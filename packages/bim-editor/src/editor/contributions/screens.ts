import type { ComponentType } from 'react'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'
import type { RibbonGroup, RibbonTab } from '../ribbon/types'
import { INSPECTOR_SECTION, PART_SECTION, RAIL_SECTION, ROUTE_SECTION, RUN_SECTION, SPACE_LOADS_SECTION, WORKFLOW_HOST, componentContribution } from './slots'
import type { AddonContributions, AddonInput, AddonUiManifest, ComponentSlot, RibbonCommandModule, RibbonCommandTarget, RibbonTabModule } from './types'

/**
 * An add-on's loader map: for each id in its UI data, the screen code that
 * fills it, behind `import()`. Lives in the add-on's own screen folder; the
 * host pairs it with the add-on's `ADDON_UI` here without knowing the add-on.
 */
export interface AddonScreens {
  readonly tabs?: Readonly<Record<string, () => Promise<RibbonTabModule>>>
  readonly commands?: Readonly<Record<string, () => Promise<RibbonCommandModule>>>
  /** Icon components by the names the UI data uses (shown while a command loads). */
  readonly icons?: Readonly<Record<string, ComponentType>>
  readonly components?: Readonly<Record<string, () => Promise<ComponentType<never>>>>
}

const SLOTS: Readonly<Record<string, ComponentSlot<never>>> = {
  'inspector-section': INSPECTOR_SECTION,
  'run-section': RUN_SECTION,
  'part-section': PART_SECTION,
  'route-section': ROUTE_SECTION,
  'space-loads-section': SPACE_LOADS_SECTION,
  rail: RAIL_SECTION,
  'workflow-host': WORKFLOW_HOST,
}

/** When a command in each target applies: Model › Plan only while the surface offers its rail sections. */
const TARGET_APPLIES: Readonly<Record<RibbonCommandTarget, ((ctx: BuildingModelRibbonContext) => boolean) | undefined>> = {
  'sheet-live-table': undefined,
  'model-plan': (ctx) => ctx.plan?.openRail !== undefined,
  'trade-analyze': (ctx) => ctx.plan?.openRail !== undefined,
}

function missing(addon: string, what: string, id: string): never {
  const message = `[building-model] the ${addon} add-on's UI data names ${what} "${id}" but its loader map has no screen for it`
  console.error(message)
  throw new Error(message)
}

/** The add-on's contributions: its UI data rows, each with its loader. A row with no loader fails loud at registration. */
export function contributionsFrom(ui: AddonUiManifest, screens: AddonScreens): AddonContributions {
  const tabs = ui.tabs.map((t) => {
    const load = screens.tabs?.[t.id] ?? missing(ui.addon, 'tab', t.id)
    return { kind: t.placement === 'contextual' ? ('contextual-tab' as const) : ('ribbon-tab' as const), addon: ui.addon, id: t.id, label: t.label, applies: (ctx: BuildingModelRibbonContext) => ctx.addonInputs?.[ui.addon] !== undefined, load, ...(t.plan ? { plan: t.plan } : {}), ...(t.scheduleStart ? { scheduleStart: t.scheduleStart } : {}) }
  })
  const commands = ui.commands.map((c) => {
    const load = screens.commands?.[c.id] ?? missing(ui.addon, 'command', c.id)
    const icon = screens.icons?.[c.icon] ?? missing(ui.addon, 'icon', c.icon)
    const applies = TARGET_APPLIES[c.target]
    return { kind: 'ribbon-command' as const, addon: ui.addon, id: c.id, label: c.label, order: c.order, icon, testId: c.testId, target: c.target, ...(applies ? { applies } : {}), load }
  })
  const components = ui.slots.map((s) => {
    const slot = SLOTS[s.slot] ?? missing(ui.addon, 'slot kind', s.slot)
    const load = screens.components?.[s.id] ?? missing(ui.addon, 'slot', s.id)
    return componentContribution({ slot, addon: ui.addon, id: s.id, label: s.label, load, ...(s.elementKind ? { elementKind: s.elementKind } : {}), ...(s.subject ? { subject: s.subject } : {}), ...(s.order !== undefined ? { order: s.order } : {}) })
  })
  return { ribbon: [...tabs, ...commands], components }
}

/** One add-on's ribbon input, typed by the add-on that reads it (its tab code); undefined when the surface offers none. */
export function addonInput<T>(ctx: BuildingModelRibbonContext, addon: string): AddonInput<T> | undefined {
  return ctx.addonInputs?.[addon] as AddonInput<T> | undefined
}

/** A tab module: its tabs by the ids in the add-on's UI data, and the input they show while the add-on's workflow isn't ready. */
export interface TabModule<T> {
  readonly TABS: Readonly<Record<string, (input: T, select: RibbonGroup) => RibbonTab | null>>
  readonly waitingRibbon: (reason: string) => T
}

/** Loaders for every tab in the add-on's UI data, from one tab module: each reads the add-on's ribbon input (or the waiting one). */
export function tabsFrom<T>(ui: AddonUiManifest, load: () => Promise<TabModule<T>>): Readonly<Record<string, () => Promise<RibbonTabModule>>> {
  return Object.fromEntries(
    ui.tabs.map((t) => [
      t.id,
      () =>
        load().then((m) => {
          const build = m.TABS[t.id] ?? missing(ui.addon, 'tab builder', t.id)
          return {
            build: (ctx: BuildingModelRibbonContext, select: RibbonGroup) => {
              const input = addonInput<T>(ctx, ui.addon)
              return input ? build('ready' in input ? input.ready : m.waitingRibbon(input.waiting), select) : null
            },
          }
        }),
    ]),
  )
}
