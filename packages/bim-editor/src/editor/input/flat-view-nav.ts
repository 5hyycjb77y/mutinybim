/**
 * Zoom and pan for every flat MutinyBIM view (sheets, drafting and detail
 * views, plan / section / elevation drawings, schedules and the printed PDF
 * on a sheet, the part editor's plan, front and side), with the same feel as
 * the 3D and plan cameras (an internal design note, "Zoom and pan"):
 *
 * - A two-finger trackpad swipe pans; a pinch (a wheel with Ctrl, which is
 *   how macOS browsers deliver it) zooms toward the pointer. A notched mouse
 *   wheel zooms toward the pointer (`MOUSE_WHEEL_ACTION`, product decision, Nov 3: "like
 *   Revit / AutoCAD"); `wheelSource` tells the two apart. The point under the
 *   pointer stays under it; the step is the one 3D uses
 *   (`@permitzip/bim-viewer-3d/wheel-zoom`). Shift + wheel pans.
 * - Middle-drag pans, and so does holding the left and right buttons together
 *   (the chord many Mac mice send; `@permitzip/bim-viewer-3d/pan-buttons`).
 *   A chord that forms during a left drag cancels that drag and pans instead.
 *   Space + drag pans, and a drag that starts on empty paper in Select pans
 *   (a press there that doesn't move is still a click). A pan never opens the
 *   right-button menu or clicks; a plain right-click still opens it. Esc
 *   during a pan puts the view back where the pan started.
 * - A middle double-click, F or 0 zooms to extents; + / − step.
 *
 * The navigator is the camera side of a `GestureArbiter`: an edit that owns
 * the pointer (a grip, a box, a duct drag) claims it, and then buttons do not
 * pan. The wheel and the trackpad keep zooming and panning. No React here; `drawing-zoom.ts`
 * and the part editor apply the zoom to their own view state.
 */

import { PanButtonGuard, panButtonOf } from '@permitzip/bim-viewer-3d/pan-buttons'
import { wheelMagnification, wheelTravelPx } from '@permitzip/bim-viewer-3d/wheel-zoom'
import { GestureArbiter, type PointerCamera } from './gesture-arbiter'

/** + and − zoom by this much, about the middle of the view. */
export const KEY_ZOOM_STEP = 1.25
/** Two middle presses within this long and this close are a double-click (zoom extents); the same as 3D. */
export const MIDDLE_DOUBLE_CLICK_MS = 400
export const MIDDLE_DOUBLE_CLICK_PX = 6

/** What a surface does with the gestures. Points are client (viewport) pixels. */
export interface FlatNavTarget {
  /** Magnify by `factor` (above 1 is closer) keeping the content under (clientX, clientY) where it is. */
  zoom(factor: number, clientX: number, clientY: number): void
  /** Move the content by (dx, dy) screen pixels: it follows the pointer. */
  pan(dx: number, dy: number): void
  /** Zoom extents: the whole sheet / drawing / part in the window. */
  fit(): void
}

export interface FlatNavOptions {
  /** Listen for + / − / 0 / F on the window (one flat view on screen at a time). Default true. */
  readonly keyboard?: boolean
}

export type WheelIntent = { readonly kind: 'zoom'; readonly factor: number } | { readonly kind: 'pan'; readonly dx: number; readonly dy: number }

export type WheelSource = 'mouse' | 'trackpad'

/** What a plain (no Ctrl, no Shift) notched mouse wheel does on a flat view. The one place to flip it. */
export const MOUSE_WHEEL_ACTION: 'zoom' | 'pan' = 'zoom'

/** A mouse notch reports at least this much travel in pixel mode; a trackpad's stream reports small steps. */
export const MOUSE_NOTCH_MIN_PX = 50
/** Wheel events closer together than this are one gesture: it keeps the source its first event had. */
export const WHEEL_STREAM_GAP_MS = 150

