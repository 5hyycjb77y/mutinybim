/**
 * @jest-environment node
 *
 * Drawings reported broken in review (Oct 19 2026): a plan cropped around routed
 * ductwork printed an EMPTY viewport, and a section was an outline with a
 * disclaimer. Each block fails on the kernel before this change:
 *
 * - The plan's level is the linked model's storey ("LEVEL 1"); the duct was
 *   routed on the model level "Level 1". Drawing matched levels by exact name,
 *   so nothing on the plan's level existed and the viewport printed empty.
 * - Sections drew a fixed-height box for legacy duct only and ignored routed
 *   runs, fittings and parts; there was no cut geometry, no hidden lines.
 * - Display settings (visual style, hidden lines, line weights, detail level)
 *   did not exist; detail level was stored and ignored.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  DEFAULT_SETTINGS,
  HIDDEN_DASH,
  buildSheetSceneFor,
  buildViewScene,
  commandSchema,
  frameForViewport,
  paperToModel,
  planCommit,
  sceneToSvg,
  sheetDependsOn,
  type ModelState,
  type Primitive,
  type ReferencePlan,
  type SheetReference,
  type Vec2,
  type ViewProps,
} from "@permitzip/bim-kernel";
import { renderSheetPdfWith } from "../src/pdf-core";

const FT = 304.8;
const IN = 25.4;
const MM_TO_PT = 72 / 25.4;
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `drawings-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-19T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

type Line = Extract<Primitive, { kind: "line" }>;
const lines = (prims: readonly Primitive[]): Line[] => prims.filter((p): p is Line => p.kind === "line");
const texts = (prims: readonly Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "text" }> => p.kind === "text");
const fills = (prims: readonly Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "fill" }> => p.kind === "fill");

const SA = { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" };
const TRUNK = { shape: "rect", width: 14 * IN, height: 10 * IN };
const ELEV = 10 * FT;

/**
 * The review screenshot: an L of 14"x10" supply duct at 10 ft on the model level
 * "Level 1" — north leg down to an elbow at the origin, then east 15 ft.
 */
function lModel(): ModelState {
  let m: ModelState = { modelId: "drawings", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "l", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: ELEV, system: SA, points: [{ x: 0, y: 10 * FT }, { x: 0, y: 0 }, { x: 15 * FT, y: 0 }] });
  return m;
}

/** A plan of the linked storey "LEVEL 1" (as the plan dialog offers it), cropped around the L, placed on M-101. */
function placedPlan(props: Partial<ViewProps> = {}, level = "LEVEL 1"): ModelState {
  let m = lModel();
  m = commit(m, {
    type: "create_view",
    viewId: "v-plan",
    name: "Level 1 Mechanical Plan",
    viewType: "floor_plan",
    crop: { min: { x: -6 * FT, y: -6 * FT }, max: { x: 20 * FT, y: 14 * FT } },
    props: { level, levelElevationMm: 0, ...props },
  });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Mechanical plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 300, y: 250 }, scale: 48 });
  return m;
}

function frameEdges(m: ModelState, vpId: string) {
  const vp = m.elements[vpId];
  if (vp?.kind !== "viewport") throw new Error("no viewport");
  const view = m.elements[vp.viewId];
  if (view?.kind !== "view") throw new Error("no view");
  const f = frameForViewport(m, vp, view);
  return { f, left: f.center.x - f.size.x / 2, right: f.center.x + f.size.x / 2, top: f.center.y - f.size.y / 2, bottom: f.center.y + f.size.y / 2 };
}

const inFrame = (l: Line, e: ReturnType<typeof frameEdges>) =>
  [l.a, l.b].every((q) => q.x >= e.left - 0.01 && q.x <= e.right + 0.01 && q.y >= e.top - 0.01 && q.y <= e.bottom + 0.01);

