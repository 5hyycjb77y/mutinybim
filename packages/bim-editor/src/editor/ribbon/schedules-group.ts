import { FolderOpen, Library, Sigma, TableProperties } from 'lucide-react'
import { SCHEDULE_CATEGORIES, type ScheduleCategory } from '@permitzip/bim-kernel'
import { addonTabsWith } from '../contributions/registry'
import { isTradeTab, withTradeSectionCommands } from './trade-tab'
import type { RibbonCommand, RibbonGroup, RibbonTab } from './types'

/**
 * The model schedules on every discipline tab (SCHEDULES-PLAN §7
 * discoverability): New schedule… starts on what that trade lists most,
 * Open a schedule lists the schedules in the model.
 */

export interface RibbonSchedules {
  /** The model's schedule views, by name. */
  readonly views: readonly { readonly id: string; readonly name: string }[]
  readonly newSchedule: (category: ScheduleCategory) => void
  readonly open: (viewId: string) => void
  /** Manage › Library: the firm's shared calculations and schedule templates. */
  readonly openLibrary: () => void
  readonly editBlocked: string | null
  /**
   * One-click load schedules (Space loads, Panel loads, Loads): opens the
   * model's one by that name, making it the first time with the Loads columns
   * already chosen. `blocked` says why one can't be made yet.
   */
  readonly loadSchedules?: {
    readonly lists: readonly { readonly id: string; readonly label: string; readonly description: string; readonly blocked: string | null }[]
    readonly open: (id: string) => void
  }
}

/** What New schedule… starts on from Model, Views and any tab that names nothing else. */
const DEFAULT_START: ScheduleCategory = 'mechanical_equipment'

function isScheduleCategory(value: string): value is ScheduleCategory {
  return (SCHEDULE_CATEGORIES as readonly string[]).includes(value)
}

/** What New schedule… starts on, per tab that carries the group: Model and Views, then every add-on tab whose UI data names a `scheduleStart`. */
function tabStarts(): ReadonlyMap<string, ScheduleCategory> {
  const starts = new Map<string, ScheduleCategory>([
    ['model', DEFAULT_START],
    ['views', DEFAULT_START],
  ])
  for (const t of addonTabsWith('scheduleStart')) {
    if (isScheduleCategory(t.value)) starts.set(t.id, t.value)
    else console.error('[ribbon] an add-on tab names a schedule category the kernel does not have; it starts on the default', { tabId: t.id, category: t.value })
  }
  return starts
}

function scheduleCommands(tabId: string, start: ScheduleCategory, s: RibbonSchedules): RibbonCommand[] {
  const open: RibbonCommand = {
    id: `${tabId}-open-schedule`,
    label: 'Open a schedule',
    icon: FolderOpen,
    description: 'Open one of the model’s schedules as a spreadsheet you can edit',
    keywords: ['schedule', 'spreadsheet', 'grid', 'table'],
    disabledReason: s.views.length === 0 ? 'No schedules in this model yet. Make one with New schedule…' : null,
    children: s.views.map((v) => ({
      id: `${tabId}-open-schedule-${v.id}`,
      label: v.name,
      icon: TableProperties,
      description: `Open ${v.name} as a spreadsheet`,
      run: () => s.open(v.id),
      testId: `ribbon-open-schedule-${v.id}`,
    })),
    testId: `ribbon-${tabId}-open-schedule`,
  }
  const loads: RibbonCommand[] = s.loadSchedules
    ? [
        {
          id: `${tabId}-load-schedules`,
          label: 'Load schedules',
          icon: Sigma,
          description: 'A schedule with the Loads columns already chosen: estimate, devices so far and counted, per space or per panel',
          keywords: ['loads', 'load study', 'space loads', 'panel loads', 'estimate', 'devices so far', 'counted', 'va', 'wsfu', 'dfu', 'cfm'],
          children: s.loadSchedules.lists.map((l) => ({
            id: `${tabId}-load-schedule-${l.id}`,
            label: l.label,
            icon: TableProperties,
            description: l.description,
            disabledReason: l.blocked,
            run: () => s.loadSchedules?.open(l.id),
            testId: `ribbon-${tabId}-load-schedule-${l.id}`,
          })),
          testId: `ribbon-${tabId}-load-schedules`,
        },
      ]
    : []
  return [
    {
      id: `${tabId}-new-schedule`,
      label: 'New schedule…',
      icon: TableProperties,
      description: 'List items from the model in a spreadsheet: choose what to list, then the columns',
      keywords: ['schedule', 'list', 'spreadsheet', 'grid', 'table', 'takeoff'],
      disabledReason: s.editBlocked,
      run: () => s.newSchedule(start),
      testId: `ribbon-${tabId}-new-schedule`,
    },
    open,
    ...loads,
  ]
}

export function libraryCommand(s: RibbonSchedules): RibbonCommand {
  return {
    id: 'manage-library',
    label: 'Library',
    icon: Library,
    description: 'The firm’s shared calculations, fields and schedule templates',
    keywords: ['library', 'formula', 'calculation', 'template', 'shared parameters'],
    run: s.openLibrary,
    testId: 'ribbon-manage-library',
  }
}

/** Add the Schedules commands to each discipline tab (into its own Schedules group when it has one), and Library to Manage. */
export function withScheduleGroups(tabs: readonly RibbonTab[], s: RibbonSchedules | null | undefined): RibbonTab[] {
  if (!s) return [...tabs]
  const starts = tabStarts()
  return tabs.map((tab) => {
    if (tab.id === 'manage') return { ...tab, groups: [...tab.groups, { id: 'manage-library', label: 'Library', commands: [libraryCommand(s)] }] }
    const start = starts.get(tab.id)
    if (!start) return tab
    const commands = scheduleCommands(tab.id, start, s)
    // A trade's tab keeps them in its Documents section, first.
    if (isTradeTab(tab)) return withTradeSectionCommands(tab, 'documents', commands, true)
    const existing = tab.groups.findIndex((g) => g.label === 'Schedules')
    if (existing >= 0) {
      const groups = tab.groups.map((g, i): RibbonGroup => (i === existing ? { ...g, commands: [...commands, ...g.commands] } : g))
      return { ...tab, groups }
    }
    return { ...tab, groups: [...tab.groups, { id: `${tab.id}-schedules`, label: 'Schedules', commands }] }
  })
}
