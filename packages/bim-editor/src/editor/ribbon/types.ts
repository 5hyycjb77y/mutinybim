import type { ComponentType } from 'react'

/**
 * One thing you can do from the ribbon. It is enabled unless it carries a
 * `disabledReason`, which is shown wherever the command is (tooltip, search)
 * so a greyed control always says why.
 */
export interface RibbonCommand {
  readonly id: string
  readonly label: string
  /** Accessible name when it says more than the label ("Undo resize run"). */
  readonly ariaLabel?: string
  readonly icon: ComponentType
  /** One line for the tooltip: what it does. */
  readonly description: string
  /** Shown in the tooltip and in search, e.g. "P" or "⌘Z". */
  readonly shortcut?: string
  readonly disabledReason?: string | null
  /** For on/off commands (Section cut, Lift the roof off). */
  readonly pressed?: boolean
  readonly run?: () => void
  /**
   * A command that opens a menu of these (New ▾). Each child is also found by
   * search. Without `split` the button only opens the menu; with `split` the
   * button runs `run` (the last choice) and a chevron beside it opens the menu.
   */
  readonly children?: readonly RibbonCommand[]
  /** Draw as a split button: the face runs `run`, the chevron opens `children` (Detail line ▾). */
  readonly split?: boolean
  /** Extra words search should match ("dimension" finds "Dimension"; "annotation" finds it too). */
  readonly keywords?: readonly string[]
  readonly testId?: string
  /**
   * A drawing tool: once picked, the keyboard belongs to the drawing (Enter
   * finishes, Esc cancels, Backspace takes a point back), so focus neither
   * stays on the button nor returns to the menu's arrow. Otherwise the Enter
   * that finishes a chain of lines also presses the ribbon control again.
   */
  readonly handsOffKeyboard?: boolean
}

/** The sections every trade's tab reads in the same order and words (`ribbon/trade-tab.ts`). */
export type TradeSection = 'create' | 'connect' | 'analyze' | 'design' | 'documents'

export interface RibbonGroup {
  readonly id: string
  /** Caption under the group (expanded ribbon). */
  readonly label: string
  /** Which trade-tab section this group is (set by `tradeTab`); absent on other tabs. */
  readonly section?: TradeSection
  readonly commands: readonly RibbonCommand[]
  /**
   * Set for a group of exclusive tools (Select / Place part / Route …): drawn
   * as one radio group whose value is the active command id.
   */
  readonly tool?: { readonly value: string; readonly onValueChange: (id: string) => void; readonly ariaLabel: string }
  /**
   * The same group repeated on several tabs (Select at the left of every tab,
   * Modify on the Modify tab and the drawn-items tab). Search lists it once,
   * under the first tab that has it.
   */
  readonly shared?: boolean
}

export interface RibbonTab {
  readonly id: string
  readonly label: string
  readonly groups: readonly RibbonGroup[]
  /** Shown only while it applies (something selected); drawn in the accent colour. */
  readonly contextual?: boolean
}

/** At most this many controls are visible in one group; the rest sit under the group's More menu. */
export const MAX_VISIBLE_PER_GROUP = 5

/** The commands a group shows inline, and the ones it folds into its More menu. */
export function splitGroup(commands: readonly RibbonCommand[]): { visible: readonly RibbonCommand[]; overflow: readonly RibbonCommand[] } {
  if (commands.length <= MAX_VISIBLE_PER_GROUP) return { visible: commands, overflow: [] }
  // Keep one slot for the More button itself, so the group never shows more than five controls.
  return { visible: commands.slice(0, MAX_VISIBLE_PER_GROUP - 1), overflow: commands.slice(MAX_VISIBLE_PER_GROUP - 1) }
}

/**
 * The name a group's More button is read by: the group's own word, so "Create · Build" reads
 * "More build tools" and a one-group section ("Create") reads "More create tools".
 */
export function moreToolsLabel(groupLabel: string): string {
  const own = groupLabel.split(' · ').pop() ?? groupLabel
  return `More ${own.toLowerCase()} tools`
}

export interface SearchEntry {
  readonly command: RibbonCommand
  readonly tabId: string
  /** "Views › New › Floor plan for a level" */
  readonly path: string
}

/** Every runnable command on every tab, menus flattened, for the command search. */
export function searchEntries(tabs: readonly RibbonTab[]): SearchEntry[] {
  const out: SearchEntry[] = []
  const sharedSeen = new Set<string>()
  for (const tab of tabs) {
    for (const group of tab.groups) {
      if (group.shared) {
        if (sharedSeen.has(group.id)) continue
        sharedSeen.add(group.id)
      }
      for (const command of group.commands) {
        if (command.children) {
          if (command.split) out.push({ command, tabId: tab.id, path: `${tab.label} › ${command.label}` })
          for (const child of command.children) out.push({ command: child, tabId: tab.id, path: `${tab.label} › ${command.label} › ${child.label}` })
        } else out.push({ command, tabId: tab.id, path: `${tab.label} › ${command.label}` })
      }
    }
  }
  return out
}

/** Tooltip text: what it does, its shortcut, or why it's off. */
export function tooltipFor(command: RibbonCommand): string {
  if (command.disabledReason) return command.disabledReason
  return command.shortcut ? `${command.description} (${command.shortcut})` : command.description
}
