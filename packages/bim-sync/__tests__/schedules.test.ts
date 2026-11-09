/**
 * @jest-environment node
 *
 * Schedule subscriptions over live sync (SCHEDULES-PLAN §6, Stream G): the
 * model server evaluates schedules over the whole building, sends a window of
 * rows, then patches; `editing_cell` holds make a second person's edit wait;
 * losing access closes the subscription. Real SyncHub, Sequencer and
 * SyncClient on a full-BIM building, in process.
 */
import { type Actor, type Interest, type ModelState } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import {
  DurableLog,
  GroupCommitMemoryStore,
  InMemoryCommitStore,
  LocalScheduleClient,
  LocalScheduleRunner,
  Sequencer,
  SyncClient,
  SyncHub,
  SyncScheduleConnection,
  actorColor,
  type CommitOutcome,
  type ScheduleEvent,
  type ScheduleServerMessage,
  type ServerMessage,
} from "../src";
import { TERMINAL_VIEW, cfmToSi, terminalPlanner, terminalScheduleEvaluator } from "./support/terminal-schedule";
import { airflowOf } from "@permitzip/bim-pack-mechanical";

class Net {
  private inflight = new Set<Promise<void>>();
  track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (this.inflight.size === 0) {
        await new Promise((r) => setImmediate(r));
        if (this.inflight.size === 0) return;
      }
      await Promise.all([...this.inflight]);
    }
  }
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

const human = (name: string): Actor => ({ id: name.toLowerCase(), name, kind: "human" });
const L1Z1: Interest = { areas: [{ level: "L01", zone: "Z1" }] };
const L2Z2: Interest = { areas: [{ level: "L02", zone: "Z2" }] };

function connect(net: Net, hub: SyncHub, actor: Actor, id: string, interest?: Interest) {
  const received: ServerMessage[] = [];
  const sentTypes: string[] = [];
  const conn = {
    id,
    send: (data: string) => {
      const parsed: unknown = JSON.parse(data);
      if (isServerMessage(parsed)) received.push(parsed);
      client.receive(data);
    },
  };
  const client: SyncClient = new SyncClient(
    {
      send: (data) => {
        const parsed: unknown = JSON.parse(data);
        if (isServerMessage(parsed)) sentTypes.push(parsed.type);
        net.track(hub.handle(conn, data));
      },
      close: () => hub.leave(conn),
    },
    actor,
    {},
    60_000,
    interest ? { interest } : {},
  );
  hub.join(conn);
  client.opened();
  const schedules = new SyncScheduleConnection(client, { id: actor.id, name: actor.name, color: actorColor(actor.id) }, { planner: terminalPlanner });
  return { client, conn, received, sentTypes, schedules };
}

function recorder() {
  const events: ScheduleEvent[] = [];
  return { events, listener: (e: ScheduleEvent) => events.push(e), of: <T extends ScheduleEvent["type"]>(type: T) => events.filter((e): e is Extract<ScheduleEvent, { type: T }> => e.type === type) };
}

function terminalIds(model: ModelState, interest?: Interest): string[] {
  const out: string[] = [];
  for (const el of Object.values(model.elements)) {
    if (el.kind !== "terminal") continue;
    if (interest && !interest.areas.some((a) => el.id.startsWith(`${a.level}-${a.zone}-`))) continue;
    out.push(el.id);
  }
  return out;
}

async function setup(store?: InMemoryCommitStore | GroupCommitMemoryStore) {
  const evaluator = terminalScheduleEvaluator();
  const sequencer = await Sequencer.start(store ?? new InMemoryCommitStore(createFullBimModel(FULL_BIM_TIERS.XS)));
  const hub = new SyncHub(sequencer, { schedules: evaluator });
  return { sequencer, hub, evaluator, net: new Net() };
}

const WHOLE = { offset: 0, limit: 2000 };

