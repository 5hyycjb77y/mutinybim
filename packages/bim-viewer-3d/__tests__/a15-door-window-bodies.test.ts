/**
 * @jest-environment node
 *
 * Round 15 lane A15 (A0): doors and windows have bodies. The review screenshot
 * (Nov 4): a door placed in a wall left an empty hole in 3D. The wall was
 * cut (fb1104) but nothing filled it: `native-geometry.ts` had no case for
 * an opening and no source gave one a body.
 *
 * Now the Architecture add-on contributes `kernel.class_solids` rows: a door
 * is a frame (two jambs and a head) and a closed leaf flush with the face it
 * opens to (two leaves for a double door); a window is a sill, a frame and
 * see-through glass. Both sit exactly in the void the kernel cuts, as deep
 * as the wall or the type's frame depth. The 3D viewer draws class bodies
 * for any kind; sections and elevations cut the same body (`elementSolid`).
 *
 * Fails on round 14's code: `elementSolids` returns [] for the opening and
 * `elementSolid` returns null (no class solids point existed).
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { planGapsOf, type ModelState, type Wall } from "@permitzip/bim-kernel";
import { twoLevels, type Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { elementSolid } from "../../bim-kernel/src/drawing/solids";
import { MM } from "../src/coords";
import { changedElements, elementSolids, type Solid } from "../src/native-geometry";

installFirstPartyAddOns();

interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function solidsOf(m: Log, id: string): Solid[] {
  const el = m.head.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return elementSolids(el, undefined, m.head as ModelState);
}

/** Mesh corners in kernel plan mm and elevation mm. */
function corners(s: Solid): P3[] {
  const out: P3[] = [];
  const p = s.mesh?.positions ?? new Float32Array();
  for (let i = 0; i < p.length; i += 3) out.push({ x: Math.round(((p[i] ?? 0) + s.center[0]) / MM), y: Math.round(-((p[i + 2] ?? 0) + s.center[2]) / MM), z: Math.round(((p[i + 1] ?? 0) + s.center[1]) / MM) });
  return out;
}

function bounds(points: readonly P3[]): { min: P3; max: P3 } {
  const min = { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)), z: Math.min(...points.map((p) => p.z)) };
  const max = { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)), z: Math.max(...points.map((p) => p.z)) };
  return { min, max };
}

function wallWith(openingType: "door" | "window", extra: Record<string, unknown> = {}): Log {
  const m = twoLevels("a15");
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  const size = openingType === "door" ? { widthMm: 900, heightMm: 2100 } : { widthMm: 1200, heightMm: 1200 };
  m.ok({ type: "create_hosted", elementId: "o", kind: "opening", openingType, mark: "101", hostId: "w", s: 3000, side: 1, size, ...extra });
  return m;
}

