/**
 * @jest-environment node
 *
 * Batch 16-D (Nov 6 review video rows 28, 32, 34, 58): the architect's linked
 * model is geometry, not a picture. Its walls are a snap source (faces, centre
 * line, ends, corners) read by plan cell and height; rooms are found from
 * linked walls as well as ours; a dimension follows a linked wall by its
 * GlobalId and says so when the wall has gone; outside walls and their windows
 * are read as envelope facts for a space.
 *
 * Fails on the old code: there was no reference geometry at all (linked
 * models only drew linework), Find rooms from walls read our own walls only
 * (a building drawn only in the link proposed nothing), and a dimension could
 * reference only elements of our model.
 */
import {
  asElementId,
  buildLinkedReferenceIndex,
  detectRoomsFromWalls,
  dimensionPoints,
  lineLikeOf,
  linkedAnchorPoint,
  linkedBoundarySegments,
  linkedElementKey,
  linkedEnvelopeAt,
  linkedReferenceItem,
  linkedReferenceRulesOf,
  linkedReferenceStats,
  linkedSnapCandidates,
  nounOfIfcEntity,
  parseLinkedElementKey,
  publishLinkedReferenceIndex,
  resolveLinkedAnchor,
  spaceEnvelopeOf,
  withdrawLinkedReferenceSources,
  LINKED_WALL_ROOM_DETECTOR_ID,
  type AnchorRef,
  type DrawingItem,
  type Vec2,
} from "../src";
import { ANNOTATION_LINKED_ANCHORS_FEATURE, commandSchema, executeCommand, withUpgradePolicy, type ModelState } from "../src";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { L1, modelWith, wall } from "./a13b-fixtures";
import { LINK_ID, STOREY_TOP, TEST_ROWS, TEST_RULES, WALL_T, linkedWall, manyWalls, sampleWarehouse } from "./d16-linked-fixtures";

const ID = "d16-linked";
beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));

const Z = 1200;
/** The sample warehouse's bay, mm (the fixture's default). */
const BAY_MM = 6 * 1000;

describe("d16 linked reference rules", () => {
  it("a pack row wins; an entity the plan cuts as a body is a snap reference that bounds nothing; anything else is not reference geometry", () => {
    const rules = linkedReferenceRulesOf(TEST_ROWS, ["IFCWALL", "IFCRAILING"]);
    expect(rules.rules.IFCWALL).toEqual({ noun: "wall", snap: true, boundsRooms: true, envelope: "wall" });
    expect(rules.rules.IFCRAILING).toEqual({ noun: "railing", snap: true, boundsRooms: false, envelope: null });
    expect(rules.rules.IFCSLAB).toBeUndefined();
    expect(nounOfIfcEntity("IFCWALLSTANDARDCASE")).toBe("wall");
    // The kernel itself names no entity: with no rows and no plan display, nothing is reference geometry.
    expect(Object.keys(linkedReferenceRulesOf([], []).rules)).toEqual([]);
  });
});

describe("d16 long, thin outlines", () => {
  it("a wall's hull gives its axis, both faces and its width, whatever its angle", () => {
    for (const deg of [0, 30, 90, 137]) {
      const a = (deg * Math.PI) / 180;
      const el = linkedWall("w", { x: 1000, y: 2000 }, { x: 1000 + 5000 * Math.cos(a), y: 2000 + 5000 * Math.sin(a) });
      const pts: Vec2[] = [];
      for (let i = 0; i < (el.hull?.length ?? 0); i += 2) pts.push({ x: el.hull?.[i] ?? 0, y: el.hull?.[i + 1] ?? 0 });
      const shape = lineLikeOf(pts);
      expect(shape).not.toBeNull();
      expect(shape?.widthMm).toBeCloseTo(WALL_T, 3);
      const len = Math.hypot((shape?.axis.end.x ?? 0) - (shape?.axis.start.x ?? 0), (shape?.axis.end.y ?? 0) - (shape?.axis.start.y ?? 0));
      expect(len).toBeCloseTo(5000 + WALL_T, 3);
    }
  });

  it("a squat outline (a column) is not long and thin", () => {
    expect(lineLikeOf([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }])).toBeNull();
  });
});

