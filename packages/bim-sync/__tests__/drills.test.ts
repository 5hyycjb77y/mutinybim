/**
 * @jest-environment node
 *
 * In-process behavior drills R1-R7 against the in-memory development baseline.
 * Each drill states an outcome. Nothing here crosses a network or a process
 * boundary; deployed, real-process drills (real machines, signals, wss) are in
 * services/bim-authority/drills/deployed.ts.
 */
import {
  canonicalJson,
  executeCommand,
  readSetStillValid,
  type Actor,
  type CommandRequest,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  InMemoryCommitStore,
  Sequencer,
  StaleLeaseError,
  SyncClient,
  SyncHub,
  type CommitOutcome,
} from "../src";

const FT = 304.8;

/** Simulated network: every hop is async; `settle()` waits until it is quiet. */
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

function connect(net: Net, hub: SyncHub, actor: Actor, id: string) {
  const link = { online: true };
  const outcomes: CommitOutcome[] = [];
  const conn = {
    id,
    send: (data: string) => {
      if (link.online) client.receive(data);
    },
  };
  const client: SyncClient = new SyncClient(
    {
      send: (data) => {
        if (link.online) net.track(hub.handle(conn, data));
      },
      close: () => hub.leave(conn),
    },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome) },
    60_000,
  );
  hub.join(conn);
  client.opened();
  return { client, link, conn, outcomes };
}

const human = (name: string): Actor => ({ id: name.toLowerCase(), name, kind: "human" });
const agent = (name: string): Actor => ({ id: name.toLowerCase(), name, kind: "agent" });

async function setup() {
  const store = new InMemoryCommitStore(createDemoModel());
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer);
  return { store, sequencer, hub, net: new Net() };
}

function hashOf(client: SyncClient): string {
  const view = client.view();
  return view ? canonicalJson({ revision: client.confirmedRevision(), elements: view.elements }) : "none";
}

describe("F-a: two browsers see one coherent connected change", () => {
  it("a branch slide in one client arrives whole in the other", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    const res = a.client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    expect(res.ok).toBe(true);
    await net.settle();
    const view = b.client.view();
    const run = view?.elements["seg-run-1"];
    const elbow = view?.elements["elbow-1"];
    expect(run?.kind === "duct_segment" && run.start.x).toBeCloseTo(10 * FT);
    expect(elbow?.kind === "elbow" && elbow.position.x).toBeCloseTo(10 * FT);
    expect(b.client.confirmedRevision()).toBe(1);
    expect(hashOf(a.client)).toBe(hashOf(b.client));
  });
});

describe("R1 one accepted writer after failover", () => {
  it("a stale sequencer cannot commit once a new one holds the lease", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const first = await Sequencer.start(store);
    const req = (key: string, cfm: number, base = 0): CommandRequest => ({
      idempotencyKey: key,
      baseRevision: base,
      actor: human("Priya"),
      command: { type: "set_terminal_cfm", terminalId: "sd-1", cfm },
    });
    expect((await first.submit(req("key-first-0001", 360))).status).toBe("committed");
    const second = await Sequencer.start(store); // failover: new lease generation
    await expect(first.submit(req("key-first-0002", 370))).rejects.toThrow(StaleLeaseError);
    const ok = await second.submit(req("key-second-001", 380, 1));
    expect(ok.status).toBe("committed");
    expect((await store.changesSince(0)).map((cs) => cs.revision)).toEqual([1, 2]);
  });
});

describe("R2 atomic changesets", () => {
  it("an invalid command changes nothing for anyone", async () => {
    const { hub, store, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    const before = canonicalJson(await store.head());
    const res = a.client.submit({ type: "slide_branch", tapId: "tap-1", s: 18 * FT });
    expect(res.ok).toBe(false);
    await net.settle();
    expect(canonicalJson(await store.head())).toBe(before);
  });
});

describe("R3 validation dependencies are re-verified", () => {
  it("a read-but-unwritten element changing between validation and commit invalidates the read set", async () => {
    const model = createDemoModel();
    const validated = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.readSet["seg-run-1"]).toBeDefined();
    const store = new InMemoryCommitStore(model);
    const seq = await Sequencer.start(store);
    await seq.submit({
      idempotencyKey: "other-resize-01",
      baseRevision: 0,
      actor: human("Avery"),
      command: { type: "resize_run", segmentId: "seg-run-1", profile: { shape: "rect", width: 12 * 25.4, height: 8 * 25.4 } },
    });
    expect(readSetStillValid(await store.head(), validated.readSet)).toBe(false);
  });
});

