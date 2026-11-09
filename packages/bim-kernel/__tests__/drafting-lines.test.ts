/**
 * @jest-environment node
 *
 * Detail lines the BIM drafting-view way: a rectangle is four joined lines,
 * edits keep joined ends together, and the Modify tools (trim/extend to
 * corner, single, multiple; split, split with gap; fillet arc; chamfer;
 * offset; pin; match type) plan the edits people and agents both send.
 * Rectangles stored before drafting schema 2 still load and print, and become
 * joined lines the first time they are edited, undoably.
 */
import {
  DETAIL_LINE_STYLES,
  DRAFTING_SCHEMA_VERSION,
  detailLineStyleOf,
  lineStyleFor,
  buildViewScene,
  chainOf,
  commandSchema,
  documentIndex,
  draftingVersionOf,
  endsAt,
  executeCommand,
  modifyCommand,
  polygonLines,
  rectSideId,
  rectangleLines,
  toDocumentRecord,
  tangentEndArc,
  arcStartEndRadius,
  type DrawingItem,
  type ModelState,
  type ModifyOp,
  type Vec2,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: unknown): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function detail(): ModelState {
  return run(createDemoModel(), { type: "create_view", viewId: "det", name: "Detail", viewType: "detail", props: { scale: 8 }, crop: { min: { x: -5000, y: -5000 }, max: { x: 5000, y: 5000 } } });
}

const items = (m: ModelState): DrawingItem[] => (documentIndex(m).itemsByOwner.get("det" as never) ?? []).filter((i) => !i.deleted);
const item = (m: ModelState, id: string): DrawingItem => {
  const el = m.elements[id];
  if (el?.kind !== "drawing_item") throw new Error(`no item ${id}`);
  return el;
};

function modify(m: ModelState, ids: string[], op: ModifyOp, prefix = "mod"): ModelState {
  const made = modifyCommand(items(m), ids, op, "det", prefix);
  if (!made.ok) throw new Error(made.reason);
  return run(m, made.command);
}
function refused(m: ModelState, ids: string[], op: ModifyOp): string {
  const made = modifyCommand(items(m), ids, op, "det", "mod");
  if (made.ok) throw new Error(`accepted: ${made.summary}`);
  return made.reason;
}

/** The undo an editor sends: every changed drawing item back as it was. */
function undo(before: ModelState, after: ModelState): ModelState {
  const changed = Object.keys(after.elements).filter((id) => after.elements[id] !== before.elements[id] && after.elements[id]?.kind === "drawing_item");
  return run(after, {
    type: "restore_document_elements",
    items: changed.map((id) => {
      const was = before.elements[id];
      return { elementId: id, before: was ? toDocumentRecord(was) : null, expectedVersion: after.elements[id]?.version ?? 0 };
    }),
  });
}

function drawRectangle(m: ModelState, a: Vec2, b: Vec2, prefix = "r"): ModelState {
  const commands = rectangleLines(a, b).map(([p, q], k) => ({ type: "add_drawing_item", itemId: `${prefix}${k}`, ownerId: "det", shape: "line", points: [p, q] }));
  return run(m, { type: "batch_documents", label: "Rectangle", commands });
}

const near = (p: Vec2 | undefined, q: Vec2, tol = 0.01) => {
  expect(p).toBeDefined();
  expect(Math.hypot((p?.x ?? NaN) - q.x, (p?.y ?? NaN) - q.y)).toBeLessThan(tol);
};

