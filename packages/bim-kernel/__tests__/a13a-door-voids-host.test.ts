/**
 * @jest-environment node
 *
 * Round 13 lane A13a: host voids. A door cuts its wall: `voidsOf` lists the
 * void (in the wall's own along / up coordinates), the wall's body is built
 * around it (full height either side, a lintel over the head), the plan
 * breaks both faces at the door with a jamb line each side, and the wall's
 * net face area drops by exactly the door's area. A window keeps the body
 * under its sill and isn't a gap below the cut height.
 *
 * Fails on round 12's code: `voidsOf` refused ("Doors and windows cutting
 * their wall aren't built yet"), the wall stayed one solid box and one
 * outline, and there was no `create_hosted`.
 */
import { asElementId, type ModelState } from "../src";
import { elementSolid } from "../src/drawing/solids";
import { voidsOf } from "../src/hosting/void-point";
import { lineJoinPlanGraphics } from "../src/joins/plan";
import { measuredValue } from "../src/qto/measure";
import type { PlanGraphic, PlanGraphicsContext } from "../src/registry/kind-row-faces";
import { element, twoLevels } from "./a13a-fixtures";

const W = asElementId("w");

function wallModel() {
  const m = twoLevels();
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  return m;
}

function ctx(m: ModelState): PlanGraphicsContext {
  return { elements: m.elements, scale: 100, levelId: "L1", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null };
}

const zRange = (m: ModelState) =>
  (elementSolid(m, element(m, W), 0)?.pieces ?? []).map((p) => [Math.min(...p.r0.map((q) => q.x)), Math.max(...p.r0.map((q) => q.x)), p.r0[0]?.z, p.r1[0]?.z]);

describe("a13a door voids host", () => {
  it("a door cuts its wall's body, breaks its plan and drops its net area by the door's area", () => {
    const m = wallModel();
    const grossNet = measuredValue(m.head.elements, W, "qto.area_net");
    expect(grossNet).toBeCloseTo(18, 6);
    expect(zRange(m.head)).toEqual([[0, 6000, 0, 3000]]);
    expect(voidsOf(m.head, W)).toEqual([]);

    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", mark: "101", hostId: "w", s: 1500, side: 1, size: { widthMm: 900, heightMm: 2100 } });
    expect(voidsOf(m.head, W)).toEqual([{ elementId: "d", hostId: "w", role: "fill", profile: [{ x: 1050, y: 0 }, { x: 1950, y: 0 }, { x: 1950, y: 2100 }, { x: 1050, y: 2100 }] }]);
    expect(zRange(m.head)).toEqual([
      [0, 1050, 0, 3000],
      [1050, 1950, 2100, 3000],
      [1950, 6000, 0, 3000],
    ]);
    expect(measuredValue(m.head.elements, W, "qto.area_net")).toBeCloseTo(18 - 0.9 * 2.1, 6);

    const lines = (lineJoinPlanGraphics(element(m.head, W), ctx(m.head)) ?? []).filter((g): g is Extract<PlanGraphic, { form: "line" }> => g.form === "line");
    const along = lines.filter((l) => l.a.y === l.b.y).map((l) => [l.a.x, l.b.x, l.a.y]);
    expect(along).toEqual([
      [0, 1050, 100],
      [1950, 6000, 100],
      [0, 1050, -100],
      [1950, 6000, -100],
    ]);
    // Jambs at 1050 and 1950, and the two free ends.
    expect(lines.filter((l) => l.a.x === l.b.x).map((l) => l.a.x)).toEqual([1050, 1950, 0, 6000]);
  });

  it("a window keeps the wall under its sill and above its head, and is no plan gap below the cut", () => {
    const m = wallModel();
    m.ok({ type: "create_hosted", elementId: "win", kind: "opening", openingType: "window", hostId: "w", s: 3000, side: 1, size: { widthMm: 1200, heightMm: 1200 }, values: { "opening.sill_mm": 900 } });
    expect(zRange(m.head)).toEqual([
      [0, 2400, 0, 3000],
      [2400, 3600, 0, 900],
      [2400, 3600, 2100, 3000],
      [3600, 6000, 0, 3000],
    ]);
    expect(measuredValue(m.head.elements, W, "qto.area_net")).toBeCloseTo(18 - 1.44, 6);
    m.ok({ type: "set_element_values", elementIds: ["win"], values: { "opening.sill_mm": 1500 } });
    // Above the cut: no gap, nothing joined, so the plan draws the wall as it always has.
    expect(lineJoinPlanGraphics(element(m.head, W), ctx(m.head))).toBeNull();
  });

  it("undo of the door puts the wall back whole", () => {
    const m = wallModel();
    const cs = m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w", s: 1500, side: 1, size: { widthMm: 900 } });
    m.ok({ type: "undo", revision: cs.revision });
    expect(voidsOf(m.head, W)).toEqual([]);
    expect(zRange(m.head)).toEqual([[0, 6000, 0, 3000]]);
    expect(voidsOf(m.head, asElementId("nope"))).toEqual({ refused: "There is no element nope in this model" });
  });
});
