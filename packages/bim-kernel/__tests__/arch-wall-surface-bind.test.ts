/**
 * @jest-environment node
 *
 * A wall's top and base bound to surfaces (`kernel.surface_face`): the
 * underside of the structure above, a ceiling, a roof (sloped too), the top of
 * the floor under it. The height is derived from the faces in force and
 * follows them: a thicker floor above shortens a wall run to its underside, a
 * raised ceiling lengthens a partition run to it, a wall under a pitched roof
 * gets a sloped top. The kernel names no trade; the roof is the Architecture
 * add-on's row.
 *
 * Fails on the previous code: a placement had no top or base surface (the
 * schema refused one), nothing read a slab's underside or a ceiling for a
 * wall, a wall's body was always a flat box from its level, and there was no
 * command to change a floor's thickness.
 */
import { elementSolid } from "../src/drawing/solids";
import { followSurfaceEdits, resolveBoundBody, type BimElement, type ModelState } from "../src";
import { element, twoLevels, type Log } from "./a13a-fixtures";

const LINE = { kind: "line", start: { x: 1000, y: 1000 }, end: { x: 7000, y: 1000 } } as const;
const FLOOR = [
  { x: 0, y: 0 },
  { x: 10_000, y: 0 },
  { x: 10_000, y: 8000 },
  { x: 0, y: 8000 },
];

const wall = (m: Log, id: string) => {
  const w = element(m.head, id);
  if (w.kind !== "wall") throw new Error(`${id} is a ${w.kind}`);
  return w;
};

/** Level 1 at 0, Level 2 at 4 m with a 200 mm floor on it. */
function withFloorAbove(): Log {
  const m = twoLevels("surface-bind");
  m.ok({ type: "create_element", elementId: "f2", kind: "slab", levelId: "L2", placement: { kind: "area", outline: FLOOR }, size: { thicknessMm: 200 } });
  return m;
}

