/**
 * Model server restart drill (`authority.restart.resume`, round 12 owed,
 * round 14 Q14). Editors are mid-edit on one model when the model server
 * process dies: its connections go dead and an edit it already showed to
 * others may not be durable yet. A fresh process loads the durable log,
 * every editor reconnects on its own, and the drill checks:
 *
 * - every edit an editor sent was applied exactly once (each editor moves its
 *   own part by +1 in per edit, so the stored position counts them);
 * - no revision a client was told is saved is missing from the durable log
 *   (no lost revision) and no idempotency key is stored twice;
 * - every editor's edits are answered after the restart (resumed);
 * - the validation state kept before the restart is adopted when the head is
 *   reopened from its rows, and the first edit after it runs no whole-model
 *   check (as the Postgres store offers it on boot, pg-store.ts).
 *
 * It times the restart: new process start → every editor answered
 * (`authority.restart.resume`, measured first, no budget yet).
 *
 * In process: the real SyncClient / SyncHub / Sequencer / group-commit store
 * with a DurableLog standing in for the database (the Postgres store's own
 * drill is group-commit-store.ts). Writes nothing outside --out.
 *
 *   node --max-old-space-size=12288 --import tsx services/bim-authority/drills/restart-resume.ts [--tier=XS|250k|1M] [--editors=5] [--moves=6] [--out=dir]
 *
 * Exits 1 on any failed check. 250k and 1M only through the shared stack's
 * heavy lock or the dispatch-only bim-perf-1m CI job.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_PART_TYPES,
  elementsFromRows,
  incrementalValidationStats,
  issuesOf,
  offerValidationState,
  planCommit,
  validationStateOf,
  validationStateStats,
  withUpgradePolicy,
  type Actor,
  type BimElement,
  type Command,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { DurableLog, GroupCommitMemoryStore, Sequencer, SyncClient, SyncHub, type HubConnection } from "@permitzip/bim-sync";
import { bindServedModelState } from "../src/packs";

const FT = 304.8;
const IN = 25.4;
const LEVEL = "restart-drill-level";
/** A part's area is named by its level's name, so the editors' interest uses it. */
const LEVEL_NAME = "Restart drill level";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const tierArg = arg("tier", "XS");
const editorsN = Number(arg("editors", "5"));
const moves = Number(arg("moves", "6"));
const writeDelayMs = Number(arg("write-delay-ms", "20"));
const settleBudgetMs = Number(arg("settle-ms", "120000"));
const outDir = arg("out", path.resolve(process.cwd(), ".perf-results/mutinybim", `restart-resume-${tierArg}-${new Date().toISOString().replace(/[:.]/g, "-")}`));

type Tier = keyof typeof FULL_BIM_TIERS;
function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

interface Authority {
  readonly sequencer: Sequencer;
  readonly hub: SyncHub;
}