describe("R4 server-derived scope", () => {
  it("ignores a caller-supplied read set / authored list", async () => {
    const { hub, store } = await setup();
    const conn = { id: "forger", send: () => undefined };
    hub.join(conn);
    await hub.handle(
      conn,
      JSON.stringify({
        type: "command",
        request: {
          idempotencyKey: "forged-scope-1",
          baseRevision: 0,
          actor: agent("Agent-1"),
          command: { type: "slide_branch", tapId: "tap-1", s: 10 * FT },
          readSet: {},
          authored: [],
          intents: [],
        },
      }),
    );
    const cs = (await store.changesSince(0))[0];
    expect(cs).toBeDefined();
    expect(Object.keys(cs?.readSet ?? {})).toEqual(expect.arrayContaining(["tap-1", "seg-trunk", "seg-run-1"]));
    expect(cs?.authored).toEqual([{ elementId: "tap-1", field: "s", value: 10 * FT }]);
  });
});

describe("R5 idempotent retries", () => {
  it("the same key returns the first outcome and commits once", async () => {
    const { sequencer, store } = await setup();
    const req: CommandRequest = {
      idempotencyKey: "retry-key-0001",
      baseRevision: 0,
      actor: human("Priya"),
      command: { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 },
    };
    const first = await sequencer.submit(req);
    const again = await sequencer.submit(req);
    expect(again).toEqual(first);
    expect(await store.changesSince(0)).toHaveLength(1);
  });
});

describe("R6 guaranteed catch-up", () => {
  it("a lost final broadcast is recovered by the heartbeat head check", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    hub.dropNextBroadcasts(1);
    a.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 275 });
    await net.settle();
    expect(b.client.confirmedRevision()).toBe(0); // missed it, nothing else happens
    b.client.checkHead(); // the periodic heartbeat
    await net.settle();
    expect(b.client.confirmedRevision()).toBe(1);
    expect(hashOf(a.client)).toBe(hashOf(b.client));
  });

  it("an offline client converges after reconnect with no lost or duplicated changesets", async () => {
    const { hub, store, net } = await setup();
    const india = connect(net, hub, human("Priya"), "india");
    const us = connect(net, hub, human("Avery"), "us");
    const bot = connect(net, hub, agent("Agent-1"), "agent");
    await net.settle();
    india.link.online = false;
    for (let i = 0; i < 5; i++) {
      bot.client.submit({ type: "set_terminal_cfm", terminalId: i % 2 ? "sd-1" : "sd-2", cfm: 300 + i * 10 });
      await net.settle();
    }
    us.client.submit({ type: "slide_branch", tapId: "tap-2", s: 28 * FT });
    await net.settle();
    india.link.online = true;
    india.client.opened();
    await net.settle();
    expect(india.client.confirmedRevision()).toBe((await store.head()).revision);
    expect((await store.changesSince(0)).map((cs) => cs.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hashOf(india.client)).toBe(hashOf(us.client));
    expect(hashOf(us.client)).toBe(hashOf(bot.client));
  });
});

