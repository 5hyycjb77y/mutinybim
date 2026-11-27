/** Two real editor sync clients on the authority started by native-install.py. */
import assert from "node:assert/strict";
import { on } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import type { Actor } from "@permitzip/bim-kernel";
import { SyncClient, type ServerMessage } from "@permitzip/bim-sync";
import { PgNativeSessionStore } from "../src/native-session-store";
import { connect, PostgresCommitStore } from "../src/pg-store";
import { signIn } from "./native-drill-signin";

const [port, sessionFile] = process.argv.slice(2);
const db = process.env.MUTINYBIM_NATIVE_DRILL_URL;
if (!db || new URL(db).hostname !== "127.0.0.1" || new URL(db).pathname !== "/native_drill" ||
    !sessionFile || !port || !/^\d{1,5}$/.test(port)) {
  throw new Error("Run the disposable database drill with native-install.py");
}
const modelId = "east-plant";
const socketUrl = `ws://127.0.0.1:${port}/sync?model=${modelId}`;
const peers: Peer[] = [];

class Peer {
  readonly socket = new WebSocket(socketUrl);
  readonly client: SyncClient;
  private readonly messages = on(this.socket, "message", { close: ["close"], signal: AbortSignal.timeout(30_000) });
  readonly closed = new Promise<number>((resolve) => this.socket.once("close", resolve));

  constructor(actor: Actor, token: string) {
    peers.push(this);
    this.client = new SyncClient(this.socket, actor, {}, 60_000, { modelId, token });
    this.socket.on("open", () => this.client.opened());
    this.socket.on("message", (raw) => this.client.receive(raw.toString()));
    this.socket.on("close", () => this.client.closed());
  }

  async next<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const event = await this.messages.next();
      assert.ok(!event.done, `Socket closed before ${type}`);
      const message: ServerMessage = JSON.parse(event.value[0].toString());
      if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
      if (message.type === "denied") throw new Error(message.reason);
      if (message.type === "unavailable" || message.type === "error") throw new Error(message.message);
    }
  }

  async addLevel(id: string, name: string) {
    const submitted = this.client.submit({ type: "create_level", levelId: id, name, elevationMm: 8200 }, { idempotencyKey: id });
    assert.ok(submitted.ok, "Valid level should reach the server");
    const reply = await this.next("outcome");
    assert.equal(reply.idempotencyKey, id);
    return reply.outcome;
  }
}

const sql = connect(db);
const sessions = new PgNativeSessionStore(sql);
async function storedHead(databaseUrl: string) {
  // A new store and database connection cannot reuse the running authority's cached model or lease.
  const reader = connect(databaseUrl, 1);
  try {
    return await new PostgresCommitStore(reader, { modelId, owner: "drill-reader", ownerMachine: null, leaseTtlMs: 10000 }).head();
  } finally {
    await reader.end();
  }
}

try {
  const saved: { active: string; coworker: string } = JSON.parse(readFileSync(sessionFile, "utf8"));
  const ownerSession = await sessions.resolveSession(saved.active);
  const viewerSession = await sessions.resolveSession(saved.coworker);
  assert.ok(ownerSession && viewerSession && ownerSession.personId !== viewerSession.personId);
  const ownerActor: Actor = { id: ownerSession.personId, name: "Drill owner", kind: "human" };
  const viewerActor: Actor = { id: viewerSession.personId, name: "Drill coworker", kind: "human" };
  const owner = new Peer(ownerActor, saved.active);
  const viewer = new Peer(viewerActor, saved.coworker);
  const [ownerWelcome, viewerWelcome] = await Promise.all([owner.next("welcome"), viewer.next("welcome")]);
  const before = (await storedHead(db)).revision;
  for (const { model } of [ownerWelcome, viewerWelcome]) {
    assert.equal(model.modelId, modelId);
    assert.equal(model.revision, before);
    assert.ok(model.elements["east-roof"]);
  }

  const level = "east-plant-service-deck";
  const committed = await owner.addLevel(level, "Service deck");
  assert.equal(committed.status, "committed");
  assert.equal(committed.revision, before + 1);
  const { changeset } = await viewer.next("changeset");
  assert.equal(changeset.actor.id, ownerActor.id);
  assert.equal(changeset.idempotencyKey, level);
  assert.equal(changeset.revision, committed.revision);
  const seen = viewer.client.view()?.elements[level];
  assert.ok(seen?.kind === "level");
  assert.equal(seen.name, "Service deck");
  assert.equal(viewer.client.confirmedRevision(), committed.revision);

  const rejectedId = "viewer-service-deck";
  const refused = await viewer.addLevel(rejectedId, "Viewer level");
  assert.equal(refused.status, "rejected");
  assert.equal(refused.error.code, "forbidden");
  const stored = await storedHead(db);
  assert.equal(stored.revision, committed.revision);
  assert.deepEqual(stored.elements[level], seen);
  assert.ok(!stored.elements[rejectedId] && !viewer.client.view()?.elements[rejectedId]);

  await sessions.revokeSession(saved.coworker);
  assert.match((await viewer.next("denied")).reason, /sign in again/i);
  assert.equal(await viewer.closed, 4003);
  const retry = new Peer(viewerActor, saved.coworker);
  assert.match((await retry.next("denied")).reason, /sign in again/i);

  // The next live recheck must keep a still-valid short native session, then drop it at actual expiry.
  const short = await signIn(new PgNativeSessionStore(sql, { sessionTtlSeconds: 5 }), "Drill coworker");
  assert.equal(short.personId, viewerActor.id);
  const temporary = new Peer(viewerActor, short.sessionToken);
  assert.equal((await temporary.next("welcome")).model.revision, committed.revision);
  assert.match((await temporary.next("denied")).reason, /sign in again/i);
  assert.equal(await temporary.closed, 4003);
  assert.equal(await sessions.resolveSession(short.sessionToken), null);
  assert.equal(owner.socket.readyState, WebSocket.OPEN);
  owner.client.checkHead();
  assert.equal((await owner.next("head")).revision, committed.revision);
  console.log(JSON.stringify({ before, saved: stored.revision, viewerSaw: changeset.revision, viewerWrite: refused.error.code }));
} finally {
  for (const peer of peers) peer.socket.terminate();
  await sql.end();
}
