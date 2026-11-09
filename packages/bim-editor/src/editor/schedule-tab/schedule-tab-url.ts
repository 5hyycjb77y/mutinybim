/**
 * Which schedule is docked beside the plan lives in the page address
 * (`?tab=<kind>:<id>`), so Back closes it, Forward reopens it, a reload keeps it
 * and a link opens it. Tab-only screen state: never browser storage, never
 * the database. Generic over schedule kinds (`<kind>:<record id>`).
 */
export const SCHEDULE_TAB_PARAM = 'tab'

export interface ScheduleTabRef {
  /** Which schedule, in the add-on's word for its records. */
  readonly kind: string
  /** The record it is for (its element id). */
  readonly id: string
}

const KIND = /^[a-z][a-z0-9_]{0,39}$/

/** The address value for a docked schedule. */
export function scheduleTabValue(tab: ScheduleTabRef): string {
  return `${tab.kind}:${tab.id}`
}

/** The docked schedule an address names, or null (none, or a value this screen doesn't read). */
export function readScheduleTab(value: string | null | undefined): ScheduleTabRef | null {
  if (!value) return null
  const at = value.indexOf(':')
  if (at <= 0) return null
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  return KIND.test(kind) && id.length > 0 && id.length <= 200 ? { kind, id } : null
}

/** `search` (without "?") with the docked schedule set, or removed when `tab` is null; other parameters kept in order. */
export function withScheduleTab(search: string, tab: ScheduleTabRef | null): string {
  const params = new URLSearchParams(search)
  if (tab) params.set(SCHEDULE_TAB_PARAM, scheduleTabValue(tab))
  else params.delete(SCHEDULE_TAB_PARAM)
  const next = params.toString()
  return next ? `?${next}` : ''
}