describe("model reset under an open browser", () => {
  /** A browser whose server can be swapped for a freshly reset one, mid-session. */
  async function browserAcrossReset() {
    const first = await setup();
    const server = { hub: first.hub };
    const net = first.net;
    const resets: { fromRevision: number; toRevision: number; droppedEdits: number }[] = [];
    const outcomes: CommitOutcome[] = [];
    const keys: string[] = [];
    const conn = { id: "avery", send: (data: string) => client.receive(data) };
    const client: SyncClient = new SyncClient(
      { send: (data) => net.track(server.hub.handle(conn, data)), close: () => server.hub.leave(conn) },
      human("Avery"),
      {
        onOutcome: (r, o) => {
          outcomes.push(o);
          keys.push(r.idempotencyKey);
        },
        onModelReset: (info) => resets.push(info),
      },
      60_000,
    );
    server.hub.join(conn);
    client.opened();
    await net.settle();
    client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 });
    await net.settle();
    client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 320 });
    await net.settle();
    expect(client.confirmedRevision()).toBe(2);
    // A test run resets the model: the server now holds a fresh Rev 0.
    const reset = await setup();
    server.hub.leave(conn);
    server.hub = reset.hub;
    server.hub.join(conn);
    return { client, net, resets, outcomes, keys, reset };
  }

  it("a head check answered after newer live edits is stale, not a reset (far-away browsers)", async () => {
    const { hub, net } = await setup();
    const resets: unknown[] = [];
    const heldHeartbeats: string[] = [];
    const conn = { id: "india", send: (data: string) => client.receive(data) };
    const client: SyncClient = new SyncClient(
      {
        send: (data) => {
          // The head check is slow (another route, an ocean away); everything else flows normally.
          if (JSON.parse(data).type === "heartbeat") heldHeartbeats.push(data);
          else net.track(hub.handle(conn, data));
        },
        close: () => hub.leave(conn),
      },
      human("Priya"),
      { onModelReset: (info) => resets.push(info) },
      60_000,
    );
    hub.join(conn);
    client.opened();
    await net.settle();
    client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 });
    await net.settle();
    expect(client.confirmedRevision()).toBe(1);
    client.checkHead(); // asked while at Rev 1
    client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 320 });
    await net.settle();
    expect(client.confirmedRevision()).toBe(2);
    expect(heldHeartbeats).toHaveLength(1);
    // The answer finally arrives: Rev 1, older than what the browser now holds, but not lower than when it asked.
    client.receive(JSON.stringify({ type: "head", revision: 1 }));
    await net.settle();
    expect(resets).toEqual([]);
    expect(client.confirmedRevision()).toBe(2);
    client.dispose();
  });

  it("the heartbeat sees the head went backwards and reloads instead of staying ahead", async () => {
    const { client, net, resets } = await browserAcrossReset();
    client.checkHead();
    await net.settle();
    expect(client.confirmedRevision()).toBe(0);
    expect(resets).toEqual([{ fromRevision: 2, toRevision: 0, droppedEdits: 0 }]);
    expect(client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT }).ok).toBe(true);
    await net.settle();
    expect(client.confirmedRevision()).toBe(1);
  });

  it("an edit refused because its base is ahead reloads once, and the next edit saves", async () => {
    const { client, net, resets, outcomes, reset } = await browserAcrossReset();
    client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    await net.settle();
    const refused = outcomes.at(-1);
    expect(refused?.status === "rejected" && refused.error.code).toBe("stale_base");
    expect(resets).toEqual([{ fromRevision: 2, toRevision: 0, droppedEdits: 1 }]);
    client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    await net.settle();
    expect(outcomes.at(-1)?.status).toBe("committed");
    expect((await reset.store.head()).revision).toBe(1);
  });

  it("a repeated delivery of the same refusal does not reload or warn twice", async () => {
    const { client, net, resets, outcomes, keys } = await browserAcrossReset();
    client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    await net.settle();
    const refused = outcomes.at(-1);
    if (refused?.status !== "rejected") throw new Error("expected a refusal");
    // Candidate C's bridge can deliver the same stored outcome a second time.
    client.receive(JSON.stringify({ type: "outcome", idempotencyKey: keys.at(-1), outcome: refused }));
    await net.settle();
    expect(resets).toHaveLength(1);
    expect(client.confirmedRevision()).toBe(0);
  });
});

