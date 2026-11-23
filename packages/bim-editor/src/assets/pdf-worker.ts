import { pdfjs } from 'react-pdf'

/** The bundled pdf.js worker. react-pdf sets a bare `pdf.worker.mjs` default when its module loads, so code that renders straight through `pdfjs` sets this again first. */
export const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC

export const PDF_IMAGE_RESOURCES_PATH = '/pdfjs/images/'

/**
 * Stable react-pdf Document options. Must be a module-level constant —
 * inline `options={{...}}` recreates the object every render and forces
 * pdf.js to reload the worker/document.
 *
 * Points pdf.js at self-hosted CMaps, Standard-14 fonts, OpenJPEG/QCMS WASM,
 * and ICC profiles so Bluebeam/CAD PDFs do not silently degrade fonts, scans,
 * or colors.
 */
export const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
}
