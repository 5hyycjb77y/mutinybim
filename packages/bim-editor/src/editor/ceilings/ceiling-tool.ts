import { LampCeiling } from 'lucide-react'
import { containsPoint, planeHeightAt, spaceAt, spaceLabel, spaceOutlines, type CeilingSlope, type Command, type ElementId, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import { feetInches } from '../placement'
import { parseFeet } from '../parse-feet'
import type { RibbonCommand } from '../ribbon/types'

/**
 * The ceiling plan's Ceiling tool, without React: what the person typed, read
 * into a height and a slope; the command a drawn outline or a clicked space
 * makes; and why the tool is off. Every write goes through the model's one
 * undoable edit path (`create_ceiling`, `make_ceiling_from_space_height`).
 */

const MM_PER_FT = 304.8

export const CEILING_TOOL_FORMS = [
  { id: 'flat', label: 'Flat' },
  { id: 'sloped', label: 'Sloped' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'soffit', label: 'Soffit' },
  { id: 'open_to_structure', label: 'Open to structure' },
] as const

export type CeilingToolForm = (typeof CEILING_TOOL_FORMS)[number]['id']

/** How the tool makes a ceiling: draw its outline, or click a space to fill it. */
export type CeilingToolHow = 'outline' | 'space'

/** What the person typed in the tool bar, as typed. */
export interface CeilingToolSettings {
  readonly how: CeilingToolHow
  readonly form: CeilingToolForm
  /** Height above the floor, feet as typed (`9`, `9'6"`). */
  readonly height: string
  /** Rise in inches per 12 of run, for a sloped or tilted ceiling. */
  readonly rise: string
  /** Direction it rises toward, degrees counter-clockwise from east (0 east, 90 north). */
  readonly towardDeg: string
}

export const DEFAULT_CEILING_SETTINGS: CeilingToolSettings = { how: 'outline', form: 'flat', height: '9', rise: '3', towardDeg: '90' }

/** Forms whose plane may slope (the kernel refuses a slope on the others). */
export function formSlopes(form: CeilingToolForm): boolean {
  return form === 'sloped' || form === 'cloud'
}

/** Forms that show their height at the cursor while drawing. */
export function showsHeightAtCursor(form: CeilingToolForm): boolean {
  return form === 'sloped' || form === 'cloud'
}

export type ParsedCeilingSettings =
  | { readonly ok: true; readonly heightMm: number; readonly slope: CeilingSlope | null }
  | { readonly ok: false; readonly message: string }

/** The typed values as a height and a slope, or what to fix in words. A cloud slopes only when a rise is typed; a sloped ceiling must have one. */
export function parseCeilingSettings(s: CeilingToolSettings): ParsedCeilingSettings {
  const ft = parseFeet(s.height)
  if (ft === null || ft <= 0) return { ok: false, message: "Type the ceiling height above the floor in feet, like 9 or 9'6\"." }
  const heightMm = Math.round(ft * MM_PER_FT)
  if (!formSlopes(s.form)) return { ok: true, heightMm, slope: null }
  const riseText = s.rise.trim()
  if (riseText === '' && s.form === 'cloud') return { ok: true, heightMm, slope: null }
  const rise = Number(riseText)
  if (!Number.isFinite(rise) || rise === 0) {
    return { ok: false, message: s.form === 'sloped' ? 'A sloped ceiling needs its rise in inches per foot of run, like 3 (3 in 12). Choose Flat for no slope.' : 'Type the cloud’s rise in inches per 12, like 2, or clear it for a level cloud.' }
  }
  const toward = Number(s.towardDeg.trim() === '' ? '0' : s.towardDeg)
  if (!Number.isFinite(toward)) return { ok: false, message: 'Type which way it rises as degrees: 0 east, 90 north, 180 west, 270 south.' }
  return { ok: true, heightMm, slope: { directionDeg: toward, pitch: rise / 12 } }
}

/** The height at the cursor while drawing, in words (`9'-6"`): the first corner is where the typed height is. */
export function heightAtCursorText(parsed: ParsedCeilingSettings, firstCorner: Vec2 | undefined, cursor: Vec2): string | null {
  if (!parsed.ok) return null
  return feetInches(planeHeightAt(parsed.heightMm, firstCorner ?? cursor, parsed.slope, cursor))
}

/** Why the Ceiling tool is off, in words; null when it can be used. */
export function ceilingToolReason(o: { readonly ceilingPlanOpen: boolean; readonly levelId: ElementId | null; readonly editBlocked: string | null }): string | null {
  if (!o.ceilingPlanOpen) return 'Open a ceiling plan to draw ceilings: Views › New › Ceiling plan, or open one from the Views and sheets panel.'
  if (!o.levelId) return 'This ceiling plan isn’t on a level yet. Choose its level in the view’s properties first.'
  return o.editBlocked
}

/** A drawn outline as one new ceiling at the typed height and slope (the height is at the first corner). */
export function outlineCeilingCommand(o: { readonly ceilingId: string; readonly levelId: ElementId; readonly outline: readonly Vec2[]; readonly form: CeilingToolForm; readonly parsed: Extract<ParsedCeilingSettings, { ok: true }>; readonly spaceId?: ElementId }): Command {
  const outline = o.outline.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
  const first = outline[0]
  return {
    type: 'create_ceiling',
    ceilings: [
      {
        ceilingId: o.ceilingId,
        levelId: o.levelId,
        ...(o.spaceId ? { spaceId: o.spaceId } : {}),
        outline,
        form: o.form,
        heightMm: o.parsed.heightMm,
        ...(o.parsed.slope && first ? { slope: o.parsed.slope, reference: first } : {}),
      },
    ],
  }
}

export type FillSpace = { readonly ok: true; readonly command: Command; readonly label: string; readonly spaceName: string } | { readonly ok: false; readonly message: string }

/** Clicking a space fills the part of it under the click (a space of several rooms fills one room) with a ceiling at the typed height. */
export function fillSpaceCommand(o: { readonly model: ModelState; readonly levelId: ElementId; readonly point: Vec2; readonly ceilingId: string; readonly form: CeilingToolForm; readonly parsed: Extract<ParsedCeilingSettings, { ok: true }> }): FillSpace {
  const space = spaceAt(o.model.elements, o.levelId, o.point)
  if (!space) return { ok: false, message: 'There’s no space here. Click inside a space, or choose Draw outline.' }
  const outline = spaceOutlines(o.model.elements, space).find((poly) => poly.length >= 3 && containsPoint(poly, o.point))
  if (!outline) return { ok: false, message: `${spaceLabel(space)} has no outline here to fill. Redraw it in the Spaces panel, or choose Draw outline.` }
  return { ok: true, command: outlineCeilingCommand({ ceilingId: o.ceilingId, levelId: o.levelId, outline, form: o.form, parsed: o.parsed, spaceId: space.id }), label: 'Fill space with a ceiling', spaceName: spaceLabel(space) }
}

/** The Model tab's Build › Ceiling command: on while the tool is, and greyed with the reason when no ceiling plan is open. */
export function ceilingRibbonCommand(o: { readonly active: boolean; readonly disabledReason: string | null; readonly toggle: () => void }): RibbonCommand {
  return {
    id: 'ceiling',
    label: 'Ceiling',
    icon: LampCeiling,
    description: 'Draw a ceiling on this ceiling plan (flat, sloped, a cloud, a soffit or open to structure), or click a space to fill it. Esc stops',
    keywords: ['ceiling', 'rcp', 'reflected ceiling', 'cloud', 'soffit', 'sloped ceiling', 'open to structure', 'ceiling height'],
    pressed: o.active,
    disabledReason: o.disabledReason,
    run: o.toggle,
    testId: 'ribbon-ceiling',
  }
}