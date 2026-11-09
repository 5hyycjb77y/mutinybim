/**
 * @jest-environment node
 *
 * Quiet upgrade on edit over live sync (round 5a, f-wire; product decision
 * 6): a stored record below its kind's current schema version is upgraded by
 * the next edit that touches it, in that edit's changeset, and undo puts the
 * stored record back. It happens only while the server and every connected
 * page read the new shape; with an old page connected the edit saves the old
 * shape. Nothing else in the model is rewritten.
 *
 * Needs the one hook line in `finish()` (command-core.ts, applied by
 * f-layers).
 *
 * Fails on the code before round 5a: there was no record schema registry and
 * no upgrade inside a command, so the edited level kept its old shape.
 */
import {
  asElementId,
  registerSchemaStep,
  storedSchemaVersion,
  unregisterSchemaSteps,
  type Actor,
  type Level,
  type ModelState,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, recordFeature, type CommitOutcome } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const STORED: Level = { id: asElementId("lvl-1"), version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 };

/** A model saved before the step existed: its level has no schema version. */
function storedModel(): ModelState {
  const demo = createDemoModel();
  return { ...demo, elements: { ...demo.elements, [STORED.id]: STORED } };
}

function attach(hub: SyncHub, actor: Actor, id: string, opts: { oldPage?: boolean } = {}) {
  const outcomes: CommitOutcome[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const toServer = (data: string) => {
    if (!opts.oldPage) return data;
    const msg: unknown = JSON.parse(data);
    if (typeof msg !== "object" || msg === null || !("type" in msg) || msg.type !== "hello") return data;
    const { protocol: _dropped, ...rest } = Object.fromEntries(Object.entries(msg)); // a round 4 page sends no protocol
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

const FEATURE = recordFeature("level", 2);

beforeAll(() => {
  registerSchemaStep({
    kind: "level",
    from: 1,
    to: 2,
    name: "r5w_test_level_label",
    feature: FEATURE,
    upgrade: (r) => (r.kind === "level" ? Object.assign({}, r, { r5wLabel: r.name.toUpperCase() }) : r),
  });
});
afterAll(() => unregisterSchemaSteps("level"));

async function startHub() {
  const store = new InMemoryCommitStore(storedModel());
  const sequencer = await Sequencer.start(store);
  return { hub: new SyncHub(sequencer), store };
}

describe("quiet upgrade on the next edit", () => {
  it("the edit's changeset carries the upgraded record; undo restores the stored one", async () => {
    const { hub, store } = await startHub();
    expect(hub.protocol.features).toContain(FEATURE);
    const a = attach(hub, avery, "a");
    await settle();
    const demoIds = Object.keys(createDemoModel().elements);

    expect(a.client.submit({ type: "update_level", levelId: "lvl-1", name: "Ground floor" }).ok).toBe(true);
    // The page predicts what the server will store (it advertised the feature).
    expect(storedSchemaVersion(a.client.view()?.elements["lvl-1"] ?? {})).toBe(2);
    await settle();
    expect(a.outcomes.map((o) => o.status)).toEqual(["committed"]);

    const head = await store.head();
    const edited = head.elements["lvl-1"];
    // The step runs on the edited record (end of the command, before derive and validate).
    expect(edited).toMatchObject({ name: "Ground floor", r5wLabel: "GROUND FLOOR", schemaVersion: 2 });
    const [cs] = await store.changesSince(0);
    expect(cs?.revision).toBe(1); // one batch: the upgrade and the edit
    expect(cs?.elements.find((e) => e.id === "lvl-1")).toEqual(edited);
    // Nothing else was rewritten or stamped.
    for (const id of demoIds) expect(storedSchemaVersion(head.elements[id] ?? {})).toBeUndefined();

    expect(a.client.submit({ type: "undo", revision: 1 }).ok).toBe(true);
    await settle();
    const undone = (await store.head()).elements["lvl-1"];
    expect(undone).toMatchObject({ name: "Level 1", elevationMm: 0 });
    expect(undone).not.toHaveProperty("schemaVersion");
    expect(undone).not.toHaveProperty("r5wLabel");
  });

  it("with an old page connected, the edit saves the old shape (it couldn't read the new one)", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    attach(hub, priya, "old", { oldPage: true });
    await settle();
    expect(hub.everyoneReads(FEATURE)).toBe(false);
    expect(a.client.submit({ type: "update_level", levelId: "lvl-1", name: "Ground floor" }).ok).toBe(true);
    await settle();
    const edited = (await store.head()).elements["lvl-1"];
    expect(edited).toMatchObject({ name: "Ground floor" });
    expect(edited).not.toHaveProperty("schemaVersion");
    expect(edited).not.toHaveProperty("r5wLabel");
    // The page's own prediction is replaced by what the server stored.
    expect(storedSchemaVersion(a.client.view()?.elements["lvl-1"] ?? {})).toBeUndefined();
  });
});