describe("d16 snapping to linked walls", () => {
  const index = buildLinkedReferenceIndex([sampleWarehouse(2, 1)], TEST_RULES);

  it("near a wall, its faces, centre line, ends and corners are offered in plain words", () => {
    const c = linkedSnapCandidates(index, { at: { x: 3000, y: 120 }, reachMm: 400, zMm: Z });
    expect(c.lines.some((l) => l.kind === "face" && l.label === "On the linked wall's face" && l.ref.globalId === "H0")).toBe(true);
    expect(c.lines.some((l) => l.kind === "centre" && l.label === "On the linked wall's centre line")).toBe(true);
    expect(c.points.some((p) => p.kind === "end" && p.label === "End of the linked wall")).toBe(true);
    expect(c.points.some((p) => p.kind === "corner")).toBe(true);
  });

  it("reads only the cells round the pointer and only what the plan height passes through", () => {
    const far = linkedSnapCandidates(index, { at: { x: 90_000, y: 90_000 }, reachMm: 400, zMm: Z });
    expect(far.lines).toHaveLength(0);
    const above = linkedSnapCandidates(index, { at: { x: 3000, y: 120 }, reachMm: 400, zMm: STOREY_TOP + 500 });
    expect(above.lines).toHaveLength(0);
  });

  it("every element keeps its linked model and GlobalId, and a key round-trips", () => {
    const item = linkedReferenceItem(index, { sourceId: LINK_ID, globalId: "V1" });
    expect(item?.rule.noun).toBe("wall");
    const key = linkedElementKey({ sourceId: LINK_ID, globalId: "2O2Fr$t4X7Zf8NOew3FLOH" });
    expect(parseLinkedElementKey(key)).toEqual({ sourceId: LINK_ID, globalId: "2O2Fr$t4X7Zf8NOew3FLOH" });
    expect(parseLinkedElementKey("wall-1")).toBeNull();
  });
});

describe("d16 rooms from linked walls", () => {
  it("a building drawn only in the link proposes its rooms; without the link it proposes none", () => {
    const m = modelWith([], ID);
    expect(detectRoomsFromWalls(m.elements, L1)).toHaveLength(0);
    const index = buildLinkedReferenceIndex([sampleWarehouse(2, 2)], TEST_RULES);
    const found = detectRoomsFromWalls(m.elements, L1, { index, zMm: Z });
    expect(found).toHaveLength(4);
    for (const p of found) {
      expect(p.linkedBoundary).toBe(true);
      expect(p.areaM2).toBeCloseTo(((BAY_MM - WALL_T) * (BAY_MM - WALL_T)) / 1e6, 3);
    }
    expect(LINKED_WALL_ROOM_DETECTOR_ID).toBe("linked-walls-rooms@1");
  });

  it("our own wall splits a linked room in two", () => {
    const m = modelWith([wall("ours", { x: 3000, y: 0 }, { x: 3000, y: 6000 })], ID);
    const index = buildLinkedReferenceIndex([sampleWarehouse(1, 1)], TEST_RULES);
    const found = detectRoomsFromWalls(m.elements, L1, { index, zMm: Z });
    expect(found).toHaveLength(2);
    expect(found.every((p) => p.boundary.some((b) => b.elementId === "ours"))).toBe(true);
  });

  it("linked walls bound rooms only where the plan height passes through them", () => {
    const index = buildLinkedReferenceIndex([sampleWarehouse(1, 1)], TEST_RULES);
    expect(linkedBoundarySegments(index, Z).length).toBe(8);
    expect(linkedBoundarySegments(index, STOREY_TOP + 1000)).toHaveLength(0);
  });
});

