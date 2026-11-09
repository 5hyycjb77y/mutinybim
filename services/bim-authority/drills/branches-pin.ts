/**
 * b8-fork-is-a-pin, against a THROWAWAY model-server Postgres (Testing only:
 * `db/local` then `db/migrations` applied, never a shared or real database).
 *
 * A 60k-element model (above CHECKPOINT_MAX_ELEMENTS) is branched at
 * revision 2: the fork writes one bim.models row and one pin, no element rows
 * and no checkpoint. Main then moves on to revision 10, a checkpoint at 8 is
 * recorded (as partitioned checkpoints will) and retention runs with no grace
 * window. The pin keeps every changeset after 2, so the branch still opens at
 * exactly revision 2's elements. Fails on round 8's code: no branch columns,
 * no pins, and retention would have purged revisions 3..8.
 *
 *   BIM_BRANCH_DRILL_DB_URL=postgresql://postgres:postgres@127.0.0.1:<throwaway>/postgres \
 *   node --import tsx services/bim-authority/drills/branches-pin.ts
 */
import { asRevision, type BimElement, type Changeset } from "@permitzip/bim-kernel";
import { connect, loadHeadTimed, toJson } from "../src/pg-store";
import { PgBranchRegistry, loadBranchHead, type BaseSource } from "../src/pg-branches";

const url = process.env.BIM_BRANCH_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_BRANCH_DRILL_DB_URL to a throwaway model-server database");
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("This drill writes; point it at a local throwaway database only");

const ELEMENTS = 60_000;
const MODEL = "site-9898";
const sql = connect(url, 2);

function element(n: number, version: number): BimElement {
  // A tag is the smallest record the loader reads; nothing here validates it.
  return { id: `el-${String(n).padStart(6, "0")}`, kind: "tag", version, authoredRev: {}, text: `v${version}`, hostId: null, position: { x: n, y: 0 }, offset: { x: 0, y: 0 } } as unknown as BimElement;
}

function changeset(revision: number, n: number): Changeset {
  return {
    revision: asRevision(revision),
    baseRevision: revision - 1,
    idempotencyKey: `drill-${revision}`,
    actor: { id: "drill", name: "Drill", kind: "human" },
    command: { type: "set_tag_text", tagId: `el-${n}`, text: `v${revision}` },
    elements: [element(n, revision + 1)],
    readSet: {},
    authored: [],
    intents: [],
    rebased: false,
    committedAt: new Date(0).toISOString(),
    before: { [element(n, 0).id]: element(n, revision) },
  };
}

async function commitMain(revision: number): Promise<void> {
  const n = revision % 5;
  const cs = changeset(revision, n);
  await sql`insert into bim.changesets (model_id, revision, idempotency_key, actor_id, actor_kind, body, committed_at)
            values (${MODEL}, ${revision}, ${cs.idempotencyKey}, 'drill', 'human', ${sql.json(toJson(cs))}, now() - interval '400 days')`;
  await sql`update bim.elements set body = ${sql.json(toJson(cs.elements[0]))}, version = ${revision + 1} where model_id = ${MODEL} and element_id = ${cs.elements[0]?.id ?? ""}`;
  await sql`update bim.models set revision = ${revision} where id = ${MODEL}`;
}

async function main(): Promise<void> {
  await sql`delete from bim.models where id = ${MODEL} or base_model_id = ${MODEL}`;
  const [project] = await sql<{ id: string }[]>`insert into public.projects (id, project_number, name) values (gen_random_uuid(), '9898', 'Branch drill') on conflict do nothing returning id`;
  const projectId = project?.id ?? (await sql<{ id: string }[]>`select id from public.projects where project_number = '9898'`)[0]?.id;
  await sql`insert into bim.models (id, project_id, revision, lease_generation, settings) values (${MODEL}, ${projectId ?? null}, 0, 0, '{}'::jsonb)`;
  await sql`insert into bim.elements (model_id, element_id, kind, version, body)
            select ${MODEL}, e->>'id', 'tag', 1, e from jsonb_array_elements(${sql.json(toJson(Array.from({ length: ELEMENTS }, (_, i) => element(i, 1))))}::jsonb) e`;
  for (let r = 1; r <= 2; r++) await commitMain(r);
  const atTwo = (await loadHeadTimed(sql, MODEL)).head.model;

  const registry = new PgBranchRegistry(sql);
  const t0 = performance.now();
  const branch = await registry.create({ baseModelId: MODEL, name: "Pin drill", baseRevision: 2, createdBy: "drill" });
  const forkMs = performance.now() - t0;
  const [counts] = await sql<{ elements: string; checkpoints: string; pins: string }[]>`
    select (select count(*) from bim.elements where model_id = ${branch.modelId})::text as elements,
           (select count(*) from bim.checkpoints where model_id = ${branch.modelId})::text as checkpoints,
           (select count(*) from bim.history_pins where model_id = ${MODEL})::text as pins`;
  if (counts?.elements !== "0" || counts.checkpoints !== "0" || counts.pins !== "1") throw new Error(`fork copied something: ${JSON.stringify(counts)}`);

  for (let r = 3; r <= 10; r++) await commitMain(r);
  await sql`insert into bim.checkpoints (model_id, revision, element_count, body) values (${MODEL}, 8, ${ELEMENTS}, '{}'::jsonb)`;
  const [purged] = await sql<{ deleted: string }[]>`select bim.purge_changesets(${MODEL}, 0, interval '0', 5000)::text as deleted`;
  const [kept] = await sql<{ min: string | null }[]>`select min(revision)::text as min from bim.changesets where model_id = ${MODEL}`;
  if (Number(kept?.min) !== 3) throw new Error(`retention removed pinned history: oldest kept ${kept?.min}`);

  const base: BaseSource = {
    head: async () => (await loadHeadTimed(sql, MODEL)).head.model,
    changesSince: async (rev) => (await sql<{ body: Changeset }[]>`select body from bim.changesets where model_id = ${MODEL} and revision > ${rev} order by revision`).map((r) => r.body),
  };
  const t1 = performance.now();
  const opened = await loadBranchHead(sql, branch.modelId, 2, base);
  const openMs = performance.now() - t1;
  for (let n = 0; n < 5; n++) {
    const id = element(n, 0).id;
    if (JSON.stringify(opened.model.elements[id]) !== JSON.stringify(atTwo.elements[id])) throw new Error(`branch element ${id} is not revision 2's`);
  }
  if (opened.model.revision !== 2) throw new Error(`branch opened at ${opened.model.revision}`);
  console.log(JSON.stringify({ drill: "b8-fork-is-a-pin", ok: true, elements: ELEMENTS, forkMs, openMs, purged: Number(purged?.deleted ?? 0), oldestKept: Number(kept?.min) }));
  await sql`delete from bim.models where id = ${branch.modelId} or id = ${MODEL}`;
  await sql.end();
}

main().catch(async (err: unknown) => {
  console.error("[drill b8-fork-is-a-pin] FAILED", err);
  await sql.end();
  process.exit(1);
});
