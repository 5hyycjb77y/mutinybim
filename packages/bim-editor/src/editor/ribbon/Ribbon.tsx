'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, MoreHorizontal, Search } from 'lucide-react'
import { Button } from '../../ui/button'
import { ButtonGroup } from '../../ui/button-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Separator } from '../../ui/separator'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '../../ui/cn'
import { LoadingLine } from '../LoadingLine'
import { CLOSES_AT_ONCE } from '../menu-close'
import { moreToolsLabel, splitGroup, tooltipFor, type RibbonCommand, type RibbonGroup, type RibbonTab } from './types'

const ToolSearchList = dynamic(() => import('./ToolSearchList').then((m) => m.ToolSearchList), {
  ssr: false,
  loading: () => (
    <div className="p-3">
      <LoadingLine label="Loading tools…" />
    </div>
  ),
})

const NO_QUICK: readonly RibbonCommand[] = []

/** The accent fill is too light to mark the active tab on a light ribbon; the selection color reads at 3:1 or more. */
const ACTIVE_TAB_BAR = 'group-data-[variant=line]/tabs-list:data-[state=active]:after:bg-(--mutiny-selection)'

/** A pressed tool: a pale accent tint with a selection-colored edge, so the state doesn't rest on the tint alone. */
const PRESSED_TOOL =
  'bg-(--mutiny-accent-subtle) text-(--mutiny-text) shadow-[inset_0_0_0_1px_var(--mutiny-selection)] hover:bg-(--mutiny-accent-subtle) hover:text-(--mutiny-text) dark:hover:bg-(--mutiny-accent-subtle)'

/**
 * A ribbon for a growing tool library.
 *
 * - Tabs group the jobs (Model, Annotate, Modify, Views, Sheets, Manage); a
 *   contextual tab appears while something is selected and opens itself.
 *   Select sits at the left of every tab.
 * - Quick commands (Undo, Redo) sit beside Find a tool on every tab.
 * - Each group shows at most five controls (Nielsen 8, Three Apples); a group
 *   with more folds the rest under its own More menu. The cap is per group,
 *   not per ribbon: a ribbon is several small groups you scan one at a time,
 *   and each group is the unit you choose from.
 * - Every control has a visible label (expanded) or a tooltip naming it, its
 *   shortcut, or why it is off (Nielsen 6 and 10). Disabled is never silent.
 * - Collapse folds the ribbon to one row: tabs plus the open tab's commands
 *   as icons with tooltips.
 * - "Find a tool" (or /) searches every command on every tab, including menu
 *   items, opens its tab and runs it.
 */
