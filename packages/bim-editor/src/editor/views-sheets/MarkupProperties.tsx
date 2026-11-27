'use client'

import { CheckCircle2, CircleDot, Highlighter, PenTool, Trash2 } from 'lucide-react'
import { DEFAULT_MARKER_COLOR, DEFAULT_MARKER_WIDTH_MM, MARKUP_WIDTH_PRESETS, type DrawingItem, type MarkupStatus, type MarkupTool } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Separator } from '../../ui/separator'
import { MARKUP_COLOR_SWATCHES } from './markup-tools'

interface Props {
  readonly item: DrawingItem
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly onUpdate: (patch: { readonly status?: MarkupStatus; readonly color?: string; readonly widthMm?: number; readonly tool?: MarkupTool }) => void
  readonly onDelete: () => void
}

const STATUS_OPTIONS: ReadonlyArray<{ readonly value: MarkupStatus; readonly label: string; readonly hint: string }> = [
  { value: 'open', label: 'Open', hint: 'Active redline for the agent or reviewer' },
  { value: 'addressed', label: 'Yellow-lined', hint: 'Addressed — highlighted yellow for backcheck' },
  { value: 'resolved', label: 'Resolved', hint: 'Hidden from active review renders' },
]

/** Right-rail inspector when a single sheet review markup stroke is selected. */
export function MarkupProperties({ item, canEdit, blockedReason, onUpdate, onDelete }: Props) {
  const spec = item.markup
  if (!spec) return null
  const tool = spec.tool ?? 'marker'
  const color = spec.color ?? DEFAULT_MARKER_COLOR
  const widthMm = spec.widthMm ?? DEFAULT_MARKER_WIDTH_MM
  const status = spec.status ?? 'open'
  const presets = MARKUP_WIDTH_PRESETS[tool]

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="markup-properties">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium">
          {tool === 'highlighter' ? <Highlighter className="size-3.5" /> : <PenTool className="size-3.5" />}
          <span>Sheet markup</span>
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Non-printing</span>
      </div>

      {spec.note && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs text-foreground">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Note</div>
          {spec.note}
        </div>
      )}

      {spec.addressedNote && (
        <div className="rounded-md border border-warning-300 bg-warning-50 p-2 text-xs text-foreground">
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning-700">
            <CheckCircle2 className="size-3" />
            Addressed note
          </div>
          {spec.addressedNote}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Review status</span>
        <div className="grid grid-cols-3 gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={status === opt.value ? 'secondary' : 'outline'}
              className="h-7 px-1.5 text-[11px]"
              disabled={!canEdit}
              title={!canEdit ? blockedReason : opt.hint}
              data-testid={`markup-status-${opt.value}`}
              onClick={() => onUpdate({ status: opt.value })}
            >
              {opt.value === 'open' && <CircleDot className="mr-1 size-3 text-danger-600" />}
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Ink colour</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {MARKUP_COLOR_SWATCHES.map((swatch) => {
            const active = color.toLowerCase() === swatch.color.toLowerCase()
            return (
              <Button
                key={swatch.color}
                type="button"
                variant="ghost"
                size="icon"
                disabled={!canEdit}
                title={!canEdit ? blockedReason : swatch.label}
                onClick={() => onUpdate({ color: swatch.color })}
                className={`size-5 rounded-full border p-0 hover:bg-transparent ${active ? 'ring-2 ring-foreground ring-offset-1 ring-offset-background' : 'border-black/20'}`}
                style={{ backgroundColor: swatch.color }}
              />
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Tip &amp; thickness</span>
        <div className="flex gap-1">
          {presets.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={Math.abs(widthMm - p.widthMm) < 0.3 ? 'secondary' : 'outline'}
              className="h-7 flex-1 text-[11px]"
              disabled={!canEdit}
              onClick={() => onUpdate({ widthMm: p.widthMm })}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {spec.smartShape && (
        <div className="text-[11px] text-muted-foreground">
          Smart shape: <span className="font-medium text-foreground">{spec.smartShape}</span>
        </div>
      )}

      <Separator />

      <Button
        type="button"
        variant="destructive"
        size="sm"
        className="h-7 text-xs"
        disabled={!canEdit}
        title={!canEdit ? blockedReason : 'Delete this markup stroke'}
        data-testid="markup-delete"
        onClick={onDelete}
      >
        <Trash2 className="mr-1.5 size-3.5" />
        Delete stroke
      </Button>
    </div>
  )
}
