/**
 * @jest-environment node
 *
 * A v2 schedule view can be created and changed by command (`props.scheduleV2`),
 * the same path people and agents use for every other view. Before, the
 * view-properties schema refused the key and only a direct model write could
 * make one.
 */
import { commandSchema, executeCommand, type ModelState, type ScheduleDefinitionV2 } from "../src";
import { scheduleV1ToV2 } from "../src/schedules/engine";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const terminals: ScheduleDefinitionV2 = scheduleV1ToV2({ category: "air_terminal", title: "Air terminal schedule", columns: [{ field: "mark" }, { field: "cfm" }] });

function run(model: ModelState, command: unknown) {
  return executeCommand(model, commandSchema.parse(command));
}

describe("scheduleV2 on view commands", () => {
  const model = createDemoModel();

  it("creates a schedule view with a v2 definition and keeps it on the view", () => {
    const r = run(model, { type: "create_view", viewId: "sched-v2", name: "Air terminals (v2)", viewType: "schedule", props: { scheduleV2: terminals } });
    if (!r.ok) throw new Error(r.error.message);
    const view = r.model.elements["sched-v2"];
    expect(view?.kind === "view" ? view.props?.scheduleV2 : null).toEqual(terminals);
  });

  it("takes a form presentation and highlights, and changes the definition with set_view_properties", () => {
    const created = run(model, { type: "create_view", viewId: "sched-v2", name: "Air terminals (v2)", viewType: "schedule", props: { scheduleV2: terminals } });
    if (!created.ok) throw new Error(created.error.message);
    const next: ScheduleDefinitionV2 = { ...terminals, columns: [...terminals.columns, { id: "big", kind: "formula", expression: "{cfm} * 2", highlights: [{ when: "{cfm} > 500 cfm", tone: "warning", reason: "Over 500 CFM" }] }] };
    const r = run(created.model, { type: "set_view_properties", viewId: "sched-v2", props: { scheduleV2: next } });
    if (!r.ok) throw new Error(r.error.message);
    const view = r.model.elements["sched-v2"];
    expect(view?.kind === "view" ? view.props?.scheduleV2?.columns.map((c) => c.id) : null).toEqual(["mark", "cfm", "big"]);
  });

  it("refuses a v2 schedule on a plan, and a view that is two kinds of schedule at once", () => {
    const onPlan = run(model, { type: "create_view", viewId: "p", name: "Plan", viewType: "floor_plan", props: { level: "L1", scheduleV2: terminals } });
    expect(onPlan.ok ? "" : onPlan.error.message).toBe("Only schedule views list elements in a table.");
    const both = run(model, { type: "create_view", viewId: "s", name: "Both", viewType: "schedule", props: { scheduleV2: terminals, schedule: { category: "air_terminal", columns: [{ field: "mark" }] } } });
    expect(both.ok ? "" : both.error.message).toContain("pick one, not both");
  });

  it("refuses an unknown key inside the definition by name", () => {
    const parsed = commandSchema.safeParse({ type: "create_view", viewId: "x", name: "X", viewType: "schedule", props: { scheduleV2: { ...terminals, colums: [] } } });
    expect(parsed.success).toBe(false);
    const badUnit = commandSchema.safeParse({ type: "create_view", viewId: "x", name: "X", viewType: "schedule", props: { scheduleV2: { ...terminals, columns: [{ id: "cfm", kind: "field", path: "cfm", unit: "furlongs" }] } } });
    expect(badUnit.success ? "" : badUnit.error.issues[0]?.message).toContain("not a unit MutinyBIM knows");
    const goodUnit = commandSchema.safeParse({ type: "create_view", viewId: "x", name: "X", viewType: "schedule", props: { scheduleV2: { ...terminals, columns: [{ id: "cfm", kind: "field", path: "cfm", unit: "cfm" }] } } });
    expect(goodUnit.success).toBe(true);
  });
});
