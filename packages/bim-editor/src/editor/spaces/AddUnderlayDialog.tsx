'use client'

import { useEffect, useState } from 'react'
import { FileImage, FileText, FileX } from 'lucide-react'
import type { Command, ElementId } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../../ui/item'
import { Skeleton } from '../../ui/skeleton'
import type { UnderlayCandidate } from '../../contracts/bim/underlays/formats'
import { newElementId } from '../placement'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { underlayPageInfoFrom, useUnderlayCandidatesFrom } from './use-underlays'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly projectId: string
  /** The level it goes on (the plan the person is on). */
  readonly levelId: ElementId | null
  readonly levelName: string | null
  readonly submit: (command: Command, undoLabel: string) => string | null
  /** Placed: open calibration for it next. */
  readonly onPlaced: (underlayId: ElementId) => void
}

/**
 * Add underlay (F3): pick a PDF page or picture from the project's workspace
 * and place it on the current level, so spaces can be traced over it. CAD
 * files are listed with why they can't be placed yet (export to PDF).
 */
export function AddUnderlayDialog({ open, onOpenChange, projectId, levelId, levelName, submit, onPlaced }: Props) {
  const underlays = useEditorHost().data.underlays
  const { files } = useUnderlayCandidatesFrom(underlays, projectId, open)
  const [picked, setPicked] = useState<UnderlayCandidate | null>(null)
  const [page, setPage] = useState('1')
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setPicked(null)
      setPage('1')
      setPageCount(null)
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!picked || picked.format !== 'pdf') {
      setPageCount(picked ? 1 : null)
      return
    }
    let live = true
    setPageCount(null)
    underlayPageInfoFrom(underlays, projectId, picked.fileId, 1)
      .then((info) => live && setPageCount(info.pageCount))
      .catch((err: unknown) => {
        console.error('[AddUnderlayDialog] reading the PDF failed', { fileId: picked.fileId, err })
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [underlays, projectId, picked])

  const pageNo = Number.parseInt(page, 10)
  const pageProblem = picked?.format === 'pdf' && pageCount !== null && (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pageCount) ? `Pick a page from 1 to ${pageCount}.` : null
  const placeReason = !levelId ? 'Open a floor plan first: the drawing goes on that plan’s level.' : !picked ? 'Pick a drawing first.' : pageProblem ?? (picked.format === 'pdf' && pageCount === null && !error ? 'Reading the PDF…' : null)

  const place = async () => {
    if (!picked || !levelId || placeReason) return
    setBusy(true)
    try {
      const info = await underlayPageInfoFrom(underlays, projectId, picked.fileId, picked.format === 'pdf' ? pageNo : 1)
      const underlayId = newElementId('underlay') as ElementId
      const refused = submit(
        {
          type: 'place_underlay',
          underlayId,
          levelId,
          // oss-clean: legacy-host-id: the underlay source id stored on models today; a host-supplied id replaces this in a later change.
          source: { format: info.format, provider: 'polygnotos.workspace', ref: picked.fileId, ...(info.format === 'pdf' ? { page: info.page } : {}), name: picked.name },
          opacityPct: 50,
        },
        'Add underlay',
      )
      if (refused) {
        setError(refused)
        return
      }
      onOpenChange(false)
      onPlaced(underlayId)
    } catch (err) {
      console.error('[AddUnderlayDialog] placing the drawing failed', { fileId: picked.fileId, err })
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-underlay-dialog">
        <DialogHeader>
          <DialogTitle>Add a drawing to trace over</DialogTitle>
          <DialogDescription>
            Pick an architect’s PDF or a picture from this project’s workspace. It goes under {levelName ?? 'the current plan'}; set its scale next, then trace spaces over it.
          </DialogDescription>
        </DialogHeader>
        {files.state === 'loading' ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">Loading the project’s drawings</span>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : files.state === 'error' ? (
          <Alert variant="destructive">
            <AlertTitle>The drawings didn’t load</AlertTitle>
            <AlertDescription>{files.message}</AlertDescription>
          </Alert>
        ) : files.value.length === 0 ? (
          <Empty className="border" data-testid="add-underlay-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>No drawings in this project yet</EmptyTitle>
              <EmptyDescription>Upload the architect’s PDF to the project’s Workspace (project menu › Workspace), then come back here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="max-h-72 overflow-auto" role="listbox" aria-label="Drawings">
            {files.value.map((f) => (
              <Item
                key={f.fileId}
                variant={picked?.fileId === f.fileId ? 'outline' : 'default'}
                size="sm"
                role="option"
                aria-selected={picked?.fileId === f.fileId}
                aria-disabled={f.unsupportedReason !== null}
                data-testid="add-underlay-file"
                data-file={f.fileId}
                onClick={() => {
                  if (f.unsupportedReason) return
                  setPicked(f)
                  setError(null)
                  setPage('1')
                }}
                className={f.unsupportedReason ? 'opacity-70' : 'cursor-pointer'}
              >
                <ItemMedia variant="icon">{f.unsupportedReason ? <FileX /> : f.format === 'image' ? <FileImage /> : <FileText />}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{f.name}</ItemTitle>
                  <ItemDescription>{f.unsupportedReason ?? (f.format === 'pdf' ? 'PDF' : 'Picture')}</ItemDescription>
                </ItemContent>
                {picked?.fileId === f.fileId ? <ItemActions className="text-xs text-muted-foreground">Picked</ItemActions> : null}
              </Item>
            ))}
          </ItemGroup>
        )}
        {picked?.format === 'pdf' ? (
          <Field>
            <FieldLabel htmlFor="underlay-page">Page</FieldLabel>
            <Input id="underlay-page" inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value)} className="w-24" data-testid="add-underlay-page" />
            <FieldDescription>{pageCount === null ? 'Reading the PDF…' : `This PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`}</FieldDescription>
          </Field>
        ) : null}
        {error ? (
          <Alert variant="destructive" data-testid="add-underlay-error">
            <AlertTitle>That drawing can’t be placed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void place()} disabled={placeReason !== null || busy} title={placeReason ?? undefined} data-testid="add-underlay-place">
            {busy ? 'Placing…' : 'Place under the plan'}
          </Button>
        </DialogFooter>
        {placeReason && picked ? <p className="text-xs text-muted-foreground">{placeReason}</p> : null}
      </DialogContent>
    </Dialog>
  )
}
