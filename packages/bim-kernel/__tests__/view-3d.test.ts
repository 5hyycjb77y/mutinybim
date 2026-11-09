/**
 * @jest-environment node
 *
 * Saved 3D views and 3D crop boxes: the box math (oriented planes, face push,
 * fit to a selection grown out to levels and grid lines), and the commands
 * through planCommit (validated, attributed, idempotent on replay, undoable
 * with restore_document_elements).
 */
import {
  CROP_FACES,
  applyChangeset,
  asElementId,
  boxCorners,
  boxForRegion,
  boxKeepPlanes,
  boxPlanRect,
  commandSchema,
  executeCommand,
  faceCenter,
  faceSnapOffsets,
  insideBox,
  isKind,
  planCommit,
  pushFace,
  toDocumentRecord,
  viewCropBox3d,
  workingViewOf,
  documentIndex,
  type BimElement,
  type Changeset,
  type CommandRequest,
  type CropBox3d,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const FT = 304.8;
const NOW = () => "2026-10-20T00:00:00.000Z";
const avery = { id: "avery", name: "Avery", kind: "human" as const };
let keySeq = 0;

function req(head: ModelState, command: RawCommand): CommandRequest {
  keySeq += 1;
  return { idempotencyKey: `v3d-key-${keySeq}`, baseRevision: head.revision, actor: avery, command: commandSchema.parse(command) };
}

function commit(head: ModelState, command: RawCommand): { model: ModelState; changeset: Changeset } {
  const d = planCommit(head, [], req(head, command), NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return { model: d.model, changeset: d.changeset };
}

function refusal(head: ModelState, command: RawCommand): string {
  const r = executeCommand(head, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

function view(model: ModelState, id: string) {
  const found = model.elements[id];
  if (!found || !isKind(found, "view")) throw new Error(`${id} is not a view`);
  return found;
}

/** The demo ductwork with Level 1 at 0 and Level 2 at 14 ft. */
function withLevels(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).model;
  m = commit(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 14 * FT }).model;
  return m;
}

const box = (rotationDeg = 0): CropBox3d => ({ center: { x: 1000, y: 2000, z: 1500 }, halfSize: { x: 500, y: 300, z: 1500 }, rotationDeg });

describe("crop box math", () => {
  test("each keep plane passes through its face and keeps the centre", () => {
    for (const rot of [0, 30, -115]) {
      const b = box(rot);
      const planes = boxKeepPlanes(b);
      CROP_FACES.forEach((face, i) => {
        const pl = planes[i];
        const { point } = faceCenter(b, face);
        if (!pl) throw new Error("missing plane");
        expect(pl.normal.x * point.x + pl.normal.y * point.y + pl.normal.z * point.z + pl.constant).toBeCloseTo(0, 6);
        expect(pl.normal.x * b.center.x + pl.normal.y * b.center.y + pl.normal.z * b.center.z + pl.constant).toBeGreaterThan(0);
      });
      for (const c of boxCorners(b)) expect(insideBox(b, c, 1e-6)).toBe(true);
    }
  });

  test("a turned box keeps what lies along its turned axis and drops what the unturned box would keep", () => {
    const b = box(45);
    // 450 mm along the box's own x axis (turned 45°): inside.
    const along = { x: 1000 + 450 * Math.SQRT1_2, y: 2000 + 450 * Math.SQRT1_2, z: 1500 };
    expect(insideBox(b, along)).toBe(true);
    // 450 mm due east: inside the unturned box, outside the turned one (its y half is 300).
    expect(insideBox(box(0), { x: 1450, y: 2000, z: 1500 })).toBe(true);
    expect(insideBox(b, { x: 1450, y: 2000, z: 1500 })).toBe(false);
  });

  test("pushing one face moves only that face; Shift (symmetric) moves both and keeps the centre", () => {
    const b = box(0);
    const one = pushFace(b, "x+", 200);
    expect(faceCenter(one, "x+").point.x).toBeCloseTo(1700, 6);
    expect(faceCenter(one, "x-").point.x).toBeCloseTo(500, 6);
    const both = pushFace(b, "x+", 200, true);
    expect(faceCenter(both, "x+").point.x).toBeCloseTo(1700, 6);
    expect(faceCenter(both, "x-").point.x).toBeCloseTo(300, 6);
    expect(both.center.x).toBe(1000);
    // Never thinner than 1 in.
    const crushed = pushFace(b, "z+", -10_000);
    expect(crushed.halfSize.z * 2).toBeCloseTo(25.4, 3);
    expect(faceCenter(crushed, "z-").point.z).toBeCloseTo(0, 6);
  });

  test("a top face snaps to the levels it passes", () => {
    const m = withLevels();
    const offsets = faceSnapOffsets(m, box(0), "z+");
    // Top face at 3000; Level 2 at 14 ft is 1267.2 above it, Level 1 is 3000 below.
    expect(offsets.map((o) => Math.round(o * 10) / 10).sort((a, b) => a - b)).toEqual([-3000, 1267.2]);
  });
});

describe("fit to a selection grows out to the model's datums", () => {
  test("from the floor the selection sits on to the next level above it", () => {
    const m = withLevels();
    const fitted = boxForRegion(m, { min: { x: 3 * FT, y: 2 * FT, z: 9 * FT }, max: { x: 7.5 * FT, y: 4.2 * FT, z: 10 * FT } });
    const lo = fitted.center.z - fitted.halfSize.z;
    const hi = fitted.center.z + fitted.halfSize.z;
    expect(lo).toBeCloseTo(0, 3);
    expect(hi).toBeCloseTo(14 * FT, 3);
    // No grid lines: out to the 10 ft planning lines around it, not a fixed margin.
    const plan = boxPlanRect(fitted);
    expect(plan.min.x).toBeCloseTo(0, 3);
    expect(plan.max.x).toBeCloseTo(10 * FT, 3);
    expect(plan.max.y).toBeCloseTo(10 * FT, 3);
  });

  test("in plan, out to the grid lines beyond each side", () => {
    const m0 = withLevels();
    const grid = (id: string, start: { x: number; y: number }, end: { x: number; y: number }): BimElement => ({ id: asElementId(id), version: 1, authoredRev: {}, kind: "grid", label: id, start, end });
    const m: ModelState = {
      ...m0,
      elements: {
        ...m0.elements,
        "g-a": grid("g-a", { x: 0, y: -100 * FT }, { x: 0, y: 100 * FT }),
        "g-b": grid("g-b", { x: 25 * FT, y: -100 * FT }, { x: 25 * FT, y: 100 * FT }),
        "g-1": grid("g-1", { x: -100 * FT, y: -10 * FT }, { x: 100 * FT, y: -10 * FT }),
        "g-2": grid("g-2", { x: -100 * FT, y: 20 * FT }, { x: 100 * FT, y: 20 * FT }),
      },
    };
    const plan = boxPlanRect(boxForRegion(m, { min: { x: 3 * FT, y: 2 * FT, z: 9 * FT }, max: { x: 7 * FT, y: 4 * FT, z: 10 * FT } }));
    expect(plan.min).toEqual({ x: 0, y: -10 * FT });
    expect(plan.max.x).toBeCloseTo(25 * FT, 3);
    expect(plan.max.y).toBeCloseTo(20 * FT, 3);
  });

  test("a grid line a building away is another bay's: the side goes to the next planning line instead", () => {
    const m0 = withLevels();
    const far: BimElement = { id: asElementId("g-far"), version: 1, authoredRev: {}, kind: "grid", label: "Z", start: { x: 1400 * FT, y: -100 * FT }, end: { x: 1400 * FT, y: 100 * FT } };
    const m: ModelState = { ...m0, elements: { ...m0.elements, "g-far": far } };
    const plan = boxPlanRect(boxForRegion(m, { min: { x: 3 * FT, y: 2 * FT, z: 9 * FT }, max: { x: 7.5 * FT, y: 4 * FT, z: 10 * FT } }));
    expect(plan.max.x).toBeCloseTo(10 * FT, 3);
  });
});

describe("saved 3D view commands", () => {
  test("create_3d_view of a selection: pre-cropped to the trunk's storey, with a camera on the box", () => {
    const m0 = withLevels();
    const { model: m, changeset } = commit(m0, { type: "create_3d_view", viewId: "v-3d", name: "Trunk 3D", fit: { elementIds: ["seg-trunk"] }, projection: "orthographic" });
    const v = view(m, "v-3d");
    expect(v.viewType).toBe("three_d");
    expect(v.props?.projection).toBe("orthographic");
    const b = v.props?.cropBox3d;
    if (!b) throw new Error("no box");
    expect(b.center.z - b.halfSize.z).toBeCloseTo(0, 3);
    expect(b.center.z + b.halfSize.z).toBeCloseTo(14 * FT, 3);
    // The plan crop follows the box, so the old plan-crop readers (and sheets) agree with it.
    expect({ min: v.cropMin, max: v.cropMax }).toEqual(boxPlanRect(b));
    const cam = v.props?.camera3d;
    if (!cam) throw new Error("no camera");
    expect(cam.target).toEqual(b.center);
    expect(cam.eye.x).toBeLessThan(cam.target.x);
    expect(cam.eye.z).toBeGreaterThan(cam.target.z);
    expect(changeset.elements.map((e) => e.id)).toContain("v-3d");
  });

  test("create_view three_d (the existing path) also gets a box and a camera", () => {
    const m0 = withLevels();
    const m = commit(m0, { type: "create_view", viewId: "v-legacy", name: "3D", viewType: "three_d", crop: { min: { x: 0, y: -10 * FT }, max: { x: 50 * FT, y: 30 * FT } } }).model;
    const v = view(m, "v-legacy");
    expect(boxPlanRect(v.props?.cropBox3d ?? box())).toEqual({ min: v.cropMin, max: v.cropMax });
    expect(v.props?.camera3d).toBeDefined();
  });

  test("a legacy 3D view with only a plan crop crops at every storey", () => {
    const m = withLevels();
    const legacy = { viewType: "three_d" as const, cropMin: { x: 0, y: 0 }, cropMax: { x: 10 * FT, y: 10 * FT }, props: {} };
    const b = viewCropBox3d(m, legacy);
    if (!b) throw new Error("no box");
    expect(b.center.z - b.halfSize.z).toBeLessThan(0);
    expect(b.center.z + b.halfSize.z).toBeGreaterThan(14 * FT);
  });

  test("set_3d_crop_box: resize, turn crop off and on, show or hide the box, reset to the model", () => {
    const m0 = commit(withLevels(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk 3D", fit: { elementIds: ["seg-trunk"] } }).model;
    const resized: CropBox3d = { center: { x: 5000, y: 0, z: 2000 }, halfSize: { x: 2000, y: 1000, z: 2000 }, rotationDeg: 30 };
    const { model: m1, changeset } = commit(m0, { type: "set_3d_crop_box", viewId: "v-3d", box: resized });
    expect(view(m1, "v-3d").props?.cropBox3d).toEqual(resized);
    // Attributed, so a competing edit to the same box conflicts instead of last-write-wins.
    expect(changeset.authored.some((a) => a.elementId === "v-3d" && a.field === "doc.props.cropBox3d")).toBe(true);
    const off = commit(m1, { type: "set_3d_crop_box", viewId: "v-3d", enabled: false, show: false }).model;
    expect(view(off, "v-3d").props?.cropView).toBe(false);
    expect(view(off, "v-3d").props?.showCropBox).toBe(false);
    expect(view(off, "v-3d").props?.cropBox3d).toEqual(resized);
    const reset = commit(off, { type: "set_3d_crop_box", viewId: "v-3d", fit: "model", extent: { min: { x: -1000, y: -2000, z: -300 }, max: { x: 60000, y: 30000, z: 9000 } } }).model;
    const r = view(reset, "v-3d").props?.cropBox3d;
    expect(r?.rotationDeg).toBe(0);
    expect(boxPlanRect(r ?? resized)).toEqual({ min: { x: -1000, y: -2000 }, max: { x: 60000, y: 30000 } });
  });

  test("replaying the same set changes nothing further (idempotent), and a second create is refused", () => {
    const m0 = commit(withLevels(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk 3D", fit: { elementIds: ["seg-trunk"] } }).model;
    const cmd = { type: "set_3d_crop_box", viewId: "v-3d", box: { center: { x: 1, y: 2, z: 3 }, halfSize: { x: 400, y: 400, z: 400 }, rotationDeg: 10 } };
    const once = commit(m0, cmd).model;
    const twice = commit(once, cmd).model;
    const strip = (el: BimElement | undefined) => (el ? { ...el, version: 0, authoredRev: {} } : el);
    expect(strip(twice.elements["v-3d"])).toEqual(strip(once.elements["v-3d"]));
    expect(refusal(once, { type: "create_3d_view", viewId: "v-3d", name: "Again" })).toMatch(/already used/);
  });

  test("undo puts the box, camera and crop back exactly", () => {
    const m0 = commit(withLevels(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk 3D", fit: { elementIds: ["seg-trunk"] } }).model;
    const before = m0.elements["v-3d"];
    if (!before) throw new Error("missing view");
    let m = commit(m0, { type: "set_3d_crop_box", viewId: "v-3d", box: { center: { x: 0, y: 0, z: 0 }, halfSize: { x: 100, y: 100, z: 100 }, rotationDeg: 0 } }).model;
    m = commit(m, { type: "set_3d_view_camera", viewId: "v-3d", camera: { eye: { x: 9000, y: 9000, z: 9000 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 2 }, fovDeg: 30, orthoHeightMm: 5000 }, projection: "perspective" }).model;
    expect(view(m, "v-3d").props?.camera3d?.up).toEqual({ x: 0, y: 0, z: 1 });
    const current = m.elements["v-3d"];
    if (!current) throw new Error("missing view");
    const undone = commit(m, { type: "restore_document_elements", items: [{ elementId: "v-3d", before: toDocumentRecord(before), expectedVersion: current.version }] }).model;
    const v = view(undone, "v-3d");
    const b = view(m0, "v-3d");
    expect(v.props?.cropBox3d).toEqual(b.props?.cropBox3d);
    expect(v.props?.camera3d).toEqual(b.props?.camera3d);
    expect(v.cropMin).toEqual(b.cropMin);
  });

  test("a placed 3D view's viewport follows its box; a new plan crop stretches the box", () => {
    let m = commit(withLevels(), { type: "create_3d_view", viewId: "v-3d", name: "Trunk 3D", fit: { elementIds: ["seg-trunk"] } }).model;
    m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-301", name: "Isometrics" }).model;
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-3d", center: { x: 400, y: 300 } }).model;
    const vp0 = m.elements["vp-1"];
    if (!vp0 || vp0.kind !== "viewport") throw new Error("no viewport");
    const grown = view(m, "v-3d").props?.cropBox3d;
    if (!grown) throw new Error("no box");
    const m1 = commit(m, { type: "set_3d_crop_box", viewId: "v-3d", box: pushFace(grown, "x+", 20 * FT) }).model;
    const vp1 = m1.elements["vp-1"];
    if (!vp1 || vp1.kind !== "viewport") throw new Error("no viewport");
    expect(vp1.size.x).toBeGreaterThan(vp0.size.x);
    // Dragging the frame is refused (the frame is the box seen from the camera); a plan crop sent the old way still moves the box.
    expect(refusal(m1, { type: "resize_viewport", viewportId: "vp-1", size: { x: vp1.size.x / 2, y: vp1.size.y / 2 } })).toMatch(/Change the box/);
    const v1 = view(m1, "v-3d");
    const m2 = commit(m1, { type: "set_view_crop", viewId: "v-3d", crop: { min: v1.cropMin, max: { x: (v1.cropMin.x + v1.cropMax.x) / 2, y: v1.cropMax.y } } }).model;
    const b2 = view(m2, "v-3d").props?.cropBox3d;
    const v2 = view(m2, "v-3d");
    expect(boxPlanRect(b2 ?? grown).min.x).toBeCloseTo(v2.cropMin.x, 0);
    expect(boxPlanRect(b2 ?? grown).max.y).toBeCloseTo(v2.cropMax.y, 0);
    expect(b2?.halfSize.z).toBe(view(m1, "v-3d").props?.cropBox3d?.halfSize.z);
  });

  test("working 3D views: one per person, never on a sheet, a duplicate is an ordinary view", () => {
    let m = commit(withLevels(), { type: "create_3d_view", viewId: "w-avery", name: "{3D - Avery}", workingFor: "avery" }).model;
    expect(workingViewOf(documentIndex(m).views, "avery")?.id).toBe("w-avery");
    expect(refusal(m, { type: "create_3d_view", viewId: "w-2", name: "{3D - Avery} 2", workingFor: "avery" })).toMatch(/already has a working 3D view/);
    m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-301", name: "Isometrics" }).model;
    expect(refusal(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "w-avery", center: { x: 400, y: 300 } })).toMatch(/working 3D view/);
    m = commit(m, { type: "duplicate_view", viewId: "w-avery", newViewId: "v-copy", name: "Mechanical room 3D" }).model;
    expect(view(m, "v-copy").props?.workingFor).toBeUndefined();
    expect(view(m, "v-copy").props?.cropBox3d).toEqual(view(m, "w-avery").props?.cropBox3d);
  });

  test("refusals say what to do in plain words", () => {
    let m = withLevels();
    m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1", viewType: "floor_plan", props: { level: "Level 1" } }).model;
    expect(refusal(m, { type: "set_3d_crop_box", viewId: "v-plan", enabled: true })).toMatch(/not a 3D view/);
    m = commit(m, { type: "create_3d_view", viewId: "v-3d", name: "3D" }).model;
    expect(refusal(m, { type: "set_3d_crop_box", viewId: "v-3d" })).toMatch(/Nothing to change/);
    expect(refusal(m, { type: "set_3d_crop_box", viewId: "v-3d", fit: "selection", elementIds: ["nope"] })).toMatch(/None of those elements/);
    expect(refusal(m, { type: "set_3d_view_camera", viewId: "v-3d", camera: { eye: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 100 } })).toMatch(/somewhere other than/);
  });

  test("the commands batch with other views and sheets steps", () => {
    const m0 = withLevels();
    const { model: m } = commit(m0, {
      type: "batch_documents",
      label: "Isometric of the trunk on a sheet",
      commands: [
        { type: "create_3d_view", viewId: "v-iso", name: "Trunk isometric", fit: { elementIds: ["seg-trunk"] }, projection: "orthographic" },
        { type: "create_sheet", sheetId: "s-iso", number: "M-501", name: "Isometrics" },
        { type: "place_viewport", viewportId: "vp-iso", sheetId: "s-iso", viewId: "v-iso", center: { x: 400, y: 300 } },
      ],
    });
    expect(view(m, "v-iso").props?.cropBox3d).toBeDefined();
    expect(m.elements["vp-iso"]?.kind).toBe("viewport");
    // And the changeset applies cleanly on another replica.
    const replica = applyChangeset(m0, commit(m0, { type: "create_3d_view", viewId: "v-x", name: "X" }).changeset);
    expect(replica.elements["v-x"]?.kind).toBe("view");
  });
});
