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
import { fetchLibraryPartTypesFrom, publishPartTypeFrom } from './part-type-library'

type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly current: number | null }
  | { readonly kind: 'saving'; readonly current: number | null }
  | { readonly kind: 'failed'; readonly message: string; readonly current: number | null }

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly definition: PartTypeDefinition
  readonly partName: string
  readonly sizesText: string
  /** Keeps Place part's firm list current (the older firm parts store); resolves to its refusal or null. */
  readonly alsoSaveForPlacePart?: (definition: PartTypeDefinition) => Promise<string | null>
  /** The outcome in words, for the editor's status line. */
  readonly onDone: (message: { readonly ok: boolean; readonly text: string }) => void
}

/**
 * Part editor › Publish…: the part, every size, as the next revision of its
 * firm library part type. Placed copies of older revisions then offer
 * "A newer version is in the library" › Review update in the projects that
 * use them. Esc or Cancel leaves everything as it was.
 */
export function PublishPartDialog({ open, onOpenChange, definition, partName, sizesText, alsoSaveForPlacePart, onDone }: Props) {
  const library = useEditorHost().data.firmLibrary
  const [stage, setStage] = useState<Stage>({ kind: 'checking' })
  const modelId = definition.model?.id ?? null

  useEffect(() => {
    if (!open) return
    let live = true
    fetchLibraryPartTypesFrom(library)
      .then(({ partTypes }) => {
        if (!live) return
        const found = modelId ? partTypes.find((p) => p.id === drawnPartItemId(modelId)) : undefined
        setStage({ kind: 'ready', current: found?.revision ?? null })
      })
      .catch((err: unknown) => {
        console.error('[part-editor] reading the firm library before publish failed', err)
        if (live) setStage({ kind: 'failed', message: `The firm library didn't answer: ${err instanceof Error ? err.message : 'the connection dropped'}. Close and try again.`, current: null })
      })
    return () => {
      live = false
    }
  }, [library, open, modelId])

  const current = stage.kind === 'checking' ? null : stage.current
  const publish = async () => {
    setStage({ kind: 'saving', current })
    try {
      const answer = await publishPartTypeFrom(library, definition)
      if (!answer.ok) {
        setStage({ kind: 'failed', message: `Not published: ${answer.message}`, current })
        return
      }
      const placeRefused = alsoSaveForPlacePart ? await alsoSaveForPlacePart(definition) : null
      const text = answer.upToDate ? `${partName} is already revision ${answer.revision} in the firm library; nothing changed.` : `Published ${partName} as revision ${answer.revision} in the firm library (${sizesText}).`
      onDone(placeRefused ? { ok: false, text: `${text} Place part's list wasn't updated: ${placeRefused}` } : { ok: true, text })
      onOpenChange(false)
    } catch (err) {
      console.error('[part-editor] publish failed', err)
      setStage({ kind: 'failed', message: `Not published: ${err instanceof Error ? err.message : 'the connection dropped'}. Nothing changed; try again.`, current })
    }
  }

  const next = (current ?? 0) + 1
  return (
    <Dialog open={open} onOpenChange={(o) => stage.kind !== 'saving' && onOpenChange(o)}>
      <DialogContent data-testid="pe-publish-dialog">
        <DialogHeader>
          <DialogTitle>Publish {partName}</DialogTitle>
          <DialogDescription>
            {stage.kind === 'checking' ? 'Checking the firm library…' : current === null ? `New in the firm library: revision 1 (${sizesText}).` : `Revision ${current} is in the firm library. This publishes revision ${next} (${sizesText}); projects with copies of revision ${current} are offered the update and choose for themselves.`}
          </DialogDescription>
        </DialogHeader>
        {stage.kind === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>Not published</AlertTitle>
            <AlertDescription>{stage.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={stage.kind === 'saving'}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => void publish()} disabled={stage.kind === 'checking' || stage.kind === 'saving'} data-testid="pe-publish-confirm">
            {stage.kind === 'saving' ? <Spinner data-icon="inline-start" /> : <Library data-icon="inline-start" />}
            {stage.kind === 'saving' ? 'Saving…' : `Publish revision ${next}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