describe("schedule subscriptions", () => {
  it("a person who loaded one zone opens a whole-building schedule and gets every row", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    await net.settle();
    const rec = recorder();
    const sub = a.schedules.open({ viewId: TERMINAL_VIEW }, rec.listener);
    sub.requestWindow(WHOLE);
    await net.settle();

    const head = await sequencer.head();
    const all = terminalIds(head);
    const inMyZone = terminalIds(head, L1Z1);
    const rows = rec.of("rows").at(-1);
    expect(rows).toBeDefined();
    expect(rows?.total).toBe(all.length);
    expect([...(rows?.rows.rowKeys ?? [])].sort()).toEqual([...all].sort());
    // The client itself holds only its zone; the schedule is still the whole building.
    expect(inMyZone.length).toBeLessThan(all.length);
    expect(terminalIds(a.client.confirmedModel() ?? head).length).toBe(inMyZone.length);
    a.schedules.dispose();
  });

  it("after someone else's edit the subscriber gets a patch for that row, not a rebuild", async () => {
    const { sequencer, hub, net, evaluator } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const b = connect(net, hub, human("Avery"), "b", L2Z2);
    await net.settle();
    const rec = recorder();
    a.schedules.open({ viewId: TERMINAL_VIEW }, rec.listener).requestWindow(WHOLE);
    await net.settle();
    expect(evaluator.counts.opens).toBe(1);
    const rowsBefore = rec.of("rows").length;

    // Avery edits a terminal on L02-Z2, outside Priya's loaded zone.
    const target = terminalIds(await sequencer.head(), L2Z2)[0] ?? "";
    expect(b.client.submit({ type: "set_terminal_cfm", terminalId: target, cfm: 333 }).ok).toBe(true);
    await net.settle();

    const patches = rec.of("patch");
    expect(patches).toHaveLength(1);
    const patch = patches[0]?.patch;
    expect(patch?.upserts.map((u) => u.rowKey)).toEqual([target]);
    expect(patch?.upserts[0]?.values.cfm).toBeCloseTo(cfmToSi(333), 9);
    expect(patch?.toRevision).toBe(1);
    // Patched, not rebuilt: no second open, no fresh rows message.
    expect(evaluator.counts.opens).toBe(1);
    expect(evaluator.counts.applies).toBe(1);
    expect(rec.of("rows")).toHaveLength(rowsBefore);
    // Priya's plan view did not receive the change itself (outside her zone): only a revision notice.
    expect(a.received.filter((m) => m.type === "changeset")).toHaveLength(0);
    expect(hub.metrics.schedules?.patchesSent).toBe(1);
    a.schedules.dispose();
    b.schedules.dispose();
  });

  it("two people with the same schedule open share one evaluation", async () => {
    const { hub, net, evaluator } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    a.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined);
    b.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined);
    await net.settle();
    expect(evaluator.counts.opens).toBe(1);
    expect(hub.metrics.schedules?.open).toBe(2);
    expect(hub.metrics.schedules?.evaluations).toBe(1);
    a.schedules.dispose();
    await net.settle();
    expect(hub.metrics.schedules?.open).toBe(1);
    b.schedules.dispose();
    await net.settle();
    expect(hub.metrics.schedules?.evaluations).toBe(0);
  });

  it("a window holds only its rows; edits outside it send nothing, edits inside it send a patch", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    const rec = recorder();
    const sub = a.schedules.open({ viewId: TERMINAL_VIEW }, rec.listener);
    sub.requestWindow({ offset: 0, limit: 3 });
    await net.settle();
    const first = rec.of("rows").at(-1);
    expect(first?.rows.rowCount).toBe(3);
    expect(first?.total).toBeGreaterThan(6);

    sub.requestWindow({ offset: 3, limit: 3 });
    await net.settle();
    const second = rec.of("rows").at(-1);
    const all = terminalIds(await sequencer.head());
    expect(second?.rows.rowCount).toBe(3);
    expect(second?.window).toEqual({ offset: 3, limit: 3 });

    const outside = all.find((id) => !(second?.rows.rowKeys ?? []).includes(id)) ?? "";
    b.client.submit({ type: "set_terminal_cfm", terminalId: outside, cfm: 211 });
    await net.settle();
    expect(rec.of("patch")).toHaveLength(0);

    const inside = second?.rows.rowKeys[1] ?? "";
    b.client.submit({ type: "set_terminal_cfm", terminalId: inside, cfm: 212 });
    await net.settle();
    expect(rec.of("patch").map((p) => p.patch.upserts.map((u) => u.rowKey))).toEqual([[inside]]);
    a.schedules.dispose();
    b.schedules.dispose();
  });

  it("an unknown schedule is closed with a plain message", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    const rec = recorder();
    a.schedules.open({ viewId: "no-such-view" }, rec.listener);
    await net.settle();
    expect(rec.of("closed")).toEqual([{ type: "closed", reason: "deleted", message: "This schedule was deleted." }]);
    expect(hub.metrics.schedules?.open).toBe(0);
    a.schedules.dispose();
  });

  it("losing read access closes the subscription with denied, and no patch follows", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    const rec = recorder();
    a.schedules.open({ viewId: TERMINAL_VIEW }, rec.listener);
    await net.settle();

    hub.revoke("a", "Your access to this model was removed, so live editing has stopped.");
    await net.settle();
    expect(rec.of("closed")).toEqual([{ type: "closed", reason: "denied", message: "Your access to this model was removed, so live editing has stopped." }]);
    expect(hub.metrics.schedules?.open).toBe(0);

    b.client.submit({ type: "set_terminal_cfm", terminalId: terminalIds(await sequencer.head())[0] ?? "", cfm: 290 });
    await net.settle();
    expect(rec.of("patch")).toHaveLength(0);
    expect(a.received.filter((m) => m.type === "schedule_patch")).toHaveLength(0);
    a.schedules.dispose();
    b.schedules.dispose();
  });

  it("a person's own edit reaches their schedule only after their plan has it (one revision on screen)", async () => {
    const log = new DurableLog(createFullBimModel(FULL_BIM_TIERS.XS), 30);
    const { sequencer, hub, net } = await setup(new GroupCommitMemoryStore(log));
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    a.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined).requestWindow(WHOLE);
    await net.settle();
    a.received.length = 0;
    const target = terminalIds(await sequencer.head())[0] ?? "";
    expect(a.client.submit({ type: "set_terminal_cfm", terminalId: target, cfm: 444 }).ok).toBe(true);
    await net.settle();
    await new Promise((r) => setTimeout(r, 80));
    await net.settle();
    const order = a.received.map((m) => m.type).filter((t) => t === "changeset" || t === "schedule_patch");
    expect(order).toEqual(["changeset", "schedule_patch"]);
    a.schedules.dispose();
  });

  it("re-opens its schedules after a reconnect", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    const rec = recorder();
    a.schedules.open({ viewId: TERMINAL_VIEW }, rec.listener);
    await net.settle();
    expect(rec.of("rows")).toHaveLength(1);
    hub.leave(a.conn);
    a.client.closed();
    expect(hub.metrics.schedules?.open).toBe(0);
    hub.join(a.conn);
    a.client.opened();
    await net.settle();
    expect(rec.of("rows")).toHaveLength(2);
    expect(rec.of("connection")).toEqual([{ type: "connection", state: "connected" }]);
    expect(hub.metrics.schedules?.open).toBe(1);
    a.schedules.dispose();
  });
});

