/**
 * @jest-environment node
 *
 * Rectangular risers and 45° slopes in 3D. Before, a riser was an unrotated
 * box (its width along plan X whatever its elbows did) and a slope was a level
 * box at its mid-height, so both sat off the fittings they join.
 */
import { DEFAULT_SETTINGS, planCommit, segmentRings, type Command, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { elementSolids } from "../src/native-geometry";

const FT = 304.8;
const IN = 25.4;
const MM = 0.001;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `s-${model.revision}-key`, baseRevision: model.revision, actor: { id: "s", name: "S", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function routed(points: Array<{ x: number; y: number; elevationMm?: number }>, riseStyle?: "45"): ModelState {
  let m: ModelState = { modelId: "v", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return commit(m, { type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 24 * IN, height: 12 * IN }, elevationMm: 10 * FT, system: { id: "sa", kind: "supply_air" }, points, ...(riseStyle ? { riseStyle } : {}) });
}

function extent(positions: Float32Array, axis: 0 | 1 | 2): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < positions.length; i += 3) {
    const v = positions[i] ?? 0;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo;
}

describe("risers and slopes in 3D", () => {
  it("a riser off an east-west leg is 12\" east-west and 24\" north-south, like its elbows", () => {
    const m = routed([{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 20 * FT, y: 0 }]);
    const riser = m.elements["r-s2"] as RunSegment;
    const [solid, ...rest] = elementSolids(riser, undefined, m);
    expect(rest).toEqual([]);
    expect(solid?.shape).toBe("mesh");
    const positions = solid?.mesh?.positions ?? new Float32Array();
    // Scene x = plan east, scene z = plan south.
    expect(extent(positions, 0)).toBeCloseTo(12 * IN * MM, 4);
    expect(extent(positions, 2)).toBeCloseTo(24 * IN * MM, 4);
    // Height: the straight piece between the two elbow faces.
    const rings = segmentRings(m.elements, riser);
    expect(extent(positions, 1)).toBeCloseTo((rings.end.center.z - rings.start.center.z) * MM, 4);
  });

  it("a riser off a 45° leg is turned 45° in plan", () => {
    const m = routed([{ x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT, elevationMm: 14 * FT }, { x: 20 * FT, y: 20 * FT }]);
    const positions = elementSolids(m.elements["r-s2"] as RunSegment, undefined, m)[0]?.mesh?.positions ?? new Float32Array();
    // A 24x12 rectangle at 45°: (24 + 12) / √2 across on each plan axis.
    expect(extent(positions, 0)).toBeCloseTo(((36 * IN) / Math.SQRT2) * MM, 4);
    expect(extent(positions, 2)).toBeCloseTo(((36 * IN) / Math.SQRT2) * MM, 4);
  });

  it("a 45° slope is tilted, not a level box at its mid-height", () => {
    const m = routed([{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 20 * FT, y: 0 }], "45");
    const slope = m.elements["r-s2"] as RunSegment;
    const [solid] = elementSolids(slope, undefined, m);
    expect(solid?.shape).toBe("mesh");
    const rings = segmentRings(m.elements, slope);
    const rise = rings.end.center.z - rings.start.center.z;
    expect(rise).toBeGreaterThan(2 * FT);
    // The straight piece's rise, plus the 12" height tilted 45°: 12"/√2 more.
    expect(extent(solid?.mesh?.positions ?? new Float32Array(), 1)).toBeCloseTo((rise + (12 * IN) / Math.SQRT2) * MM, 4);
  });
});