describe("conflict policy through the hub", () => {
  it("two people resizing the same run: the second gets a conflict naming the first", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    b.link.online = false;
    a.client.submit({ type: "resize_run", segmentId: "seg-trunk", profile: { shape: "rect", width: 30 * 25.4, height: 12 * 25.4 } });
    await net.settle();
    b.link.online = true;
    const sent = b.client.submit({ type: "resize_run", segmentId: "seg-trunk", profile: { shape: "rect", width: 28 * 25.4, height: 12 * 25.4 } });
    expect(sent.ok).toBe(true);
    await net.settle();
    const outcome = b.outcomes.at(-1);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") {
      expect(outcome.error.code).toBe("conflict");
      expect(outcome.conflict?.withActor.name).toBe("Priya");
    }
  });

  it("two people changing different diffusers: no conflict, totals right everywhere", async () => {
    const { hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a");
    const b = connect(net, hub, human("Avery"), "b");
    await net.settle();
    b.link.online = false;
    a.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 500 });
    await net.settle();
    b.link.online = true;
    b.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 100 });
    await net.settle();
    expect(b.outcomes.at(-1)?.status).toBe("committed");
    a.client.checkHead();
    b.client.checkHead();
    await net.settle();
    const ahu = a.client.view()?.elements["ahu-1"];
    expect(ahu?.kind === "equipment" && ahu.totalCfm).toBe(600);
    expect(hashOf(a.client)).toBe(hashOf(b.client));
  });
});

describe("client status", () => {
  it("ends Live when the transport answers hello synchronously (cache-backed backends)", () => {
    const statuses: string[] = [];
    const model = createDemoModel();
    const client: SyncClient = new SyncClient(
      {
        send: (data) => {
          if (JSON.parse(data).type === "hello") client.receive(JSON.stringify({ type: "welcome", model }));
        },
        close: () => undefined,
      },
      human("Priya"),
      { onStatus: (s) => statuses.push(s) },
      60_000,
    );
    client.opened();
    client.opened(); // reconnect path, now with a confirmed model
    expect(statuses.at(-1)).toBe("live");
    client.dispose();
  });
});

describe("authorization hook", () => {
  it("a connection without access to the project is denied and receives nothing", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const sequencer = await Sequencer.start(store);
    const hub = new SyncHub(sequencer, {
      authorize: async (hello) =>
        hello.token === "good" ? { ok: true, principal: { actorId: hello.actor.id, canWrite: true } } : { ok: false, reason: "No access to this project" },
    });
    const received: string[] = [];
    const outsider = { id: "x", send: (d: string) => received.push(d) };
    hub.join(outsider);
    await hub.handle(outsider, JSON.stringify({ type: "hello", actor: human("Outsider"), lastRevision: -1, token: "bad" }));
    await hub.handle(outsider, JSON.stringify({ type: "sync", fromRevision: 0 }));
    expect(received.map((d) => JSON.parse(d).type)).toEqual(["denied", "denied"]);
  });
});

describe("scripted agents + humans: convergence under a burst", () => {
  it("random concurrent edits from 4 actors converge to identical state", async () => {
    const { hub, store, net } = await setup();
    const actors = [connect(net, hub, human("Priya"), "p"), connect(net, hub, human("Avery"), "k"), connect(net, hub, agent("Agent-1"), "a1"), connect(net, hub, agent("Agent-2"), "a2")];
    await net.settle();
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 300; i++) {
      const who = actors[Math.floor(rand() * actors.length)];
      if (!who) continue;
      who.link.online = rand() > 0.15;
      if (rand() < 0.5) who.client.submit({ type: "slide_branch", tapId: rand() < 0.5 ? "tap-1" : "tap-2", s: (6 + rand() * 30) * FT });
      else who.client.submit({ type: "set_terminal_cfm", terminalId: rand() < 0.5 ? "sd-1" : "sd-2", cfm: Math.round(150 + rand() * 400) });
      who.link.online = true;
      if (i % 10 === 0) await net.settle();
    }
    await net.settle();
    for (const a of actors) {
      a.link.online = true;
      a.client.opened();
    }
    await net.settle();
    const hashes = new Set(actors.map((a) => hashOf(a.client)));
    expect(hashes.size).toBe(1);
    const revisions = (await store.changesSince(0)).map((cs) => cs.revision);
    expect(revisions).toEqual(revisions.map((_, i) => i + 1));
  });
});

