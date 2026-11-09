/**
 * @jest-environment node
 *
 * Area-based loading on a full-BIM building: people load a level / zone, get
 * only changes that touch it, and switch areas without reloading the model.
 */
import {
  canonicalJson,
  inInterest,
  partitionOf,
  planCommit,
  sliceModel,
  type Actor,
  type Interest,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, type ServerMessage } from "../src";

const FT = 304.8;

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

function connect(net: Net, hub: SyncHub, actor: Actor, id: string, interest: Interest) {
  const received: ServerMessage[] = [];
  let bytes = 0;
  const conn = {
    id,
    send: (data: string) => {
      bytes += data.length;
      const parsed: unknown = JSON.parse(data);
      if (isServerMessage(parsed)) received.push(parsed);
      client.receive(data);
    },
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => net.track(hub.handle(conn, data)), close: () => hub.leave(conn) },
    actor,
    {},
    60_000,
    { interest },
  );
  hub.join(conn);
  client.opened();
  return { client, received, bytes: () => bytes };
}

const human = (name: string): Actor => ({ id: name.toLowerCase(), name, kind: "human" });

async function setup() {
  const store = new InMemoryCommitStore(createFullBimModel(FULL_BIM_TIERS.XS));
  const sequencer = await Sequencer.start(store);
  return { store, sequencer, hub: new SyncHub(sequencer), net: new Net() };
}

const L1Z1: Interest = { areas: [{ level: "L01", zone: "Z1" }] };
const L1Z2: Interest = { areas: [{ level: "L01", zone: "Z2" }] };
const L2Z1: Interest = { areas: [{ level: "L02", zone: "Z1" }] };

function confirmed(client: SyncClient): ModelState {
  const model = client.confirmedModel();
  if (!model) throw new Error("client has no model");
  return model;
}

/** The client holds exactly the server's head sliced to its areas. */
function expectSlice(client: SyncClient, head: ModelState, interest: Interest): void {
  const mine = confirmed(client);
  const expected = sliceModel(head, interest);
  expect(mine.revision).toBe(head.revision);
  expect(canonicalJson(mine.elements)).toBe(canonicalJson(expected.elements));
  expect(mine.connections.map((c) => c.id).sort()).toEqual(expected.connections.map((c) => c.id).sort());
}

const types = (msgs: readonly ServerMessage[]) => msgs.map((m) => m.type);