interface Editor {
  readonly index: number;
  readonly actor: Actor;
  readonly partId: string;
  readonly client: SyncClient;
  link: { alive: boolean; conn: HubConnection; queue: Promise<void>; hub: SyncHub } | null;
  sentMoves: number;
  committedRevisions: number[];
  rejected: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settled = (e: Editor) => e.client.pendingCount() === 0 && e.client.saveState().retrying === 0;

async function waitUntil(done: () => boolean, budgetMs: number): Promise<number | null> {
  const t0 = performance.now();
  while (!done()) {
    if (performance.now() - t0 > budgetMs) return null;
    await sleep(5);
  }
  return Math.round(performance.now() - t0);
}

function reopenFromRows(head: ModelState): ModelState {
  return {
    ...head,
    elements: elementsFromRows(JSON.parse(JSON.stringify(Object.values(head.elements))) as BimElement[]),
    connections: JSON.parse(JSON.stringify(head.connections)) as ModelState["connections"],
  };
}

async function main(): Promise<void> {
  if (!isTier(tierArg)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}; got ${tierArg}`);
  if (!Number.isInteger(editorsN) || editorsN < 1 || !Number.isInteger(moves) || moves < 1) throw new Error("--editors and --moves must be whole numbers of at least 1");
  const diffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
  if (!diffuser) throw new Error("the starter library has no air terminal to place");

  const log = new DurableLog(createFullBimModel({ ...FULL_BIM_TIERS[tierArg], modelId: `restart-drill-${tierArg}` }), writeDelayMs);
  const elements = Object.keys(log.model.elements).length;
  // As the model server does on boot: the first-party add-ons bound to the model it serves.
  bindServedModelState(log.model);
  const start = async (): Promise<Authority> => {
    const sequencer = await Sequencer.start(new GroupCommitMemoryStore(log), { maxBatch: 64 });
    return { sequencer, hub: new SyncHub(sequencer) };
  };

  let connSeq = 0;
  const attach = (editor: Editor, authority: Authority) => {
    connSeq += 1;
    const link: NonNullable<Editor["link"]> = {
      alive: true,
      hub: authority.hub,
      queue: Promise.resolve(),
      conn: {
        id: `restart-conn-${connSeq}`,
        send: (data: string) => {
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

  let authority = await start();
  const level = await authority.sequencer.submit({
    idempotencyKey: "restart-drill-level",
    baseRevision: log.model.revision,
    actor: { id: "restart-setup", name: "Setup", kind: "human" },
    clientSessionId: "restart-setup",
    command: { type: "create_level", levelId: LEVEL, name: LEVEL_NAME, elevationMm: 0 },
  });
  if (level.status !== "committed") throw new Error(`the drill could not create its level: ${JSON.stringify(level)}`);

  const editors: Editor[] = [];
  for (let i = 0; i < editorsN; i++) {
    const actor: Actor = { id: `restart-${i}`, name: `Restart ${i}`, kind: "human" };
    const editor: Editor = {
      index: i,
      actor,
      partId: `restart-part-${i}`,
      sentMoves: 0,
      committedRevisions: [],
      rejected: [],
      link: null,
      client: new SyncClient(
        {
          send: (data) => {
            const link = editor.link;
            if (!link || !link.alive) return;
            link.queue = link.queue.then(() => (link.alive ? link.hub.handle(link.conn, data) : undefined)).catch((err) => console.error("[restart-resume] hub.handle failed", err));
          },
          close: () => undefined,
        },
        actor,
        {
          onOutcome: (_request, outcome) => {
            if (outcome.status === "committed") editor.committedRevisions.push(Number(outcome.revision));
            else editor.rejected.push(`${outcome.error.code}: ${outcome.error.message}`);
          },
        },
        60_000,
        { clientSessionId: `restart-session-${i}`, interest: { areas: [{ level: LEVEL_NAME }] } },
      ),
    };
    editors.push(editor);
    attach(editor, authority);
  }
  await sleep(20);

  const place: (e: Editor) => Command = (e) => ({ type: "place_part", partId: e.partId, typeId: diffuser.id, partType: diffuser.definition, levelId: LEVEL, zone: `R${e.index}`, position: { x: e.index * 3 * FT, y: 0 }, offsetMm: 9 * FT });
  for (const e of editors) {
    const sent = e.client.submit(place(e));
    if (!sent.ok) throw new Error(`${e.actor.id} could not place its part: ${sent.error.message}`);
  }
  const placed = () => editors.every((e) => settled(e) && e.committedRevisions.length > 0 && e.client.confirmedModel()?.elements[e.partId] !== undefined);
  if ((await waitUntil(placed, settleBudgetMs)) === null) throw new Error(`the parts were never placed (durable r${log.model.revision}; ${editors.map((e) => `${e.actor.id} confirmed r${e.client.confirmedRevision()}, pending ${e.client.pendingCount()}`).join(", ")})`);
  const refusedPlace = editors.filter((e) => e.rejected.length > 0);
  if (refusedPlace.length > 0) throw new Error(`placing the drill parts was refused: ${refusedPlace.map((e) => `${e.actor.id} ${e.rejected.join(" | ")}`).join("; ")}`);

  // Mid-edit: every editor sends its moves at once; the process dies while some are shown but not durable.
  for (let m = 0; m < moves; m++) {
    for (const e of editors) {
      const sent = e.client.submit({ type: "move_elements", ids: [e.partId], delta: { x: IN, y: 0 } });
      if (!sent.ok) throw new Error(`${e.actor.id} could not send move ${m + 1}: ${sent.error.message}`);
      e.sentMoves += 1;
    }
  }
  // Kill as soon as a decision is shown beyond the durable log, or while the moves are still in flight.
  for (let tries = 0; tries < writeDelayMs; tries++) {
    if (Math.max(...editors.map((e) => e.client.confirmedRevision())) > log.model.revision) break;
    if (log.writes > 0 && editors.some((e) => e.client.pendingCount() > 0) && tries > 1) break;
    await sleep(1);
  }
  const shownBeyondDurable = Math.max(...editors.map((e) => e.client.confirmedRevision())) - log.model.revision;
  const pendingAtKill = editors.reduce((n, e) => n + e.client.pendingCount(), 0);

  // The validation state the store keeps beside the durable head, written before the process died.
  const durableAtKill = log.model;
  issuesOf(durableAtKill);
  const kept = validationStateOf(durableAtKill, "restart-drill");

  for (const e of editors) {
    if (e.link) e.link.alive = false;
    e.client.closed();
  }
  const restartedAt = performance.now();
  authority = await start();
  for (const e of editors) attach(e, authority);
  const resumed = await waitUntil(() => editors.every(settled), settleBudgetMs);
  const resumeMs = resumed === null ? null : Math.round(performance.now() - restartedAt);
  await authority.sequencer.drain();
  await sleep(50 + 4 * writeDelayMs);

  const durable = log.model;
  const exactlyOnceViolations = editors.filter((e) => {
    const part = durable.elements[e.partId];
    if (part?.kind !== "part") return true;
    return Math.round((part.position.x - e.index * 3 * FT) / IN) !== e.sentMoves;
  });
  const keys = log.changesets.map((cs) => cs.idempotencyKey);
  const durableRevisions = new Set(log.changesets.map((cs) => Number(cs.revision)));
  const lostRevisions = editors.flatMap((e) => e.committedRevisions.filter((r) => !durableRevisions.has(r)).map((r) => `${e.actor.id} r${r}`));

  let keptReuse: { adopted: number; declined: number; lastDeclined: string | null; wholeModelChecks: number; firstEditMs: number } | null = null;
  if (kept) {
    // What the new process boots from: the durable head at the kill, read back from its rows, offered the kept state.
    const fresh = reopenFromRows(durableAtKill);
    offerValidationState(fresh, JSON.parse(JSON.stringify(kept)), "restart-drill");
    const before = { ...incrementalValidationStats(), ...validationStateStats() };
    const t0 = performance.now();
    const decided = withUpgradePolicy(
      () => true,
      () => planCommit(fresh, [], { idempotencyKey: "restart-drill-after", baseRevision: fresh.revision, actor: editors[0]?.actor ?? { id: "restart", name: "Restart", kind: "human" }, command: { type: "move_elements", ids: [editors[0]?.partId ?? ""], delta: { x: IN, y: 0 } } }, () => new Date(0).toISOString()),
    );
    const firstEditMs = Math.round((performance.now() - t0) * 100) / 100;
    if (!decided.ok) throw new Error(`the first edit after the restart was refused: ${decided.error.message}`);
    const after = { ...incrementalValidationStats(), ...validationStateStats() };
    keptReuse = {
      adopted: after.adopted - before.adopted,
      declined: after.declined - before.declined,
      lastDeclined: after.declined > before.declined ? after.lastDeclined : null,
      wholeModelChecks: after.fullPasses + after.coldPasses - (before.fullPasses + before.coldPasses),
      firstEditMs,
    };
  }

  const problems: string[] = [];
  if (pendingAtKill === 0 && shownBeyondDurable <= 0) problems.push("the process died after every edit was already durable, so the drill proved nothing; lower --moves or raise --write-delay-ms");
  if (resumeMs === null) problems.push(`not every editor was answered within ${settleBudgetMs} ms of the restart: ${editors.filter((e) => !settled(e)).map((e) => `${e.actor.id} pending ${e.client.pendingCount()}`).join(", ")}`);
  if (exactlyOnceViolations.length > 0) problems.push(`edits not applied exactly once for ${exactlyOnceViolations.map((e) => e.actor.id).join(", ")}`);
  if (lostRevisions.length > 0) problems.push(`revisions clients were told are saved are missing from the durable log: ${lostRevisions.slice(0, 10).join(", ")}`);
  if (keys.length !== new Set(keys).size) problems.push(`${keys.length - new Set(keys).size} idempotency keys are stored twice`);
  if (!kept) problems.push("no validation state was kept beside the durable head before the restart");
  else if (!keptReuse || keptReuse.adopted === 0) problems.push(`the kept validation state was not adopted after the restart${keptReuse?.lastDeclined ? ` (declined: ${keptReuse.lastDeclined})` : ""}`);
  else if (keptReuse.wholeModelChecks > 0) problems.push(`the first edit after the restart re-checked the whole model ${keptReuse.wholeModelChecks} time(s)`);

  const report = {
    recordedAt: new Date().toISOString(),
    tier: tierArg,
    elements,
    editors: editorsN,
    movesPerEditor: moves,
    shownBeyondDurableAtKill: shownBeyondDurable,
    pendingAtKill,
    metric: "authority.restart.resume",
    resumeMs,
    finalRevision: Number(durable.revision),
    rejected: editors.flatMap((e) => e.rejected).slice(0, 10),
    keptReuse,
    problems,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  for (const e of editors) {
    if (e.link) e.link.alive = false;
    e.client.dispose();
  }
  console.log(`[restart-resume] ${tierArg} (${elements} elements), ${editorsN} editors x ${moves} moves: resumed in ${resumeMs ?? "never"} ms; ${shownBeyondDurable} revision(s) shown beyond durable and ${pendingAtKill} edit(s) pending at the kill; kept state ${keptReuse ? `adopted ${keptReuse.adopted}, whole checks ${keptReuse.wholeModelChecks}, first edit ${keptReuse.firstEditMs} ms` : "none"}`);
  if (problems.length > 0) {
    console.error(`[restart-resume] FAIL: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else console.log(`[restart-resume] PASS; results: ${path.join(outDir, "results.json")}`);
  process.exit();
}

main().catch((err) => {
  console.error("[restart-resume] failed", err);
  process.exit(1);
});
