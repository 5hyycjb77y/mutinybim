import { builtinCalcRegistry, type CalcDomain, type RunRequest, type RunResult } from "@permitzip/bim-calc";
import { acceptGhostsCommand, commandIssueMessage, commandSchema, executeCommand, isEditBatchCommand, proposersFor, runProposer, withUpgradePolicy, type Command, type GhostPlacement, type ModelState, type PackCommand, type PartTypeDefinition, type ProposerAnswer, type ProposerRequest } from "@permitzip/bim-kernel";
import { FIRST_PARTY_PACK_IDS, PACK_READ_POINT, activePackSet, firstPartyPackName, withPackSet, type PackSet } from "@permitzip/bim-kernel/packs";
import { scriptSourceIssues, type ScriptKind, type ScriptValue } from "@permitzip/bim-library";
import type { ScriptDefinition } from "./define";
import { deterministicId, seededRandom, type RunSeed } from "./determinism";
import { MAX_SCRIPT_REPORT_BYTES, MAX_SCRIPT_REPORTS, chunkEdits, jsonBytes, stepRefusal, type EditStep, type ScriptOutput, type ScriptReport } from "./output";
import { sliceAsModel, sliceReader, type ModelSlice, type SliceReader } from "./slice";
import { bindWorking } from "./working";

/** A calculation a script can run (`ctx.calcs()`). */
export interface ScriptCalcInfo {
  readonly id: string;
  readonly title: string;
  readonly domain: CalcDomain;
  readonly summary: string;
  /** It reads the model (it is run on the script's working copy). */
  readonly readsModel: boolean;
}

/** One calculation run from a script: the calc and its inputs, and an edition when the job names one. The model is the script's working copy. */
export type ScriptCalcRequest = Omit<RunRequest, "model" | "projectAdoption" | "projectAdoptions">;

/** An add-on's read a script can run (`ctx.reads()`): a panel's loads, a rebalance plan, a duct size, a catalogue. */
export interface ScriptReadInfo {
  readonly id: string;
  readonly label: string;
}

/** An add-on's proposer (`ctx.proposers()`): devices placed by a code's spacing or coverage, as ghosts. */
export interface ScriptProposerInfo {
  readonly id: string;
  readonly label: string;
  /** What it places on, in words ("walls", "typed ceilings"). */
  readonly hosts: string;
}

/** What a script's `run` works through. */
export interface ScriptContext {
  readonly kind: ScriptKind;
  /** The model, as far as the script's reads go. Edits it made are visible to later reads. */
  readonly model: SliceReader;
  /** A new id, the same on every run with the same script, values and slice revision. */
  id(prefix?: string): string;
  /** Seeded randomness in [0, 1): use this, never Math.random. */
  random(): number;
  /** Layout and route scripts: one edit, applied to the working copy at once (later steps see it), recorded for the output. */
  edit(command: Command | PackCommand): void;
  /**
   * Sends a plan's edit as it came from an add-on read or proposer (one edit,
   * or a batch such as a rebalance's or a room template's), step by step.
   * The output batches the steps again; one approval covers them.
   */
  editSteps(command: unknown): void;
  /** What the edits do, in words, for the approval card ("Receptacles every 12 ft, Level 2"). */
  label(text: string): void;
  /**
   * Shows a value the script read or worked out to the agent, beside the
   * preview (`report` in bim_run_script's answer): levels and their ids, a
   * room's area, a calc's answer. Plain data only (numbers, text, lists,
   * objects); at most 50 reports and 16 KB a run. A script that only
   * reports, and makes no edits, still runs: its preview has nothing to
   * apply. If the run stops, what it reported so far is in the message.
   */
  report(label: string, value: unknown): void;
  /** The engineering calculations a script can run (code calcs, duct and pipe reports, service size). */
  calcs(): readonly ScriptCalcInfo[];
  /**
   * Runs one calculation, on the model as this script has it so far (earlier
   * edits included). Use the answer to decide edits (sizes, slopes, breakers).
   * Without an edition, a code calc uses its default edition: the host's
   * adopted codes are not read from a script.
   */
  calc(request: ScriptCalcRequest): RunResult;
  /** The reads the model's add-ons offer (computed answers: loads, plans, sizes, catalogues). */
  reads(): readonly ScriptReadInfo[];
  /**
   * Runs one add-on read on the model as this script has it so far. Reads
   * never edit: a plan's `command` is sent with `ctx.edit` when the script
   * keeps it. A refusal fails the run with the add-on's words.
   */
  read<T = unknown>(id: string, input?: unknown): T;
  /** The proposers the model's add-ons offer (receptacles by code spacing, cleanouts…). */
  proposers(): readonly ScriptProposerInfo[];
  /** Runs one proposer on the script's model: ghost placements with the reason and code clause for each, nothing placed. */
  propose(proposerId: string, request: ProposerRequest): ProposerAnswer;
  /** Places the ghosts kept (all of them, or a filtered list) as one edit, on their level; nothing is connected. */
  acceptGhosts(ghosts: readonly GhostPlacement[], label: string): void;
  /** Part scripts: one part type (one size of the part, usually), saved under `typeId`. */
  readonly parts: { define(typeId: string, definition: PartTypeDefinition): void };
}