/** A store whose durable storage can be switched off, like a database outage. */
class FlakyStore extends InMemoryCommitStore {
  down = false;
  /** Store the commit, then fail before answering: the ambiguous case after a crash or a dropped connection. */
  failAfterCommit = false;
  override async transact(...args: Parameters<InMemoryCommitStore["transact"]>) {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const result = await super.transact(...args);
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error("Connection terminated unexpectedly");
    }
    return result;
  }
  override async head() {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    return super.head();
  }
}

describe("storage outages are never silent", () => {
  it("an edit during an outage is shown as not saved, kept, retried with the same key, and saved once", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const store = new FlakyStore(createDemoModel());
      const hub = new SyncHub(await Sequencer.start(store));
      const net = new Net();
      const a = connect(net, hub, human("Priya"), "a");
      await net.settle();
      const client = a.client;
      store.down = true;
      const res = client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 });
      expect(res.ok).toBe(true);
      await net.settle();
      const s1 = client.saveState();
      expect(s1.retrying).toBe(1);
      expect(s1.message).toMatch(/Not saved yet/);
      expect(a.outcomes).toHaveLength(0); // nothing decided, nothing claimed
      // Still down at the first retry: still kept, still not saved.
      jest.advanceTimersByTime(1000);
      await net.settle();
      expect(client.saveState().retrying).toBe(1);
      expect(client.pendingCount()).toBe(1);
      // Storage back: the next retry saves it exactly once.
      store.down = false;
      jest.advanceTimersByTime(2000);
      await net.settle();
      expect(a.outcomes.map((o) => o.status)).toEqual(["committed"]);
      expect(client.saveState()).toEqual({ pending: 0, retrying: 0, message: null });
      expect((await store.changesSince(0)).filter((cs) => res.ok && cs.idempotencyKey === res.request.idempotencyKey)).toHaveLength(1);
      expect(client.confirmedRevision()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stored-then-failed (ambiguous) edit: the retry gets the first answer, applied once", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const store = new FlakyStore(createDemoModel());
      const hub = new SyncHub(await Sequencer.start(store));
      const net = new Net();
      const a = connect(net, hub, human("Priya"), "a");
      await net.settle();
      store.failAfterCommit = true;
      const res = a.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 333 });
      await net.settle();
      expect(a.client.saveState().retrying).toBe(1);
      jest.advanceTimersByTime(1000);
      await net.settle();
      expect(a.outcomes).toHaveLength(1);
      expect(a.outcomes[0]).toMatchObject({ status: "committed", revision: 1 });
      const log = await store.changesSince(0);
      expect(log.filter((cs) => res.ok && cs.idempotencyKey === res.request.idempotencyKey)).toHaveLength(1);
      expect(log).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a server that lost its lease says so, stops, and never claims the edit was saved", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const old = await Sequencer.start(store);
    const lost: StaleLeaseError[] = [];
    const hub = new SyncHub(old, { onLeaseLost: (err) => lost.push(err) });
    const net = new Net();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    await Sequencer.start(store); // another process takes over
    a.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 401 });
    await net.settle();
    expect(lost).toHaveLength(1);
    expect(a.outcomes).toHaveLength(0);
    expect(a.client.saveState().retrying).toBe(1);
    expect(a.client.saveState().message).toMatch(/no longer owns the model/);
    expect(await store.changesSince(0)).toHaveLength(0);
    a.client.dispose();
  });

  it("a read during an outage tells the person, then clears when storage answers again", async () => {
    const store = new FlakyStore(createDemoModel());
    const hub = new SyncHub(await Sequencer.start(store));
    const net = new Net();
    const a = connect(net, hub, human("Priya"), "a");
    await net.settle();
    store.down = true;
    a.client.checkHead();
    await net.settle();
    expect(a.client.saveState().message).toMatch(/can't reach the database/);
    store.down = false;
    a.client.checkHead();
    await net.settle();
    expect(a.client.saveState().message).toBeNull();
    a.client.dispose();
  });
});
