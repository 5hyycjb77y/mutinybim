import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_SETTINGS, canonicalJson, elementCount, elementValues, gatedRecordFeatures, type ModelState } from "@permitzip/bim-kernel";
import { contentHashOf, makeItem, scriptItemSchema, scriptReadsSchema, type ScriptItem, type ScriptReads } from "@permitzip/bim-library";
import {
  RUNNER_CONTRACT,
  SLICE_FORMAT,
  ScriptOutputError,
  KIT_ENTRIES,
  KIT_EXAMPLES,
  KIT_EXAMPLES_PATH,
  KIT_RECIPES,
  kitExample,
  checkScriptOutput,
  checkScriptSource,
  commandFields,
  lintScript,
  parseScriptOutput,
  partTypeItemsFromRun,
  readsWarnings,
  runFailureWords,
  searchReference,
  sliceAsModel,
  sliceModel,
  type ModelSlice,
  type OutputCheck,
  type ScriptOutput,
  type ScriptRunResult,
} from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { CHANGING_TOOL, READ_ONLY_TOOL } from "../annotations";
import type { ApprovalIo, ApprovalProposal } from "../approvals";
import { libraryPartTypesFor } from "./library-parts";
import type { LibrarySaveResult, ModelArgs, ScriptLibrary, ScriptToolHost, ToolResult } from "../host";
import { PROJECT_SCHEMAS, type CoreSchemas } from "../schemas";
import { editsChange, outputHash, partTypesChange, type ScriptChangeReport } from "./change-summary";
import { SCRIPT_APPLY_TOOL, SCRIPT_SAVE_PART_TYPE_TOOL, scriptRunAllowed } from "./tier";

/** The script tools' host (kept under its first name for the hosts that already build one). */
export type ScriptToolHelpers = ScriptToolHost;

/**
 * The script tools: the primary job of the MutinyBIM tool server. The agent
 * writes a script with the open-source kit; the host runs it on a machine
 * other than this process (a hosted product: the thread's own sealed
 * machine; a local server: a fresh capped process); the kit checks its
 * output; a person approves the result before anything lands.
 *
 * - bim_script_reference: the generated kit reference (topic search, one
 *   command's fields, saved scripts), and whether a script machine exists
 *   here, so an agent learns that before it writes a script.
 * - bim_check_output: lint and syntax with line numbers, the slice the reads
 *   would send, and the kernel's checks on an output. Runs nothing.
 * - bim_run_script previews: it runs, checks and says what would change.
 *   Nothing is saved. A saved library script runs here only for its author or
 *   when a person approved that version.
 * - bim_apply_output (a model edit: pauses for approval, durable action row,
 *   preflight) and bim_save_part_type (the firm library: pauses for approval,
 *   never for the session) re-run the same script on approval and land the
 *   result only when it is exactly what was previewed (same output hash, same
 *   counts, same risk tier). Runs are deterministic, so a moved model is the
 *   only thing that changes the answer, and then nothing lands. An outside
 *   client may send bim_apply_output the output it made itself; the kernel
 *   checks it again and it always asks.
 * - Approving a script for other agents, and installing packages, are a
 *   person's (the library screen); no tool here does either.
 * - Every landing asks the host's approval gate first, after the re-run
 *   matched the preview (approvals.ts).
 */

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const FIRM_SCOPE = "firm";
const MAX_PICTURE_CHARS = 20_000;
const SEED_PREFIX = "sha256:";

const MODEL_ID = z.string().min(1).max(200);
const area = { level: z.string().min(1).max(40).optional(), zone: z.string().min(1).max(40).optional() };
const readsArg = z.record(z.string(), z.unknown()).describe('{levels?, kinds?, ids?: [..] | "selection", partTypes?}');
const scriptArg = z
  .union([z.object({ source: z.string().min(1).max(200_000), reads: readsArg }), z.object({ key: z.string().min(1).max(120), version: z.string().min(1).max(40) })])
  .describe("{source, reads} you wrote, or a saved {key, version}.");
const valuesArg = z.record(z.string(), z.union([z.string().max(400), z.number(), z.boolean()])).optional().describe("SI values (metres).");
const selectionArg = z.array(z.string().min(1).max(200)).max(5000).optional();
const hashArg = z.string().regex(/^sha256:[a-f0-9]{64}$/);

type ScriptArg = z.infer<typeof scriptArg>;

interface ResolvedScript {
  readonly source: string;
  readonly reads: ScriptReads;
  /** Seeds ids and randomness: the library item's content hash, or the inline source's. */
  readonly seed: string;
  readonly saved: ScriptItem | null;
}

/** Runs that stopped on a cap, per thread: the same script, values and model revision is answered, not run again. */
const STOPPED = new Map<string, Map<string, Extract<ScriptRunResult, { ok: false }>>>();

function stoppedKey(seed: string, values: unknown, revision: number): string {
  return `${seed}\u0000${canonicalJson(values ?? {})}\u0000${revision}`;
}

function inlineSeed(source: string, reads: ScriptReads): string {
  return `${SEED_PREFIX}${createHash("sha256").update(canonicalJson({ source, reads })).digest("hex")}`;
}

function authoredBy(item: ScriptItem, callerId: string): boolean {
  return item.authors.some((a) => a.subject === callerId || a.onBehalfOf?.subject === callerId);
}