describe("drawing joined lines", () => {
  it("a rectangle is four lines joined end to end", () => {
    const m = drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 });
    expect(items(m).map((i) => i.shape)).toEqual(["line", "line", "line", "line"]);
    expect(chainOf(items(m), "r0").map((i) => i.id).sort()).toEqual(["r0", "r1", "r2", "r3"]);
    for (const it of items(m)) expect(endsAt(items(m), it.points[0] ?? { x: 0, y: 0 }, new Set([it.id])).length).toBe(1);
  });

  it("polygons inscribed and circumscribed, start-end-radius and tangent-end arcs", () => {
    const hex = polygonLines({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, true);
    expect(hex).toHaveLength(6);
    near(hex[0]?.[0], { x: 100, y: 0 });
    const out = polygonLines({ x: 0, y: 0 }, { x: 100, y: 0 }, 4, false);
    // Circumscribed: side midpoints touch the circle.
    const [a, b] = out[0] ?? [];
    near(a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined, { x: 100, y: 0 });
    const arc = arcStartEndRadius({ x: -100, y: 0 }, { x: 100, y: 0 }, 100, { x: 0, y: 50 });
    near(arc?.points[0], { x: 0, y: 0 });
    expect(arc?.ccw).toBe(false);
    const tan = tangentEndArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 100 });
    near(tan?.points[0], { x: 0, y: 100 });
    expect(tan?.ccw).toBe(true);
  });
});

describe("joined ends follow", () => {
  it("moving one side of a rectangle stretches the two sides joined to it", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r1"], { op: "move", delta: { x: 500, y: 0 } });
    near(item(m, "r1").points[0], { x: 2500, y: 0 });
    near(item(m, "r0").points[1], { x: 2500, y: 0 });
    near(item(m, "r2").points[0], { x: 2500, y: 1000 });
    expect(item(m, "r3").points).toEqual([{ x: 0, y: 1000 }, { x: 0, y: 0 }]);
  });

  it("fillet arcs ride along with a moved side, keeping their radius; the lines beyond them stretch", () => {
    let m = drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 });
    m = modify(m, ["r0", "r1"], { op: "fillet_arc", radius: 200 }, "f1");
    m = modify(m, ["r1", "r2"], { op: "fillet_arc", radius: 200 }, "f2");
    m = modify(m, ["r1"], { op: "move", delta: { x: 500, y: 0 } });
    const arc = item(m, "f1-fillet");
    near(arc.points[0], { x: 2300, y: 200 });
    expect(Math.hypot((arc.points[1]?.x ?? 0) - (arc.points[0]?.x ?? 0), (arc.points[1]?.y ?? 0) - (arc.points[0]?.y ?? 0))).toBeCloseTo(200, 3);
    near(item(m, "r0").points[1], { x: 2300, y: 0 });
    near(item(m, "r2").points[0], { x: 2300, y: 1000 });
    expect(chainOf(items(m), "r0")).toHaveLength(6);
  });

  it("Disjoin leaves joined lines where they were", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r1"], { op: "move", delta: { x: 500, y: 0 }, disjoin: true });
    near(item(m, "r0").points[1], { x: 2000, y: 0 });
  });

  it("dragging an end drags the joined end with it", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r0"], { op: "move_end", end: "end", to: { x: 2200, y: -200 } });
    near(item(m, "r0").points[1], { x: 2200, y: -200 });
    near(item(m, "r1").points[0], { x: 2200, y: -200 });
  });
});

