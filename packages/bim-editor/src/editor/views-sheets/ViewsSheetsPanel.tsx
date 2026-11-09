'use client'

import { useMemo, useState } from 'react'
import { Box, ChevronDown, ChevronRight, FileText, Layers, MoreHorizontal, Network, PenLine, Plus, Printer, Scissors, Sparkles, SquareDashed, Stamp, TableProperties } from 'lucide-react'
import { canonicalViewLevel, type DiagramKind, documentIndex, type ModelState, type Sheet, type ViewElement } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { VIEW_DRAG_TYPE, VIEW_TYPE_LABEL, sameOpen, type CreatableViewType, type OpenItem } from './types'

export type PanelRequest =
  | { readonly kind: 'new_view'; readonly viewType: CreatableViewType }
  /** A live diagram drawn from the model (one-line, electrical riser, plumbing riser). */
  | { readonly kind: 'new_diagram'; readonly diagramKind: DiagramKind }
  | { readonly kind: 'new_sheet' }
  | { readonly kind: 'new_schedule' }
  | { readonly kind: 'rename_view'; readonly view: ViewElement }
  | { readonly kind: 'duplicate_view'; readonly view: ViewElement }
  | { readonly kind: 'delete_view'; readonly view: ViewElement }
  | { readonly kind: 'edit_sheet'; readonly sheet: Sheet }
  | { readonly kind: 'delete_sheet'; readonly sheet: Sheet }
  | { readonly kind: 'arrange_sheet'; readonly sheet: Sheet }
  | { readonly kind: 'sheet_revisions'; readonly sheet: Sheet }
  | { readonly kind: 'print_set' }
  | { readonly kind: 'issue_set' }
  | { readonly kind: 'export_ifc' }
  /** Sheets › Project info: the facts every title block prints, filled in once. */
  | { readonly kind: 'project_info' }
  /** Open Cmd+J on a new thread with a drafted prompt to make sheets, views and schedules by script (nothing is sent or changed until the person approves). */
  | { readonly kind: 'agent_make' }

interface Props {
  readonly model: ModelState | null
  readonly canEdit: boolean
  /** Why editing is off, said the way the person can act on it. */
  readonly blockedReason: string
  readonly open: OpenItem
  readonly onOpen: (item: OpenItem) => void
  readonly onRequest: (request: PanelRequest) => void
  /** Who is looking: their own working 3D view is listed, other people's are not. */
  readonly userId?: string
  /** The rail draws the title and the New button in its section header. */
  readonly headerless?: boolean
}

/** The list's "+" (New view or sheet) button and menu. */
export function NewViewOrSheetMenu({ onRequest, canEdit, blockedReason }: { onRequest: (request: PanelRequest) => void; canEdit: boolean; blockedReason: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="New view or sheet">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? 'New view or sheet' : blockedReason}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <NewMenuItems onRequest={onRequest} disabled={!canEdit} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const GROUPS: ReadonlyArray<{ type: ViewElement['viewType']; title: string }> = [
  { type: 'floor_plan', title: 'Floor plans' },
  { type: 'ceiling_plan', title: 'Ceiling plans' },
  { type: 'section', title: 'Sections' },
  { type: 'three_d', title: '3D views' },
  { type: 'detail', title: 'Detail views' },
  { type: 'schedule', title: 'Schedules' },
]

/** The New menu, shared by the toolbar and the list's header. */
export function NewMenuItems({ onRequest, disabled }: { onRequest: (request: PanelRequest) => void; disabled: boolean }) {
  return (
    <>
      <DropdownMenuLabel>New view</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_view', viewType: 'floor_plan' })}>
          <Layers data-icon="inline-start" />
          Floor plan for a level
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_view', viewType: 'ceiling_plan' })}>
          <SquareDashed data-icon="inline-start" />
          Ceiling plan
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_view', viewType: 'section' })}>
          <Scissors data-icon="inline-start" />
          Section (draw a cut line)
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_view', viewType: 'three_d' })}>
          <Box data-icon="inline-start" />
          3D view
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_view', viewType: 'detail' })}>
          <PenLine data-icon="inline-start" />
          Detail view (drawing-only)
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_schedule' })} data-testid="new-menu-schedule">
          <TableProperties data-icon="inline-start" />
          New schedule…
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Diagrams from the model</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_diagram', diagramKind: 'one_line' })} data-testid="new-view-one-line">
          <Network data-icon="inline-start" />
          One-line diagram
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_diagram', diagramKind: 'electrical_riser' })}>
          <Network data-icon="inline-start" />
          Electrical riser diagram
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_diagram', diagramKind: 'plumbing_riser' })} data-testid="new-view-plumbing-riser">
          <Network data-icon="inline-start" />
          Plumbing riser diagram
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_diagram', diagramKind: 'plumbing_isometric' })} data-testid="new-view-plumbing-isometric">
          <Network data-icon="inline-start" />
          Plumbing isometric
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'new_sheet' })}>
        <FileText data-icon="inline-start" />
        New sheet
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled} onSelect={() => onRequest({ kind: 'agent_make' })} data-testid="new-menu-agent-make">
        <Sparkles data-icon="inline-start" />
        Make sheets, views and schedules with the agent…
      </DropdownMenuItem>
    </>
  )
}