describe("arch wall top and base bound to surfaces", () => {
  it("a wall run to the structure above stops at Level 2 less the floor's thickness, and follows when the thickness changes", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure" } });
    expect(wall(m, "w").height).toBe(3800);
    expect(wall(m, "w").bodyProfile).toBeUndefined();
    const cs = m.ok({ type: "set_element_thickness", elementIds: ["f2"], thicknessMm: 350 });
    expect(wall(m, "w").height).toBe(3650);
    // The wall is part of the same change, so one undo puts both back.
    expect(JSON.stringify(cs)).toContain('"w"');
    m.ok({ type: "update_level", levelId: "L2", elevationMm: 4300 });
    expect(wall(m, "w").height).toBe(3950);
  });

  it("an offset from the underside is kept, and a wall with nothing over it is refused in words", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure", offsetMm: -100 } });
    expect(wall(m, "w").height).toBe(3700);
    const far = { kind: "line", start: { x: 20_000, y: 0 }, end: { x: 26_000, y: 0 } } as const;
    expect(m.refused({ type: "create_element", elementId: "w2", kind: "wall", levelId: "L1", placement: far, topSurface: { to: "structure" } })).toMatch(/There is no slab, deck or roof over Wall w2 at its start/);
  });

  it("an exterior wall drawn on the floor's edge (and ending on its corner) is under that floor", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "edge", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 10_000, y: 0 } }, topSurface: { to: "structure" } });
    expect(wall(m, "edge").height).toBe(3800);
  });

  it("a partition run to the ceiling follows the ceiling's height", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "L1", outline: FLOOR, heightMm: 2700 }] });
    m.ok({ type: "create_element", elementId: "p", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "ceiling" } });
    expect(wall(m, "p").height).toBe(2700);
    m.ok({ type: "edit_ceiling", ceilingId: "c1", heightMm: 3000 });
    expect(wall(m, "p").height).toBe(3000);
  });

  it("a wall under a sloped roof gets a sloped top, drawn sloped in 3D and sections", () => {
    const m = twoLevels("surface-bind-roof");
    // 3 in 12 rising north from its low edge at y = 0, its underside at Level 2.
    m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: FLOOR }, values: { "architecture.slope_rise": 0.25, "architecture.slope_direction_deg": 90 } });
    const northSouth = { kind: "line", start: { x: 1000, y: 1000 }, end: { x: 1000, y: 7000 } } as const;
    m.ok({ type: "create_element", elementId: "g", kind: "wall", levelId: "L1", placement: northSouth, topSurface: { to: "roof" } });
    const w = wall(m, "g");
    expect(w.bodyProfile).toEqual([
      { atMm: 0, baseMm: 0, topMm: 4250 },
      { atMm: 6000, baseMm: 0, topMm: 5750 },
    ]);
    expect(w.height).toBe(5750);
    const solid = elementSolid(m.head, w, 0);
    const tops = (solid?.pieces ?? []).flatMap((p) => p.r1.map((q) => Math.round(q.z)));
    expect(Math.min(...tops)).toBeLessThanOrEqual(4250);
    expect(Math.max(...tops)).toBeGreaterThanOrEqual(5750);
    // A wall running along the slope's level line stays flat.
    m.ok({ type: "create_element", elementId: "e", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "roof" } });
    expect(wall(m, "e").bodyProfile).toBeUndefined();
    expect(wall(m, "e").height).toBe(4250);
  });

  it("changing a roof re-sizes the walls under it (the edit hook reads any face row)", () => {
    const m = twoLevels("surface-bind-roof-edit");
    m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: FLOOR }, values: { "architecture.slope_rise": 0.25, "architecture.slope_direction_deg": 90 } });
    m.ok({ type: "create_element", elementId: "e", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "roof" } });
    const roof = element(m.head, "r");
    // A steeper pitch, as an add-on's own edit of its roof would write it.
    const steeper = { ...roof, slope: { directionDeg: 90, rise: 0.5 } } as unknown as BimElement;
    const working: Record<string, BimElement> = { ...m.head.elements, r: steeper };
    const touched = [roof.id];
    followSurfaceEdits(m.head, working, touched);
    expect(touched).toContain("e");
    const e = working.e;
    expect(e?.kind === "wall" ? e.height : NaN).toBe(4500);
  });

  it("a base on the floor under it: a raised floor lifts the base and shortens a wall up to Level 2", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topLevelId: "L2", baseSurface: { to: "floor" } });
    expect(wall(m, "w").height).toBe(4000);
    const p = wall(m, "w").placement;
    expect(p?.kind === "line" ? p.startOffsetMm : NaN).toBe(0);
  });

  it("a wall bound to one slab's face follows that slab only", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure", elementId: "f2" } });
    expect(wall(m, "w").height).toBe(3800);
    expect(m.refused({ type: "create_element", elementId: "x", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure", elementId: "L2" } })).toMatch(/L2 is a level; it has no top or underside to run to/);
  });

  it("set_element_placement binds and unbinds; a level and a surface together are refused", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, size: { heightMm: 2400 } });
    const p = wall(m, "w").placement;
    if (p?.kind !== "line") throw new Error("no line placement");
    m.ok({ type: "set_element_placement", elementId: "w", placement: { ...p, topSurface: { to: "structure" } } });
    expect(wall(m, "w").height).toBe(3800);
    expect(m.refused({ type: "set_element_placement", elementId: "w", placement: { ...p, topLevelId: "L2", topSurface: { to: "structure" } } })).toMatch(/up to a level or to a surface, not both/);
    expect(m.refused({ type: "set_element_placement", elementId: "w", placement: { ...p, topSurface: { to: "structure" } }, heightMm: 3000 })).toMatch(/leave the height out/);
    m.ok({ type: "set_element_placement", elementId: "w", placement: p, heightMm: 3000 });
    expect(wall(m, "w").height).toBe(3000);
    m.ok({ type: "set_element_thickness", elementIds: ["f2"], thicknessMm: 400 });
    expect(wall(m, "w").height).toBe(3000);
  });

  it("a model server that doesn't store surface bindings is sent the height it works out to", () => {
    const m = withFloorAbove();
    const oldPeer = (feature: string) => feature !== "walls:surface_binding";
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure" } }, oldPeer);
    const w = wall(m, "w");
    expect(w.height).toBe(3800);
    expect(w.placement?.kind === "line" ? w.placement.topSurface : "no placement").toBeUndefined();
  });

  it("resolveBoundBody names the faces it follows", () => {
    const m = withFloorAbove();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topSurface: { to: "structure" } });
    const body = resolveBoundBody(m.head as ModelState, wall(m, "w"));
    expect(body?.ok && body.sourceIds).toEqual(["f2"]);
  });
});