describe("area-based loading", () => {
  it("a person loads only their zone, never the whole building", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    await net.settle();
    const head = await sequencer.head();
    const held = Object.keys(confirmed(a.client).elements).length;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(Object.keys(head.elements).length / 3);
    for (const el of Object.values(confirmed(a.client).elements)) expect(inInterest(partitionOf(el), L1Z1)).toBe(true);
    expectSlice(a.client, head, L1Z1);
  });

  it("an edit in zone X is not delivered to someone watching zone Y, who still advances", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();
    const bBefore = canonicalJson(confirmed(b.client).elements);
    b.received.length = 0;

    const res = a.client.submit({ type: "slide_branch", tapId: "L01-Z1-air-t1-s2-b1-tap", s: 3.5 * FT });
    expect(res.ok).toBe(true);
    await net.settle();

    expect(types(b.received)).toEqual(["advance"]);
    expect(confirmed(b.client).revision).toBe(1);
    expect(canonicalJson(confirmed(b.client).elements)).toBe(bBefore);
    const head = await sequencer.head();
    expectSlice(a.client, head, L1Z1);
    expectSlice(b.client, head, L1Z2);
  });

  it("a riser edit through every level reaches people on both levels, each with only their piece", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const c = connect(net, hub, human("Agent"), "c", L2Z1);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();
    for (const p of [a, b, c]) p.received.length = 0;

    const res = a.client.submit({ type: "resize_riser", riserId: "riser-Z1-air", profile: { shape: "rect", width: 40 * 25.4, height: 24 * 25.4 } });
    expect(res.ok).toBe(true);
    await net.settle();

    const changesetFor = (msgs: readonly ServerMessage[]) => msgs.find((m): m is Extract<ServerMessage, { type: "changeset" }> => m.type === "changeset");
    expect(changesetFor(a.received)?.changeset.elements.map((el) => el.id)).toEqual(["L01-Z1-riser-air"]);
    expect(changesetFor(c.received)?.changeset.elements.map((el) => el.id)).toEqual(["L02-Z1-riser-air"]);
    expect(types(b.received)).toEqual(["advance"]);
    const head = await sequencer.head();
    expectSlice(a.client, head, L1Z1);
    expectSlice(c.client, head, L2Z1);
  });

  it("switching areas loads only the new partitions, then delivers their edits", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();
    a.received.length = 0;

    const both: Interest = { areas: [{ level: "L01", zone: "Z1" }, { level: "L01", zone: "Z2" }] };
    a.client.setInterest(both);
    await net.settle();

    const area = a.received.find((m): m is Extract<ServerMessage, { type: "area" }> => m.type === "area");
    if (!area) throw new Error("no area message");
    const head = await sequencer.head();
    expect(area.elements.map((el) => el.id).sort()).toEqual(Object.keys(sliceModel(head, L1Z2).elements).sort());
    expectSlice(a.client, head, both);

    a.received.length = 0;
    expect(b.client.submit({ type: "set_tag_text", tagId: "L01-Z2-door-101-tag", text: "D101 rated" }).ok).toBe(true);
    await net.settle();
    expect(types(a.received)).toEqual(["changeset"]);
    expectSlice(a.client, await sequencer.head(), both);
  });

  it("switching areas while someone keeps editing there still converges exactly", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();

    const both: Interest = { areas: [{ level: "L01", zone: "Z1" }, { level: "L01", zone: "Z2" }] };
    for (let i = 0; i < 6; i++) {
      b.client.submit({ type: "move_tag", tagId: "L01-Z2-door-101-tag", offset: { x: 300 + i * 10, y: 300 } });
      if (i === 2) a.client.setInterest(both);
      b.client.submit({ type: "set_terminal_cfm", terminalId: "L01-Z2-air-t1-s1-b1-dev", cfm: 200 + i * 10 });
    }
    await net.settle();
    const head = await sequencer.head();
    expect(head.revision).toBe(12);
    expectSlice(a.client, head, both);
    expectSlice(b.client, head, L1Z2);
  });

  it("narrowing drops areas locally and stops their changes arriving", async () => {
    const { sequencer, hub, net } = await setup();
    const both: Interest = { areas: [{ level: "L01" }] };
    const a = connect(net, hub, human("Priya"), "a", both);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();
    a.client.setInterest(L1Z1);
    await net.settle();
    a.received.length = 0;
    expect(b.client.submit({ type: "set_tag_text", tagId: "L01-Z2-door-101-tag", text: "D101 rated" }).ok).toBe(true);
    await net.settle();
    expect(types(a.received)).toEqual(["advance"]);
    expectSlice(a.client, await sequencer.head(), L1Z1);
  });

  it("a lost notice outside your area is recovered by the heartbeat like any other", async () => {
    const { sequencer, hub, net } = await setup();
    const a = connect(net, hub, human("Priya"), "a", L1Z1);
    const b = connect(net, hub, human("Avery"), "b", L1Z2);
    await net.settle();
    hub.dropNextBroadcasts(1);
    expect(a.client.submit({ type: "set_tag_text", tagId: "L01-Z1-door-101-tag", text: "D101 rated" }).ok).toBe(true);
    await net.settle();
    expect(confirmed(b.client).revision).toBe(0);
    b.client.checkHead();
    await net.settle();
    expectSlice(b.client, await sequencer.head(), L1Z2);
    expectSlice(a.client, await sequencer.head(), L1Z1);
  });

  it("merge rules: an area older than what you hold never overwrites newer records; one ahead waits until you catch up", () => {
    const full = createFullBimModel(FULL_BIM_TIERS.XS);
    const actor = human("Priya");
    const plan = (head: ModelState, command: Parameters<typeof planCommit>[2]["command"], key: string) => {
      const d = planCommit(head, [], { idempotencyKey: key, baseRevision: head.revision, actor, command });
      if (!d.ok) throw new Error(d.error.message);
      return d;
    };
    const both: Interest = { areas: [{ level: "L01", zone: "Z1" }, { level: "L01", zone: "Z2" }] };
    const sent: string[] = [];
    const client = new SyncClient({ send: (d) => sent.push(d), close: () => undefined }, actor, {}, 60_000, { interest: L1Z1 });
    const feed = (msg: ServerMessage) => client.receive(JSON.stringify(msg));
    client.opened();
    feed({ type: "welcome", model: sliceModel(full, L1Z1), interest: L1Z1 });
    client.setInterest(both);

    // Older area after a newer change to one of its records: keep the newer record.
    const r1 = plan(full, { type: "set_tag_text", tagId: "L01-Z2-door-101-tag", text: "newer" }, "k1-aaaaaaaa");
    feed({ type: "changeset", changeset: r1.changeset });
    const z2 = sliceModel(full, L1Z2);
    feed({ type: "area", revision: 0, interest: both, elements: Object.values(z2.elements), connections: z2.connections });
    const tag = confirmed(client).elements["L01-Z2-door-101-tag"];
    expect(tag?.kind === "tag" ? tag.text : null).toBe("newer");
    expectSlice(client, r1.model, both);

    // An area ahead of us waits: nothing from it shows until our revision reaches it.
    const later = new SyncClient({ send: (d) => sent.push(d), close: () => undefined }, actor, {}, 60_000, { interest: L1Z1 });
    const feedLater = (msg: ServerMessage) => later.receive(JSON.stringify(msg));
    later.opened();
    feedLater({ type: "welcome", model: sliceModel(full, L1Z1), interest: L1Z1 });
    later.setInterest(both);
    const r2 = plan(r1.model, { type: "set_tag_text", tagId: "L01-Z1-door-101-tag", text: "z1 edit" }, "k2-aaaaaaaa");
    const ahead = sliceModel(r2.model, L1Z2);
    feedLater({ type: "area", revision: 2, interest: both, elements: Object.values(ahead.elements), connections: ahead.connections });
    expect(sent.at(-1)).toContain('"type":"sync"');
    feedLater({ type: "changeset", changeset: r1.changeset });
    expect(confirmed(later).revision).toBe(1);
    expect(Object.keys(confirmed(later).elements).some((id) => id.startsWith("L01-Z2-") && id !== "L01-Z2-door-101-tag")).toBe(false);
    feedLater({ type: "changeset", changeset: r2.changeset });
    expectSlice(later, r2.model, both);
  });

  it("an area-loaded browser receives a fraction of the bytes a whole-model browser does", async () => {
    const { hub, net } = await setup();
    const zone = connect(net, hub, human("Priya"), "a", L1Z1);
    const whole = connect(net, hub, human("Avery"), "b", { areas: [{ level: "L01" }, { level: "L02" }] });
    await net.settle();
    expect(zone.bytes() * 3).toBeLessThan(whole.bytes());
  });
});
