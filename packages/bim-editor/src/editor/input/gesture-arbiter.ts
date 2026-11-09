/**
 * One owner per pointer gesture in a model viewport, decided once at
 * pointerdown and held until the release (or Esc / pointercancel):
 *
 *   tool (box, route stroke, move)  >  grab (drag a run, the selection, slide a takeoff)
 *     >  click (select / tool click)  >  camera (orbit / pan)
 *
 * The arbiter is the only thing that takes the camera off the pointer. A tool
 * or grab that wins the press claims the pointer from the camera; a click
 * leaves it with the camera, so a press that moves becomes an orbit and one
 * that doesn't is a click. The wheel always zooms (toward the pointer) and
 * never changes who owns the gesture; the owner refreshes its preview when the
 * camera moves. Orbit-point clicks, double-clicks and camera listeners never
 * decide ownership.
 *
 * The input design notes (internal) cover the rest.
 */

/** The active tool, in the words the arbiter needs. Unknown tools behave like a tool click. */
export type ArbiterTool = 'select' | 'box' | 'route' | 'move' | 'place' | 'measure' | 'split' | (string & {})

export type GestureKind =
  /** A box drawn over the view (Box tool, or Shift in Select). */
  | 'box'
  /** A route stroke: from a connector / run / the route's last point to where it is released. */
  | 'route-stroke'
  /** The Move tool dragging a part. */
  | 'move'
  /** Dragging a straight piece, an end or an elbow of a routed run. */
  | 'run-drag'
  /** A press on the current selection (a selected part, or any piece of a box selection): the whole selection moves. */
  | 'move-selection'
  /** Sliding a branch takeoff along its trunk. */
  | 'slide'
  /** Nothing grabbed: a click if it doesn't move (select, or the tool's click), an orbit if it does. */
  | 'click'

export type GestureOwner = 'tool' | 'grab' | 'click'

export const OWNER_OF: Readonly<Record<GestureKind, GestureOwner>> = {
  box: 'tool',
  'route-stroke': 'tool',
  move: 'tool',
  'run-drag': 'grab',
  'move-selection': 'grab',
  slide: 'grab',
  click: 'click',
}

/** A press that moves less than this before release is a click, px. */
export const CLICK_SLOP_PX = 4

export interface PressContext {
  readonly tool: ArbiterTool
  readonly shiftKey: boolean
  /** The route tool is waiting for an offset click (no strokes then). */
  readonly offsetArmed?: boolean
  /**
   * What a Select drag that grabs nothing does. `box` (U5, box select by
   * default, as on drawings): a window or crossing box, and Shift+drag
   * moves the camera instead. `orbit` (absent): the camera moves, Shift+drag boxes.
   */
  readonly emptyDrag?: 'orbit' | 'box'
}

/**
 * Select's empty-space drag for the open view. Looking down at a live plan it
 * boxes, as on drawings (U5). In 3D it orbits, the way people turn a model;
 * Shift+drag or the Box select tool boxes there. A finger always moves the
 * camera (tablets have no Shift).
 */
export function emptyDragFor(pointerType: string, viewMode: '3d' | 'plan' | null): 'orbit' | 'box' {
  if (pointerType === 'touch') return 'orbit'
  return viewMode === 'plan' ? 'box' : 'orbit'
}

/**
 * Which kinds a press may become, in priority order. A kind is only tried if
 * the active tool allows it; `click` ends the list (Select's empty-space
 * box ends it instead: its attempt always takes the press).
 */
export function pressOrder(ctx: PressContext): readonly GestureKind[] {
  if (ctx.tool === 'select' && ctx.emptyDrag === 'box') return ctx.shiftKey ? ['click'] : ['run-drag', 'move-selection', 'slide', 'box']
  if (ctx.tool === 'box' || (ctx.tool === 'select' && ctx.shiftKey)) return ['box']
  if (ctx.tool === 'route') return ctx.offsetArmed ? ['click'] : ['route-stroke', 'click']
  if (ctx.tool === 'move') return ['move', 'click']
  if (ctx.tool === 'select') return ['run-drag', 'move-selection', 'slide', 'click']
  return ['click']
}

