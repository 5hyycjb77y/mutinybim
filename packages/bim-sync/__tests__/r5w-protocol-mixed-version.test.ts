/**
 * @jest-environment node
 *
 * Mixed versions on the wire (round 5a, f-wire; MIGRATION-PLAN §3
 * "Protocol"): the host app and the model server deploy separately, so a new page
 * meets an old model server and an old page meets a new one. In every
 * combination people keep editing and nobody loses an edit, each side knows
 * what the other speaks, and a message the server cannot act on is answered
 * with a coded error instead of being dropped.
 *
 * "Old" peers are the round 4 wire exactly: an old page sends no `protocol`
 * in hello; an old server ignores the client's `protocol` (its schema strips
 * unknown keys), sends no `protocol` in welcome, and answers anything it
 * can't read with a bare "Message not understood".
 *
 * Fails on the code before round 5a: welcome carried no `protocol`, the hub
 * kept no per-connection protocol (`peerProtocolOf` / `everyoneReads` did not
 * exist), and an unknown message type got `{ type: "error", message }` with
 * no `code` or `messageType`.
 */
import { canonicalJson, type Actor, type Command } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, PROTOCOL_FEATURES, PROTOCOL_VERSION, Sequencer, SyncClient, SyncHub, type CommitOutcome } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

type Json = { readonly [key: string]: unknown };

function parse(data: string): Json {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null) throw new Error(`not a message: ${data}`);
  return Object.fromEntries(Object.entries(value));
}

/** What an old (round 4) model server puts on the wire instead of this message. */
function asOldServer(msg: Json): Json {
  if (msg.type === "welcome") {
    const { protocol: _dropped, ...rest } = msg;
    return rest;
  }
  if (msg.type === "error") return { type: "error", message: "Message not understood" };
  return msg;
}

/** A page on an in-memory link; `oldClient` / `oldServer` reproduce the round 4 wire on that side. */
function attach(hub: SyncHub, actor: Actor, id: string, opts: { oldClient?: boolean; oldServer?: boolean } = {}) {
  const outcomes: CommitOutcome[] = [];
  const received: Json[] = [];
  const conn = {
    id,
    send: (data: string) => {
      const msg = opts.oldServer ? asOldServer(parse(data)) : parse(data);
      received.push(msg);
      client.receive(JSON.stringify(msg));
    },
  };
  const toServer = (data: string) => {
    const msg = parse(data);
    // An old page never sent it; an old server's hello schema drops it.
    if (msg.type === "hello" && (opts.oldClient || opts.oldServer)) {
      const { protocol: _dropped, ...rest } = msg;
      return JSON.stringify(rest);
    }
    return data;
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, toServer(data)), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null },
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, outcomes, received, conn };
}

async function startHub() {
  const store = new InMemoryCommitStore(createDemoModel());
  const sequencer = await Sequencer.start(store);
  return { hub: new SyncHub(sequencer), store };
}

const LEVEL: Command = { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 };
const RENAME = (name: string): Command => ({ type: "update_level", levelId: "lvl-1", name });

/** Both people edit in turn; every edit commits and both screens equal the stored model. */
async function editTogether(a: ReturnType<typeof attach>, b: ReturnType<typeof attach>, store: InMemoryCommitStore) {
  expect(a.client.submit(LEVEL).ok).toBe(true);
  await settle();
  expect(b.client.submit(RENAME("Ground floor")).ok).toBe(true);
  await settle();
  expect(a.client.submit(RENAME("Level 1 (kitchen)")).ok).toBe(true);
  await settle();
  expect(b.client.submit({ type: "update_level", levelId: "lvl-1", elevationMm: 150 }).ok).toBe(true);
  await settle();
  const head = await store.head();
  expect(head.revision).toBe(4);
  expect([...a.outcomes, ...b.outcomes].map((o) => o.status)).toEqual(["committed", "committed", "committed", "committed"]);
  expect(head.elements["lvl-1"]).toMatchObject({ name: "Level 1 (kitchen)", elevationMm: 150 });
  expect(canonicalJson(a.client.confirmedModel())).toBe(canonicalJson(head));
  expect(canonicalJson(b.client.confirmedModel())).toBe(canonicalJson(head));
  expect(a.client.pendingCount() + b.client.pendingCount()).toBe(0);
}

