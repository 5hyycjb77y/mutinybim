import { elementValues, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'

/**
 * Picking a building edge for "Align axes to an edge": a click on a wall or
 * slab edge gives its direction in one go; otherwise two clicked points along
 * the edge do. Kept behind an interface so the surface pick from the viewer
 * (linked-model faces and their edges, an internal design note) plugs in as
 * `surfaceEdges` without changing the pick overlay.
 */

/** A straight building edge in plan (model mm). */
export interface EdgeHit {
  readonly from: Vec2
  readonly to: Vec2
  /** What it is, in words: "a wall", "a duct", "the architect's model". */
  readonly label: string
}

/** A plan point under the pointer (model mm). */
export interface PointHit {
  readonly at: Vec2
  /** What it landed on, in words; null when only on the work plane. */
  readonly label: string | null
}

export interface EdgePicker {
  /** The straight edge under the pointer, or null. */
  edgeAt(clientX: number, clientY: number): Promise<EdgeHit | null>
  /** The plan point under the pointer on the work plane. Null when the pointer is off the plane (above the horizon). */
  pointAt(clientX: number, clientY: number): Promise<PointHit | null>
}

/** How close (screen px) the pointer must be to an edge to take it. */
export const EDGE_PICK_PX = 8

/** An edge as drawn on screen, for the nearest-edge test. */
interface ScreenEdge {
  readonly edge: EdgeHit
  readonly a: { readonly x: number; readonly y: number }
  readonly b: { readonly x: number; readonly y: number }
}

/** Straight plan edges of authored elements: walls, grid lines, ducts and straight runs. */
export function modelEdges(model: ModelState): EdgeHit[] {
  const out: EdgeHit[] = []
  for (const el of elementValues(model.elements)) {
    switch (el.kind) {
      case 'wall':
        out.push({ from: el.start, to: el.end, label: 'a wall' })
        break
      case 'grid':
        out.push({ from: el.start, to: el.end, label: 'a grid line' })
        break
      case 'duct_segment':
        if (Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) > 1) out.push({ from: { x: el.start.x, y: el.start.y }, to: { x: el.end.x, y: el.end.y }, label: 'a duct' })
        break
      case 'run_segment':
        if (Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) > 1) out.push({ from: { x: el.start.x, y: el.start.y }, to: { x: el.end.x, y: el.end.y }, label: 'a run' })
        break
      default:
        break
    }
  }
  return out
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** The edge nearest the pointer on screen, within `px`. `project` puts a plan point on screen (canvas px), or null when it is behind the camera. */
export function nearestEdge(edges: readonly EdgeHit[], project: (p: Vec2) => { x: number; y: number } | null, cursor: { x: number; y: number }, px = EDGE_PICK_PX): EdgeHit | null {
  let best: ScreenEdge | null = null
  let bestD = px
  for (const edge of edges) {
    const a = project(edge.from)
    const b = project(edge.to)
    if (!a || !b) continue
    const d = distanceToSegment(cursor, a, b)
    if (d <= bestD) {
      bestD = d
      best = { edge, a, b }
    }
  }
  return best?.edge ?? null
}

/** How far (mm) above or below the work plane a surface hit may be and still name what the point landed on. */
export const ON_PLANE_MM = 50

/**
 * The picked point: always where the pointer meets the work plane, so the dot
 * sits under the pointer and two points measure a direction on the plane in
 * a tilted 3D view as in a plan. A surface the pick ray hits first (a wall
 * top, a far face, a sloped roof) is somewhere else in plan when the camera
 * is tilted, so it only names the point when it lies on the plane itself.
 */
export function pointOnWorkPlane(plane: Vec2, surface: { readonly point: { readonly z: number }; readonly linked: unknown } | null, elevationMm: number): PointHit {
  const onPlane = surface !== null && Math.abs(surface.point.z - elevationMm) <= ON_PLANE_MM
  return { at: plane, label: onPlane ? (surface.linked ? "the architect's model" : 'the model') : null }
}

export interface ViewerEdgePickerArgs {
  readonly viewer: Pick<ModelViewer3D, 'pickSurfaceAsync' | 'planPointAt' | 'canvasPointOf' | 'renderer'>
  readonly model: ModelState
  /** The elevation the work plane sits at (the active level, else the project base point). */
  readonly elevationMm: number
  /** Edges of the surface under the pointer (linked-model faces), when the viewer offers it. */
  readonly surfaceEdges?: (clientX: number, clientY: number) => Promise<EdgeHit | null>
}

/** The live picker: authored edges first, then the surface pick's edges; points on the work plane under the pointer. */
export function viewerEdgePicker({ viewer, model, elevationMm, surfaceEdges }: ViewerEdgePickerArgs): EdgePicker {
  const edges = modelEdges(model)
  const canvasXY = (clientX: number, clientY: number) => {
    const rect = viewer.renderer.domElement.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }
  return {
    async edgeAt(clientX, clientY) {
      const own = nearestEdge(edges, (p) => viewer.canvasPointOf(p.x, p.y, elevationMm), canvasXY(clientX, clientY))
      if (own) return own
      return surfaceEdges ? surfaceEdges(clientX, clientY) : null
    },
    async pointAt(clientX, clientY) {
      const plane = viewer.planPointAt(clientX, clientY, elevationMm)
      if (!plane) return null
      return pointOnWorkPlane(plane, await viewer.pickSurfaceAsync(clientX, clientY), elevationMm)
    },
  }
}
