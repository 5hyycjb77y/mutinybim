/**
 * @jest-environment node
 *
 * True north on drawings: a plan set to "true north" turns so true north is
 * up the sheet; a plan left on "plan north" does not move. Every placed plan
 * prints a north arrow that points at true north on paper (straight up on a
 * true-north plan, at the true north angle on a plan-north one), and the arrow
 * is in the printed PDF. A viewport can turn its arrow off.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  buildSheetSceneFor,
  buildViewScene,
  commandSchema,
  executeCommand,
  frameForViewport,
  modelToPaper,
  paperToModel,
  planCommit,
  type ModelState,
  type Primitive,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";

const FT = 304.8;
const MM_TO_PT = 72 / 25.4;
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

type Raw = { readonly type: string } & Record<string, unknown>;
function commit(head: ModelState, command: Raw): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `north-test-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-20T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

type Fill = Extract<Primitive, { kind: "fill" }>;
type Line = Extract<Primitive, { kind: "line" }>;

/** The north arrow's head: the only black three-point fill on the sheet. Its first point is the tip. */
function arrowHead(prims: readonly Primitive[]): Fill[] {
  return prims.filter((p): p is Fill => p.kind === "fill" && p.points.length === 3 && p.grey === 0);
}

/** Degrees clockwise from paper-up that an arrowhead points (paper y is down). */
function arrowDeg(head: Fill): number {
  const [tip, , tail] = head.points;
  if (!tip || !tail) throw new Error("arrowhead needs three points");
  const deg = (Math.atan2(tip.x - tail.x, -(tip.y - tail.y)) * 180) / Math.PI;
  return Math.round(deg * 1000) / 1000;
}

/** Demo ductwork, a level-1 plan placed on M-101 at 1/4" = 1'-0", and true north 30° clockwise of plan north. */
function model(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1" } });
  m = commit(m, { type: "create_view", viewId: "v-det", name: "Hanger detail", viewType: "detail", crop: { min: { x: 0, y: 0 }, max: { x: 10 * FT, y: 6 * FT } } });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Mechanical plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 320, y: 260 }, scale: 48 });
  m = commit(m, { type: "place_viewport", viewportId: "vp-det", sheetId: "s-1", viewId: "v-det", center: { x: 650, y: 480 }, scale: 48 });
  m = commit(m, { type: "set_true_north", angleDeg: 30 });
  return m;
}

describe("plan orientation", () => {
  it("plan north (the default) keeps model north up the sheet even with true north set", () => {
    const m = model();
    const vp = m.elements["vp-plan"];
    const view = m.elements["v-plan"];
    if (vp?.kind !== "viewport" || view?.kind !== "view") throw new Error("setup");
    const frame = frameForViewport(m, vp, view);
    expect(frame.rotationDeg ?? 0).toBe(0);
    const c = frame.modelCenter;
    const up = modelToPaper(frame, { x: c.x, y: c.y + 48 * 10 });
    expect(up.x).toBeCloseTo(frame.center.x, 6);
    expect(up.y).toBeCloseTo(frame.center.y - 10, 6);
  });

  it("true north turns the plan so a point true-north of the centre lands straight up the sheet; paper back to model round-trips", () => {
    const m = commit(model(), { type: "set_view_properties", viewId: "v-plan", props: { orientation: "true_north" } });
    const vp = m.elements["vp-plan"];
    const view = m.elements["v-plan"];
    if (vp?.kind !== "viewport" || view?.kind !== "view") throw new Error("setup");
    const frame = frameForViewport(m, vp, view);
    expect(frame.rotationDeg).toBe(30);
    const c = frame.modelCenter;
    const a = Math.PI / 6;
    // True north in plan is 30° clockwise of plan north: (sin 30°, cos 30°).
    const p = modelToPaper(frame, { x: c.x + 480 * Math.sin(a), y: c.y + 480 * Math.cos(a) });
    expect(p.x).toBeCloseTo(frame.center.x, 6);
    expect(p.y).toBeCloseTo(frame.center.y - 10, 6);
    const back = paperToModel(frame, p);
    expect(back.x).toBeCloseTo(c.x + 480 * Math.sin(a), 6);
    expect(back.y).toBeCloseTo(c.y + 480 * Math.cos(a), 6);
    // The frame on paper bounds the turned window, and the stored viewport size agrees with it.
    expect(frame.windowSize).toBeDefined();
    expect(frame.size.x).toBeGreaterThan(frame.windowSize?.x ?? Infinity);
    expect(vp.size.x).toBeCloseTo(frame.size.x, 2);
    expect(vp.size.y).toBeCloseTo(frame.size.y, 2);
    // The single view, outside a sheet, turns the same way.
    const { frame: alone } = buildViewScene(m, "v-plan");
    expect(alone.rotationDeg).toBe(30);
  });

  it("only plans turn to true north; a turned plan's frame is edited through its crop box", () => {
    const m = commit(model(), { type: "set_view_properties", viewId: "v-plan", props: { orientation: "true_north" } });
    const refuse = (command: Raw) => {
      const r = executeCommand(m, commandSchema.parse(command));
      return r.ok ? null : r.error.message;
    };
    expect(refuse({ type: "set_view_properties", viewId: "v-det", props: { orientation: "true_north" } })).toMatch(/Only plans turn to true north/);
    expect(refuse({ type: "resize_viewport", viewportId: "vp-plan", size: { x: 100, y: 100 } })).toMatch(/turned to true north/);
  });
});

