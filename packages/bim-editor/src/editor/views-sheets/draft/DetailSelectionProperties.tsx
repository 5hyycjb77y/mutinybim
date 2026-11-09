'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { DETAIL_LINE_STYLES, detailComponent, detailLineStyleOf, documentIndex, lineStyleFor, type BatchCommand, type DetailLineStyleId, type DrawingItem, type ModelState, type ViewCommand } from '@permitzip/bim-kernel'
import { Button } from '../../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../../ui/field'
import { Input } from '../../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { newId } from '../types'

/**
 * Drawn items selected in a drawing (one, or several with Shift+click): line
 * style, a region's Edit Boundary, detail group, copy into another view or
 * sheet, delete. Each is one kernel command (a batch for several), the same
 * agents send.
 */

const SHAPE_WORD: Record<string, string> = { line: 'detail line', rect: 'rectangle', cloud: 'revision cloud', arc: 'arc', circle: 'circle', polyline: 'polyline', spline: 'spline', region: 'region', component: 'component', repeat: 'repeating detail', batt: 'insulation run', dimension: 'dimension', tag: 'tag', text: 'note' }
const STYLED = new Set(['line', 'rect', 'arc', 'circle', 'polyline', 'spline', 'region'])

function batch(commands: ViewCommand[], label: string): ViewCommand | BatchCommand | null {
  if (commands.length === 0) return null
  return commands.length === 1 && commands[0] ? commands[0] : { type: 'batch_documents', label, commands }
}

