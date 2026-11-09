/**
 * Kill-mid-batch drill for group commit. Real SyncClient instances edit one
 * model through the real SyncHub + Sequencer + group-commit store; the
 * database is a DurableLog shared by every "process". The authority is
 * killed while decisions it has already shown to other people are still
 * waiting for (or in the middle of) their durable write: its connections go
 * dead, nothing it does afterwards reaches anyone, and its in-flight write is
 * fenced by the next owner's lease. A fresh authority loads the durable log,
 * every client reconnects, editing continues, and at the end:
 *
 * - every client's model equals the durable model (no divergence);
 * - every edit a client submitted was applied exactly once (each editor moves
 *   its own diffuser by +1 in per edit, so its final position counts them);
 * - no idempotency key appears twice in the durable log.
 *
 * Used by group-commit-kill.test.ts (small) and
 * scripts/perf/mutinybim/kill-drill.ts (25 and 50 editors).
 */
import { BUILTIN_PART_TYPES, canonicalJson, type Actor, type BimElement, type Command } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { DurableLog, GroupCommitMemoryStore, Sequencer, SyncClient, SyncHub, type HubConnection } from "../../src";

const FT = 304.8;
const IN = 25.4;

export interface KillDrillOptions {
  readonly editors: number;
  readonly kills: number;
  /** Edits per editor per second. */
  readonly rate: number;
  /** Editing time between kills, ms. */
  readonly phaseMs: number;
  /** The durable write's latency, ms. */
  readonly writeDelayMs: number;
  readonly maxBatch?: number;
  readonly seed?: number;
  /** Edits every editor piles up right before each kill (a backlog: unanswered edits stacked on the connection). */
  readonly backlog?: number;
  /** Called every 2 s while waiting for edits to settle (diagnosis). */
  readonly onProgress?: (state: Record<string, unknown>) => void;
  /** How long to wait for every edit to be answered at the end, ms. */
  readonly settleMs?: number;
}

export interface KillDrillReport {
  readonly editors: number;
  readonly kills: number;
  readonly submitted: number;
  readonly committed: number;
  readonly rejected: number;
  /** Kills that happened while decisions shown to others were not yet durable. */
  readonly killsWithUndurableShown: number;
  /** Most revisions any client had applied beyond the durable log at a kill (edits seen, then lost with the process). */
  readonly maxShownButLost: number;
  /** Clients whose final model differs from the durable model. */
  readonly divergentClients: number;
  /** Editors whose diffuser moved a different number of times than they submitted moves. */
  readonly exactlyOnceViolations: number;
  readonly duplicateKeysInLog: number;
  readonly durableWrites: number;
  readonly finalRevision: number;
  readonly unsettledClients: number;
  /** Time from the end of editing until every edit was answered, ms (null when it never settled). */
  readonly settleMs: number | null;
  /** Commands the last authority could not decide in memory (serial path). */
  readonly fallbacks: number;
  /** Per unsettled editor: what it still waits on (diagnosis). */
  readonly stuck: readonly string[];
  /** Refusals by error code, with one message each. */
  readonly refusals: Readonly<Record<string, { readonly count: number; readonly message: string }>>;
}

interface Authority {
  readonly store: GroupCommitMemoryStore;
  readonly sequencer: Sequencer;
  readonly hub: SyncHub;
}

interface Editor {
  readonly index: number;
  readonly actor: Actor;
  readonly partId: string;
  readonly client: SyncClient;
  link: { alive: boolean; conn: HubConnection; queue: Promise<void>; hub: SyncHub; outstanding: number } | null;
  moves: number;
  placed: boolean;
  committed: number;
  rejected: number;
}