describe("protocol version and features on hello / welcome", () => {
  it("new page with new model server: each side knows what the other reads, and editing works", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    const b = attach(hub, priya, "b");
    await settle();
    const welcome = a.received.find((m) => m.type === "welcome");
    expect(welcome?.protocol).toEqual({ version: PROTOCOL_VERSION, features: expect.arrayContaining([PROTOCOL_FEATURES.unknownMessageAck, PROTOCOL_FEATURES.recordSchemaVersion]) });
    expect(a.client.serverProtocolOf()?.version).toBe(PROTOCOL_VERSION);
    expect(hub.peerProtocolOf("a")).toEqual({ version: PROTOCOL_VERSION, features: expect.arrayContaining([PROTOCOL_FEATURES.recordSchemaVersion]) });
    expect(hub.everyoneReads(PROTOCOL_FEATURES.recordSchemaVersion)).toBe(true);
    await editTogether(a, b, store);
  });

  it("old page with new model server: the server treats it as version 1 and gates new shapes while it is connected", async () => {
    const { hub, store } = await startHub();
    const old = attach(hub, avery, "old", { oldClient: true });
    const fresh = attach(hub, priya, "fresh");
    await settle();
    expect(hub.peerProtocolOf("old")).toEqual({ version: 1, features: [] });
    expect(hub.everyoneReads(PROTOCOL_FEATURES.recordSchemaVersion)).toBe(false);
    await editTogether(old, fresh, store);
    // Once the old page leaves, everyone left reads it again.
    hub.leave(old.conn);
    expect(hub.everyoneReads(PROTOCOL_FEATURES.recordSchemaVersion)).toBe(true);
  });

  it("new page with old model server: the page sees no features, predicts the old shapes, and editing works", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a", { oldServer: true });
    const b = attach(hub, priya, "b", { oldServer: true });
    await settle();
    expect(a.received.find((m) => m.type === "welcome")).not.toHaveProperty("protocol");
    expect(a.client.serverProtocolOf()).toBeUndefined();
    await editTogether(a, b, store);
  });

  it("a feature the server does not advertise is not one everyone reads", async () => {
    const { hub } = await startHub();
    attach(hub, avery, "a");
    await settle();
    expect(hub.everyoneReads("schema:part@2")).toBe(false);
  });
});

describe("a message the server can't act on is answered, never dropped", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined)); // each refusal is logged on purpose
  afterEach(() => jest.restoreAllMocks());

  async function rawConnection() {
    const { hub, store } = await startHub();
    const answers: Json[] = [];
    const conn = { id: "raw", send: (data: string) => answers.push(parse(data)) };
    hub.join(conn, { actorId: avery.id, canWrite: true });
    await hub.handle(conn, JSON.stringify({ type: "hello", actor: avery, lastRevision: -1 }));
    answers.length = 0;
    return { hub, store, conn, answers };
  }

  it("an unknown type gets an unknown_message error naming it", async () => {
    const { hub, conn, answers } = await rawConnection();
    await hub.handle(conn, JSON.stringify({ type: "lease_request", areas: ["L1"] }));
    expect(answers).toEqual([
      expect.objectContaining({ type: "error", code: "unknown_message", messageType: "lease_request", message: expect.stringContaining('"lease_request"') }),
    ]);
  });

  it("a malformed known message and invalid JSON get their own codes", async () => {
    const { hub, conn, answers } = await rawConnection();
    await hub.handle(conn, JSON.stringify({ type: "command", request: { idempotencyKey: "k" } }));
    await hub.handle(conn, "{not json");
    expect(answers.map((a) => [a.type, a.code, a.messageType ?? null])).toEqual([
      ["error", "invalid_message", "command"],
      ["error", "invalid_json", null],
    ]);
  });

  it("keeps the type first on the wire (the host's model session reads errors by prefix) and the connection keeps working", async () => {
    const { hub, store, conn } = await rawConnection();
    const raw: string[] = [];
    const spy = { id: conn.id, send: (data: string) => raw.push(data) };
    await hub.handle(spy, JSON.stringify({ type: "frobnicate" }));
    expect(raw[0]?.startsWith('{"type":"error"')).toBe(true);
    await hub.handle(spy, JSON.stringify({ type: "command", request: { idempotencyKey: "avery-level", baseRevision: 0, actor: avery, command: LEVEL } }));
    expect((await store.head()).revision).toBe(1);
  });
});