describe("fillet arc, chamfer, trim/extend", () => {
  it("fillet arcs round two corners of a rectangle and keep it closed", () => {
    let m = drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 });
    m = modify(m, ["r0", "r1"], { op: "fillet_arc", radius: 200 }, "f1");
    m = modify(m, ["r1", "r2"], { op: "fillet_arc", radius: 200 }, "f2");
    const arc1 = item(m, "f1-fillet");
    expect(arc1.shape).toBe("arc");
    near(arc1.points[0], { x: 1800, y: 200 });
    near(item(m, "r0").points[1], { x: 1800, y: 0 });
    near(item(m, "r1").points[0], { x: 2000, y: 200 });
    near(item(m, "r1").points[1], { x: 2000, y: 800 });
    // Every end still meets exactly one other end.
    for (const it of items(m)) {
      const e = it.shape === "arc" ? [it.points[1], it.points[2]] : [it.points[0], it.points[1]];
      for (const p of e) expect(endsAt(items(m), p ?? { x: 0, y: 0 }, new Set([it.id])).length).toBe(1);
    }
  });

  it("refuses a radius the lines are too short for, and parallel lines", () => {
    const m = drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 });
    expect(refused(m, ["r0", "r1"], { op: "fillet_arc", radius: 5000 })).toMatch(/smaller radius/);
    expect(refused(m, ["r0", "r2"], { op: "fillet_arc", radius: 10 })).toMatch(/parallel/);
  });

  it("chamfers a corner", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r0", "r1"], { op: "chamfer", d1: 100, d2: 50 });
    expect(item(m, "mod-chamfer").points).toEqual([{ x: 1900, y: 0 }, { x: 2000, y: 50 }]);
  });

  it("trim/extend to corner meets two lines, keeping the picked parts", () => {
    let m = detail();
    m = run(m, { type: "add_drawing_item", itemId: "h", ownerId: "det", shape: "line", points: [{ x: 0, y: 0 }, { x: 800, y: 0 }] });
    m = run(m, { type: "add_drawing_item", itemId: "v", ownerId: "det", shape: "line", points: [{ x: 1000, y: -500 }, { x: 1000, y: 500 }] });
    m = modify(m, ["h", "v"], { op: "trim_extend_corner", keep1: { x: 100, y: 0 }, keep2: { x: 1000, y: 400 } });
    expect(item(m, "h").points).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    expect(item(m, "v").points).toEqual([{ x: 1000, y: 0 }, { x: 1000, y: 500 }]);
  });

  it("trim/extend single and multiple, against a line and against an arc", () => {
    let m = detail();
    m = run(m, { type: "add_drawing_item", itemId: "edge", ownerId: "det", shape: "line", points: [{ x: 1000, y: -1000 }, { x: 1000, y: 1000 }] });
    m = run(m, { type: "add_drawing_item", itemId: "a", ownerId: "det", shape: "line", points: [{ x: 0, y: 0 }, { x: 1500, y: 0 }] });
    m = run(m, { type: "add_drawing_item", itemId: "b", ownerId: "det", shape: "line", points: [{ x: 0, y: 200 }, { x: 600, y: 200 }] });
    m = run(m, { type: "add_drawing_item", itemId: "c", ownerId: "det", shape: "line", points: [{ x: 0, y: 400 }, { x: 700, y: 400 }] });
    const single = modify(m, ["a"], { op: "trim_extend_single", boundaryId: "edge", keep: { x: 100, y: 0 } });
    expect(item(single, "a").points).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    const multi = modify(m, ["a", "b", "c"], { op: "trim_extend_multiple", boundaryId: "edge", keeps: [{ x: 1400, y: 0 }, { x: 100, y: 200 }, { x: 100, y: 400 }] });
    expect(item(multi, "a").points).toEqual([{ x: 1000, y: 0 }, { x: 1500, y: 0 }]);
    expect(item(multi, "b").points).toEqual([{ x: 0, y: 200 }, { x: 1000, y: 200 }]);
    expect(item(multi, "c").points).toEqual([{ x: 0, y: 400 }, { x: 1000, y: 400 }]);
    // An arc boundary: the line stops on the circle.
    let k = run(m, { type: "add_drawing_item", itemId: "arc", ownerId: "det", shape: "arc", points: [{ x: 0, y: 0 }, { x: 500, y: -500 }, { x: 500, y: 500 }] });
    k = modify(k, ["a"], { op: "trim_extend_single", boundaryId: "arc", keep: { x: 10, y: 0 } });
    near(item(k, "a").points[1], { x: Math.hypot(500, 500), y: 0 }, 0.01);
  });

  it("trims an arc against a line", () => {
    let m = detail();
    m = run(m, { type: "add_drawing_item", itemId: "arc", ownerId: "det", shape: "arc", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: -1000, y: 0 }] });
    m = run(m, { type: "add_drawing_item", itemId: "cut", ownerId: "det", shape: "line", points: [{ x: 0, y: -100 }, { x: 0, y: 2000 }] });
    m = modify(m, ["arc"], { op: "trim_extend_single", boundaryId: "cut", keep: { x: 700, y: 700 } });
    const a = item(m, "arc");
    near(a.points[1], { x: 1000, y: 0 });
    near(a.points[2], { x: 0, y: 1000 });
  });
});

