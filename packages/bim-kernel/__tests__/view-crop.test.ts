/**
 * @jest-environment node
 *
 * Crop boxes: every view has one; set_view_crop changes it through the same
 * attributed, conflict-checked, undoable path as every edit; a placed
 * viewport's frame is the crop at its scale, so changing either changes both.
 */
import {
  buildSheetSceneFor,
  canonicalJson,
  commandSchema,
  executeCommand,
  frameForViewport,
  isKind,
  planCommit,
  TEXT_WIDTH_PER_CHAR,
  viewWindowIn,
  type BimElement,
  type Changeset,
  type CommandRequest,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const FT = 304.8;
const NOW = () => "2026-10-19T00:00:00.000Z";
const avery = { id: "avery", name: "Avery", kind: "human" as const };
const priya = { id: "priya", name: "Priya", kind: "human" as const };
let keySeq = 0;

function req(head: ModelState, command: RawCommand, actor = avery, baseRevision = head.revision): CommandRequest {
  keySeq += 1;
  return { idempotencyKey: `crop-key-${keySeq}`, baseRevision, actor, command: commandSchema.parse(command) };
}

function commit(head: ModelState, command: RawCommand, actor = avery): { model: ModelState; changeset: Changeset } {
  const d = planCommit(head, [], req(head, command, actor), NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return { model: d.model, changeset: d.changeset };
}

function refusal(head: ModelState, command: RawCommand): string {
  const r = executeCommand(head, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

function el<K extends BimElement["kind"]>(model: ModelState, id: string, kind: K): Extract<BimElement, { kind: K }> {
  const found = model.elements[id];
  if (!found || !isKind(found, kind)) throw new Error(`${id} is not a ${kind}`);
  return found;
}

const CROP = { min: { x: 0, y: 0 }, max: { x: 40 * FT, y: 30 * FT } };

/** Demo model, a level-1 plan with a 40 x 30 ft crop placed at 1/4" = 1'-0" on M-101. */
function placedPlan(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Plan", viewType: "floor_plan", crop: CROP, props: { level: "L1", scale: 48 } }).model;
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" }).model;
  m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
  return m;
}

/** Paper left/right/top/bottom edges of a viewport's frame. */
function edges(m: ModelState, vpId: string): { left: number; right: number; top: number; bottom: number } {
  const vp = el(m, vpId, "viewport");
  const f = frameForViewport(m, vp, el(m, vp.viewId, "view"));
  return { left: f.center.x - f.size.x / 2, right: f.center.x + f.size.x / 2, top: f.center.y - f.size.y / 2, bottom: f.center.y + f.size.y / 2 };
}

describe("set_view_crop", () => {
  test("dragging the crop's east edge widens the viewport on the sheet; the west edge stays put on paper", () => {
    const m0 = placedPlan();
    const before = edges(m0, "vp-1");
    expect(before.right - before.left).toBeCloseTo((40 * FT) / 48, 2);
    const { model: m, changeset } = commit(m0, { type: "set_view_crop", viewId: "v-plan", crop: { min: CROP.min, max: { x: 52 * FT, y: 30 * FT } } });
    const after = edges(m, "vp-1");
    expect(after.left).toBeCloseTo(before.left, 2);
    expect(after.right - before.right).toBeCloseTo((12 * FT) / 48, 2);
    expect(after.top).toBeCloseTo(before.top, 2);
    // Stored size follows too, for agents and older readers.
    expect(el(m, "vp-1", "viewport").size.x).toBeCloseTo((52 * FT) / 48, 2);
    // One changeset carries the view and its viewport, attributed to Avery.
    expect(changeset.elements.map((e) => e.id).sort()).toEqual(["v-plan", "vp-1"]);
    expect(changeset.actor.id).toBe("avery");
  });

  test("crop view off shows all the level's content; moving the crop box turns cropping back on", () => {
    let m = placedPlan();
    m = commit(m, { type: "set_view_crop", viewId: "v-plan", cropView: false }).model;
    const v = el(m, "v-plan", "view");
    expect(v.props?.cropView).toBe(false);
    const all = viewWindowIn(m, v);
    expect(all.max.x - all.min.x).not.toBeCloseTo(40 * FT, 0);
    m = commit(m, { type: "set_view_crop", viewId: "v-plan", crop: CROP }).model;
    expect(el(m, "v-plan", "view").props?.cropView).toBe(true);
  });

  test("fit sets the crop around a detail view's drawing; far clip is for sections only", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-det", name: "Hanger", viewType: "detail" }).model;
    m = commit(m, { type: "add_drawing_item", itemId: "d-1", ownerId: "v-det", shape: "line", points: [{ x: 20 * FT, y: 5 * FT }, { x: 30 * FT, y: 5 * FT }] }).model;
    m = commit(m, { type: "set_view_crop", viewId: "v-det", fit: true }).model;
    const det = el(m, "v-det", "view");
    expect(det.cropMin.x).toBeCloseTo(19 * FT, 1);
    expect(det.cropMax.x).toBeCloseTo(31 * FT, 1);
    expect(refusal(m, { type: "set_view_crop", viewId: "v-det", farClipMm: 3000 })).toMatch(/Only sections/);
    expect(refusal(m, { type: "set_view_crop", viewId: "v-det", crop: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } } })).toMatch(/at least 1 in/);
  });

  test("section crop is the cut's width by height; far clip sets how far it sees", () => {
    let m = createDemoModel();
    m = commit(m, {
      type: "create_view",
      viewId: "v-sec",
      name: "Section A",
      viewType: "section",
      props: { level: "L1", section: { start: { x: 0, y: 0 }, end: { x: 30 * FT, y: 0 }, direction: 1, depthMm: 10 * FT } },
    }).model;
    m = commit(m, { type: "set_view_crop", viewId: "v-sec", crop: { min: { x: 5 * FT, y: 0 }, max: { x: 25 * FT, y: 14 * FT } }, farClipMm: 20 * FT }).model;
    const sec = el(m, "v-sec", "view");
    expect(sec.cropMax).toEqual({ x: 25 * FT, y: 14 * FT });
    expect(sec.props?.section?.depthMm).toBeCloseTo(20 * FT, 3);
  });

  test("someone else changing the crop first is a conflict, not last-write-wins", () => {
    const head = placedPlan();
    const theirs = commit(head, { type: "set_view_crop", viewId: "v-plan", crop: { min: CROP.min, max: { x: 50 * FT, y: 30 * FT } } }, priya);
    const mine = planCommit(theirs.model, [theirs.changeset], req(theirs.model, { type: "set_view_crop", viewId: "v-plan", crop: { min: CROP.min, max: { x: 45 * FT, y: 30 * FT } } }, avery, head.revision), NOW);
    expect(mine.ok).toBe(false);
    if (!mine.ok) expect(mine.error.code).toBe("conflict");
  });

  test("undo restores the crop and the viewport; refuses after someone else changed the crop", () => {
    const m0 = placedPlan();
    const prior = (m: ModelState, id: string): unknown => JSON.parse(canonicalJson(m.elements[id])) as unknown;
    const priors = { "v-plan": prior(m0, "v-plan"), "vp-1": prior(m0, "vp-1") };
    const m1 = commit(m0, { type: "set_view_crop", viewId: "v-plan", crop: { min: CROP.min, max: { x: 52 * FT, y: 30 * FT } } }).model;
    const undo = () => ({
      type: "restore_document_elements",
      items: (["v-plan", "vp-1"] as const).map((id) => ({ elementId: id, before: priors[id], expectedVersion: m1.elements[id]?.version ?? 0 })),
    });
    const undone = commit(m1, undo()).model;
    expect(el(undone, "v-plan", "view").cropMax).toEqual(CROP.max);
    expect(edges(undone, "vp-1")).toEqual(edges(m0, "vp-1"));
    const changed = commit(m1, { type: "set_view_crop", viewId: "v-plan", crop: { min: CROP.min, max: { x: 60 * FT, y: 30 * FT } } }, priya).model;
    expect(refusal(changed, undo())).toMatch(/changed since your edit/);
  });
});

describe("viewport edges edit the crop", () => {
  test("dragging the frame's right edge on paper extends the crop east at the viewport's scale", () => {
    const m0 = placedPlan();
    const vp = el(m0, "vp-1", "viewport");
    // Right edge out by 20 mm: size +20, centre +10.
    const m = commit(m0, { type: "resize_viewport", viewportId: "vp-1", size: { x: vp.size.x + 20, y: vp.size.y }, center: { x: vp.center.x + 10, y: vp.center.y } }).model;
    const v = el(m, "v-plan", "view");
    expect(v.cropMin.x).toBeCloseTo(CROP.min.x, 0);
    expect(v.cropMax.x).toBeCloseTo(CROP.max.x + 20 * 48, 0);
    expect(v.cropMin.y).toBeCloseTo(CROP.min.y, 0);
    expect(el(m, "vp-1", "viewport").scale).toBe(48);
    expect(edges(m, "vp-1").left).toBeCloseTo(edges(m0, "vp-1").left, 2);
  });

  test("dragging the top edge on paper (y down) raises the crop's north edge", () => {
    const m0 = placedPlan();
    const vp = el(m0, "vp-1", "viewport");
    const m = commit(m0, { type: "resize_viewport", viewportId: "vp-1", size: { x: vp.size.x, y: vp.size.y + 10 }, center: { x: vp.center.x, y: vp.center.y - 5 } }).model;
    const v = el(m, "v-plan", "view");
    expect(v.cropMax.y).toBeCloseTo(CROP.max.y + 10 * 48, 0);
    expect(v.cropMin.y).toBeCloseTo(CROP.min.y, 0);
  });

  test("an older 3D view (plan crop, no saved camera) still resizes its frame by scaling its plan crop evenly", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d", crop: CROP }).model;
    // As saved before 3D views had a camera and a 3D box (a camera view's frame is set by its box instead; see view-3d-sheet.test.ts).
    const made = el(m, "v-3d", "view");
    const { camera3d: _camera, cropBox3d: _box, ...older } = made.props ?? {};
    m = { ...m, elements: { ...m.elements, "v-3d": { ...made, props: older } } };
    m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" }).model;
    m = commit(m, { type: "place_viewport", viewportId: "vp-3d", sheetId: "s-1", viewId: "v-3d", center: { x: 300, y: 250 } }).model;
    const vp = el(m, "vp-3d", "viewport");
    m = commit(m, { type: "resize_viewport", viewportId: "vp-3d", size: { x: vp.size.x * 2, y: vp.size.y * 2 } }).model;
    const v = el(m, "v-3d", "view");
    expect(v.cropMax.x - v.cropMin.x).toBeCloseTo(80 * FT, -1);
    expect(v.cropMax.y - v.cropMin.y).toBeCloseTo(60 * FT, -1);
  });
});

