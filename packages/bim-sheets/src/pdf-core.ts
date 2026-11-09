import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type RGB } from "pdf-lib";
import { TONE_GREY, fillGrey, lineWidthMm, organizationOf, type ModelState, type SheetScene, type Tone } from "@permitzip/bim-kernel";
import { drawTextBlocks } from "./text/pdf-text";
import { WinAnsiWriter } from "./text/win-ansi";
import type { NoteFontSource } from "./text/fonts";

export { NOTE_FONT_URL_BASE, NoteFontMismatchError, fetchNoteFonts, type NoteFontSource } from "./text/fonts";

/**
 * The vector PDF writer with no Node dependencies, so the browser can print a
 * sheet from the exact model revision it has (last saved, or after pending
 * edits are saved). Node callers use `renderSheetPdf` in ./pdf, which adds the
 * file system and hashing for placed standard details.
 */

const MM_TO_PT = 72 / 25.4;
/** Helvetica cap height is ~0.718 of the font size. */
const CAP_HEIGHT_RATIO = 0.718;

export interface PdfMetadata {
  readonly title: string;
  readonly subject?: string;
  /** sha256 of the export snapshot the PDF was rendered from. */
  readonly snapshotSha256: string;
  readonly modelRevision: number;
  readonly renderer: string;
}

export interface RenderedPdf {
  readonly bytes: Uint8Array;
  /** Every non-model input actually embedded, with the hash verified at render time. */
  readonly embeddedDetails: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
  /** Labels the PDF's standard font couldn't print as written (`1⅜"`), and what it printed instead (`1-3/8"`). Empty when none. */
  readonly substitutedText: ReadonlyArray<{ readonly text: string; readonly printed: string }>;
}

export class DetailHashMismatchError extends Error {
  constructor(readonly file: string, readonly expected: string, readonly actual: string) {
    super(`Standard detail ${file} has changed (expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}); refusing to issue`);
    this.name = "DetailHashMismatchError";
  }
}

/** Loads a placed standard detail's PDF bytes and hashes them. Absent: a sheet with placed details is refused. */
export interface DetailSource {
  load(file: string): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<string>;
}

/** Loads a placed picture's bytes by the file id the sheet stores (the host's workspace file, a file in standalone). */
export interface SheetImageSource {
  load(fileId: string): Promise<Uint8Array>;
}

/** Loads a scene font (a firm title block's face) by the file its title block names. */
export interface SceneFontSource {
  load(file: string): Promise<Uint8Array>;
}

