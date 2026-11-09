import { evaluateScheduleV2, fieldProviderRegistry, type BimElement, type ModelState, type ScheduleDefinitionV2 } from '@permitzip/bim-kernel'
import { ScheduleDefinitionError, V1_SCHEDULE_PROFILE_ID, buildRowSet } from '@permitzip/bim-kernel/schedules'
import { viewScheduleDefinition } from '../bim/schedules/view-definition'

/**
 * "Show Main beside" (a schedule on a branch): the rows whose elements differ
 * from Main, each with the cells that differ, printed exactly as the schedule
 * prints them. Main is the branch's model with the changed elements put back
 * as Main has them (the model server's `state_at`), so only those rows can
 * differ; nothing else is read from Main.
 */
export interface ScheduleDiffCell {
  readonly heading: string
  readonly branch: string
  readonly main: string
}

export interface ScheduleDiffRow {
  readonly key: string
  /** The row's first printed cell (its mark or name), else its element ids. */
  readonly label: string
  readonly elementIds: readonly string[]
  readonly state: 'changed' | 'new_on_branch' | 'removed_on_branch'
  readonly cells: readonly ScheduleDiffCell[]
}

export type ScheduleDiff = { readonly ok: true; readonly rows: readonly ScheduleDiffRow[] } | { readonly ok: false; readonly message: string }

interface PrintedRows {
  readonly headings: readonly string[]
  readonly byKey: ReadonlyMap<string, { readonly cells: readonly string[]; readonly ids: readonly string[] }>
}

/** As the sheet prints it: a native schedule naming trade provider fields builds over every field provider (kernel `buildPaperRows`). */
function rowsOf(model: ModelState, def: ScheduleDefinitionV2, viewId: string): ReturnType<typeof buildRowSet> {
  const ctx = { viewId, revision: model.revision }
  try {
    return buildRowSet(model, def, ctx)
  } catch (err) {
    const providerFields = def.display.profile !== V1_SCHEDULE_PROFILE_ID && err instanceof ScheduleDefinitionError && err.problems.some((p) => p.code === 'unknown_field')
    if (!providerFields) throw err
    return buildRowSet(model, def, { ...ctx, registry: fieldProviderRegistry() })
  }
}

function printed(model: ModelState, viewId: string): PrintedRows | string {
  const def = viewScheduleDefinition(model, viewId)
  if (!def) return 'This schedule prints on its sheet, so it has no rows to compare here.'
  try {
    const evaluated = evaluateScheduleV2(rowsOf(model, def, viewId), def)
    const byKey = new Map<string, { cells: readonly string[]; ids: readonly string[] }>()
    evaluated.rows.forEach((cells, i) => {
      const ids = evaluated.elementIds[i] ?? []
      if (ids.length > 0) byKey.set([...ids].sort().join(','), { cells, ids })
    })
    return { headings: evaluated.headings, byKey }
  } catch (err) {
    if (err instanceof ScheduleDefinitionError) return `This schedule can't be compared: ${err.problems.map((p) => p.message).join(' ')}`
    throw err
  }
}

/** The element ids this schedule lists on the branch (to ask Main for). */
export function scheduleElementIds(model: ModelState, viewId: string): readonly string[] | string {
  const rows = printed(model, viewId)
  if (typeof rows === 'string') return rows
  return [...new Set([...rows.byKey.values()].flatMap((r) => r.ids))]
}

/** Rows that differ between the branch (`model`) and Main (`model` with `main`'s records for the changed ids). */
export function scheduleRowsVsMain(model: ModelState, viewId: string, changed: ReadonlySet<string>, main: Readonly<Record<string, BimElement | null>>): ScheduleDiff {
  const branch = printed(model, viewId)
  if (typeof branch === 'string') return { ok: false, message: branch }
  const elements: Record<string, BimElement> = { ...model.elements }
  for (const [id, record] of Object.entries(main)) {
    if (!changed.has(id)) continue
    if (record) elements[id] = record
    else delete elements[id]
  }
  const onMain = printed({ ...model, elements }, viewId)
  if (typeof onMain === 'string') return { ok: false, message: onMain }
  const touches = (ids: readonly string[]) => ids.some((id) => changed.has(id))
  const rows: ScheduleDiffRow[] = []
  for (const [key, row] of branch.byKey) {
    if (!touches(row.ids)) continue
    const there = onMain.byKey.get(key)
    const cells = branch.headings.flatMap((heading, i) => {
      const b = row.cells[i] ?? ''
      const m = there ? (there.cells[i] ?? '') : ''
      return b === m ? [] : [{ heading: heading || `Column ${i + 1}`, branch: b, main: m }]
    })
    if (there && cells.length === 0) continue
    rows.push({ key, label: row.cells[0] || row.ids.join(', '), elementIds: row.ids, state: there ? 'changed' : 'new_on_branch', cells })
  }
  for (const [key, row] of onMain.byKey) {
    if (branch.byKey.has(key) || !touches(row.ids)) continue
    rows.push({ key, label: row.cells[0] || row.ids.join(', '), elementIds: row.ids, state: 'removed_on_branch', cells: onMain.headings.map((heading, i) => ({ heading: heading || `Column ${i + 1}`, branch: '', main: row.cells[i] ?? '' })).filter((c) => c.main !== '') })
  }
  return { ok: true, rows }
}
