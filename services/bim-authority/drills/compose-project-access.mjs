/** Exercise two signed-in project users against a disposable Compose authority. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { SyncClient, NO_MODEL_ACCESS } = require("@permitzip/bim-sync");
const { WebSocket } = require("ws");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const connections = [];

async function until(test, message) {
  const deadline = Date.now() + 30_000;
  while (!test() && Date.now() < deadline) await delay(20);
  assert.ok(test(), message);
}

async function connect(person) {
  const socket = new WebSocket("ws://127.0.0.1:8080/sync?model=demo");
  const client = new SyncClient(socket, { id: person.id, kind: "human", name: person.name },
    {}, 60_000, { modelId: "demo", token: person.token });
  const peer = { client, socket, welcome: null, denied: null, outcome: null };
  connections.push(peer);
  socket.once("open", () => client.opened());
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    client.receive(raw.toString());
    if (message.type === "welcome") peer.welcome = message.model;
    if (message.type === "denied") peer.denied = message.reason;
    if (message.type === "outcome" && message.idempotencyKey === fixture.level) peer.outcome = message.outcome;
  });
  socket.on("close", () => client.closed());
  await until(() => peer.welcome || peer.denied, "Expected a model admission decision");
  return peer;
}

try {
  const member = await connect(fixture.member);
  const outsider = await connect(fixture.outsider);
  assert.equal(outsider.denied, NO_MODEL_ACCESS);
  assert.equal(member.welcome?.revision, fixture.revision);
  for (const id of fixture.existingLevels) {
    assert.equal(member.welcome.elements[id]?.name, id);
  }
  const submitted = member.client.submit({
    type: "create_level", levelId: fixture.level, name: fixture.level, elevationMm: 3000 * (fixture.revision + 1),
  }, { idempotencyKey: fixture.level });
  assert.ok(submitted.ok);
  await until(() => member.outcome, "Expected a durable outcome for the project member");
  assert.equal(member.outcome.status, "committed");
  assert.equal(member.outcome.revision, fixture.revision + 1);
  console.log(JSON.stringify({ opened: member.welcome.revision, saved: member.outcome.revision, nonmemberDenied: true }));
} finally {
  for (const { client, socket } of connections) {
    client.closed();
    socket.close();
  }
}
