/**
 * @jest-environment node
 *
 * v1 schedules read into the v2 engine unchanged (SCHEDULES-PLAN §5a): for
 * every v1 category, with every field it offers, the v2 rows are the same
 * elements in the same order as the v1 table prints, text columns print the
 * same text, and numeric columns carry the same number (now typed, in SI).
 * v1 sheets themselves still print through `schedule.ts` (golden tests in
 * sheet-truth and drawing-set stay byte-identical).
 *
 * Before Stream E there was no v2 engine or `scheduleV1ToV2`, so this failed
 * on import.
 */
import { fromSI } from "@permitzip/bim-units";
import { builtinFormTemplate, commandSchema, drawScheduleView, evaluateSchedule, executeCommand, scheduleFields, scheduleV2Form, scheduleViewSize, SCHEDULE_CATEGORIES, type FormScheduleDefinition, type ModelState, type Primitive, type ScheduleDefinition } from "../src";
import { buildRowSet, formScheduleToV2, scheduleV1ToV2, type RowSet } from "../src/schedules/engine";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { referenceBuilding, referenceDistribution } from "./fixtures/electrical-building";
import { threeStoreyStack } from "./fixtures/three-storey-stack";

function withStack(): ModelState {
  let m = createDemoModel();
  for (const c of threeStoreyStack().setup) {
    const r = executeCommand(m, commandSchema.parse(c));
    if (!r.ok) throw new Error(r.error.message);
    m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
  }
  return m;
}

function electrical(): ModelState {
  return referenceDistribution().head;
}

function cell(rows: RowSet, column: string, i: number): number | string | boolean | null {
  const col = rows.values.get(column);
  if (!col) throw new Error(`no column ${column}`);
  if (col.type === "quantity") {
    const v = col.values[i] ?? Number.NaN;
    return Number.isNaN(v) ? null : v;
  }
  if (col.type === "boolean") return col.values[i] === -1 ? null : col.values[i] === 1;
  return col.values[i] ?? null;
}

function expectParity(model: ModelState, def: ScheduleDefinition): number {
  const v1 = evaluateSchedule(model, def);
  const v2 = buildRowSet(model, scheduleV1ToV2(def), { viewId: "v", revision: 1 });
  expect(v2.rowCount).toBe(v1.rows.length);
  expect(v2.rowElementIds ?? v2.elementIds.map((id) => [id])).toEqual(v1.elementIds);
  v2.columns.forEach((col, j) => {
    for (let i = 0; i < v2.rowCount; i++) {
      const printed = v1.rows[i]?.[j] ?? "";
      const value = cell(v2, col.id, i);
      if (col.valueType === "quantity") {
        if (printed === "") continue;
        expect(value).not.toBeNull();
        if (col.id === "count" || /^-?\d+(\.\d+)?$/.test(printed)) {
          const n = col.unit && typeof value === "number" ? fromSI(value, col.unit) : value;
          expect(Number(n)).toBeCloseTo(Number(printed), Math.max(0, (printed.split(".")[1]?.length ?? 0) - 1));
        }
      } else if (col.valueType === "boolean") {
        expect(value === null ? "" : value ? "Yes" : "No").toBe(printed);
      } else {
        expect(value ?? "").toBe(printed);
      }
    }
  });
  return v1.rows.length;
}

describe("v1 schedules read into the v2 engine", () => {
  const models: readonly [string, () => ModelState][] = [
    ["demo", createDemoModel],
    ["plumbing stack", withStack],
    ["electrical building", electrical],
  ];

  it.each(models)("every category and field matches on the %s model", (_name, make) => {
    const model = make();
    let rows = 0;
    for (const category of SCHEDULE_CATEGORIES) {
      const fields = scheduleFields(model, category);
      rows += expectParity(model, { category, columns: fields.map((f) => ({ field: f.key })) });
    }
    expect(rows).toBeGreaterThan(0);
  });

  it("matches with itemize off, filters, a level and a descending sort", () => {
    const m = createDemoModel();
    expectParity(m, { category: "air_terminal", columns: [{ field: "type" }], itemize: false });
    expectParity(m, { category: "air_terminal", columns: [{ field: "mark" }, { field: "type" }, { field: "cfm" }], filters: [{ field: "cfm", op: "greater_than", value: "150" }] });
    expectParity(m, { category: "air_terminal", columns: [{ field: "mark" }, { field: "cfm" }], sort: [{ field: "cfm", descending: true }] });
    expectParity(m, { category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "level" }], level: "L1" });
  });

  it("the pipe category (#2711) lists routed pipe with its size and material", () => {
    const m = withStack();
    const n = expectParity(m, { category: "pipe", columns: [{ field: "system" }, { field: "size" }, { field: "material" }, { field: "length" }] });
    expect(n).toBeGreaterThan(0);
  });

  it("a form schedule read as v2 is a form presentation that draws the same primitives as the v1 form", () => {
    const m = referenceBuilding().head;
    const forms: FormScheduleDefinition[] = [
      { kind: "panel", elementId: "l1", template: builtinFormTemplate("panel") },
      { kind: "switchboard", elementId: "mdp", template: builtinFormTemplate("switchboard"), textSizeMm: 2.2 },
      ...(["feeder", "connection_types", "equipment_connections", "gas_equipment", "gas_connections"] as const).map((kind) => ({ kind, template: builtinFormTemplate(kind), emptyText: "" })),
    ];
    for (const form of forms) {
      const v2 = formScheduleToV2(form);
      expect(v2.presentation).toEqual({ kind: "form", template: form.kind, form });
      const before: Primitive[] = [];
      drawScheduleView(before, m, { formSchedule: form }, { x: 10, y: 20 });
      const after: Primitive[] = [];
      drawScheduleView(after, m, { scheduleV2: v2 }, { x: 10, y: 20 });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(scheduleViewSize(m, { scheduleV2: v2 })).toEqual(scheduleViewSize(m, { formSchedule: form }));
      expect(before.length).toBeGreaterThan(0);
    }
    // Naming a built-in form kind without a stored copy prints the built-in template.
    const named = { ...formScheduleToV2(forms[0] as FormScheduleDefinition), source: { kind: "related" as const, from: "l1", relationship: "source_of" }, presentation: { kind: "form" as const, template: "panel" } };
    expect(scheduleV2Form(named)).toMatchObject({ kind: "panel", elementId: "l1", template: builtinFormTemplate("panel") });
  });

  it("keeps the v1 title, text size and empty text", () => {
    const v2 = scheduleV1ToV2({ category: "sheet_list", columns: [{ field: "number" }, { field: "number" }], emptyText: "" });
    expect(v2).toMatchObject({ name: "Sheet list", sort: [{ path: "number", direction: "asc" }], display: { textSizeMm: 2.5, emptyText: "" }, source: { classes: ["doc.sheet"] } });
    expect(v2.columns.map((c) => c.id)).toEqual(["number", "number_2"]);
  });
});