async function resolveScript(lib: ScriptLibrary, arg: ScriptArg): Promise<{ readonly ok: true; readonly script: ResolvedScript } | { readonly ok: false; readonly message: string }> {
  if ("source" in arg) {
    const reads = scriptReadsSchema.safeParse(arg.reads);
    if (!reads.success) return { ok: false, message: `reads isn't a script's reads: ${reads.error.issues.map((i) => `${i.path.join(".") || "reads"} ${i.message}`).join("; ")}.` };
    const issues = checkScriptSource(arg.source);
    if (issues.length > 0) return { ok: false, message: `The script can't run: it ${issues.join(" It ")}` };
    return { ok: true, script: { source: arg.source, reads: reads.data, seed: inlineSeed(arg.source, reads.data), saved: null } };
  }
  const item = (await lib.scripts()).map((s) => s.body).find((s) => s.key === arg.key && s.version === arg.version);
  if (!item) return { ok: false, message: `No script ${arg.key} ${arg.version} in a library you can read. bim_script_reference({ library: "list" }) lists them.` };
  const seed = item.contentHash ?? contentHashOf(makeItem("script", item));
  const allowed = await scriptRunAllowed(lib.approvals, { key: item.key, version: item.version, hash: seed, authoredByCaller: authoredBy(item, lib.callerId) });
  if (!allowed.ok) return { ok: false, message: allowed.message };
  return { ok: true, script: { source: item.source, reads: item.manifest.reads, seed, saved: item } };
}

/**
 * The features a script's slice carries: what the model server advertises out
 * of the protocol's features and the kernel's gated record shapes (ceilings,
 * quantities, …). The server advertises both (`serverProtocol`), so a slice
 * built from the protocol list alone refuses shapes the server stores.
 */
export function sliceFeatures(policy: (feature: string) => boolean): string[] {
  return [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])].filter((f) => policy(f));
}

const EMPTY_SLICE: ModelSlice = { format: SLICE_FORMAT, version: 1, modelId: "none", revision: 0, reads: {}, selection: [], elements: {}, connections: [], settings: DEFAULT_SETTINGS, features: [] };

interface RunOnModel {
  readonly result: ScriptRunResult;
  readonly slice: ModelSlice;
  readonly head: ModelState;
}

/** `skip`: answers instead of running (a run already stopped on a cap with this script, values and revision). */
type Skip = (slice: ModelSlice) => ScriptRunResult | null;

async function runOn(helpers: ScriptToolHelpers, extra: unknown, projectId: string, script: ResolvedScript, values: Record<string, string | number | boolean>, slice: ModelSlice, head: ModelState, skip?: Skip): Promise<RunOnModel> {
  const skipped = skip?.(slice);
  if (skipped) return { result: skipped, slice, head };
  const allowed = await helpers.authorize(extra, { action: "script.run", projectId });
  if (!allowed.ok) throw new ScriptToolRefusal(`The script wasn't run: ${allowed.reason}`);
  const result = await helpers.runner(extra).run({ source: script.source, scriptHash: script.seed, values, slice }, helpers.scope(extra, projectId));
  return { result, slice, head };
}

/** Runs against the model (or, with no model, an empty slice: part scripts read nothing). */
async function runScriptFor(helpers: ScriptToolHelpers, extra: unknown, args: { project_id: string; model_id?: string; level?: string; zone?: string; selection?: string[] }, script: ResolvedScript, values: Record<string, string | number | boolean>, skip?: Skip): Promise<RunOnModel> {
  if (!args.model_id) {
    if (Object.keys(script.reads).length > 0) throw new ScriptToolRefusal("This script reads the model; give model_id.");
    return runOn(helpers, extra, args.project_id, script, values, EMPTY_SLICE, sliceAsModel(EMPTY_SLICE), skip);
  }
  return helpers.withModel(extra, { project_id: args.project_id, model_id: args.model_id, level: args.level, zone: args.zone }, async (session) => {
    const head = session.model();
    const policy = session.upgradePolicy();
    const features = sliceFeatures(policy);
    // Parts the script names from the host's library ride in the slice, so the sealed runner can place them (the open server holds none of its own).
    const patterns = script.reads.partTypes ?? [];
    const library = patterns.length > 0 ? libraryPartTypesFor(await (await helpers.library(extra)).partTypes(), patterns) : {};
    return runOn(helpers, extra, args.project_id, script, values, sliceModel(head, script.reads, args.selection ?? [], features, library), head, skip);
  });
}

class ScriptToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptToolRefusal";
  }
}

interface Checked {
  readonly output: ScriptOutput;
  readonly check: OutputCheck;
  readonly change: ScriptChangeReport;
  readonly hash: string;
}

/** The run's output, checked and summarised; a refusal in words when it doesn't check out. */
async function checked(helpers: ScriptToolHost, run: RunOnModel): Promise<Checked | { readonly stopped: Extract<ScriptRunResult, { ok: false }> } | { readonly refused: string }> {
  if (!run.result.ok) return { stopped: run.result };
  const output = parseScriptOutput(run.result.output);
  if (output.kind === "part_types") await drawingEngine(helpers);
  const check = checkScriptOutput(run.head, output, { features: run.slice.features });
  if (output.kind === "part_types") return { output, check, change: partTypesChange(output), hash: outputHash(output) };
  const change = editsChange(run.head, output, run.slice);
  if ("refused" in change) return { refused: change.refused };
  return { output, check, change, hash: outputHash(output) };
}

/** Loads the part geometry engine for pictures; without it the checks still run and say there is no picture. */
async function drawingEngine(helpers: ScriptToolHost): Promise<void> {
  try {
    if (helpers.drawingEngine) await helpers.drawingEngine();
    else await (await import("@permitzip/bim-editor/contracts/bim/part-geometry")).initPartGeometry();
  } catch (err) {
    console.error("[mcp:bim-scripts] the part geometry engine didn't load; part checks run without pictures", err);
  }
}

function stoppedBody(stopped: Extract<ScriptRunResult, { ok: false }>, repeated: boolean) {
  const cap = stopped.code.startsWith("cap_");
  return {
    status: "stopped",
    code: stopped.code,
    message: runFailureWords(stopped, RUNNER_CONTRACT),
    ...(cap ? { retry: "Change the script or its values first; this exact run will stop the same way and is not run again in this thread." } : {}),
    ...(repeated ? { not_run: true } : {}),
    nothing_changed: true,
  };
}