export interface WheelLike {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  /** Chrome and Safari's legacy field: whole multiples of 120 per mouse notch, −3 × deltaY on a trackpad. */
  readonly wheelDeltaY?: number
}

/**
 * Mouse wheel or trackpad, from one event: line or page deltas are a notched
 * wheel; a sideways delta is two fingers; the legacy delta is a whole number
 * of 120-steps only for a notch; otherwise a large whole pixel step with no
 * sideways part is a notch and anything smaller is a trackpad.
 */
export function wheelSource(e: WheelLike): WheelSource {
  if (e.deltaMode !== 0) return 'mouse'
  if (e.deltaX !== 0) return 'trackpad'
  const legacy = e.wheelDeltaY
  if (typeof legacy === 'number' && legacy !== 0) return legacy % 120 === 0 ? 'mouse' : 'trackpad'
  return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= MOUSE_NOTCH_MIN_PX ? 'mouse' : 'trackpad'
}

/** Keeps a gesture's source steady across its events (a trackpad swipe can send one 120-sized step mid-stream). */
export class WheelSourceTracker {
  private last: { readonly source: WheelSource; readonly at: number } | null = null

  classify(e: WheelLike, at: number): WheelSource {
    const source = this.last && at - this.last.at < WHEEL_STREAM_GAP_MS ? this.last.source : wheelSource(e)
    this.last = { source, at }
    return source
  }
}

/**
 * What one wheel event does in a flat view: a pinch (Ctrl) zooms; Shift pans
 * sideways; a trackpad swipe pans with the fingers; a mouse wheel does
 * `MOUSE_WHEEL_ACTION`.
 */
export function wheelIntent(e: WheelLike, source: WheelSource = wheelSource(e)): WheelIntent {
  if (e.shiftKey && !e.ctrlKey) {
    // Browsers turn Shift + wheel into a sideways scroll on some platforms and not on others.
    const along = e.deltaX !== 0 ? e.deltaX : e.deltaY
    return { kind: 'pan', dx: -wheelTravelPx(along, e.deltaMode), dy: 0 }
  }
  if (e.ctrlKey) return { kind: 'zoom', factor: wheelMagnification(e) }
  if (source === 'trackpad' || MOUSE_WHEEL_ACTION === 'pan') {
    return { kind: 'pan', dx: -wheelTravelPx(e.deltaX, e.deltaMode), dy: -wheelTravelPx(e.deltaY, e.deltaMode) }
  }
  return { kind: 'zoom', factor: wheelMagnification(e) }
}

/** Fired (bubbling) from a flat view the first time it sees a trackpad swipe or pinch, for the one-time hint. */
export const TRACKPAD_GESTURE_EVENT = 'mutinybim:trackpad-gesture'

function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/** Safari's trackpad pinch: non-standard gesture events with a running `scale`. */
interface GestureLike extends Event {
  readonly scale: number
  readonly clientX: number
  readonly clientY: number
}

function isGestureLike(e: Event): e is GestureLike {
  return 'scale' in e && typeof Reflect.get(e, 'scale') === 'number'
}

interface PanDrag {
  readonly pointerId: number
  readonly via: 'middle' | 'chord' | 'space' | 'empty'
  x: number
  y: number
  /** How far this pan has moved the view, px (Esc moves it back). */
  movedX: number
  movedY: number
  /** For an empty-paper press: run when it is released without moving (the click it would have been). */
  readonly onClick: (() => void) | null
}

/** A `pointercancel` for the pointer a chord takes over, so whatever its left press started (a grip, a move, a box) gives up as on a lost pointer. */
function cancelFor(e: PointerEvent): Event {
  const init = { bubbles: true, cancelable: false, clientX: e.clientX, clientY: e.clientY }
  if (typeof PointerEvent === 'function') return new PointerEvent('pointercancel', { ...init, pointerId: e.pointerId, pointerType: e.pointerType })
  const cancel = new MouseEvent('pointercancel', init)
  Object.defineProperty(cancel, 'pointerId', { value: e.pointerId })
  return cancel
}