/** Scene fonts fetched over HTTP from the path the title block names (the browser print path). */
export function fetchSceneFonts(fetchImpl: typeof fetch = fetch): SceneFontSource {
  return {
    async load(file) {
      const res = await fetchImpl(file);
      if (!res.ok) throw new Error(`Couldn't load the title block font ${file} (HTTP ${res.status}), so this sheet can't be printed`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export interface PdfPrintOptions {
  /** Where a firm title block's fonts come from. Absent: fetched from the paths the title block names. */
  readonly sceneFonts?: SceneFontSource;
  /** Every colour printed black, as a black-only plotter prints it. */
  readonly monochrome?: boolean;
}

/** Keyword that carries a library title block's Verify-code slot (paper mm) to the issue step's stamp. */
export const CODE_SLOT_KEYWORD = "code-slot:";

function hexColor(hex: string): RGB {
  const v = Number.parseInt(hex.slice(1), 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/**
 * Vector PDF of a sheet scene at true paper size (1 paper mm = 1 mm). Every
 * line and glyph is vector; placed standard details are embedded as vector PDF
 * pages, and refused if their hash no longer matches what the sheet pins.
 */
/** How this model's sheets print: black only when the project chose it (Sheets › Black only), else colour. */
export function modelPrintOptions(model: Pick<ModelState, "elements" | "connections">): PdfPrintOptions {
  return organizationOf(model).printBlackOnly ? { monochrome: true } : {};
}

export async function renderSheetPdfWith(scene: SheetScene, meta: PdfMetadata, details: DetailSource | null, noteFonts: NoteFontSource | null = null, images: SheetImageSource | null = null, print: PdfPrintOptions = {}): Promise<RenderedPdf> {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setSubject(meta.subject ?? `Model revision ${meta.modelRevision}`);
  doc.setProducer(meta.renderer);
  doc.setCreator("MutinyBIM");
  const slot = scene.codeSlot;
  doc.setKeywords([`model-revision:${meta.modelRevision}`, `snapshot-sha256:${meta.snapshotSha256}`, ...(slot ? [`${CODE_SLOT_KEYWORD}${[slot.left, slot.top, slot.right, slot.bottom].map((n) => n.toFixed(2)).join(",")}`] : [])]);
  // Fixed dates keep the bytes deterministic for one snapshot + renderer.
  const epoch = new Date("2026-01-01T00:00:00.000Z");
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);

  const width = scene.paper.x * MM_TO_PT;
  const height = scene.paper.y * MM_TO_PT;
  const page = doc.addPage([width, height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const winAnsi = new WinAnsiWriter();
  const black = rgb(0, 0, 0);
  const toneColor = (tone: Tone | undefined, color?: string) => (tone && tone !== "ink" ? rgb(TONE_GREY[tone], TONE_GREY[tone], TONE_GREY[tone]) : color && !print.monochrome ? hexColor(color) : black);
  // A firm title block's faces: embedded subset, under a fixed name so the bytes stay deterministic.
  const sceneFonts = new Map<string, { font: PDFFont; capHeight: number }>();
  if ((scene.fonts ?? []).length > 0) {
    doc.registerFontkit(fontkit);
    const source = print.sceneFonts ?? fetchSceneFonts();
    for (const f of scene.fonts ?? []) {
      const bytes = await source.load(f.file);
      sceneFonts.set(f.id, { font: await doc.embedFont(bytes, { subset: true, customName: `MutinyBIMTitle-${f.id}` }), capHeight: f.capHeight });
    }
  }
  const x = (mm: number) => mm * MM_TO_PT;
  const y = (mm: number) => height - mm * MM_TO_PT;

  const embeddedDetails: Array<{ file: string; sha256: string }> = [];
  for (const d of scene.details) {
    if (!details) throw new Error(`Standard detail ${d.file} can't be embedded here; print this sheet from the server`);
    const bytes = await details.load(d.file);
    const actual = await details.sha256(bytes);
    if (actual !== d.sha256) throw new DetailHashMismatchError(d.file, d.sha256, actual);
    const [embedded] = await doc.embedPdf(bytes, [0]);
    if (!embedded) throw new Error(`Standard detail ${d.file} has no pages`);
    page.drawPage(embedded, { x: x(d.at.x), y: y(d.at.y + d.size.y), width: d.size.x * MM_TO_PT, height: d.size.y * MM_TO_PT });
    embeddedDetails.push({ file: d.file, sha256: actual });
  }

  // Pictures sit under the linework, stretched to their frames as placed.
  for (const im of scene.images ?? []) {
    if (!images) throw new Error(`This sheet has a picture (${im.name}), and pictures can't be loaded here, so it can't be printed`);
    let bytes: Uint8Array;
    try {
      bytes = await images.load(im.fileId);
    } catch (err) {
      throw new Error(`The picture ${im.name} couldn't be loaded for printing: ${err instanceof Error ? err.message : String(err)}`);
    }
    const embedded = im.mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    page.drawImage(embedded, { x: x(im.at.x), y: y(im.at.y + im.size.y), width: im.size.x * MM_TO_PT, height: im.size.y * MM_TO_PT });
  }

  for (const p of scene.primitives) {
    if (p.kind === "line") {
      page.drawLine({
        start: { x: x(p.a.x), y: y(p.a.y) },
        end: { x: x(p.b.x), y: y(p.b.y) },
        thickness: lineWidthMm(p) * MM_TO_PT,
        color: toneColor(p.tone, p.color),
        dashArray: p.dash ? p.dash.map((d) => d * MM_TO_PT) : undefined,
      });
    } else if (p.kind === "fill") {
      if (p.points.length < 3) continue;
      const g = fillGrey(p.grey, p.tone);
      // SVG path in points, y down from the page's top-left (pdf-lib flips it).
      const path = p.points.map((q, i) => `${i === 0 ? "M" : "L"}${(q.x * MM_TO_PT).toFixed(3)} ${(q.y * MM_TO_PT).toFixed(3)}`).join(" ") + " Z";
      page.drawSvgPath(path, { x: 0, y: height, color: p.color && !print.monochrome ? hexColor(p.color) : rgb(g, g, g), borderWidth: 0 });
    } else if (p.kind === "rect") {
      page.drawRectangle({
        x: x(p.at.x),
        y: y(p.at.y + p.size.y),
        width: p.size.x * MM_TO_PT,
        height: p.size.y * MM_TO_PT,
        borderColor: toneColor(undefined, p.color),
        borderWidth: lineWidthMm(p) * MM_TO_PT,
      });
    } else {
      const face = p.font ? sceneFonts.get(p.font) : undefined;
      const font: PDFFont = face?.font ?? (p.bold ? bold : regular);
      const size = (p.size / (face?.capHeight ?? CAP_HEIGHT_RATIO)) * MM_TO_PT;
      const text = face ? p.text : winAnsi.text(font, p.text);
      const textWidth = font.widthOfTextAtSize(text, size);
      const dx = p.anchor === "middle" ? -textWidth / 2 : p.anchor === "end" ? -textWidth : 0;
      if (p.rotate) {
        // Paper turns clockwise with y down; PDF turns counter-clockwise with y up. The anchor shift turns with the words.
        const a = (-p.rotate * Math.PI) / 180;
        page.drawText(text, { x: x(p.at.x) + dx * Math.cos(a), y: y(p.at.y) + dx * Math.sin(a), size, font, color: toneColor(p.tone, p.color), rotate: degrees(-p.rotate) });
      } else page.drawText(text, { x: x(p.at.x) + dx, y: y(p.at.y), size, font, color: toneColor(p.tone, p.color) });
    }
  }

  const blocks = scene.textBlocks ?? [];
  if (blocks.length > 0) {
    if (!noteFonts) throw new Error("This sheet has notes, and their fonts weren't provided, so it can't be printed here");
    await drawTextBlocks(doc, page, blocks, noteFonts);
  }

  return { bytes: await doc.save({ useObjectStreams: false }), embeddedDetails, substitutedText: winAnsi.substituted };
}