describe("a cropped plan of the linked storey prints the ductwork routed on the model level (the empty viewport)", () => {
  it("draws the L's double lines inside the viewport frame on the sheet", () => {
    const m = placedPlan();
    const e = frameEdges(m, "vp-plan");
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    const vpLines = lines(scene.primitives).filter((l) => inFrame(l, e));
    // East leg: two sides 14" apart, horizontal on paper.
    const east = vpLines.filter((l) => Math.abs(l.a.y - l.b.y) < 1e-6 && Math.abs(l.b.x - l.a.x) > 40);
    const ys = [...new Set(east.map((l) => Math.round(l.a.y * 100) / 100))];
    expect(ys.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo((14 * IN) / 48, 1);
    // North leg: two vertical sides.
    expect(vpLines.filter((l) => Math.abs(l.a.x - l.b.x) < 1e-6 && Math.abs(l.b.y - l.a.y) > 40).length).toBeGreaterThanOrEqual(2);
    // Its size tag prints too.
    expect(texts(scene.primitives).some((t) => t.text === '14x10' || t.text === '14"x10"')).toBe(true);
  });

  it("also matches a storey with a different name on the same floor elevation, and stays empty for another floor", () => {
    const same = placedPlan({}, "01 - First Floor");
    expect(lines(buildSheetSceneFor(same, "s-1", { projectName: "P" }).primitives).filter((l) => inFrame(l, frameEdges(same, "vp-plan"))).length).toBeGreaterThan(4);
    const other = placedPlan({ levelElevationMm: 4 * 3048 }, "LEVEL 5");
    expect(lines(buildSheetSceneFor(other, "s-1", { projectName: "P" }).primitives).filter((l) => inFrame(l, frameEdges(other, "vp-plan"))).length).toBe(0);
  });

  it("the routed duct is a printed dependency of the sheet (print checks it for unsaved edits)", () => {
    const m = placedPlan();
    const depends = sheetDependsOn(m, "s-1");
    const seg = Object.values(m.elements).find((el) => el.kind === "run_segment");
    if (!seg) throw new Error("no segment");
    expect(depends(seg.id, seg)).toBe(true);
  });

  it("the printed PDF strokes the duct inside the viewport", async () => {
    const m = placedPlan();
    const e = frameEdges(m, "vp-plan");
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "t", renderer: "t" }, null);
    const segs = await pdfPaths(pdf.bytes);
    const pageH = scene.paper.y * MM_TO_PT;
    const inside = segs.lines.filter((s) => {
      const xs = [s.x1, s.x2].map((v) => v / MM_TO_PT);
      const ys = [s.y1, s.y2].map((v) => (pageH - v) / MM_TO_PT);
      return xs.every((x) => x >= e.left - 0.05 && x <= e.right + 0.05) && ys.every((y) => y >= e.top - 0.05 && y <= e.bottom + 0.05);
    });
    const eastSides = inside.filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(s.x2 - s.x1) > 40 * MM_TO_PT);
    expect(eastSides.length).toBeGreaterThanOrEqual(2);
  });

  it("the linked model's plan cut prints under the duct, screened, clipped to the crop", () => {
    const m = placedPlan();
    const e = frameEdges(m, "vp-plan");
    const wall: ReferencePlan = {
      id: "arch",
      source: { file: "arch.ifc", sha256: "x" },
      level: { name: "LEVEL 1", elevationMm: 0 },
      cutHeightMm: 1219.2,
      bounds: { min: { x: -50 * FT, y: 3 * FT }, max: { x: 50 * FT, y: 3 * FT } },
      layers: [{ id: "arch:cut:ifcwall", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [-50 * FT, 3 * FT, 50 * FT, 3 * FT] }],
      labels: [],
    };
    const backgrounds: Record<string, readonly SheetReference[]> = { "v-plan": [{ plan: wall, pen: "heavy", tone: "ink" }] };
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P", backgrounds });
    const wallLines = lines(scene.primitives).filter((l) => l.tone === "halftone" && l.pen === "heavy");
    expect(wallLines).toHaveLength(1);
    const w = wallLines[0] as Line;
    expect(inFrame(w, e)).toBe(true);
    expect(Math.abs(w.b.x - w.a.x)).toBeCloseTo(e.right - e.left, 1);
    // Screened background prints before (under) the ductwork.
    const firstDuct = scene.primitives.findIndex((p) => p.kind === "line" && p.tone === undefined && inFrame(p, e));
    expect(scene.primitives.indexOf(w)).toBeLessThan(firstDuct);
  });
});

