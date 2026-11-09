'use client'

import { useMemo, useState } from 'react'
import { ChartLine, ImagePlus } from 'lucide-react'
import { SHEET_IMAGE_MIMES, chartKinds, evaluateFigure, sheetPaper, type ModelState, type Sheet, type SheetFigureSpec, type Vec2 } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { newId, type SubmitCommand } from './types'
import type { SheetImages } from './use-sheet-images'

// Chart kinds are registered when the Building Model installs its add-ons (`lib/building-model/add-ons.ts`).

const CHART_SIZE: Vec2 = { x: 200, y: 140 }
const PICTURE_WIDTH = 120

const isMime = (v: string): v is (typeof SHEET_IMAGE_MIMES)[number] => SHEET_IMAGE_MIMES.some((m) => m === v)

/** The frame for a figure of `size`, centred on the sheet inside its border. */
export function centredFrame(paper: Vec2, size: Vec2): [Vec2, Vec2] {
  const w = Math.min(size.x, paper.x - 60)
  const h = Math.min(size.y, paper.y - 60)
  const x = Math.round((paper.x - w) / 2)
  const y = Math.round((paper.y - h) / 2)
  return [{ x, y }, { x: x + Math.round(w), y: y + Math.round(h) }]
}

function pictureSize(file: File): Promise<Vec2> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const ratio = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.75
      resolve({ x: PICTURE_WIDTH, y: Math.max(10, Math.round(PICTURE_WIDTH * ratio)) })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      console.error('[SheetFigureDialog] reading the picture size failed; using 4:3', { name: file.name })
      resolve({ x: PICTURE_WIDTH, y: PICTURE_WIDTH * 0.75 })
    }
    img.src = url
  })
}

/**
 * Sheets › Chart or Picture: put a live chart (the Hunter curve first) or a
 * picture on the open sheet. It lands centred as one edit; drag it to move,
 * drag its corners to resize, Ctrl+Z takes it off. A picture is uploaded to
 * the project's workspace first, so it is kept, shared and permissioned
 * like any other project file.
 */
export function SheetFigureDialog({ mode, sheet, model, images, submit, onClose, onPlaced }: { mode: 'chart' | 'picture'; sheet: Sheet; model: ModelState; images: SheetImages; submit: SubmitCommand; onClose: () => void; onPlaced: (itemId: string) => void }) {
  const kinds = chartKinds()
  const [chart, setChart] = useState(kinds[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useMemo(() => (mode === 'chart' && chart ? evaluateFigure(model, { kind: 'chart', chart }) : null), [mode, chart, model])
  const paper = sheetPaper(sheet)
  const fileProblem = mode === 'picture' && file && !isMime(file.type) ? `${file.name} is not a PNG or JPEG picture; sheets print those two.` : null
  const blocked = mode === 'chart' ? (chart ? null : 'This MutinyBIM has no charts to place.') : !file ? 'Choose a PNG or JPEG picture first.' : fileProblem

  const place = async (e: React.FormEvent) => {
    e.preventDefault()
    if (blocked) return
    setError(null)
    let figure: SheetFigureSpec
    let size = CHART_SIZE
    if (mode === 'chart') figure = { kind: 'chart', chart, ...(title.trim() ? { title: title.trim() } : {}) }
    else {
      if (!file || !isMime(file.type)) return
      setBusy(true)
      const uploaded = await images.upload(file)
      if ('error' in uploaded) {
        setBusy(false)
        setError(uploaded.error)
        return
      }
      size = await pictureSize(file)
      setBusy(false)
      figure = { kind: 'image', image: { fileId: uploaded.fileId, name: file.name.slice(0, 200), mime: file.type } }
    }
    const itemId = newId('fig')
    const refusal = submit({ type: 'add_drawing_item', itemId, ownerId: sheet.id, shape: 'figure', points: centredFrame(paper, size), figure }, mode === 'chart' ? 'place a chart' : 'place a picture')
    if (refusal) {
      setError(refusal)
      return
    }
    onPlaced(itemId)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="sheet-figure-dialog">
        <form onSubmit={(e) => void place(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{mode === 'chart' ? 'Place a chart' : 'Place a picture'}</DialogTitle>
            <DialogDescription>
              {mode === 'chart' ? `On ${sheet.number}, drawn live from the model every time the sheet shows or prints.` : `On ${sheet.number}. The picture is saved to this project's workspace and printed in the PDF.`} It lands in the middle of the sheet: drag it to move, drag a corner to resize, Ctrl+Z takes it off.
            </DialogDescription>
          </DialogHeader>
          {mode === 'chart' ? (
            <>
              <Field>
                <FieldLabel htmlFor="bm-figure-chart">Chart</FieldLabel>
                <Select value={chart} onValueChange={setChart}>
                  <SelectTrigger id="bm-figure-chart" data-testid="sheet-figure-chart">
                    <SelectValue placeholder="Pick a chart" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {kinds.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {preview && 'reason' in preview ? <FieldDescription className="text-warning-700">{preview.reason}; it will say so on the sheet until the model has what it needs.</FieldDescription> : preview ? <FieldDescription data-testid="sheet-figure-chart-summary">{preview.markers.length > 0 ? `Marks ${preview.markers.map((m) => m.label).join('; ')}` : 'No design points yet: it shows the curves alone until a system is drawn.'}</FieldDescription> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="bm-figure-title">Title (optional)</FieldLabel>
                <Input id="bm-figure-title" maxLength={160} placeholder={preview && !('reason' in preview) ? preview.title : ''} value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel htmlFor="bm-figure-file">Picture (PNG or JPEG)</FieldLabel>
              <Input id="bm-figure-file" type="file" accept={SHEET_IMAGE_MIMES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="sheet-figure-file" />
              {fileProblem && <FieldDescription className="text-danger-600">{fileProblem}</FieldDescription>}
            </Field>
          )}
          {error && (
            <FieldDescription className="text-danger-600" role="alert" data-testid="sheet-figure-error">
              {error}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={blocked !== null || busy} title={blocked ?? undefined} data-testid="sheet-figure-place">
              {busy ? <Spinner data-icon="inline-start" /> : mode === 'chart' ? <ChartLine data-icon="inline-start" /> : <ImagePlus data-icon="inline-start" />}
              {busy ? 'Uploading…' : 'Place on the sheet'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