/** Hit tests for a press, by kind. Each returns true when it took the press (it may start a preview). Missing kinds decline. */
export type PressAttempts = Partial<Record<Exclude<GestureKind, 'click'>, () => boolean>>

/** What the camera side of a viewport offers the arbiter. */
export interface PointerCamera {
  /** Take the pointer from the camera (buttons and touches stop orbiting; the wheel keeps zooming). Returns the release. */
  claimPointer(owner: string): () => void
}

export interface Gesture {
  readonly kind: GestureKind
  readonly owner: GestureOwner
  readonly pointerId: number
  readonly start: { readonly x: number; readonly y: number }
  /** Moved past the click slop since the press. */
  moved: boolean
}

export interface Release {
  readonly kind: GestureKind
  readonly owner: GestureOwner
  /** Released within the click slop of the press. */
  readonly click: boolean
}

export class GestureArbiter {
  private current: Gesture | null = null
  private releaseCamera: (() => void) | null = null

  constructor(private camera: PointerCamera | null = null) {}

  /** The viewport's camera (null while it loads). Re-attaching mid-gesture re-claims on the new one. */
  attach(camera: PointerCamera | null) {
    if (camera === this.camera) return
    this.releaseCamera?.()
    this.releaseCamera = null
    this.camera = camera
    if (this.current && this.current.owner !== 'click' && camera) this.releaseCamera = camera.claimPointer(this.current.kind)
  }

  /**
   * Pointerdown with the primary button: decide who owns it. Tries the tool's
   * kinds in order; the first that takes the press wins. A second pointer
   * during an edit is ignored (returns null); any other leftover gesture is
   * stale (its release happened off the canvas) and is dropped first.
   */
  press(pointerId: number, x: number, y: number, ctx: PressContext, attempts: PressAttempts): Gesture | null {
    if (this.current && this.current.pointerId !== pointerId && this.editing()) return null
    this.end()
    let kind: GestureKind = 'click'
    for (const candidate of pressOrder(ctx)) {
      if (candidate === 'click') break
      if (attempts[candidate]?.()) {
        kind = candidate
        break
      }
    }
    const gesture: Gesture = { kind, owner: OWNER_OF[kind], pointerId, start: { x, y }, moved: false }
    this.current = gesture
    if (gesture.owner !== 'click' && this.camera) this.releaseCamera = this.camera.claimPointer(kind)
    return gesture
  }

  /** Pointermove: records whether the press has turned into a drag. Returns the gesture (null when none). */
  move(pointerId: number, x: number, y: number): Gesture | null {
    const g = this.current
    if (!g || g.pointerId !== pointerId) return null
    if (!g.moved && Math.hypot(x - g.start.x, y - g.start.y) >= CLICK_SLOP_PX) g.moved = true
    return g
  }

  /** Pointerup: ends the gesture and gives the pointer back to the camera. Null when nothing (or another pointer) was pressed. */
  release(pointerId: number, x: number, y: number): Release | null {
    const g = this.current
    if (!g || g.pointerId !== pointerId) return null
    this.end()
    return { kind: g.kind, owner: g.owner, click: !g.moved && Math.hypot(x - g.start.x, y - g.start.y) < CLICK_SLOP_PX }
  }

  /** Esc, pointercancel, lost capture, tool switch or unmount: drop the gesture. Returns what was cancelled. */
  cancel(): GestureKind | null {
    const g = this.current
    this.end()
    return g?.kind ?? null
  }

  /** The gesture in progress, if any. */
  active(): Gesture | null {
    return this.current
  }

  /** A tool or grab owns the pointer (its preview follows the pointer and the camera). */
  editing(): boolean {
    return this.current !== null && this.current.owner !== 'click'
  }

  private end() {
    this.current = null
    const release = this.releaseCamera
    this.releaseCamera = null
    release?.()
  }
}
