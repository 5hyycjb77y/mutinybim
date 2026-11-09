/**
 * Group commit against the real Postgres store: many edits decided in memory
 * and written in batches must land exactly as the serial path would, and an
 * owner that loses its lease with a batch still unwritten must write nothing.
 *
 * 1. Batching: 20 people x 10 edits submitted together through a group-commit
 *    sequencer. Fewer writes than commits; a second store loading the
 *    database holds exactly the model the first one decided.
 * 2. Kill mid-batch: an owner decides edits (shown to others) and, before its
 *    batch is written, its lease runs out and another process takes the
 *    model. The old owner's write is refused by the database fence, and the
 *    new owner's head equals the seed plus exactly the durable changesets.
 *
 * Runs only against a throwaway database on this machine (db/local,
 * db/disposable and db/migrations applied):
 *
 *   BIM_PARTS_DRILL_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
 *   node --import tsx services/bim-authority/drills/group-commit-store.ts
 */
import { randomUUID } from "node:crypto";
import { BUILTIN_PART_TYPES, applyChangeset, canonicalJson, type Changeset, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PipelineBrokenError, Sequencer, type CommitOutcome } from "@permitzip/bim-sync";
import { PostgresCommitStore, connect } from "../src/pg-store";

const url = process.env.BIM_PARTS_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_PARTS_DRILL_DB_URL to a throwaway database on this machine");
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("This drill writes; it refuses any database that is not on this machine");

const FT = 304.8;
const IN = 25.4;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}

type Sql = ReturnType<typeof connect>;

async function seed(sql: Sql, modelId: string, model: ModelState): Promise<void> {
  const project = randomUUID();
  await sql`insert into public.projects (id, project_number, name) values (${project}, ${modelId}, ${"Group commit drill"})`;
  await sql`insert into bim.models (id, project_id, revision, lease_generation, settings)
            values (${modelId}, ${project}, ${model.revision}, 0, ${sql.json(JSON.parse(JSON.stringify(model.settings)))})`;
  for (const el of Object.values(model.elements)) {
    await sql`insert into bim.elements (model_id, element_id, kind, version, body) values (${modelId}, ${el.id}, ${el.kind}, ${el.version}, ${sql.json(JSON.parse(JSON.stringify(el)))})`;
  }
  let ordinal = 0;
  for (const c of model.connections) {
    await sql`insert into bim.connections (model_id, connection_id, ordinal, a_element, a_end, b_element, b_end)
              values (${modelId}, ${c.id}, ${ordinal}, ${c.a.elementId}, ${c.a.end}, ${c.b.elementId}, ${c.b.end})`;
    ordinal += 1;
  }
}

const store = (sql: Sql, modelId: string, owner: string) => new PostgresCommitStore(sql, { modelId, owner, ownerMachine: null, leaseTtlMs: 10_000 });

const diffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
if (!diffuser) throw new Error("starter library has no air terminal");

function editsFor(person: number, count: number): Command[] {
  const partId = `gc-part-${person}`;
  const out: Command[] = [{ type: "place_part", partId, typeId: diffuser!.id, partType: diffuser!.definition, levelId: "gc-level", zone: `G${person}`, position: { x: person * 3 * FT, y: 0 }, offsetMm: 9 * FT }];
  for (let i = 1; i < count; i++) out.push({ type: "move_elements", ids: [partId], delta: { x: IN, y: 0 } });
  return out;
}

async function submitAll(seq: Sequencer, base: number, people: number, perPerson: number, tag: string): Promise<CommitOutcome[]> {
  // Each person sends in order (as one socket does); people in parallel.
  const runs = Array.from({ length: people }, async (_, p) => {
    const outcomes: CommitOutcome[] = [];
    for (const [i, command] of editsFor(p, perPerson).entries()) {
      outcomes.push(await seq.submit({ idempotencyKey: `${tag}-${p}-${i}-key`, baseRevision: base, actor: { id: `gc-${p}`, name: `GC ${p}`, kind: "human" }, clientSessionId: `gc-session-${p}`, command }));
    }
    return outcomes;
  });
  return (await Promise.all(runs)).flat();
}

