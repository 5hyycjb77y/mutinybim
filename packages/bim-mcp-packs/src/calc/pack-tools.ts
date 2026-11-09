import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { commandIssueMessage, commandSchema, type ModelState } from "@permitzip/bim-kernel";
import { AGENT_TOOL_POINT, COMMAND_BUILDER_POINT, PACK_READ_POINT, type AgentToolDescriptor, type CommandBuilderDef, type Pack } from "@permitzip/bim-kernel/packs";
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";
import { ELECTRICAL_AGENT_TOOLS, ELECTRICAL_PACK_READS } from "@permitzip/bim-pack-electrical";
import { PLUMBING_AGENT_TOOLS, PLUMBING_PACK_READS } from "@permitzip/bim-pack-plumbing";
import { MECHANICAL_AGENT_TOOLS, MECHANICAL_PACK_READS } from "@permitzip/bim-pack-mechanical";
import { bindPinnedPacks, installedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";
import { registerBimPackEditTool } from "../support/tool-names";
import { tradeBaseRevision as baseRevision, explain, failure, notSent, runEdit, tradeTarget as target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import type { PackToolPermissionSink } from "./capabilities";

/**
 * The host for agent tools MutinyBIM add-ons declare (`AGENT_TOOL_POINT`):
 * every tool a pack this server has offers is registered once, guarded like
 * every bim_ tool (model read on the project for a read, model edit for a
 * write), and applies only to models whose active set holds its pack (the
 * first-party add-ons always; any other only where the model pins it). A read
 * runs the pack's `PACK_READ_POINT` row on the open model; a write becomes
 * the declared kernel command and goes through `runEdit`, the edit spine and
 * approval every bim_ edit uses. Tools that need host services (the
 * project's adopted codes, files, sessions' previews) keep a host registration
 * in their trade file, keyed by the declared name.
 */

let permissionSink: PackToolPermissionSink | null = null;

/**
 * A host with a per-tool permission map records each pack tool's permission
 * here before any registers; every pack tool registered afterwards is
 * recorded once. Without one, the caller's own read / edit check is the gate.
 */
export function setPackToolPermissionSink(sink: PackToolPermissionSink | null): void {
  permissionSink = sink;
}

/** A pack's tool read: `run(model, input)`; a refusal is `{ refused: "<plain words>" }`. */
interface PackRead {
  readonly id: string;
  readonly label: string;
  run(model: ModelState, input: unknown): unknown;
}

export interface PackTool {
  readonly packId: string;
  readonly tool: AgentToolDescriptor;
  /** The read a `target.kind: "read"` tool runs, when the pack declares it. */
  readonly read: PackRead | null;
  /** The builder a `target.kind: "build_command"` tool runs, when the pack declares it. */
  readonly builder: CommandBuilderDef | null;
}

interface Declarations {
  readonly tools: readonly AgentToolDescriptor[];
  readonly reads: readonly PackRead[];
  readonly builders?: readonly CommandBuilderDef[];
}

/**
 * Wave 1 of round 6: the first-party packs don't contribute their tools yet
 * (their pack.ts lands in wave 2), so their declarations are read here. A
 * first-party pack that contributes to `AGENT_TOOL_POINT` replaces its row.
 */
const FIRST_PARTY_DECLARATIONS: Readonly<Record<string, Declarations>> = {
  electrical: { tools: ELECTRICAL_AGENT_TOOLS, reads: ELECTRICAL_PACK_READS },
  plumbing_gas: { tools: PLUMBING_AGENT_TOOLS, reads: PLUMBING_PACK_READS },
  mechanical: { tools: MECHANICAL_AGENT_TOOLS, reads: MECHANICAL_PACK_READS },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolDescriptor(value: unknown): value is AgentToolDescriptor {
  return isRecord(value) && typeof value.name === "string" && typeof value.description === "string" && isRecord(value.input) && (value.permission === "read" || value.permission === "write") && isRecord(value.target);
}

function isPackRead(value: unknown): value is PackRead {
  return isRecord(value) && typeof value.id === "string" && typeof value.run === "function";
}

function isCommandBuilder(value: unknown): value is CommandBuilderDef {
  return isRecord(value) && typeof value.id === "string" && typeof value.build === "function";
}

function declaredIn(pack: Pack): Declarations {
  const items = (pointId: string) => pack.contributions.filter((c) => c.pointId === pointId).flatMap((c) => c.items);
  return { tools: items(AGENT_TOOL_POINT.id).filter(isToolDescriptor), reads: items(PACK_READ_POINT.id).filter(isPackRead), builders: items(COMMAND_BUILDER_POINT.id).filter(isCommandBuilder) };
}

function declarationsOf(packId: string, pack: Pack | null): Declarations {
  const own = pack ? declaredIn(pack) : { tools: [], reads: [] };
  if (own.tools.length > 0) return own;
  return FIRST_PARTY_DECLARATIONS[packId] ?? own;
}

function toolsOf(packId: string, declarations: Declarations): PackTool[] {
  const reads = new Map(declarations.reads.map((r) => [r.id, r]));
  const builders = new Map((declarations.builders ?? []).map((b) => [b.id, b]));
  return declarations.tools.map((tool) => ({
    packId,
    tool,
    read: tool.target.kind === "read" ? (reads.get(tool.target.read) ?? null) : null,
    builder: tool.target.kind === "build_command" ? (builders.get(tool.target.build) ?? null) : null,
  }));
}

const FIRST_PARTY_IDS: readonly string[] = Object.keys(FIRST_PARTY_DECLARATIONS);

function firstPartyAddOn(id: string): Pack | null {
  return FIRST_PARTY_ADDONS.find((p) => p.manifest.id === id) ?? null;
}

/** Per host list: packs are frozen, so a list's tools never change. */
const listed = new WeakMap<readonly Pack[], readonly PackTool[]>();

/** Every tool this server's add-ons declare: the first-party add-ons', then each installed pack's. */
export function hostPackTools(host: readonly Pack[] = installedPacks()): readonly PackTool[] {
  const held = listed.get(host);
  if (held) return held;
  const tools = [
    ...FIRST_PARTY_IDS.flatMap((id) => toolsOf(id, declarationsOf(id, firstPartyAddOn(id)))),
    ...host.filter((p) => !FIRST_PARTY_IDS.includes(p.manifest.id)).flatMap((p) => toolsOf(p.manifest.id, declaredIn(p))),
  ];
  listed.set(host, tools);
  return tools;
}


type PinnedModel = Pick<ModelState, "modelId" | "settings">;

/** Whether a model's active set holds this pack: first-party always, any other where the model pins it and this server has it. */
export function packActiveFor(model: PinnedModel, packId: string, host: readonly Pack[] = installedPacks()): boolean {
  return FIRST_PARTY_IDS.includes(packId) || bindPinnedPacks(model, host).has(packId);
}

/** The pack tools that apply to this model: its active set's, nothing from a pack it doesn't pin. */
export function packToolsForModel(model: PinnedModel, host: readonly Pack[] = installedPacks()): readonly PackTool[] {
  return hostPackTools(host).filter((t) => packActiveFor(model, t.packId, host));
}

/** Run a pack tool's read on an open model, as the tool returns it. */
export function dispatchPackRead(model: ModelState, entry: PackTool, input: unknown) {
  if (!entry.read) return failure(`${entry.tool.name} names a read (${entry.tool.target.kind === "read" ? entry.tool.target.read : "none"}) its add-on doesn't have. Nothing was read.`);
  const out = entry.read.run(model, input);
  if (isRecord(out) && typeof out.refused === "string") return failure(out.refused);
  return text(out);
}

/** A pack-declared tool that needs host services registers itself with the declared title and description. */
export type HostedPackTool = (copy: { readonly title: string; readonly description: string }) => void;

export interface PackToolRegistration {
  /** Host registrations by tool name; every other declared tool takes the generic read or command path. */
  readonly hosted?: Readonly<Record<string, HostedPackTool>>;
  /** Exact argument schemas by tool name (a first-party pack's frozen schemas); otherwise the declared JSON Schema is read. */
  readonly shapes?: Readonly<Record<string, z.ZodRawShape>>;
  /** Default: this server's installed packs. */
  readonly host?: readonly Pack[];
  /** Register only these of the pack's tools (a trade file registers its own); default every one. */
  readonly only?: readonly string[];
}

const registeredOn = new WeakMap<object, Set<string>>();

type JsonSchema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;

/** The declared input as zod reads JSON Schema; a property that isn't a schema is refused, naming it. */
function jsonSchemaOf(tool: AgentToolDescriptor): JsonSchema {
  const properties: Record<string, JsonSchema | boolean> = {};
  for (const [key, value] of Object.entries(tool.input.properties)) {
    if (typeof value !== "boolean" && !isRecord(value)) throw new Error(`${tool.name}: input property ${key} isn't a JSON Schema`);
    properties[key] = value;
  }
  const { type, required, additionalProperties, description } = tool.input;
  return { type, properties, ...(required ? { required: [...required] } : {}), ...(additionalProperties !== undefined ? { additionalProperties } : {}), ...(description ? { description } : {}) };
}

function shapeFrom(tool: AgentToolDescriptor): z.ZodRawShape {
  const schema = z.fromJSONSchema(jsonSchemaOf(tool));
  if (!(schema instanceof z.ZodObject)) throw new Error(`${tool.name}: its input schema isn't an object schema`);
  return schema.shape;
}

// Built on first use: this module and its host composer may import each other.
const where = () => z.object({ ...target, ...baseRevision });

function argsIssue(tool: string, issues: readonly z.core.$ZodIssue[]) {
  return failure(`Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
}

const WHERE_KEYS: ReadonlySet<string> = new Set(["project_id", "model_id", "base_revision"]);

function ownArgs(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !WHERE_KEYS.has(key)));
}

function registerOne(server: McpServer, caller: ResolveBimCaller | null, entry: PackTool, options: PackToolRegistration): void {
  const { tool, packId } = entry;
  const done = registeredOn.get(server) ?? new Set<string>();
  registeredOn.set(server, done);
  if (done.has(tool.name)) return;
  done.add(tool.name);
  permissionSink?.(tool.name, tool.permission);
  if (tool.permission === "write") registerBimPackEditTool(tool.name);
  const copy = { title: tool.title, description: tool.description };
  const hosted = options.hosted?.[tool.name];
  if (hosted) {
    hosted(copy);
    return;
  }
  if (!caller) throw new Error(`[mcp:bim-pack-tools] ${tool.name} has no host registration and no caller to run it with`);
  const own = options.shapes?.[tool.name] ?? shapeFrom(tool);
  const ownSchema = z.object(own);
  const host = options.host ?? installedPacks();
  if (tool.target.kind === "read") {
    server.registerTool(tool.name, { ...copy, inputSchema: { ...target, ...own } }, async (raw: Record<string, unknown>, extra: Extra) => {
      const at = where().safeParse(raw);
      const input = ownSchema.safeParse(ownArgs(raw));
      if (!at.success) return argsIssue(tool.name, at.error.issues);
      if (!input.success) return argsIssue(tool.name, input.error.issues);
      try {
        const who = await caller(extra, at.data.project_id, false);
        return await withSession(who, at.data.model_id, undefined, async (s) => {
          const model = s.model();
          if (!packActiveFor(model, packId, host)) return failure(`This model doesn't use the ${packId} add-on, so ${tool.name} doesn't apply to it. Nothing was read.`);
          return dispatchPackRead(model, entry, input.data);
        });
      } catch (err) {
        return explain(err, tool.name);
      }
    });
    return;
  }
  const toolTarget = tool.target;
  server.registerTool(tool.name, { ...copy, inputSchema: { ...target, ...baseRevision, ...own } }, async (raw: Record<string, unknown>, extra: Extra) => {
    const at = where().safeParse(raw);
    const input = ownSchema.safeParse(ownArgs(raw));
    if (!at.success) return argsIssue(tool.name, at.error.issues);
    if (!input.success) return argsIssue(tool.name, input.error.issues);
    if (!FIRST_PARTY_IDS.includes(packId)) {
      try {
        const who = await caller(extra, at.data.project_id, false);
        const active = await withSession(who, at.data.model_id, undefined, async (s) => packActiveFor(s.model(), packId, host));
        if (!active) return failure(`This model doesn't use the ${packId} add-on, so ${tool.name} doesn't apply to it. Nothing changed.`);
      } catch (err) {
        return explain(err, tool.name);
      }
    }
    let built: { readonly type: string };
    if (toolTarget.kind === "command") built = { ...input.data, type: toolTarget.command };
    else {
      const builder = entry.builder;
      if (!builder) return failure(`${tool.name} names a command builder (${toolTarget.build}) its add-on doesn't have. Nothing changed.`);
      try {
        const who = await caller(extra, at.data.project_id, false);
        const out = await withSession(who, at.data.model_id, undefined, async (s) => builder.build(s.model(), input.data));
        if ("refused" in out) return failure(out.refused);
        built = out.command;
      } catch (err) {
        return explain(err, tool.name);
      }
    }
    const checked = commandSchema.safeParse(built);
    if (!checked.success) return failure(notSent(commandIssueMessage(checked.error, built)));
    return runEdit(caller, tool.name, extra, at.data, checked.data);
  });
}

/** Register a pack's declared tools on an MCP server (once per name per server). */
/** `caller` may be null when every tool registered here is hosted. */
export function registerPackTools(server: McpServer, caller: ResolveBimCaller | null, packId: string, options: PackToolRegistration = {}): void {
  const only = options.only ? new Set(options.only) : null;
  const entries = hostPackTools(options.host).filter((t) => t.packId === packId && (!only || only.has(t.tool.name)));
  const declared = new Set(entries.map((t) => t.tool.name));
  const strays = [...Object.keys(options.hosted ?? {}), ...(options.only ?? [])].filter((name) => !declared.has(name));
  if (strays.length > 0) throw new Error(`[mcp:bim-pack-tools] ${packId} doesn't declare ${[...new Set(strays)].join(", ")}, which this host registers`);
  for (const entry of entries) registerOne(server, caller, entry, options);
}

/** Register every tool the installed (non-first-party) packs declare. */
export function registerInstalledPackTools(server: McpServer, caller: ResolveBimCaller, host: readonly Pack[] = installedPacks()): void {
  for (const pack of host) {
    if (FIRST_PARTY_IDS.includes(pack.manifest.id)) continue;
    registerPackTools(server, caller, pack.manifest.id, { host });
  }
}
