import { PAPER_SIZES, documentIndex, type Command, type FormScheduleDefinition, type ModelState, type ScheduleDefinitionV2, type Sheet, type TitleBlockType, type Vec2, type ViewCommand } from '@permitzip/bim-kernel'
import type { ReactNode } from 'react'

/**
 * The one New schedule window's plan: make the schedule view and, when
 * asked, put it on a sheet (an existing one or a new one) at a free spot, as
 * one edit (one undo step). Generic: what a form kind needs (which element it
 * is for, its template, its rules) comes from the add-on that owns the kind,
 * through a `NewScheduleFormSlot`.
 */

/** What placing on a sheet needs: which sheet, its number for the undo label, and its paper. */
export interface SheetSpot {
  readonly id: string
  readonly number: string
  readonly titleBlock?: TitleBlockType
}

export function sheetSpotOf(sheet: Sheet): SheetSpot {
  return { id: sheet.id, number: sheet.number, ...(sheet.props?.titleBlock ? { titleBlock: sheet.props.titleBlock } : {}) }
}

const MARGIN_MM = 25
const GAP_MM = 15
/** Right-hand strip a title block takes on every MutinyBIM sheet; schedules stay left of it. */
const TITLE_STRIP_MM = 110

/**
 * Where a new viewport of `size` goes on `sheet`: right of what is already
 * placed, else under it, else the top-left margin. Paper mm, the frame's centre.
 */
export function freeSpotOnSheet(model: Pick<ModelState, 'elements' | 'connections'>, sheet: SheetSpot, size: Vec2): Vec2 {
  const paper = PAPER_SIZES[sheet.titleBlock ?? 'arch_d_mutinybim']
  const placed = documentIndex(model).viewportsBySheet.get(sheet.id) ?? []
  const at = (left: number, top: number): Vec2 => ({ x: Math.round(left + size.x / 2), y: Math.round(top + size.y / 2) })
  if (placed.length === 0) return at(MARGIN_MM, MARGIN_MM)
  const right = Math.max(...placed.map((vp) => vp.center.x + vp.size.x / 2))
  const top = Math.min(...placed.map((vp) => vp.center.y - vp.size.y / 2))
  if (right + GAP_MM + size.x <= paper.x - TITLE_STRIP_MM) return at(right + GAP_MM, Math.max(MARGIN_MM, top))
  const bottom = Math.max(...placed.map((vp) => vp.center.y + vp.size.y / 2))
  return at(MARGIN_MM, bottom + GAP_MM)
}

/** What a schedule view stores when it is made: a list (v2, the one model for new lists) or a form. */
export type NewScheduleProps = { readonly scheduleV2: ScheduleDefinitionV2 } | { readonly formSchedule: FormScheduleDefinition }

export interface ScheduleCreate {
  readonly viewId: string
  readonly name: string
  readonly props: NewScheduleProps
  /** Paper size of the table, for where it goes on the sheet. */
  readonly size: Vec2
  /** What the undo label names. */
  readonly subject: string
  readonly viewportId: string
  /** Place it on this sheet (already in the model, or made by `newSheet` first); null: not on a sheet yet. */
  readonly sheet: SheetSpot | null
  readonly newSheet?: { readonly sheetId: string; readonly number: string; readonly name: string }
}

export type NewSchedulePlan = { readonly ok: true; readonly command: Command; readonly label: string; readonly sheetId: string | null } | { readonly ok: false; readonly reason: string }

/** The one edit that makes the schedule view and, when asked, puts it on its sheet. */
export function planScheduleCreate(model: ModelState, input: ScheduleCreate): NewSchedulePlan {
  if (!input.name.trim()) return { ok: false, reason: 'Give the schedule a name.' }
  const steps: ViewCommand[] = []
  let sheet = input.sheet
  if (input.newSheet) {
    if (!input.newSheet.number.trim() || !input.newSheet.name.trim()) return { ok: false, reason: 'Give the new sheet a number and a name.' }
    steps.push({ type: 'create_sheet', sheetId: input.newSheet.sheetId, number: input.newSheet.number.trim(), name: input.newSheet.name.trim() })
    sheet = { id: input.newSheet.sheetId, number: input.newSheet.number.trim() }
  }
  steps.push({ type: 'create_view', viewId: input.viewId, name: input.name.trim(), viewType: 'schedule', props: input.props })
  if (sheet) steps.push({ type: 'place_viewport', viewportId: input.viewportId, sheetId: sheet.id, viewId: input.viewId, center: freeSpotOnSheet(model, sheet, input.size) })
  const label = `add ${input.subject}${sheet ? ` to ${sheet.number}` : ''}`
  const command: Command = steps.length === 1 && steps[0] ? steps[0] : { type: 'batch_documents', label, commands: steps }
  return { ok: true, command, label, sheetId: sheet?.id ?? null }
}

/** A form kind's choices, as its add-on reports them to the window. */
export type FormScheduleReady =
  | {
      readonly ok: true
      readonly form: FormScheduleDefinition
      /** The name the window suggests until one is typed. */
      readonly suggestedName: string
      /** What the undo label names. */
      readonly subject: string
    }
  | { readonly ok: false; readonly reason: string; readonly suggestedName: string }

export interface NewScheduleFormFieldsProps {
  readonly model: ModelState
  readonly kind: string
  readonly onReady: (ready: FormScheduleReady) => void
}

/**
 * What an add-on lends the New schedule window for the form kinds it owns
 * (published as the workflow's shared `newScheduleForms`): the fields drawn
 * inside the window, and the sheet a new one suggests. Absent: the window
 * says the add-on's tools are still loading.
 */
export interface NewScheduleFormSlot {
  readonly kinds: readonly string[]
  /** Draws the kind's fields (a render function, so the fields keep what was picked while the window redraws). */
  readonly renderFields: (props: NewScheduleFormFieldsProps) => ReactNode
  /** A new sheet's number and name for these schedules ("the next free schedule sheet"). */
  readonly newSheet: (model: ModelState) => { readonly number: string; readonly name: string }
}

/** The free number after the model's sheets, for a list schedule's new sheet ("G-601"). */
export function nextSheetNumber(model: Pick<ModelState, 'elements' | 'connections'>, prefix = 'G'): string {
  const taken = new Set(documentIndex(model).sheets.map((s) => s.number.toUpperCase()))
  for (let n = 601; n < 1000; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`
  return `${prefix}-1000`
}