async function main(): Promise<void> {
  const sql = connect(url ?? "", 8);
  try {
    // ---- 1. batching
    const modelA = `gc-drill-${Date.now().toString(36)}`;
    await seed(sql, modelA, createDemoModel());
    const a = store(sql, modelA, `drill-a/${randomUUID()}`);
    const seqA = await Sequencer.start(a, { maxBatch: 64 });
    const head0 = await a.head();
    const level = await seqA.submit({ idempotencyKey: `${modelA}-level`, baseRevision: head0.revision, actor: { id: "gc-setup", name: "Setup", kind: "human" }, command: { type: "create_level", levelId: "gc-level", name: "GC", elevationMm: 0 } });
    check("level created", level.status === "committed", JSON.stringify(level));
    const startRev = (await a.head()).revision;
    const t0 = performance.now();
    const outcomes = await submitAll(seqA, startRev, 20, 10, modelA);
    const ms = performance.now() - t0;
    const committed = outcomes.filter((o) => o.status === "committed").length;
    check("every edit committed", committed === 200, `${committed}/200, refusals: ${JSON.stringify(outcomes.find((o) => o.status === "rejected") ?? null)}`);
    const writes = (a.pathStats.group_write ?? 0) + (a.pathStats.fast_commit ?? 0);
    check("batched: fewer writes than commits", writes < committed, `${writes} writes for ${committed} commits in ${Math.round(ms)} ms; batch sizes ${JSON.stringify(seqA.groupStats.batchSizes.slice(0, 12))}`);
    const decided = canonicalJson(await a.head());
    await a.releaseLease();
    const reader = store(sql, modelA, `drill-reader/${randomUUID()}`);
    await reader.acquireLease();
    check("database holds exactly what was decided", canonicalJson(await reader.head()) === decided);
    await reader.releaseLease();

    // ---- 2. kill mid-batch
    const modelB = `gc-kill-${Date.now().toString(36)}`;
    const seedModel = createDemoModel();
    await seed(sql, modelB, seedModel);
    const old = store(sql, modelB, `drill-old/${randomUUID()}`);
    // A long window keeps decided edits unwritten while the lease runs out.
    const seqOld = await Sequencer.start(old, { maxBatch: 64, windowMs: 40 });
    const shown: Changeset[] = [];
    seqOld.onCommit((cs) => shown.push(cs));
    const base = (await old.head()).revision;
    const levelB = await seqOld.submit({ idempotencyKey: `${modelB}-level`, baseRevision: base, actor: { id: "gc-setup", name: "Setup", kind: "human" }, command: { type: "create_level", levelId: "gc-level", name: "GC", elevationMm: 0 } });
    check("kill drill: level durable before the kill", levelB.status === "committed");
    const pending = submitAll(seqOld, base + 1, 10, 3, modelB).then(
      () => "written" as const,
      (err: unknown) => (err instanceof PipelineBrokenError ? ("refused" as const) : Promise.reject(err)),
    );
    await new Promise((r) => setTimeout(r, 5));
    const shownBeforeKill = shown.length;
    // The old owner stops renewing (killed); its lease lapses; another process takes the model.
    await sql`update bim.models set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${modelB}`;
    const next = store(sql, modelB, `drill-next/${randomUUID()}`);
    await next.acquireLease();
    const verdict = await pending;
    check("old owner's batch refused by the fence", verdict === "refused", verdict);
    const [row] = await sql<{ revision: string }[]>`select revision from bim.models where id = ${modelB}`;
    const durable = Number(row?.revision ?? -1);
    check("edits were shown before the kill and never written", shownBeforeKill > 1 && durable < base + shownBeforeKill, `shown ${shownBeforeKill}, durable revision ${durable}, base ${base}`);
    let expected: ModelState = { ...seedModel, modelId: modelB };
    for (const cs of shown) if (cs.revision <= durable) expected = applyChangeset(expected, cs);
    const got = await next.head();
    const same = canonicalJson(got) === canonicalJson(expected);
    const differing = same ? [] : Object.keys({ ...got.elements, ...expected.elements }).filter((id) => canonicalJson(got.elements[id] ?? null) !== canonicalJson(expected.elements[id] ?? null));
    check(
      "new owner holds seed + exactly the durable changesets",
      same,
      same ? "" : `revision ${got.revision} vs ${expected.revision}; elements differing: ${differing.slice(0, 5).join(", ")}; connections ${got.connections.length} vs ${expected.connections.length}; settings same: ${canonicalJson(got.settings) === canonicalJson(expected.settings)}`,
    );
    await next.releaseLease();
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[group-commit-store drill] failed", err);
  process.exit(1);
});
