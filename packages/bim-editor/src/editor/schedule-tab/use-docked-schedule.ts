'use client'

import { useEditorNavigation } from '@permitzip/bim-editor/host'
import type { DockDeclaration } from '../contributions/types'
import { SCHEDULE_TAB_PARAM, readScheduleTab, withScheduleTab } from './schedule-tab-url'

/**
 * One add-on's docked schedule (round 12): which of its records is open
 * beside the plan, read from and written to the page address, so Back closes
 * it, Forward reopens it and a reload keeps it. Generic over add-ons: the
 * declaration (`ADDON_UI.docks`) brings every word.
 */
export function useDockedSchedule(dock: DockDeclaration): { readonly openId: string | null; readonly open: (id: string) => void; readonly close: () => void } {
  const { router, pathname, searchParams } = useEditorNavigation()
  const current = readScheduleTab(searchParams.get(SCHEDULE_TAB_PARAM))
  const openId = current?.kind === dock.kind ? current.id : null
  const go = (id: string | null) => {
    // The address as it is now, not as it was at this render: a write since then (another param, a close just before) is kept.
    const search = typeof window === 'undefined' ? searchParams.toString() : window.location.search
    const href = `${pathname}${withScheduleTab(search, id ? { kind: dock.kind, id } : null)}`
    if (id) router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }
  return { openId, open: (id) => go(id), close: () => go(null) }
}