function checkLines(check: OutputCheck) {
  if (check.kind === "part_types") return check.types.map((t) => ({ type_id: t.typeId, problems: t.problems, ...(t.notes.length ? { notes: t.notes } : {}) }));
  return check.batches.map((b) => ({ label: b.label, steps: b.steps, status: b.status, ...(b.message ? { message: b.message } : {}), reopens: b.reopens.slice(0, 5), quantity_changes: b.quantityChanges.slice(0, 8) }));
}

function partLines(output: Extract<ScriptOutput, { kind: "part_types" }>, check: OutputCheck) {
  return output.types.map((t) => {
    const pictures = check.kind === "part_types" ? check.types.find((c) => c.typeId === t.typeId)?.pictures : undefined;
    const plan = pictures?.plan;
    return {
      type_id: t.typeId,
      name: `${t.definition.familyName} ${t.definition.typeName}`,
      connectors: t.definition.connectors.map((c) => `${c.label} (${c.domain}, ${c.shape})`),
      ...(plan && plan.length <= MAX_PICTURE_CHARS ? { plan_svg: plan } : {}),
    };
  });
}

function valuesOf(v: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> {
  return v ?? {};
}

/** The script machine is missing: said before the agent writes a script, and again by any tool that would run one. */
async function machineWords(helpers: ScriptToolHelpers, extra: unknown): Promise<string | null> {
  const ready = await helpers.runner(extra).availability();
  return ready.ok ? null : `Scripts can't run here: ${ready.reason}. Do the work with the other MutinyBIM tools instead of writing a script.`;
}

/** Plain TypeScript syntax errors with their line (type stripping parses the source; nothing runs). */
async function syntaxFindings(source: string): Promise<{ line: number; rule: "syntax"; message: string }[]> {
  try {
    const mod: { stripTypeScriptTypes?: (code: string, options: { mode: "strip" }) => string } = await import("node:module");
    if (typeof mod.stripTypeScriptTypes !== "function") return [];
    stripTypes = mod.stripTypeScriptTypes;
    stripTypes(source, { mode: "strip" });
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ line: syntaxErrorLine(source, message), rule: "syntax", message: `It isn't valid TypeScript: ${message.split("\n")[0]?.slice(0, 300) ?? "it doesn't parse"}.` }];
  }
}

/** The parser names no line: the first line whose prefix of the source fails with the same words is where it is (0: not found). */
function syntaxErrorLine(source: string, message: string): number {
  const lines = source.split("\n");
  if (lines.length > SYNTAX_SEARCH_MAX_LINES) return 0;
  for (let n = 1; n <= lines.length; n++) {
    try {
      stripTypes?.(lines.slice(0, n).join("\n"), { mode: "strip" });
    } catch (err) {
      if ((err instanceof Error ? err.message : String(err)) === message) return n;
    }
  }
  return 0;
}

const SYNTAX_SEARCH_MAX_LINES = 2000;
let stripTypes: ((code: string, options: { mode: "strip" }) => string) | undefined;

/** What a script's reads would send, counted (the read slice an agent checks before running). */
function sliceSummary(slice: ModelSlice) {
  const kinds: Record<string, number> = {};
  for (const el of elementValues(slice.elements)) kinds[el.kind] = (kinds[el.kind] ?? 0) + 1;
  return { revision: slice.revision, elements: elementCount(slice.elements), kinds, selection: slice.selection.length, add_ons: (slice.addOns ?? []).map((a) => a.id) };
}

const referenceIndex = () => ({
  start_here: `Whole example scripts to copy and change (each one bim_run_script → check → apply): ${KIT_EXAMPLES.map((x) => x.name).join(", ")}. Read one with bim_script_reference({ example: "<name>" }); the files are in ${KIT_EXAMPLES_PATH}.`,
  examples: KIT_EXAMPLES.map((x) => ({ name: x.name, title: x.title, builds: x.builds })),
  workflow: "bim_script_reference (search a topic; command for a command's fields) → write the script → bim_check_output → bim_run_script (preview, saves nothing) → show the person → bim_apply_output or bim_save_part_type with apply_with.args (they Approve).",
  prefer: "One script for a multi-step layout (connect N parts to a run, place and route equipment, a sheet per level) instead of many single tool calls: one preview, one Approve, one Undo.",
  module: 'import { defineScript, units, routes, parts, building, equipment, documents, checks } from "@permitzip/bim-script"; export default defineScript({ kind: "part" | "layout" | "route", reads, parameters, run(ctx, values) { ... } }). Import nothing else; no fetch, files, timers, Date or Math.random.',
  kit: KIT_ENTRIES.map((e) => e.name),
  recipes: KIT_RECIPES.map((r) => r.name),
  /** The jobs an engineer names, each with a worked example: search one (search: "schedules") for its steps and script. */
  tasks: Object.fromEntries(KIT_RECIPES.map((r) => [r.task, r.name])),
  part_definition: {
    how: "parts.part(name, { type, category }) → box / cylinder / transition bodies → connector(face, { id, label, domain, systemKind, shape, width?, height?, diameter? }) → ctx.parts.define(typeId, builder.build()).",
    example: KIT_ENTRIES.find((e) => e.name === "PartBuilder.connector")?.example,
  },
  rules: {
    levels: "Level arguments are level ids: building.level returns one, ctx.model.levels() lists them (reads.levels: true). The kit's helpers also take the name of exactly one level the script read; raw ctx.edit commands take only the id.",
    part_types_in_layouts: 'A layout or route script uses part types by listing their ids in reads.partTypes ("acme.rtu.*" patterns work) and placing them with equipment.place. Only a part script (kind: "part") defines part types, with ctx.parts.define.',
    reads: 'Read what a kit function works from: building.spaceInWalls traces walls, so read them (reads.kinds: ["wall"]) unless the script draws them first. bim_check_output warns when a call needs data the reads don\'t send.',
    see_values: "ctx.report(label, value) shows what the script read or worked out in bim_run_script's report (50 reports, 16 KB a run); a script that only reports still runs. Don't throw an error to see a value.",
    units: 'units.* values are measures, not numbers: give them to kit helpers (building.walls, building.ceiling, equipment.place). A raw ctx.edit command takes plain millimetres: units.in_(length, "mm").',
  },
  limits: "one result ≤ 500 steps (one undo step); 1 GB memory, 30 s, 2 MB output; a run that hits a cap is not run again unchanged.",
  outside_clients: "Agents outside this server may run the open-source kit themselves and send its output to bim_apply_output ({ output, provenance }); the kernel re-checks every step and a person still approves.",
});

