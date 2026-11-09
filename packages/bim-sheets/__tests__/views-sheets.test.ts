/**
 * @jest-environment node
 *
 * Sheets drawn from their viewports: each view at its viewport's scale, edits
 * flowing through, sections cutting what crosses the line, and a printed PDF
 * whose dimensions measure true at 1/4" = 1'-0".
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  buildSheetSceneFor,
  buildViewScene,
  commandSchema,
  planCommit,
  sceneToSvg,
  sheetDependsOn,
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

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `sheet-test-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-19T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

type Line = Extract<Primitive, { kind: "line" }>;
const lines = (prims: readonly Primitive[]): Line[] => prims.filter((p): p is Line => p.kind === "line");
const texts = (prims: readonly Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "text" }> => p.kind === "text");
const len = (l: Line) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);

/** Demo ductwork, a level-1 plan, a detail view with a 10'-0" dimension, and sheet M-101 with both placed at 1/4" = 1'-0". */
function sheetModel(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1" } });
  m = commit(m, { type: "create_view", viewId: "v-det", name: "Hanger detail", viewType: "detail", crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 14 * FT, y: 6 * FT } } });
  m = commit(m, { type: "add_drawing_item", itemId: "d-dim", ownerId: "v-det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
  m = commit(m, { type: "add_drawing_item", itemId: "d-line", ownerId: "v-det", shape: "line", points: [{ x: 0, y: 3 * FT }, { x: 12 * FT, y: 3 * FT }] });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Mechanical plan", fields: { drawn_by: "KG", date: "2026-10-19" } });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 320, y: 230 }, scale: 48 });
  m = commit(m, { type: "place_viewport", viewportId: "vp-det", sheetId: "s-1", viewId: "v-det", center: { x: 600, y: 500 }, scale: 48 });
  m = commit(m, { type: "add_drawing_item", itemId: "n-1", ownerId: "s-1", shape: "text", points: [{ x: 30, y: 560 }], text: "1. VERIFY ALL DUCT ROUTING IN FIELD." });
  m = commit(m, { type: "add_drawing_item", itemId: "c-1", ownerId: "s-1", shape: "cloud", points: [{ x: 250, y: 150 }, { x: 330, y: 210 }] });
  return m;
}

describe("sheet drawing reads viewports", () => {
  it("draws each placed view, titles them in sheet order with their scale, and the title block fields", () => {
    const scene = buildSheetSceneFor(sheetModel(), "s-1", { projectName: "7301 Pilot" });
    const t = texts(scene.primitives).map((p) => p.text);
    expect(t).toContain("1  LEVEL 1 MECHANICAL");
    expect(t).toContain("2  HANGER DETAIL");
    expect(t.filter((x) => x === 'SCALE: 1/4" = 1\'-0"')).toHaveLength(2);
    expect(t).toContain("M-101");
    expect(t).toContain("KG");
    // Notes print through the shared text layout, not as one-line text primitives.
    const notes = (scene.textBlocks ?? []).map((b) => b.layout.lines.map((l) => l.pieces.map((q) => q.text).join("")).join(" "));
    expect(notes).toContain("1. VERIFY ALL DUCT ROUTING IN FIELD.");
    // The cloud is many short chords.
    expect(lines(scene.primitives).filter((l) => l.a.x >= 240 && l.a.x <= 340 && l.a.y >= 140 && l.a.y <= 220).length).toBeGreaterThan(50);
    expect(sceneToSvg(scene)).toContain("M-101");
  });

  it("an empty sheet is just border and title block; an unplaced view is not drawn", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_sheet", sheetId: "s-2", number: "M-102", name: "Empty" });
    const scene = buildSheetSceneFor(m, "s-2", { projectName: "P" });
    expect(texts(scene.primitives).some((p) => p.text.includes("LEVEL"))).toBe(false);
  });

  it("viewport scale: a model length lands at length / scale on paper", () => {
    const m = sheetModel();
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    // The 12'-0" detail line at 1/4" = 1'-0" is 3" = 76.2 mm long.
    const detailLine = lines(scene.primitives).find((l) => l.pen === "medium" && Math.abs(len(l) - (12 * FT) / 48) < 0.01);
    expect(detailLine).toBeDefined();
    // Rescale the viewport to 1/8": the same line halves.
    const half = buildSheetSceneFor(commit(m, { type: "set_viewport_scale", viewportId: "vp-det", scale: 96 }), "s-1", { projectName: "P" });
    expect(lines(half.primitives).some((l) => l.pen === "medium" && Math.abs(len(l) - (12 * FT) / 96) < 0.01)).toBe(true);
  });

  it("a duct edit updates the plan on the sheet", () => {
    const m = sheetModel();
    const before = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    const after = buildSheetSceneFor(commit(m, { type: "slide_branch", tapId: "tap-1", s: 9 * FT }), "s-1", { projectName: "P" });
    const tag = (s: typeof before) => s.tags.find((x) => x.elementId === "seg-riser-1");
    expect(tag(before)).toBeDefined();
    expect((tag(after)?.at.x ?? 0) < (tag(before)?.at.x ?? 0)).toBe(true);
  });

  it("hiding the duct category removes ductwork from the plan; a discipline halftones the rest", () => {
    const m = sheetModel();
    const wide = (s: ReturnType<typeof buildSheetSceneFor>) => lines(s.primitives).filter((l) => l.pen === "wide" && l.a.x < 620 && l.a.y < 420).length;
    const shown = wide(buildSheetSceneFor(m, "s-1", { projectName: "P" }));
    const hidden = wide(buildSheetSceneFor(commit(m, { type: "set_view_properties", viewId: "v-plan", props: { hiddenCategories: ["duct", "duct_fitting"] } }), "s-1", { projectName: "P" }));
    expect(shown).toBeGreaterThan(0);
    expect(hidden).toBeLessThan(shown);
    const other = buildSheetSceneFor(commit(m, { type: "set_view_properties", viewId: "v-plan", props: { discipline: "electrical" } }), "s-1", { projectName: "P" });
    expect(lines(other.primitives).some((l) => l.pen === "wide" && l.tone === "halftone")).toBe(true);
  });

  it("a section cuts the duct it crosses: its true cut shape at its elevation, crossed, and no outline-level disclaimer", () => {
    let m = createDemoModel();
    const seg = Object.values(m.elements).find((e) => e.kind === "duct_segment" && Math.abs(e.start.y - e.end.y) < 1);
    if (!seg || seg.kind !== "duct_segment") throw new Error("demo has no horizontal duct");
    const midX = (seg.start.x + seg.end.x) / 2;
    m = commit(m, {
      type: "create_view",
      viewId: "v-sec",
      name: "Section A",
      viewType: "section",
      props: { level: "L1", section: { start: { x: midX, y: seg.start.y - 10 * FT }, end: { x: midX, y: seg.start.y + 10 * FT }, direction: 1, depthMm: 5 * FT } },
    });
    const { scene } = buildViewScene(m, "v-sec");
    expect(texts(scene.primitives).some((p) => p.text.startsWith("OUTLINE SECTION"))).toBe(false);
    // Cut duct: a wide-pen rectangle plus its two diagonals (the default cross pattern).
    expect(lines(scene.primitives).filter((l) => l.pen === "wide").length).toBeGreaterThanOrEqual(4);
    expect(lines(scene.primitives).filter((l) => l.pen === "thin" && Math.abs(l.a.x - l.b.x) > 0.5 && Math.abs(l.a.y - l.b.y) > 0.5).length).toBeGreaterThanOrEqual(2);
  });
});

