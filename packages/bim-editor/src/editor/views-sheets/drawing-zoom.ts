'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { FlatViewNavigator, KEY_ZOOM_STEP } from '../input/flat-view-nav'

/**
 * Zoom and pan for sheets and drawings (drafting and detail views, plan /
 * section / elevation drawings, and the schedules and printed PDF on them),
 * the same way the 3D and plan views zoom: the wheel, a two-finger scroll and
 * a pinch zoom toward the pointer, middle-drag / Space-drag / a drag on empty
 * paper pans, a middle double-click, F or 0 fits, + / − step. Gestures come
 * from `input/flat-view-nav.ts`; this hook keeps the paper's place.
 *
 * The paper is laid out at its zoomed size (not scaled with a CSS transform),
 * so the drawing's vector linework is redrawn sharp at every zoom and the
 * printed PDF re-renders at the new size. `zoom` is relative to "fit": 1
 * shows the whole sheet in the window.
 */

export const MIN_ZOOM = 0.2
/** Fit-relative ceiling for small papers; larger papers go to MAX_ACTUAL_SIZE of their actual size. */
export const MAX_ZOOM = 16
/** Closest zoom on a sheet: 800% of actual paper size. */
export const MAX_ACTUAL_SIZE = 8
/** Space around the paper when it fits the window, px. */
export const FIT_PAD_PX = 16
/** This much of the paper always stays in the window, px, so it can't be panned away. */
export const KEEP_VISIBLE_PX = 48
/** CSS pixels per paper millimetre at actual size (96 dpi). */
export const PX_PER_MM = 96 / 25.4

export interface Size {
  readonly w: number
  readonly h: number
}

export interface PaperMm {
  readonly x: number
  readonly y: number
}

/** Where the paper sits: fit-relative zoom, and its top-left corner in the window, px. */
export interface PaperView {
  readonly zoom: number
  readonly x: number
  readonly y: number
}

export interface ZoomLimits {
  readonly min: number
  readonly max: number
}

/** Fit-relative zoom that shows the paper at actual size (100%), given the fit width in px. */
export function actualSizeZoom(paperWidthMm: number, fitWidthPx: number): number {
  if (fitWidthPx <= 0 || paperWidthMm <= 0) return 1
  return (paperWidthMm * PX_PER_MM) / fitWidthPx
}

/** Sheet limits: out to a fifth of the window; in to 800% of the paper's actual size (at least 16× fit). */
export function zoomLimits(paperWidthMm: number, fitWidthPx: number): ZoomLimits {
  return { min: MIN_ZOOM, max: Math.max(MAX_ZOOM, actualSizeZoom(paperWidthMm, fitWidthPx) * MAX_ACTUAL_SIZE) }
}

export function clampZoom(z: number, limits: ZoomLimits = { min: MIN_ZOOM, max: MAX_ZOOM }): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(limits.max, Math.max(limits.min, z))
}

export function zoomStep(zoom: number, direction: 1 | -1, limits?: ZoomLimits): number {
  return clampZoom(direction > 0 ? zoom * KEY_ZOOM_STEP : zoom / KEY_ZOOM_STEP, limits)
}

/** The zoom as a PDF viewer shows it: percent of actual paper size; falls back to percent of fit before layout. */
export function zoomPercent(zoom: number, paperWidthMm: number, fitWidthPx: number): number {
  if (fitWidthPx <= 0 || paperWidthMm <= 0) return Math.round(zoom * 100)
  return Math.round(((zoom * fitWidthPx) / (paperWidthMm * PX_PER_MM)) * 100)
}

/** Paper width at zoom 1: the whole sheet inside the window, less the padding. */
export function fitWidthFor(viewport: Size, paper: PaperMm, pad = FIT_PAD_PX): number {
  const w = viewport.w - pad * 2
  const h = viewport.h - pad * 2
  if (w <= 0 || h <= 0 || paper.x <= 0 || paper.y <= 0) return Math.max(0, w)
  return Math.min(w, (h * paper.x) / paper.y)
}

