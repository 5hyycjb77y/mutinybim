'use client'

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { SheetScene } from '@permitzip/bim-kernel'
import type { SheetImageSource } from '@permitzip/bim-sheets/pdf-core'
import { Spinner } from '../../ui/spinner'
import { scenePdfBytes } from './print-sheet'

/** Longest side of a rendered bitmap, device pixels (browsers cap canvas size). */
export const MAX_RENDER_PX = 8192
/** Wait for edits, zoom and pan to settle before rendering a new PDF. */
const SETTLE_MS = 350
/** A render still running after this long is reported as failed (a late finish still shows). */
export const RENDER_TIMEOUT_MS = 20_000
/** Extra page drawn round the visible window, as a share of its size, so a short pan stays sharp. */
const WINDOW_MARGIN = 0.25

/** The last finished render: which scene the canvas shows, or which scene failed and why. */
type Rendered = { readonly kind: 'ready'; readonly scene: SheetScene } | { readonly kind: 'failed'; readonly scene: SheetScene; readonly message: string }

/** Where on the paper the bitmap sits, as shares of the paper, so a zoom keeps it in place until the next render. */
interface Placement {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface PrintedWindow {
  /** pdf.js scale: device pixels per PDF point. Never capped, so text is as sharp as the screen. */
  readonly scale: number
  /** Bitmap size in device pixels (at most MAX_RENDER_PX a side). */
  readonly canvasW: number
  readonly canvasH: number
  /** pdf.js viewport offset, device pixels: the page shifted so the window's corner is at the bitmap's. */
  readonly offsetX: number
  readonly offsetY: number
  readonly placement: Placement
}

/**
 * What to render for a page `pageW` x `pageH` points shown `widthPx` CSS px
 * wide. The whole page when it fits under the bitmap cap at full sharpness;
 * past that, only the part on screen (`visible`, paper CSS px) plus a margin,
 * still at full sharpness. Zoomed in on a 36 x 24 sheet, the whole page would
 * need ~25,000 px, and scaling a capped bitmap up is what blurred tags like E1.
 */
export function printedWindow(pageW: number, pageH: number, widthPx: number, ratio: number, visible: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null): PrintedWindow {
  const scale = (widthPx * ratio) / pageW
  const fullW = pageW * scale
  const fullH = pageH * scale
  if (Math.max(fullW, fullH) <= MAX_RENDER_PX || !visible) {
    // No window known: the whole page, capped (sharp up to the cap, as before).
    const fit = Math.min(scale, MAX_RENDER_PX / Math.max(pageW, pageH))
    return { scale: fit, canvasW: Math.floor(pageW * fit), canvasH: Math.floor(pageH * fit), offsetX: 0, offsetY: 0, placement: { left: 0, top: 0, width: 1, height: 1 } }
  }
  const heightPx = (widthPx * pageH) / pageW
  const mx = (visible.x1 - visible.x0) * WINDOW_MARGIN
  const my = (visible.y1 - visible.y0) * WINDOW_MARGIN
  const maxCss = MAX_RENDER_PX / ratio
  let x0 = Math.max(0, visible.x0 - mx)
  let y0 = Math.max(0, visible.y0 - my)
  const x1 = Math.min(widthPx, visible.x1 + mx, x0 + maxCss)
  const y1 = Math.min(heightPx, visible.y1 + my, y0 + maxCss)
  x0 = Math.floor(x0)
  y0 = Math.floor(y0)
  const w = Math.max(1, Math.ceil(x1) - x0)
  const h = Math.max(1, Math.ceil(y1) - y0)
  return {
    scale,
    canvasW: Math.min(MAX_RENDER_PX, Math.round(w * ratio)),
    canvasH: Math.min(MAX_RENDER_PX, Math.round(h * ratio)),
    offsetX: -x0 * ratio,
    offsetY: -y0 * ratio,
    placement: { left: x0 / widthPx, top: y0 / heightPx, width: w / widthPx, height: h / heightPx },
  }
}

/** The part of `paper` inside `viewport`, in paper CSS px; null when either is missing or nothing is on screen. */
function visibleOnPaper(paper: HTMLElement | null, viewport: HTMLElement | null): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!paper || !viewport) return null
  const p = paper.getBoundingClientRect()
  const v = viewport.getBoundingClientRect()
  const x0 = Math.max(p.left, v.left) - p.left
  const y0 = Math.max(p.top, v.top) - p.top
  const x1 = Math.min(p.right, v.right) - p.left
  const y1 = Math.min(p.bottom, v.bottom) - p.top
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}

/**
 * The printed drawing as the PDF itself: the scene goes through the same
 * vector PDF writer as Print PDF and pdf.js draws page one over the paper.
 * While a newer revision renders, the instant scene preview underneath shows
 * through and the status says so. Zoomed past what one bitmap can hold, only
 * the part on screen is drawn, at the screen's full sharpness; `frame` (the
 * paper's position and width) re-renders it after a pan or zoom settles.
 */