/** How a gated tool reaches the person through the client (MCP elicitation), when the client can. */
export function approvalIo(server: McpServer): ApprovalIo {
  return {
    async confirm(message) {
      const low = (server as Partial<McpServer>).server;
      if (!low?.getClientCapabilities()?.elicitation) return "unsupported";
      const answer = await low.elicitInput({
        message,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Land this change" } }, required: ["approve"] },
      });
      return answer.action === "accept" && answer.content?.approve === true ? "approved" : "declined";
    },
  };
}

/** Lands only on the host gate's yes; the refusal when it says no. */
async function gate(helpers: ScriptToolHost, server: McpServer, extra: unknown, proposal: ApprovalProposal): Promise<ToolResult | null> {
  const decision = await helpers.approvals.decide(extra, proposal, approvalIo(server));
  return decision.approved ? null : json({ status: "not_approved", message: decision.message, nothing_changed: true });
}

/** Where a hosted product runs scripts, as bim_run_script says it. */
export const SEALED_MACHINE_WORDS = "on this thread's sealed machine (no network, 1 GB, 30 s, 2 MB)";

export interface ScriptToolOptions {
  readonly schemas?: CoreSchemas;
  /** Where this host runs scripts, in bim_run_script's description (default: a sealed machine per thread). */
  readonly runsWhere?: string;
}

