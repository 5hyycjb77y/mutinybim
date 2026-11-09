import { pdfjs } from 'react-pdf'

/** The bundled pdf.js worker. react-pdf sets a bare `pdf.worker.mjs` default when its module loads, so code that renders straight through `pdfjs` sets this again first. */
export const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC

/**
 * Stable react-pdf Document options. Must be a module-level constant —
 * inline `options={{...}}` recreates the object every render and forces
 * pdf.js to reload the worker/document.
 *
 * Cast: react-pdf's DocumentInitParameters typings omit imageResourcesPath.
 */
export const PDF_DOCUMENT_OPTIONS = {
  imageResourcesPath: '/pdfjs/images/',
} as Record<string, string>
