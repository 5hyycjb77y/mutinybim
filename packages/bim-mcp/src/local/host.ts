import { randomUUID } from "node:crypto";
import { LocalScriptRunner } from "@permitzip/bim-script-runner/local";
import { RUNNER_CONTRACT, type ScriptRunner } from "@permitzip/bim-script";
import { autoApproval, elicitationApproval, type ApprovalGate } from "../approvals";
import type { BimToolHost, ScriptRunnerAvailability, ScriptRunnerHost } from "../host";
import { MemoryScriptLibrary } from "./library";
import { MemoryScriptPreviewStore } from "../scripts/previews";
import type { LocalModelServer } from "./model-server";
import { localCaller, localModelAccess, type LocalModelAccessOptions } from "./models";
import type { ResolveBimCaller } from "../caller";

/**
 * The open host: one person, on their own computer, with their own agent.
 *
 * - Identity: the person running the server (`person`), and one agent run
 *   per server start acting for them.
 * - Authorization: everything is theirs; `readOnly` refuses edits and
 *   library saves; `scripts: false` refuses script runs.
 * - Approval: asked through the agent client (MCP elicitation) by default;
 *   `approve: "auto"` lands everything without asking (a local demo only).
 * - Script runner: a fresh capped local process per script
 *   (`LocalScriptRunner`). Local only: never host other people's scripts
 *   with it.
 * - Model server: in memory, or a running one at a WebSocket address.
 * - Kept scripts: in this process's memory (`MemoryScriptPreviewStore`), so a
 *   script is sent once and a preview lands by its id until the server stops.
 */
export interface LocalHostOptions {
  readonly server: LocalModelServer;
  /** The checkout holding `packages/` (the script runner bundles from it). */
  readonly repoRoot: string;
  readonly person?: string;
  readonly approve?: "ask" | "auto";
  readonly readOnly?: boolean;
  /** false: scripts are refused here (reads and edits through other packs still work). */
  readonly scripts?: boolean;
  /** Another runner (a container, a hosted sandbox); default the local process runner. */
  readonly runner?: ScriptRunner & { availability?(): Promise<ScriptRunnerAvailability> };
  readonly partGeometry?: LocalModelAccessOptions["partGeometry"];
}

export const LOCAL_RUNS_WHERE = "in a fresh local process (1 GB, 30 s, 2 MB; this computer only, not network-sealed)";

export interface LocalHost extends BimToolHost {
  readonly person: string;
  /** The caller add-on packs work through. */
  readonly caller: ResolveBimCaller;
  readonly runId: string;
  readonly library: BimToolHost["library"];
}

export function createLocalHost(options: LocalHostOptions): LocalHost {
  const person = options.person ?? "local-user";
  const runId = `local-${randomUUID().slice(0, 8)}`;
  const access = { server: options.server, person, runId, ...(options.readOnly ? { readOnly: true } : {}), ...(options.partGeometry ? { partGeometry: options.partGeometry } : {}) };
  const models = localModelAccess(access);
  const library = new MemoryScriptLibrary(person);
  const kept = new MemoryScriptPreviewStore();
  const runner = options.runner ?? new LocalScriptRunner({ repoRoot: options.repoRoot, limits: RUNNER_CONTRACT });
  const scriptsOff = options.scripts === false;
  const runnerHost: ScriptRunnerHost = {
    run: (request) => runner.run(request),
    async availability() {
      if (scriptsOff) return { ok: false, reason: "this tool server was started with scripts off (--no-scripts)" };
      return runner.availability ? runner.availability() : { ok: true };
    },
  };
  const approvals: ApprovalGate = options.approve === "auto" ? autoApproval : elicitationApproval();
  return {
    person,
    runId,
    caller: localCaller({ ...access, approvals }),
    withModel: models.withModel,
    withArea: models.withArea,
    edit: models.edit,
    runner: () => runnerHost,
    scope: (_extra, projectId) => ({ conversationId: runId, projectId }),
    library: async () => library.forCaller(!options.readOnly),
    author: (_extra, callerId) => ({ provider: "mutinybim-local", subject: `agent:${runId}`, kind: "agent", onBehalfOf: { provider: "mutinybim-local", subject: callerId, kind: "person" } }),
    async authorize() {
      return scriptsOff ? { ok: false, reason: "this tool server was started with scripts off (--no-scripts)." } : { ok: true };
    },
    approvals,
    previews: () => kept,
  };
}
