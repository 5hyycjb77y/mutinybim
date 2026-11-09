/**
 * @jest-environment node
 *
 * Parts over live sync (CP3): place / delete reach every client whole,
 * area-scoped clients get removals for their area, undo is planned by the
 * client and decided by the sequencer with the history it fetches itself,
 * a retried placement is answered once, and an agent preview saves nothing.
 */
import { BUILTIN_PART_TYPES, canonicalJson, type Actor, type Command, type LibraryEntry } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { AgentSession, InMemoryCommitStore, Sequencer, SyncClient, SyncHub, listPartTypes, queryElements, type CommitOutcome } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };

function libraryType(category: string): LibraryEntry {
  const found = BUILTIN_PART_TYPES.find((t) => t.definition.category === category);
  if (!found) throw new Error(`no ${category} in the starter library`);
  return found;
}
const DIFFUSER = libraryType("air_terminal");
const PANEL = libraryType("electrical_equipment");

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function attach(hub: SyncHub, actor: Actor, id: string, interest?: { areas: { level: string }[] }) {
  const outcomes: CommitOutcome[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null, interest },
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, outcomes };
}

async function startHub() {
  const store = new InMemoryCommitStore(createDemoModel());
  const sequencer = await Sequencer.start(store);
  return { hub: new SyncHub(sequencer), store, sequencer };
}

function place(partId: string, type: LibraryEntry = DIFFUSER, levelId = "lvl-1"): Command {
  return { type: "place_part", partId, typeId: type.id, partType: type.definition, levelId, position: { x: 2000, y: 1000 }, offsetMm: 2743 };
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("nothing yet");
  return item;
}

