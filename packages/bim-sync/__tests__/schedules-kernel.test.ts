/**
 * @jest-environment node
 *
 * Live schedules through the kernel's row engine (Stream E) on the hub: a
 * schedule view is evaluated over the whole building, edits arrive as
 * patches, a changed definition re-sends the rows, a deleted view closes.
 */
import { DOCUMENT_ZONE, PROJECT_DOCUMENT_LEVEL, type Actor, type Command, type ModelState } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, SyncScheduleConnection, actorColor, kernelScheduleEvaluator, type ScheduleEvent } from "../src";

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

const VIEW = "sched-air-terminals";

/** One zone of the building, plus the project documents (where a schedule view lives) so this person can edit the schedule. */
const INTEREST = { areas: [{ level: "L01", zone: "Z1" }, { level: PROJECT_DOCUMENT_LEVEL, zone: DOCUMENT_ZONE }] };
async function setup() {
  const sequencer = await Sequencer.start(new InMemoryCommitStore(createFullBimModel(FULL_BIM_TIERS.XS)));
  const hub = new SyncHub(sequencer, { schedules: kernelScheduleEvaluator() });
  const net = new Net();
  const actor: Actor = { id: "avery", name: "Avery", kind: "human" };
  const conn = { id: "k", send: (data: string) => client.receive(data) };
  const client: SyncClient = new SyncClient({ send: (data) => net.track(hub.handle(conn, data)), close: () => hub.leave(conn) }, actor, {}, 60_000, { interest: INTEREST });
  hub.join(conn);
  client.opened();
  await net.settle();
  const schedules = new SyncScheduleConnection(client, { id: actor.id, name: actor.name, color: actorColor(actor.id) });
  const submit = async (command: Command) => {
    const res = client.submit(command);
    if (!res.ok) throw new Error(res.error.message);
    await net.settle();
  };
  return { sequencer, hub, net, client, schedules, submit };
}

const terminals = (m: ModelState) => Object.values(m.elements).filter((e) => e.kind === "terminal");

describe("kernel row engine behind the hub", () => {
  it("whole-building rows, patches on edit, fresh rows on a definition change, closed on delete", async () => {
    const { sequencer, net, client, schedules, submit } = await setup();
    await submit({ type: "create_view", viewId: VIEW, name: "Air terminal schedule", viewType: "schedule", props: { schedule: { category: "air_terminal", columns: [{ field: "mark" }, { field: "cfm" }] } } });
    const events: ScheduleEvent[] = [];
    const sub = schedules.open({ viewId: VIEW }, (e) => events.push(e));
    sub.requestWindow({ offset: 0, limit: 2000 });
    await net.settle();

    const head = await sequencer.head();
    const rows = events.filter((e): e is Extract<ScheduleEvent, { type: "rows" }> => e.type === "rows").at(-1);
    expect(rows?.total).toBe(terminals(head).length);
    expect(rows?.rows.columns.map((c) => c.heading)).toEqual(["MARK", "CFM"]);

    // The schedule covers the whole building; the client edits a terminal it has loaded (its interest is L01 / Z1 and the documents).
    const loaded = client.view();
    const target = loaded ? terminals(loaded)[0] : undefined;
    expect(target).toBeDefined();
    expect(terminals(head).length).toBeGreaterThan(loaded ? terminals(loaded).length : 0);
    await submit({ type: "set_terminal_cfm", terminalId: target?.id ?? "", cfm: 345 });
    const patch = events.filter((e): e is Extract<ScheduleEvent, { type: "patch" }> => e.type === "patch").at(-1)?.patch;
    expect(patch?.upserts.map((u) => u.elementId)).toEqual([target?.id]);

    const rowsBefore = events.filter((e) => e.type === "rows").length;
    await submit({ type: "set_view_properties", viewId: VIEW, props: { schedule: { category: "air_terminal", columns: [{ field: "mark" }] } } });
    const fresh = events.filter((e): e is Extract<ScheduleEvent, { type: "rows" }> => e.type === "rows");
    expect(fresh).toHaveLength(rowsBefore + 1);
    expect(fresh.at(-1)?.rows.columns.map((c) => c.heading)).toEqual(["MARK"]);

    await submit({ type: "delete_view", viewId: VIEW });
    expect(events.at(-1)).toEqual({ type: "closed", reason: "deleted", message: "This schedule was deleted." });
    schedules.dispose();
  });
});
