/**
 * @jest-environment node
 *
 * QA D-1 (Oct 27): the model server must open the Loads list. Its columns are
 * trade provider fields (`load.status`, `loads.counted.dfu`), and the
 * evaluator opened every schedule over the bare built-in registry, so the
 * grid answered "This schedule can't be shown: "load.status" isn't a field of
 * Load points" (the same for Not placed yet's `placement`). Native v2
 * schedules now open with every field provider; a v1 schedule keeps the
 * built-in registry, so its columns read and print as before.
 */
import { DEFAULT_SETTINGS, commandSchema, executeCommand, type ModelState, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { scheduleV1ToV2 } from "@permitzip/bim-kernel/schedules";
import { kernelScheduleEvaluator } from "../src/schedules/kernel-evaluator";

function run(model: ModelState, command: unknown): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

const LOADS: ScheduleDefinitionV2 = {
  name: "Loads",
  source: { kind: "classes", classes: ["mep.load_point"], includeSubclasses: true },
  columns: [
    { id: "mark", kind: "field", path: "mark" },
    { id: "status", kind: "field", path: "load.status" },
    { id: "dfu", kind: "field", path: "loads.counted.dfu", total: true },
    { id: "cfh", kind: "field", path: "loads.counted_gas_flow", total: true },
  ],
  filters: [],
  sort: [{ path: "mark", direction: "asc" }],
  groups: [],
  grandTotals: true,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

function model(): ModelState {
  let m: ModelState = { modelId: "loads", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_load", loads: [{ id: "load-FD-1", mark: "FD-1", values: { dfu: 5 } }, { id: "load-WC-1", mark: "WC-1", values: { wsfu_cold: 5, dfu: 5 } }, { id: "load-gas-GWH", mark: "GWH", service: "gas", values: { mbh: 199 } }] });
  return m;
}

describe("the model server opens native v2 lists with every field provider", () => {
  it("a Loads list view opens with its status and counted columns and a totals row", () => {
    const m = run(model(), { type: "create_view", viewId: "v-loads", name: "Loads", viewType: "schedule", props: { scheduleV2: LOADS } });
    const opened = kernelScheduleEvaluator().open(m, { viewId: "v-loads" });
    if (!opened.ok) throw new Error(opened.message);
    const rows = opened.instance.rows();
    expect(rows.rowCount).toBe(3);
    expect(rows.totals?.get("dfu")?.value).toBe(10);
    // 199 MBH at 1,000 Btu/cf is 199 CFH (canonical m³/s in the measure).
    expect((rows.totals?.get("cfh")?.value ?? 0) * 3600 / 0.028316846592).toBeCloseTo(199, 6);
  });

  it("an ad hoc Loads definition opens too", () => {
    const opened = kernelScheduleEvaluator().open(model(), { definition: Object.fromEntries(Object.entries(LOADS)) });
    expect(opened.ok).toBe(true);
  });

  it("a v1 schedule, saved as v1 or converted in place, keeps the v1 reading: FAMILY stays its column", () => {
    const v1 = { category: "plumbing_fixture" as const, columns: [{ field: "mark" }, { field: "family" }] };
    let m = run(model(), { type: "create_view", viewId: "v1", name: "Fixtures", viewType: "schedule", props: { schedule: v1 } });
    m = run(m, { type: "create_view", viewId: "v1-in-place", name: "Fixtures 2", viewType: "schedule", props: { scheduleV2: scheduleV1ToV2(v1) } });
    for (const viewId of ["v1", "v1-in-place"]) {
      const opened = kernelScheduleEvaluator().open(m, { viewId });
      if (!opened.ok) throw new Error(opened.message);
      expect(opened.instance.rows().columns.map((c) => c.heading)).toEqual(["MARK", "FAMILY"]);
    }
  });
});
