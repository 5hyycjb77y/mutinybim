import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BIM_TOOL_PACKS, CORE_PACK_ID, bimPack, bimPackOfTool } from "@permitzip/bim-plugin";
import type { BimToolHost } from "./host";
import { registerBimNetworkReadTools, registerBimSummaryReadTools } from "./reads/tools";
import type { CoreSchemas } from "./schemas";
import { registerBimScriptTools, type ScriptToolOptions } from "./scripts/tools";

/**
 * The MutinyBIM tool server: one deliberately small core pack, and an
 * extension point for add-on packs.
 *
 * The core is script execution first: the agent learns the kit
 * (bim_script_reference), checks a script (bim_check_output), runs it for a
 * preview that saves nothing (bim_run_script), and lands the result after a
 * person approves (bim_apply_output, or bim_save_part_type for a part
 * script). Four reads let it look before it writes. Every other capability
 * (walls, routes, equipment, circuits, sheets, schedules) is a kit function
 * inside a script, not another tool, so the agent's context stays small
 * however much the kit grows.
 *
 * Pack membership still lives in one place, the `@permitzip/bim-plugin`
 * catalogue: the core is its core pack, and every other pack is a family.
 */

/** The core reads. */
export const CORE_READ_TOOLS = ["bim_model_summary", "bim_query_elements", "bim_inspect_network", "bim_validation_issues"] as const;

/** The core pack, in list order: the script tools, then the reads (the catalogue's core pack). */
export const CORE_TOOLS: readonly string[] = bimPack(CORE_PACK_ID)?.tools ?? [];

/**
 * The core's one server-control tool: lists the opt-in tool families and turns
 * one on for this session (MCP `notifications/tools/list_changed`). It is on
 * the server only when a family is there to turn on, and it counts against
 * the core budget.
 */
export const PACK_CONTROL_TOOL = "bim_enable_pack";

/** The most tools the default list (the core) may hold. Raising it is the maintainer's call. */
export const CORE_TOOL_BUDGET = 10;

/** Opt-in tool families: the catalogue's packs (by slug), less the core. */
export const TOOL_FAMILIES: readonly string[] = BIM_TOOL_PACKS.filter((p) => p.id !== CORE_PACK_ID).map((p) => p.slug);

/** The family a tool belongs to (its catalogue pack's slug), or null for a tool the catalogue doesn't list. */
export function toolFamily(tool: string): string | null {
  return bimPackOfTool(tool)?.slug ?? null;
}

/** A family by slug, id or skill name ("ducts-pipes", "ducts_pipes", "mutinybim-ducts-pipes"), or null. */
export function familySlug(name: string): string | null {
  const slug = bimPack(name)?.slug ?? null;
  return slug && TOOL_FAMILIES.includes(slug) ? slug : null;
}

/** Core tools the catalogue doesn't list (always empty; a test holds it there). */
export function coreToolsOutsideCatalogue(): string[] {
  return CORE_TOOLS.filter((name) => !bimPackOfTool(name));
}

export interface CoreToolOptions extends ScriptToolOptions {
  readonly schemas?: CoreSchemas;
}

/** Registers the core pack on a server a host already has (its own transport, auth and middleware). */
export function registerBimCoreTools(server: McpServer, host: BimToolHost, options: CoreToolOptions = {}): void {
  registerBimScriptTools(server, host, options);
  registerBimSummaryReadTools(server, host, options);
  registerBimNetworkReadTools(server, host, options);
}

/**
 * An add-on tool pack: more tools on the same server, registered after the
 * core, without touching it. A pack's tools reach the model only through the
 * host it is given, so they get the same identity, permissions, approvals and
 * model server as the core.
 */
export interface BimToolPack {
  readonly id: string;
  /** What the pack is for, in one line (the server lists it in its instructions). */
  readonly purpose: string;
  /** Tool names it registers (unique on the server; a core name is refused). */
  readonly tools: readonly string[];
  register(server: McpServer, host: BimToolHost): void;
}

