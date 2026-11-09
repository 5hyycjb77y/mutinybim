/**
 * @jest-environment node
 *
 * The shared view input layer: a point in a plan, section or elevation drawing
 * (on its own or through a sheet viewport at its scale and crop) maps to one
 * model point and back, and the drawing picks the elements it draws, by id.
 * Before this, only the 3D viewer could turn a pointer into a model point, and
 * it cast onto a horizontal floor, so a section had no correct mapping at all.
 */
import {
  BUILTIN_PART_TYPES,
  DEFAULT_SETTINGS,
  buildViewPickIndex,
  buildViewScene,
  clientToPaper,
  frameForViewport,
  modelToPaperPoint,
  paperDeltaToModel,
  paperToClient,
  paperToModelPoint,
  pickAt,
  pickInBox,
  planCommit,
  viewMapping,
  viewOnPaper,
  viewportOnPaper,
  viewportUnder,
  type BimElement,
  type Command,
  type CommandRequest,
  type ModelState,
  type RunPoint,
  type Sheet,
  type ViewElement,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-20T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const DIFFUSER = BUILTIN_PART_TYPES.find((t) => t.id === "builtin:supply-diffuser-24@1");

let seq = 0;
function apply(m: ModelState, command: Command): ModelState {
  seq += 1;
  const req: CommandRequest = { idempotencyKey: `vm-${seq}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command };
  const d = planCommit(m, [], req, NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function view(m: ModelState, id: string): ViewElement {
  const v = m.elements[id];
  if (v?.kind !== "view") throw new Error(`${id} is not a view`);
  return v;
}

function close(a: RunPoint | null, b: RunPoint, tol = 1e-6) {
  expect(a).not.toBeNull();
  if (!a) return;
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
  expect(Math.abs(a.z - b.z)).toBeLessThan(tol);
}

/** Level 1 at 0 and Level 2 at 12', a trunk east along y = 10' at 9' up, a diffuser, a plan, a section across the trunk and a sheet. */
function project(): ModelState {
  let m: ModelState = { modelId: "vm", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = apply(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = apply(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT });
  m = apply(m, { type: "route_run", idPrefix: "t", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 9 * FT, system: SA, points: [{ x: 0, y: 10 * FT }, { x: 40 * FT, y: 10 * FT }] });
  if (!DIFFUSER) throw new Error("builtin diffuser missing");
  m = apply(m, { type: "place_part", partId: "d1", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 20 * FT }, offsetMm: 8 * FT });
  m = apply(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 50 * FT, y: 30 * FT } }, props: { level: "Level 1", scale: 48 } });
  // Looking north across the trunk: the cut runs west → east along y = 0, direction +1 looks to the left of start→end (north).
  m = apply(m, {
    type: "create_view",
    viewId: "v-sec",
    name: "Section A",
    viewType: "section",
    props: { level: "Level 1", scale: 48, section: { start: { x: -5 * FT, y: 0 }, end: { x: 50 * FT, y: 0 }, direction: 1, depthMm: 30 * FT } },
  });
  m = apply(m, { type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Mechanical plan" });
  m = apply(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 }, scale: 96 });
  m = apply(m, { type: "place_viewport", viewportId: "vp-sec", sheetId: "s-m101", viewId: "v-sec", center: { x: 600, y: 450 }, scale: 48 });
  return m;
}

const trunkId = (m: ModelState) => Object.values(m.elements).find((e): e is Extract<BimElement, { kind: "run_segment" }> => e.kind === "run_segment")?.id ?? "";

describe("view mapping", () => {
  const m = project();

  test("plan: drawing u, v is model x, y; elevation comes from the depth choice, default the floor", () => {
    const map = viewMapping(m, view(m, "v-plan"));
    expect(map.kind).toBe("plan");
    expect(map.modelReason).toBeNull();
    close(map.toModel({ x: 1000, y: 2000 }), { x: 1000, y: 2000, z: 0 });
    close(map.toModel({ x: 1000, y: 2000 }, { elevationMm: 9 * FT }), { x: 1000, y: 2000, z: 9 * FT });
    const p = { x: 123, y: 456, z: 789 };
    const d = map.toDrawing(p);
    close(map.toModel({ x: d.u, y: d.v }, map.depthOf(p)), p);
    close(map.deltaToModel({ x: 10, y: -20 }), { x: 10, y: -20, z: 0 });
  });

  test("section: u along the cut, v elevation; depth beyond the line; a drag up is a rise", () => {
    const map = viewMapping(m, view(m, "v-sec"));
    expect(map.kind).toBe("section");
    expect(map.axis).toEqual({ x: 1, y: 0 });
    expect(map.look).toEqual({ x: -0, y: 1 });
    // 10' along the cut from its start (x = -5'), 9' up, on the trunk's line 10' beyond the cut.
    close(map.toModel({ x: 15 * FT, y: 9 * FT }, { depthMm: 10 * FT }), { x: 10 * FT, y: 10 * FT, z: 9 * FT });
    const p = { x: 7 * FT, y: 4 * FT, z: 3 * FT };
    const d = map.toDrawing(p);
    expect(d.v).toBeCloseTo(3 * FT);
    expect(d.depth).toBeCloseTo(-4 * FT);
    close(map.toModel({ x: d.u, y: d.v }, map.depthOf(p)), p);
    close(map.deltaToModel({ x: 2 * FT, y: 3 * FT }), { x: 2 * FT, y: 0, z: 3 * FT });
  });

  test("elevation (a section looking west, made by the orientation control): u runs south → north", () => {
    const m2 = apply(m, {
      type: "create_view",
      viewId: "v-east",
      name: "East elevation",
      viewType: "section",
      props: { scale: 48, section: { start: { x: 60 * FT, y: -5 * FT }, end: { x: 60 * FT, y: 40 * FT }, direction: 1, depthMm: 80 * FT } },
    });
    const map = viewMapping(m2, view(m2, "v-east"));
    expect(map.axis).toEqual({ x: 0, y: 1 });
    expect(map.look?.x).toBeCloseTo(-1);
    close(map.deltaToModel({ x: 1000, y: 0 }), { x: 0, y: 1000, z: 0 });
    const p = { x: 30 * FT, y: 12 * FT, z: 2000 };
    const d = map.toDrawing(p);
    close(map.toModel({ x: d.u, y: d.v }, map.depthOf(p)), p);
    expect(map.depthOf(p).depthMm).toBeCloseTo(30 * FT);
  });

  test("3D, detail and schedule views say in plain words why a point can't be taken", () => {
    let m2 = apply(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d", props: { level: "Level 1" } });
    m2 = apply(m2, { type: "create_view", viewId: "v-det", name: "Detail 1", viewType: "detail" });
    expect(viewMapping(m2, view(m2, "v-3d")).toModel({ x: 0, y: 0 })).toBeNull();
    expect(viewMapping(m2, view(m2, "v-3d")).modelReason).toMatch(/isometric/)
    expect(viewMapping(m2, view(m2, "v-det")).modelReason).toMatch(/drawing only/);
  });
});

describe("paper and sheet viewports", () => {
  const m = project();

  test("the view on its own: paper ↔ model round trip, and the crop window bounds what can be taken", () => {
    const { frame } = buildViewScene(m, "v-plan");
    const vop = viewOnPaper(m, view(m, "v-plan"), frame);
    const p = { x: 12 * FT, y: 7 * FT, z: 0 };
    close(paperToModelPoint(vop, modelToPaperPoint(vop, p)), p, 1e-6);
    // Far outside the 50' × 30' crop.
    expect(paperToModelPoint(vop, modelToPaperPoint(vop, { x: 500 * FT, y: 0, z: 0 }))).toBeNull();
  });

  test("a sheet viewport at 1/8\" scale: one paper mm is 96 model mm, and screen pixels compose through the paper", () => {
    const sheet = m.elements["s-m101"] as Sheet;
    const vp = m.elements["vp-plan"];
    if (vp?.kind !== "viewport") throw new Error("viewport missing");
    const vop = viewportOnPaper(m, vp, view(m, "v-plan"));
    expect(vop.frame.scale).toBe(96);
    const a = modelToPaperPoint(vop, { x: 10 * FT, y: 10 * FT, z: 0 });
    const b = modelToPaperPoint(vop, { x: 10 * FT + 960, y: 10 * FT, z: 0 });
    expect(b.x - a.x).toBeCloseTo(10);
    // Paper y runs down; model y runs north.
    const c = modelToPaperPoint(vop, { x: 10 * FT, y: 10 * FT + 960, z: 0 });
    expect(c.y - a.y).toBeCloseTo(-10);
    const screen = { left: 100, top: 50, width: 1830, height: 1220 };
    const paper = { x: 914.4, y: 609.6 };
    const px = paperToClient(screen, paper, a);
    const back = paperToModelPoint(vop, clientToPaper(screen, paper, px));
    close(back, { x: 10 * FT, y: 10 * FT, z: 0 }, 1e-6);
    expect(viewportUnder(m, sheet, a)?.view.id).toBe("v-plan");
    expect(viewportUnder(m, sheet, { x: 2, y: 2 })).toBeNull();
  });

  test("cropping the view through the viewport keeps the scale and moves the window", () => {
    const m2 = apply(m, { type: "resize_viewport", viewportId: "vp-plan", size: { x: 60, y: 40 } });
    const vp = m2.elements["vp-plan"];
    if (vp?.kind !== "viewport") throw new Error("viewport missing");
    const vop = viewportOnPaper(m2, vp, view(m2, "v-plan"));
    expect(vop.frame.scale).toBe(96);
    expect((vop.window.max.x - vop.window.min.x) / 96).toBeCloseTo(60, 0);
    const inside = { x: (vop.window.min.x + vop.window.max.x) / 2, y: (vop.window.min.y + vop.window.max.y) / 2, z: 0 };
    close(paperToModelPoint(vop, modelToPaperPoint(vop, inside)), inside, 1e-6);
  });

  test("a true-north plan turns on paper; points and drags still land where the model is", () => {
    let m2 = apply(m, { type: "set_true_north", angleDeg: 30 });
    m2 = apply(m2, { type: "set_view_properties", viewId: "v-plan", props: { orientation: "true_north" } });
    const vp = m2.elements["vp-plan"];
    if (vp?.kind !== "viewport") throw new Error("viewport missing");
    const vop = viewportOnPaper(m2, vp, view(m2, "v-plan"));
    expect(frameForViewport(m2, vp, view(m2, "v-plan")).rotationDeg).toBeCloseTo(30);
    const p = { x: 10 * FT, y: 12 * FT, z: 0 };
    close(paperToModelPoint(vop, modelToPaperPoint(vop, p)), p, 1e-6);
    // A drag straight right on paper is not due east in the model any more.
    const from = modelToPaperPoint(vop, p);
    const d = paperDeltaToModel(vop, from, { x: from.x + 10, y: from.y });
    expect(d).not.toBeNull();
    expect(Math.hypot(d?.x ?? 0, d?.y ?? 0)).toBeCloseTo(960);
    expect(Math.abs(d?.y ?? 0)).toBeGreaterThan(100);
  });

  test("a section viewport: a drag up on paper raises the point", () => {
    const vp = m.elements["vp-sec"];
    if (vp?.kind !== "viewport") throw new Error("viewport missing");
    const vop = viewportOnPaper(m, vp, view(m, "v-sec"));
    const d = paperDeltaToModel(vop, { x: 600, y: 450 }, { x: 600, y: 440 });
    close(d, { x: 0, y: 0, z: 480 }, 1e-6);
  });
});

describe("picking in a drawing", () => {
  const m = project();
  const trunk = trunkId(m);

  test("plan: the trunk and the diffuser are under the pointer where they draw; the diffuser wins over the duct", () => {
    const index = buildViewPickIndex(m, view(m, "v-plan"));
    expect(pickAt(index, { x: 15 * FT, y: 10 * FT }, 50)).toEqual([trunk]);
    expect(pickAt(index, { x: 15 * FT, y: 10 * FT + 7 * IN - 5 }, 0)).toEqual([trunk]);
    expect(pickAt(index, { x: 15 * FT, y: 10 * FT + 9 * IN }, 0)).toEqual([]);
    expect(pickAt(index, { x: 20 * FT, y: 20 * FT }, 10)[0]).toBe("d1");
  });

  test("section: the trunk shows as its cut-through outline at 9' up; nothing at the floor there", () => {
    const index = buildViewPickIndex(m, view(m, "v-sec"));
    // u = 15' along the cut (x = 10'), the trunk's 10" height centred at 9'.
    expect(pickAt(index, { x: 15 * FT, y: 9 * FT }, 0)).toContain(trunk);
    expect(pickAt(index, { x: 15 * FT, y: 1 * FT }, 0)).toEqual([]);
  });

  test("section depth: a section that stops short of the trunk can't pick it", () => {
    const m2 = apply(m, { type: "set_view_crop", viewId: "v-sec", farClipMm: 5 * FT });
    const index = buildViewPickIndex(m2, view(m2, "v-sec"));
    expect(pickAt(index, { x: 15 * FT, y: 9 * FT }, 0)).toEqual([]);
  });

  test("box: window keeps what is fully inside, crossing what it touches", () => {
    const index = buildViewPickIndex(m, view(m, "v-plan"));
    const a = { x: 10 * FT, y: 5 * FT };
    const b = { x: 30 * FT, y: 25 * FT };
    expect(pickInBox(index, a, b, "window")).toEqual(["d1"]);
    expect(new Set(pickInBox(index, a, b, "crossing"))).toEqual(new Set(["d1", trunk]));
  });

  test("hidden categories and other levels don't pick", () => {
    const m2 = apply(m, { type: "set_view_properties", viewId: "v-plan", props: { hiddenCategories: ["duct"] } });
    const index = buildViewPickIndex(m2, view(m2, "v-plan"));
    expect(pickAt(index, { x: 15 * FT, y: 10 * FT }, 50)).toEqual([]);
    const m3 = apply(m, { type: "set_view_properties", viewId: "v-plan", props: { level: "Level 2" } });
    expect(pickAt(buildViewPickIndex(m3, view(m3, "v-plan")), { x: 15 * FT, y: 10 * FT }, 50)).toEqual([]);
  });

  test("updating after an edit re-measures only what changed, and gives the same answers as a rebuild", () => {
    const before = buildViewPickIndex(m, view(m, "v-plan"));
    const moved = apply(m, { type: "move_elements", ids: ["d1"], delta: { x: 5 * FT, y: 0 } });
    const updated = buildViewPickIndex(moved, view(moved, "v-plan"), before);
    const rebuilt = buildViewPickIndex(moved, view(moved, "v-plan"));
    for (const q of [{ x: 20 * FT, y: 20 * FT }, { x: 25 * FT, y: 20 * FT }, { x: 15 * FT, y: 10 * FT }]) expect(pickAt(updated, q, 10)).toEqual(pickAt(rebuilt, q, 10));
    expect(pickAt(updated, { x: 25 * FT, y: 20 * FT }, 10)[0]).toBe("d1");
    expect(updated.footprints.get(trunk)).toBe(before.footprints.get(trunk));
  });
});