describe("d16 dimensions that follow a linked wall", () => {
  const item = (refs: readonly (AnchorRef | null)[], points: Vec2[]): DrawingItem => {
    const record: unknown = { id: asElementId("dim-1"), kind: "drawing_item", version: 1, authoredRev: {}, ownerId: "view-1", shape: "dimension", points, dim: { kind: "aligned", offsetMm: -8, refs } };
    return record as DrawingItem;
  };

  afterEach(() => withdrawLinkedReferenceSources([LINK_ID]));

  it("moves with the wall's face when the link's new version moves it, and says so when the wall is gone", () => {
    const m = modelWith([], ID);
    const key = linkedElementKey({ sourceId: LINK_ID, globalId: "V1" });
    const dim = item([{ elementId: key, anchor: "edge_left" }, null], [{ x: 6000 + WALL_T / 2, y: 3000 }, { x: 12_000, y: 3000 }]);
    // Not loaded: the stored point stands, nothing is flagged.
    expect(dimensionPoints(m, null, dim).points[0]).toEqual({ x: 6100, y: 3000 });

    publishLinkedReferenceIndex(buildLinkedReferenceIndex([sampleWarehouse(2, 1)], TEST_RULES));
    const at0 = dimensionPoints(m, null, dim).points[0];
    expect(Math.abs((at0?.x ?? 0) - 6000)).toBeCloseTo(WALL_T / 2, 3);

    // The architect moves the wall 500 mm east: the dimension point follows its face.
    const moved = sampleWarehouse(2, 1);
    const shifted = { ...moved, elements: moved.elements.map((e) => (e.globalId === "V1" ? linkedWall("V1", { x: 6500, y: 0 }, { x: 6500, y: 6000 }) : e)) };
    publishLinkedReferenceIndex(buildLinkedReferenceIndex([shifted], TEST_RULES));
    const at1 = dimensionPoints(m, null, dim).points[0];
    expect(Math.abs((at1?.x ?? 0) - 6500)).toBeCloseTo(WALL_T / 2, 3);
    expect(at1?.y).toBeCloseTo(3000, 6);

    // Gone from the new version: kept where it was, and flagged with words.
    publishLinkedReferenceIndex(buildLinkedReferenceIndex([{ ...moved, elements: moved.elements.filter((e) => e.globalId !== "V1") }], TEST_RULES));
    const gone = dimensionPoints(m, null, dim);
    expect(gone.points[0]).toEqual({ x: 6100, y: 3000 });
    expect(gone.missingLinked?.[0]?.sourceLabel).toBe("Sample Warehouse (architect)");
    expect(resolveLinkedAnchor({ elementId: key, anchor: "edge_left" }, { x: 0, y: 0 })?.kind).toBe("missing");
  });

  it("saves a dimension anchored to a linked wall (outside the model), and still refuses one pointing at a missing element of ours", () => {
    const exec = (m: ModelState, command: Record<string, unknown>) => executeCommand(m, commandSchema.parse(command));
    const made = exec(createDemoModel(), { type: "create_view", viewId: "fp", name: "Level 1 plan", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } });
    if (!made.ok) throw new Error(made.error.message);
    const key = linkedElementKey({ sourceId: LINK_ID, globalId: "V1" });
    const add = { type: "add_drawing_item", itemId: "dim-linked", ownerId: "fp", shape: "dimension", points: [{ x: 6100, y: 3000 }, { x: 9000, y: 3000 }], dim: { kind: "aligned", refs: [{ elementId: key, anchor: "edge_left" }, null], offsetMm: -8 } };
    // A peer that reads linked anchors stores it; an older model server is told in words, never a silent drop.
    const linkedDim = withUpgradePolicy((f) => f === ANNOTATION_LINKED_ANCHORS_FEATURE, () => exec(made.model, add));
    expect(linkedDim.ok ? "saved" : linkedDim.error.message).toBe("saved");
    const older = exec(made.model, add);
    expect(older.ok ? "saved" : older.error.message).toMatch(/model server this model is open on is an older version/);
    const missing = exec(made.model, { type: "add_drawing_item", itemId: "dim-bad", ownerId: "fp", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], dim: { kind: "aligned", refs: [{ elementId: "no-such-wall", anchor: "start" }, null], offsetMm: -8 } });
    expect(missing.ok).toBe(false);
  });

  it("an anchor on a column (not long and thin) lands on its nearest edge", () => {
    const index = buildLinkedReferenceIndex([{ modelId: "link-cols", label: "Columns", elements: [{ globalId: "C1", name: "Column", ifcClass: "IFCCOLUMN", box: [0, 0, 0, 400, 400, 3000] }] }], TEST_RULES);
    const col = linkedReferenceItem(index, { sourceId: "link-cols", globalId: "C1" });
    if (!col) throw new Error("column missing");
    expect(linkedAnchorPoint(col, "mid", { x: 900, y: 200 })).toEqual({ x: 400, y: 200 });
  });
});

