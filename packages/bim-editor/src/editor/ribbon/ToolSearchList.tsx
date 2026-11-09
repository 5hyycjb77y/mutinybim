'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { defaultFilter } from 'cmdk'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '../../ui/command'
import { searchEntries, type RibbonCommand, type RibbonTab } from './types'

const QUICK_TAB_ID = 'quick'

/**
 * A tool whose name or keyword is the word typed ranks first ("tape" → Measure); the rest keep the
 * fuzzy score, under it. Without this, a tool whose words merely contain the letters in order could win.
 */
export function toolSearchScore(value: string, search: string, keywords?: string[]): number {
  const typed = search.trim().toLowerCase()
  if (typed && keywords?.some((k) => k.trim().toLowerCase() === typed)) return 1
  return defaultFilter(value, search, keywords) * 0.99
}

/** The ribbon's Find a tool list (opened from its button or "/"). */
export function ToolSearchList({
  tabs: ribbonTabs,
  quick,
  onOpenChange,
  onTab,
}: {
  readonly tabs: readonly RibbonTab[]
  readonly quick: readonly RibbonCommand[]
  readonly onOpenChange: (open: boolean) => void
  readonly onTab: (tabId: string) => void
}) {
  const tabs = useMemo<readonly RibbonTab[]>(() => (quick.length > 0 ? [...ribbonTabs, { id: QUICK_TAB_ID, label: 'Quick access', groups: [{ id: QUICK_TAB_ID, label: 'Quick access', commands: quick }] }] : ribbonTabs), [ribbonTabs, quick])
  const entries = useMemo(() => searchEntries(tabs), [tabs])
  const byTab = useMemo(() => {
    const map = new Map<string, typeof entries>()
    for (const e of entries) map.set(e.tabId, [...(map.get(e.tabId) ?? []), e])
    return map
  }, [entries])
  const choose = useCallback(
    (entry: (typeof entries)[number]) => {
      if (entry.command.disabledReason) return
      onOpenChange(false)
      if (entry.tabId !== QUICK_TAB_ID) onTab(entry.tabId)
      entry.command.run?.()
    },
    [onOpenChange, onTab],
  )
  const [search, setSearch] = useState('')
  const item = (entry: (typeof entries)[number], where: string | null): ReactNode => {
    const Icon = entry.command.icon
    return (
      <CommandItem
        key={`${entry.tabId}:${entry.command.id}`}
        value={entry.path}
        keywords={[entry.command.label, ...(entry.command.keywords ?? []), entry.command.description]}
        disabled={Boolean(entry.command.disabledReason)}
        onSelect={() => choose(entry)}
        className="items-start py-2"
      >
        <Icon />
        <span className="flex min-w-0 flex-col">
          <span>{entry.path.split(' › ').slice(1).join(' › ')}</span>
          {where && <span className="text-xs text-muted-foreground">{where}</span>}
          {entry.command.disabledReason && <span className="text-xs text-muted-foreground">{entry.command.disabledReason}</span>}
        </span>
        {entry.command.shortcut && <CommandShortcut>{entry.command.shortcut}</CommandShortcut>}
      </CommandItem>
    )
  }
  return (
    <Command filter={toolSearchScore}>
      <CommandInput placeholder="Find a tool…" aria-label="Find a tool" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>No tool by that name. Try another word, like “duct”, “sheet” or “dimension”.</CommandEmpty>
        {search.trim() ? (
          // One list while searching, so the best match is on top whichever tab it is on (results across groups don't reorder).
          <CommandGroup heading="Tools">{entries.map((entry) => item(entry, entry.path.split(' › ')[0] ?? null))}</CommandGroup>
        ) : (
          tabs.map((tab) => {
            const list = byTab.get(tab.id) ?? []
            if (list.length === 0) return null
            return (
              <CommandGroup key={tab.id} heading={tab.label}>
                {list.map((entry) => item(entry, null))}
              </CommandGroup>
            )
          })
        )}
      </CommandList>
    </Command>
  )
}
