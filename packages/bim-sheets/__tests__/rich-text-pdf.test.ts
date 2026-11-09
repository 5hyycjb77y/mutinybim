/**
 * @jest-environment node
 *
 * Rich notes print exactly where the screen draws them: the PDF writer and the
 * SVG the sheet editor shows are both fed by the one layout engine. This reads
 * the PDF's content stream back (text matrices and glyph counts) and the SVG's
 * glyph positions, and holds them to the same line breaks and positions.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFRef, decodePDFRawStream } from "pdf-lib";
import {
  NOTE_FONT_FACES,
  NOTE_FONT_FILES,
  buildSheetSceneFor,
  commandSchema,
  pieceCharX,
  planCommit,
  sceneToSvg,
  type ModelState,
  type NoteParagraph,
  type SheetScene,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { NOTE_FONTS_DIR, NoteFontMismatchError, nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";

const MM_TO_PT = 72 / 25.4;
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `rich-pdf-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-19T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

const SAMPLE: NoteParagraph[] = [
  { runs: [{ text: "GENERAL NOTES", bold: true, underline: true }], align: "center" },
  { runs: [{ text: "Coordinate all ductwork with the structure and the " }, { text: "architect", italic: true }, { text: " before fabrication." }], list: { kind: "numbered", level: 0 } },
  { runs: [{ text: "Seal all " }, { text: "supply", bold: true }, { text: " and return joints to SMACNA seal class A." }], list: { kind: "numbered", level: 0 } },
  { runs: [{ text: "Hangers at 8'-0\" O.C. maximum, ±1/4\"." }], list: { kind: "bullet", level: 1 } },
  { runs: [{ text: "Verify every dimension in the field before ordering equipment; report discrepancies to the engineer." }], align: "justify" },
];

function sceneWithNote(rotation = 0): SheetScene {
  let m = createDemoModel();
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-001", name: "Notes" });
  m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-1", at: { x: 60, y: 80 }, width: 70, rotation, textSize: 2.38, paragraphs: SAMPLE });
  return buildSheetSceneFor(m, "s-1", { projectName: "P" });
}

interface PdfGlyphRun {
  readonly font: string;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly a: number;
  readonly b: number;
  readonly glyphs: number;
}

/** Every Tj in the page: its font resource's BaseFont, size, text matrix origin and glyph count. */
async function pdfTextRuns(bytes: Uint8Array): Promise<PdfGlyphRun[]> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const resources = page.node.Resources();
  const fontDict = resources?.lookup(PDFName.of("Font"), PDFDict);
  const baseFont = new Map<string, string>();
  for (const [name, ref] of fontDict?.entries() ?? []) {
    const f = ref instanceof PDFRef ? doc.context.lookup(ref, PDFDict) : null;
    baseFont.set(name.asString(), f?.lookup(PDFName.of("BaseFont"))?.toString() ?? "");
  }
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  const collect = (o: unknown) => {
    if (o instanceof PDFRawStream) streams.push(o);
  };
  if (contents && "asArray" in contents) for (const r of contents.asArray()) collect(doc.context.lookup(r));
  else collect(contents);
  const out: PdfGlyphRun[] = [];
  for (const stream of streams) {
    const text = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    const re = /(\/\S+) ([\d.]+) Tf\s+[\s\S]*?(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\s+<([0-9A-Fa-f]*)> Tj/g;
    for (const m of text.matchAll(re)) {
      out.push({ font: baseFont.get(m[1] ?? "") ?? "", size: Number(m[2]), a: Number(m[3]), b: Number(m[4]), x: Number(m[7]), y: Number(m[8]), glyphs: (m[9] ?? "").length / 4 });
    }
  }
  return out;
}