export function ViewsSheetsPanel({ model, canEdit, blockedReason, open, onOpen, onRequest, userId, headerless = false }: Props) {
  const index = useMemo(() => (model ? documentIndex(model) : null), [model])
  const sheetNumberOf = useMemo(() => {
    const map = new Map<string, string>()
    if (!index) return map
    const numbers = new Map(index.sheets.map((s) => [s.id as string, s.number]))
    for (const [viewId, vp] of index.viewportByView) map.set(viewId, numbers.get(vp.sheetId) ?? '')
    return map
  }, [index])
  const sheets = useMemo(() => [...(index?.sheets ?? [])].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })), [index])

  return (
    <section className="flex flex-col gap-2" aria-label="Views and sheets" data-testid={headerless ? undefined : 'views-sheets-panel'}>
      {!headerless && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Views and sheets</h2>
          <NewViewOrSheetMenu onRequest={onRequest} canEdit={canEdit} blockedReason={blockedReason} />
        </div>
      )}

      <ItemGroup className="gap-0.5">
        <OpenRow label="3D model" description="Everything, live" active={sameOpen(open, { kind: 'model', mode: '3d' })} onOpen={() => onOpen({ kind: 'model', mode: '3d' })} />
        <OpenRow label="Top-down plan" description="All levels, looking down" active={sameOpen(open, { kind: 'model', mode: 'plan' })} onOpen={() => onOpen({ kind: 'model', mode: 'plan' })} />
      </ItemGroup>

      {!model ? (
        <Empty className="border p-3">
          <EmptyHeader>
            <EmptyTitle className="text-sm">No saved views yet</EmptyTitle>
            <EmptyDescription className="text-xs">{blockedReason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {GROUPS.map((group) => {
            const views = (index?.views ?? []).filter((v) => v.viewType === group.type && (!v.props?.workingFor || v.props.workingFor === userId)).sort(byLevelThenName(model))
            if (views.length === 0) return null
            return (
              <Group key={group.type} title={group.title} count={views.length}>
                {views.map((view) => (
                  <ViewRow
                    key={view.id}
                    view={view}
                    levelName={viewLevelLabel(model, view)}
                    onSheet={sheetNumberOf.get(view.id) ?? null}
                    active={open.kind === 'view' && open.id === view.id}
                    canEdit={canEdit}
                    blockedReason={blockedReason}
                    onOpen={() => onOpen({ kind: 'view', id: view.id })}
                    onRequest={onRequest}
                  />
                ))}
              </Group>
            )
          })}
          <Group title="Sheets" count={sheets.length}>
            {sheets.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No sheets yet. Use + to make one, then drag views onto it, or have the agent make the set.</p>
            ) : (
              sheets.map((sheet) => (
                <SheetRow
                  key={sheet.id}
                  sheet={sheet}
                  viewCount={index?.viewportsBySheet.get(sheet.id)?.length ?? 0}
                  active={open.kind === 'sheet' && open.id === sheet.id}
                  canEdit={canEdit}
                  blockedReason={blockedReason}
                  onOpen={() => onOpen({ kind: 'sheet', id: sheet.id })}
                  onRequest={onRequest}
                />
              ))
            )}
            <div className="px-1 pt-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex">
                    <Button variant="outline" size="sm" className="flex-1" disabled={!canEdit} onClick={() => onRequest({ kind: 'agent_make' })} data-testid="views-agent-make">
                      <Sparkles data-icon="inline-start" />
                      Make with the agent…
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canEdit ? 'Opens Cmd+J with a drafted request for sheets, views and schedules. Edit it, send it; nothing changes until you approve.' : blockedReason}</TooltipContent>
              </Tooltip>
            </div>
            {sheets.length > 0 && (
              <div className="flex gap-1 px-1 pt-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => onRequest({ kind: 'print_set' })} data-testid="panel-print-set">
                  <Printer data-icon="inline-start" />
                  Print set…
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex flex-1">
                      <Button variant="outline" size="sm" className="flex-1" disabled={!canEdit} onClick={() => onRequest({ kind: 'issue_set' })} data-testid="panel-issue-set">
                        <Stamp data-icon="inline-start" />
                        Issue set…
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{canEdit ? 'Check the set against its last print, add the revision row and issue it' : blockedReason}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </Group>
          {(index?.views.length ?? 0) === 0 && (
            <p className="text-xs text-muted-foreground">Make a floor plan for a level, draw a section in it, then put both on a sheet.</p>
          )}
        </>
      )}
    </section>
  )
}

/** The level a views-list row names: the level's name, also for a view that stored its level's id. */
export function viewLevelLabel(model: ModelState | null, view: ViewElement): string | null {
  const level = view.props?.level
  if (!level || view.viewType === 'detail') return null
  return (model ? canonicalViewLevel(model, level) : level) ?? null
}

