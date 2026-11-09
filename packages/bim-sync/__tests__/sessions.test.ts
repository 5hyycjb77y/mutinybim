/**
 * @jest-environment node
 *
 * Session identity and host controls (MutinyBIM CP2): the same person in two
 * tabs gets stale-edit protection, separate agent runs are separate
 * identities, a host can admit an already-authorized connection, revoke it
 * live, or halt commits, and a session can report what it measured.
 */
import { executeCommand, type Actor, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  InMemoryCommitStore,
  NO_MODEL_ACCESS,
  Sequencer,
  SessionMeter,
  SyncClient,
  SyncHub,
  agentActor,
  percentiles,
  syncUrlForModel,
  type CommitOutcome,
  type ConnectionStatus,
  type SessionReport,
} from "../src";

const FT = 304.8;
const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Waits for a named condition, turn by turn, and fails saying which one never
 * came. Measurement assertions use this instead of settle(): they depend on a
 * particular message having been handled, not on how many turns went by.
 */
async function waitFor(what: string, done: () => boolean, maxTurns = 500): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`[sessions.test] still waiting after ${maxTurns} event-loop turns for: ${what}`);
}

/**
 * Puts the wall clock under the test's control. Only Date is faked: event-loop
 * turns stay real, so waitFor() still runs the link. Commit times, heartbeat
 * answers and arrivals are stamped in whole milliseconds, so on a real clock an
 * in-process arrival can land half a millisecond "before" its commit once the
 * clock offset is estimated, and the meter rightly drops it. A held clock makes
 * every measurement exact.
 */
function controlClock(start = Date.UTC(2026, 10, 7, 12)): { advance(ms: number): void } {
  jest.useFakeTimers({ now: start, doNotFake: ["setImmediate", "clearImmediate", "nextTick", "queueMicrotask", "performance", "hrtime"] });
  return { advance: (ms) => jest.setSystemTime(Date.now() + ms) };
}

/** The messages a tab has received, parsed. */
const messages = (received: readonly string[]): { type: string; changeset?: { idempotencyKey: string }; idempotencyKey?: string }[] =>
  received.map((raw) => JSON.parse(raw) as { type: string });

/** True once a tab has received the change committed with `idempotencyKey` (as a changeset or an advance). */
const hasReceived = (received: readonly string[], idempotencyKey: string): boolean =>
  messages(received).some((m) => (m.type === "changeset" && m.changeset?.idempotencyKey === idempotencyKey) || (m.type === "advance" && m.idempotencyKey === idempotencyKey));

/** A client on an in-memory link to a hub; the host admits it with a principal, as the authority does. */
function attach(
  hub: SyncHub,
  actor: Actor,
  id: string,
  opts: { canWrite?: boolean; clientSessionId?: string; meter?: SessionMeter; deliver?: (data: string, receive: () => void) => void } = {},
) {
  const outcomes: CommitOutcome[] = [];
  const received: string[] = [];
  const state: { status: ConnectionStatus; history: ConnectionStatus[] } = { status: "connecting", history: [] };
  const conn = {
    id,
    send: (data: string) => {
      // `deliver` lets a test hold a message back to choose the order a tab sees them in.
      const receive = () => {
        received.push(data);
        client.receive(data);
      };
      if (opts.deliver) opts.deliver(data, receive);
      else receive();
    },
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    {
      onOutcome: (_req, outcome) => outcomes.push(outcome),
      onStatus: (status) => {
        state.status = status;
        state.history.push(status);
      },
    },
    60_000,
    { clientSessionId: opts.clientSessionId, meter: opts.meter ?? null },
  );
  hub.join(conn, { actorId: actor.id, canWrite: opts.canWrite ?? true });
  client.opened();
  return { client, outcomes, received, conn, status: () => state.status, statusHistory: () => [...state.history] };
}

/** Slide branch 1 along the trunk (the demo model's tap-1). */
function slideCommand(model: ModelState, s: number): Command {
  if (!model.elements["tap-1"]) throw new Error("demo model has no tap-1");
  return { type: "slide_branch", tapId: "tap-1", s };
}

async function startHub(options: ConstructorParameters<typeof SyncHub>[1] = {}) {
  const store = new InMemoryCommitStore(createDemoModel());
  const sequencer = await Sequencer.start(store);
  return { hub: new SyncHub(sequencer, options), store, sequencer };
}