export function Ribbon({
  tabs,
  value,
  onValueChange,
  quick = NO_QUICK,
  trailing,
  trailingSlotId,
  testId = 'ribbon',
}: {
  readonly tabs: readonly RibbonTab[]
  readonly value: string
  readonly onValueChange: (tabId: string) => void
  /** Commands shown on every tab beside Find a tool (Undo, Redo), and found by search too. */
  readonly quick?: readonly RibbonCommand[]
  /** Status on the right of the tab row (presence, save state…). */
  readonly trailing?: ReactNode
  /**
   * An empty element with this id where `trailing` would go, for status the
   * host portals in: live status (save state, revision) then re-renders only
   * itself, not the ribbon.
   */
  readonly trailingSlotId?: string
  readonly testId?: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const active = tabs.find((t) => t.id === value) ?? tabs[0]
  // A narrow window scrolls the tool row sideways. When the tab or its groups change (another view opened,
  // a contextual tab came or went) the row starts at its first tool again, so the tools never sit off to the left.
  const commandsRow = useRef<HTMLDivElement | null>(null)
  const layoutKey = active ? `${active.id}|${collapsed ? 'c' : 'e'}|${active.groups.map((g) => g.id).join(',')}` : ''
  useLayoutEffect(() => {
    const row = commandsRow.current
    if (row && row.scrollLeft !== 0) row.scrollLeft = 0
  }, [layoutKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex flex-col border-b bg-background" data-testid={testId} data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="flex min-w-0 items-center gap-1 px-2">
        <Tabs value={active?.id} onValueChange={onValueChange} className="min-w-0 shrink">
          {/* Too narrow for every tab: the tab row scrolls by itself; the status and search on the right never push it away. */}
          <TabsList variant="line" aria-label="Tool tabs" className="h-9 max-w-full justify-start overflow-x-auto overflow-y-hidden" data-testid="ribbon-tabs">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={cn('px-2.5 text-xs', ACTIVE_TAB_BAR, tab.contextual && 'text-accent-700 data-[state=active]:text-accent-700')}
                data-testid={`ribbon-tab-${tab.id}`}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {collapsed && active && (
          <div ref={commandsRow} className="flex min-w-0 items-center gap-0.5 overflow-x-auto pl-2" data-testid="ribbon-commands">
            {active.groups.map((group, i) => (
              <Fragment key={group.id}>
                {i > 0 && <Separator orientation="vertical" className="mx-1 h-5" />}
                <GroupControls group={group} compact />
              </Fragment>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {trailing}
          {trailingSlotId ? <div id={trailingSlotId} className="flex items-center" /> : null}
          {quick.length > 0 && (
            <div className="flex items-center gap-0.5" role="group" aria-label="Quick access" data-testid="ribbon-quick">
              {quick.map((c) => (
                <CommandButton key={c.id} command={c} compact />
              ))}
            </div>
          )}
          <CommandSearch tabs={tabs} quick={quick} open={searchOpen} onOpenChange={setSearchOpen} onTab={onValueChange} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={collapsed ? 'Expand the ribbon' : 'Collapse the ribbon to one row'} aria-pressed={collapsed} onClick={() => setCollapsed((c) => !c)} data-testid="ribbon-collapse">
                {collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{collapsed ? 'Show tool names and groups' : 'Fold the tools into one row'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {!collapsed && active && (
        <div ref={commandsRow} className="flex min-w-0 items-stretch gap-1 overflow-x-auto border-t px-2 py-1" role="toolbar" aria-label={`${active.label} tools`} data-testid="ribbon-commands">
          {active.groups.map((group, i) => (
            <Fragment key={group.id}>
              {i > 0 && <Separator orientation="vertical" className="mx-1 h-auto" />}
              <div className="flex shrink-0 flex-col items-center gap-0.5" role="group" aria-label={group.label} data-testid={`ribbon-group-${group.id}`}>
                <div className="flex items-center gap-0.5">
                  <GroupControls group={group} compact={false} />
                </div>
                <span className="text-[10px] leading-none text-muted-foreground">{group.label}</span>
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

function GroupControls({ group, compact }: { readonly group: RibbonGroup; readonly compact: boolean }) {
  const { visible, overflow } = splitGroup(group.commands)
  const more = overflow.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? 'icon-sm' : 'sm'} aria-label={moreToolsLabel(group.label)}>
          <MoreHorizontal data-icon={compact ? undefined : 'inline-start'} />
          {!compact && 'More'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={CLOSES_AT_ONCE}>
        <DropdownMenuGroup>
          {overflow.map((c) => (
            <MenuItemFor key={c.id} command={c} />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  if (group.tool) {
    const tool = group.tool
    return (
      <>
        <ToggleGroup type="single" variant="outline" size="sm" value={tool.value} onValueChange={(v) => v && tool.onValueChange(v)} aria-label={tool.ariaLabel}>
          {visible.filter((c) => !c.children).map((c) => {
            const Icon = c.icon
            return (
              <Tooltip key={c.id}>
                <TooltipTrigger asChild>
                  <span>
                    <ToggleGroupItem value={c.id} aria-label={c.label} disabled={Boolean(c.disabledReason)} data-testid={c.testId}>
                      <Icon data-icon={compact ? undefined : 'inline-start'} />
                      {!compact && c.label}
                    </ToggleGroupItem>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{tooltipFor(c)}</TooltipContent>
              </Tooltip>
            )
          })}
        </ToggleGroup>
        {visible.filter((c) => c.children).map((c) => <ControlFor key={c.id} command={c} compact={compact} />)}
        {more}
      </>
    )
  }
  return (
    <>
      {visible.map((c) => (
        <ControlFor key={c.id} command={c} compact={compact} />
      ))}
      {more}
    </>
  )
}

function ControlFor({ command, compact }: { readonly command: RibbonCommand; readonly compact: boolean }) {
  if (command.children && command.split) return <SplitCommand command={command} compact={compact} />
  if (command.children) return <MenuCommand command={command} compact={compact} />
  return <CommandButton command={command} compact={compact} />
}

/**
 * A menu whose choice hands the keyboard to the drawing (a drawing tool) does
 * not put focus back on its arrow when it closes, and leaves nothing focused:
 * the drawing hears its keys at the window.
 */
function useKeyboardHandOff() {
  const handingOff = useRef(false)
  return {
    chosen: (c: RibbonCommand) => {
      handingOff.current = Boolean(c.handsOffKeyboard)
    },
    onCloseAutoFocus: (e: Event) => {
      if (!handingOff.current) return
      handingOff.current = false
      e.preventDefault()
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    },
  }
}

/** The face runs the last choice (Detail line draws the last shape); the chevron opens the other choices. */
function SplitCommand({ command, compact }: { readonly command: RibbonCommand; readonly compact: boolean }) {
  const handOff = useKeyboardHandOff()
  return (
    <ButtonGroup aria-label={command.label}>
      <CommandButton command={command} compact={compact} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="w-5" aria-label={`${command.label}: choose another`} data-testid={command.testId ? `${command.testId}-menu` : undefined}>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{command.disabledReason ?? `Choose another kind of ${command.label.toLowerCase()}`}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className={CLOSES_AT_ONCE} onCloseAutoFocus={handOff.onCloseAutoFocus}>
          {command.disabledReason && <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground">{command.disabledReason}</DropdownMenuLabel>}
          <DropdownMenuGroup>
            {(command.children ?? []).map((c) => (
              <MenuItemFor key={c.id} command={c} onChosen={handOff.chosen} />
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

function CommandButton({ command, compact }: { readonly command: RibbonCommand; readonly compact: boolean }) {
  const Icon = command.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="ghost"
            size={compact ? 'icon-sm' : 'sm'}
            className={command.pressed ? PRESSED_TOOL : undefined}
            aria-label={command.ariaLabel ?? command.label}
            aria-pressed={command.pressed}
            disabled={Boolean(command.disabledReason)}
            onClick={(e) => {
              command.run?.()
              if (command.handsOffKeyboard) e.currentTarget.blur()
            }}
            data-testid={command.testId}
          >
            <Icon data-icon={compact ? undefined : 'inline-start'} />
            {!compact && command.label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltipFor(command)}</TooltipContent>
    </Tooltip>
  )
}

function MenuCommand({ command, compact }: { readonly command: RibbonCommand; readonly compact: boolean }) {
  const Icon = command.icon
  const handOff = useKeyboardHandOff()
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size={compact ? 'icon-sm' : 'sm'} aria-label={command.label} data-testid={command.testId}>
              <Icon data-icon={compact ? undefined : 'inline-start'} />
              {!compact && command.label}
              {!compact && <ChevronDown data-icon="inline-end" />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipFor(command)}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className={CLOSES_AT_ONCE} onCloseAutoFocus={handOff.onCloseAutoFocus}>
        {command.disabledReason && <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground">{command.disabledReason}</DropdownMenuLabel>}
        <DropdownMenuGroup>
          {(command.children ?? []).map((c) => (
            <MenuItemFor key={c.id} command={c} onChosen={handOff.chosen} />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MenuItemFor({ command, onChosen }: { readonly command: RibbonCommand; readonly onChosen?: (command: RibbonCommand) => void }) {
  const Icon = command.icon
  return (
    <DropdownMenuItem
      disabled={Boolean(command.disabledReason)}
      onSelect={() => {
        onChosen?.(command)
        command.run?.()
      }}
      title={command.disabledReason ?? undefined}
      data-testid={command.testId}
    >
      <Icon data-icon="inline-start" />
      {command.label}
      {command.shortcut && <span className="ml-auto pl-4 text-xs text-muted-foreground">{command.shortcut}</span>}
    </DropdownMenuItem>
  )
}

function CommandSearch({
  tabs: ribbonTabs,
  quick,
  open,
  onOpenChange,
  onTab,
}: {
  readonly tabs: readonly RibbonTab[]
  readonly quick: readonly RibbonCommand[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onTab: (tabId: string) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-40 justify-start text-muted-foreground" aria-label="Find a tool" data-testid="ribbon-search-trigger">
          <Search data-icon="inline-start" />
          Find a tool
          <kbd className="ml-auto rounded border px-1 font-mono text-[10px]">/</kbd>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="ribbon-search">
        <ToolSearchList tabs={ribbonTabs} quick={quick} onOpenChange={onOpenChange} onTab={onTab} />
      </PopoverContent>
    </Popover>
  )
}