/** Zoom extents: the paper at zoom 1, centred in the window. */
export function fittedView(viewport: Size, paper: PaperMm, pad = FIT_PAD_PX): PaperView {
  const width = fitWidthFor(viewport, paper, pad)
  const height = paper.x > 0 ? (width * paper.y) / paper.x : 0
  return { zoom: 1, x: (viewport.w - width) / 2, y: (viewport.h - height) / 2 }
}

/**
 * Magnify about `at` (window px): the paper point under `at` stays under it.
 * That point is at (at − corner) / zoom in fit pixels before and after, so the
 * corner moves to at − (at − corner) × (new / old).
 */
export function zoomAtPoint(view: PaperView, factor: number, at: { readonly x: number; readonly y: number }, limits: ZoomLimits): PaperView {
  const zoom = clampZoom(view.zoom * factor, limits)
  const f = zoom / view.zoom
  if (f === 1) return view
  return { zoom, x: at.x - (at.x - view.x) * f, y: at.y - (at.y - view.y) * f }
}

export function panView(view: PaperView, dx: number, dy: number): PaperView {
  return { zoom: view.zoom, x: view.x + dx, y: view.y + dy }
}

/** Keep at least `keep` px of the paper in the window each way. */
export function keepOnScreen(view: PaperView, viewport: Size, paperPx: Size, keep = KEEP_VISIBLE_PX): PaperView {
  const kx = Math.min(keep, paperPx.w, viewport.w)
  const ky = Math.min(keep, paperPx.h, viewport.h)
  const x = Math.min(viewport.w - kx, Math.max(kx - paperPx.w, view.x))
  const y = Math.min(viewport.h - ky, Math.max(ky - paperPx.h, view.y))
  return x === view.x && y === view.y ? view : { zoom: view.zoom, x, y }
}

/** The paper point (mm) under window point `at`. */
export function paperPointAt(view: PaperView, fitWidthPx: number, paper: PaperMm, at: { readonly x: number; readonly y: number }): { x: number; y: number } {
  const pxPerMm = (view.zoom * fitWidthPx) / paper.x
  return { x: (at.x - view.x) / pxPerMm, y: (at.y - view.y) / pxPerMm }
}

interface State extends PaperView {
  /** Untouched since the last fit: a window resize fits again. */
  readonly fitted: boolean
}

/** The paper's size on screen at a view's zoom, px. */
function paperPx(view: PaperView, viewport: Size, paper: PaperMm): Size {
  const w = view.zoom * fitWidthFor(viewport, paper)
  return { w, h: paper.x > 0 ? (w * paper.y) / paper.x : 0 }
}

function measure(el: HTMLElement | null): Size {
  if (!el) return { w: 0, h: 0 }
  const r = el.getBoundingClientRect()
  return { w: r.width, h: r.height }
}

/** How long the wheel or a pan must pause before the paper is laid out again at the new zoom (sharp linework), ms. */
export const PREVIEW_SETTLE_MS = 140

function sameView(a: PaperView, b: PaperView): boolean {
  return a.zoom === b.zoom && a.x === b.x && a.y === b.y
}

/**
 * `paperRef` is the paper element the returned `paperStyle` is applied to.
 * While the wheel turns or a pan drags, the paper only moves with a GPU
 * transform (no React render, so a busy sheet keeps the frame rate); once it
 * pauses for PREVIEW_SETTLE_MS the paper is laid out at the new size and the
 * transform drops, in the same frame.
 */
