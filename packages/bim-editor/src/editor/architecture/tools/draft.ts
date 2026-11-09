import { MIN_WALL_MM, type BimElement, type Command, type Vec2 } from '@permitzip/bim-kernel'
import type { ArchitectureTool } from './catalog'
import { chainHint, clickCorner, EMPTY_CHAIN, finishChain, flipLocation, typeDigit, typedCorner, undoCorner, type ChainState } from './wall-chain'
import { nextOpeningMark } from './door-flips'
import { aimOpening, openingHint, placeOpening, type OpeningAim, type OpeningKind } from './opening-place'

/**
 * One armed Architecture tool's drawing, as a value: the corners drawn so
 * far, the side a door opens to, the closed walls under the pointer, and
 * what each click or key does. Each step returns the next draft and, when
 * something is to be made, the command.
 */

/** The closed walls around a plan point: the outline a floor or room there would fill, or why there is none. */
export type FaceAt = { readonly ok: true; readonly outline: readonly Vec2[]; readonly area: string } | { readonly ok: false; readonly message: string }

export interface Draft {
  readonly tool: ArchitectureTool
  readonly chain: ChainState
  readonly side: 1 | -1
  readonly aim: OpeningAim | null
  /** Floor and Room: the closed walls under the pointer (null before the pointer moves, or once a floor sketch has started). */
  readonly face: FaceAt | null
}

export interface DraftContext {
  readonly elements: Readonly<Record<string, BimElement>>
  readonly levelId: string
  readonly newId: (prefix: string) => string
  /** The type the armed tool draws with (a starter type the model doesn't have yet is added by the drawing). */
  readonly typeId?: string
  readonly thicknessMm?: number
  /** A door's or window's size from its type; unset: the tool's defaults. */
  readonly openingSize?: { readonly widthMm: number; readonly heightMm: number }
  /** How tall the walls drawn are (up to the next level); unset: the kernel's default. */
  readonly wallHeightMm?: number
  /** The level the walls drawn run up to (their height then follows it); unset: walls keep `wallHeightMm`. */
  readonly wallTopLevelId?: string
  /** Walls near a plan point, nearest first (a door goes in the nearest one even when the hover highlight is elsewhere). */
  readonly wallsAt?: (p: Vec2) => readonly string[]
  /** The closed walls around a plan point. */
  readonly faceAt?: (p: Vec2) => FaceAt
  /** The command that makes a room bounded by the walls around a plan point. */
  readonly roomCommand?: (p: Vec2) => Command
}

export interface Step {
  readonly draft: Draft
  readonly command: Command | null
}

export function startDraft(tool: ArchitectureTool): Draft {
  return { tool, chain: EMPTY_CHAIN, side: 1, aim: null, face: null }
}

const keep = (draft: Draft): Step => ({ draft, command: null })

function lineCommand(tool: ArchitectureTool, ctx: DraftContext, a: Vec2, b: Vec2): Command {
  return { type: 'create_element', elementId: ctx.newId(tool.id), kind: tool.kind, levelId: ctx.levelId, placement: { kind: 'line', start: a, end: b }, ...(ctx.typeId ? { typeId: ctx.typeId } : {}) }
}

