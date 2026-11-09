import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { titleBlockCodeSlot } from "@permitzip/bim-kernel";
import { CODE_SLOT_KEYWORD, type PdfMetadata } from "./pdf-core";
import { encodeQr, qrRuns } from "./qr";

/**
 * A drawing set as one PDF: each sheet's own vector PDF, in set order, one page
 * per sheet at its true paper size. The pages are copied, not redrawn, so the
 * set prints exactly what each sheet prints on its own.
 */

export interface SetPage {
  readonly number: string;
  readonly title: string;
  readonly bytes: Uint8Array;
}

export interface RenderedSet {
  readonly bytes: Uint8Array;
  /** Page number (1-based) per sheet number. */
  readonly pages: ReadonlyArray<{ readonly number: string; readonly title: string; readonly page: number }>;
}

export async function mergeSheetPdfs(sheets: readonly SetPage[], meta: PdfMetadata): Promise<RenderedSet> {
  if (sheets.length === 0) throw new Error("A drawing set needs at least one sheet.");
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setSubject(meta.subject ?? `Model revision ${meta.modelRevision}`);
  doc.setProducer(meta.renderer);
  doc.setCreator("MutinyBIM");
  doc.setKeywords([`model-revision:${meta.modelRevision}`, `snapshot-sha256:${meta.snapshotSha256}`, `sheets:${sheets.map((s) => s.number).join(",")}`]);
  // Same fixed dates as a single sheet: one snapshot + renderer gives the same bytes.
  const epoch = new Date("2026-01-01T00:00:00.000Z");
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);
  const pages: Array<{ number: string; title: string; page: number }> = [];
  for (const sheet of sheets) {
    const src = await PDFDocument.load(sheet.bytes);
    const copied = await doc.copyPages(src, src.getPageIndices());
    for (const p of copied) doc.addPage(p);
    pages.push({ number: sheet.number, title: sheet.title, page: doc.getPageCount() - copied.length + 1 });
  }
  return { bytes: await doc.save({ useObjectStreams: false }), pages };
}

// ---------------------------------------------------------------------------
// V10 — the Verify code on an issued sheet: a QR code in the title block's
// sheet-number box (`titleBlockCodeSlot`) that opens the sheet's Verify page. Drawn into the sheet's own
// PDF before it is fingerprinted, so the printed code is part of the file the
// fingerprint names. Same input, same bytes (no clock, no metadata update).
// ---------------------------------------------------------------------------

/** Module size in points (0.9 pt ≈ 0.32 mm: a phone reads it at arm's length) and the white margin around the code, in modules. */
export const SHEET_CODE_MODULE_PT = 0.9;
export const SHEET_CODE_QUIET_MODULES = 2;
const MM_TO_PT = 72 / 25.4;
const SHEET_CODE_CAPTION = "Scan to verify";
const SHEET_CODE_CAPTION_PT = 4;

/** Where the code sits on a page of this size (points, PDF y up): centred in the title block's code slot, inside the border. */
export function sheetCodeBox(pageWidth: number, pageHeight: number, matrixSize: number, librarySlot?: CodeSlot): { readonly x: number; readonly y: number; readonly size: number; readonly captionHeight: number } {
  const size = (matrixSize + SHEET_CODE_QUIET_MODULES * 2) * SHEET_CODE_MODULE_PT;
  const captionHeight = SHEET_CODE_CAPTION_PT + 2;
  const slot = librarySlot ?? titleBlockCodeSlot({ x: pageWidth / MM_TO_PT, y: pageHeight / MM_TO_PT });
  const slotBottom = pageHeight - slot.bottom * MM_TO_PT;
  const slotHeight = (slot.bottom - slot.top) * MM_TO_PT;
  return { x: slot.right * MM_TO_PT - size, y: slotBottom + Math.max(0, (slotHeight - size - captionHeight) / 2), size, captionHeight };
}

type CodeSlot = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };

/** A library title block's QR slot, as the sheet's PDF carries it in its keywords (`CODE_SLOT_KEYWORD`). */
export function codeSlotOf(keywords: string | undefined): CodeSlot | undefined {
  const entry = (keywords ?? "").split(/\s+/).find((k) => k.startsWith(CODE_SLOT_KEYWORD));
  const nums = entry?.slice(CODE_SLOT_KEYWORD.length).split(",").map(Number) ?? [];
  const [left, top, right, bottom] = nums;
  if (nums.length !== 4 || left === undefined || top === undefined || right === undefined || bottom === undefined || nums.some((n) => !Number.isFinite(n))) return undefined;
  return { left, top, right, bottom };
}

/** Draw the Verify code for `url` on every page of one sheet's PDF and return the new bytes. */
export async function stampSheetCode(sheetPdf: Uint8Array, url: string): Promise<Uint8Array> {
  const matrix = encodeQr(url);
  const doc = await PDFDocument.load(sheetPdf, { updateMetadata: false });
  const librarySlot = codeSlotOf(doc.getKeywords());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const m = SHEET_CODE_MODULE_PT;
  const q = SHEET_CODE_QUIET_MODULES;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const box = sheetCodeBox(width, height, matrix.length, librarySlot);
    page.drawRectangle({ x: box.x, y: box.y, width: box.size, height: box.size + box.captionHeight, color: rgb(1, 1, 1) });
    const top = box.y + box.size - q * m;
    for (const run of qrRuns(matrix)) {
      page.drawRectangle({ x: box.x + (q + run.col) * m, y: top - (run.row + 1) * m, width: run.length * m, height: m, color: rgb(0, 0, 0) });
    }
    const captionWidth = font.widthOfTextAtSize(SHEET_CODE_CAPTION, SHEET_CODE_CAPTION_PT);
    page.drawText(SHEET_CODE_CAPTION, { x: box.x + (box.size - captionWidth) / 2, y: box.y + box.size + 0.5, size: SHEET_CODE_CAPTION_PT, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}