/** Section A: cut across the east leg at x = 8 ft, looking west (back toward the north leg 8 ft away). */
function sectionModel(props: Partial<ViewProps> = {}): ModelState {
  let m = lModel();
  m = commit(m, {
    type: "create_view",
    viewId: "v-sec",
    name: "Section A",
    viewType: "section",
    props: { level: "LEVEL 1", levelElevationMm: 0, section: { start: { x: 8 * FT, y: -4 * FT }, end: { x: 8 * FT, y: 14 * FT }, direction: 1, depthMm: 10 * FT }, ...props },
  });
  return m;
}

function sectionLinesModel(m: ModelState, viewId = "v-sec") {
  const { scene, frame } = buildViewScene(m, viewId);
  const toModel = (q: Vec2) => paperToModel(frame, q);
  return { scene, frame, toModel, ls: lines(scene.primitives) };
}

describe("sections are real cuts", () => {
  it("a 14x10 duct cut square shows a 14\" x 10\" rectangle centred at its 10'-0\" elevation, crossed", () => {
    const { ls, toModel } = sectionLinesModel(sectionModel());
    const cut = ls.filter((l) => l.pen === "wide").map((l) => [toModel(l.a), toModel(l.b)] as const);
    // Hand check: u is distance along the cut from its start (y = -4 ft), so the duct (y = -7".."+7") sits at u = 4 ft ± 7"; v is elevation 10 ft ± 5".
    const us = cut.flatMap(([a, b]) => [a.x, b.x]);
    const vs = cut.flatMap(([a, b]) => [a.y, b.y]);
    expect(Math.min(...us)).toBeCloseTo(4 * FT - 7 * IN, 0);
    expect(Math.max(...us)).toBeCloseTo(4 * FT + 7 * IN, 0);
    expect(Math.min(...vs)).toBeCloseTo(ELEV - 5 * IN, 0);
    expect(Math.max(...vs)).toBeCloseTo(ELEV + 5 * IN, 0);
    expect(cut).toHaveLength(4);
    // The cross: two thin diagonals corner to corner.
    const diagonals = ls.filter((l) => l.pen === "thin").map((l) => [toModel(l.a), toModel(l.b)] as const).filter(([a, b]) => Math.abs(a.x - b.x) > 300 && Math.abs(a.y - b.y) > 200);
    expect(diagonals).toHaveLength(2);
  });

  it("ductwork beyond draws in projection; where nearer surfaces cover it, it is removed, or dashed with hidden lines shown", () => {
    // An 8x6 duct at 10 ft runs north 11 ft behind the cut (x = -3 ft): the cut duct, its elbow and the north leg all stand in front of it.
    const withBeyond = (props: Partial<ViewProps>) => {
      let m = sectionModel({ ...props, section: { start: { x: 8 * FT, y: -4 * FT }, end: { x: 8 * FT, y: 14 * FT }, direction: 1, depthMm: 14 * FT } });
      m = commit(m, { type: "route_run", idPrefix: "bk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 8 * IN, height: 6 * IN }, elevationMm: ELEV, system: SA, points: [{ x: -3 * FT, y: -4 * FT }, { x: -3 * FT, y: 14 * FT }] });
      return sectionLinesModel(m);
    };
    // Its top edge: v = 10'-3", inside the 14x10's 9'-7"..10'-5" — so the cut shape hides it (not just touches it).
    const topEdge = (r: ReturnType<typeof sectionLinesModel>, dashed: boolean) =>
      r.ls
        .filter((l) => (dashed ? l.dash?.join() === HIDDEN_DASH.join() : !l.dash))
        .map((l) => [r.toModel(l.a), r.toModel(l.b)] as const)
        .filter(([a, b]) => Math.abs(a.y - (ELEV + 3 * IN)) < 1 && Math.abs(b.y - (ELEV + 3 * IN)) < 1 && Math.abs(a.x - b.x) > 10);
    const hiddenRemoved = withBeyond({});
    const solid = topEdge(hiddenRemoved, false);
    // Visible south of the cut duct (u < 4 ft - 7") and north of where the north leg ends (u > 14 ft);
    // between, the cut duct, the elbow and the north leg cover it.
    expect(solid.length).toBeGreaterThanOrEqual(2);
    for (const [a, b] of solid) expect(Math.max(a.x, b.x) <= 4 * FT - 7 * IN + 1 || Math.min(a.x, b.x) >= 14 * FT - 1).toBe(true);
    expect(topEdge(hiddenRemoved, true)).toHaveLength(0);
    const shown = withBeyond({ showHiddenLines: true });
    const dashed = topEdge(shown, true);
    expect(dashed.some(([a, b]) => Math.min(a.x, b.x) <= 4 * FT - 7 * IN + 1 && Math.max(a.x, b.x) >= 4 * FT + 7 * IN - 1)).toBe(true);
  });

  it("level datum lines carry their name and elevation; no outline disclaimer", () => {
    const { scene } = sectionLinesModel(sectionModel());
    const t = texts(scene.primitives).map((x) => x.text);
    expect(t).toContain("LEVEL 1  EL. 0'-0\"");
    expect(t.some((x) => x.startsWith("OUTLINE SECTION"))).toBe(false);
  });

  it("cut pattern: solid fills the cut shape; hatch draws 45° lines inside it", () => {
    const solid = buildViewScene(sectionModel({ cutPattern: "solid" }), "v-sec").scene;
    expect(fills(solid.primitives).some((f) => f.grey < 0.3)).toBe(true);
    const { ls, toModel } = sectionLinesModel(sectionModel({ cutPattern: "hatch" }));
    const hatch = ls.filter((l) => l.pen === "thin").map((l) => [toModel(l.a), toModel(l.b)] as const).filter(([a, b]) => Math.abs(Math.abs(b.x - a.x) - Math.abs(b.y - a.y)) < 1 && Math.abs(a.x - b.x) > 5);
    expect(hatch.length).toBeGreaterThan(3);
  });

  it("prints to PDF as vector paths", async () => {
    let m = sectionModel();
    m = commit(m, { type: "create_sheet", sheetId: "s-2", number: "M-301", name: "Sections" });
    m = commit(m, { type: "place_viewport", viewportId: "vp-sec", sheetId: "s-2", viewId: "v-sec", center: { x: 300, y: 250 }, scale: 24 });
    const scene = buildSheetSceneFor(m, "s-2", { projectName: "P" });
    const pdf = await renderSheetPdfWith(scene, { title: "M-301", modelRevision: scene.revision, snapshotSha256: "t", renderer: "t" }, null);
    const { lines: segs } = await pdfPaths(pdf.bytes);
    // The cut rectangle's 14" sides at 1/2" = 1'-0": 14 * 25.4 / 24 mm.
    const side = ((14 * IN) / 24) * MM_TO_PT;
    expect(segs.filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - side) < 0.05).length).toBeGreaterThanOrEqual(2);
  });
});