/** Deterministic random numbers, so a failing run can be repeated. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runKillDrill(opts: KillDrillOptions): Promise<KillDrillReport> {
  const random = rng(opts.seed ?? 42);
  const foundDiffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
  if (!foundDiffuser) throw new Error("starter library has no air terminal");
  const diffuser = foundDiffuser;
  const log = new DurableLog(createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "kill-drill" }), opts.writeDelayMs);

  let connSeq = 0;
  const start = async (): Promise<Authority> => {
    const store = new GroupCommitMemoryStore(log);
    const sequencer = await Sequencer.start(store, { maxBatch: opts.maxBatch ?? 64 });
    return { store, sequencer, hub: new SyncHub(sequencer) };
  };

  const editors: Editor[] = [];
  const refusals = new Map<string, number>();
  const refusalSample = new Map<string, string>();
  const attach = (editor: Editor, authority: Authority) => {
    connSeq += 1;
    const link: NonNullable<Editor["link"]> = {
      alive: true,
      outstanding: 0,
      hub: authority.hub,
      queue: Promise.resolve(),
      conn: {
        id: `drill-conn-${connSeq}`,
        send: (data: string) => {
          // Delivered after the current turn, as a socket would; a dead link delivers nothing.
          setImmediate(() => {
            if (link.alive) editor.client.receive(data);
          });
        },
      },
    };
    editor.link = link;
    authority.hub.join(link.conn);
    editor.client.opened();
  };

  for (let i = 0; i < opts.editors; i++) {
    const actor: Actor = { id: `drill-${i}`, name: `Drill ${i}`, kind: "human" };
    const editor: Editor = {
      index: i,
      actor,
      partId: `drill-part-${i}`,
      moves: 0,
      placed: false,
      committed: 0,
      rejected: 0,
      link: null,
      client: new SyncClient(
        {
          send: (data) => {
            const link = editor.link;
            if (!link || !link.alive) return;
            // One message at a time per connection, as services/bim-authority/src/server.ts does.
            link.outstanding += 1;
            link.queue = link.queue
              .then(() => (link.alive ? link.hub.handle(link.conn, data) : undefined))
              .catch((err) => console.error("[kill-drill] hub.handle failed", err))
              .finally(() => {
                link.outstanding -= 1;
              });
          },
          close: () => undefined,
        },
        actor,
        {
          onOutcome: (_request, outcome) => {
            if (outcome.status === "committed") editor.committed += 1;
            else {
              editor.rejected += 1;
              refusals.set(outcome.error.code, (refusals.get(outcome.error.code) ?? 0) + 1);
              if (!refusalSample.has(outcome.error.code)) refusalSample.set(outcome.error.code, outcome.error.message);
            }
          },
        },
        60_000,
        { clientSessionId: `drill-session-${i}` },
      ),
    };
    editors.push(editor);
  }

  let authority = await start();
  const seeded = await authority.sequencer.submit({
    idempotencyKey: "kill-drill-level",
    baseRevision: log.model.revision,
    actor: { id: "drill-setup", name: "Setup", kind: "human" },
    clientSessionId: "drill-setup",
    command: { type: "create_level", levelId: "drill-level", name: "Drill level", elevationMm: 0 },
  });
  if (seeded.status !== "committed") throw new Error(`kill drill could not create its level: ${JSON.stringify(seeded)}`);
  for (const editor of editors) attach(editor, authority);
  await sleep(20);

  const edit = (editor: Editor): void => {
    if (!editor.link?.alive) return;
    const command: Command = editor.placed
      ? { type: "move_elements", ids: [editor.partId], delta: { x: IN, y: 0 } }
      : {
          type: "place_part",
          partId: editor.partId,
          typeId: diffuser.id,
          partType: diffuser.definition,
          levelId: "drill-level",
          zone: `D${editor.index}`,
          position: { x: editor.index * 3 * FT, y: 0 },
          offsetMm: 9 * FT,
        };
    const sent = editor.client.submit(command);
    if (!sent.ok) return;
    if (editor.placed) editor.moves += 1;
    editor.placed = true;
  };

  const editFor = async (ms: number): Promise<void> => {
    const interval = 1000 / opts.rate;
    const timers = editors.map((editor) => {
      let every: ReturnType<typeof setInterval> | null = null;
      const first = setTimeout(() => {
        edit(editor);
        every = setInterval(() => edit(editor), interval);
      }, random() * interval);
      return () => {
        clearTimeout(first);
        if (every) clearInterval(every);
      };
    });
    await sleep(ms);
    for (const stop of timers) stop();
  };

  let killsWithUndurableShown = 0;
  let maxShownButLost = 0;
  for (let k = 0; k <= opts.kills; k++) {
    await editFor(opts.phaseMs);
    if (k === opts.kills) break;
    // Kill while a batch is waiting or being written and others have been shown it.
    for (let tries = 0; tries < 400; tries++) {
      const shown = Math.max(...editors.map((e) => e.client.confirmedRevision()));
      if (shown > log.model.revision) break;
      // A few extra edits from people with nothing waiting, so a batch is in flight; never a pile-up.
      const idle = editors.filter((e) => e.client.pendingCount() === 0);
      const pick = idle[Math.floor(random() * idle.length)];
      if (pick) edit(pick);
      await sleep(1);
    }
    for (let b = 0; b < (opts.backlog ?? 0); b++) for (const editor of editors) edit(editor);
    const shown = Math.max(...editors.map((e) => e.client.confirmedRevision()));
    const lost = shown - log.model.revision;
    if (lost > 0) killsWithUndurableShown += 1;
    maxShownButLost = Math.max(maxShownButLost, lost);
    for (const editor of editors) {
      if (editor.link) editor.link.alive = false;
      editor.client.closed();
    }
    // The next owner takes the lease at once; the dead process's write in flight is fenced by it.
    authority = await start();
    await sleep(random() * 3 * opts.writeDelayMs);
    for (const editor of editors) attach(editor, authority);
  }

  // Quiesce: every edit answered, then everyone checks the head and catches up.
  let unsettled = editors.length;
  const settleStarted = performance.now();
  const settleBudget = opts.settleMs ?? 20_000;
  let lastProgress = settleStarted;
  while (unsettled > 0 && performance.now() - settleStarted < settleBudget) {
    await sleep(10);
    if (opts.onProgress && performance.now() - lastProgress > 2000) {
      lastProgress = performance.now();
      opts.onProgress({ committed: editors.reduce((n, e) => n + e.committed, 0), durable: log.model.revision, writes: log.writes, pipeline: authority.sequencer.pipelineState() });
    }
    unsettled = editors.filter((e) => e.client.pendingCount() > 0 || e.client.saveState().retrying > 0).length;
  }
  const settleMs = unsettled === 0 ? Math.round(performance.now() - settleStarted) : null;
  const stuck = editors
    .filter((e) => e.client.pendingCount() > 0 || e.client.saveState().retrying > 0)
    .slice(0, 5)
    .map((e) => `${e.actor.id}: pending ${e.client.pendingCount()}, retrying ${e.client.saveState().retrying}, confirmed r${e.client.confirmedRevision()} (durable r${log.model.revision}), link ${e.link?.alive ? "up" : "down"}, messages queued at the server ${e.link?.outstanding ?? 0}; pipeline ${JSON.stringify(authority.sequencer.pipelineState())}`);
  await authority.sequencer.drain();
  for (const editor of editors) editor.client.checkHead();
  await sleep(50 + 4 * opts.writeDelayMs);

  const durable = canonicalJson(log.model);
  const divergentClients = editors.filter((e) => {
    const model = e.client.confirmedModel();
    return !model || canonicalJson(model) !== durable;
  }).length;
  const exactlyOnceViolations = editors.filter((e) => {
    if (!e.placed) return false;
    const part: BimElement | undefined = log.model.elements[e.partId];
    if (part?.kind !== "part") return true;
    const moved = Math.round((part.position.x - e.index * 3 * FT) / IN);
    return moved !== e.moves;
  }).length;
  const keys = log.changesets.map((cs) => cs.idempotencyKey);

  for (const editor of editors) {
    if (editor.link) editor.link.alive = false;
    editor.client.dispose();
  }

  return {
    editors: opts.editors,
    kills: opts.kills,
    submitted: editors.reduce((n, e) => n + e.moves + (e.placed ? 1 : 0), 0),
    committed: editors.reduce((n, e) => n + e.committed, 0),
    rejected: editors.reduce((n, e) => n + e.rejected, 0),
    killsWithUndurableShown,
    maxShownButLost,
    divergentClients,
    exactlyOnceViolations,
    duplicateKeysInLog: keys.length - new Set(keys).size,
    durableWrites: log.writes,
    finalRevision: log.model.revision,
    unsettledClients: unsettled,
    settleMs,
    stuck,
    fallbacks: authority.sequencer.groupStats.fallbacks,
    refusals: Object.fromEntries([...refusals].map(([code, count]) => [code, { count, message: refusalSample.get(code) ?? "" }])),
  };
}
