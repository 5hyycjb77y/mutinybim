import { executeCommand, type Actor, type BranchRef, type Command, type CommandError, type Connection, type ElementId, type Interest, type ModelState } from "@permitzip/bim-kernel";
import { SyncClient, type BranchRequest, type MergeRequest } from "./client";
import type { BranchServerMessage } from "./branches/protocol";
import type { MergeServerMessage } from "./merge/messages";
import { peerHas } from "./protocol-version";
import { decideWithUpgrades } from "./upgrade-policy";
import type { CommitOutcome } from "./store";
import { syncUrlForModel } from "./sync-url";

/**
 * Server-side agent connection to the authority. An agent edits through the
 * exact path a browser uses: the same hello (with the person's login), the same
 * kernel commands, the same outcome. Results are what the authority decided,
 * never a locally fabricated success.
 */

export interface AgentSocket {
  send(data: string): void;
  close(): void;
}

export interface AgentSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(reason: string): void;
}

export type AgentSocketFactory = (url: string, handlers: AgentSocketHandlers) => AgentSocket;

/** Uses the runtime's built-in WebSocket (Node 22+, browsers). */
export function builtinWebSocketFactory(): AgentSocketFactory {
  const Ctor = globalThis.WebSocket;
  if (typeof Ctor !== "function") throw new Error("This runtime has no built-in WebSocket; pass a socket factory");
  return (url, handlers) => {
    const ws = new Ctor(url);
    ws.addEventListener("open", () => handlers.onOpen());
    ws.addEventListener("message", (event) => handlers.onMessage(typeof event.data === "string" ? event.data : String(event.data)));
    ws.addEventListener("close", (event) => handlers.onClose(event.reason || `closed (${event.code})`));
    ws.addEventListener("error", () => handlers.onClose("connection error"));
    return { send: (data) => ws.send(data), close: () => ws.close() };
  };
}

