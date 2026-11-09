import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, executeCommand, type ModelState } from "@permitzip/bim-kernel";
import { createLocalHost, LOCAL_RUNS_WHERE, type LocalHost } from "./local/host";
import { remoteModelServer, startInMemoryModelServer, type LocalModelServer } from "./local/model-server";
import { LOCAL_SCHEMAS } from "./schemas";
import { createBimToolServer, familySlug, TOOL_FAMILIES, type BimToolPack } from "./server";
import { serveHttp, serveStdio } from "./transports";

/**
 * `mutinybim-mcp`: the MutinyBIM tool server on your own computer.
 *
 *   mutinybim-mcp                                  stdio, an in-memory model "demo", approvals asked in your client
 *   mutinybim-mcp --http --port 3333               streamable HTTP at http://127.0.0.1:3333/mcp
 *   mutinybim-mcp --model-server ws://127.0.0.1:3095/sync --model f-a-demo
 *                                                  the models of a running dev server (npm run demo)
 *   mutinybim-mcp --approve auto                   a local demo: every change lands without asking
 *   mutinybim-mcp --read-only                      reads and previews only
 *   mutinybim-mcp --no-scripts                     scripts refused
 *   mutinybim-mcp --packs drafting,electrical       the core plus those tool families from the start
 *   mutinybim-mcp --packs all --files ./mutinybim-files
 *                                                  the core plus every add-on tool family; sheets and sets are written under --files
 *
 * The default is the core only (scripts do the rest). Every family is still
 * on the server, off: the agent turns one on with bim_enable_pack. Over HTTP,
 * /mcp is the core and /packs/<family>/mcp is the core plus that family.
 */

export interface CliOptions {
  readonly transport: "stdio" | "http";
  readonly port: number;
  readonly host: string;
  readonly modelServer: string | null;
  readonly models: readonly string[];
  readonly approve: "ask" | "auto";
  readonly readOnly: boolean;
  readonly scripts: boolean;
  /** "none": the core only (the default: scripts do the rest). "all": every add-on tool family too. Or the families listed from the start. */
  readonly packs: "none" | "all" | readonly string[];
  /** Where printed sheets, issued sets and saved pictures are written. */
  readonly files: string;
}

export const USAGE =
  "usage: mutinybim-mcp [--http [--port 3333] [--host 127.0.0.1]] [--model-server ws://host:port/sync] [--model <id> ...] [--approve ask|auto] [--read-only] [--no-scripts] [--packs none|all|<family,…>] [--files <dir>]";

export function parseArgs(argv: readonly string[]): CliOptions | { readonly error: string } {
  let transport: CliOptions["transport"] = "stdio";
  let port = 3333;
  let host = "127.0.0.1";
  let modelServer: string | null = null;
  const models: string[] = [];
  let approve: CliOptions["approve"] = "ask";
  let readOnly = false;
  let scripts = true;
  let packs: CliOptions["packs"] = "none";
  let files = "mutinybim-files";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.`);
      return v;
    };
    try {
      if (arg === "--http") transport = "http";
      else if (arg === "--stdio") transport = "stdio";
      else if (arg === "--port") port = Number(value());
      else if (arg === "--host") host = value();
      else if (arg === "--model-server") modelServer = value();
      else if (arg === "--model") models.push(value());
      else if (arg === "--approve") {
        const v = value();
        if (v !== "ask" && v !== "auto") throw new Error(`--approve is ask or auto, not ${v}.`);
        approve = v;
      } else if (arg === "--read-only") readOnly = true;
      else if (arg === "--no-scripts") scripts = false;
      else if (arg === "--packs") {
        const v = value();
        if (v === "none" || v === "all") packs = v;
        else {
          const names = v.split(",").map((s) => s.trim()).filter(Boolean);
          const unknown = names.filter((n) => !familySlug(n));
          if (names.length === 0 || unknown.length > 0) throw new Error(`--packs is none, all or a comma list of families (${TOOL_FAMILIES.join(", ")}), not ${v}.`);
          packs = names.map((n) => familySlug(n) ?? n);
        }
      } else if (arg === "--files") files = value();
      else return { error: `Unknown option ${arg}. ${USAGE}` };
    } catch (err) {
      return { error: `${err instanceof Error ? err.message : String(err)} ${USAGE}` };
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `--port is a port number. ${USAGE}` };
  return { transport, port, host, modelServer, models: models.length > 0 ? models : ["demo"], approve, readOnly, scripts, packs, files };
}

/** An empty model with one level, so a first script has somewhere to put things. */
export function starterModel(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const made = executeCommand(empty, { type: "create_level", levelId: "level-1", name: "Level 1", elevationMm: 0 });
  if (!made.ok) throw new Error(`The starter model couldn't be made: ${made.error.message}`);
  return { ...made.model, revision: 0 as ModelState["revision"] };
}