describe("stale-edit protection between two sessions of the same person", () => {
  it("refuses the second tab's edit made on a revision the first tab already changed", async () => {
    const { hub } = await startHub();
    const tabA = attach(hub, avery, "tab-a");
    const tabB = attach(hub, avery, "tab-b");
    await settle();
    const base = tabA.client.confirmedModel();
    if (!base) throw new Error("not connected");
    expect(executeCommand(base, slideCommand(base, 10 * FT)).ok).toBe(true);

    // Both tabs edit the same tap from the same revision; tab B has not seen tab A's edit.
    const baseRevision = base.revision;
    tabA.client.submit(slideCommand(base, 10 * FT));
    await settle();
    tabB.client.submit(slideCommand(base, 14 * FT), { baseRevision });
    await settle();

    expect(tabA.outcomes).toEqual([expect.objectContaining({ status: "committed" })]);
    expect(tabB.outcomes).toHaveLength(1);
    const second = tabB.outcomes[0];
    expect(second?.status).toBe("rejected");
    if (second?.status === "rejected") expect(second.error.code).toBe("conflict");
  });

  it("still lets one tab build on its own unconfirmed edit", async () => {
    const { hub } = await startHub();
    const tab = attach(hub, avery, "tab-a");
    await settle();
    const base = tab.client.confirmedModel();
    if (!base) throw new Error("not connected");
    tab.client.submit(slideCommand(base, 10 * FT));
    tab.client.submit(slideCommand(base, 12 * FT), { baseRevision: base.revision });
    await settle();
    expect(tab.outcomes.map((o) => o.status)).toEqual(["committed", "committed"]);
  });

  it("treats two agent runs for the same person as different editors", async () => {
    const { hub } = await startHub();
    const run1 = agentActor(avery.id, "run-1", "Agent 1");
    const run2 = agentActor(avery.id, "run-2", "Agent 2");
    expect(run1.id).not.toBe(run2.id);
    const a = attach(hub, run1, "agent-1", { clientSessionId: `run:${run1.id}` });
    const b = attach(hub, run2, "agent-2", { clientSessionId: `run:${run2.id}` });
    await settle();
    const base = a.client.confirmedModel();
    if (!base) throw new Error("not connected");
    a.client.submit(slideCommand(base, 10 * FT));
    await settle();
    b.client.submit(slideCommand(base, 14 * FT), { baseRevision: base.revision });
    await settle();
    const refused = b.outcomes[0];
    expect(refused?.status).toBe("rejected");
    if (refused?.status === "rejected") expect(refused.conflict?.withActor.id).toBe(run1.id);
  });
});

describe("host controls on a live hub", () => {
  it("does not authorize an admitted connection a second time", async () => {
    const authorize = jest.fn();
    const { hub } = await startHub({ authorize });
    const tab = attach(hub, avery, "tab-a");
    await settle();
    expect(authorize).not.toHaveBeenCalled();
    expect(tab.client.confirmedModel()).not.toBeNull();
  });

  it("revoking access sends the plain reason and refuses everything after", async () => {
    const { hub } = await startHub();
    const denied: string[] = [];
    const tab = attach(hub, avery, "tab-a");
    await settle();
    const base = tab.client.confirmedModel();
    if (!base) throw new Error("not connected");
    hub.revoke("tab-a", NO_MODEL_ACCESS);
    for (const raw of tab.received) {
      const msg: unknown = JSON.parse(raw);
      if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "denied" && "reason" in msg && typeof msg.reason === "string") denied.push(msg.reason);
    }
    expect(denied).toEqual([NO_MODEL_ACCESS]);
    const before = tab.received.length;
    tab.client.submit(slideCommand(base, 10 * FT));
    await settle();
    expect(tab.outcomes).toHaveLength(0);
    expect(tab.received.slice(before).some((raw) => raw.includes('"denied"'))).toBe(true);
  });

  it("downgrading to view-only refuses edits with a plain message", async () => {
    const { hub } = await startHub();
    const tab = attach(hub, avery, "tab-a");
    await settle();
    const base = tab.client.confirmedModel();
    if (!base) throw new Error("not connected");
    hub.setPrincipal("tab-a", { actorId: avery.id, canWrite: false });
    tab.client.submit(slideCommand(base, 10 * FT));
    await settle();
    const outcome = tab.outcomes[0];
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") expect(outcome.error.message).toMatch(/view this model but not edit it/);
  });

  it("a halted hub answers 'not saved yet' and commits nothing", async () => {
    const { hub, sequencer } = await startHub();
    const tab = attach(hub, avery, "tab-a");
    await settle();
    const base = tab.client.confirmedModel();
    if (!base) throw new Error("not connected");
    hub.halt("Reconnecting: this server stopped editing the model.");
    tab.client.submit(slideCommand(base, 10 * FT));
    await settle();
    expect(tab.outcomes).toHaveLength(0);
    expect(tab.client.saveState().retrying).toBe(1);
    expect((await sequencer.head()).revision).toBe(base.revision);
  });
});

