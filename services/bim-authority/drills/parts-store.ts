/**
 * Parts against the real Postgres store (CP3): every command that adds,
 * removes or reconnects elements is committed through PostgresCommitStore,
 * then a second store loads the head from the database and must hold exactly
 * the same model. Covers removals (delete with cascade and disconnect),
 * connections cut and put back (undo of a disconnecting delete, with the
 * history the sequencer reads from the database), and a command planned on
 * an old base.
 *
 * Runs only against a database on this machine (a throwaway container with
 * db/local, db/disposable and db/migrations applied):
 *
 *   BIM_PARTS_DRILL_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
 *   node --import tsx services/bim-authority/drills/parts-store.ts
 */
import { randomUUID } from "node:crypto";
import { BUILTIN_PART_TYPES, canonicalJson, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { Sequencer, type CommitOutcome } from "@permitzip/bim-sync";
import { PostgresCommitStore, connect } from "../src/pg-store";

const url = process.env.BIM_PARTS_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_PARTS_DRILL_DB_URL to a throwaway database on this machine");
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("This drill writes; it refuses any database that is not on this machine");

const MODEL = `parts-drill-${Date.now().toString(36)}`;
const PROJECT = randomUUID();
const actor = { id: "drill-person", name: "Drill", kind: "human" as const };

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function seed(sql: ReturnType<typeof connect>, model: ModelState): Promise<void> {
  await sql`insert into public.projects (id, project_number, name) values (${PROJECT}, ${MODEL}, ${"Parts drill"})`;
  await sql`insert into bim.models (id, project_id, revision, lease_generation, settings)
            values (${MODEL}, ${PROJECT}, 0, 0, ${sql.json(JSON.parse(JSON.stringify(model.settings)))})`;
  for (const el of Object.values(model.elements)) {
    await sql`insert into bim.elements (model_id, element_id, kind, version, body) values (${MODEL}, ${el.id}, ${el.kind}, ${el.version}, ${sql.json(JSON.parse(JSON.stringify(el)))})`;
  }
  let ordinal = 0;
  for (const c of model.connections) {
    await sql`insert into bim.connections (model_id, connection_id, ordinal, a_element, a_end, b_element, b_end)
              values (${MODEL}, ${c.id}, ${ordinal}, ${c.a.elementId}, ${c.a.end}, ${c.b.elementId}, ${c.b.end})`;
    ordinal += 1;
  }
}

async function main(): Promise<void> {
  const sql = connect(url ?? "", 4);
  try {
    await seed(sql, createDemoModel(MODEL));
    const store = new PostgresCommitStore(sql, { modelId: MODEL, owner: `drill/${randomUUID()}`, ownerMachine: null, leaseTtlMs: 10_000 });
    const sequencer = await Sequencer.start(store);
    await store.head();
    let n = 0;
    const send = async (command: Command, base?: number): Promise<CommitOutcome> => {
      n += 1;
      const head = await store.head();
      return sequencer.submit({ idempotencyKey: `${MODEL}-step-${n}`, baseRevision: base ?? head.revision, actor, command, clientSessionId: "drill" });
    };
    const diffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
    if (!diffuser) throw new Error("no air terminal in the starter library");

    const level = await send({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    check("create_level commits", level.status === "committed");
    const placed = await send({ type: "place_part", partId: "p-1", typeId: diffuser.id, partType: diffuser.definition, levelId: "lvl-1", position: { x: 1000, y: 1000 }, offsetMm: 2743 });
    check("place_part commits (part + pinned type)", placed.status === "committed");
    const cut = await send({ type: "delete_elements", ids: ["sd-1"], policy: "disconnect" });
    check("delete with disconnect commits", cut.status === "committed");
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from bim.connections where model_id = ${MODEL} and connection_id = 'c-run-1-sd'`;
    check("the cut connection row is gone", rows[0]?.n === "0");
    if (cut.status !== "committed") throw new Error("cannot continue");
    const undone = await send({ type: "undo", revision: cut.revision });
    check("undo of the delete commits", undone.status === "committed", undone.status === "rejected" ? undone.error.message : "");
    const back = await sql<{ n: string }[]>`select count(*)::text as n from bim.connections where model_id = ${MODEL} and connection_id = 'c-run-1-sd'`;
    check("the connection row is back", back[0]?.n === "1");
    const cascade = await send({ type: "delete_elements", ids: ["lvl-1"], policy: "cascade" });
    check("delete a level with cascade commits", cascade.status === "committed");
    // Planned five revisions ago; nothing it touches changed since, so it still commits.
    const stale = await send({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 4200 }, 1);
    check("a command planned on an old base commits", stale.status === "committed");

    const inMemory = await store.head();
    const fresh = new PostgresCommitStore(sql, { modelId: MODEL, owner: `drill-reader/${randomUUID()}`, ownerMachine: null, leaseTtlMs: 10_000 });
    const loaded = await fresh.head();
    const sorted = (m: ModelState) => canonicalJson({ ...m, elements: Object.fromEntries(Object.entries(m.elements).sort(([a], [b]) => a.localeCompare(b))) });
    check("a fresh load from Postgres equals the committed head", sorted(loaded) === sorted(inMemory), `revision ${loaded.revision}, ${Object.keys(loaded.elements).length} elements, ${loaded.connections.length} connections`);
    check("the deleted level and its part are gone from the database", !loaded.elements["lvl-1"] && !loaded.elements["p-1"]);
    console.log(`paths: ${JSON.stringify(store.pathStats)}`);
  } finally {
    await sql`delete from bim.models where id = ${MODEL}`;
    await sql`delete from public.projects where id = ${PROJECT}`;
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[parts-store drill] failed", err);
  process.exit(1);
});
