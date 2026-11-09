import { sheetViewportOverhangs, type ModelState } from "@permitzip/bim-kernel";
import type { RenderedPdf } from "./pdf-core";

/**
 * What a printed sheet's reader should know that the PDF alone doesn't say:
 * viewports that run past the sheet's drawing area (so part of a drawing is
 * off the paper or under the title block), and labels the PDF's standard font
 * printed differently from the screen (`1⅜"` as `1-3/8"`). Empty when the
 * sheet printed as drawn.
 */
export function sheetPrintNotes(model: ModelState, sheetId: string, sheetNumber: string, rendered: Pick<RenderedPdf, "substitutedText">): string[] {
  const notes = sheetViewportOverhangs(model, sheetId).map((o) => o.message);
  const subs = rendered.substitutedText;
  if (subs.length > 0) {
    const shown = subs.slice(0, 5).map((s) => `${s.printed} for ${s.text}`).join(", ");
    notes.push(`Sheet ${sheetNumber}: the PDF's standard font has no glyph for some characters, so it printed ${shown}${subs.length > 5 ? ` and ${subs.length - 5} more` : ""}. The drawing on screen is unchanged.`);
  }
  return notes;
}