export function PrintedPdfLayer({
  scene,
  title,
  widthPx,
  images = null,
  viewportRef,
  frame,
}: {
  scene: SheetScene
  title: string
  widthPx: number
  images?: SheetImageSource | null
  /** The scrolling window the paper is seen through; without it the whole page renders, capped. */
  viewportRef?: RefObject<HTMLElement | null>
  /** Changes whenever the paper moves under the window (pan, zoom). */
  frame?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rendered, setRendered] = useState<Rendered | null>(null)
  const [placement, setPlacement] = useState<Placement>({ left: 0, top: 0, width: 1, height: 1 })

  useEffect(() => {
    if (widthPx <= 0) return
    let cancelled = false
    let finished = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    let task: { cancel(): void } | null = null
    const timer = setTimeout(() => {
      deadline = setTimeout(() => {
        if (cancelled || finished) return
        console.error('[PrintedPdfLayer] rendering the printed PDF timed out', { revision: scene.revision, timeoutMs: RENDER_TIMEOUT_MS })
        setRendered({ kind: 'failed', scene, message: `It was still drawing after ${RENDER_TIMEOUT_MS / 1000} seconds. Reload the page to try again.` })
      }, RENDER_TIMEOUT_MS)
      void (async () => {
        try {
          const bytes = await scenePdfBytes(scene, title, `preview-rev-${scene.revision}`, images)
          const { PDF_WORKER_SRC } = await import('@permitzip/bim-editor/assets/pdf-worker')
          const { pdfjs } = await import('react-pdf')
          pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC
          const doc = await pdfjs.getDocument({ data: bytes }).promise
          try {
            const page = await doc.getPage(1)
            const base = page.getViewport({ scale: 1 })
            const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
            const shown = canvasRef.current
            if (!shown || cancelled) return
            const win = printedWindow(base.width, base.height, widthPx, ratio, visibleOnPaper(shown.parentElement, viewportRef?.current ?? null))
            const viewport = page.getViewport({ scale: win.scale, offsetX: win.offsetX, offsetY: win.offsetY })
            const whole = win.placement.width === 1 && win.placement.height === 1
            // A window is drawn off screen first, so the picture on screen stays put while a pan re-renders.
            const target = whole ? shown : document.createElement('canvas')
            target.width = win.canvasW
            target.height = win.canvasH
            const context = target.getContext('2d')
            if (!context) throw new Error('This browser has no 2D drawing surface.')
            // Print intent: display intent paces drawing on animation frames, which never come while the
            // browser pane is off screen, so a render started there hung until the timeout. Sheet PDFs
            // carry no annotations or optional layers, so the two intents draw the same page.
            const rendering = page.render({ canvas: target, canvasContext: context, viewport, intent: 'print' })
            task = rendering
            await rendering.promise
            task = null
            if (cancelled) return
            if (!whole) {
              shown.width = win.canvasW
              shown.height = win.canvasH
              const onScreen = shown.getContext('2d')
              if (!onScreen) throw new Error('This browser has no 2D drawing surface.')
              onScreen.drawImage(target, 0, 0)
            }
            finished = true
            setPlacement(win.placement)
            setRendered({ kind: 'ready', scene })
          } finally {
            await doc.destroy()
          }
        } catch (err) {
          if (cancelled) return
          finished = true
          console.error('[PrintedPdfLayer] rendering the printed PDF failed', { revision: scene.revision, err })
          setRendered({ kind: 'failed', scene, message: err instanceof Error ? err.message : 'The PDF could not be drawn.' })
        }
      })()
    }, SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(deadline)
      // A superseded render keeps the canvas busy; the next one on it would throw "same canvas during multiple render() operations".
      task?.cancel()
    }
  }, [scene, title, widthPx, images, viewportRef, frame])

  const current = rendered?.kind === 'ready' && rendered.scene === scene
  const failed = rendered?.kind === 'failed' && rendered.scene === scene ? rendered.message : null
  const box: CSSProperties = { left: `${placement.left * 100}%`, top: `${placement.top * 100}%`, width: `${placement.width * 100}%`, height: `${placement.height * 100}%` }
  return (
    <>
      <canvas
        ref={canvasRef}
        className={`pointer-events-none absolute ${current ? 'opacity-100' : 'opacity-0'}`}
        style={box}
        data-testid="printed-pdf"
        data-revision={current ? scene.revision : undefined}
        aria-hidden
      />
      <div className="pointer-events-none absolute right-2 top-2 flex select-none items-center gap-1.5 rounded-md border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-sm" role="status" data-testid="printed-pdf-status">
        {current && `Printed PDF, Rev ${scene.revision}`}
        {failed && <span className="text-danger-600">The printed PDF couldn&apos;t be drawn: {failed} The preview underneath is the same drawing.</span>}
        {!current && !failed && (
          <>
            <Spinner />
            Updating the printed PDF…
          </>
        )}
      </div>
    </>
  )
}
