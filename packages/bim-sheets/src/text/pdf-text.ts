import fontkit from "@pdf-lib/fontkit";
import { degrees, rgb, type PDFDocument, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { boxToPaper, type NoteFace, type TextBlock } from "@permitzip/bim-kernel";
import { loadVerifiedFace, type NoteFontSource } from "./fonts";

/**
 * Draw laid-out notes into a PDF page. Each glyph piece is placed at the x
 * and baseline the layout engine computed (the screen places the same
 * pieces), with the embedded font's own advances inside a piece and kerning
 * and ligatures off, so the printed glyphs land where the screen drew them.
 */

const MM_TO_PT = 72 / 25.4;
/** No shaping: the layout measured plain advances, so the PDF must not substitute or kern. */
const NO_SHAPING = { liga: false, clig: false, dlig: false, calt: false, rlig: false, kern: false } as const;

function color(hex: string | null): RGB {
  if (!hex) return rgb(0, 0, 0);
  const v = Number.parseInt(hex.slice(1), 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

export async function drawTextBlocks(doc: PDFDocument, page: PDFPage, blocks: readonly TextBlock[], source: NoteFontSource): Promise<void> {
  if (blocks.length === 0) return;
  doc.registerFontkit(fontkit);
  const height = page.getHeight();
  const fonts = new Map<NoteFace, PDFFont>();
  const fontFor = async (face: NoteFace): Promise<PDFFont> => {
    const have = fonts.get(face);
    if (have) return have;
    const bytes = await loadVerifiedFace(source, face);
    // A fixed name keeps the bytes deterministic for one snapshot (pdf-lib otherwise adds a random suffix).
    const font = await doc.embedFont(bytes, { subset: true, customName: `MutinyBIMNotes-${face}`, features: NO_SHAPING });
    fonts.set(face, font);
    return font;
  };
  const toPdf = (block: TextBlock, local: { x: number; y: number }) => {
    const p = boxToPaper(block, local);
    return { x: p.x * MM_TO_PT, y: height - p.y * MM_TO_PT };
  };

  for (const block of blocks) {
    const rotate = degrees(-block.rotation);
    for (const line of block.layout.lines) {
      for (const piece of line.pieces) {
        if (piece.text.trim().length === 0) continue;
        const font = await fontFor(piece.face);
        const at = toPdf(block, { x: piece.x, y: piece.baseline });
        page.drawText(piece.text, { x: at.x, y: at.y, size: piece.em * MM_TO_PT, font, color: color(piece.color), rotate });
      }
      for (const u of line.underlines) {
        const at = toPdf(block, { x: u.x0, y: u.y + u.thickness });
        page.drawRectangle({ x: at.x, y: at.y, width: (u.x1 - u.x0) * MM_TO_PT, height: u.thickness * MM_TO_PT, color: color(u.color), rotate });
      }
    }
  }
}