export interface BimToolServerOptions extends CoreToolOptions {
  readonly host: BimToolHost;
  readonly packs?: readonly BimToolPack[];
  /**
   * Which families' tools are listed from the start: family slugs, or "all".
   * Default: none, the core only. The rest stay registered but off until the
   * agent turns one on with `bim_enable_pack`.
   */
  readonly families?: readonly string[] | "all";
  readonly name?: string;
  readonly version?: string;
  /** Added after the server's own instructions (how this host approves, where scripts run). */
  readonly instructions?: string;
  /**
   * Wraps every tool's handler (core, packs and `bim_enable_pack`) as it is
   * registered: a host that answers some calls itself (a model it reaches
   * elsewhere) does so here, and calls `next` for the rest. The tool's name,
   * schema and listing are unchanged.
   */
  readonly aroundTool?: ToolCallWrapper;
}

/** A tool handler as registered: the parsed arguments (absent for a tool with none) and the request's extra. */
export type ToolHandler = (...args: never[]) => unknown;
/** Wraps one tool's handler; return `next` to leave the tool as it is. */
export type ToolCallWrapper = (name: string, next: ToolHandler) => ToolHandler;

export const BIM_TOOL_SERVER_VERSION = "0.1.0";

const CORE_INSTRUCTIONS =
  "MutinyBIM tool server: read and change a MutinyBIM building model by writing scripts with the open-source kit. " +
  "Start with bim_script_reference (no arguments: the workflow, the kit's functions, whether scripts can run here), then bim_model_summary. " +
  "Workflow: write the script → bim_check_output → bim_run_script (a preview; nothing is saved) → show the person → bim_apply_output (or bim_save_part_type) with apply_with.args. " +
  "Nothing changes until the person approves; one result is one undo step. Pass base_revision = the revision you read; a stale preview is refused and you run it again.";