describe("print scope: only the selected sheet's dependencies", () => {
  it("counts the sheet, its viewports, views, notes and the levels its views show; not another sheet's notes", () => {
    let m = sheetModel();
    m = commit(m, { type: "create_sheet", sheetId: "s-2", number: "M-102", name: "Other" });
    m = commit(m, { type: "add_drawing_item", itemId: "n-other", ownerId: "s-2", shape: "text", points: [{ x: 30, y: 30 }], text: "OTHER" });
    const depends = sheetDependsOn(m, "s-1");
    const el = (id: string) => m.elements[id];
    for (const id of ["s-1", "vp-plan", "vp-det", "v-plan", "v-det", "d-dim", "n-1", "c-1"]) expect(depends(id, el(id))).toBe(true);
    // Ductwork on L1, which the placed plan shows.
    expect(depends("seg-riser-1", el("seg-riser-1"))).toBe(true);
    expect(depends("n-other", el("n-other"))).toBe(false);
    expect(depends("s-2", el("s-2"))).toBe(false);
  });
});

describe("printed PDF", () => {
  async function strokedLinesPt(bytes: Uint8Array): Promise<Array<{ x1: number; y1: number; x2: number; y2: number }>> {
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
    for (const stream of streams) {
      const text = new TextDecoder().decode(decodePDFRawStream(stream).decode());
      for (const m of text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l/g)) {
        out.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
      }
    }
    return out;
  }

  it("prints at true paper size and a 10'-0\" dimension measures 2 1/2\" (180 pt) at 1/4\" = 1'-0\"", async () => {
    const scene = buildSheetSceneFor(sheetModel(), "s-1", { projectName: "7301 Pilot" });
    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
    const doc = await PDFDocument.load(pdf.bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(36 * 72, 1);
    expect(height).toBeCloseTo(24 * 72, 1);
    const segs = await strokedLinesPt(pdf.bytes);
    const expectedPt = ((10 * FT) / 48) * MM_TO_PT;
    expect(expectedPt).toBeCloseTo(180, 6);
    const dimLine = segs.find((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - expectedPt) < 0.05);
    expect(dimLine).toBeDefined();
  });

  it("a cropped plan prints only what is inside its crop box, and no crop boundary", async () => {
    // The sheet's own revision cloud overlaps the plan; take it off so only the view's linework is near the frame.
    let m = commit(sheetModel(), { type: "delete_drawing_item", itemId: "c-1" });
    // Crop the plan to the east half of the trunk; the viewport shrinks to match.
    m = commit(m, { type: "set_view_crop", viewId: "v-plan", crop: { min: { x: 19.5 * FT, y: -3 * FT }, max: { x: 30 * FT, y: 12 * FT } } });
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "P" });
    const vp = m.elements["vp-plan"];
    if (vp?.kind !== "viewport") throw new Error("viewport missing");
    const w = (10.5 * FT) / 48;
    const h = (15 * FT) / 48;
    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
    const paperHeightPt = 24 * 72;
    const frame = {
      left: (vp.center.x - w / 2) * MM_TO_PT,
      right: (vp.center.x + w / 2) * MM_TO_PT,
      top: paperHeightPt - (vp.center.y - h / 2) * MM_TO_PT,
      bottom: paperHeightPt - (vp.center.y + h / 2) * MM_TO_PT,
    };
    // Lines near the plan's frame (the detail and the title block are elsewhere on the sheet).
    const near = (await strokedLinesPt(pdf.bytes)).filter((s) => s.y1 > frame.bottom - 60 && s.y1 < frame.top + 60 && s.x1 > frame.left - 60 && s.x1 < frame.right + 60);
    const viewLines = near.filter((s) => s.y1 > frame.bottom - 1 && s.y1 < frame.top + 1);
    expect(viewLines.length).toBeGreaterThan(0);
    const pad = 0.05;
    for (const s of viewLines) {
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) {
        expect(x).toBeGreaterThanOrEqual(frame.left - pad);
        expect(x).toBeLessThanOrEqual(frame.right + pad);
        expect(y).toBeGreaterThanOrEqual(frame.bottom - pad);
        expect(y).toBeLessThanOrEqual(frame.top + pad);
      }
    }
    // The crop boundary is an on-screen aid only: no frame-sized rectangle is printed.
    expect(scene.primitives.some((p) => p.kind === "rect" && Math.abs(p.size.x - w) < 0.5 && Math.abs(p.size.y - h) < 0.5)).toBe(false);
  });
});