export function DetailSelectionProperties({
  items,
  model,
  ownerId,
  canEdit,
  blockedReason,
  send,
  onCleared,
  editingBoundary = false,
  onEditBoundary,
}: {
  items: readonly DrawingItem[]
  model: ModelState
  ownerId: string
  canEdit: boolean
  blockedReason: string
  send: (command: ViewCommand | BatchCommand, label: string) => boolean
  onCleared: () => void
  /** A region's boundary is being sketched right now. */
  editingBoundary?: boolean
  /** Start Edit Boundary on this region. */
  onEditBoundary?: (itemId: string) => void
}) {
  const [groupName, setGroupName] = useState('')
  const n = items.length
  const first = items[0]
  if (!first) return null
  const what = n === 1 ? (first.component ? (detailComponent(first.component.symbolId)?.name ?? 'Component') : (SHAPE_WORD[first.shape] ?? first.shape)) : `${n} drawn items`
  const styled = items.filter((i) => STYLED.has(i.shape) && !i.fill?.masking)
  const styleIds = new Set(styled.map((i) => detailLineStyleOf(i.lineStyle) ?? 'custom'))
  const styleId = styleIds.size === 1 ? [...styleIds][0] : undefined
  const pinned = items.filter((i) => i.pinned).length
  const groups = [...new Set(items.flatMap((i) => (i.detailGroup ? [i.detailGroup] : [])))]
  const index = documentIndex(model)
  const targets = [
    ...index.views.filter((v) => !v.deleted && v.id !== ownerId && v.viewType !== 'three_d' && v.viewType !== 'schedule').map((v) => ({ id: v.id as string, label: v.name })),
    ...index.sheets.filter((sh) => !sh.deleted && sh.id !== ownerId).map((sh) => ({ id: sh.id as string, label: `Sheet ${sh.number} ${sh.title}` })),
  ]
  const restyle = (id: DetailLineStyleId) => {
    const lineStyle = lineStyleFor(id)
    const command = batch(
      styled.map((i) => ({ type: 'update_drawing_item', itemId: i.id, lineStyle })),
      `Restyle ${styled.length} items`,
    )
    if (command) send(command, 'change the line style')
  }
  const regroup = (group: string | null) => {
    const command = batch(
      items.map((i) => ({ type: 'update_drawing_item', itemId: i.id, detailGroup: group })),
      group ? `Group ${n} items` : `Ungroup ${n} items`,
    )
    if (command) send(command, group ? `group as ${group}` : 'ungroup')
  }
  return (
    <div className="flex flex-col gap-3" data-testid="detail-selection">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{what}</span>
      {!canEdit && <span className="text-xs text-muted-foreground">{blockedReason}</span>}
      {n > 1 && <span className="text-xs text-muted-foreground">Shift+click adds or removes items. The Modify tools work on all of them.</span>}
      {pinned > 0 && (
        <span className="text-xs text-muted-foreground" data-testid="detail-pinned">
          {pinned === n ? (n === 1 ? 'Pinned' : 'All pinned') : `${pinned} of ${n} pinned`}: Move, trims, splits and Delete refuse {pinned === 1 ? 'it' : 'them'}. Modify › Unpin frees {pinned === 1 ? 'it' : 'them'}.
        </span>
      )}
      {styled.length > 0 && (
        <Field>
          <FieldLabel htmlFor="detail-line-style">Line style</FieldLabel>
          <Select value={styleId === 'custom' || !styleId ? '' : styleId} onValueChange={(v) => { const style = DETAIL_LINE_STYLES.find((x) => x.id === v); if (style) restyle(style.id) }} disabled={!canEdit}>
            <SelectTrigger id="detail-line-style" size="sm" data-testid="detail-line-style">
              <SelectValue placeholder={styleId === 'custom' ? 'Custom' : 'Mixed'} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {DETAIL_LINE_STYLES.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      {n === 1 && first.shape === 'region' && onEditBoundary && (
        <Field>
          <Button variant="outline" size="sm" disabled={!canEdit || editingBoundary || first.pinned === true} onClick={() => onEditBoundary(first.id)} data-testid="detail-edit-boundary">
            Edit boundary
          </Button>
          <FieldDescription>{!canEdit ? blockedReason : first.pinned ? 'Unpin it first (Modify › Unpin).' : editingBoundary ? 'Finish or cancel the edit in the bar over the drawing.' : 'Drag its corners, add or remove corners, then Finish (Enter) or Cancel (Esc).'}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="detail-group">Detail group</FieldLabel>
        {groups.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm" data-testid="detail-group-name">
              {groups.join(', ')}
            </span>
            <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => regroup(null)} data-testid="detail-ungroup">
              Ungroup
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input id="detail-group" value={groupName} placeholder="e.g. Hanger" onChange={(e) => setGroupName(e.target.value)} className="h-8" disabled={!canEdit} />
            <Button variant="outline" size="sm" disabled={!canEdit || !groupName.trim()} onClick={() => regroup(groupName.trim())} data-testid="detail-group-apply">
              Group
            </Button>
          </div>
        )}
        <FieldDescription>Grouped items select, move and copy together.</FieldDescription>
      </Field>
      {targets.length > 0 && (
        <Field>
          <FieldLabel htmlFor="detail-copy-to">Copy into</FieldLabel>
          <Select
            value=""
            disabled={!canEdit}
            onValueChange={(to) => {
              const target = targets.find((t) => t.id === to)
              if (target && send({ type: 'copy_drawing_items', itemIds: items.map((i) => i.id), toOwnerId: to, offset: { x: 0, y: 0 }, idPrefix: newId('cp') }, `copy into ${target.label}`)) toastCopied(target.label, n)
            }}
          >
            <SelectTrigger id="detail-copy-to" size="sm" data-testid="detail-copy-to">
              <SelectValue placeholder="Another view or sheet…" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Copies keep their place; dimensions between copied items follow the copies.</FieldDescription>
        </Field>
      )}
      <Button
        variant="outline"
        size="sm"
        className="text-danger-600"
        disabled={!canEdit}
        onClick={() => {
          const command = batch(items.map((i) => ({ type: 'delete_drawing_item', itemId: i.id })), `Delete ${n} items`)
          if (command && send(command, 'delete')) onCleared()
        }}
        data-testid="detail-delete"
      >
        Delete
      </Button>
      <span className="text-xs text-muted-foreground">Delete key also removes them. Ctrl+Z brings them back.</span>
    </div>
  )
}

function toastCopied(label: string, n: number) {
  toast.success(`Copied ${n} item${n === 1 ? '' : 's'} into ${label}. Open it from the Views and sheets panel.`)
}