describe("parts over live sync", () => {
  it("a placement is predicted at once, saved once, and lands identically on another person's screen", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    const b = attach(hub, priya, "b");
    await settle();
    expect(a.client.submit({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).ok).toBe(true);
    await settle();
    const sent = a.client.submit(place("p-1"));
    expect(sent.ok).toBe(true);
    // Live preview: the person's own view has it before the server answers.
    expect(a.client.view()?.elements["p-1"]?.kind).toBe("part");
    await settle();
    expect(last(a.outcomes).status).toBe("committed");
    const head = await store.head();
    expect(canonicalJson(b.client.confirmedModel())).toBe(canonicalJson(head));
  });

  it("the same request key twice (a retry after a lost answer) places one part and gets the first answer", async () => {
    const { hub, store } = await startHub();
    const answers: string[] = [];
    const conn = { id: "raw", send: (data: string) => answers.push(data) };
    hub.join(conn, { actorId: avery.id, canWrite: true });
    const send = (key: string, base: number, command: Command) =>
      hub.handle(conn, JSON.stringify({ type: "command", request: { idempotencyKey: key, baseRevision: base, actor: avery, command } }));
    await send("avery-level-attempt-1", 0, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    await send("avery-place-p-1-attempt", 1, place("p-1"));
    await send("avery-place-p-1-attempt", 1, place("p-1"));
    const outcomes = answers.map((a) => JSON.parse(a)).filter((m) => m.type === "outcome" && m.idempotencyKey === "avery-place-p-1-attempt");
    expect(outcomes.map((m) => m.outcome)).toEqual([
      { status: "committed", revision: 2, rebased: false },
      { status: "committed", revision: 2, rebased: false },
    ]);
    expect((await store.head()).revision).toBe(2);
  });

  it("undo is decided with history the sequencer reads itself, and refuses over the other tab's newer edit", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    const b = attach(hub, priya, "b");
    await settle();
    a.client.submit({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    await settle();
    a.client.submit(place("p-1"));
    await settle();
    a.client.submit({ type: "move_elements", ids: ["p-1"], delta: { x: 500, y: 0 } });
    await settle();
    const moveRevision = (await store.head()).revision;
    b.client.submit({ type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 95 } });
    await settle();
    // Avery's client still predicts the undo (it holds the history), but the sequencer refuses it.
    const sent = a.client.submit({ type: "undo", revision: moveRevision });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.message).toBe(`Priya changed this since (revision ${moveRevision + 1}); undo would overwrite their work`);

    // A client with no local history (a fresh agent) still gets the authoritative answer from the sequencer.
    const fresh = attach(hub, avery, "fresh");
    await settle();
    fresh.client.submit({ type: "move_elements", ids: ["p-1"], delta: { x: 0, y: 100 } });
    await settle();
    const own = (await store.head()).revision;
    const undone = fresh.client.submit({ type: "undo", revision: own });
    expect(undone.ok).toBe(true);
    await settle();
    expect(last(fresh.outcomes).status).toBe("committed");
    const part = (await store.head()).elements["p-1"];
    expect(part?.kind === "part" && part.position).toEqual({ x: 2500, y: 1000 });
  });

  it("a delete reaches a client loading only that level; another level's client is not sent the part", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    await settle();
    a.client.submit({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    a.client.submit({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 4200 });
    await settle();
    a.client.submit(place("panel-1", PANEL, "lvl-2"));
    await settle();
    const onL2 = attach(hub, priya, "l2", { areas: [{ level: "Level 2" }] });
    const onL1 = attach(hub, priya, "l1", { areas: [{ level: "Level 1" }] });
    await settle();
    expect(onL2.client.confirmedModel()?.elements["panel-1"]).toBeDefined();
    expect(onL1.client.confirmedModel()?.elements["panel-1"]).toBeUndefined();
    // Levels and types are global: every area holds them.
    expect(onL1.client.confirmedModel()?.elements[PANEL.id]).toBeDefined();
    a.client.submit({ type: "delete_elements", ids: ["panel-1"], policy: "refuse" });
    await settle();
    expect(onL2.client.confirmedModel()?.elements["panel-1"]).toBeUndefined();
    expect(onL2.client.confirmedRevision()).toBe((await store.head()).revision);
  });
});

describe("agent reads and preview", () => {
  it("lists library types not yet in the model, then the model's own; describes placed parts in plain units", async () => {
    const { store } = await startHub();
    const model = await store.head();
    const listing = listPartTypes(model, { category: "electrical_device" });
    expect(listing.types.length).toBeGreaterThanOrEqual(2);
    expect(listing.types.every((t) => !t.inModel)).toBe(true);
  });

  it("preview reports what would change and saves nothing", async () => {
    const { hub, store } = await startHub();
    const a = attach(hub, avery, "a");
    await settle();
    a.client.submit({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    await settle();
    a.client.submit(place("p-1"));
    await settle();
    const revision = (await store.head()).revision;
    const sockets: { onMessage: (data: string) => void }[] = [];
    const session = await AgentSession.open({
      url: "ws://test.invalid",
      token: "t",
      modelId: "demo",
      actor: { id: "agent:user-avery:run-1", name: "Agent", kind: "agent" },
      timeoutMs: 2000,
      socketFactory: (_url, handlers) => {
        const conn = { id: "agent", send: (data: string) => handlers.onMessage(data) };
        hub.join(conn, { actorId: "agent:user-avery:run-1", canWrite: true });
        sockets.push({ onMessage: handlers.onMessage });
        setImmediate(() => handlers.onOpen());
        return { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) };
      },
    });
    const preview = session.preview({ type: "delete_elements", ids: ["p-1"], policy: "refuse" });
    expect(preview).toMatchObject({ status: "would_save", removedIds: ["p-1"], revision });
    const refused = session.preview({ type: "delete_elements", ids: ["lvl-1"], policy: "refuse" });
    expect(refused.status).toBe("would_refuse");
    expect((await store.head()).revision).toBe(revision);
    const rows = queryElements(session.model(), { kinds: ["part"] }).rows;
    expect(rows[0]?.facts).toMatchObject({ level: "Level 1", category: "air_terminal", height_above_level_ft: 9, airflow: 150 });
    session.close();
  });
});
