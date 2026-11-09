/**
 * @jest-environment node
 *
 * Detailing: styled linework, arcs / circles / polylines / splines, hatched and
 * masking regions, library components, repeating details and batts draw as
 * vector primitives; categories hide per view; items copy between views with
 * their dimensions; modify tools plan the edits; snaps and tracking land where
 * a drafter expects.
 */
import {
  DETAIL_COMPONENTS,
  buildViewScene,
  commandSchema,
  detailSnap,
  dimensionLabels,
  documentIndex,
  executeCommand,
  hatchSegments,
  planModify,
  trackAngle,
  type DrawingItem,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function refusal(model: ModelState, command: Record<string, unknown> & { type: string }): string {
  const r = executeCommand(model, commandSchema.parse(command));
  if (r.ok) throw new Error("accepted");
  return r.error.message;
}

function detail(): ModelState {
  let m = createDemoModel();
  m = run(m, { type: "create_view", viewId: "det", name: "Detail", viewType: "detail", props: { scale: 8 }, crop: { min: { x: -3000, y: -3000 }, max: { x: 3000, y: 3000 } } });
  return m;
}

const prims = (m: ModelState, viewId = "det") => buildViewScene(m, viewId).scene.primitives;
const item = (m: ModelState, id: string): DrawingItem => {
  const el = m.elements[id];
  if (el?.kind !== "drawing_item") throw new Error(id);
  return el;
};

describe("detailing shapes", () => {
  it("draw as vector linework, styled", () => {
    let m = detail();
    const before = prims(m).length;
    const add = (c: Record<string, unknown>) => (m = run(m, { type: "add_drawing_item", ownerId: "det", ...c }));
    add({ itemId: "l", shape: "line", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], lineStyle: { weight: "heavy", pattern: "dashed" } });
    add({ itemId: "a", shape: "arc", points: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 0, y: 500 }] });
    add({ itemId: "c", shape: "circle", points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] });
    add({ itemId: "p", shape: "polyline", points: [{ x: 0, y: 0 }, { x: 200, y: 200 }, { x: 400, y: 0 }], closed: true });
    add({ itemId: "s", shape: "spline", points: [{ x: 0, y: 0 }, { x: 200, y: 300 }, { x: 400, y: 0 }, { x: 600, y: 300 }] });
    const lines = prims(m).filter((p) => p.kind === "line");
    expect(lines.length).toBeGreaterThan(before + 40);
    expect(lines.some((p) => p.kind === "line" && p.pen === "heavy" && p.dash?.[0] === 3)).toBe(true);
  });

  it("hatched regions fill with clipped lines; masking regions are white with no outline", () => {
    let m = detail();
    m = run(m, { type: "add_drawing_item", itemId: "r", ownerId: "det", shape: "region", points: [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 600 }, { x: 0, y: 600 }], fill: { pattern: "crosshatch" } });
    m = run(m, { type: "add_drawing_item", itemId: "mask", ownerId: "det", shape: "region", points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }], fill: { pattern: "solid", masking: true } });
    const all = prims(m);
    const fills = all.filter((p) => p.kind === "fill");
    expect(fills.some((p) => p.kind === "fill" && p.grey === 1 && p.points.length === 3)).toBe(true);
    const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
    const hatch = hatchSegments(square, "diagonal");
    expect(hatch.length).toBeGreaterThan(5);
    for (const [a, b] of hatch) for (const p of [a, b]) expect(p.x >= -1e-6 && p.x <= 20 + 1e-6 && p.y >= -1e-6 && p.y <= 10 + 1e-6).toBe(true);
  });

  it("components come from the library; repeats and batts lay out along a line", () => {
    let m = detail();
    expect(DETAIL_COMPONENTS.map((c) => c.id)).toEqual(expect.arrayContaining(["flex_duct", "trapeze_hanger", "gate_valve", "concrete_anchor", "duct_rect_section"]));
    expect(refusal(m, { type: "add_drawing_item", itemId: "x", ownerId: "det", shape: "component", points: [{ x: 0, y: 0 }], component: { symbolId: "nope" } })).toMatch(/no detail component "nope"/);
    expect(refusal(m, { type: "add_drawing_item", itemId: "x", ownerId: "det", shape: "batt", points: [{ x: 0, y: 0 }, { x: 900, y: 0 }] })).toMatch(/thickness/);
    const base = prims(m).length;
    m = run(m, { type: "add_drawing_item", itemId: "v", ownerId: "det", shape: "component", points: [{ x: 0, y: 0 }], component: { symbolId: "gate_valve", rotationDeg: 90 } });
    const valve = prims(m).length - base;
    m = run(m, { type: "add_drawing_item", itemId: "rep", ownerId: "det", shape: "repeat", points: [{ x: 0, y: 0 }, { x: 914.4, y: 0 }], component: { symbolId: "gate_valve", spacingMm: 152.4 } });
    expect(prims(m).length - base - valve).toBeGreaterThanOrEqual(valve * 6);
    m = run(m, { type: "add_drawing_item", itemId: "b", ownerId: "det", shape: "batt", points: [{ x: 0, y: -400 }, { x: 900, y: -400 }], batt: { thicknessMm: 76.2 } });
    expect(prims(m).length).toBeGreaterThan(base + valve * 7 + 20);
  });

  it("a view hides drafting categories", () => {
    let m = detail();
    m = run(m, { type: "add_drawing_item", itemId: "r", ownerId: "det", shape: "region", points: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 600 }], fill: { pattern: "diagonal" } });
    const shown = prims(m).length;
    m = run(m, { type: "set_view_properties", viewId: "det", props: { hiddenDraftingCategories: ["hatching"] } });
    expect(prims(m).length).toBeLessThan(shown);
  });
});

