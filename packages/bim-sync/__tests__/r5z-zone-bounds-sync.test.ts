/**
 * @jest-environment node
 *
 * Round 5b f-spatial over live sync (product decision: models upgrade quietly on the
 * next edit, undo works). A stored v1 zone is upgraded to zone@2 by the next
 * edit that touches it, in that edit's changeset; undo puts the stored record
 * back. With an old page connected the edit saves the v1 shape, and an
 * outlined zone is refused (in words) instead of saved.
 *
 * Fails on the old code: no zone step was registered, so the server never
 * advertised `schema:zone@2` and an outlined zone could not be made at all.
 */
import { asElementId, storedSchemaVersion, type Actor, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, recordFeature, type CommitOutcome } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const LEVEL: BimElement = { id: asElementId("lvl-1"), version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 };
/** A zone saved before round 5b: spaceIds only. */
const STORED: BimElement = { id: asElementId("z1"), version: 1, authoredRev: {}, kind: "zone", name: "Zone 1", purpose: "thermal", spaceIds: [] };

function storedModel(): ModelState {
  const demo = createDemoModel();
  return { ...demo, elements: { ...demo.elements, [LEVEL.id]: LEVEL, [STORED.id]: STORED } };
}

function attach(hub: SyncHub, actor: Actor, id: string, opts: { oldPage?: boolean } = {}) {
  const outcomes: CommitOutcome[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const toServer = (data: string) => {
    if (!opts.oldPage) return data;
    const msg: unknown = JSON.parse(data);
    if (typeof msg !== "object" || msg === null || !("type" in msg) || msg.type !== "hello") return data;
    const { protocol: _dropped, ...rest } = Object.fromEntries(Object.entries(msg)); // a round 5a page reads no zone@2
    return JSON.stringify(rest);
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
  return { client, outcomes };
}

const FEATURE = recordFeature("zone", 2);

async function startHub() {
  const store = new InMemoryCommitStore(storedModel());
  const sequencer = await Sequencer.start(store);
  return { hub: new SyncHub(sequencer), store };
}

describe("r5z zone@2 over live sync", () => {
  it("the next edit upgrades the stored zone in its own changeset; undo restores the v1 record", async () => {
    const { hub, store } = await startHub();
    expect(hub.protocol.features).toContain(FEATURE);
    const a = attach(hub, avery, "a");
    await settle();
    expect(a.client.submit({ type: "edit_zone", zoneId: "z1", name: "Zone A" }).ok).toBe(true);
    await settle();
    expect(a.outcomes.map((o) => o.status)).toEqual(["committed"]);
    const edited = (await store.head()).elements.z1;
    expect(edited).toMatchObject({ name: "Zone A", spaceIds: [], bounds: { kind: "spaces", spaceIds: [] }, schemaVersion: 2 });
    const [cs] = await store.changesSince(0);
    expect(cs?.elements.find((e) => e.id === "z1")).toEqual(edited);

    expect(a.client.submit({ type: "undo", revision: 1 }).ok).toBe(true);
    await settle();
    const undone = (await store.head()).elements.z1;
    expect(undone).toMatchObject({ name: "Zone 1" });
    expect(undone).not.toHaveProperty("bounds");
    expect(storedSchemaVersion(undone ?? {})).toBeUndefined();
  });

  it("an outlined zone saves when everyone reads zone@2", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    await settle();
    const outline = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }];
    expect(a.client.submit({ type: "create_zone", zoneId: "fa1", name: "Fire area 1", purpose: "fire_area", outline: { levelId: "lvl-1", outline } }).ok).toBe(true);
    await settle();
    expect((await store.head()).elements.fa1).toMatchObject({ bounds: { kind: "outline", levelId: "lvl-1", outline } });
  });

  it("with an old page connected: the edit saves the v1 shape, and an outlined zone isn't saved", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    attach(hub, priya, "old", { oldPage: true });
    await settle();
    expect(hub.everyoneReads(FEATURE)).toBe(false);
    expect(a.client.submit({ type: "edit_zone", zoneId: "z1", name: "Zone A" }).ok).toBe(true);
    await settle();
    const edited = (await store.head()).elements.z1;
    expect(edited).toMatchObject({ name: "Zone A" });
    expect(edited).not.toHaveProperty("bounds");

    a.client.submit({ type: "create_zone", zoneId: "fa1", name: "Fire area 1", purpose: "fire_area", outline: { levelId: "lvl-1", outline: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }] } });
    await settle();
    expect((await store.head()).elements.fa1).toBeUndefined();
    const last = a.outcomes[a.outcomes.length - 1];
    expect(last?.status).not.toBe("committed");
  });
});