describe("split, offset, pin, match type", () => {
  it("splits a line, with Delete Inner Segment, and with a gap", () => {
    let m = run(detail(), { type: "add_drawing_item", itemId: "l", ownerId: "det", shape: "line", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] });
    const s = modify(m, ["l"], { op: "split", at: { x: 400, y: 3 } });
    expect(item(s, "l").points).toEqual([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
    expect(item(s, "mod-l").points).toEqual([{ x: 400, y: 0 }, { x: 1000, y: 0 }]);
    const inner = modify(m, ["l"], { op: "split", at: { x: 300, y: 0 }, to: { x: 700, y: 0 } });
    expect(item(inner, "l").points[1]).toEqual({ x: 300, y: 0 });
    expect(item(inner, "mod-l").points[0]).toEqual({ x: 700, y: 0 });
    m = modify(m, ["l"], { op: "split_gap", at: { x: 500, y: 0 }, gap: 50 });
    expect(item(m, "l").points[1]).toEqual({ x: 475, y: 0 });
    expect(item(m, "mod-l").points[0]).toEqual({ x: 525, y: 0 });
  });

  it("offsets a closed chain inward and its corners still meet", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r0", "r1", "r2", "r3"], { op: "offset", distance: 100, side: { x: 1000, y: 500 } }, "off");
    const copies = ["r0", "r1", "r2", "r3"].map((id) => item(m, `off-${id}`));
    expect(copies[0]?.points).toEqual([{ x: 100, y: 100 }, { x: 1900, y: 100 }]);
    expect(copies[1]?.points).toEqual([{ x: 1900, y: 100 }, { x: 1900, y: 900 }]);
    expect(chainOf(items(m), "off-r0")).toHaveLength(4);
    // Copy off: the originals move.
    const moved = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r0", "r1", "r2", "r3"], { op: "offset", distance: 100, side: { x: 1000, y: 500 }, copy: false });
    expect(item(moved, "r0").points).toEqual([{ x: 100, y: 100 }, { x: 1900, y: 100 }]);
  });

  it("pinned items refuse to move and delete until unpinned", () => {
    let m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 }), ["r0"], { op: "pin" });
    expect(item(m, "r0").pinned).toBe(true);
    expect(refused(m, ["r0"], { op: "move", delta: { x: 1, y: 0 } })).toMatch(/pinned/);
    expect(refused(m, ["r0"], { op: "delete" })).toMatch(/pinned/);
    expect(refused(m, ["r1"], { op: "move", delta: { x: 10, y: 0 } })).toMatch(/pinned line is joined/);
    const direct = executeCommand(m, commandSchema.parse({ type: "delete_drawing_item", itemId: "r0" }));
    expect(direct.ok).toBe(false);
    m = modify(m, ["r0"], { op: "unpin" });
    expect(item(m, "r0").pinned).toBeUndefined();
    m = modify(m, ["r0"], { op: "delete" });
    expect(m.elements.r0?.kind === "drawing_item" && m.elements.r0.deleted).toBe(true);
  });

  it("match type copies line style and category", () => {
    let m = drawRectangle(detail(), { x: 0, y: 0 }, { x: 2000, y: 1000 });
    m = run(m, { type: "update_drawing_item", itemId: "r0", lineStyle: { weight: "wide", pattern: "hidden" } });
    m = modify(m, ["r1", "r2"], { op: "match_type", sourceId: "r0" });
    expect(item(m, "r2").lineStyle).toEqual({ weight: "wide", pattern: "hidden" });
  });

  it("an array can make each copy its own group", () => {
    const m = modify(drawRectangle(detail(), { x: 0, y: 0 }, { x: 200, y: 100 }), ["r0", "r1"], { op: "array", count: 3, delta: { x: 500, y: 0 }, group: true }, "arr");
    expect(item(m, "arr-1-r0").detailGroup).toBe("arr-g1");
    expect(item(m, "arr-2-r1").detailGroup).toBe("arr-g2");
  });
});