describe("session measurements", () => {
  afterEach(() => jest.useRealTimers());

  it("percentiles are p50/p95 over the samples", () => {
    expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null });
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(samples)).toEqual({ count: 100, p50: 51, p95: 96 });
  });

  it("uses the heartbeat with the smallest round trip for the clock offset", () => {
    const meter = new SessionMeter("t1", () => ({ userAgent: null, timeZone: null, effectiveType: null, downlinkMbps: null, networkRttMs: null, pageCache: null }));
    // Server clock is 5,000 ms ahead. A 400 ms round trip, then a 40 ms one.
    meter.recordClockSample(1_000, 1_400, 6_200);
    meter.recordClockSample(2_000, 2_040, 7_020);
    const report = meter.report("s-1");
    expect(report.clockRttMs).toBe(40);
    expect(report.clockOffsetMs).toBe(5_000);
    // A commit stamped at server 10,000 that arrives at client 5,120 was 120 ms in flight.
    meter.recordRemoteArrival(new Date(10_000).toISOString(), 5_120);
    expect(meter.report("s-1").remoteVisibility).toEqual({ count: 1, p50: 120, p95: 120 });
  });

  it("a client with a meter reports commit and remote visibility to the host", async () => {
    const clock = controlClock();
    const reports: SessionReport[] = [];
    const { hub } = await startHub({ onReport: ({ report }) => reports.push(report) });
    const env = () => ({ userAgent: "jest", timeZone: "UTC", effectiveType: null, downlinkMbps: null, networkRttMs: null, pageCache: null });
    const meterA = new SessionMeter("drill", env);
    const meterB = new SessionMeter("drill", env);
    const a = attach(hub, avery, "tab-a", { meter: meterA });
    // The other person's change reaches the second tab 120 ms after it was committed.
    const b = attach(hub, { id: "user-priya", name: "Priya", kind: "human" }, "tab-b", {
      meter: meterB,
      deliver: (data, receive) => {
        if (data.includes('"type":"changeset"')) clock.advance(120);
        receive();
      },
    });
    // The second tab counts a remote arrival only while live and once it has a clock estimate (its first heartbeat answer).
    await waitFor("the first tab to be live", () => a.status() === "live" && a.client.confirmedModel() !== null);
    await waitFor("the second tab to be live with a clock offset", () => b.status() === "live" && meterB.report("probe").clockOffsetMs !== null);
    const base = a.client.confirmedModel();
    if (!base) throw new Error("not connected");
    a.client.submit(slideCommand(base, 10 * FT));
    await waitFor("the first tab's edit to be committed", () => a.outcomes.some((o) => o.status === "committed"));
    const key = messages(a.received).find((m) => m.type === "changeset")?.changeset?.idempotencyKey;
    if (!key) throw new Error("the first tab never saw its own changeset");
    await waitFor("the second tab to receive the first tab's change", () => hasReceived(b.received, key));
    a.client.sendReport();
    b.client.sendReport();
    await waitFor("both reports to reach the host", () => reports.length >= 2);
    const fromA = reports.find((r) => r.clientSessionId === a.client.clientSessionId);
    const fromB = reports.find((r) => r.clientSessionId === b.client.clientSessionId);
    expect(fromA?.commit.count).toBe(1);
    expect(fromA?.join.count).toBe(1);
    expect(fromB?.remoteVisibility).toEqual({ count: 1, p50: 120, p95: 120 });
    expect(fromB?.clockOffsetMs).toBe(0);
    expect(fromB?.label).toBe("drill");
  });

  it("drops a remote arrival that lands while catching up (a head answer overtook the change): by design, not a lost edit", async () => {
    const clock = controlClock();
    const reports: SessionReport[] = [];
    const { hub } = await startHub({ onReport: ({ report }) => reports.push(report) });
    const env = () => ({ userAgent: "jest", timeZone: "UTC", effectiveType: null, downlinkMbps: null, networkRttMs: null, pageCache: null });
    const meterB = new SessionMeter("overlap", env);
    // The second tab's inbound messages can be held, so the test picks the order they arrive in.
    let holding = false;
    const held: { data: string; receive: () => void }[] = [];
    const a = attach(hub, avery, "tab-a");
    const b = attach(hub, { id: "user-priya", name: "Priya", kind: "human" }, "tab-b", {
      meter: meterB,
      deliver: (data, receive) => (holding ? held.push({ data, receive }) : receive()),
    });
    await waitFor("the first tab to be live", () => a.status() === "live" && a.client.confirmedModel() !== null);
    await waitFor("the second tab to be live with a clock offset", () => b.status() === "live" && meterB.report("probe").clockOffsetMs !== null);
    const base = a.client.confirmedModel();
    if (!base) throw new Error("not connected");

    holding = true;
    a.client.submit(slideCommand(base, 10 * FT));
    await waitFor("the first tab's edit to be committed", () => a.outcomes.some((o) => o.status === "committed"));
    await waitFor("the change to be queued for the second tab", () => held.some((h) => /"type":"(changeset|advance)"/.test(h.data)));
    // Ask for the head after the commit, so the answer names the new revision.
    b.client.checkHead();
    await waitFor("the head answer to be queued for the second tab", () => held.some((h) => /"type":"head"/.test(h.data)));

    // Deliver the head answer first: the tab sees a newer revision than it holds and starts catching up.
    const order = [...held.filter((h) => /"type":"head"/.test(h.data)), ...held.filter((h) => !/"type":"head"/.test(h.data))];
    held.length = 0;
    holding = false;
    const before = b.statusHistory().length;
    order[0]?.receive();
    expect(b.status()).toBe("catching_up");
    // Had it been counted, this arrival would read 120 ms.
    clock.advance(120);
    for (const h of order.slice(1)) h.receive();
    await waitFor("the second tab to catch up and be live again", () => b.status() === "live" && b.client.confirmedModel()?.revision === base.revision + 1);
    // The edit itself is not lost: the tab holds the new revision and went through catching up to get there.
    expect(b.client.confirmedModel()?.revision).toBe(base.revision + 1);
    expect(b.statusHistory().slice(before)).toEqual(expect.arrayContaining(["catching_up", "live"]));

    b.client.sendReport();
    await waitFor("the second tab's report to reach the host", () => reports.some((r) => r.clientSessionId === b.client.clientSessionId));
    const fromB = reports.find((r) => r.clientSessionId === b.client.clientSessionId);
    // The clock estimate was there; the sample was dropped only because the change arrived while catching up.
    expect(fromB?.clockOffsetMs).toBe(0);
    expect(fromB?.remoteVisibility).toEqual({ count: 0, p50: null, p95: null });
  });
});