describe("north arrow on the sheet", () => {
  it("on a plan-north plan it points at the true north angle; on a true-north plan straight up", () => {
    const plain = buildSheetSceneFor(model(), "s-1", { projectName: "P" });
    const heads = arrowHead(plain.primitives);
    // One arrow: the plan has one, the detail view does not by default.
    expect(heads).toHaveLength(1);
    expect(arrowDeg(heads[0] ?? (() => { throw new Error("no arrow"); })())).toBeCloseTo(30, 3);
    expect(plain.primitives.some((p) => p.kind === "text" && p.text === "N")).toBe(true);

    const turned = buildSheetSceneFor(commit(model(), { type: "set_view_properties", viewId: "v-plan", props: { orientation: "true_north" } }), "s-1", { projectName: "P" });
    const [head] = arrowHead(turned.primitives);
    expect(head && arrowDeg(head)).toBeCloseTo(0, 3);
  });

  it("follows a new true north angle without touching the view", () => {
    const m = commit(model(), { type: "set_true_north", angleDeg: -45 });
    const [head] = arrowHead(buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives);
    expect(head && arrowDeg(head)).toBeCloseTo(-45, 3);
  });

  it("can be turned off per viewport, and on for a view that has none by default; undoable like any edit", () => {
    let m = commit(model(), { type: "set_viewport_north_arrow", viewportId: "vp-plan", show: false });
    expect(arrowHead(buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives)).toHaveLength(0);
    m = commit(m, { type: "set_viewport_north_arrow", viewportId: "vp-det", show: true });
    expect(arrowHead(buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives)).toHaveLength(1);
  });

  it("prints in the PDF: the arrowhead outline is stroked at the sheet's coordinates", async () => {
    const scene = buildSheetSceneFor(model(), "s-1", { projectName: "P" });
    const [head] = arrowHead(scene.primitives);
    if (!head) throw new Error("no arrow");
    const [tip] = head.points;
    if (!tip) throw new Error("no tip");
    const outline = scene.primitives.filter((p): p is Line => p.kind === "line" && p.pen === "medium" && (Math.hypot(p.a.x - tip.x, p.a.y - tip.y) < 1e-6 || Math.hypot(p.b.x - tip.x, p.b.y - tip.y) < 1e-6));
    expect(outline.length).toBe(2);

    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
    const doc = await PDFDocument.load(pdf.bytes);
    const page = doc.getPage(0);
    const height = page.getSize().height;
    const contents = page.node.Contents();
    const streams: PDFRawStream[] = contents instanceof PDFRawStream ? [contents] : [];
    if (contents instanceof PDFArray) for (const ref of contents.asArray()) {
      const s = doc.context.lookup(ref);
      if (s instanceof PDFRawStream) streams.push(s);
    }
    const strokes: Array<[number, number, number, number]> = [];
    for (const s of streams) {
      const text = new TextDecoder().decode(decodePDFRawStream(s).decode());
      for (const m of text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l/g)) strokes.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
    }
    for (const l of outline) {
      const want = [l.a.x * MM_TO_PT, height - l.a.y * MM_TO_PT, l.b.x * MM_TO_PT, height - l.b.y * MM_TO_PT];
      expect(strokes.some((s) => s.every((v, i) => Math.abs(v - (want[i] ?? NaN)) < 0.05))).toBe(true);
    }
  });
});