function byLevelThenName(model: ModelState | null) {
  return (a: ViewElement, b: ViewElement): number =>
    (viewLevelLabel(model, a) ?? '').localeCompare(viewLevelLabel(model, b) ?? '', undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true })
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start px-1 text-xs font-medium text-muted-foreground">
          {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
          {title}
          <span className="ml-auto tabular-nums">{count}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ItemGroup className="gap-0.5">{children}</ItemGroup>
      </CollapsibleContent>
    </Collapsible>
  )
}

function OpenRow({ label, description, active, onOpen }: { label: string; description: string; active: boolean; onOpen: () => void }) {
  return (
    <Item asChild size="xs" variant={active ? 'muted' : 'default'}>
      <Button variant="ghost" className="h-auto justify-start" aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <ItemContent>
          <ItemTitle className="text-xs">{label}</ItemTitle>
          <ItemDescription className="text-xs">{description}</ItemDescription>
        </ItemContent>
      </Button>
    </Item>
  )
}

function ViewRow({
  view,
  levelName,
  onSheet,
  active,
  canEdit,
  blockedReason,
  onOpen,
  onRequest,
}: {
  view: ViewElement
  levelName: string | null
  onSheet: string | null
  active: boolean
  canEdit: boolean
  blockedReason: string
  onOpen: () => void
  onRequest: (request: PanelRequest) => void
}) {
  const draggable = canEdit && onSheet === null
  return (
    <Item size="xs" variant={active ? 'muted' : 'default'} className="flex-nowrap gap-1 py-0.5 pl-2 pr-0.5" data-testid={`view-row-${view.id}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start px-1 font-normal"
            aria-current={active ? 'page' : undefined}
            onClick={onOpen}
            draggable={draggable}
            onDragStart={(e) => {
              e.dataTransfer.setData(VIEW_DRAG_TYPE, view.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <span className="truncate">{view.name}</span>
            {levelName && <span className="shrink-0 text-muted-foreground">{levelName}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {onSheet ? `${VIEW_TYPE_LABEL[view.viewType]}. On sheet ${onSheet}.` : canEdit ? `${VIEW_TYPE_LABEL[view.viewType]}. Open it, or drag it onto an open sheet.` : VIEW_TYPE_LABEL[view.viewType]}
        </TooltipContent>
      </Tooltip>
      {onSheet && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {onSheet}
        </Badge>
      )}
      <ItemActions>
        <RowMenu
          label={`Actions for view ${view.name}`}
          canEdit={canEdit}
          blockedReason={blockedReason}
          items={[
            { label: 'Rename…', onSelect: () => onRequest({ kind: 'rename_view', view }) },
            { label: 'Duplicate', onSelect: () => onRequest({ kind: 'duplicate_view', view }) },
            { label: 'Delete…', destructive: true, onSelect: () => onRequest({ kind: 'delete_view', view }) },
          ]}
        />
      </ItemActions>
    </Item>
  )
}

function SheetRow({
  sheet,
  viewCount,
  active,
  canEdit,
  blockedReason,
  onOpen,
  onRequest,
}: {
  sheet: Sheet
  viewCount: number
  active: boolean
  canEdit: boolean
  blockedReason: string
  onOpen: () => void
  onRequest: (request: PanelRequest) => void
}) {
  return (
    <Item size="xs" variant={active ? 'muted' : 'default'} className="flex-nowrap gap-1 py-0.5 pl-2 pr-0.5" data-testid={`sheet-row-${sheet.number}`}>
      <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1 font-normal" aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <span className="shrink-0 font-medium">{sheet.number}</span>
        <span className="truncate text-muted-foreground">{sheet.title}</span>
      </Button>
      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums" aria-label={`${viewCount} views placed`}>
        {viewCount}
      </span>
      <ItemActions>
        <RowMenu
          label={`Actions for sheet ${sheet.number}`}
          canEdit={canEdit}
          blockedReason={blockedReason}
          items={[
            { label: 'Number, name and title block…', onSelect: () => onRequest({ kind: 'edit_sheet', sheet }) },
            { label: 'Arrange views…', onSelect: () => onRequest({ kind: 'arrange_sheet', sheet }) },
            { label: 'Revisions…', onSelect: () => onRequest({ kind: 'sheet_revisions', sheet }) },
            { label: 'Delete…', destructive: true, onSelect: () => onRequest({ kind: 'delete_sheet', sheet }) },
          ]}
        />
      </ItemActions>
    </Item>
  )
}

function RowMenu({ label, canEdit, blockedReason, items }: { label: string; canEdit: boolean; blockedReason: string; items: ReadonlyArray<{ label: string; destructive?: boolean; onSelect: () => void }> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!canEdit && <DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted-foreground">{blockedReason}</DropdownMenuLabel>}
        <DropdownMenuGroup>
          {items.map((item) => (
            <DropdownMenuItem key={item.label} disabled={!canEdit} className={item.destructive ? 'text-danger-600' : undefined} onSelect={item.onSelect}>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
