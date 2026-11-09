/**
 * @jest-environment node
 *
 * Routing over live sync (CP3 slice 2): a route is predicted at once, saved
 * whole and lands identically for another person; the same person's second
 * tab resizing from an old base gets a conflict (not last-write-wins); an
 * agent's preview of a route saves nothing and its edit goes through the
 * same sequencer.
 */
import { DEFAULT_SETTINGS, builtinPartType, canonicalJson, type Actor, type Command, type LibraryEntry, type ModelState } from "@permitzip/bim-kernel";
import { AgentSession, InMemoryCommitStore, Sequencer, SyncClient, SyncHub, type CommitOutcome } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };
const FT = 304.8;
const IN = 25.4;

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`no ${id} in the starter library`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function attach(hub: SyncHub, actor: Actor, id: string) {
  const outcomes: CommitOutcome[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null },
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, outcomes };
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("nothing yet");
  return item;
}

const empty: ModelState = { modelId: "routing-sync", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

const setup: Command[] = [
  { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
  { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" },
  { type: "place_part", partId: "sd-1", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" },
];

const route: Command = {
  type: "route_run",
  idPrefix: "trunk",
  levelId: "lvl-1",
  domain: "duct",
  size: { shape: "rect", width: 14 * IN, height: 10 * IN },
  elevationMm: 10 * FT,
  system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" },
  points: [],
  from: { kind: "part", partId: "rtu", connectorId: "supply" },
  to: { kind: "part", partId: "sd-1", connectorId: "neck" },
};

async function startWithParts() {
  const store = new InMemoryCommitStore(empty);
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer);
  const a = attach(hub, avery, "a");
  await settle();
  for (const c of setup) {
    expect(a.client.submit(c).ok).toBe(true);
    await settle();
  }
  return { hub, store, a };
}

describe("routing over live sync", () => {
  it("a route is predicted at once, saved whole, and lands identically on another person's screen", async () => {
    const { hub, store, a } = await startWithParts();
    const b = attach(hub, priya, "b");
    await settle();
    expect(a.client.submit(route).ok).toBe(true);
    // The author sees the whole run before the server answers.
    expect(a.client.view()?.elements["trunk-s2"]?.kind).toBe("run_segment");
    await settle();
    expect(last(a.outcomes).status).toBe("committed");
    const head = await store.head();
    expect(head.elements["trunk-s3"]?.kind).toBe("run_segment");
    expect(canonicalJson(b.client.confirmedModel())).toBe(canonicalJson(head));
  });

  it("the same person's other tab resizing from an old base is a conflict, not last-write-wins", async () => {
    const { hub, store, a } = await startWithParts();
    a.client.submit(route);
    await settle();
    const tab2 = attach(hub, avery, "a-tab-2");
    await settle();
    const base = (await store.head()).revision;
    a.client.submit({ type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 16 * IN, height: 10 * IN } });
    await settle();
    expect(last(a.outcomes).status).toBe("committed");
    const sent = tab2.client.submit({ type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 18 * IN, height: 10 * IN } }, { baseRevision: base });
    // The tab predicts it fine on its own view; the sequencer decides against the newer head.
    expect(sent.ok).toBe(true);
    await settle();
    const outcome = last(tab2.outcomes);
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.error.code).toBe("conflict");
    const head = await store.head();
    const seg = head.elements["trunk-s2"];
    expect(seg?.kind === "run_segment" && seg.size).toEqual({ shape: "rect", width: 16 * IN, height: 10 * IN });
  });

  it("an agent previews a route without saving, then routes it through the same sequencer", async () => {
    const { hub, store } = await startWithParts();
    const session = await AgentSession.open({
      url: "ws://test.invalid",
      token: "t",
      modelId: "routing-sync",
      actor: { id: "agent:user-avery:run-1", name: "Agent", kind: "agent" },
      timeoutMs: 2000,
      socketFactory: (_url, handlers) => {
        const conn = { id: "agent", send: (data: string) => handlers.onMessage(data) };
        hub.join(conn, { actorId: "agent:user-avery:run-1", canWrite: true });
        setImmediate(() => handlers.onOpen());
        return { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) };
      },
    });
    const before = (await store.head()).revision;
    const preview = session.preview(route);
    expect(preview.status).toBe("would_save");
    expect((await store.head()).revision).toBe(before);
    const result = await session.edit(route, { idempotencyKey: "agent-route-trunk-key", baseRevision: before });
    expect(result.status).toBe("saved");
    expect((await store.head()).elements["trunk-s1"]?.kind).toBe("run_segment");
    session.close();
  });

  // The browser's kernel predicted a 104 ft riser, the server's message check threw it away, and the page said "Saving…" for good.
  it("refuses at once an edit the server's checks would throw away, so nothing is left saving", async () => {
    const { store, a } = await startWithParts();
    const before = (await store.head()).revision;
    const result = a.client.submit({
      type: "route_run",
      idPrefix: "tall",
      levelId: "lvl-1",
      domain: "duct",
      size: { shape: "rect", width: 14 * IN, height: 10 * IN },
      elevationMm: 9 * FT,
      system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" },
      points: [{ x: 0, y: 10 * FT }, { x: 10 * FT, y: 10 * FT, elevationMm: 104 * FT }, { x: 20 * FT, y: 10 * FT }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/^That height is past what the model allows/);
    expect(a.client.pendingCount()).toBe(0);
    await settle();
    expect((await store.head()).revision).toBe(before);
  });
});
