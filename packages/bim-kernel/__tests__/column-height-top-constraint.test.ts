/**
 * @jest-environment node
 *
 * Verifies column vertical constraints (`size.heightMm`, `topLevelId`,
 * `topOffsetMm`, `baseOffsetMm`, `rotationDeg`) end-to-end across kernel
 * creation, level moves, 2D solids/sections, 2D multi-story floor plans,
 * annotations, picking, and QTO measurements.
 */
import {
  buildViewPickIndex,
  buildViewScene,
  columnVerticalSpan,
  DEFAULT_SETTINGS,
  executeCommand,
  measuredValue,
  pickAt,
  validateModel,
  withUpgradePolicy,
  type Column,
  type Command,
  type ModelState,
  type Revision,
  type ViewElement,
} from "../src";
import { elementSolid } from "../src/drawing/solids";

const FT = 304.8;
const IN = 25.4;

function run(model: ModelState, commands: readonly Command[]): ModelState {
  let cur = model;
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) throw new Error(`${command.type} failed: ${res.error.code} — ${res.error.message}`);
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

function baseModel(): ModelState {
  const empty: ModelState = { modelId: "col-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return withUpgradePolicy(
    () => true,
    () =>
      run(empty, [
        { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
        { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
        { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: Math.round(24 * FT) },
      ]),
  );
}

describe("column height and top-level constraints", () => {
  it("preserves explicit size.heightMm, topLevelId, topOffsetMm, baseOffsetMm, and rotationDeg on create_element", () => {
    const m = withUpgradePolicy(
      () => true,
      () =>
        run(baseModel(), [
          {
            type: "create_element",
            elementId: "col-fixed",
            levelId: "L1",
            kind: "column",
            placement: { kind: "point", position: { x: 0, y: 0 }, rotationDeg: 30 },
            size: { widthMm: 300, depthMm: 400, heightMm: 5000 },
            baseOffsetMm: 150,
            material: "steel",
          },
          {
            type: "create_element",
            elementId: "col-tied",
            levelId: "L1",
            kind: "column",
            placement: { kind: "point", position: { x: 4000, y: 0 } },
            size: { widthMm: 254, depthMm: 254 },
            topLevelId: "ROOF",
            topOffsetMm: -200,
            baseOffsetMm: 100,
          },
        ]),
    );

    expect(validateModel(m)).toEqual([]);

    const fixed = m.elements["col-fixed"] as Column;
    expect(fixed.height).toBe(5000);
    expect(fixed.material).toBe("steel");
    expect(fixed.placement).toMatchObject({ kind: "point", levelId: "L1", offsetMm: 150, rotationDeg: 30 });
    expect(columnVerticalSpan(m.elements, fixed, 0)).toEqual({ baseZMm: 150, topZMm: 5150, heightMm: 5000, topLevelId: null });

    const tied = m.elements["col-tied"] as Column;
    const expectedTiedH = Math.round(24 * FT) - 200 - 100;
    expect(tied.height).toBe(expectedTiedH);
    expect(tied.placement).toMatchObject({ kind: "point", levelId: "L1", offsetMm: 100, topLevelId: "ROOF", topOffsetMm: -200 });
    expect(columnVerticalSpan(m.elements, tied, 0)).toEqual({ baseZMm: 100, topZMm: Math.round(24 * FT) - 200, heightMm: expectedTiedH, topLevelId: "ROOF" });
  });

  it("refuses conflicting heightMm + topLevelId or topOffsetMm without topLevelId", () => {
    const m = baseModel();
    const both = executeCommand(m, {
      type: "create_element",
      elementId: "col-bad-1",
      levelId: "L1",
      kind: "column",
      placement: { kind: "point", position: { x: 0, y: 0 } },
      size: { widthMm: 300, depthMm: 300, heightMm: 3000 },
      topLevelId: "L2",
    });
    expect(both.ok).toBe(false);

    const orphanOffset = executeCommand(m, {
      type: "create_element",
      elementId: "col-bad-2",
      levelId: "L1",
      kind: "column",
      placement: { kind: "point", position: { x: 0, y: 0 } },
      size: { widthMm: 300, depthMm: 300 },
      topOffsetMm: -200,
    });
    expect(orphanOffset.ok).toBe(false);
  });

  it("re-evaluates level-tied column height when the top level moves, leaving fixed-height columns unchanged", () => {
    let m = withUpgradePolicy(
      () => true,
      () =>
        run(baseModel(), [
          { type: "create_element", elementId: "col-fixed", levelId: "L1", kind: "column", placement: { kind: "point", position: { x: 0, y: 0 } }, size: { widthMm: 300, depthMm: 300, heightMm: 4500 } },
          { type: "create_element", elementId: "col-tied", levelId: "L1", kind: "column", placement: { kind: "point", position: { x: 3000, y: 0 } }, size: { widthMm: 300, depthMm: 300 }, topLevelId: "L2", topOffsetMm: -Math.round(8 * IN) },
        ]),
    );

    const oldL2 = Math.round(12 * FT);
    const newL2 = Math.round(14 * FT);
    expect((m.elements["col-tied"] as Column).height).toBe(oldL2 - Math.round(8 * IN));

    m = withUpgradePolicy(
      () => true,
      () => run(m, [{ type: "update_level", levelId: "L2", elevationMm: newL2 }]),
    );

    expect((m.elements["col-fixed"] as Column).height).toBe(4500);
    expect((m.elements["col-tied"] as Column).height).toBe(newL2 - Math.round(8 * IN));
    expect(measuredValue(m.elements, "col-tied", "qto.length")).toBeCloseTo((newL2 - Math.round(8 * IN)) / 1000, 4);
    expect(measuredValue(m.elements, "col-fixed", "qto.length")).toBeCloseTo(4.5, 4);
    expect(measuredValue(m.elements, "col-fixed", "qto.volume")).toBeCloseTo(0.3 * 0.3 * 4.5, 5);
  });

  it("produces exact 2D section solids and renders multi-story columns on intermediate floor plans", () => {
    const m = withUpgradePolicy(
      () => true,
      () =>
        run(baseModel(), [
          { type: "create_element", elementId: "col-2story", levelId: "L1", kind: "column", placement: { kind: "point", position: { x: 2000, y: 2000 }, rotationDeg: 45 }, size: { widthMm: 400, depthMm: 400 }, topLevelId: "ROOF", topOffsetMm: -200 },
          { type: "create_view", viewId: "view-l2", name: "L2 Plan", viewType: "floor_plan", crop: { min: { x: -1000, y: -1000 }, max: { x: 6000, y: 6000 } }, props: { level: "Level 2", scale: 50 } },
        ]),
    );

    const s = elementSolid(m, m.elements["col-2story"]!, 0);
    expect(s).not.toBeNull();
    const zs = s?.pieces.flatMap((p) => [...p.r0, ...p.r1].map((pt) => pt.z)) ?? [];
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(Math.round(24 * FT) - 200);

    // L2 plan should include the continuous L1→ROOF column cutting through L2 (4 rotated outline edges) AND make it pickable.
    const { scene } = buildViewScene(m, "view-l2");
    const lines = scene.primitives.filter((p) => p.kind === "line");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const pickIdx = buildViewPickIndex(m, m.elements["view-l2"] as ViewElement);
    expect(pickAt(pickIdx, { x: 2000, y: 2000 }, 50)).toContain("col-2story");
  });

  it("does not truncate an untied column with negative baseOffsetMm at its own level", () => {
    const m = withUpgradePolicy(
      () => true,
      () =>
        run(baseModel(), [
          { type: "create_element", elementId: "col-neg", levelId: "L1", kind: "column", placement: { kind: "point", position: { x: 1000, y: 1000 } }, baseOffsetMm: -500, size: { widthMm: 300, depthMm: 300 } },
        ]),
    );
    const span = columnVerticalSpan(m.elements, m.elements["col-neg"] as Column, 0);
    expect(span.baseZMm).toBe(-500);
    expect(span.topZMm).toBe(Math.round(12 * FT));
    expect(span.heightMm).toBe(Math.round(12 * FT) + 500);
  });
});