describe("editing_cell holds", () => {
  afterEach(() => jest.useRealTimers());

  it("B's edit to a cell A is editing is held, then sent once A releases it", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    const aRec = recorder();
    const bRec = recorder();
    const aSub = a.schedules.open({ viewId: TERMINAL_VIEW }, aRec.listener);
    const bSub = b.schedules.open({ viewId: TERMINAL_VIEW }, bRec.listener);
    await net.settle();
    const row = terminalIds(await sequencer.head())[0] ?? "";
    aSub.setEditingCell({ rowKey: row, columnId: "cfm" });
    await net.settle();
    const seen = bRec.of("presence").at(-1)?.editing ?? [];
    expect(seen.map((p) => [p.rowKey, p.columnId, p.actor.name])).toEqual([[row, "cfm", "Priya"]]);

    let outcome: Awaited<ReturnType<typeof bSub.edit>> | null = null;
    const editing = bSub.edit({ source: "type", edits: [{ rowKey: row, columnId: "cfm", value: cfmToSi(515) }] }).then((o) => (outcome = o));
    await net.settle();
    // Held: nothing sent, nothing committed.
    expect(outcome).toBeNull();
    expect(b.sentTypes.filter((t) => t === "command")).toHaveLength(0);
    expect((await sequencer.head()).revision).toBe(0);

    aSub.setEditingCell(null);
    await net.settle();
    await editing;
    await net.settle();
    expect(outcome).toEqual({ ok: true, revision: 1, refusals: [] });
    expect(b.sentTypes.filter((t) => t === "command")).toHaveLength(1);
    const after = (await sequencer.head()).elements[row];
    expect(after?.kind === "terminal" ? airflowOf(after) : null).toBeCloseTo(515, 6);
    expect(bRec.of("presence").at(-1)?.editing).toEqual([]);
    a.schedules.dispose();
    b.schedules.dispose();
  });

  it("a hold its owner never releases lapses after the TTL (at most 8 s), and the held edit goes through", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    const bSub = b.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined);
    await net.settle();
    const row = terminalIds(await sequencer.head())[1] ?? "";

    // Priya's laptop closes mid-edit: one announcement, no release, no refresh.
    a.client.sendSchedule({ type: "editing_cell", viewId: TERMINAL_VIEW, rowKey: row, columnId: "cfm", ttlMs: 8000 });
    await net.settle();
    let outcome: Awaited<ReturnType<typeof bSub.edit>> | null = null;
    const editing = bSub.edit({ source: "type", edits: [{ rowKey: row, columnId: "cfm", value: cfmToSi(616) }] }).then((o) => (outcome = o));
    await net.settle();
    jest.advanceTimersByTime(7000);
    await net.settle();
    expect(outcome).toBeNull();
    expect(b.sentTypes.filter((t) => t === "command")).toHaveLength(0);

    jest.advanceTimersByTime(1100);
    await net.settle();
    await editing;
    await net.settle();
    expect(outcome).toEqual({ ok: true, revision: 1, refusals: [] });
    a.schedules.dispose();
    b.schedules.dispose();
  });

  it("someone joining sees holds already in place; a person who leaves releases theirs", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    const aSub = a.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined);
    await net.settle();
    aSub.setEditingCell({ rowKey: "r-1", columnId: "mark" });
    await net.settle();

    const c = connect(net, hub, human("Asha"), "c");
    const cRec = recorder();
    c.schedules.open({ viewId: TERMINAL_VIEW }, cRec.listener);
    await net.settle();
    expect(c.schedules.editingOn(TERMINAL_VIEW).map((h) => [h.rowKey, h.actor.name, h.actor.color])).toEqual([["r-1", "Priya", actorColor("priya")]]);

    hub.leave(a.conn);
    await net.settle();
    expect(c.schedules.editingOn(TERMINAL_VIEW)).toEqual([]);
    a.schedules.dispose();
    c.schedules.dispose();
  });

  it("a second claim on a held cell is refused; the first holder keeps it", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    const c = connect(net, hub, human("Asha"), "c");
    await net.settle();
    for (const p of [a, b, c]) p.schedules.open({ viewId: TERMINAL_VIEW }, () => undefined);
    await net.settle();
    a.client.sendSchedule({ type: "editing_cell", viewId: TERMINAL_VIEW, rowKey: "r-2", columnId: "cfm", ttlMs: 8000 });
    await net.settle();
    b.client.sendSchedule({ type: "editing_cell", viewId: TERMINAL_VIEW, rowKey: "r-2", columnId: "cfm", ttlMs: 8000 });
    await net.settle();
    expect(c.schedules.editingOn(TERMINAL_VIEW).map((h) => h.actor.name)).toEqual(["Priya"]);
    for (const p of [a, b, c]) p.schedules.dispose();
  });
});