export function registerBimScriptTools(server: McpServer, helpers: ScriptToolHelpers, options: ScriptToolOptions = {}): void {
  const target = { project_id: (options.schemas ?? PROJECT_SCHEMAS).scripts.project_id, model_id: MODEL_ID };
  server.registerTool(
    "bim_script_reference",
    {
      title: "Script kit reference",
      annotations: READ_ONLY_TOOL,
      description: "Start here before writing a MutinyBIM script. No arguments: whether scripts can run here, the example scripts, the workflow, the kit's functions and recipes. example: one whole example script to copy (\"rooftop-unit\", \"small-office\", \"plumbing-riser\", \"electrical-room\"). search: a topic (\"rooftop unit\", \"drain slope\", \"sheet per level\"). command: one ctx.edit command's fields. library: list or read saved scripts.",
      inputSchema: {
        example: z.string().min(1).max(80).optional(),
        search: z.string().min(1).max(200).optional(),
        command: z.string().min(1).max(80).optional(),
        library: z.enum(["list", "read"]).optional(),
        key: z.string().max(120).optional(),
        version: z.string().max(40).optional(),
      },
    },
    async (args, extra) => {
      try {
        if (args.example) {
          const x = kitExample(args.example);
          if (!x) return failure(`No example "${args.example}". Examples: ${KIT_EXAMPLES.map((e) => e.name).join(", ")}.`);
          return json({ example: x.name, title: x.title, builds: x.builds, run: "Send source as script.source to bim_run_script with the reads it declares; check, then apply.", source: x.source });
        }
        if (args.command) {
          const found = commandFields(args.command);
          if (!found) {
            const near = searchReference(args.command.replace(/_/g, " "), 6).filter((h) => h.kind === "command").map((h) => h.name);
            return failure(`ctx.edit has no command "${args.command}".${near.length ? ` Near: ${near.join(", ")}.` : ""} Search with bim_script_reference({ search }).`);
          }
          return json({ command: found.type, from: found.from, fields: found.fields, schema: found.schema });
        }
        if (args.search) {
          const hits = searchReference(args.search);
          return json({ search: args.search, hits, ...(hits.length === 0 ? { message: "Nothing on that topic. Try a shorter word (wall, run, part, sheet) or ask for the index (no arguments)." } : {}) });
        }
        if (args.library) return await libraryAnswer(helpers, extra, args.library, args.key, args.version);
        const blocked = await machineWords(helpers, extra);
        return json({ script_machine: blocked ? { ready: false, message: blocked } : { ready: true }, ...referenceIndex() });
      } catch (err) {
        console.error("[mcp:bim_script_reference] failed", err);
        return failure(`The script reference couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "bim_check_output",
    {
      title: "Check a script",
      annotations: READ_ONLY_TOOL,
      description: "Lint and syntax of a script with line numbers and what its reads send (with model_id), or the kernel's checks on an output. Runs and saves nothing.",
      inputSchema: { project_id: target.project_id.optional(), model_id: target.model_id.optional(), ...area, script: scriptArg.optional(), selection: selectionArg, output: z.record(z.string(), z.unknown()).optional() },
    },
    async (args, extra) => {
      try {
        const body: Record<string, unknown> = {};
        let ok = true;
        if (args.script && "source" in args.script) {
          const findings = [...(await syntaxFindings(args.script.source)), ...lintScript(args.script.source)].sort((a, b) => a.line - b.line);
          const reads = scriptReadsSchema.safeParse(args.script.reads);
          if (!reads.success) findings.push({ line: 0, rule: "shape", message: `reads isn't a script's reads: ${reads.error.issues.map((i) => `${i.path.join(".") || "reads"} ${i.message}`).join("; ")}.` });
          body.findings = findings.map((f) => ({ line: f.line, rule: f.rule, message: f.message }));
          ok = findings.length === 0;
          const warnings = reads.success ? readsWarnings(args.script.source, reads.data) : [];
          if (warnings.length > 0) body.warnings = warnings.map((w) => ({ line: w.line, rule: w.rule, message: w.message }));
        }
        if ((args.script || args.output) && args.model_id && args.project_id) {
          const modelArgs = { project_id: args.project_id, model_id: args.model_id, level: args.level, zone: args.zone };
          await helpers.withModel(extra, modelArgs, async (session) => {
            const policy = session.upgradePolicy();
            const features = sliceFeatures(policy);
            const reads = args.script && "source" in args.script ? scriptReadsSchema.safeParse(args.script.reads) : null;
            if (reads?.success) body.reads = sliceSummary(sliceModel(session.model(), reads.data, args.selection ?? [], features));
            if (args.output) {
              const output = parseScriptOutput(args.output);
              if (output.kind === "part_types") await drawingEngine(helpers);
              const check = checkScriptOutput(session.model(), output, { features });
              body.output = { status: check.ok ? "ok" : "has_issues", revision: session.revision(), checks: checkLines(check) };
              ok = ok && check.ok;
            }
          });
        } else if (args.output) {
          const output = parseScriptOutput(args.output);
          body.output = { status: "parsed", kind: output.kind, message: "Give project_id and model_id to check it against the model." };
        }
        if (!args.script && !args.output) return failure("Give script (to lint it and see its reads) or output (to check a change set).");
        return json({ status: ok ? "ok" : "has_issues", ...body, ...(ok && args.script ? { next: "Run it with bim_run_script (a preview; nothing is saved)." } : {}) });
      } catch (err) {
        if (err instanceof ScriptOutputError) return json({ status: "has_issues", message: err.message });
        console.error("[mcp:bim_check_output] failed", err);
        return failure(`The script couldn't be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "bim_run_script",
    {
      title: "Run a script (preview)",
      annotations: READ_ONLY_TOOL,
      description: `Preview: run a script ${options.runsWhere ?? SEALED_MACHINE_WORDS} and check its output. Saves nothing; returns what would change and apply_with.`,
      inputSchema: { project_id: target.project_id, model_id: target.model_id.optional(), ...area, script: scriptArg, values: valuesArg, selection: selectionArg },
    },
    async (args, extra) => {
      try {
        const blocked = await machineWords(helpers, extra);
        if (blocked) return json({ status: "refused", message: blocked, nothing_changed: true });
        const lib = await helpers.library(extra);
        const resolved = await resolveScript(lib, args.script);
        if (!resolved.ok) return json({ status: "refused", message: resolved.message, nothing_changed: true });
        const values = valuesOf(args.values);
        const conv = helpers.scope(extra, args.project_id).conversationId;
        const stopped = STOPPED.get(conv) ?? new Map<string, Extract<ScriptRunResult, { ok: false }>>();
        let repeated = false;
        const run = await runScriptFor(helpers, extra, args, resolved.script, values, (slice) => {
          const before = stopped.get(stoppedKey(resolved.script.seed, values, slice.revision));
          repeated = before !== undefined;
          return before ?? null;
        });
        const got = await checked(helpers, run);
        if ("stopped" in got) {
          if (got.stopped.code.startsWith("cap_") && !repeated) {
            stopped.set(stoppedKey(resolved.script.seed, values, run.slice.revision), got.stopped);
            STOPPED.set(conv, stopped);
          }
          return json(stoppedBody(got.stopped, repeated));
        }
        if ("refused" in got) return json({ status: "has_issues", message: got.refused, nothing_changed: true });
        const manifest = run.result.ok ? run.result.manifest : undefined;
        if (!resolved.script.saved && manifest && canonicalJson(manifest.reads) !== canonicalJson(resolved.script.reads)) {
          return json({ status: "has_issues", message: `The script declares reads ${canonicalJson(manifest.reads)} but was run with ${canonicalJson(resolved.script.reads)}. Run it with the reads it declares.`, nothing_changed: true });
        }
        const report = got.output.report ? { report: got.output.report } : {};
        if (got.output.kind === "edits" && got.output.steps === 0) {
          return json({ status: "reported", kind: "edits", ...report, message: "The script made no edits, so there is nothing to apply. Its reports are in report.", nothing_changed: true, ms: run.result.ok ? run.result.ms : 0 });
        }
        const tier = got.change.tier;
        const approval = tier.tier;
        if (got.output.kind === "edits") {
          const one = got.output.batches.length === 1;
          const body = {
            status: got.check.ok && one ? "previewed" : "has_issues",
            kind: "edits",
            label: got.output.label,
            steps: got.output.steps,
            changes: { creates: got.change.summary.creates, edits: got.change.summary.edits, deletes: got.change.summary.deletes },
            checks: checkLines(got.check),
            ...report,
            approval,
            ...(tier.tier === "ask_every_time" ? { approval_reasons: tier.reasons } : {}),
            ...(!one ? { message: `It makes ${got.output.steps} steps; one result lands as one undo step of at most 500. Split the work into smaller runs.` } : {}),
            ms: run.result.ok ? run.result.ms : 0,
          };
          if (body.status !== "previewed" || !args.model_id) return json(body);
          return json({
            ...body,
            apply_with: { tool: SCRIPT_APPLY_TOOL, args: { project_id: args.project_id, model_id: args.model_id, ...(args.level ? { level: args.level } : {}), ...(args.zone ? { zone: args.zone } : {}), base_revision: run.slice.revision, script: args.script, values, ...(args.selection ? { selection: args.selection } : {}), output_hash: got.hash, label: got.output.label, steps: got.output.steps, changes: body.changes, approval } },
            next: "Show the person what it does. To land it call bim_apply_output with apply_with.args; nothing changes until they click Approve, and one Undo removes it.",
          });
        }
        const parts = partLines(got.output, got.check);
        const body = { status: got.check.ok ? "previewed" : "has_issues", kind: "part_types", types: parts, checks: checkLines(got.check), ...report, approval, ms: run.result.ok ? run.result.ms : 0 };
        if (!got.check.ok) return json(body);
        return json({
          ...body,
          apply_with: {
            tool: SCRIPT_SAVE_PART_TYPE_TOOL,
            args: { project_id: args.project_id, ...(args.model_id ? { model_id: args.model_id } : {}), script: args.script, values, output_hash: got.hash, parts: parts.map((p) => ({ type_id: p.type_id, name: p.name, connectors: p.connectors.length })), ...(resolved.script.saved ? {} : { save_as: { key: "<firm>.<name>", name: "<name>", version: "1.0.0" } }) },
          },
          next: resolved.script.saved
            ? "To save these part types to the firm library call bim_save_part_type with apply_with.args; the person approves it first."
            : "To save, fill save_as (key like acme.rect_plenum, a name, a version) and call bim_save_part_type with apply_with.args; the person approves it first. The script version is saved with its parts; other agents run it only after a person approves that version.",
        });
      } catch (err) {
        if (err instanceof ScriptToolRefusal || err instanceof ScriptOutputError) return json({ status: "refused", message: err.message, nothing_changed: true });
        console.error("[mcp:bim_run_script] failed", err);
        return failure(`The script couldn't be run: ${err instanceof Error ? err.message : String(err)}. Nothing changed.`);
      }
    },
  );

  server.registerTool(
    SCRIPT_APPLY_TOOL,
    {
      title: "Apply a script result",
      annotations: CHANGING_TOOL,
      description: "Land bim_run_script's apply_with.args as one undo step after the person approves; re-runs and lands only what was previewed. Outside clients send output + provenance instead of script.",
      inputSchema: {
        ...target,
        ...area,
        base_revision: z.number().int().min(0),
        script: scriptArg.optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        provenance: z.object({ script_hash: hashArg, kit_version: z.string().max(40), client: z.string().max(120) }).optional(),
        values: valuesArg,
        selection: selectionArg,
        output_hash: hashArg,
        label: z.string().min(1).max(160),
        steps: z.number().int().min(1),
        changes: z.object({ creates: z.number().int().min(0), edits: z.number().int().min(0), deletes: z.number().int().min(0) }),
        approval: z.enum(["session_allowed", "ask_every_time"]),
      },
    },
    async (args, extra) => {
      try {
        if (args.output) return await applyOutsideOutput(helpers, extra, args, (proposal) => gate(helpers, server, extra, proposal));
        if (!args.script) return json({ status: "refused", message: "Give script (bim_run_script's apply_with.args) or, from an outside client, output with provenance.", nothing_changed: true });
        const blocked = await machineWords(helpers, extra);
        if (blocked) return json({ status: "refused", message: blocked, nothing_changed: true });
        const lib = await helpers.library(extra);
        const resolved = await resolveScript(lib, args.script);
        if (!resolved.ok) return json({ status: "refused", message: resolved.message, nothing_changed: true });
        const values = valuesOf(args.values);
        const run = await runScriptFor(helpers, extra, args, resolved.script, values);
        const got = await checked(helpers, run);
        if ("stopped" in got) return json(stoppedBody(got.stopped, false));
        if ("refused" in got) return json({ status: "refused", message: got.refused, nothing_changed: true });
        const stale = mismatch(args, got, run);
        if (stale) return json({ status: "stale_preview", message: stale, nothing_changed: true, next: "Run bim_run_script again and show the person the new preview." });
        if (got.output.kind !== "edits") return json({ status: "refused", message: "This script makes part types; save them with bim_save_part_type.", nothing_changed: true });
        const [batch] = got.output.batches;
        if (!batch || got.output.batches.length !== 1) return json({ status: "refused", message: "One result lands as one undo step of at most 500 steps; split the work.", nothing_changed: true });
        const revision = run.slice.revision;
        const declined = await gate(helpers, server, extra, editsProposal(args, got.output.label, got.change));
        if (declined) return declined;
        return helpers.edit(SCRIPT_APPLY_TOOL, extra, args, args, (model) => (model.revision === revision ? { ok: true, command: batch } : { ok: false, message: `The model moved to Rev ${model.revision} after the run read Rev ${revision}. Preview it again.` }));
      } catch (err) {
        if (err instanceof ScriptToolRefusal || err instanceof ScriptOutputError) return json({ status: "refused", message: err.message, nothing_changed: true });
        console.error("[mcp:bim_apply_output] failed", err);
        return failure(`Not applied: ${err instanceof Error ? err.message : String(err)}. Nothing changed.`);
      }
    },
  );

  server.registerTool(
    SCRIPT_SAVE_PART_TYPE_TOOL,
    {
      title: "Save a script's part types",
      annotations: CHANGING_TOOL,
      description: "Save bim_run_script's part types (apply_with.args) and the script version to the firm library after the person approves; re-runs and saves only what was previewed.",
      inputSchema: {
        project_id: target.project_id,
        model_id: target.model_id.optional(),
        script: scriptArg,
        values: valuesArg,
        output_hash: hashArg,
        parts: z.array(z.object({ type_id: z.string().min(1).max(200), name: z.string().max(400), connectors: z.number().int().min(0) })).min(1).max(200),
        save_as: z.object({ key: z.string().min(1).max(120), name: z.string().min(1).max(120), version: z.string().min(1).max(40) }).optional(),
      },
    },
    async (args, extra) => {
      try {
        const lib = await helpers.library(extra);
        if (!lib.firmWrite.allowed) return json({ status: "refused", message: `Not saved: ${lib.firmWrite.reason}`, nothing_changed: true });
        const blocked = await machineWords(helpers, extra);
        if (blocked) return json({ status: "refused", message: blocked, nothing_changed: true });
        const resolved = await resolveScript(lib, args.script);
        if (!resolved.ok) return json({ status: "refused", message: resolved.message, nothing_changed: true });
        const values = valuesOf(args.values);
        const run = await runScriptFor(helpers, extra, args, resolved.script, values);
        const got = await checked(helpers, run);
        if ("stopped" in got) return json(stoppedBody(got.stopped, false));
        if ("refused" in got) return json({ status: "refused", message: got.refused, nothing_changed: true });
        if (got.output.kind !== "part_types") return json({ status: "refused", message: "This script makes edits; land them with bim_apply_output.", nothing_changed: true });
        if (got.hash !== args.output_hash) return json({ status: "stale_preview", message: "The script's output now differs from the preview, so nothing was saved.", nothing_changed: true });
        const parts = got.output.types.map((t) => ({ type_id: t.typeId, name: `${t.definition.familyName} ${t.definition.typeName}`, connectors: t.definition.connectors.length }));
        if (canonicalJson(parts) !== canonicalJson(args.parts)) return json({ status: "stale_preview", message: "The parts named in this call aren't the ones the script makes, so nothing was saved.", nothing_changed: true });
        if (!got.check.ok) return json({ status: "refused", message: "The parts don't pass the kit's checks.", checks: checkLines(got.check), nothing_changed: true });
        const declined = await gate(helpers, server, extra, {
          tool: SCRIPT_SAVE_PART_TYPE_TOOL,
          projectId: args.project_id,
          ...(args.model_id ? { modelId: args.model_id } : {}),
          summary: `save ${parts.length} part type${parts.length === 1 ? "" : "s"} (${parts.map((p) => p.name).join(", ")}) and the script version to the library`,
          tier: "ask_every_time",
        });
        if (declined) return declined;
        const author = helpers.author(extra, lib.callerId);
        let script: ScriptItem;
        let scriptSave: LibrarySaveResult | null = null;
        if (resolved.script.saved) script = resolved.script.saved;
        else {
          const manifest = run.result.ok ? run.result.manifest : undefined;
          if (!args.save_as) return json({ status: "refused", message: "An inline script needs save_as (key, name, version) to be saved with its parts.", nothing_changed: true });
          if (!manifest) return json({ status: "refused", message: "The script machine didn't report the script's manifest; it needs the current development image.", nothing_changed: true });
          const item = scriptItemSchema.safeParse({ id: args.save_as.key, revision: 1, key: args.save_as.key, name: args.save_as.name, version: args.save_as.version, language: "typescript", kit: ">=0.1.0", manifest, source: resolved.script.source, license: "LicenseRef-Firm", authors: [author] });
          if (!item.success) return json({ status: "refused", message: `save_as doesn't make a library script: ${item.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}.`, nothing_changed: true });
          scriptSave = await lib.saveScript(FIRM_SCOPE, item.data);
          if (scriptSave.status === "refused") return json({ status: "refused", message: `The script wasn't saved: ${scriptSave.message}`, nothing_changed: true });
          script = { ...item.data, contentHash: contentHashOf(makeItem("script", item.data)) };
        }
        const items = partTypeItemsFromRun(got.output, { script: { ...script, contentHash: script.contentHash ?? contentHashOf(makeItem("script", script)) }, values, generatedBy: author, generatedAt: (helpers.now?.() ?? new Date()).toISOString() });
        const saved = await lib.savePartTypesFromRun(FIRM_SCOPE, items);
        const refused = saved.filter((s) => s.status === "refused");
        return json({
          status: refused.length === 0 ? "saved" : "partly_saved",
          library: "firm",
          ...(scriptSave ? { script: { key: script.key, version: script.version, result: scriptSave.status, approved_for_agents: false } } : {}),
          parts: saved.map((s, i) => ({ type_id: items[i]?.key, result: s.status, ...(s.status === "saved" ? { revision: s.summary.revision, because: s.because } : s.status === "refused" ? { message: s.message } : { revision: s.revision }) })),
          message: `${saved.filter((s) => s.status === "saved").length} part type(s) saved to the firm library, ${saved.filter((s) => s.status === "up_to_date").length} already up to date.${scriptSave ? " Other agents can run the script only after a person approves this version." : ""}`,
        });
      } catch (err) {
        if (err instanceof ScriptToolRefusal || err instanceof ScriptOutputError) return json({ status: "refused", message: err.message, nothing_changed: true });
        console.error("[mcp:bim_save_part_type] failed", err);
        return failure(`Not saved: ${err instanceof Error ? err.message : String(err)}. Nothing changed.`);
      }
    },
  );
}

/** `bim_script_reference({ library })`: saved scripts (list), or one script's source and manifest (read). */
async function libraryAnswer(helpers: ScriptToolHelpers, extra: unknown, action: "list" | "read", key?: string, version?: string): Promise<ToolResult> {
  const lib = await helpers.library(extra);
  const scripts = (await lib.scripts()).map((s) => ({ scope: s.scope, item: s.body }));
  if (action === "list") {
    const rows = await Promise.all(
      scripts.map(async ({ scope, item }) => {
        const hash = item.contentHash ?? contentHashOf(makeItem("script", item));
        const approval = await lib.approvals.approvalOf(item.key, hash);
        return { key: item.key, version: item.version, name: item.name, kind: item.manifest.kind, scope, yours: authoredBy(item, lib.callerId), approved_for_agents: approval !== null };
      }),
    );
    return json({ scripts: rows, ...(rows.length === 0 ? { message: "No scripts yet. Write one (bim_script_reference) and preview it with bim_run_script." } : {}) });
  }
  const item = scripts.find((s) => s.item.key === key && (version === undefined || s.item.version === version))?.item;
  if (!item) return failure(`No script ${key ?? "(key missing)"}${version ? ` ${version}` : ""}. List them first: bim_script_reference({ library: "list" }).`);
  return json({ key: item.key, version: item.version, name: item.name, manifest: item.manifest, source: item.source, run_with: { key: item.key, version: item.version } });
}

type ApplyArgs = ModelArgs & { base_revision: number; output?: Record<string, unknown>; provenance?: { script_hash: string; kit_version: string; client: string }; output_hash: string; label: string; steps: number; changes: { creates: number; edits: number; deletes: number }; approval: "session_allowed" | "ask_every_time" };

/**
 * An outside client's change set (product decision, Nov 4, "one sealed script path",
 * item 4): it ran the open-source kit in its own sandbox. Nothing it says is
 * trusted: the output is parsed and checked by the kernel at the head, its
 * hash, label, step and change counts must match the call (what the card
 * showed), it always asks the person, and it lands as one undo step.
 */
async function applyOutsideOutput(helpers: ScriptToolHelpers, extra: unknown, args: ApplyArgs, ask: (proposal: ApprovalProposal) => Promise<ToolResult | null>): Promise<ToolResult> {
  if (!args.provenance) return json({ status: "refused", message: "An output from an outside client needs provenance (script_hash, kit_version, client).", nothing_changed: true });
  if (args.approval !== "ask_every_time") return json({ status: "refused", message: "An outside client's output asks the person every time; call again with approval: ask_every_time.", nothing_changed: true });
  const output = parseScriptOutput(args.output);
  if (output.kind !== "edits") return json({ status: "refused", message: "Only edits land here; part types are saved by running their script with bim_run_script and bim_save_part_type.", nothing_changed: true });
  if (outputHash(output) !== args.output_hash) return json({ status: "refused", message: "output_hash isn't this output's hash.", nothing_changed: true });
  const [batch] = output.batches;
  if (!batch || output.batches.length !== 1) return json({ status: "refused", message: "One result lands as one undo step of at most 500 steps; split the work.", nothing_changed: true });
  const verdict = await helpers.withModel(extra, args, async (session) => {
    const head = session.model();
    if (head.revision !== args.base_revision) return { stale: `The model is at Rev ${head.revision}; the output was made at Rev ${args.base_revision}.` } as const;
    const policy = session.upgradePolicy();
    const features = sliceFeatures(policy);
    const check = checkScriptOutput(head, output, { features });
    const change = editsChange(head, output, sliceModel(head, {}, [], features));
    return { check, change } as const;
  });
  if ("stale" in verdict) return json({ status: "stale_preview", message: verdict.stale, nothing_changed: true });
  if (!verdict.check.ok) return json({ status: "refused", message: "The kernel refuses this output.", checks: checkLines(verdict.check), nothing_changed: true });
  if ("refused" in verdict.change) return json({ status: "refused", message: verdict.change.refused, nothing_changed: true });
  const s = verdict.change.summary;
  if (output.label !== args.label || output.steps !== args.steps || s.creates !== args.changes.creates || s.edits !== args.changes.edits || s.deletes !== args.changes.deletes) return json({ status: "refused", message: "What this call says it does isn't what the output does.", nothing_changed: true });
  const revision = args.base_revision;
  const declined = await ask({ ...editsProposal(args, output.label, verdict.change), tier: "ask_every_time" });
  if (declined) return declined;
  return helpers.edit(SCRIPT_APPLY_TOOL, extra, args, args, (model) => (model.revision === revision ? { ok: true, command: batch } : { ok: false, message: `The model moved to Rev ${model.revision} after the output was made at Rev ${revision}.` }));
}

/** What the person is asked before a script result lands in the model. */
function editsProposal(args: ModelArgs, label: string, change: ScriptChangeReport): ApprovalProposal {
  const s = change.summary;
  return {
    tool: SCRIPT_APPLY_TOOL,
    projectId: args.project_id,
    modelId: args.model_id,
    summary: `land "${label}" in model ${args.model_id} as one undo step: ${s.creates} new, ${s.edits} changed, ${s.deletes} deleted`,
    tier: change.tier.tier,
    ...(change.tier.tier === "ask_every_time" ? { reasons: change.tier.reasons } : {}),
  };
}


/** Why an approved call no longer matches its preview, or null. */
function mismatch(args: { output_hash: string; label: string; steps: number; changes: { creates: number; edits: number; deletes: number }; approval: string; base_revision: number }, got: Checked, run: RunOnModel): string | null {
  if (run.slice.revision !== args.base_revision) return `The model is at Rev ${run.slice.revision}; the preview read Rev ${args.base_revision}.`;
  if (got.hash !== args.output_hash) return "The script's output now differs from the preview.";
  if (got.output.kind !== "edits") return null;
  const s = got.change.summary;
  if (got.output.label !== args.label || got.output.steps !== args.steps || s.creates !== args.changes.creates || s.edits !== args.changes.edits || s.deletes !== args.changes.deletes) return "What this call says it does isn't what the script does.";
  if (args.approval === "session_allowed" && got.change.tier.tier !== "session_allowed") return `This result needs the person's approval each time (${got.change.tier.tier === "ask_every_time" ? got.change.tier.reasons.join(" ") : ""}); call again with approval: ask_every_time.`;
  return null;
}
