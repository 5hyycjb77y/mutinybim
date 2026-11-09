/**
 * @jest-environment node
 *
 * Round 10 lane P10 (coordinator line in the hub): a pipe fitting that keeps
 * its joint by end type (`end_type`) reaches a peer without
 * `pipes:addon_products` under its stored joint name, in the welcome. A peer
 * of this release gets the record as stored.
 *
 * Fails on round 9's hub plus P10's kernel: `lowerModelFor` lowered add-on
 * kinds only, so the older page received `end_type`, which it can't read.
 */
import { recomputeDerived, type Actor, type ElementId, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const priya: Actor = { id: "user-priya", name: "Priya", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function attach(hub: SyncHub, actor: Actor, id: string, opts: { oldPage?: boolean } = {}) {
  const received: unknown[] = [];
  const conn = {
    id,
    send: (data: string) => {
      received.push(JSON.parse(data));
      client.receive(data);
    },
  };
  const toServer = (data: string) => {
    if (!opts.oldPage) return data;
    const msg: unknown = JSON.parse(data);
    if (typeof msg !== "object" || msg === null || !("type" in msg) || msg.type !== "hello") return data;
    const { protocol: _dropped, ...rest } = Object.fromEntries(Object.entries(msg)); // a page from before round 10 reads no pipes:addon_products
    return JSON.stringify(rest);
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, toServer(data)), close: () => hub.leave(conn) },
    actor,
    {},
    60_000,
    { clientSessionId: `${id}-session`, meter: null },
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, received };
}

function welcomeOf(received: readonly unknown[]): ModelState {
  for (const m of received) if (typeof m === "object" && m !== null && "type" in m && m.type === "welcome" && "model" in m) return m.model as ModelState;
  throw new Error("no welcome");
}

describe("p10 hub lowers pipe joints for an older peer", () => {
  it("an end-type joint arrives under its stored name for an older page; a current page gets it as stored", async () => {
    const demo = recomputeDerived(createDemoModel("p10-hub")).model;
    const press: RunFitting = {
      id: "p10-press" as ElementId,
      kind: "run_fitting",
      version: 1,
      authoredRev: {},
      fittingType: "elbow",
      label: "Elbow",
      domain: "pipe",
      systemId: "s" as ElementId,
      levelId: "l" as ElementId,
      position: { x: 0, y: 0, z: 0 },
      ports: [],
      family: "pipe.water.elbow_90",
      params: { end_type: "plumbing_gas.press", r_over_d: 1, takeout_mm: 0 },
    };
    const store = new InMemoryCommitStore({ ...demo, elements: { ...demo.elements, [press.id]: press } });
    const hub = new SyncHub(await Sequencer.start(store));

    const current = attach(hub, avery, "current");
    const old = attach(hub, priya, "old", { oldPage: true });
    await settle();

    const toOld = welcomeOf(old.received).elements[press.id] as RunFitting | undefined;
    expect(toOld?.params).toEqual({ joint: "press", r_over_d: 1, takeout_mm: 0 });
    const toCurrent = welcomeOf(current.received).elements[press.id] as RunFitting | undefined;
    expect(toCurrent?.params).toEqual(press.params);
  });
});