describe("standalone runner (no model server)", () => {
  it("serves the same subscription and patches next to a local model", async () => {
    const evaluator = terminalScheduleEvaluator();
    const store = new InMemoryCommitStore(createFullBimModel(FULL_BIM_TIERS.XS));
    const sequencer = await Sequencer.start(store);
    const head = await sequencer.head();
    let client: LocalScheduleClient | null = null;
    const runner = new LocalScheduleRunner(evaluator, head, (msg: ScheduleServerMessage) => client?.receive(msg));
    sequencer.onCommit((cs) => {
      void sequencer.head().then((model) => runner.commit(cs, model));
    });
    const actor: Actor = human("Avery");
    client = new LocalScheduleClient(
      (msg) => void runner.handle(msg),
      (command) => {
        const request = { idempotencyKey: `local-${Math.random().toString(36).slice(2, 12)}`, baseRevision: 0, actor, command };
        const outcome: Promise<CommitOutcome> = sequencer.submit(request);
        return { ok: true, request, outcome };
      },
    );
    const connection = new SyncScheduleConnection(client, { id: "avery", name: "Avery", color: actorColor("avery") }, { planner: terminalPlanner });
    const rec = recorder();
    const sub = connection.open({ viewId: TERMINAL_VIEW }, rec.listener);
    sub.requestWindow(WHOLE);
    await new Promise((r) => setImmediate(r));
    expect(rec.of("rows").at(-1)?.total).toBe(terminalIds(head).length);

    const row = terminalIds(head)[2] ?? "";
    const outcome = await sub.edit({ source: "type", edits: [{ rowKey: row, columnId: "cfm", value: cfmToSi(377) }] });
    expect(outcome).toEqual({ ok: true, revision: 1, refusals: [] });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const patch = rec.of("patch").at(-1)?.patch;
    expect(patch?.upserts.map((u) => [u.rowKey, u.values.cfm])).toEqual([[row, cfmToSi(377)]]);
    expect(evaluator.counts.opens).toBe(1);
    connection.dispose();
  });
});
