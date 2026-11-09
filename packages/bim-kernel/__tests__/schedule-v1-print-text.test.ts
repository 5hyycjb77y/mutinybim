/**
 * @jest-environment node
 *
 * A v1 schedule read as v2 prints its part parameters as v1 does
 * (`formatParam`): two decimals at most, and whole numbers from 100 up
 * (STATUS "known bugs": the v1 conversion edge for values of 100 or more).
 *
 * Before the fix the v2 read used the profile's per-kind precision, so an
 * MCA of 15.456 A printed "15.5 A" (v1: "15.46 A") and 150.456 A printed
 * "150.5 A" (v1: "150 A"). v1 sheets still print through `schedule.ts`.
 */
import { evaluateSchedule, evaluateScheduleV2, scheduleFields, SCHEDULE_CATEGORIES, type ModelState } from "../src";
import { buildRowSet, scheduleV1ToV2 } from "../src/schedules/engine";
import { referenceBuilding } from "./fixtures/electrical-building";

/** Every numeric part value moved off whole numbers (and, scaled, past 100). */
function withValues(map: (v: number) => number): ModelState {
  const m = referenceBuilding().head;
  const elements = Object.fromEntries(
    Object.entries(m.elements).map(([id, el]) => [id, el.kind === "part" ? { ...el, values: Object.fromEntries(Object.entries(el.values).map(([k, v]) => [k, typeof v === "number" ? map(v) : v])) } : el]),
  );
  return { ...m, elements };
}

/** v1 text vs v2 text, cell by cell, for every category with every field. */
function differences(model: ModelState): string[] {
  const out: string[] = [];
  for (const category of SCHEDULE_CATEGORIES) {
    const fields = scheduleFields(model, category);
    const def = { category, columns: fields.map((f) => ({ field: f.key })) };
    const v1 = evaluateSchedule(model, def);
    const v2def = scheduleV1ToV2(def);
    const v2 = evaluateScheduleV2(buildRowSet(model, v2def, { viewId: "v", revision: 1 }), v2def);
    v1.rows.forEach((row, i) =>
      row.forEach((text, j) => {
        const field = fields[j]?.key ?? "";
        // Part types in this fixture disagree on voltage's unit, so v2 reads it as text (fields.ts), a separate difference.
        if (field === "voltage") return;
        const printed = v2.rows[i]?.[j] ?? "<missing>";
        if (printed !== text) out.push(`${category}.${field}: v1 ${JSON.stringify(text)}, v2 ${JSON.stringify(printed)}`);
      }),
    );
  }
  return out;
}

describe("v1 part parameters read as v2 print as v1 printed them", () => {
  it("below 100: two decimals at most (15.456 A prints 15.46 A)", () => {
    const model = withValues((v) => v + 0.456);
    expect(differences(model)).toEqual([]);
    const v1 = evaluateSchedule(model, { category: "mechanical_equipment", columns: [{ field: "mca" }] });
    expect(v1.rows.some((r) => /^\d+\.\d\d A$/.test(r[0] ?? ""))).toBe(true);
  });

  it("from 100 up: whole numbers (150.456 A prints 150 A)", () => {
    const model = withValues((v) => v * 10 + 0.456);
    expect(differences(model)).toEqual([]);
    const v1 = evaluateSchedule(model, { category: "mechanical_equipment", columns: [{ field: "mca" }] });
    expect(v1.rows.some((r) => /^\d{3,} A$/.test(r[0] ?? ""))).toBe(true);
  });
});
