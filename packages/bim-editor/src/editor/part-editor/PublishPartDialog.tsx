'use client'

import { useEffect, useState } from 'react'
import { Library } from 'lucide-react'
import type { PartTypeDefinition } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Spinner } from '../../ui/spinner'
import { drawnPartItemId } from '../../contracts/bim/firm-part-versions'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { newElementId } from '../placement'
import { fetchLibraryPartTypesFrom, publishPartTypeFrom } from './part-type-library'

type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready' | 'saving'; readonly current: number }
  | { readonly kind: 'unconfirmed'; readonly request: { definition: PartTypeDefinition; baseRevision: number; requestId: string }; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly definition: PartTypeDefinition
  /** The catalog revision seen by the editor when the draft was opened. */
  readonly baseRevision?: number
  readonly partName: string
  readonly sizesText: string
  /** Refreshes Place part after publication, including the copy required by older hosts. */
  readonly alsoSaveForPlacePart?: (definition: PartTypeDefinition) => Promise<string | null>
  /** The outcome in words, for the editor's status line. */
  readonly onDone: (message: { readonly ok: boolean; readonly text: string; readonly revision: number }) => void
}

/**
 * Part editor › Publish…: the part, every size, as the next revision of its
 * firm library part type. Placed copies of older revisions then offer
 * "A newer version is in the library" › Review update in the projects that
 * use them. Esc or Cancel leaves everything as it was.
 */
export function PublishPartDialog({ open, onOpenChange, definition, baseRevision, partName, sizesText, alsoSaveForPlacePart, onDone }: Props) {
  const library = useEditorHost().data.firmLibrary
  const [stage, setStage] = useState<Stage>({ kind: 'checking' })
  const modelId = definition.model?.id ?? null

  useEffect(() => {
    if (!open) return
    let live = true
    setStage({ kind: 'checking' })
    fetchLibraryPartTypesFrom(library)
      .then(({ partTypes, canPublish }) => {
        if (!live) return
        if (!canPublish) {
          setStage({ kind: 'failed', message: 'This firm library is read-only.' })
          return
        }
        const found = modelId ? partTypes.find((p) => p.id === drawnPartItemId(modelId)) : undefined
        const current = found?.revision ?? 0
        if (library?.publishPartTypeAtRevision && baseRevision !== undefined && baseRevision !== current) {
          const opened = baseRevision === 0 ? 'This draft started as a new library part.' : `You opened this part at revision ${baseRevision}.`
          const reason = current === 0 ? 'The part is no longer in the library.' : `The library is now at revision ${current}.`
          setStage({ kind: 'failed', message: `${opened} ${reason} Review the catalog before publishing again.` })
          return
        }
        setStage({ kind: 'ready', current })
      })
      .catch((err: unknown) => {
        console.error('[part-editor] reading the firm library before publish failed', err)
        if (live) setStage({ kind: 'failed', message: `Couldn’t check the library revision. ${err instanceof Error ? err.message : 'Close and reopen Publish to try again.'}` })
      })
    return () => {
      live = false
    }
  }, [library, open, modelId, baseRevision])

  const current = stage.kind === 'ready' || stage.kind === 'saving' ? stage.current : null
  const publish = async () => {
    if (stage.kind !== 'ready' && stage.kind !== 'unconfirmed') return
    const request = stage.kind === 'unconfirmed' ? stage.request : {
      definition, baseRevision: stage.current, requestId: newElementId('publish'),
    }
    setStage({ kind: 'saving', current: request.baseRevision })
    let answer
    try {
      answer = await publishPartTypeFrom(library, request.definition, request.baseRevision, request.requestId)
    } catch (err) {
      console.error('[part-editor] publish failed', err)
      setStage(library?.publishPartTypeAtRevision
        ? { kind: 'unconfirmed', request, message: `The library did not confirm the save. Retry this same publish to recover its receipt. ${err instanceof Error ? err.message : ''}`.trim() }
        : { kind: 'failed', message: 'The library did not confirm the save. Close and reopen Publish to check the current revision.' })
      return
    }
    if (!answer.ok) {
      setStage({ kind: 'failed', message: answer.message })
      return
    }
    const text = answer.upToDate ? `${partName} is already revision ${answer.revision} in the firm library.` : `Published ${partName} as revision ${answer.revision} in the firm library (${sizesText}).`
    let placeRefused
    try {
      placeRefused = await alsoSaveForPlacePart?.(request.definition)
    } catch (err) {
      placeRefused = err instanceof Error ? err.message : 'The library did not answer.'
    }
    onDone({ ok: !placeRefused, text: placeRefused ? `${text} Place part could not refresh its list. ${placeRefused}` : text, revision: answer.revision })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => stage.kind !== 'saving' && onOpenChange(o)}>
      <DialogContent data-testid="pe-publish-dialog">
        <DialogHeader>
          <DialogTitle>Publish {partName}</DialogTitle>
          <DialogDescription>
            {stage.kind === 'checking' ? 'Checking the firm library…' : stage.kind === 'unconfirmed' ? 'Your original edit and its publish ID are ready to retry.' : current === null ? 'Close this dialog to return to your part.' : current === 0 ? `Publish ${sizesText} as the first revision in the firm library.` : `The library has revision ${current}. Publish ${sizesText} as revision ${current + 1}. Projects using this part can review the update.`}
          </DialogDescription>
        </DialogHeader>
        {(stage.kind === 'failed' || stage.kind === 'unconfirmed') && (
          <Alert variant="destructive">
            <AlertTitle>{stage.kind === 'unconfirmed' ? 'Publish unconfirmed' : 'Publish unavailable'}</AlertTitle>
            <AlertDescription>{stage.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={stage.kind === 'saving'}>
              {stage.kind === 'unconfirmed' ? 'Close' : 'Cancel'}
            </Button>
          </DialogClose>
          <Button onClick={() => void publish()} disabled={stage.kind !== 'ready' && stage.kind !== 'unconfirmed'} data-testid="pe-publish-confirm">
            {stage.kind === 'saving' ? <Spinner data-icon="inline-start" /> : <Library data-icon="inline-start" />}
            {stage.kind === 'saving' ? 'Saving…' : stage.kind === 'unconfirmed' ? 'Retry publish' : current === null ? 'Publish' : `Publish revision ${current + 1}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