describe("d16 envelope from the link", () => {
  it("finds the outside walls (not the partitions), the windows in them, and a space's share", () => {
    const index = buildLinkedReferenceIndex([sampleWarehouse(2, 1)], TEST_RULES);
    const env = linkedEnvelopeAt(index, Z);
    expect(env.walls.map((w) => w.ref.globalId).sort()).toEqual(["H0", "H1", "V0", "V2"]);
    expect(env.openings).toHaveLength(4);
    const south = env.walls.find((w) => w.ref.globalId === "H0");
    expect(south?.outward.y).toBeCloseTo(-1, 6);
    // The west room: inside faces of V0, H0, H1 (its east side is the partition V1).
    const h = WALL_T / 2;
    const room: Vec2[] = [{ x: h, y: h }, { x: 6000 - h, y: h }, { x: 6000 - h, y: 6000 - h }, { x: h, y: 6000 - h }];
    const s = spaceEnvelopeOf(env, room);
    expect(s.walls.map((w) => w.wall.globalId).sort()).toEqual(["H0", "H1", "V0"]);
    expect(s.exteriorLengthMm).toBeCloseTo(3 * (BAY_MM - WALL_T), 3);
    expect(s.openings.map((o) => o.ref.globalId).sort()).toEqual(["WN0", "WS0"]);
    expect(s.windowAreaM2).toBeCloseTo(2 * 1.2 * 1.2, 6);
  });
});

/**
 * The pointer-move hot path does bounded work at 50,000 linked walls: one
 * build, each wall in at most four 5 m cells, a pointer move scoring only the
 * walls near it. That is checked on every run. The clock budgets are Perf Gate
 * (BIM) rows linked.reference.index.large (400 / 800 ms) and
 * linked.reference.snap.large (0.05 / 0.2 ms per move), measured in plain Node
 * by scripts/perf/mutinybim/d16-linked-reference.ts. Not here: Jest runs each
 * file in a sandbox where every Math.* read is slow, so a 57-73 ms build read
 * 340 ms under Jest on a laptop and 1.4-1.6 s in PR Gate's Unit Tests job.
 * Coverage was not the cause (packages/ is not instrumented).
 */
describe("d16 speed (pointer-move hot path)", () => {
  it("indexes 50,000 linked walls once, in a few cells each, and a pointer move looks only nearby", () => {
    const model = manyWalls(50_000);
    const t0 = performance.now();
    const index = buildLinkedReferenceIndex([model], TEST_RULES);
    const buildMs = performance.now() - t0;
    const builds = linkedReferenceStats.builds;
    const memberships = [...index.cells.values()].reduce((n, list) => n + list.length, 0);
    const t1 = performance.now();
    let hits = 0;
    let most = 0;
    for (let k = 0; k < 10_000; k++) {
      const offered = linkedSnapCandidates(index, { at: { x: (k * 37) % 800_000, y: (k * 53) % 220_000 }, reachMm: 300, zMm: Z }).lines.length;
      hits += offered;
      most = Math.max(most, offered);
    }
    const queryMs = performance.now() - t1;
    process.stderr.write(`[d16-perf] build ${Math.round(buildMs)} ms for ${index.items.length} walls (${memberships} cell entries); 10k snaps ${Math.round(queryMs)} ms (${(queryMs / 10).toFixed(3)} µs each); ${hits} lines offered, at most ${most} per move\n`);
    expect(linkedReferenceStats.builds).toBe(builds);
    expect(index.items).toHaveLength(50_000);
    expect(index.wide).toHaveLength(0);
    // A 3 m wall on a 5 m grid sits in at most four cells (it may straddle a corner): no wall is indexed everywhere.
    expect(memberships).toBeLessThanOrEqual(4 * 50_000);
    // A pointer move offers the walls of the cells round it, never the building (each wall gives a few lines).
    expect(most).toBeLessThan(400);
  });
});
