'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Info, PencilRuler, SearchX, X } from 'lucide-react'
import { partGroupName } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import type { CatalogEntry } from '../model-session'
import { useWindowedRows, windowBoxStyle, windowSlice } from '../use-windowed-rows'
import { flattenPartGroups, groupParts, type PartsListRow } from './group-parts'
import { partEditBlockedReason } from './part-edit'

export interface GroupedPartsListProps {
  readonly entries: readonly CatalogEntry[]
  /** The search box's words; groups keep their headers and counts while it filters. */
  readonly filter: string
  readonly onClearFilter: () => void
  readonly selectedTypeId: string | null
  readonly onSelectType: (entry: CatalogEntry) => void
  /** Open the part editor on a type. Absent when this person can't change the model. */
  readonly onEditPart?: (entry: CatalogEntry) => void
}

/** Estimated height of one row, px (real heights replace it once measured). */
const ROW_PX = 52

/**
 * Part types grouped category → family → type with counts. Click a type to
 * place it; double-click (or its pencil) opens it in the part editor, or says
 * why it can't.
 */
export function GroupedPartsList({ entries, filter, onClearFilter, selectedTypeId, onSelectType, onEditPart }: GroupedPartsListProps) {
  const groups = useMemo(() => groupParts(entries, filter), [entries, filter])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsedFor, setCollapsedFor] = useState(filter)
  // A new filter opens every group again, so a match is never hidden in a closed one.
  if (collapsedFor !== filter) {
    setCollapsedFor(filter)
    setCollapsed(new Set())
  }
  const rows = useMemo(() => flattenPartGroups(groups, collapsed, selectedTypeId), [groups, collapsed, selectedTypeId])
  const windowRows = useWindowedRows(rows.length, ROW_PX)
  const [notice, setNotice] = useState<string | null>(null)

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const openEditor = (entry: CatalogEntry) => {
    const why = partEditBlockedReason(entry, onEditPart !== undefined)
    if (why !== null || !onEditPart) {
      setNotice(why)
      return
    }
    setNotice(null)
    onEditPart(entry)
  }

  if (rows.length === 0) {
    const words = filter.trim()
    return (
      <Empty className="border" data-testid="parts-list-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>{words === '' ? 'No parts to show' : `No parts match "${words}".`}</EmptyTitle>
          <EmptyDescription>{words === '' ? 'Choose All categories, or use New part to make one.' : 'Clear the filter, or choose All categories.'}</EmptyDescription>
        </EmptyHeader>
        {words !== '' && (
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={onClearFilter}>
              Clear the filter
            </Button>
          </EmptyContent>
        )}
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {notice && (
        <Alert data-testid="part-edit-notice">
          <Info />
          <AlertDescription className="flex items-start justify-between gap-2">
            <span role="status">{notice}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div ref={windowRows.scrollRef} className={windowRows.windowed ? 'overflow-y-auto' : undefined} style={windowBoxStyle(windowRows)}>
        <ItemGroup className="gap-1" aria-label="Part types">
          {windowRows.padTop > 0 && <div aria-hidden="true" style={{ height: windowRows.padTop }} />}
          {windowSlice(rows, windowRows).map(({ item: row, index }) => (
            <div key={row.key} ref={windowRows.measure} data-index={index}>
              {row.kind === 'type' ? (
                <TypeRow
                  entry={row.entry}
                  selected={row.entry.typeId === selectedTypeId}
                  onSelect={() => {
                    setNotice(null)
                    onSelectType(row.entry)
                  }}
                  onOpenEditor={() => openEditor(row.entry)}
                  canEdit={onEditPart !== undefined}
                />
              ) : (
                <GroupHeader row={row} onToggle={() => toggle(row.key)} />
              )}
            </div>
          ))}
          {windowRows.padBottom > 0 && <div aria-hidden="true" style={{ height: windowRows.padBottom }} />}
        </ItemGroup>
      </div>
    </div>
  )
}

function GroupHeader({ row, onToggle }: { row: Extract<PartsListRow, { kind: 'category' | 'family' }>; onToggle: () => void }) {
  const name = row.kind === 'category' ? row.label : row.name
  const Chevron = row.open ? ChevronDown : ChevronRight
  return (
    <Button
      variant="ghost"
      size="sm"
      className={row.kind === 'category' ? 'w-full justify-start font-medium' : 'w-full justify-start pl-5 text-muted-foreground'}
      aria-expanded={row.open}
      onClick={onToggle}
      data-testid={row.kind === 'category' ? 'parts-category' : 'parts-family'}
    >
      <Chevron data-icon="inline-start" />
      <span className="truncate">{name}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        <span aria-hidden="true">{row.count}</span>
        <span className="sr-only">, {row.count} {row.count === 1 ? 'type' : 'types'}</span>
        {!row.open && row.holdsSelected ? ' · chosen' : ''}
      </span>
    </Button>
  )
}

function TypeRow({ entry, selected, onSelect, onOpenEditor, canEdit }: { entry: CatalogEntry; selected: boolean; onSelect: () => void; onOpenEditor: () => void; canEdit: boolean }) {
  const origin = entry.inModel ? null : entry.library === 'firm' ? 'firm library' : 'starter library'
  const why = canEdit && entry.definition.model ? partEditBlockedReason(entry, true) : null
  return (
    <Item size="sm" variant={selected ? 'outline' : 'default'} className={selected ? 'ml-8 border-primary bg-primary-50' : 'ml-8'} asChild>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          className="h-auto flex-1 justify-start text-left whitespace-normal"
          onClick={onSelect}
          onDoubleClick={onOpenEditor}
          aria-pressed={selected}
          title="Click to place. Double-click to open in the part editor."
          data-testid={`part-type-${entry.typeId}`}
        >
          <ItemContent>
            <ItemTitle className="text-xs">{entry.definition.typeName}</ItemTitle>
            {origin && <ItemDescription className="text-xs">{origin}</ItemDescription>}
          </ItemContent>
        </Button>
        {canEdit && entry.definition.model && (
          <ItemActions>
            {why === null ? (
              <Button variant="ghost" size="icon-sm" aria-label={`Edit part ${partGroupName(entry.definition)}`} title="Edit part" onClick={onOpenEditor} data-testid={`edit-part-${entry.typeId}`}>
                <PencilRuler />
              </Button>
            ) : (
              // A disabled button shows no tooltip; the wrapper carries why.
              <span title={why}>
                <Button variant="ghost" size="icon-sm" disabled aria-label={why} data-testid={`edit-part-${entry.typeId}`}>
                  <PencilRuler />
                </Button>
              </span>
            )}
          </ItemActions>
        )}
      </div>
    </Item>
  )
}