/** The four corners of the rectangle with opposite corners `a` and `b`, counter-clockwise. */
export function rectangleCorners(a: Vec2, b: Vec2): Vec2[] {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

function areaCommand(tool: ArchitectureTool, ctx: DraftContext, outline: readonly Vec2[]): Command {
  if (tool.kind === 'ceiling') return { type: 'create_ceiling', ceilings: [{ ceilingId: ctx.newId('ceiling'), levelId: ctx.levelId, outline: [...outline], heightMm: 2743 }] }
  return { type: 'create_element', elementId: ctx.newId(tool.id), kind: tool.kind, levelId: ctx.levelId, placement: { kind: 'area', outline: [...outline] }, ...(ctx.typeId ? { typeId: ctx.typeId } : {}) }
}

/** Hovered ids first (what the person points at), then the walls near the point. */
function hostCandidates(ctx: DraftContext, p: Vec2 | null, hovered: readonly string[]): readonly string[] {
  const near = p && ctx.wallsAt ? ctx.wallsAt(p) : []
  return near.length === 0 ? hovered : [...hovered, ...near.filter((id) => !hovered.includes(id))]
}

/** Floor and Room read the closed walls under the pointer; a floor sketch already started reads nothing. */
function faceFor(d: Draft, ctx: DraftContext, p: Vec2 | null): FaceAt | null {
  if (!p || !ctx.faceAt) return null
  if (d.tool.mode === 'room') return ctx.faceAt(p)
  if (d.tool.mode === 'area' && d.tool.kind !== 'ceiling' && d.chain.points.length === 0) return ctx.faceAt(p)
  return null
}

/** A click at `p` (the plan point under the pointer) over `hovered`. */
export function clickDraft(d: Draft, ctx: DraftContext, p: Vec2, hovered: readonly string[]): Step {
  switch (d.tool.mode) {
    case 'chain': {
      const first = d.chain.points[0]
      // Back on the first corner: the loop is closed, so its walls are made now.
      if (first && d.chain.points.length >= 3 && first.x === p.x && first.y === p.y) return { draft: { ...d, chain: EMPTY_CHAIN }, command: commitChain(d, ctx, d.chain, true) }
      return keep({ ...d, chain: clickCorner(d.chain, p, MIN_WALL_MM) })
    }
    case 'rectangle': {
      const first = d.chain.points[0]
      if (!first) return keep({ ...d, chain: clickCorner(d.chain, p) })
      // Narrower than a wall's minimum either way: not a rectangle yet, keep the first corner.
      if (Math.abs(p.x - first.x) < MIN_WALL_MM || Math.abs(p.y - first.y) < MIN_WALL_MM) return keep(d)
      return { draft: { ...d, chain: EMPTY_CHAIN }, command: commitChain(d, ctx, { ...d.chain, points: rectangleCorners(first, p) }, true) }
    }
    case 'line': {
      const start = d.chain.points[0]
      if (!start) return keep({ ...d, chain: clickCorner(d.chain, p) })
      if (start.x === p.x && start.y === p.y) return keep(d)
      return { draft: { ...d, chain: EMPTY_CHAIN }, command: lineCommand(d.tool, ctx, start, p) }
    }
    case 'area': {
      const face = faceFor(d, ctx, p)
      // Inside closed walls, the first click fills them; anywhere else it is the sketch's first corner.
      if (face?.ok) return { draft: { ...d, face }, command: areaCommand(d.tool, ctx, face.outline) }
      const first = d.chain.points[0]
      // Clicking the first corner again closes the sketch.
      if (first && d.chain.points.length >= 3 && first.x === p.x && first.y === p.y) return { draft: { ...d, chain: EMPTY_CHAIN, face: null }, command: areaCommand(d.tool, ctx, d.chain.points) }
      return keep({ ...d, chain: clickCorner(d.chain, p), face: null })
    }
    case 'room': {
      const face = faceFor(d, ctx, p)
      if (!face?.ok || !ctx.roomCommand) return keep({ ...d, face })
      return { draft: { ...d, face }, command: ctx.roomCommand(p) }
    }
    case 'point':
      return { draft: d, command: { type: 'create_element', elementId: ctx.newId(d.tool.id), kind: d.tool.kind, levelId: ctx.levelId, placement: { kind: 'point', position: p }, ...(ctx.typeId ? { typeId: ctx.typeId } : {}) } }
    case 'hosted': {
      const aim = aimOpening(ctx.elements, d.tool.kind as OpeningKind, hostCandidates(ctx, p, hovered), p, ctx.openingSize?.widthMm)
      if (!aim.ok) return keep({ ...d, aim })
      // Its mark comes with it (D1, W1, …), so the live plan tags it at once.
      return { draft: { ...d, aim }, command: placeOpening(aim, d.tool.kind as OpeningKind, d.side, ctx.newId(d.tool.id), ctx.typeId, nextOpeningMark(ctx.elements, d.tool.kind), ctx.openingSize?.heightMm) }
    }
    case 'dialog':
      return keep(d)
  }
}

/** The pointer moved: a door's ghost follows the wall it is near; a floor or room reads the walls round the pointer. */
export function hoverDraft(d: Draft, ctx: DraftContext, p: Vec2 | null, hovered: readonly string[]): Draft {
  if (d.tool.mode === 'hosted') return { ...d, aim: aimOpening(ctx.elements, d.tool.kind as OpeningKind, hostCandidates(ctx, p, hovered), p, ctx.openingSize?.widthMm) }
  if (d.tool.mode === 'room' || d.tool.mode === 'area') return { ...d, face: faceFor(d, ctx, p) }
  return d
}

function commitChain(d: Draft, ctx: DraftContext, chain: ChainState, closed = false): Command | null {
  return finishChain(chain, { kind: d.tool.kind, levelId: ctx.levelId, idPrefix: ctx.newId(d.tool.id), thicknessMm: ctx.thicknessMm ?? 150, closed, ...(ctx.wallHeightMm ? { heightMm: ctx.wallHeightMm } : {}), ...(ctx.wallTopLevelId ? { topLevelId: ctx.wallTopLevelId } : {}), ...(ctx.typeId ? { typeId: ctx.typeId } : {}) })
}

/** A key. `finish` true when the key ends the tool (Esc): what was drawn is kept. */
export function keyDraft(d: Draft, ctx: DraftContext, key: string, pointer: Vec2 | null): Step & { readonly finish: boolean } {
  const chainCommit = () => (d.tool.mode === 'chain' ? commitChain(d, ctx, d.chain) : d.tool.mode === 'area' && d.chain.points.length >= 3 ? areaCommand(d.tool, ctx, d.chain.points) : null)
  switch (key) {
    case 'Escape':
      return { draft: { ...d, chain: EMPTY_CHAIN }, command: chainCommit(), finish: true }
    case 'Enter': {
      const corner = typedCorner(d.chain, pointer)
      if (corner) return { draft: { ...d, chain: clickCorner(d.chain, corner) }, command: null, finish: false }
      return { draft: { ...d, chain: EMPTY_CHAIN }, command: chainCommit(), finish: false }
    }
    case 'Backspace':
      return { draft: { ...d, chain: undoCorner(d.chain) }, command: null, finish: false }
    case 'Tab':
      return { draft: d.tool.mode === 'chain' || d.tool.mode === 'rectangle' ? { ...d, chain: flipLocation(d.chain) } : d, command: null, finish: false }
    case ' ':
      return { draft: d.tool.mode === 'hosted' ? { ...d, side: d.side === 1 ? -1 : 1 } : d, command: null, finish: false }
    default:
      return { draft: { ...d, chain: typeDigit(d.chain, key) }, command: null, finish: false }
  }
}

/** The hint bar's words for the draft. */
export function draftHint(d: Draft): string {
  switch (d.tool.mode) {
    case 'chain':
      return chainHint(d.chain, d.tool.noun)
    case 'rectangle':
      return d.chain.points.length === 0 ? 'Click one corner of the rectangle' : `Click the opposite corner: four walls, joined at every corner · Tab: drawing on the ${d.chain.location === 'centre' ? 'centre line' : 'finish face'} · Esc to stop`
    case 'line':
      return d.chain.points.length === 0 ? `Click the ${d.tool.noun}'s start` : `Click its end · Esc to stop`
    case 'area':
      if (d.chain.points.length === 0 && d.face?.ok) return `Click to fill these walls with a ${d.tool.noun} (${d.face.area}), or click outside them to sketch its corners`
      if (d.chain.points.length === 0 && d.tool.kind !== 'ceiling') return `Click inside closed walls to fill them with a ${d.tool.noun}, or click the ${d.tool.noun}'s first corner`
      return d.chain.points.length < 3 ? `Click the ${d.tool.noun}'s corners` : `Click more corners, or Enter or the first corner to close the ${d.tool.noun} · Backspace takes a corner back · Esc keeps it and stops`
    case 'room':
      if (!d.face) return 'Click inside closed walls to make a room'
      return d.face.ok ? `Click to make a room here (${d.face.area}) · Esc to stop` : d.face.message
    case 'point':
      return `Click to place the ${d.tool.noun} · Esc to stop`
    case 'hosted':
      return openingHint(d.tool.kind as OpeningKind, d.aim)
    case 'dialog':
      return ''
  }
}