export function useDrawingZoom(viewportRef: RefObject<HTMLDivElement | null>, paperRef: RefObject<HTMLDivElement | null>, paper: PaperMm) {
  /** What the paper is laid out at (React state; drives layout, `zoom` and `percent`). */
  const [state, setState] = useState<State>({ zoom: 1, x: 0, y: 0, fitted: true })
  const [size, setSize] = useState<Size>({ w: 0, h: 0 })
  const [navigator, setNavigator] = useState<FlatViewNavigator | null>(null)
  /** What is on screen: the layout plus the preview transform. All gesture math starts from here. */
  const live = useRef<State>(state)
  /** The layout the DOM actually has (updated after React commits it). */
  const laidOut = useRef<State>(state)
  const env = useRef({ size, paper })
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    env.current = { size, paper }
  })

  const fitWidthPx = fitWidthFor(size, paper)
  const limits = zoomLimits(paper.x, fitWidthPx)

  /** Put the paper where `live` says, as a transform over its current layout. */
  const showLive = useCallback(() => {
    const el = paperRef.current
    if (!el) return
    const l = live.current
    const c = laidOut.current
    if (sameView(l, c)) {
      el.style.transform = ''
      return
    }
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${l.x - c.x}px, ${l.y - c.y}px) scale(${l.zoom / c.zoom})`
  }, [paperRef])

  const commit = useCallback(() => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = null
    setState(live.current)
  }, [])

  /** Show `next` now; lay it out once things pause (wheel, pan) or straight away (fit, keys, buttons). */
  const show = useCallback(
    (next: State, now: boolean) => {
      live.current = next
      showLive()
      if (now) {
        commit()
        return
      }
      if (settle.current) clearTimeout(settle.current)
      settle.current = setTimeout(commit, PREVIEW_SETTLE_MS)
    },
    [showLive, commit],
  )

  // The new layout is in the DOM: drop (or shrink) the transform before paint, so nothing jumps.
  useLayoutEffect(() => {
    laidOut.current = state
    showLive()
  }, [state, showLive])

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current)
    },
    [],
  )

  const zoomBy = useCallback(
    (factor: number, at: { x: number; y: number } | undefined, now: boolean) => {
      const { size: sz, paper: p } = env.current
      const s = live.current
      const lim = zoomLimits(p.x, fitWidthFor(sz, p))
      const z = zoomAtPoint(s, factor, at ?? { x: sz.w / 2, y: sz.h / 2 }, lim)
      if (z === s) return
      show({ ...keepOnScreen(z, sz, paperPx(z, sz, p)), fitted: false }, now)
    },
    [show],
  )

  const fit = useCallback(() => {
    const { size: sz, paper: p } = env.current
    show({ ...fittedView(sz, p), fitted: true }, true)
  }, [show])

  // The window's size; a fitted paper follows it.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => {
      const next = measure(el)
      const prev = env.current.size
      if (next.w === prev.w && next.h === prev.h) return
      env.current = { ...env.current, size: next }
      setSize(next)
      if (live.current.fitted) show({ ...fittedView(next, env.current.paper), fitted: true }, true)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewportRef, show])

  // A new paper size (another sheet size) fits again.
  useLayoutEffect(() => {
    if (live.current.fitted) fit()
  }, [paper.x, paper.y, fit])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const nav = new FlatViewNavigator(el, {
      zoom: (factor, clientX, clientY) => {
        const r = el.getBoundingClientRect()
        zoomBy(factor, { x: clientX - r.left, y: clientY - r.top }, false)
      },
      pan: (dx, dy) => {
        const { size: sz, paper: p } = env.current
        const moved = panView(live.current, dx, dy)
        show({ ...keepOnScreen(moved, sz, paperPx(moved, sz, p)), fitted: false }, false)
      },
      fit,
    })
    setNavigator(nav)
    return () => {
      nav.dispose()
      setNavigator(null)
    }
  }, [viewportRef, zoomBy, fit, show])

  const setZoom = useCallback(
    (next: number, at?: { clientX: number; clientY: number }) => {
      const r = viewportRef.current?.getBoundingClientRect()
      zoomBy(next / live.current.zoom, at && r ? { x: at.clientX - r.left, y: at.clientY - r.top } : undefined, true)
    },
    [viewportRef, zoomBy],
  )

  const paperStyle: CSSProperties = {
    position: 'absolute',
    left: state.x,
    top: state.y,
    width: state.zoom * fitWidthPx,
    aspectRatio: `${paper.x} / ${paper.y}`,
  }

  return {
    zoom: state.zoom,
    fitWidthPx,
    limits,
    percent: zoomPercent(state.zoom, paper.x, fitWidthPx),
    paperStyle,
    navigator,
    zoomIn: () => zoomBy(KEY_ZOOM_STEP, undefined, true),
    zoomOut: () => zoomBy(1 / KEY_ZOOM_STEP, undefined, true),
    fit,
    actualSize: () => setZoom(actualSizeZoom(paper.x, fitWidthPx)),
    setZoom,
  }
}