export class AgentSessionError extends Error {
  constructor(
    readonly code: "denied" | "timeout" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

/** What happened to one edit, in the authority's words. */
export type AgentEditResult =
  | {
      readonly status: "saved";
      readonly revision: number;
      /** The edit was decided against a newer head than the agent read (no conflict, so it still applied). */
      readonly rebased: boolean;
      /** Elements the edit changed, as the kernel planned it on the head the agent read. */
      readonly changedIds: readonly ElementId[];
      /** What else happened, in words (run ends capped or left open, a trunk kept whole). */
      readonly summary?: readonly string[];
      /** Issues open before this edit that it left alone. Absent when the model is valid. */
      readonly openIssues?: readonly { readonly code: string; readonly message: string; readonly elementIds: readonly ElementId[] }[];
    }
  | {
      readonly status: "conflict";
      readonly message: string;
      readonly elementIds: readonly ElementId[];
      readonly withActor: string | null;
      readonly withRevision: number | null;
      /** Read the model again from this revision, then re-plan. */
      readonly latestRevision: number;
    }
  | {
      readonly status: "refused";
      readonly code: string;
      readonly message: string;
      readonly elementIds: readonly ElementId[];
      readonly latestRevision: number;
    }
  | {
      /** Sent but not confirmed in time (for example the database is unreachable); it will be retried with the same key. */
      readonly status: "not_saved_yet";
      readonly message: string;
    };

/** What an edit would do at the revision read, without sending it (an agent's dry run). */
export type AgentPreview =
  | {
      readonly status: "would_save";
      readonly revision: number;
      readonly changedIds: readonly ElementId[];
      readonly removedIds: readonly ElementId[];
      readonly cutConnections: readonly Connection["id"][];
      /** What else would happen, in words (run ends capped or left open, a trunk kept whole). */
      readonly summary?: readonly string[];
      /** Only when the model server agrees at commit time; someone may change the same thing first. */
      readonly note: string;
    }
  | { readonly status: "would_refuse"; readonly revision: number; readonly code: CommandError["code"]; readonly message: string; readonly elementIds: readonly ElementId[] };

export interface AgentSessionOptions {
  readonly url: string;
  readonly token: string;
  readonly modelId: string;
  readonly actor: Actor;
  /** Load only these areas. Absent: the whole model. */
  readonly interest?: Interest;
  readonly socketFactory?: AgentSocketFactory;
  readonly timeoutMs?: number;
}

interface OutcomeWaiter {
  resolve(outcome: CommitOutcome): void;
}

export class AgentSession {
  private readonly waiters = new Map<string, OutcomeWaiter>();
  private readonly early = new Map<string, CommitOutcome>();
  private closedReason: string | null = null;

  private constructor(
    private readonly client: SyncClient,
    private readonly timeoutMs: number,
  ) {}

  /** Connect, sign in and wait for the model (or the area asked for). */
  static open(opts: AgentSessionOptions): Promise<AgentSession> {
    const factory = opts.socketFactory ?? builtinWebSocketFactory();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      let session: AgentSession | null = null;
      let settled = false;
      const fail = (err: AgentSessionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new AgentSessionError("timeout", "The model server did not answer in time")), timeoutMs);
      const client = new SyncClient(
        { send: (data) => socket.send(data), close: () => socket.close() },
        opts.actor,
        {
          onStatus: (status) => {
            if (status === "live" && !settled && client.confirmedModel()) {
              settled = true;
              clearTimeout(timer);
              resolve(session as AgentSession);
            }
          },
          onDenied: (reason) => fail(new AgentSessionError("denied", reason)),
          onOutcome: (req, outcome) => session?.deliver(req.idempotencyKey, outcome),
        },
        // Agents are short-lived; the head check still recovers a lost broadcast.
        5_000,
        // One session per agent run: the run's own earlier edits are not competing intent; another run's are.
        { token: opts.token, modelId: opts.modelId, interest: opts.interest, clientSessionId: `run:${opts.actor.id}`.slice(0, 128) },
      );
      const socket = factory(syncUrlForModel(opts.url, opts.modelId), {
        onOpen: () => client.opened(),
        onMessage: (data) => client.receive(data),
        onClose: (reason) => {
          client.closed();
          if (session) session.closedReason = reason;
          fail(new AgentSessionError("closed", `The model server closed the connection: ${reason}`));
        },
      });
      session = new AgentSession(client, timeoutMs);
    });
  }

  /** Committed state only. Agents read and plan from this, never from predictions. */
  model(): ModelState {
    const model = this.client.confirmedModel();
    if (!model) throw new AgentSessionError("closed", "Not connected to the model");
    return model;
  }

  revision(): number {
    return this.client.confirmedRevision();
  }

  /** The branch this session is on (null: Main). Approve cards and tool answers name it. */
  branch(): BranchRef | null {
    return this.client.branch();
  }

  /** The model server lists, creates and closes branches here. */
  branchesAvailable(): boolean {
    return this.client.branchesAvailable();
  }

  /** The model server answers `coverage_check` here (round 9). */
  coverageAvailable(): boolean {
    return this.client.coverageAvailable();
  }

  /** A branch or history request on this session (see SyncClient.request). */
  request(msg: BranchRequest): Promise<BranchServerMessage> {
    if (this.closedReason) return Promise.reject(new AgentSessionError("closed", `The model server closed the connection: ${this.closedReason}`));
    return this.client.request(msg);
  }

  /** The model server previews and lands merges of this branch (see SyncClient.mergeRequest). */
  mergeAvailable(): boolean {
    return this.client.mergeAvailable();
  }

  /** `merge_preview` / `merge_apply` on this session's branch (see SyncClient.mergeRequest). */
  mergeRequest(msg: MergeRequest): Promise<MergeServerMessage> {
    if (this.closedReason) return Promise.reject(new AgentSessionError("closed", `The model server closed the connection: ${this.closedReason}`));
    return this.client.mergeRequest(msg);
  }

  /**
   * Submit one kernel command and wait for the authority's answer. The same
   * idempotency key always gets the first answer (a retried tool call is safe).
   */
  async edit(command: Command, opts: { readonly idempotencyKey: string; readonly baseRevision?: number }): Promise<AgentEditResult> {
    if (this.closedReason) throw new AgentSessionError("closed", `The model server closed the connection: ${this.closedReason}`);
    const model = this.model();
    const planned = this.predict(model, command);
    const changedIds = planned.ok ? [...planned.changedIds, ...planned.removedIds] : [];
    const submitted = this.client.submit(command, { idempotencyKey: opts.idempotencyKey, baseRevision: opts.baseRevision });
    if (!submitted.ok) {
      return {
        status: "refused",
        code: submitted.error.code,
        message: submitted.error.message,
        elementIds: submitted.error.elementIds,
        latestRevision: this.revision(),
      };
    }
    const outcome = await this.waitFor(opts.idempotencyKey);
    if (!outcome) {
      return {
        status: "not_saved_yet",
        message: this.client.saveState().message ?? "The model server has not confirmed this edit yet; it will be sent again with the same key",
      };
    }
    if (outcome.status === "committed") {
      await this.waitForRevision(outcome.revision);
      return {
        status: "saved",
        revision: outcome.revision,
        rebased: outcome.rebased,
        changedIds,
        ...(planned.ok && planned.summary ? { summary: planned.summary } : {}),
        ...(planned.ok && planned.openIssues ? { openIssues: planned.openIssues } : {}),
      };
    }
    if (outcome.error.code === "conflict" || outcome.error.code === "stale_base") {
      return {
        status: "conflict",
        message: outcome.error.message,
        elementIds: outcome.error.elementIds,
        withActor: outcome.conflict?.withActor.name ?? null,
        withRevision: outcome.conflict?.withRevision ?? null,
        latestRevision: this.revision(),
      };
    }
    return {
      status: "refused",
      code: outcome.error.code,
      message: outcome.error.message,
      elementIds: outcome.error.elementIds,
      latestRevision: this.revision(),
    };
  }

  /** Decide locally the way the server will: gated record shapes (new service rows, zone bounds, view category overrides) only when the server advertised them. */
  private predict(model: ModelState, command: Command) {
    const server = this.client.serverProtocolOf();
    return decideWithUpgrades(command, (feature) => peerHas(server, feature), () => executeCommand(model, command));
  }

  /** What the server advertised it stores, as an upgrade policy: a host's own preview decides gated shapes the way the server will (round 9 lane Q9). */
  upgradePolicy(): (feature: string) => boolean {
    const server = this.client.serverProtocolOf();
    return (feature) => peerHas(server, feature);
  }

  /** Dry run: the same kernel command on the committed model, nothing sent. */
  preview(command: Command): AgentPreview {
    const model = this.model();
    const planned = this.predict(model, command);
    if (!planned.ok) return { status: "would_refuse", revision: model.revision, code: planned.error.code, message: planned.error.message, elementIds: planned.error.elementIds };
    return {
      status: "would_save",
      revision: model.revision,
      changedIds: planned.changedIds,
      removedIds: planned.removedIds,
      cutConnections: planned.removedConnections.map((c) => c.id),
      ...(planned.summary ? { summary: planned.summary } : {}),
      note: "Nothing was saved. The model server checks it again when you make the edit; if someone changes the same thing first you get a conflict.",
    };
  }

  close(): void {
    this.client.dispose();
  }

  private deliver(key: string, outcome: CommitOutcome): void {
    const waiter = this.waiters.get(key);
    if (waiter) {
      this.waiters.delete(key);
      waiter.resolve(outcome);
    } else {
      this.early.set(key, outcome);
    }
  }

  private waitFor(key: string): Promise<CommitOutcome | null> {
    const early = this.early.get(key);
    if (early) {
      this.early.delete(key);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve(null);
      }, this.timeoutMs);
      this.waiters.set(key, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
    });
  }

  /** The commit is decided; give its broadcast a moment so reads after the edit include it. */
  private async waitForRevision(revision: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (this.client.confirmedRevision() < revision && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