describe("copy between views", () => {
  it("copies items with their dimensions following the copies, and groups stay together", () => {
    let m = detail();
    m = run(m, { type: "create_view", viewId: "det2", name: "Detail 2", viewType: "detail" });
    m = run(m, { type: "add_drawing_item", itemId: "l", ownerId: "det", shape: "line", points: [{ x: 0, y: 0 }, { x: 609.6, y: 0 }], detailGroup: "hanger" });
    m = run(m, { type: "add_drawing_item", itemId: "d", ownerId: "det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 609.6, y: 0 }], dim: { kind: "aligned", offsetMm: 5, refs: [{ elementId: "l", anchor: "start" }, { elementId: "l", anchor: "end" }] }, detailGroup: "hanger" });
    m = run(m, { type: "copy_drawing_items", itemIds: ["l", "d"], toOwnerId: "det2", offset: { x: 100, y: 0 }, idPrefix: "cp" });
    const copies = documentIndex(m).itemsByOwner.get("det2") ?? [];
    expect(copies.map((c) => c.id).sort()).toEqual(["cp-d", "cp-l"]);
    expect(item(m, "cp-d").dim?.refs?.[0]?.elementId).toBe("cp-l");
    expect(item(m, "cp-l").detailGroup).toBe("cp-hanger");
    m = run(m, { type: "update_drawing_item", itemId: "cp-l", points: [{ x: 100, y: 0 }, { x: 1014.4, y: 0 }] });
    const view = m.elements.det2;
    if (view?.kind !== "view") throw new Error("no view");
    expect(dimensionLabels(m, view, item(m, "cp-d"))).toEqual([`3'-0"`]);
    expect(dimensionLabels(m, m.elements.det?.kind === "view" ? m.elements.det : null, item(m, "d"))).toEqual([`2'-0"`]);
  });
});

describe("modify tools", () => {
  const line = (id: string, a: [number, number], b: [number, number]): DrawingItem =>
    ({ id, kind: "drawing_item", version: 0, authoredRev: {}, ownerId: "det", shape: "line", points: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }] }) as unknown as DrawingItem;
  const none = () => undefined;

  it("rotate, mirror and array plan point updates or copies", () => {
    const l = line("l", [0, 0], [100, 0]);
    const rot = planModify([l], { op: "rotate", center: { x: 0, y: 0 }, angleDeg: 90 }, "p", none);
    expect(rot.ok && rot.steps[0]).toMatchObject({ type: "update_drawing_item", points: [{ x: 0, y: 0 }, { x: 0, y: 100 }] });
    const mir = planModify([l], { op: "mirror", a: { x: 0, y: 50 }, b: { x: 100, y: 50 }, copy: true }, "p", none);
    expect(mir.ok && mir.steps[0]).toMatchObject({ type: "add_drawing_item", points: [{ x: 0, y: 100 }, { x: 100, y: 100 }] });
    const arr = planModify([l], { op: "array", count: 4, delta: { x: 0, y: 50 } }, "p", none);
    expect(arr.ok && arr.steps).toHaveLength(3);
  });

  it("offset to the picked side; trim and extend at an edge; fillet two lines", () => {
    const l = line("l", [0, 0], [100, 0]);
    const off = planModify([l], { op: "offset", distance: 10, side: { x: 50, y: 30 } }, "p", none);
    expect(off.ok && off.steps[0]).toMatchObject({ type: "add_drawing_item", points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] });
    const edge = line("e", [60, -50], [60, 50]);
    const look = (id: string) => (id === "e" ? edge : undefined);
    const trim = planModify([l], { op: "trim", boundaryId: "e", keep: { x: 10, y: 0 } }, "p", look);
    expect(trim.ok && trim.steps[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 60, y: 0 }] });
    const short = line("s", [0, 0], [40, 0]);
    const ext = planModify([short], { op: "extend", boundaryId: "e", near: { x: 40, y: 0 } }, "p", look);
    expect(ext.ok && ext.steps[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 60, y: 0 }] });
    const v = line("v", [100, 20], [100, 120]);
    const fil = planModify([line("h", [0, 0], [90, 0]), v], { op: "fillet", radius: 10 }, "p", none);
    expect(fil.ok).toBe(true);
    if (!fil.ok) return;
    const arc = fil.steps.find((s) => s.type === "add_drawing_item");
    expect(arc && "points" in arc && arc.points[0]).toEqual({ x: 90, y: 10 });
    expect(planModify([l, l], { op: "fillet", radius: 10 }, "p", none)).toMatchObject({ ok: false });
  });
});