/** A model server address as the log shows it: a hosted server takes an access key in the address, and the log never shows it. */
export function redactAddress(address: string): string {
  return address.replace(/([?&](?:key|token)=)[^&#]*/gi, "$1…");
}

export interface Started {
  readonly server: LocalModelServer;
  readonly url?: string;
  close(): Promise<void>;
}

/** Starts the server; logs go to stderr (stdout carries the protocol in stdio mode). */
/** Builds the add-on packs for a local host (the bin entry passes `localToolPacks` from @permitzip/bim-mcp-packs). */
export type LocalPacksFactory = (host: LocalHost, filesDir: string) => readonly BimToolPack[];

export async function startCli(options: CliOptions, repoRoot: string, packsFor?: LocalPacksFactory): Promise<Started> {
  // The kernel carries no trade: duct, pipe and wire are first-party add-ons, installed before any model is decided.
  installFirstPartyAddOns();
  const server = options.modelServer ? remoteModelServer(options.modelServer, options.models) : startInMemoryModelServer();
  if (!options.modelServer) for (const id of options.models) await server.seed(starterModel(id));
  const host = createLocalHost({ server, repoRoot, approve: options.approve, readOnly: options.readOnly, scripts: options.scripts });
  const where = options.modelServer ? `the model server at ${redactAddress(options.modelServer)}` : "an in-memory model server (nothing is kept after it stops)";
  const instructions =
    `Models here: ${options.models.join(", ")} (on ${where}); project_id may be left out. ` +
    `Scripts run ${LOCAL_RUNS_WHERE}. ` +
    (options.approve === "auto" ? "Approvals: --approve auto, so changes land without asking (a local demo). " : "Approvals: every change asks the person in their client before it lands. ") +
    (options.readOnly ? "This server is read-only. " : "");
  if (options.packs !== "none" && !packsFor) throw new Error("--packs needs the add-on packs (@permitzip/bim-mcp-packs); start the server with packages/bim-mcp/bin/mutinybim-mcp.mjs.");
  const startFamilies = options.packs === "none" ? [] : options.packs;
  const make = (families: readonly string[] | "all" = startFamilies) =>
    createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE, instructions, families, ...(packsFor ? { packs: packsFor(host, options.files) } : {}) });
  const log = (line: string) => process.stderr.write(`[mutinybim-mcp] ${line}\n`);
  if (options.approve === "auto") log("--approve auto: every change lands without asking. Use this only for a local demo.");
  if (options.transport === "stdio") {
    const mcp = await serveStdio(() => make());
    log(`serving on stdio; models ${options.models.join(", ")} on ${where}`);
    return { server, close: async () => { await mcp.close(); await server.close(); } };
  }
  const http = await serveHttp(make, { port: options.port, host: options.host, families: TOOL_FAMILIES });
  log(`serving streamable HTTP at ${http.url}; models ${options.models.join(", ")} on ${where}`);
  return { server, url: http.url, close: async () => { await http.close(); await server.close(); } };
}