describe("rectangles from before drafting schema 2", () => {
  function oldRect(): ModelState {
    let m = run(detail(), { type: "add_drawing_item", itemId: "box", ownerId: "det", shape: "rect", points: [{ x: 0, y: 0 }, { x: 2000, y: 1000 }], lineStyle: { weight: "wide" }, detailGroup: "g" });
    m = run(m, { type: "add_drawing_item", itemId: "dim", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 2000, y: 1000 }], dim: { kind: "aligned", offsetMm: -8, refs: [{ elementId: "box", anchor: "start" }, { elementId: "box", anchor: "end" }] } });
    return m;
  }

  it("still load and print as drawn", () => {
    const m = oldRect();
    expect(draftingVersionOf(item(m, "box"))).toBe(1);
    expect(DRAFTING_SCHEMA_VERSION).toBe(2);
    expect(buildViewScene(m, "det").scene.primitives.length).toBeGreaterThan(0);
  });

  it("become four joined lines when first edited: fillet one corner of the rectangle", () => {
    const before = oldRect();
    const after = modify(before, ["box"], { op: "fillet_arc", radius: 100, near1: { x: 1500, y: 0 }, near2: { x: 2000, y: 500 } }, "f");
    expect(after.elements.box?.kind === "drawing_item" && after.elements.box.deleted).toBe(true);
    const sides = [0, 1, 2, 3].map((k) => item(after, rectSideId("box", k)));
    expect(sides.every((s) => s.shape === "line" && s.lineStyle?.weight === "wide" && s.detailGroup === "g")).toBe(true);
    near(sides[0]?.points[1], { x: 1900, y: 0 });
    near(sides[1]?.points[0], { x: 2000, y: 100 });
    expect(item(after, "f-fillet").shape).toBe("arc");
    // The dimension follows the old corners on the new lines.
    expect(item(after, "dim").dim?.refs).toEqual([{ elementId: rectSideId("box", 0), anchor: "start" }, { elementId: rectSideId("box", 1), anchor: "end" }]);
    // Undo puts the rectangle back exactly.
    const back = undo(before, after);
    const box = item(back, "box");
    expect(box.deleted).toBeUndefined();
    expect(box.shape).toBe("rect");
    expect(box.points).toEqual(item(before, "box").points);
    expect(item(back, "dim").dim).toEqual(item(before, "dim").dim);
    expect(back.elements[rectSideId("box", 0)]?.kind === "drawing_item" && (back.elements[rectSideId("box", 0)] as DrawingItem).deleted).toBe(true);
  });

  it("a move upgrades it too; a dimension on its middle refuses the upgrade", () => {
    const moved = modify(oldRect(), ["box"], { op: "move", delta: { x: 10, y: 0 } });
    expect(item(moved, rectSideId("box", 2)).points).toEqual([{ x: 2010, y: 1000 }, { x: 10, y: 1000 }]);
    let m = run(detail(), { type: "add_drawing_item", itemId: "box", ownerId: "det", shape: "rect", points: [{ x: 0, y: 0 }, { x: 2000, y: 1000 }] });
    m = run(m, { type: "add_drawing_item", itemId: "dim", ownerId: "det", shape: "dimension", points: [{ x: 1000, y: 500 }, { x: 3000, y: 500 }], dim: { kind: "aligned", offsetMm: -8, refs: [{ elementId: "box", anchor: "mid" }, null] } });
    expect(refused(m, ["box"], { op: "move", delta: { x: 10, y: 0 } })).toMatch(/middle of this rectangle/);
  });
});

describe("named line styles", () => {
  it("every named style round-trips through the stored weight and pattern; medium solid stores nothing", () => {
    for (const s of DETAIL_LINE_STYLES) expect(detailLineStyleOf(lineStyleFor(s.id))).toBe(s.id);
    expect(lineStyleFor("medium")).toEqual({});
    expect(detailLineStyleOf(undefined)).toBe("medium");
    expect(detailLineStyleOf({ weight: "heavy", pattern: "hidden" })).toBeNull();
  });
});
