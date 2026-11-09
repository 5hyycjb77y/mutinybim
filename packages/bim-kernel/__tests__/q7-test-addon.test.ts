/**
 * @jest-environment node
 *
 * Round 7 lane Q, zero kernel edits: a test add-on brings its own class, its
 * own classification system (with codes, as a provider ships them) and a
 * measure rule for its class. With the add-on in force its elements measure
 * through its rule, its codes read with their words, a code its list doesn't
 * have is named (not dropped), and the takeoff groups by its codes. Nothing
 * in the kernel names the add-on.
 *
 * Fails on the old code: `CLASSIFICATION_POINT` and `MEASURE_RULE_POINT` had
 * no readers, so the add-on's rows reached nothing.
 */
import { CLASSIFICATION_POINT, classificationSystems, measuredValue, measureRuleFor, MEASURE_RULE_POINT, qtoGroupOf, readCode, takeoffTotals, asElementId, type BimElement, type MeasureRuleDef } from "../src";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { CLASS_POINT } from "../src/registry";
import { commit, modelOf } from "./q7-fixtures";

const WIDGET_RULE: MeasureRuleDef = {
  id: "zz.widget",
  label: "Widgets",
  classes: ["zz.widget"],
  measures: [
    { key: "qto.count", kind: "count", unit: "ea", from: "one per widget", primary: true },
    { key: "qto.area", kind: "area", unit: "m2", from: "its footprint × 2 sides", label: "Panel area" },
  ],
  measure: (el): Readonly<Record<string, number>> => (el.kind === "component" ? { "qto.count": 1, "qto.area": (2 * el.size.x * el.size.y) / 1e6 } : {}),
};

const ADDON = definePack({ id: "zz", name: "Test widgets", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(CLASS_POINT, [{ id: "zz.widget", label: "Widgets", discipline: "general", parent: "arch.component", recognize: { elementKinds: ["component"], where: [{ path: "category", op: "equals", value: "zz_widget" }] } }]),
  contribute(CLASSIFICATION_POINT, [{ id: "zz.codes", label: "Test widget codes", version: "2026", licenceNote: "Synthetic test codes, free to use.", codes: [{ code: "TEST-0300", label: "Test widgets" }] }]),
  contribute(MEASURE_RULE_POINT, [WIDGET_RULE]),
]);
const SET = PackSet.create([ADDON]);

function widget(id: string, x: number, y: number): BimElement {
  const record: unknown = { id: asElementId(id), kind: "component", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, category: "zz_widget", typeName: "Widget", position: { x: 0, y: 0 }, size: { x, y }, rotationDeg: 0 };
  return record as BimElement;
}

describe("q7 a test add-on's codes and measure rule, no kernel edit", () => {
  it("its system joins the firm's codes while it is in force", () => {
    expect(withPackSet(SET, () => classificationSystems().map((s) => s.id))).toEqual(["firm:cost_codes", "zz.codes"]);
    expect(classificationSystems().map((s) => s.id)).toEqual(["firm:cost_codes"]);
    expect(withPackSet(SET, () => readCode("zz.codes", "TEST-0300"))).toMatchObject({ status: "known", label: "Test widgets" });
    expect(withPackSet(SET, () => readCode("zz.codes", "TEST-0399"))).toMatchObject({ status: "unknown_code", warning: expect.stringMatching(/isn't in Test widget codes 2026/) });
    expect(readCode("zz.codes", "TEST-0300")).toMatchObject({ status: "unknown_system", warning: expect.stringMatching(/kept as it was saved/) });
  });

  it("its elements measure through its rule and group by its codes", () => {
    let m = modelOf([widget("g1", 1000, 500), widget("g2", 2000, 500)]);
    m = withPackSet(SET, () => commit(m, { type: "set_classification", elementIds: ["g1", "g2"], system: "zz.codes", code: "TEST-0300" }));
    withPackSet(SET, () => {
      const g1 = m.elements.g1;
      if (!g1) throw new Error("g1");
      expect(measureRuleFor(m.elements, g1)?.id).toBe("zz.widget");
      expect(measuredValue(m.elements, "g1", "qto.area")).toBeCloseTo(1, 6);
      expect(qtoGroupOf(m.elements, g1, "zz.codes")).toMatchObject({ kind: "classification", label: "TEST-0300 Test widgets" });
      const area = takeoffTotals(m.elements, { system: "zz.codes" }).find((t) => t.measure.key === "qto.area");
      expect(area).toMatchObject({ elementCount: 2, measure: { from: "its footprint × 2 sides" } });
      expect(area?.value).toBeCloseTo(3, 6);
    });
    // Without the add-on the same element is a generic component, measured by the kernel's rule.
    const g1 = m.elements.g1;
    if (!g1) throw new Error("g1");
    expect(measureRuleFor(m.elements, g1)?.id).toBe("kernel.component");
  });
});