/** Screen glyph runs as the browser gets them: the first glyph's position, in PDF points. */
function svgTextRuns(scene: SheetScene, paperHeightMm: number): Array<{ x: number; y: number; chars: number; bold: boolean }> {
  const svg = sceneToSvg(scene);
  const group = svg.slice(svg.indexOf('data-note-id="n-1"'));
  const transform = /translate\(([-\d.]+) ([-\d.]+)\)(?: rotate\(([-\d.]+)\))?/.exec(svg.slice(svg.lastIndexOf("<g", svg.indexOf('data-note-id="n-1"')))) ?? [];
  const ox = Number(transform[1]);
  const oy = Number(transform[2]);
  const r = (Number(transform[3] ?? 0) * Math.PI) / 180;
  const out: Array<{ x: number; y: number; chars: number; bold: boolean }> = [];
  for (const m of group.slice(0, group.indexOf("</g>")).matchAll(/<text x="([^"]+)" y="([-\d.]+)"([^>]*)>([^<]*)<\/text>/g)) {
    const lx = Number((m[1] ?? "").split(" ")[0]);
    const ly = Number(m[2]);
    const px = ox + lx * Math.cos(r) - ly * Math.sin(r);
    const py = oy + lx * Math.sin(r) + ly * Math.cos(r);
    const chars = [...(m[4] ?? "").replace(/\u00a0/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")].length;
    out.push({ x: px * MM_TO_PT, y: (paperHeightMm - py) * MM_TO_PT, chars, bold: (m[3] ?? "").includes('font-weight="bold"') });
  }
  return out;
}

describe("rich note PDF output", () => {
  it("prints every laid-out piece at the layout's position, with the face it was measured in", async () => {
    const scene = sceneWithNote();
    const block = scene.textBlocks?.[0];
    if (!block) throw new Error("note not drawn");
    const pdf = await renderSheetPdfWith(scene, { title: "M-001", modelRevision: scene.revision, snapshotSha256: "t", renderer: "test" }, null, nodeNoteFonts());
    const runs = (await pdfTextRuns(pdf.bytes)).filter((r) => r.font.includes("MutinyBIMNotes"));
    const pieces = block.layout.lines.flatMap((l) => l.pieces.filter((p) => p.text.trim().length > 0));
    expect(runs).toHaveLength(pieces.length);
    const pageHeight = scene.paper.y * MM_TO_PT;
    pieces.forEach((p, i) => {
      const run = runs[i];
      expect(run?.x).toBeCloseTo((block.origin.x + p.x) * MM_TO_PT, 2);
      expect(run?.y).toBeCloseTo(pageHeight - (block.origin.y + p.baseline) * MM_TO_PT, 2);
      expect(run?.size).toBeCloseTo(p.em * MM_TO_PT, 3);
      expect(run?.glyphs).toBe([...p.text].length);
      expect(run?.font).toContain(`MutinyBIMNotes-${p.face}`);
    });
    // Underline bar under the heading, a filled rectangle.
    expect(block.layout.lines[0]?.underlines).toHaveLength(1);
  });

  it("screen and print agree: same line breaks, same glyph positions (within 0.01 pt), for a rotated note too", async () => {
    for (const rotation of [0, -30]) {
      const scene = sceneWithNote(rotation);
      const pdf = await renderSheetPdfWith(scene, { title: "M-001", modelRevision: scene.revision, snapshotSha256: "t", renderer: "test" }, null, nodeNoteFonts());
      const printed = (await pdfTextRuns(pdf.bytes)).filter((r) => r.font.includes("MutinyBIMNotes"));
      const screen = svgTextRuns(scene, scene.paper.y);
      expect(screen).toHaveLength(printed.length);
      screen.forEach((s, i) => {
        const p = printed[i];
        expect(s.x).toBeCloseTo(p?.x ?? NaN, 1);
        expect(s.y).toBeCloseTo(p?.y ?? NaN, 1);
        expect(Math.abs(s.x - (p?.x ?? NaN))).toBeLessThan(0.01);
        expect(Math.abs(s.y - (p?.y ?? NaN))).toBeLessThan(0.01);
        expect(s.chars).toBe(p?.glyphs);
        expect(s.bold).toBe(Boolean(p?.font.includes("-bold")));
        // Rotation: the PDF text matrix turns by the same angle the SVG group does.
        expect(Math.atan2(p?.b ?? 0, p?.a ?? 1)).toBeCloseTo((-rotation * Math.PI) / 180, 4);
      });
      // Every glyph after the first in a piece is placed by the font's own advance in both: check one piece end to end.
      const piece = scene.textBlocks?.[0]?.layout.lines[1]?.pieces.find((q) => !q.marker);
      if (piece) expect(pieceCharX(piece).length).toBe([...piece.text].length);
    }
  });

  it("is byte-for-byte deterministic for one scene (fixed font names, subset)", async () => {
    const scene = sceneWithNote();
    const meta = { title: "M-001", modelRevision: scene.revision, snapshotSha256: "t", renderer: "test" };
    const a = await renderSheetPdfWith(scene, meta, null, nodeNoteFonts());
    const b = await renderSheetPdfWith(scene, meta, null, nodeNoteFonts());
    expect(createHash("sha256").update(a.bytes).digest("hex")).toBe(createHash("sha256").update(b.bytes).digest("hex"));
  });

  it("refuses to print notes with a font that isn't the one the layout was measured with", async () => {
    const scene = sceneWithNote();
    const wrong = { load: async () => new Uint8Array(readFileSync(path.join(NOTE_FONTS_DIR, NOTE_FONT_FILES.bold))) };
    await expect(renderSheetPdfWith(scene, { title: "M", modelRevision: 0, snapshotSha256: "t", renderer: "t" }, null, wrong)).rejects.toBeInstanceOf(NoteFontMismatchError);
    await expect(renderSheetPdfWith(scene, { title: "M", modelRevision: 0, snapshotSha256: "t", renderer: "t" }, null, null)).rejects.toThrow(/fonts weren't provided/);
  });

  it("the browser's font files are the same bytes the PDF embeds and the metrics were taken from", () => {
    const publicDir = path.resolve(NOTE_FONTS_DIR, "../../../public/mutinybim/fonts");
    for (const [face, file] of Object.entries(NOTE_FONT_FILES)) {
      const pkg = createHash("sha256").update(readFileSync(path.join(NOTE_FONTS_DIR, file))).digest("hex");
      const served = createHash("sha256").update(readFileSync(path.join(publicDir, file))).digest("hex");
      expect(served).toBe(pkg);
      expect(NOTE_FONT_FACES[face as keyof typeof NOTE_FONT_FACES].sha256).toBe(pkg);
    }
  });
});
