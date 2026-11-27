/** Exercise the native member store and the sync hub on the installer's disposable East plant model. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Actor, Command } from "@permitzip/bim-kernel";
import { NativeModelAuthorizer, Sequencer, SyncHub, authorizeConnection, commandDigest, type ClientMessage, type NativeModelRole, type ServerMessage } from "@permitzip/bim-sync";
import { readNativeSaveReceipt } from "../src/auth/native-socket";
import { connectionLineageFor } from "../src/lineages/admission";
import { PgLineageMemberStore } from "../src/lineages/members";
import { PgLineageStore } from "../src/lineages/store";
import { PgNativeModelMembers } from "../src/native-model-members";
import { PgNativeSessionStore } from "../src/native-session-store";
import { PgBranchRegistry } from "../src/pg-branches";
import { connect, PostgresCommitStore } from "../src/pg-store";

const [phase, requestedModel, sessionFile] = process.argv.slice(2);
const modelId = "east-plant";
const url = process.env.MUTINYBIM_NATIVE_DRILL_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/native_drill" ||
    requestedModel !== modelId || !sessionFile || (phase !== "grant" && phase !== "reopen")) {
  throw new Error("Run the disposable database drill with native-install.py");
}
const sql = connect(url);
const sessions = new PgNativeSessionStore(sql);
const members = new PgNativeModelMembers(sql);
const branches = new PgBranchRegistry(sql);
const lineages = new PgLineageStore(sql, branches);
const authorizer = new NativeModelAuthorizer(members, new PgLineageMemberStore(sql));
const saved: { active: string; coworker: string; revoked: string } = JSON.parse(readFileSync(sessionFile, "utf8"));

function change(token: string, target: string, expectedRole: NativeModelRole | null, role: NativeModelRole | null) {
  return members.changeRole(modelId, token, { personId: target, expectedRole, role });
}

async function revision(): Promise<number> {
  const [model] = await sql`select authorization_revision from bim.model_authority where model_id = ${modelId}`;
  return Number(model?.authorization_revision);
}

async function grantViewer(owner: string, coworker: string) {
  const initial = await revision();
  assert.equal(await members.roleOf(modelId, coworker), null);
  assert.equal(await change(saved.active, coworker, null, "viewer"), "changed");
  assert.equal(await change(saved.active, coworker, "viewer", "viewer"), "unchanged");
  assert.equal(await change(saved.active, coworker, null, "editor"), "conflict");
  assert.equal(await change(saved.active, owner, "manager", null), "denied");
  assert.equal(await revision(), initial + 1);

  // Two editors of the membership list act on the same observed role.
  const race = await Promise.all([
    change(saved.active, coworker, "viewer", "editor"), change(saved.active, coworker, "viewer", null),
  ]);
  assert.deepEqual(race.sort(), ["changed", "conflict"]);
  const winner = await members.roleOf(modelId, coworker);
  assert.ok(winner === "editor" || winner === null);
  assert.equal(await revision(), initial + 2);
  assert.equal(await change(saved.active, coworker, winner, "manager"), "changed");

  // A separate existing person can receive an ordinary membership from a manager.
  const [peer] = await sql<{ person_id: string }[]>`insert into bim.people(person_id, display_name)
    values ('12345678-0000-0000-0000-000000000036', 'Field coordinator') returning person_id`;
  assert.ok(peer);
  assert.equal(await change(saved.coworker, owner, "manager", "editor"), "denied");
  assert.equal(await change(saved.coworker, peer.person_id, null, "manager"), "denied");
  assert.equal(await change(saved.revoked, peer.person_id, null, "viewer"), "denied");
  assert.equal(await change(saved.coworker, peer.person_id, null, "viewer"), "changed");
  assert.equal(await change(saved.coworker, peer.person_id, "viewer", "editor"), "changed");
  assert.equal(await change(saved.coworker, peer.person_id, "editor", null), "changed");
  assert.equal(await change(saved.active, coworker, "manager", "viewer"), "changed");
  assert.equal(await change(saved.coworker, peer.person_id, null, "viewer"), "denied");
  assert.equal(await revision(), initial + 7);
}

async function admission(actor: Actor, token: string, onModel: string) {
  const session = await sessions.resolveSession(token);
  if (!session) return { ok: false as const, reason: "Sign in again" };
  const lineage = await connectionLineageFor(lineages, onModel);
  if (!lineage) return { ok: false as const, reason: "No such model" };
  return authorizeConnection(authorizer, { verifiedUserId: session.personId, token, modelId: onModel, actor, lineage });
}

async function exerciseHub(owner: string, coworker: string) {
  const [copy] = await branches.list(modelId);
  assert.ok(copy);
  const store = new PostgresCommitStore(sql, { modelId, owner: `member-drill-${process.pid}`,
    ownerMachine: null, leaseTtlMs: 10000, nativeSaveOrder: true });
  try {
    const sequencer = await Sequencer.start(store, { enabled: true });
    assert.equal(sequencer.groupCommit(), false, "Native edits must be durable before peers see them");
    const head = await sequencer.head();
    const before = head.revision;
    const key = "native-group-selection";
    assert.equal(store.decideLocal(0, key, before, () => assert.fail("Native saves cannot preview"), owner).kind, "fallback");
    await assert.rejects(store.flush(0, [{
      idempotencyKey: key, actorId: owner, before: head, after: head,
      outcome: { status: "rejected", error: { code: "invalid_value", message: "Drill", elementIds: [] } },
    }]), /membership-ordered/);
    for (const [person, token, levelId, canWrite] of [
      [coworker, saved.coworker, "viewer-level", false], [owner, saved.active, "east-roof", true],
    ] as const) {
      const actor: Actor = { id: person, name: "Drill member", kind: "human" };
      const hub = new SyncHub(sequencer, {
        authorize: hello => admission(hello.actor, hello.token ?? "", modelId),
        readSaveReceipt: (_conn, key, digest) => readNativeSaveReceipt(sql, token, modelId, actor, key, digest),
      });
      const child = await admission(actor, token, copy.modelId);
      assert.ok(child.ok);
      assert.equal(child.principal.canWrite, canWrite);
      const replies: ServerMessage[] = [];
      const conn = { id: person, send: (wire: string) => { replies.push(JSON.parse(wire)); } };
      hub.join(conn);
      await hub.handle(conn, JSON.stringify({ type: "hello", actor, modelId, token, lastRevision: -1 } satisfies ClientMessage));
      assert.equal(hub.principalOf(conn.id)?.canWrite, canWrite);
      assert.ok(replies.some((m) => m.type === "welcome" && m.model.revision === before && m.model.elements["ground-floor"]));
      const command: Command = { type: "create_level", levelId, name: levelId, elevationMm: 6400 };
      await hub.handle(conn, JSON.stringify({ type: "command", request: { actor, baseRevision: before, idempotencyKey: levelId, command } } satisfies ClientMessage));
      const reply = replies.find((m) => m.type === "outcome" && m.idempotencyKey === levelId);
      assert.ok(reply?.type === "outcome");
      assert.equal(reply.outcome.authorizationRevision, String(await revision()));
      const digest = commandDigest(command);
      await hub.handle(conn, JSON.stringify({ type: "read_save_receipt", idempotencyKey: levelId, commandDigest: digest } satisfies ClientMessage));
      const receipt = replies.find(m => m.type === "save_receipt");
      assert.ok(receipt?.type === "save_receipt");
      assert.deepEqual(receipt.outcome, reply.outcome);
      assert.equal(await readNativeSaveReceipt(sql, token, copy.modelId, actor, levelId, digest), null);
      assert.equal(await readNativeSaveReceipt(sql, token, modelId, actor, levelId, commandDigest({ ...command, elevationMm: 6401 })), null);
      const otherPerson = canWrite ? coworker : owner;
      const otherToken = canWrite ? saved.coworker : saved.active;
      assert.equal(await readNativeSaveReceipt(sql, otherToken, modelId, { ...actor, id: otherPerson }, levelId, digest), null);
      if (canWrite) assert.equal(reply.outcome.status, "committed");
      else {
        assert.equal(reply.outcome.status, "rejected");
        assert.equal(reply.outcome.error.code, "forbidden");
        assert.equal((await sequencer.head()).revision, before);
      }
      hub.leave(conn);
    }
    const after = await sequencer.head();
    assert.equal(after.revision, before + 1);
    assert.ok(after.elements["east-roof"] && !after.elements["viewer-level"]);
    const actor: Actor = { id: coworker, name: "Drill member", kind: "human" };
    const option = await branches.create({ baseModelId: modelId, baseRevision: after.revision,
      name: "Coworker option", createdBy: coworker });
    const open = await admission(actor, saved.coworker, option.modelId);
    assert.ok(open.ok && open.principal.canWrite, "A base viewer can edit their own open proposal");
    await branches.close(option.modelId);
    const closed = await admission(actor, saved.coworker, option.modelId);
    assert.ok(closed.ok && !closed.principal.canWrite, "A closed proposal stays readable");
  } finally {
    await store.releaseLease();
  }
}

try {
  const owner = await sessions.resolveSession(saved.active);
  const coworker = await sessions.resolveSession(saved.coworker);
  assert.ok(owner && coworker);
  if (phase === "grant") await grantViewer(owner.personId, coworker.personId);
  else await exerciseHub(owner.personId, coworker.personId);
  console.log(JSON.stringify({ owner: await members.roleOf(modelId, owner.personId),
    coworker: await members.roleOf(modelId, coworker.personId), revision: await revision() }));
} finally {
  await sql.end();
}
