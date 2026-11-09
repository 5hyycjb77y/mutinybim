/**
 * @jest-environment node
 *
 * Round 9 lane B9 (from A9's open item): a record lifted into the parameter
 * form while every connected page read `kinds:addon_owned` must reach a page
 * that joins later without that feature in the form it stores (flat `cfm`),
 * in the welcome, in later changesets and in their `before` records. A page
 * that reads the feature keeps getting the record as stored.
 *
 * Fails on round 8b + A9's hub: `sendWelcome` and `sendChangeset` sent every
 * peer the stored record, so the late older page received `values`.
 */
import { recomputeDerived, type Actor, type BimElement, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { AIRFLOW_KEY, airflowOf } from "@permitzip/bim-pack-mechanical";
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
      received.push(JSON.parse(data))
      client.receive(data)
    },
  };
  const toServer = (data: string) => {
    if (!opts.oldPage) return data;
    const msg: unknown = JSON.parse(data);
    if (typeof msg !== "object" || msg === null || !("type" in msg) || msg.type !== "hello") return data;
    const { protocol: _dropped, ...rest } = Object.fromEntries(Object.entries(msg)); // a page from before round 9 reads no kinds:addon_owned
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

function changesetsOf(received: readonly unknown[]): Changeset[] {
  const out: Changeset[] = [];
  for (const m of received) if (typeof m === "object" && m !== null && "type" in m && m.type === "changeset" && "changeset" in m) out.push(m.changeset as Changeset);
  return out;
}

const flatCfm = (el: BimElement | null | undefined): unknown => (el ? Object.fromEntries(Object.entries(el)).cfm : undefined);
const hasValues = (el: BimElement | null | undefined): boolean => (el ? "values" in el : false);

describe("b9 older peer joins after a lift", () => {
  it("receives the stored (flat) form in its welcome and in later changesets; a new page keeps the parameter form", async () => {
    const store = new InMemoryCommitStore(recomputeDerived(createDemoModel("b9-older")).model);
    const hub = new SyncHub(await Sequencer.start(store));
    const averyPage = attach(hub, avery, "avery");
    await settle();
    expect(averyPage.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }).ok).toBe(true);
    await settle();
    const lifted = (await store.head()).elements["sd-1"];
    expect(lifted && hasValues(lifted)).toBe(true);
    expect(flatCfm(lifted)).toBeUndefined();

    // Priya's page (no kinds:addon_owned) joins after the lift.
    const old = attach(hub, priya, "old", { oldPage: true });
    await settle();
    const welcomed = welcomeOf(old.received).elements["sd-1"];
    expect(flatCfm(welcomed)).toBe(410);
    expect(hasValues(welcomed)).toBe(false);
    expect(welcomed && "schemaVersion" in welcomed).toBe(false);
    expect(airflowOf(welcomed as BimElement)).toBe(410);

    // A later edit of the lifted record: the stored record stays lifted; the old page gets it flat, before included.
    expect(averyPage.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 }).ok).toBe(true);
    await settle();
    const [toOld] = changesetsOf(old.received);
    const oldRecord = toOld?.elements.find((e) => e.id === "sd-1");
    expect(flatCfm(oldRecord)).toBe(420);
    expect(hasValues(oldRecord)).toBe(false);
    const oldBefore = toOld?.before?.["sd-1"];
    expect(flatCfm(oldBefore)).toBe(410);
    expect(hasValues(oldBefore)).toBe(false);

    const toNew = changesetsOf(averyPage.received).at(-1);
    const newRecord = toNew?.elements.find((e) => e.id === "sd-1");
    expect(newRecord && "values" in newRecord ? newRecord.values : null).toEqual({ [AIRFLOW_KEY]: 420 });
    // The old page's own view agrees with the server's totals.
    expect(airflowOf(old.client.view()?.elements["sd-1"] as BimElement)).toBe(420);
  });
});