describe("a saved answer lost with the connection", () => {
  it("still settles the edit when its committed change arrived before the drop", async () => {
    const { hub } = await startHub();
    const outcomes: CommitOutcome[] = [];
    let dropOutcomes = true;
    const conn = {
      id: "tab-a",
      send: (data: string) => {
        // The connection dies after the broadcast and before the "saved" answer.
        if (dropOutcomes && data.startsWith('{"type":"outcome"')) return;
        client.receive(data);
      },
    };
    const client: SyncClient = new SyncClient(
      { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
      avery,
      { onOutcome: (_req, outcome) => outcomes.push(outcome) },
      60_000,
    );
    hub.join(conn, { actorId: avery.id, canWrite: true });
    client.opened();
    await settle();
    const base = client.confirmedModel();
    if (!base) throw new Error("not connected");
    client.submit(slideCommand(base, 10 * FT));
    await settle();
    expect(outcomes).toEqual([{ status: "committed", revision: base.revision + 1, rebased: false }]);
    expect(client.saveState()).toMatchObject({ pending: 0, retrying: 0 });
    dropOutcomes = false;
  });

  it("asks again after reconnecting when neither the change nor the answer arrived", async () => {
    const { hub, store } = await startHub();
    const outcomes: CommitOutcome[] = [];
    let online = true;
    const conn = { id: "tab-a", send: (data: string) => (online ? client.receive(data) : undefined) };
    const client: SyncClient = new SyncClient(
      { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
      avery,
      { onOutcome: (_req, outcome) => outcomes.push(outcome) },
      60_000,
    );
    hub.join(conn, { actorId: avery.id, canWrite: true });
    client.opened();
    await settle();
    const base = client.confirmedModel();
    if (!base) throw new Error("not connected");
    online = false; // everything the server says from here is lost
    client.submit(slideCommand(base, 10 * FT));
    await settle();
    expect((await store.head()).revision).toBe(base.revision + 1);
    expect(outcomes).toHaveLength(0);
    online = true;
    client.closed();
    client.opened();
    await settle();
    expect(outcomes).toEqual([expect.objectContaining({ status: "committed", revision: base.revision + 1 })]);
    expect((await store.head()).revision).toBe(base.revision + 1);
  });
});

describe("socket address", () => {
  it("carries the model id so the authority can route to the owner", () => {
    expect(syncUrlForModel("wss://mutinybim-example.fly.dev/sync", "site-7301")).toBe("wss://mutinybim-example.fly.dev/sync?model=site-7301");
  });
});
