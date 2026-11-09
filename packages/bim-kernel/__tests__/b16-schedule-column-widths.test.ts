/**
 * @jest-environment node
 *
 * Batch 16-B (review video, Nov 6, item 36: "should be able to adjust the
 * size of these columns"): a schedule's column edges are found where it sits
 * on a sheet, and dragging one saves the column's paper width in the
 * schedule with one `edit_schedule` step, so every sheet and print follows.
 *
 * Fails on the code before batch 16-B: there was no `resize_column` step (the
 * strict step schema refused it), no way to read a placed schedule's column
 * edges, and the builder's Save could not express a width change as a step.
 */
import {
  DEFAULT_SETTINGS,
  SCHEDULE_COLUMN_MAX_MM,
  SCHEDULE_COLUMN_MIN_MM,
  clampScheduleColumnWidth,
  commandSchema,
  executeCommand,
  scheduleViewColumns,
  withUpgradePolicy,
  type ModelState,
  type ScheduleDefinitionV2,
} from "../src";
import { scheduleStepsBetween } from "../src/schedules/engine";

function run(model: ModelState, command: Record<string, unknown> & { type: string }, peersRead = true): ModelState | string {
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "unparsed";
  const r = withUpgradePolicy(
    () => peersRead,
    () => executeCommand(model, parsed.data),
  );
  if (!r.ok) return r.error.message;
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function must(m: ModelState | string): ModelState {
  if (typeof m === "string") throw new Error(m);
  return m;
}

const V2: ScheduleDefinitionV2 = {
  name: "Rooms",
  source: { kind: "classes", classes: ["arch.room"], includeSubclasses: true },
  columns: [
    { id: "number", kind: "field", path: "mark" },
    { id: "name", kind: "field", path: "type", heading: "NAME" },
  ],
  filters: [],
  sort: [],
  groups: [],
  grandTotals: false,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

function model(): ModelState {
  const empty: ModelState = { modelId: "b16-cols", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return must(run(empty, { type: "create_view", viewId: "v-rooms", name: "Rooms", viewType: "schedule", props: { scheduleV2: V2 } }));
}

function propsOf(m: ModelState) {
  const v = m.elements["v-rooms"];
  if (v?.kind !== "view") throw new Error("no schedule view");
  return v.props;
}

describe("batch 16-B: schedule column widths dragged on the sheet", () => {
  it("lists each printed column's edges from the table's left, and which column it is", () => {
    const cols = scheduleViewColumns(model(), propsOf(model()));
    expect(cols?.map((c) => c.columnId)).toEqual(["number", "name"]);
    const [a, b] = cols ?? [];
    expect(a?.x0).toBe(0);
    expect(b?.x0).toBeCloseTo(a?.x1 ?? -1, 6);
  });

  it("a resize step saves the column's paper width, the printed column takes it, and null sizes it to its text again", () => {
    const resized = must(run(model(), { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "name", widthMm: 60 }] }));
    expect(propsOf(resized)?.scheduleV2?.columns.find((c) => c.id === "name")?.widthMm).toBe(60);
    const name = scheduleViewColumns(resized, propsOf(resized))?.find((c) => c.columnId === "name");
    expect((name?.x1 ?? 0) - (name?.x0 ?? 0)).toBeCloseTo(60, 6);
    const back = must(run(resized, { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "name", widthMm: null }] }));
    expect(propsOf(back)?.scheduleV2?.columns.find((c) => c.id === "name")?.widthMm).toBeUndefined();
  });

  it("an old list schedule is resized by its column's id, and is stored as v2 by that edit", () => {
    const empty: ModelState = { modelId: "b16-cols-v1", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const v1 = must(run(empty, { type: "create_view", viewId: "v-rooms", name: "Rooms", viewType: "schedule", props: { schedule: { category: "air_terminal", columns: [{ field: "mark" }, { field: "mark" }] } } }));
    expect(scheduleViewColumns(v1, propsOf(v1))?.map((c) => c.columnId)).toEqual(["mark", "mark_2"]);
    const resized = must(run(v1, { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "mark_2", widthMm: 30 }] }));
    expect(propsOf(resized)?.scheduleV2?.columns.find((c) => c.id === "mark_2")?.widthMm).toBe(30);
  });

  it("refuses in words: an unknown column, a width too small to print, and an older model server", () => {
    expect(run(model(), { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "nope", widthMm: 30 }] })).toMatch(/no column "nope"/);
    expect(typeof run(model(), { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "name", widthMm: 1 }] })).toBe("string");
    expect(run(model(), { type: "edit_schedule", viewId: "v-rooms", steps: [{ op: "resize_column", columnId: "name", widthMm: 40 }] }, false)).toMatch(/older version/);
  });

  it("a drag is kept within what prints, to a tenth of a millimetre", () => {
    expect(clampScheduleColumnWidth(2)).toBe(SCHEDULE_COLUMN_MIN_MM);
    expect(clampScheduleColumnWidth(10_000)).toBe(SCHEDULE_COLUMN_MAX_MM);
    expect(clampScheduleColumnWidth(25.437)).toBe(25.4);
  });

  it("the builder's Save sends a width change as a resize step, not a whole new schedule", () => {
    const after: ScheduleDefinitionV2 = { ...V2, columns: V2.columns.map((c) => (c.id === "number" ? { ...c, widthMm: 20 } : c)) };
    expect(scheduleStepsBetween(V2, after)).toEqual([{ op: "resize_column", columnId: "number", widthMm: 20 }]);
  });
});
