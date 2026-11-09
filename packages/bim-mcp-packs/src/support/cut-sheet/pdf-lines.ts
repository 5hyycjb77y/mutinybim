import type { CutSheetLine } from "./extract"
import { loadPdfjs, type PdfTextItemLike } from "./pdfjs"

/**
 * A PDF's text as lines, page by page, the way it reads on the sheet: pdf.js
 * text items grouped by their baseline and ordered left to right. Items far
 * apart on one line are joined with a wide gap ("  "), so a two-column table
 * row keeps its columns apart. Server-only (pdf.js legacy build, ./pdfjs).
 */

type TextItem = PdfTextItemLike

function isTextItem(v: unknown): v is TextItem {
  if (typeof v !== "object" || v === null) return false
  const str: unknown = Reflect.get(v, "str")
  const transform: unknown = Reflect.get(v, "transform")
  return typeof str === "string" && Array.isArray(transform) && transform.length >= 6
}

/** Pages read at most (cut sheets are a few pages; a 300-page manual is not one). */
export const MAX_CUT_SHEET_PAGES = 12
/** Bytes read at most. */
export const MAX_CUT_SHEET_BYTES = 25 * 1024 * 1024

export async function pdfLines(bytes: Uint8Array): Promise<{ pages: number; lines: CutSheetLine[] }> {
  if (bytes.byteLength > MAX_CUT_SHEET_BYTES) throw new Error(`The PDF is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; a cut sheet should be under ${MAX_CUT_SHEET_BYTES / 1024 / 1024} MB`)
  const { getDocument } = await loadPdfjs()
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise
  const lines: CutSheetLine[] = []
  try {
    const last = Math.min(doc.numPages, MAX_CUT_SHEET_PAGES)
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const items = content.items.filter(isTextItem).filter((i) => i.str.trim() !== "")
      const rows: Array<{ y: number; items: TextItem[] }> = []
      for (const item of items) {
        const y = item.transform[5] ?? 0
        const row = rows.find((r) => Math.abs(r.y - y) < 2.5)
        if (row) row.items.push(item)
        else rows.push({ y, items: [item] })
      }
      rows.sort((a, b) => b.y - a.y)
      for (const row of rows) {
        row.items.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0))
        let text = ""
        let end = -Infinity
        for (const item of row.items) {
          const x = item.transform[4] ?? 0
          text += text === "" ? item.str : x - end > 18 ? `  ${item.str}` : x - end > 1 ? ` ${item.str}` : item.str
          end = x + item.width
        }
        lines.push({ page: n, text: text.replace(/[ \t]+$/g, "") })
      }
    }
    return { pages: doc.numPages, lines }
  } finally {
    await doc.destroy?.().catch((err: unknown) => console.error("[cut-sheet] pdf.js document cleanup failed", err))
  }
}