describe("a15-door-window-bodies", () => {
  it("a door draws a frame and a closed leaf that fill the hole the wall leaves", () => {
    const solids = solidsOf(wallWith("door"), "o");
    expect(solids.map((s) => s.group).sort()).toEqual(["filler"]);
    const pts = corners(solids[0] as Solid);
    // Exactly the void: 900 wide about 3000, floor to 2100, as deep as the 200 wall.
    expect(bounds(pts)).toEqual({ min: { x: 2550, y: -100, z: 0 }, max: { x: 3450, y: 100, z: 2100 } });
    // Jamb inner faces, the head's underside and the leaf's 45 mm on the face it opens to (+y).
    expect(pts.some((p) => p.x === 2600 && p.z === 2050)).toBe(true);
    expect(pts.some((p) => p.y === 55 && p.x === 2600 && p.z === 0)).toBe(true);
    // Four boxes (two jambs, head, leaf): six faces of four corners each.
    expect(pts.length).toBe(4 * 24);
  });

  it("a double door has two leaves; flipped, its leaf is on the other face", () => {
    const double = corners(solidsOf(wallWith("door", { values: { "architecture.door_operation": "DOUBLE_DOOR_SINGLE_SWING" } }), "o")[0] as Solid);
    expect(double.length).toBe(5 * 24);
    // The 3 mm gap between the leaves at the middle.
    expect(double.some((p) => Math.abs(p.x - 2998.5) <= 1)).toBe(true);
    expect(double.some((p) => Math.abs(p.x - 3001.5) <= 1)).toBe(true);
    expect(double.some((p) => p.x === 3000)).toBe(false);
    const flipped = corners(solidsOf(wallWith("door", { side: -1 }), "o")[0] as Solid);
    expect(flipped.some((p) => p.y === -55 && p.x === 2600)).toBe(true);
    expect(flipped.some((p) => p.y === 55)).toBe(false);
  });

  it("a window draws a sill, a frame and see-through glass at its sill height", () => {
    const solids = solidsOf(wallWith("window"), "o");
    expect(solids.map((s) => s.group).sort()).toEqual(["filler", "glazing"]);
    const frame = bounds(corners(solids.find((s) => s.group === "filler") as Solid));
    const glass = bounds(corners(solids.find((s) => s.group === "glazing") as Solid));
    // The sill stands proud of both faces; the glass is thin and inside the frame.
    expect(frame.min.y).toBe(-125);
    expect(frame.max.y).toBe(125);
    expect(glass.max.y - glass.min.y).toBe(6);
    expect(glass.min.x).toBe(2450);
    expect(glass.max.x).toBe(3550);
    expect(glass.min.z).toBeGreaterThan(frame.min.z);
    expect(glass.max.z).toBe(frame.max.z - 50);
  });

  it("the type's frame depth sets how deep the frame is", () => {
    const m = wallWith("door", { values: { "architecture.frame_depth": 120 } });
    const b = bounds(corners(solidsOf(m, "o")[0] as Solid));
    expect([b.min.y, b.max.y]).toEqual([-60, 60]);
  });

  it("sections and elevations cut the same body", () => {
    const m = wallWith("window");
    const el = m.head.elements.o;
    if (!el) throw new Error("no opening");
    const solid = elementSolid(m.head as ModelState, el, 0);
    expect(solid).toMatchObject({ owner: "o", category: "doors_windows", role: "architecture" });
    // Sill, two jambs, head, bottom rail, glass.
    expect(solid?.pieces.length).toBe(6);
  });

  it("a changed wall rebuilds the door it hosts", () => {
    const before = wallWith("door").head as ModelState;
    const wall = before.elements.w;
    const door = before.elements.o;
    if (wall?.kind !== "wall" || !door) throw new Error("no wall or door");
    const after: ModelState = { ...before, elements: { ...before.elements, w: { ...wall, thickness: 300, version: wall.version + 1 } } };
    const { changed } = changedElements(before, after);
    expect(changed).toEqual(["w", "o"]);
    const [body] = elementSolids(door, undefined, after);
    expect(bounds(corners(body as Solid)).max.y).toBe(150);
  });

  // The 0.2 / 0.5 ms per opening budget is Perf Gate (BIM) row
  // viewer.opening.body.build.250k (scripts/perf/mutinybim/a15-walls-openings.ts).
  // Here: the work each opening's build does.
  it("builds one body per opening, of a fixed number of pieces (viewer.opening.body.build)", () => {
    const m = twoLevels("a15-perf");
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      m.ok({ type: "create_element", elementId: `w${i}`, kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: i * 1000 }, end: { x: 12000, y: i * 1000 } } });
      for (let k = 0; k < 5; k++) {
        const id = `o${i}-${k}`;
        m.ok({ type: "create_hosted", elementId: id, kind: "opening", openingType: k % 2 === 0 ? "door" : "window", mark: id, hostId: `w${i}`, s: 1200 + k * 2200, side: 1, size: { widthMm: 900, heightMm: 2100 } });
        ids.push(id);
      }
    }
    const model = m.head as ModelState;
    const els = ids.map((id) => model.elements[id]).filter((e) => e !== undefined);
    expect(els).toHaveLength(200);
    // Per type: "<solids> solids, <triangles> triangles". One shape per type means no opening's build grows with the model.
    const workByType = new Map<string, Set<string>>();
    for (const el of els) {
      const bodies = elementSolids(el, undefined, model);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.every((b) => b.elementId === el.id)).toBe(true);
      const triangles = bodies.reduce((n, b) => n + (b.mesh ? b.mesh.indices.length / 3 : 0), 0);
      const type = el.kind === "opening" ? el.openingType : el.kind;
      workByType.set(type, (workByType.get(type) ?? new Set<string>()).add(`${bodies.length} solids, ${triangles} triangles`));
    }
    expect(Object.fromEntries([...workByType].map(([type, shapes]) => [type, [...shapes]]))).toEqual({ door: ["1 solids, 48 triangles"], window: ["2 solids, 72 triangles"] });
  });

  it("window and door 3D/section bodies follow a host wall's startOffsetMm (matching the wall boolean cutout)", () => {
    const m = twoLevels("a15-offset");
    // Clerestory wall raised 1200 mm above L1 (startOffsetMm = 1200)
    m.ok({
      type: "create_element",
      elementId: "w-clerestory",
      kind: "wall",
      levelId: "L1",
      baseOffsetMm: 1200,
      size: { thicknessMm: 200, heightMm: 2400 },
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    });
    m.ok({
      type: "create_hosted",
      elementId: "win-high",
      kind: "opening",
      openingType: "window",
      mark: "W-HI",
      hostId: "w-clerestory",
      s: 3000,
      side: 1,
      size: { widthMm: 1200, heightMm: 1200 },
    });

    // Wall boolean cutout sits at 1200 + 900 = 2100 .. 1200 + 2100 = 3300 mm.
    const wallPts = corners(solidsOf(m, "w-clerestory")[0] as Solid);
    expect(bounds(wallPts).min.z).toBe(1200);
    expect(bounds(wallPts).max.z).toBe(3600);
    expect(wallPts.some((p) => p.x === 2400 && p.z === 2100)).toBe(true);
    expect(wallPts.some((p) => p.x === 2400 && p.z === 3300)).toBe(true);

    // 3D window frame and glazing MUST align with the exact same Z span [2100, 3300]!
    const winSolids = solidsOf(m, "win-high");
    const frameBounds = bounds(corners(winSolids.find((s) => s.group === "filler") as Solid));
    const glassBounds = bounds(corners(winSolids.find((s) => s.group === "glazing") as Solid));
    expect(frameBounds.min.z).toBe(2100);
    expect(frameBounds.max.z).toBe(3300);
    expect(glassBounds.min.z).toBe(2190);
    expect(glassBounds.max.z).toBe(3250);

    // 2D section/elevation solid uses the same aligned Z span.
    const secSolid = elementSolid(m.head as ModelState, m.head.elements["win-high"]!, 0);
    const secZs = secSolid?.pieces.flatMap((p) => [...p.r0, ...p.r1].map((pt) => pt.z)) ?? [];
    expect(Math.min(...secZs)).toBe(2100);
    expect(Math.max(...secZs)).toBe(3300);

    // Plan cut at 1219 mm is below the 2100 mm sill, so it produces no plan gap.
    expect(planGapsOf(m.head.elements, "w-clerestory")).toEqual([]);

    // Door hosted in a wall raised 600 mm above L1 aligns at [600, 2700].
    m.ok({
      type: "create_element",
      elementId: "w-curb",
      kind: "wall",
      levelId: "L1",
      baseOffsetMm: 600,
      size: { thicknessMm: 200, heightMm: 3000 },
      placement: { kind: "line", start: { x: 0, y: 4000 }, end: { x: 6000, y: 4000 } },
    });
    m.ok({
      type: "create_hosted",
      elementId: "d-curb",
      kind: "opening",
      openingType: "door",
      mark: "D-HI",
      hostId: "w-curb",
      s: 3000,
      side: 1,
      size: { widthMm: 900, heightMm: 2100 },
    });
    const doorBounds = bounds(corners(solidsOf(m, "d-curb")[0] as Solid));
    expect(doorBounds.min.z).toBe(600);
    expect(doorBounds.max.z).toBe(2700);

    // Curtain wall raised 1200 mm above L1 sits at [1200, 4200].
    m.ok({
      type: "create_element",
      elementId: "w-curtain",
      kind: "wall",
      levelId: "L1",
      baseOffsetMm: 1200,
      size: { thicknessMm: 150, heightMm: 3000 },
      placement: { kind: "line", start: { x: 0, y: 8000 }, end: { x: 4800, y: 8000 } },
      values: { "architecture.wall_function": "CURTAIN" },
    });
    const curtainSolids = solidsOf(m, "w-curtain");
    const curtainFrame = bounds(corners(curtainSolids.find((s) => s.group === "filler") as Solid));
    expect(curtainFrame.min.z).toBe(1200);
    expect(curtainFrame.max.z).toBe(4200);
  });

  it("window follows a sloped host wall base (startOffsetMm != endOffsetMm) at its midpoint", () => {
    const m = twoLevels("a15-sloped");
    m.ok({
      type: "create_element",
      elementId: "w-slope",
      kind: "wall",
      levelId: "L1",
      size: { thicknessMm: 200, heightMm: 3000 },
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    });
    m.ok({
      type: "create_hosted",
      elementId: "win-slope",
      kind: "opening",
      openingType: "window",
      mark: "W-SL",
      hostId: "w-slope",
      s: 3000,
      side: 1,
      size: { widthMm: 1200, heightMm: 1200 },
    });
    const wall = m.head.elements["w-slope"] as Wall;
    const slopedModel: ModelState = {
      ...(m.head as ModelState),
      elements: {
        ...m.head.elements,
        "w-slope": {
          ...wall,
          placement: wall.placement?.kind === "line" ? { ...wall.placement, startOffsetMm: 0, endOffsetMm: 1000 } : wall.placement,
        },
      },
    };
    const winSolids = elementSolids(slopedModel.elements["win-slope"]!, undefined, slopedModel);
    const frameBounds = bounds(corners(winSolids.find((s) => s.group === "filler") as Solid));
    // Midpoint at s = 3000 on 6000 mm wall has base = 500 mm -> sill = 1400, head = 2600.
    expect(frameBounds.min.z).toBe(1400);
    expect(frameBounds.max.z).toBe(2600);
  });
});