/** Packs that would break the server: a core name, a name twice, an empty id. */
export function packProblems(packs: readonly BimToolPack[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>(CORE_TOOLS);
  for (const pack of packs) {
    if (!pack.id.trim()) problems.push("A tool pack has no id.");
    for (const tool of pack.tools) {
      if (seen.has(tool)) problems.push(`Tool pack ${pack.id}: ${tool} is already on this server${CORE_TOOLS.includes(tool) ? " (a core tool)" : ""}.`);
      seen.add(tool);
    }
  }
  return problems;
}

/** A server whose `registerTool` passes each tool's handler (its last argument) through `wrap` first. */
function wrappingTools(server: McpServer, wrap: ToolCallWrapper): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          const register = target.registerTool.bind(target) as (name: string, ...args: unknown[]) => RegisteredTool;
          const last = rest[rest.length - 1];
          if (typeof last === "function") rest[rest.length - 1] = wrap(name, last as ToolHandler);
          return register(name, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A server whose `registerTool` also keeps each tool's handle (to turn it on or off later). */
function recordingTools(server: McpServer, handles: Map<string, RegisteredTool>): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          const register = target.registerTool.bind(target) as (name: string, ...args: unknown[]) => RegisteredTool;
          const handle = register(name, ...rest);
          handles.set(name, handle);
          return handle;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A registered add-on tool: its handle and its family (catalogue slug, or the outside pack's own id). */
interface FamilyTool {
  readonly handle: RegisteredTool;
  readonly family: string;
}

interface FamilyHere {
  readonly id: string;
  readonly purpose: string;
}

/** The families on this server: the catalogue's that have tools here, then outside packs (by id), each with a one-line purpose. */
function familiesHere(tools: ReadonlyMap<string, FamilyTool>, packs: readonly BimToolPack[]): FamilyHere[] {
  const present = new Set([...tools.values()].map((t) => t.family));
  const catalogue = BIM_TOOL_PACKS.filter((p) => TOOL_FAMILIES.includes(p.slug) && present.has(p.slug)).map((p) => ({ id: p.slug, purpose: p.purpose }));
  const outside = packs.filter((p) => present.has(p.id) && !TOOL_FAMILIES.includes(p.id)).map((p) => ({ id: p.id, purpose: p.purpose }));
  return [...catalogue, ...outside];
}

/** A family name as given (slug, id or skill name, or an outside pack's id), resolved against the families here. */
function resolveFamily(name: string, here: readonly FamilyHere[]): string | null {
  const slug = familySlug(name) ?? name;
  return here.some((f) => f.id === slug) ? slug : null;
}

function familyLines(tools: ReadonlyMap<string, FamilyTool>, here: readonly FamilyHere[]): string[] {
  return here.map((f) => {
    const members = [...tools.values()].filter((t) => t.family === f.id);
    const on = members.filter((t) => t.handle.enabled).length;
    return `- ${f.id} (${members.length} tools, ${on === members.length ? "on" : on > 0 ? `${on} on` : "off"}): ${f.purpose}`;
  });
}

function registerPackControlTool(server: McpServer, tools: ReadonlyMap<string, FamilyTool>, here: readonly FamilyHere[]): void {
  const ids = here.map((f) => f.id);
  server.registerTool(
    PACK_CONTROL_TOOL,
    {
      title: "Turn on a tool family",
      description:
        "Scripts can do almost everything (see bim_script_reference); turn on a tool family only when the job needs its single-purpose tools. " +
        "No argument: lists the families, one line each, and which are on. With `family`: turns that family's tools on for this session; the tool list changes (notifications/tools/list_changed).",
      inputSchema: { family: z.string().optional().describe(`A family: ${ids.join(", ")}.`) },
    },
    async ({ family }) => {
      if (family === undefined) return { content: [{ type: "text" as const, text: `Tool families here:\n${familyLines(tools, here).join("\n")}` }] };
      const slug = resolveFamily(family, here);
      if (!slug) return { isError: true, content: [{ type: "text" as const, text: `"${family}" is not a tool family here. Families: ${ids.join(", ")}.` }] };
      const turned: string[] = [];
      for (const [name, tool] of tools) {
        if (tool.family === slug && !tool.handle.enabled) {
          tool.handle.enable();
          turned.push(name);
        }
      }
      const words = turned.length > 0 ? `Turned on ${slug}: ${turned.join(", ")}. Your tool list has changed.` : `${slug} is already on (or has no tools on this server).`;
      return { content: [{ type: "text" as const, text: words }] };
    },
  );
}

/**
 * A ready MCP server: the core pack, then each add-on pack. Families outside
 * `families` are registered but off: the default list is the core (at most
 * CORE_TOOL_BUDGET tools, `bim_enable_pack` included). Connect it to stdio or
 * HTTP (transports.ts).
 */
export function createBimToolServer(options: BimToolServerOptions): McpServer {
  const packs = options.packs ?? [];
  const problems = packProblems(packs);
  if (problems.length > 0) throw new Error(`The MutinyBIM tool server can't start: ${problems.join(" ")}`);
  const packLine = packs.length > 0 ? ` More tools are here in families that are off until you turn one on with ${PACK_CONTROL_TOOL}; a script usually does the job without them.` : "";
  const server = new McpServer(
    { name: options.name ?? "mutinybim", version: options.version ?? BIM_TOOL_SERVER_VERSION },
    { instructions: `${CORE_INSTRUCTIONS}${packLine}${options.instructions ? ` ${options.instructions}` : ""}` },
  );
  const target = options.aroundTool ? wrappingTools(server, options.aroundTool) : server;
  registerBimCoreTools(target, options.host, options);
  const tools = new Map<string, FamilyTool>();
  for (const pack of packs) {
    const handles = new Map<string, RegisteredTool>();
    pack.register(recordingTools(target, handles), options.host);
    for (const [name, handle] of handles) tools.set(name, { handle, family: toolFamily(name) ?? pack.id });
  }
  if (options.families === "all") return server;
  const here = familiesHere(tools, packs);
  const on = new Set<string>();
  for (const name of options.families ?? []) {
    const id = resolveFamily(name, here);
    if (!id) throw new Error(`The MutinyBIM tool server can't start: "${name}" is not a tool family here. Families: ${here.map((f) => f.id).join(", ")}.`);
    on.add(id);
  }
  for (const tool of tools.values()) if (!on.has(tool.family)) tool.handle.disable();
  if (tools.size > 0) registerPackControlTool(target, tools, here);
  return server;
}