export class FlatViewNavigator implements PointerCamera {
  private readonly arbiter = new GestureArbiter(this)
  private readonly claims = new Set<symbol>()
  private readonly guard: PanButtonGuard
  private drag: PanDrag | null = null
  /** Set while this navigator dispatches the cancel for a pointer a chord takes over; its own cancel handler ignores it. */
  private handingOver = false
  private spaceHeld = false
  private lastMiddle: { time: number; x: number; y: number } | null = null
  private gestureScale = 1
  private readonly wheelSources = new WheelSourceTracker()
  /** This view already announced a trackpad gesture (the hint asks once per view at most). */
  private trackpadSeen = false
  /** Wheel zoom and pan gathered since the last frame, applied once per frame. */
  private pending: { factor: number; x: number; y: number; dx: number; dy: number } | null = null
  private frame = 0
  private readonly detachers: Array<() => void> = []

  constructor(
    private readonly element: HTMLElement | SVGElement,
    private readonly target: FlatNavTarget,
    options: FlatNavOptions = {},
  ) {
    const on = <K extends keyof GlobalEventHandlersEventMap>(type: K, fn: (e: GlobalEventHandlersEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      const listener = fn as EventListener
      element.addEventListener(type, listener, opts)
      this.detachers.push(() => element.removeEventListener(type, listener, opts))
    }
    // Non-passive so a pinch doesn't zoom the page and the wheel doesn't scroll it.
    on('wheel', this.onWheel, { passive: false })
    // Capture: the middle button, the chord and Space + drag pan even over a grip or a viewport, before their own handlers.
    on('pointerdown', this.onPointerDownCapture, { capture: true })
    on('pointermove', this.onPointerMove, { capture: true })
    on('pointerup', this.onPointerUp, { capture: true })
    on('pointercancel', this.onPointerCancel)
    on('lostpointercapture', this.onPointerCancel)
    // The menu, the click and the middle button's autoscroll / paste / new tab a pan would otherwise trigger.
    this.guard = new PanButtonGuard(element)
    this.detachers.push(() => this.guard.dispose())
    for (const type of ['gesturestart', 'gesturechange'] as const) {
      const fn = type === 'gesturestart' ? this.onGestureStart : this.onGestureChange
      element.addEventListener(type, fn)
      this.detachers.push(() => element.removeEventListener(type, fn))
    }
    if (options.keyboard !== false) {
      window.addEventListener('keydown', this.onKeyDown)
      window.addEventListener('keyup', this.onKeyUp)
      window.addEventListener('blur', this.onBlur)
      this.detachers.push(() => {
        window.removeEventListener('keydown', this.onKeyDown)
        window.removeEventListener('keyup', this.onKeyUp)
        window.removeEventListener('blur', this.onBlur)
      })
    }
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.pending = null
    this.endPan()
    for (const detach of this.detachers.splice(0)) detach()
  }

  /** An edit owns the pointer: buttons stop panning (the wheel keeps zooming). Returns the release. */
  claimPointer(owner: string): () => void {
    const claim = Symbol(owner)
    this.claims.add(claim)
    if (this.drag) this.endPan()
    return () => {
      this.claims.delete(claim)
    }
  }

  get pointerBlocked(): boolean {
    return this.claims.size > 0
  }

  /** A pan is in progress (middle, chord, Space or an empty-paper drag). */
  get panning(): boolean {
    return this.drag !== null && (this.drag.via !== 'empty' || this.arbiter.active()?.moved === true)
  }

  /**
   * A primary press on empty paper in Select (the surface decided nothing was
   * under it). It becomes a pan once it moves past the click slop; released
   * before that, `onClick` runs (deselect). The same rule as the plan view.
   */
  pressEmpty(e: PointerEvent, onClick?: () => void): boolean {
    if (e.button !== 0 || this.pointerBlocked || this.drag) return false
    this.arbiter.press(e.pointerId, e.clientX, e.clientY, { tool: 'select', shiftKey: false }, {})
    this.startPan(e, 'empty', onClick ?? null)
    return true
  }

  /** + / − about the middle of the view; F or 0 zooms to extents. */
  zoomStep(direction: 1 | -1) {
    const r = this.element.getBoundingClientRect()
    this.target.zoom(direction > 0 ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP, r.left + r.width / 2, r.top + r.height / 2)
  }

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const legacy: unknown = Reflect.get(e, 'wheelDeltaY')
    const wheel: WheelLike = { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, wheelDeltaY: typeof legacy === 'number' ? legacy : undefined }
    const source = this.wheelSources.classify(wheel, e.timeStamp)
    if (source === 'trackpad' && !this.trackpadSeen) {
      this.trackpadSeen = true
      this.element.dispatchEvent(new CustomEvent(TRACKPAD_GESTURE_EVENT, { bubbles: true }))
    }
    const intent = wheelIntent(wheel, source)
    const p = this.pending ?? { factor: 1, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }
    if (intent.kind === 'zoom') {
      p.factor *= intent.factor
      p.x = e.clientX
      p.y = e.clientY
    } else {
      p.dx += intent.dx
      p.dy += intent.dy
    }
    this.pending = p
    this.schedule()
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => this.flush())
  }

  /** Apply what the wheel gathered since the last frame (one re-render per frame, however many events). */
  flush() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    const p = this.pending
    this.pending = null
    if (!p) return
    if (p.dx !== 0 || p.dy !== 0) this.target.pan(p.dx, p.dy)
    if (p.factor !== 1) this.target.zoom(p.factor, p.x, p.y)
  }

  private readonly onGestureStart = (e: Event) => {
    e.preventDefault()
    this.gestureScale = 1
    if (!this.trackpadSeen) {
      this.trackpadSeen = true
      this.element.dispatchEvent(new CustomEvent(TRACKPAD_GESTURE_EVENT, { bubbles: true }))
    }
  }

  private readonly onGestureChange = (e: Event) => {
    e.preventDefault()
    if (!isGestureLike(e) || !(e.scale > 0)) return
    const factor = e.scale / this.gestureScale
    this.gestureScale = e.scale
    this.target.zoom(factor, e.clientX, e.clientY)
  }

  private readonly onPointerDownCapture = (e: PointerEvent) => {
    const asks = panButtonOf(e)
    if (asks === 'chord') {
      this.startChord(e)
      return
    }
    if (asks === 'middle') {
      e.preventDefault()
      e.stopPropagation()
      const last = this.lastMiddle
      if (last && e.timeStamp - last.time < MIDDLE_DOUBLE_CLICK_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < MIDDLE_DOUBLE_CLICK_PX) {
        this.lastMiddle = null
        this.endPan()
        this.target.fit()
        return
      }
      this.lastMiddle = { time: e.timeStamp, x: e.clientX, y: e.clientY }
      if (!this.pointerBlocked) this.startPan(e, 'middle', null)
      return
    }
    if (e.button === 0 && this.spaceHeld && !this.pointerBlocked) {
      e.preventDefault()
      e.stopPropagation()
      this.startPan(e, 'space', null)
    }
  }

  /**
   * Left and right held together: pan. The second button arrives as a move,
   * so the left press may already have started something on the surface (a
   * grip, a move, a box, an empty-paper press): that is cancelled, as a lost
   * pointer would be, and the view takes the pointer. Nothing is selected or
   * moved, and the menu the right button would open is swallowed.
   */
  private startChord(e: PointerEvent) {
    e.preventDefault()
    e.stopPropagation()
    const d = this.drag
    if (d && d.via !== 'empty') return
    if (d) {
      // An empty-paper press becomes this pan; it is no longer a click.
      this.arbiter.cancel()
      this.drag = null
    } else if (e.target instanceof EventTarget) {
      this.handingOver = true
      try {
        e.target.dispatchEvent(cancelFor(e))
      } finally {
        this.handingOver = false
      }
    }
    this.startPan(e, 'chord', null)
  }

  private startPan(e: PointerEvent, via: PanDrag['via'], onClick: (() => void) | null) {
    this.drag = { pointerId: e.pointerId, via, x: e.clientX, y: e.clientY, movedX: 0, movedY: 0, onClick }
    // An empty-paper press stays a click (double-click included) until it moves; only then does the view take the pointer.
    if (via !== 'empty') this.capture(e.pointerId, via)
  }

  private capture(pointerId: number, via: PanDrag['via']) {
    this.element.dataset.panning = via
    this.guard.panStarted()
    window.addEventListener('keydown', this.onPanKey, { capture: true })
    try {
      this.element.setPointerCapture(pointerId)
    } catch (err) {
      // A synthetic or already-released pointer can't be captured; the pan still follows moves over the view.
      console.warn('[FlatViewNavigator] pointer capture refused', err)
    }
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (panButtonOf(e) === 'chord' && (this.drag === null || this.drag.via === 'empty')) {
      this.startChord(e)
      return
    }
    const d = this.drag
    if (!d || d.pointerId !== e.pointerId) return
    if (d.via === 'empty') {
      const g = this.arbiter.move(e.pointerId, e.clientX, e.clientY)
      if (!g?.moved) return
      if (this.element.dataset.panning !== 'empty') this.capture(e.pointerId, 'empty')
    }
    // A pan's moves are the view's: nothing under the pointer hovers, drags or selects.
    e.stopPropagation()
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.movedX += dx
    d.movedY += dy
    if (dx !== 0 || dy !== 0) this.target.pan(dx, dy)
  }

  private readonly onPointerUp = (e: PointerEvent) => {
    const d = this.drag
    if (!d || d.pointerId !== e.pointerId) return
    const panned = this.panning
    const release = d.via === 'empty' ? this.arbiter.release(e.pointerId, e.clientX, e.clientY) : null
    this.endPan()
    if (panned) e.stopPropagation()
    if (release?.click) d.onClick?.()
  }

  private readonly onPointerCancel = (e: PointerEvent) => {
    if (this.handingOver) return
    // Taking the pointer from a grip that held it tells the grip it lost it; only the view's own loss ends the pan.
    if (e.type === 'lostpointercapture' && e.target !== this.element) return
    if (this.drag?.pointerId === e.pointerId) this.endPan()
  }

  /** Esc during a pan: put the view back where the pan started. The buttons' menu and click stay swallowed until they come up. */
  private readonly onPanKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.drag || !this.panning) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const { movedX, movedY } = this.drag
    this.endPan()
    if (movedX !== 0 || movedY !== 0) this.target.pan(-movedX, -movedY)
  }

  private endPan() {
    const d = this.drag
    this.drag = null
    this.arbiter.cancel()
    delete this.element.dataset.panning
    window.removeEventListener('keydown', this.onPanKey, { capture: true })
    if (d && this.element.hasPointerCapture?.(d.pointerId)) this.element.releasePointerCapture(d.pointerId)
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typingInField(e.target)) return
    // Space on a focused button presses it; only Space over the page or the view itself pans.
    if (e.key === ' ' && (e.target === document.body || (e.target instanceof Node && this.element.contains(e.target)))) {
      if (!this.spaceHeld) {
        this.spaceHeld = true
        this.element.dataset.spacePan = 'true'
      }
      e.preventDefault()
      return
    }
    // Ctrl/⌘ + stays the browser's page zoom; these are the plain keys.
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      this.zoomStep(1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      this.zoomStep(-1)
    } else if (e.key === '0' || e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      this.target.fit()
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') this.onBlur()
  }

  private readonly onBlur = () => {
    this.spaceHeld = false
    delete this.element.dataset.spacePan
  }
}
