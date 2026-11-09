/**
 * Turning the surface under the pointer (`viewer.pickSurface`) into where a
 * tool puts things. No React, no three.js. The input design
 * notes (internal) cover this under "Surface picks".
 *
 * Place part: the typed height is above the floor or roof pointed at, so a
 * typed 10 ft over the floor still means 10 ft above the level and 0 on a
 * roof sits on the roof. Route: the typed centre height, raised only when it
 * would sink the run into what is pointed at.
 */
import type { PartCategory, PartHost } from '@permitzip/bim-kernel'
import type { SurfaceHit } from '@permitzip/bim-viewer-3d'
import { feetInches } from './placement'

export interface LevelRef {
  readonly id: string
  readonly name: string
  readonly elevationMm: number
}

/** A floor slab's top is drawn a hair off its level; this much below still counts as on it. */
const ON_LEVEL_MM = 25
/** |normal.z| above this is a floor/roof (up) or a ceiling/soffit (down); below it, a wall. */
const HORIZONTAL = 0.5

export type SurfaceFacing = 'up' | 'down' | 'side'

export function surfaceFacing(hit: SurfaceHit): SurfaceFacing {
  const z = hit.normal?.z
  // A linked model that didn't report a normal: treat it as something to stand on.
  if (z === undefined) return 'up'
  return z > HORIZONTAL ? 'up' : z < -HORIZONTAL ? 'down' : 'side'
}

/** The level a point at elevation `zMm` belongs to: the highest at or below it, else the lowest (the point is below every level). */
export function levelBelow(levels: readonly LevelRef[], zMm: number): LevelRef | null {
  let best: LevelRef | null = null
  let lowest: LevelRef | null = null
  for (const l of levels) {
    if (!lowest || l.elevationMm < lowest.elevationMm) lowest = l
    if (l.elevationMm <= zMm + ON_LEVEL_MM && (!best || l.elevationMm > best.elevationMm)) best = l
  }
  return best ?? lowest
}

export interface SurfacePlacement {
  readonly levelId: string
  readonly position: { readonly x: number; readonly y: number }
  /** Part base above its level. */
  readonly offsetMm: number
  /** "On the surface 24'-2" above Level 1" — for the hint. */
  readonly where: string
}

/**
 * Where Place part puts the part for this hit. On a floor or roof the part
 * sits on it (plus the typed height); against a wall or under a soffit it
 * goes under the pointer at the typed height above the level it is over.
 */
export function placementOnSurface(hit: SurfaceHit, levels: readonly LevelRef[], heightMm: number, fallbackLevelId: string | null): SurfacePlacement | null {
  const facing = surfaceFacing(hit)
  const level = facing === 'up' ? levelBelow(levels, hit.point.z) : (levels.find((l) => l.id === fallbackLevelId) ?? levelBelow(levels, hit.point.z))
  if (!level) return null
  const position = { x: hit.point.x, y: hit.point.y }
  if (facing !== 'up') {
    return { levelId: level.id, position, offsetMm: heightMm, where: `Under the pointer, ${feetInches(heightMm)} above ${level.name}` }
  }
  const surfaceAbove = hit.point.z - level.elevationMm
  const offsetMm = surfaceAbove + heightMm
  const on = Math.abs(surfaceAbove) <= ON_LEVEL_MM ? `On ${level.name}` : `On the surface ${feetInches(surfaceAbove)} above ${level.name}`
  return { levelId: level.id, position, offsetMm, where: heightMm === 0 ? on : `${on}, raised ${feetInches(heightMm)}` }
}

/** A typed Place height up to this, on a floor or roof, is a curb or rail; higher, the part is held up by something else. */
export const CURB_PLACE_MAX_MM = 914.4

/** Kinds of part that stand on a floor or roof (so pointing at one says what they stand on). */
const STANDING: ReadonlySet<PartCategory> = new Set(['mechanical_equipment', 'electrical_equipment', 'plumbing_fixture', 'generic'])

/**
 * What Place part records as the part's host for this hit: the slab (ours)
 * or the linked surface it was set down on, with the typed height as its
 * curb. Null for things that hang or mount (air terminals, devices), for a
 * wall or soffit, and for a height too tall to be a curb.
 */
export function hostForPlacement(
  hit: SurfaceHit,
  heightMm: number,
  category: PartCategory,
  isOurSlab: (elementId: string) => boolean,
  linkedLabel: (referenceId: string) => string,
): { readonly host: PartHost; readonly curbMm: number } | null {
  if (!STANDING.has(category) || surfaceFacing(hit) !== 'up' || heightMm < 0 || heightMm > CURB_PLACE_MAX_MM) return null
  const curbMm = Math.round(heightMm * 10) / 10
  if (hit.linked) return { host: { kind: 'linked', referenceId: hit.linked.referenceId, localId: hit.linked.localId, name: `${linkedLabel(hit.linked.referenceId)} surface`, topMm: Math.round(hit.point.z * 10) / 10 }, curbMm }
  if (hit.elementId && isOurSlab(hit.elementId)) return { host: { kind: 'slab', elementId: hit.elementId }, curbMm }
  return null
}

export interface RouteStart {
  readonly point: { readonly x: number; readonly y: number }
  /** Run centreline above the route's level. */
  readonly elevationMm: number
  readonly where: string
}

/**
 * Where a route's first free point goes for this hit: tucked under a ceiling
 * or soffit (top of the duct at the underside), on a floor or roof at the
 * typed height above it (never sunk into it), or out from a wall by half the
 * run's width at the height pointed at.
 * Over a floor or roof the typed centre height wins unless it would sink the
 * run into the surface pointed at; then the run rests on it.
 */
export function routeStartOnSurface(
  hit: SurfaceHit,
  levelElevationMm: number,
  typedCenterMm: number,
  half: { readonly depthMm: number; readonly widthMm: number },
): RouteStart {
  const facing = surfaceFacing(hit)
  const p = hit.point
  let center: number
  let point = { x: p.x, y: p.y }
  let where: string
  if (facing === 'down') {
    center = p.z - half.depthMm
    where = 'Under the surface'
  } else if (facing === 'up') {
    const typed = levelElevationMm + typedCenterMm
    const resting = p.z + half.depthMm
    center = Math.max(typed, resting)
    where = resting > typed ? 'Resting on the surface' : 'At the typed height over the surface'
  } else {
    const n = hit.normal
    const len = n ? Math.hypot(n.x, n.y) : 0
    if (n && len > 0) point = { x: p.x + (n.x / len) * half.widthMm, y: p.y + (n.y / len) * half.widthMm }
    center = p.z
    where = 'Along the wall'
  }
  const elevationMm = center - levelElevationMm
  return { point, elevationMm, where: `${where}, centre ${feetInches(elevationMm)} above the level` }
}
