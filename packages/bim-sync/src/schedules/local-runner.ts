import { applyChangeset, type Changeset, type Command, type CommandError, type CommandRequest, type ModelState } from "@permitzip/bim-kernel";
import type { ScheduleChannel } from "../client";
import type { CommitOutcome } from "../store";
import type { ScheduleClientPort } from "./connection";
import type { ScheduleEvaluator } from "./evaluator";
import type { ScheduleClientMessage, ScheduleServerMessage } from "./protocol";
import { ScheduleSubscriptions } from "./subscriptions";

/**
 * Standalone, single-process MutinyBIM (no model server): the same
 * subscription engine runs next to the local model, ideally in a Web Worker
 * so a big schedule never blocks drawing. The schedule grid talks to it
 * through the same `SyncScheduleConnection` it uses against the authority.
 */

const LOCAL = "local";

/** Runs schedule subscriptions over a local model. Feed it the model's commits. */
export class LocalScheduleRunner {
  private readonly subscriptions: ScheduleSubscriptions;
  private model: ModelState;

  constructor(
    evaluator: ScheduleEvaluator,
    model: ModelState,
    private readonly send: (msg: ScheduleServerMessage) => void,
  ) {
    this.model = model;
    this.subscriptions = new ScheduleSubscriptions(evaluator, (_subscriber, _revision, msg) => this.send(msg), {
      loadHead: () => Promise.resolve(this.model),
    });
  }

  get metrics() {
    return this.subscriptions.metrics;
  }

  /** A local commit landed (the standalone sequencer's commit listener). `model` is the model after it. */
  commit(cs: Changeset, model: ModelState): void {
    this.model = model;
    this.subscriptions.onCommit(cs);
  }

  handle(msg: ScheduleClientMessage): Promise<void> {
    switch (msg.type) {
      case "schedule_open":
        return this.subscriptions.open(LOCAL, msg.subscriptionId, msg.target, msg.window);
      case "schedule_window":
        this.subscriptions.setWindow(LOCAL, msg.subscriptionId, msg.window);
        return Promise.resolve();
      case "schedule_close":
        this.subscriptions.close(LOCAL, msg.subscriptionId);
        return Promise.resolve();
      // One person, one process: there is nobody to hold a cell against.
      case "editing_cell":
      case "editing_cell_release":
        return Promise.resolve();
    }
  }

  flush(): void {
    this.subscriptions.flush();
  }
}

/** Messages the main thread posts to a schedule worker. */
export type ScheduleWorkerInbound =
  /** The model as JSON (what a welcome carries), sent once at start and again after a reload. */
  | { readonly type: "load"; readonly model: string }
  | { readonly type: "commit"; readonly changeset: Changeset }
  | { readonly type: "schedule"; readonly message: ScheduleClientMessage };

export interface WorkerScope {
  postMessage(message: ScheduleServerMessage): void;
  addEventListener(type: "message", listener: (event: { readonly data: ScheduleWorkerInbound }) => void): void;
}

/**
 * Worker entry: `startScheduleWorker(self, evaluator)` inside a Web Worker.
 * Commits are applied in order; a gap is the main thread's bug and is logged.
 */
export function startScheduleWorker(scope: WorkerScope, evaluator: ScheduleEvaluator): void {
  let runner: LocalScheduleRunner | null = null;
  let model: ModelState | null = null;
  const queued: ScheduleClientMessage[] = [];
  scope.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "load": {
        const parsed: ModelState = JSON.parse(msg.model);
        model = parsed;
        runner = new LocalScheduleRunner(evaluator, parsed, (out) => scope.postMessage(out));
        for (const q of queued.splice(0)) void runner.handle(q).catch((err) => console.error("[bim-sync] schedule worker request failed", err));
        return;
      }
      case "commit": {
        if (!runner || !model) return;
        try {
          model = applyChangeset(model, msg.changeset);
        } catch (err) {
          console.error("[bim-sync] schedule worker could not apply a commit; the main thread must send the model again", err);
          return;
        }
        runner.commit(msg.changeset, model);
        return;
      }
      case "schedule":
        if (!runner) {
          queued.push(msg.message);
          return;
        }
        void runner.handle(msg.message).catch((err) => console.error("[bim-sync] schedule worker request failed", err));
        return;
    }
  });
}

/**
 * Main-thread side of a local runner or worker, shaped like SyncClient's
 * schedule surface so `SyncScheduleConnection` works unchanged. Edits go
 * through `submit` (the standalone host's own command path).
 */
export class LocalScheduleClient implements ScheduleClientPort {
  private readonly channels = new Set<ScheduleChannel>();

  constructor(
    private readonly post: (msg: ScheduleClientMessage) => void,
    private readonly submitLocal: (command: Command) => { ok: true; request: CommandRequest; outcome: Promise<CommitOutcome> } | { ok: false; error: CommandError },
  ) {}

  attachSchedules(channel: ScheduleChannel): () => void {
    this.channels.add(channel);
    channel.welcomed();
    return () => this.channels.delete(channel);
  }

  scheduleReady(): boolean {
    return true;
  }

  sendSchedule(msg: ScheduleClientMessage): void {
    this.post(msg);
  }

  /** A message from the runner or worker. */
  receive(msg: ScheduleServerMessage): void {
    for (const channel of this.channels) channel.message(msg);
  }

  submit(command: Command): { ok: true; request: CommandRequest } | { ok: false; error: CommandError } {
    const sent = this.submitLocal(command);
    if (!sent.ok) return sent;
    void sent.outcome
      .then((outcome) => {
        for (const channel of this.channels) channel.outcome(sent.request, outcome);
      })
      .catch((err) => console.error("[bim-sync] local schedule edit failed to save", err));
    return { ok: true, request: sent.request };
  }
}
