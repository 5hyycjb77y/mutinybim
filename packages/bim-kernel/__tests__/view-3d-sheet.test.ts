/**
 * @jest-environment node
 *
 * Saved 3D views on sheets: drawn as vector hidden-line from the view's own
 * camera, clipped to its whole 3D crop box (heights included), with caps
 * where the box cuts through a solid. The viewport's frame is the box seen
 * from the camera, so it follows the camera and the box.
 */
import {
  boxPlanRect,
  buildSheetSceneFor,
  commandSchema,
  executeCommand,
  frameForViewport,
  isKind,
  planCommit,
  type CropBox3d,
  type ModelState,
  type Primitive,
  type View3dCamera,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { cameraProjector, clipPolygon3, clipSegment3, projectSolidInBox } from "../src/drawing/view3d-drawing";
import { elementSolid } from "../src/drawing/solids";
import { FaceIndex, cellFor, splitHidden } from "../src/drawing/projection";
import { boxKeepPlanes } from "../src/view3d";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const FT = 304.8;
const NOW = () => "2026-10-20T00:00:00.000Z";
let keySeq = 0;

function commit(head: ModelState, command: RawCommand): ModelState {
  keySeq += 1;
  const d = planCommit(head, [], { idempotencyKey: `v3s-key-${keySeq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: commandSchema.parse(command) }, NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

/** Demo trunk (0..40 ft east, legacy duct 9 ft above Level 1) with levels; a sheet. */
function base(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 14 * FT });
  return commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-301", name: "Isometrics" });
}

const TOP: View3dCamera = { eye: { x: 20 * FT, y: 0, z: 200 * FT }, target: { x: 20 * FT, y: 0, z: 9 * FT }, up: { x: 0, y: 1, z: 0 }, fovDeg: 45, orthoHeightMm: 30000 };
const box = (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }): CropBox3d => ({
  center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  halfSize: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 },
  rotationDeg: 0,
});

/** The lines a placed view drew on the sheet (inside its viewport frame). */
function viewLines(m: ModelState, vpId = "vp-1"): Extract<Primitive, { kind: "line" }>[] {
  const vp = m.elements[vpId];
  if (!vp || vp.kind !== "viewport") throw new Error("no viewport");
  const view = m.elements[vp.viewId];
  if (!view || !isKind(view, "view")) throw new Error("no view");
  const frame = frameForViewport(m, vp, view);
  const inFrame = (q: { x: number; y: number }) => Math.abs(q.x - frame.center.x) <= frame.size.x / 2 + 0.01 && Math.abs(q.y - frame.center.y) <= frame.size.y / 2 + 0.01;
  return buildSheetSceneFor(m, "s-1", { projectName: "Test" }).primitives.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line" && inFrame(p.a) && inFrame(p.b));
}

function place(m: ModelState, viewCmd: RawCommand): ModelState {
  return commit(commit(m, viewCmd), { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: String(viewCmd.viewId), center: { x: 400, y: 300 } });
}

describe("3D clipping primitives", () => {
  const planes = boxKeepPlanes(box({ x: 0, y: 0, z: 0 }, { x: 1000, y: 1000, z: 1000 }));
  test("a segment through the box keeps only its inside part", () => {
    const c = clipSegment3({ x: -500, y: 500, z: 500 }, { x: 1500, y: 500, z: 500 }, planes);
    expect(c?.[0].x).toBeCloseTo(0, 6);
    expect(c?.[1].x).toBeCloseTo(1000, 6);
    expect(clipSegment3({ x: -500, y: 500, z: 2000 }, { x: 1500, y: 500, z: 2000 }, planes)).toBeNull();
  });
  test("a polygon is cut back to the box", () => {
    const poly = clipPolygon3([{ x: -500, y: -500, z: 500 }, { x: 1500, y: -500, z: 500 }, { x: 1500, y: 1500, z: 500 }, { x: -500, y: 1500, z: 500 }], planes);
    expect(poly.length).toBe(4);
    for (const q of poly) {
      expect(q.x).toBeGreaterThanOrEqual(-1e-6);
      expect(q.x).toBeLessThanOrEqual(1000 + 1e-6);
    }
  });
});

describe("hidden lines from a 3D camera take the shortcuts only where they are exact", () => {
  test("a back edge is wholly hidden by its own piece; a front edge is never hidden by it", () => {
    const m = base();
    const sw: View3dCamera = { eye: { x: -60 * FT, y: -50 * FT, z: 45 * FT }, target: { x: 15 * FT, y: 0, z: 9 * FT }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 30000 };
    const planes = boxKeepPlanes(box({ x: 8 * FT, y: -30 * FT, z: 0 }, { x: 30 * FT, y: 30 * FT, z: 14 * FT }));
    const projected = Object.values(m.elements)
      .map((el) => elementSolid(m, el, 0))
      .filter((sol): sol is NonNullable<typeof sol> => sol !== null)
      .map((sol) => projectSolidInBox(sol, cameraProjector(sw), planes));
    const faces = projected.flatMap((x) => x.faces);
    expect(faces.length).toBeGreaterThan(10);
    const us = faces.flatMap((f) => f.poly.map((q) => q.u));
    const vs = faces.flatMap((f) => f.poly.map((q) => q.v));
    const index = new FaceIndex(cellFor(Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)));
    for (const f of faces) index.add(f);
    let back = 0;
    let front = 0;
    for (const e of projected.flatMap((x) => x.edges)) {
      const full = splitHidden(e.a, e.b, index);
      if (e.facing === "back") {
        back += 1;
        const shown = full.visible.reduce((sum, [p, q]) => sum + Math.hypot(q.u - p.u, q.v - p.v), 0);
        expect(shown).toBeLessThan(1);
      } else {
        front += 1;
        const skipped = splitHidden(e.a, e.b, index, undefined, (f) => f.owner === e.owner && f.piece === e.piece);
        expect(skipped.visible.length).toBe(full.visible.length);
      }
    }
    expect(back).toBeGreaterThan(0);
    expect(front).toBeGreaterThan(0);
  });
});

describe("3D views on sheets", () => {
  test("the box's heights crop on the sheet: a box below the duct prints nothing of it", () => {
    const around = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk", camera: TOP, cropBox: box({ x: -5 * FT, y: -5 * FT, z: 0 }, { x: 45 * FT, y: 5 * FT, z: 14 * FT }) });
    expect(viewLines(around).length).toBeGreaterThan(0);
    // Same plan rectangle, but only the bottom 6 ft: the trunk at 9 ft is outside it.
    const below = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk", camera: TOP, cropBox: box({ x: -5 * FT, y: -5 * FT, z: 0 }, { x: 45 * FT, y: 5 * FT, z: 6 * FT }) });
    expect(viewLines(below)).toHaveLength(0);
  });

  test("from a top-down camera an east-west duct prints left to right, and a box across it cuts it with a cap", () => {
    const whole = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk", camera: TOP, cropBox: box({ x: -5 * FT, y: -5 * FT, z: 0 }, { x: 45 * FT, y: 5 * FT, z: 14 * FT }) });
    const lines = viewLines(whole);
    const longest = lines.reduce((best, l) => (Math.abs(l.b.x - l.a.x) > Math.abs(best.b.x - best.a.x) ? l : best));
    expect(Math.abs(longest.b.y - longest.a.y)).toBeLessThan(0.5);
    expect(Math.abs(longest.b.x - longest.a.x)).toBeGreaterThan(100);
    // A box from 10 to 20 ft east, looked at from the south-west and above: the trunk is cut at both ends of the box.
    const sw: View3dCamera = { eye: { x: -60 * FT, y: -60 * FT, z: 60 * FT }, target: { x: 15 * FT, y: 0, z: 9 * FT }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 30000 };
    const cut = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk cut", camera: sw, cropBox: box({ x: 10 * FT, y: -5 * FT, z: 0 }, { x: 20 * FT, y: 5 * FT, z: 14 * FT }) });
    expect(viewLines(cut).length).toBeGreaterThan(0);
    // The trunk on its own: the box's west face (toward the camera) caps it; a box around all of it caps nothing.
    const trunk = cut.elements["seg-trunk"];
    if (!trunk) throw new Error("no trunk");
    const solid = elementSolid(cut, trunk, 0);
    if (!solid) throw new Error("no solid");
    const capped = projectSolidInBox(solid, cameraProjector(sw), boxKeepPlanes(box({ x: 10 * FT, y: -5 * FT, z: 0 }, { x: 20 * FT, y: 5 * FT, z: 14 * FT })));
    expect(capped.cuts).toHaveLength(1);
    // Every kept edge lies inside the box's 10..20 ft stretch (seen along the camera's right axis it spans less than the whole trunk).
    const all = projectSolidInBox(solid, cameraProjector(sw), boxKeepPlanes(box({ x: -5 * FT, y: -5 * FT, z: 0 }, { x: 45 * FT, y: 5 * FT, z: 14 * FT })));
    expect(all.cuts).toHaveLength(0);
    const span = (ps: typeof capped) => Math.max(...ps.edges.flatMap((e) => [e.a.u, e.b.u])) - Math.min(...ps.edges.flatMap((e) => [e.a.u, e.b.u]));
    expect(span(capped)).toBeLessThan(span(all) / 2);
  });

  test("the viewport's frame is the box seen from the camera: it follows a new camera", () => {
    const m = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk", camera: TOP, cropBox: box({ x: 0, y: -5 * FT, z: 0 }, { x: 40 * FT, y: 5 * FT, z: 14 * FT }) });
    const vp = m.elements["vp-1"];
    if (!vp || vp.kind !== "viewport") throw new Error("no viewport");
    // From the top the frame is the box's plan: 40 x 10 ft at 1/4" = 1'-0".
    expect(vp.size.x).toBeCloseTo((40 * FT) / 48, 1);
    expect(vp.size.y).toBeCloseTo((10 * FT) / 48, 1);
    const side: View3dCamera = { eye: { x: 20 * FT, y: -200 * FT, z: 7 * FT }, target: { x: 20 * FT, y: 0, z: 7 * FT }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 30000 };
    const turned = commit(m, { type: "set_3d_view_camera", viewId: "v-3d", camera: side });
    const vp2 = turned.elements["vp-1"];
    if (!vp2 || vp2.kind !== "viewport") throw new Error("no viewport");
    // From the south the frame is the box's elevation: 40 x 14 ft.
    expect(vp2.size.x).toBeCloseTo((40 * FT) / 48, 1);
    expect(vp2.size.y).toBeCloseTo((14 * FT) / 48, 1);
    // And dragging the frame's edges says what to do instead.
    const refused = executeCommand(turned, commandSchema.parse({ type: "resize_viewport", viewportId: "vp-1", size: { x: 50, y: 50 } }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Change the box/);
    // The box's plan crop still matches it, for readers of the plan crop.
    const v = turned.elements["v-3d"];
    if (!v || !isKind(v, "view") || !v.props?.cropBox3d) throw new Error("no box");
    expect({ min: v.cropMin, max: v.cropMax }).toEqual(boxPlanRect(v.props.cropBox3d));
  });

  test("the title says it is a 3D view, not to scale", () => {
    const m = place(base(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk", camera: TOP });
    const texts = buildSheetSceneFor(m, "s-1", { projectName: "Test" }).primitives.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    expect(texts).toContain("3D VIEW, NOT TO SCALE");
  });
});