/** The calculation registry scripts run (pure: no files, no network). */
const scriptCalcs = builtinCalcRegistry();

export class ScriptRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRunError";
  }
}

export interface RunScriptInput {
  readonly slice: ModelSlice;
  /** Stored values (`resolveValues`). */
  readonly values: Readonly<Record<string, ScriptValue>>;
  /** The script item's content hash: part of every id's seed. */
  readonly scriptHash: string;
  /**
   * The model's own add-ons beyond the installed first-party ones, in force
   * while each edit is decided (a sealed runner builds it from `slice.addOns`).
   * Absent: whatever is in force in this process.
   */
  readonly packs?: PackSet;
}

/** Words for the first-party trades a slice's add-ons leave out ("" when it names them all, or names none). */
function missingTradesWords(slice: ModelSlice): string {
  if (!slice.addOns) return "";
  const missing = FIRST_PARTY_PACK_IDS.filter((id) => !slice.addOns?.some((a) => a.id === id)).map((id) => firstPartyPackName(id) ?? id);
  if (missing.length === 0) return "";
  return `. This model's add-ons don't include ${missing.join(", ")}`;
}

/**
 * Runs a defined script against a slice, in this process: the runner calls
 * this inside its sandbox, the CLI on a laptop, tests in Jest. Each edit is
 * parsed with the kernel's schema and applied with `executeCommand` to a
 * working copy, so a refused step fails the run with the step and the
 * kernel's reason, and later steps see earlier ones.
 */
