import type { RibbonCommand, RibbonGroup, RibbonTab, TradeSection } from './types'

/**
 * One tab pattern for every add-on's trade tab, so a person who learns one
 * can find the same kind of command in the same place on the next: Select,
 * then what you draw or place, how it is connected (links, systems), what the
 * model works out for it (checks, sizing), the trade's design records
 * (types), and the documents drawn from it (schedules, diagrams). A tab
 * leaves out the sections it has nothing for; the order never changes.
 *
 * The section words a person reads are fixed (round 15), the same on every
 * trade's tab: Create · Connect · Analyze · Design · Documents, after Select.
 * `tradeTab` writes them; a trade's own group label only shows after the word
 * when a section has more than one group ("Create · Datums", "Create · Build").
 */
export interface TradeTabSections {
  readonly id: string
  readonly label: string
  readonly select: RibbonGroup
  /** Draw or place: route, place a part or a load point. */
  readonly create: readonly RibbonGroup[]
  /** How things join up: links and systems. */
  readonly connect?: RibbonGroup | null
  /** What the model works out: checks, balancing, sizing, demand curves. */
  readonly analyze?: RibbonGroup | null
  /** The trade's records: connection types, run types, room templates. */
  readonly design?: RibbonGroup | null
  /** Schedules and diagrams drawn from the model. */
  readonly documents?: readonly (RibbonGroup | null)[]
}

/** The order sections take on every trade's tab. */
export const TRADE_TAB_ORDER = ['select', 'create', 'connect', 'analyze', 'design', 'documents'] as const

/** The words under each section, the same on every trade's tab. */
export const TRADE_SECTION_LABEL: Readonly<Record<TradeSection, string>> = {
  create: 'Create',
  connect: 'Connect',
  analyze: 'Analyze',
  design: 'Design',
  documents: 'Documents',
}

const keep = (g: RibbonGroup | null | undefined): g is RibbonGroup => g !== null && g !== undefined && g.commands.length > 0

function inSection(section: TradeSection, groups: readonly (RibbonGroup | null | undefined)[]): RibbonGroup[] {
  const kept = groups.filter(keep)
  const word = TRADE_SECTION_LABEL[section]
  return kept.map((g) => ({ ...g, section, label: kept.length > 1 && g.label !== word ? `${word} · ${g.label}` : word }))
}

export function tradeTab(s: TradeTabSections): RibbonTab {
  return {
    id: s.id,
    label: s.label,
    groups: [
      s.select,
      ...inSection('create', s.create),
      ...inSection('connect', [s.connect]),
      ...inSection('analyze', [s.analyze]),
      ...inSection('design', [s.design]),
      ...inSection('documents', s.documents ?? []),
    ],
  }
}

/** Whether a tab was built with `tradeTab` (its groups carry their section). */
export function isTradeTab(tab: RibbonTab): boolean {
  return tab.groups.some((g) => g.section !== undefined)
}

/**
 * Adds commands to a trade tab's section: into its first group of that
 * section, or a new group with the section's word in its place in the order.
 * `first` puts them before the group's own commands.
 */
export function withTradeSectionCommands(tab: RibbonTab, section: TradeSection, commands: readonly RibbonCommand[], first = false): RibbonTab {
  if (commands.length === 0) return tab
  const existing = tab.groups.findIndex((g) => g.section === section)
  if (existing >= 0) {
    return { ...tab, groups: tab.groups.map((g, i) => (i === existing ? { ...g, commands: first ? [...commands, ...g.commands] : [...g.commands, ...commands] } : g)) }
  }
  const rank = TRADE_TAB_ORDER.indexOf(section)
  // After the last group whose section comes earlier in the order (Select and Plan count as before Create).
  let at = 0
  tab.groups.forEach((g, i) => {
    const r = g.section ? TRADE_TAB_ORDER.indexOf(g.section) : 0
    if (r < rank) at = i + 1
  })
  const groups = [...tab.groups]
  groups.splice(at, 0, { id: `${tab.id}-${section}`, label: TRADE_SECTION_LABEL[section], section, commands })
  return { ...tab, groups }
}
