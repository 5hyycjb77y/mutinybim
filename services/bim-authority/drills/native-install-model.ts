/** Child process of native-install.py. The parent compares both model heads across a PostgreSQL restart. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "@permitzip/bim-kernel";
import { Sequencer } from "@permitzip/bim-sync";
import { PgBranchRegistry } from "../src/pg-branches";
import { connect, PostgresCommitStore } from "../src/pg-store";

const mode = process.argv[2];
const url = process.env.MUTINYBIM_NATIVE_DRILL_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || (mode !== "write" && mode !== "reopen")) {
  throw new Error("Run the disposable database drill with native-install.py");
}
const sql = connect(url);
const modelId = process.argv[3] ?? "native-check";
const person = process.argv[4] ?? "00000000-0000-4000-a000-000000000036";
const options = { owner: `native-drill-${process.pid}`, ownerMachine: null, leaseTtlMs: 10000 };
const root = new PostgresCommitStore(sql, { ...options, modelId });
const copies = new PgBranchRegistry(sql);

async function addLevel(store: PostgresCommitStore, levelId: string, elevationMm: number) {
  const sequencer = await Sequencer.start(store);
  try {
    const { revision } = await sequencer.head();
    const result = await sequencer.submit({ baseRevision: revision, idempotencyKey: levelId,
      actor: { id: person, name: "Drill owner", kind: "human" },
      command: { type: "create_level", levelId, name: levelId, elevationMm } });
    assert.equal(result.status, "committed");
  } finally {
    await store.releaseLease();
  }
}

try {
  if (mode === "write") {
    await addLevel(root, "ground-floor", 0);
    await copies.create({ baseModelId: modelId, name: "Mezzanine option", createdBy: person, baseRevision: 1 });
  }
  const branches = await copies.list(modelId);
  assert.equal(branches.length, 1);
  const branch = branches[0];
  assert.ok(branch);
  assert.equal(branch.name, "Mezzanine option");
  const copy = new PostgresCommitStore(sql, { ...options, modelId: branch.modelId,
    branch: { baseRevision: branch.baseRevision, base: root } });
  if (mode === "write") await addLevel(copy, "mezzanine", 3200);
  const baseHead = await root.head();
  const copyHead = await copy.head();
  assert.equal(baseHead.revision, 1);
  assert.equal(copyHead.revision, 2);
  assert.ok(baseHead.elements["ground-floor"] && copyHead.elements["ground-floor"]);
  assert.ok(!baseHead.elements.mezzanine && copyHead.elements.mezzanine);
  const owners = await sql`select a.owner_person_id, m.role from bim.model_authority a join bim.model_members m
    on m.model_id = a.model_id and m.person_id = a.owner_person_id where a.model_id = ${modelId}`;
  assert.equal(owners.length, 1);
  assert.equal(owners[0]?.owner_person_id, person);
  assert.equal(owners[0]?.role, "manager");
  const digest = (head: typeof baseHead) => createHash("sha256").update(canonicalJson(head)).digest("hex");
  console.log(JSON.stringify({ model: [baseHead.modelId, baseHead.revision, digest(baseHead)],
    copy: [copyHead.modelId, copyHead.revision, digest(copyHead)], owner: person }));
} finally {
  await sql.end();
}