export async function runScript(definition: ScriptDefinition, input: RunScriptInput): Promise<ScriptOutput> {
  const kind = definition.manifest.kind;
  const seed: RunSeed = { scriptHash: input.scriptHash, values: input.values, revision: input.slice.revision };
  const random = seededRandom(seed);
  let counter = 0;
  let working: ModelState = sliceAsModel(input.slice);
  const steps: EditStep[] = [];
  const types: { typeId: string; definition: PartTypeDefinition }[] = [];
  const typeIds = new Set<string>();
  let label = "";
  const reports: ScriptReport[] = [];
  let reportBytes = 2;
  let reportsCut = false;
  const features = new Set(input.slice.features);
  const serverReads = (feature: string) => features.has(feature);
  const ctx: ScriptContext = {
    kind,
    model: sliceReader(input.slice, () => working),
    id: (prefix) => deterministicId(seed, counter++, prefix),
    random,
    label(text) {
      label = text.trim().slice(0, 160);
    },
    report(text, value) {
      const words = typeof text === "string" ? text.trim().slice(0, 120) : "";
      if (!words) throw new ScriptRunError('ctx.report takes a label first: ctx.report("Levels", ctx.model.levels()).');
      const plain = plainData(words, value);
      if (reportsCut) return;
      const entry = { label: words, value: plain };
      const bytes = jsonBytes(entry) + 1;
      if (reports.length >= MAX_SCRIPT_REPORTS - 1 || reportBytes + bytes > MAX_SCRIPT_REPORT_BYTES - jsonBytes(REPORTS_CUT) - 1) {
        reports.push(REPORTS_CUT);
        reportsCut = true;
        return;
      }
      reports.push(entry);
      reportBytes += bytes;
    },
    calcs() {
      return withPackSet(input.packs, () => scriptCalcs.list()).map((c) => ({ id: c.id, title: c.title, domain: c.domain, summary: c.summary, readsModel: c.needsModel }));
    },
    calc(request) {
      return withPackSet(input.packs, () => scriptCalcs.run({ ...request, model: working }));
    },
    editSteps(command) {
      if (typeof command !== "object" || command === null || !("type" in command) || typeof command.type !== "string") throw new ScriptRunError("editSteps takes an edit (an object with a type), e.g. a plan's command from ctx.read.");
      const steps: unknown = "commands" in command && NESTED_BATCHES.has(command.type) ? command.commands : null;
      if (Array.isArray(steps)) for (const step of steps) ctx.editSteps(step);
      else ctx.edit(command as Command);
    },
    reads() {
      return withPackSet(input.packs, () => activePackSet().items(PACK_READ_POINT)).map((r) => ({ id: r.id, label: r.label }));
    },
    read<T>(id: string, readInput?: unknown): T {
      const def = withPackSet(input.packs, () => activePackSet().items(PACK_READ_POINT).find((r) => r.id === id));
      if (!def) throw new ScriptRunError(`No add-on read "${id}" on this model. ctx.reads() lists them${missingTradesWords(input.slice)}.`);
      const out: unknown = withPackSet(input.packs, () => def.run(working, readInput ?? {}));
      if (isRefusal(out)) throw new ScriptRunError(`${def.label}: ${out.refused}`);
      return out as T;
    },
    proposers() {
      return withPackSet(input.packs, () => proposersFor(working)).map((p) => ({ id: p.id, label: p.label, hosts: p.hosts }));
    },
    propose(proposerId, request) {
      const answer = withPackSet(input.packs, () => runProposer(working, proposerId, request));
      if ("refused" in answer) throw new ScriptRunError(answer.refused);
      return answer;
    },
    acceptGhosts(ghosts, words) {
      const command = acceptGhostsCommand(working, ghosts, { label: words, partIdPrefix: deterministicId(seed, counter++, "ghost") });
      if (typeof command === "string") throw new ScriptRunError(command);
      ctx.edit(command);
    },
    edit(command) {
      if (kind === "part") throw new ScriptRunError("A part script makes part types (ctx.parts.define), not edits.");
      const n = steps.length + 1;
      const why = stepRefusal(command);
      if (why) throw new ScriptRunError(`Step ${n}: ${why}`);
      // Parsed as a one-step batch: the kernel's own check that it is a single edit a batch may hold.
      const one = { type: "batch_edits", commands: [command] };
      const parsed = withPackSet(input.packs, () => commandSchema.safeParse(one));
      if (!parsed.success) throw new ScriptRunError(`Step ${n} (${command.type}) isn't a valid edit: ${commandIssueMessage(parsed.error, one)}${unitWords(command)}${missingTradesWords(input.slice)}`);
      const step = isEditBatchCommand(parsed.data) ? parsed.data.commands[0] : undefined;
      if (!step) throw new ScriptRunError(`Step ${n} (${command.type}) isn't a single edit.`);
      const result = withPackSet(input.packs, () => withUpgradePolicy(serverReads, () => executeCommand(working, step)));
      if (!result.ok) throw new ScriptRunError(`Step ${n} (${command.type}) was refused: ${result.error.message}${missingTradesWords(input.slice)}`);
      working = result.model;
      steps.push(step);
    },
    parts: {
      define(typeId, def) {
        if (kind !== "part") throw new ScriptRunError("Only a part script defines part types.");
        if (typeIds.has(typeId)) throw new ScriptRunError(`Part type ${typeId} is defined twice.`);
        typeIds.add(typeId);
        types.push({ typeId, definition: def });
      },
    },
  };
  bindWorking(ctx, { model: () => working, packs: input.packs });
  try {
    await definition.runWith(ctx, input.values);
  } catch (err) {
    throw withReports(err, reports);
  }
  const report = reports.length > 0 ? { report: reports } : {};
  if (kind === "part") {
    if (types.length === 0) throw withReports(new ScriptRunError("The part script defined no part types."), reports);
    return { kind: "part_types", types, ...report };
  }
  if (steps.length === 0) {
    if (reports.length === 0) throw new ScriptRunError("The script made no edits. To see values without editing, ctx.report them.");
    return { kind: "edits", label: label || "Nothing changed: reports only", steps: 0, batches: [], ...report };
  }
  const words = label || `${steps.length} edit${steps.length === 1 ? "" : "s"} by script`;
  return { kind: "edits", label: words, steps: steps.length, batches: chunkEdits(words, steps), ...report };
}