describe("display settings change the drawing", () => {
  const planLines = (props: Partial<ViewProps>) => {
    const m = placedPlan(props);
    return { ls: lines(buildViewScene(m, "v-plan").scene.primitives), scene: buildViewScene(m, "v-plan").scene };
  };
  const eastRows = (ls: Line[]) => [...new Set(ls.filter((l) => Math.abs(l.a.y - l.b.y) < 1e-6 && Math.abs(l.b.x - l.a.x) > 40).map((l) => Math.round(l.a.y * 100) / 100))];

  it("coarse detail draws duct single-line (its centreline); medium draws both sides", () => {
    expect(eastRows(planLines({ detailLevel: "medium" }).ls)).toHaveLength(2);
    const coarse = eastRows(planLines({ detailLevel: "coarse" }).ls);
    expect(coarse).toHaveLength(1);
    const medium = eastRows(planLines({ detailLevel: "medium" }).ls);
    expect(coarse[0]).toBeCloseTo(((medium[0] ?? 0) + (medium[1] ?? 0)) / 2, 1);
  });

  it("shaded fills the duct's top surface; shaded with edges adds its lines; wireframe and hidden line fill nothing", () => {
    expect(fills(planLines({ visualStyle: "shaded" }).scene.primitives).length).toBeGreaterThan(0);
    expect(eastRows(planLines({ visualStyle: "shaded" }).ls)).toHaveLength(0);
    expect(eastRows(planLines({ visualStyle: "shaded_edges" }).ls)).toHaveLength(2);
    expect(fills(planLines({ visualStyle: "hidden_line" }).scene.primitives)).toHaveLength(0);
    expect(fills(planLines({ visualStyle: "wireframe" }).scene.primitives)).toHaveLength(0);
    // The SVG preview carries the same fills.
    expect(sceneToSvg(planLines({ visualStyle: "shaded" }).scene)).toContain("<polygon");
  });

  it("line weights by category: duct drawn heavy when the view says so", () => {
    expect(planLines({ lineWeights: { duct: { projection: "heavy" } } }).ls.filter((l) => l.pen === "heavy").length).toBeGreaterThanOrEqual(2);
  });

  it("an occluded duct crossing under another: wireframe draws it through, hidden line breaks it, hidden lines shown dash it", () => {
    const crossed = (props: Partial<ViewProps>) => {
      let m = placedPlan(props);
      // A 12x8 duct at 8 ft runs north under the east leg at x = 8 ft.
      m = commit(m, { type: "route_run", idPrefix: "lo", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 12 * IN, height: 8 * IN }, elevationMm: 8 * FT, system: SA, points: [{ x: 8 * FT, y: -4 * FT }, { x: 8 * FT, y: 10 * FT }] });
      return lines(buildViewScene(m, "v-plan").scene.primitives);
    };
    const north = (ls: Line[]) => ls.filter((l) => Math.abs(l.a.x - l.b.x) < 1e-6 && Math.abs(l.a.y - l.b.y) > 1);
    const wire = north(crossed({ visualStyle: "wireframe" }));
    const hiddenLine = north(crossed({}));
    // Wireframe: each side one unbroken line; hidden line: each side broken where the upper duct covers it.
    expect(wire.filter((l) => !l.dash).length).toBeLessThan(hiddenLine.filter((l) => !l.dash).length);
    expect(hiddenLine.some((l) => l.dash)).toBe(false);
    const dashed = north(crossed({ hiddenLineCategories: ["duct"] })).filter((l) => l.dash);
    // The covered stretch is the upper duct's 14" width at 1/4" = 1'-0".
    expect(dashed.length).toBeGreaterThanOrEqual(2);
    for (const l of dashed) expect(Math.abs(l.a.y - l.b.y)).toBeCloseTo((14 * IN) / 48, 0);
  });

  it("3D view: hidden line removes edges behind the duct's own faces; wireframe keeps them", () => {
    const iso = (style: ViewProps["visualStyle"]) => {
      let m = lModel();
      m = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d", crop: { min: { x: -6 * FT, y: -6 * FT }, max: { x: 20 * FT, y: 14 * FT } }, props: { level: "Level 1", visualStyle: style } });
      return lines(buildViewScene(m, "v-3d").scene.primitives).reduce((sum, l) => sum + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0);
    };
    expect(iso("hidden_line")).toBeGreaterThan(0);
    // A box seen from above-front hides 3 of its 12 edges; the L's back edges are a large share of its linework.
    expect(iso("wireframe")).toBeGreaterThan(iso("hidden_line") * 1.15);
  });
});

async function pdfPaths(bytes: Uint8Array): Promise<{ lines: Array<{ x1: number; y1: number; x2: number; y2: number }>; fills: number }> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = contents instanceof PDFRawStream ? [contents] : [];
  if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const resolved = doc.context.lookup(ref);
      if (resolved instanceof PDFRawStream) streams.push(resolved);
    }
  }
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  let fillCount = 0;
  for (const stream of streams) {
    const text = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    for (const m of text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l/g)) out.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
    fillCount += [...text.matchAll(/\bf\b/g)].length;
  }
  return { lines: out, fills: fillCount };
}
