import type { Command, Vec2 } from '@permitzip/bim-kernel'

/**
 * The chain-drawing tool for walls (and any line-placed kind): click corners,
 * Backspace takes the last one back, Tab flips the location line between the
 * wall's centre and its finish face, a typed length sets the next segment's
 * length along the pointer's direction, Esc or Enter finishes and keeps every
 * segment drawn. Pure: the workflow host feeds it pointer points and keys.
 */

export type LocationLine = 'centre' | 'finish'

export interface ChainState {
  readonly points: readonly Vec2[]
  readonly location: LocationLine
  /** Digits typed for the next segment's length, mm. */
  readonly typed: string
}

export const EMPTY_CHAIN: ChainState = { points: [], location: 'centre', typed: '' }

/**
 * A click on the last corner, or closer to it than `minGapMm`, is that corner again. Walls pass
 * `MIN_WALL_MM`: the second click of the double-click that finishes a chain lands a few mm off after
 * snapping, and a segment that short is one the model refuses (with every wall drawn with it).
 */
export function clickCorner(s: ChainState, p: Vec2, minGapMm = 0): ChainState {
  const last = s.points[s.points.length - 1]
  if (last && ((last.x === p.x && last.y === p.y) || Math.hypot(p.x - last.x, p.y - last.y) < minGapMm)) return s
  return { ...s, points: [...s.points, p], typed: '' }
}

export function undoCorner(s: ChainState): ChainState {
  if (s.typed.length > 0) return { ...s, typed: s.typed.slice(0, -1) }
  return { ...s, points: s.points.slice(0, -1) }
}

export function flipLocation(s: ChainState): ChainState {
  return { ...s, location: s.location === 'centre' ? 'finish' : 'centre' }
}

export function typeDigit(s: ChainState, key: string): ChainState {
  if (!/^[0-9.]$/.test(key) || s.points.length === 0) return s
  if (key === '.' && s.typed.includes('.')) return s
  return { ...s, typed: s.typed + key }
}

/** The corner a typed length puts down: from the last corner toward the pointer, that many mm. Null with no length or no direction. */
export function typedCorner(s: ChainState, pointer: Vec2 | null): Vec2 | null {
  const last = s.points[s.points.length - 1]
  const length = Number(s.typed)
  if (!last || !pointer || !(length > 0)) return null
  const dx = pointer.x - last.x
  const dy = pointer.y - last.y
  const d = Math.hypot(dx, dy)
  if (d === 0) return null
  return { x: Math.round(last.x + (dx / d) * length), y: Math.round(last.y + (dy / d) * length) }
}

/** Offset a polyline to its left by `by` mm, corners mitred, so a finish-face chain becomes centrelines. */
export function offsetChain(points: readonly Vec2[], by: number): Vec2[] {
  if (points.length < 2 || by === 0) return [...points]
  const normals = points.slice(1).map((b, i) => {
    const a = points[i] as Vec2
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }
  })
  return points.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)] as Vec2
    const n1 = normals[Math.min(normals.length - 1, i)] as Vec2
    const mx = n0.x + n1.x
    const my = n0.y + n1.y
    const ml = Math.hypot(mx, my)
    if (ml < 1e-9) return { x: p.x + n1.x * by, y: p.y + n1.y * by }
    const k = by / ((mx / ml) * n1.x + (my / ml) * n1.y)
    return { x: Math.round(p.x + (mx / ml) * k), y: Math.round(p.y + (my / ml) * k) }
  })
}

export interface ChainCommit {
  readonly kind: string
  readonly levelId: string
  readonly idPrefix: string
  readonly typeId?: string
  readonly thicknessMm: number
  /** Unset: the kernel's default height. Ignored when the top runs up to a level. */
  readonly heightMm?: number
  /** The level the walls' tops run up to: their height follows it. */
  readonly topLevelId?: string
  /** The last corner joins back to the first. */
  readonly closed?: boolean
}

/** The command that keeps the drawn segments, or null when there is less than one. */
export function finishChain(s: ChainState, c: ChainCommit): Command | null {
  if (s.points.length < 2) return null
  const points = s.location === 'finish' ? offsetChain(s.points, -c.thicknessMm / 2) : [...s.points]
  return {
    type: 'create_elements',
    idPrefix: c.idPrefix,
    kind: c.kind,
    levelId: c.levelId,
    points,
    size: { thicknessMm: c.thicknessMm, ...(c.heightMm && !c.topLevelId ? { heightMm: c.heightMm } : {}) },
    ...(c.topLevelId ? { topLevelId: c.topLevelId } : {}),
    ...(c.closed && points.length >= 3 ? { closed: true } : {}),
    ...(c.typeId ? { typeId: c.typeId } : {}),
  }
}

/** What the hint bar says for the chain's state. */
export function chainHint(s: ChainState, noun: string): string {
  if (s.points.length === 0) return `Click the ${noun}'s start`
  const line = s.location === 'centre' ? 'centre line' : 'finish face'
  if (s.typed) return `${s.typed} mm: Enter puts the corner down along the pointer`
  return `Click the next corner, or type a length; Esc or Enter to finish · Backspace takes a corner back · Tab: drawing on the ${line}`
}