/** The report that stands in for those past the run's limit. */
const REPORTS_CUT: ScriptReport = { label: "more", value: `Reports past ${MAX_SCRIPT_REPORTS} or ${MAX_SCRIPT_REPORT_BYTES / 1024} KB were left out; report less, or a summary.` };

/** A reported value as plain JSON data, or the script's error in words. */
function plainData(label: string, value: unknown): unknown {
  if (value === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new ScriptRunError(`ctx.report("${label}") takes plain data (numbers, text, lists, objects); this value can't be written out (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (text === undefined) throw new ScriptRunError(`ctx.report("${label}") takes plain data (numbers, text, lists, objects), not a function or symbol.`);
  return JSON.parse(text);
}

/** At most this much of a stopped run's message is its reports (the runner keeps 4000 characters). */
const STOPPED_REPORT_CHARS = 1500;

/** The error, with what the script reported before it stopped (an error from the script's own realm keeps its stack, so its line). */
function withReports(err: unknown, reports: readonly ScriptReport[]): unknown {
  if (reports.length === 0 || typeof err !== "object" || err === null) return err;
  const message: unknown = Reflect.get(err, "message");
  if (typeof message !== "string") return err;
  const room = Math.min(STOPPED_REPORT_CHARS, 3500 - message.length);
  if (room < 80) return err;
  const all = reports.map((r) => `${r.label}: ${JSON.stringify(r.value)}`).join("; ");
  Reflect.set(err, "message", `${message}. What it reported before stopping: ${all.length > room ? `${all.slice(0, room - 1)}…` : all}`);
  return err;
}

/** Why an edit that didn't parse may hold a units.* value or NaN where the kernel wants plain millimetres ("" when it doesn't). */
function unitWords(command: unknown): string {
  const found = unitProblem(command, "", 0, { left: 20_000 });
  return found ? `. ${found} Kernel commands take plain millimetres: units.in_(length, "mm") is the number, or use a kit helper (building.walls, building.ceiling, equipment.place) that takes units.* values.` : "";
}

function unitProblem(value: unknown, path: string, depth: number, budget: { left: number }): string | null {
  if (budget.left-- <= 0 || depth > 12) return null;
  if (typeof value === "number") return Number.isNaN(value) ? `${path || "A value"} is NaN: arithmetic on a units.* value (a measure, not a number) gives NaN.` : null;
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = unitProblem(v, `${path}[${i}]`, depth + 1, budget);
      if (found) return found;
    }
    return null;
  }
  const keys = Object.keys(value);
  const kind: unknown = Reflect.get(value, "kind");
  if (keys.length === 2 && typeof kind === "string" && typeof Reflect.get(value, "value") === "number") return `${path || "A value"} is a ${kind} measure (units.*), not a number.`;
  for (const k of keys) {
    const found = unitProblem(Reflect.get(value, k), path ? `${path}.${k}` : k, depth + 1, budget);
    if (found) return found;
  }
  return null;
}

/** The batches a plan may come as; each holds single edits (or, for batch_edits, more batches). */
const NESTED_BATCHES: ReadonlySet<string> = new Set(["batch_edits", "batch_documents", "batch_service_links"]);

function isRefusal(value: unknown): value is { readonly refused: string } {
  return typeof value === "object" && value !== null && "refused" in value && typeof value.refused === "string";
}

/** The kit's static check of a script's source before anything runs (library rule; same words at install). */
export function checkScriptSource(source: string): string[] {
  return scriptSourceIssues(source);
}
