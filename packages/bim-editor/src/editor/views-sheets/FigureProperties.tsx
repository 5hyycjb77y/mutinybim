'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { SHEET_IMAGE_MIMES, chartKind, figureFrame, type Command, type DrawingItem } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import type { SheetImages } from './use-sheet-images'

const IN = 25.4
const inches = (mm: number) => String(Math.round((mm / IN) * 100) / 100)
const isMime = (v: string): v is (typeof SHEET_IMAGE_MIMES)[number] => SHEET_IMAGE_MIMES.some((m) => m === v)

/** A number field in inches that saves on Enter or blur, and only a real change. */
function InchField({ id, label, mm, disabled, onSave }: { id: string; label: string; mm: number; disabled: boolean; onSave: (mm: number) => void }) {
  const [draft, setDraft] = useState(inches(mm))
  const commit = () => {
    const v = Number(draft)
    if (!Number.isFinite(v) || v < 0.5 || v > 48) {
      setDraft(inches(mm))
      return
    }
    if (Math.abs(v * IN - mm) > 0.05) onSave(v * IN)
  }
  return (
    <Field className="w-24">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} inputMode="decimal" value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} data-testid={id} />
    </Field>
  )
}

/**
 * Properties of a chart or picture on a sheet: what it shows, its size in
 * inches (the corners drag too), the chart's title, a new picture in the
 * same frame. Every change is one update_drawing_item, one undo.
 */
export function FigureProperties({ item, canEdit, blockedReason, images, send, onDelete }: { item: DrawingItem; canEdit: boolean; blockedReason: string; images: SheetImages | null; send: (command: Command, label: string) => boolean; onDelete: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const frame = figureFrame(item.points)
  const figure = item.figure
  if (!frame || !figure) return null
  const w = frame.max.x - frame.min.x
  const h = frame.max.y - frame.min.y
  const resize = (nw: number, nh: number) => send({ type: 'update_drawing_item', itemId: item.id, points: [frame.min, { x: Math.round((frame.min.x + nw) * 10) / 10, y: Math.round((frame.min.y + nh) * 10) / 10 }] }, `resize ${figure.kind === 'image' ? 'picture' : 'chart'}`)
  const replace = async (file: File | undefined) => {
    if (!file || !images) return
    if (!isMime(file.type)) {
      setError(`${file.name} is not a PNG or JPEG picture; sheets print those two.`)
      return
    }
    setBusy(true)
    const uploaded = await images.upload(file)
    setBusy(false)
    if ('error' in uploaded) {
      setError(uploaded.error)
      return
    }
    setError(null)
    send({ type: 'update_drawing_item', itemId: item.id, figure: { kind: 'image', image: { fileId: uploaded.fileId, name: file.name.slice(0, 200), mime: file.type } } }, 'replace the picture')
  }
  const disabled = !canEdit || busy
  const pictureError = figure.kind === 'image' ? images?.errors.get(figure.image.fileId) : undefined
  return (
    <div className="flex flex-col gap-3" data-testid="figure-properties">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{figure.kind === 'chart' ? 'Chart' : 'Picture'}</span>
      <span className="text-sm font-medium">{figure.kind === 'chart' ? (chartKind(figure.chart)?.label ?? figure.chart) : figure.image.name}</span>
      {pictureError && (
        <FieldDescription className="text-danger-600" role="alert">
          {pictureError}. Replace it, or the sheet can&apos;t print.
        </FieldDescription>
      )}
      <div className="flex gap-2">
        <InchField key={`w${w}`} id="figure-width" label='Width (")' mm={w} disabled={disabled} onSave={(v) => resize(v, h)} />
        <InchField key={`h${h}`} id="figure-height" label='Height (")' mm={h} disabled={disabled} onSave={(v) => resize(w, v)} />
      </div>
      {figure.kind === 'chart' ? (
        <Field>
          <FieldLabel htmlFor="figure-title">Title</FieldLabel>
          <Input
            key={figure.title ?? ''}
            id="figure-title"
            defaultValue={figure.title ?? ''}
            placeholder="The chart's own title"
            maxLength={160}
            disabled={disabled}
            onBlur={(e) => {
              const title = e.target.value.trim()
              if (title === (figure.title ?? '')) return
              const { title: _old, ...rest } = figure
              send({ type: 'update_drawing_item', itemId: item.id, figure: title ? { ...rest, title } : rest }, 'retitle the chart')
            }}
            data-testid="figure-title"
          />
          <FieldDescription>Drawn live from the model: it changes as the systems change.</FieldDescription>
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="figure-replace">Replace picture</FieldLabel>
          <Input id="figure-replace" type="file" accept={SHEET_IMAGE_MIMES.join(',')} disabled={disabled || !images} onChange={(e) => void replace(e.target.files?.[0])} />
        </Field>
      )}
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={!canEdit} title={canEdit ? undefined : blockedReason} onClick={onDelete} data-testid="figure-delete">
        <Trash2 data-icon="inline-start" />
        Remove from the sheet
      </Button>
      {busy && <FieldDescription role="status">Uploading the picture…</FieldDescription>}
    </div>
  )
}