describe("snaps and tracking", () => {
  const items = [
    { id: "a", kind: "drawing_item", version: 0, authoredRev: {}, ownerId: "s", shape: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { id: "b", kind: "drawing_item", version: 0, authoredRev: {}, ownerId: "s", shape: "line", points: [{ x: 50, y: -50 }, { x: 50, y: 50 }] },
  ] as unknown as DrawingItem[];
  const all = new Set(["endpoint", "midpoint", "center", "intersection", "perpendicular", "nearest"] as const);
  const id = (p: { x: number; y: number }) => p;

  it("prefers endpoints and intersections over nearest", () => {
    expect(detailSnap(items, id, { x: 99, y: 1 }, { kinds: all, reachMm: 3 })).toMatchObject({ kind: "endpoint", at: { x: 100, y: 0 } });
    expect(detailSnap(items, id, { x: 51, y: 1 }, { kinds: all, reachMm: 3 })).toMatchObject({ kind: "intersection", at: { x: 50, y: 0 } });
    expect(detailSnap(items, id, { x: 25, y: 1 }, { kinds: all, reachMm: 3 })).toMatchObject({ kind: "nearest" });
    expect(detailSnap(items, id, { x: 26, y: 1 }, { kinds: all, reachMm: 3, from: { x: 26, y: 40 } })).toMatchObject({ kind: "perpendicular", at: { x: 26, y: 0 } });
  });

  it("ortho and polar tracking pull a point onto the nearest angle", () => {
    expect(trackAngle({ x: 0, y: 0 }, { x: 100, y: 5 }, 90)).toMatchObject({ angleDeg: 0, at: { x: 100, y: 0 } });
    const polar = trackAngle({ x: 0, y: 0 }, { x: 70, y: -72 }, 45);
    expect(polar?.angleDeg).toBe(45);
    expect(trackAngle({ x: 0, y: 0 }, { x: 70, y: -40 }, 45, 4)).toBeNull();
  });
});