describe("printing respects the crop", () => {
  type Prim = ReturnType<typeof buildSheetSceneFor>["primitives"][number];
  const inFrame = (p: Prim, e: ReturnType<typeof edges>, pad = 0.01) => {
    const textBox = (t: Extract<Prim, { kind: "text" }>) => {
      const w = t.text.length * t.size * TEXT_WIDTH_PER_CHAR;
      const x0 = t.anchor === "start" ? t.at.x : t.anchor === "middle" ? t.at.x - w / 2 : t.at.x - w;
      return [{ x: x0, y: t.at.y - t.size }, { x: x0 + w, y: t.at.y }];
    };
    const pts = p.kind === "line" ? [p.a, p.b] : p.kind === "text" ? textBox(p) : p.kind === "fill" ? p.points : [p.at, { x: p.at.x + p.size.x, y: p.at.y + p.size.y }];
    return pts.every((q) => q.x >= e.left - pad && q.x <= e.right + pad && q.y >= e.top - pad && q.y <= e.bottom + pad);
  };

  test("a tight crop leaves no model linework or text outside the frame; the boundary itself is not printed", () => {
    let m = placedPlan();
    m = commit(m, { type: "set_view_crop", viewId: "v-plan", crop: { min: { x: 19.5 * FT, y: -3 * FT }, max: { x: 30 * FT, y: 12 * FT } } }).model;
    const e = edges(m, "vp-1");
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    // The viewport's own content: everything drawn between the sheet border and the viewport title.
    const anchor = (p: Prim) => (p.kind === "line" ? p.a : p.kind === "fill" ? (p.points[0] ?? { x: 0, y: 0 }) : p.at);
    const near = scene.primitives.filter((p) => anchor(p).y < e.bottom + 2 && anchor(p).x < 700 && !(p.kind === "rect" && p.pen === "heavy"));
    expect(near.length).toBeGreaterThan(0);
    for (const p of near) expect(inFrame(p, e)).toBe(true);
    // No rectangle the size of the crop box is drawn.
    expect(scene.primitives.some((p) => p.kind === "rect" && Math.abs(p.size.x - (e.right - e.left)) < 0.5)).toBe(false);
  });
});
