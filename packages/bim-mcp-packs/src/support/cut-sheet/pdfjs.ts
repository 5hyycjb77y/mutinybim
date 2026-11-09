/**
 * pdf.js (legacy build) for server-side text extraction, with its worker
 * registered in-process (no worker thread to spawn). Tests
 * swap this module for one that loads pdf.js through Node's own loader
 * (Jest can't load pdf.js's ES module).
 */

export interface PdfTextItemLike {
  readonly str: string
  readonly transform: readonly number[]
  readonly width: number
}

export interface PdfPageLike {
  getTextContent: () => Promise<{ items: ReadonlyArray<unknown> }>
}

export interface PdfDocumentLike {
  readonly numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
  destroy?: () => Promise<void>
}

export type GetPdfDocument = (opts: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean }) => { promise: Promise<PdfDocumentLike> }

export function pdfjsFrom(mod: unknown): { getDocument: GetPdfDocument } {
  if (typeof mod !== "object" || mod === null || typeof Reflect.get(mod, "getDocument") !== "function") throw new Error("pdf.js didn't load")
  return { getDocument: Reflect.get(mod, "getDocument") as GetPdfDocument }
}

export async function loadPdfjs(): Promise<{ getDocument: GetPdfDocument }> {
  const g = globalThis as typeof globalThis & { pdfjsWorker?: unknown }
  if (!g.pdfjsWorker) {
    // @ts-expect-error pdf.js worker module has no declaration file.
    g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  }
  return pdfjsFrom(await import("pdfjs-dist/legacy/build/pdf.mjs"))
}
