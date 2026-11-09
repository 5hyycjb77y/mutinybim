'use client'

import type { CategoryRegistry, ModelState, SheetScene, ViewBackgrounds } from '@permitzip/bim-kernel'
import type { PdfPrintOptions, SheetImageSource } from '@permitzip/bim-sheets/pdf-core'
import type { SheetTitle } from '../../contracts/building-model/sheet-title'

/**
 * The vector PDF of a drawing scene: the one writer Print PDF and the printed
 * preview both use, so the preview is the printed file.
 */
export async function scenePdfBytes(scene: SheetScene, title: string, snapshotSha256: string, images: SheetImageSource | null = null, print: PdfPrintOptions = {}): Promise<Uint8Array> {
  const pdfCore = await import('@permitzip/bim-sheets/pdf-core')
  const pdf = await pdfCore.renderSheetPdfWith(scene, { title, modelRevision: scene.revision, snapshotSha256, renderer: 'mutinybim-browser' }, null, pdfCore.fetchNoteFonts(), images, print)
  return pdf.bytes
}

/**
 * Print one sheet in the browser from an exact model revision: the same scene
 * graph (with its views' linked-model backgrounds) and vector PDF writer the
 * server issues with, at true paper size. `categories` (the firm library's
 * classes) lets Visibility/Graphics on a firm class print; absent, the
 * built-in categories, which every other sheet prints identically under.
 */
export async function printSheetPdf(model: ModelState, sheetId: string, title: SheetTitle, backgrounds: ViewBackgrounds = {}, images: SheetImageSource | null = null, categories?: CategoryRegistry): Promise<{ fileName: string; revision: number; sha256: string }> {
  const kernel = await import('@permitzip/bim-kernel')
  const { ensureBimChartKinds } = await import('../../contracts/bim/chart-kinds')
  ensureBimChartKinds()
  const sheet = model.elements[sheetId]
  if (!sheet || sheet.kind !== 'sheet') throw new Error('That sheet no longer exists.')
  const build = () => kernel.buildSheetSceneFor(model, sheetId, { ...title, backgrounds })
  const scene = categories ? kernel.withCategoryRegistry(categories, build) : build()
  const snapshot = await sha256Hex(new TextEncoder().encode(kernel.canonicalJson({ modelId: model.modelId, revision: model.revision, sheetId })))
  // The project's black-only choice prints here exactly as an issued set does.
  const { modelPrintOptions } = await import('@permitzip/bim-sheets/pdf-core')
  const bytes = await scenePdfBytes(scene, `${sheet.number} ${sheet.title}`, snapshot, images, modelPrintOptions(model))
  const sha256 = await sha256Hex(bytes)
  const fileName = `${sheet.number.replace(/[^\w.-]/g, '_')}-rev${model.revision}.pdf`
  const blob = new Blob([bytes.slice().buffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { fileName, revision: model.revision, sha256 }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
