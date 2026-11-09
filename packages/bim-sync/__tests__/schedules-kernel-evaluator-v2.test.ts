/**
 * @jest-environment node
 *
 * The authority's evaluator opens a schedule view saved as v2 (the grid's
 * builder and bim_schedule_define write `props.scheduleV2`). Before, it read
 * only `props.schedule`, so a builder-saved schedule reopened as "This view
 * has no schedule yet".
 */
import { commandSchema, executeCommand, type ModelState, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { scheduleV1ToV2 } from "@permitzip/bim-kernel/schedules";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { kernelScheduleEvaluator } from "../src/schedules/kernel-evaluator";

function run(model: ModelState, command: unknown): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

const TERMINALS = { category: "air_terminal" as const, columns: [{ field: "mark" }, { field: "cfm" }] };

describe("kernelScheduleEvaluator on a v2 schedule view", () => {
  it("opens props.scheduleV2 with the v2 definition's own columns", () => {
    const v2: ScheduleDefinitionV2 = { ...scheduleV1ToV2(TERMINALS), name: "Terminals by type", columns: [{ id: "type", kind: "field", path: "type" }, { id: "cfm", kind: "field", path: "cfm" }] };
    const m = run(createDemoModel(), { type: "create_view", viewId: "sched-v2", name: "Terminals (v2)", viewType: "schedule", props: { scheduleV2: v2 } });
    const opened = kernelScheduleEvaluator().open(m, { viewId: "sched-v2" });
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.instance.rows().columns.map((c) => c.id)).toEqual(["type", "cfm"]);
    expect(opened.instance.rows().rowCount).toBeGreaterThan(0);
  });

  it("opens a v1 view converted in place by set_view_properties", () => {
    let m = run(createDemoModel(), { type: "create_view", viewId: "sched", name: "Terminals", viewType: "schedule", props: { schedule: TERMINALS } });
    const before = kernelScheduleEvaluator().open(m, { viewId: "sched" });
    m = run(m, { type: "set_view_properties", viewId: "sched", props: { scheduleV2: scheduleV1ToV2(TERMINALS) } });
    const after = kernelScheduleEvaluator().open(m, { viewId: "sched" });
    if (!before.ok || !after.ok) throw new Error("schedule did not open");
    expect(after.instance.rows().elementIds).toEqual(before.instance.rows().elementIds);
  });
});
