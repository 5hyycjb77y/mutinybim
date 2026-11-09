'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, CheckCheck, CircleAlert, CircleCheck, Crosshair, X } from 'lucide-react'
import type { ModelState } from '@permitzip/bim-kernel'
import { acceptCleanoutsCommand, CLEANOUT_PROPOSAL_WORDS as W, proposeCleanouts, type CleanoutGhost } from '@permitzip/bim-pack-plumbing'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import type { ProposalGhost } from '../model-session'
import type { SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly model: ModelState
  /** The selected pipes the proposal reads its line from. */
  readonly drainIds: readonly string[]
  /** Null when this person may edit; otherwise why not, in words. */
  readonly editBlocked: string | null
  /** Null when the model server takes a part put in a pipe; otherwise why Approve is off. */
  readonly insertBlocked: string | null
  readonly submit: SubmitCommand
  readonly select: (ids: readonly string[]) => void
  readonly previewParts: (ghosts: readonly ProposalGhost[] | null) => void
  readonly onClose: () => void
}

const toPreview = (g: CleanoutGhost): ProposalGhost => ({ typeId: g.typeId, definition: g.partType, levelId: g.levelId ?? '', position: g.position, offsetMm: g.heightMm, rotationDeg: g.rotationDeg })

/**
 * Systems › Propose cleanouts: the proposal as ghosts on the plan and a list
 * beside it. Each can be approved, selected or dismissed; Approve all puts
 * every kept one in the pipe as one undo step. Esc or Close clears the ghosts
 * and places nothing.
 */
export function ProposeCleanoutsPanel({ model, drainIds, editBlocked, insertBlocked, submit, select, previewParts, onClose }: Props) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState(0)

  const answer = useMemo(() => proposeCleanouts(model, { roomIds: drainIds }), [model, drainIds])
  const refused = 'refused' in answer ? answer.refused : null
  const kept = useMemo(() => ('refused' in answer ? [] : answer.ghosts.filter((g) => !dismissed.has(`${g.segmentId}@${Math.round(g.atMm)}`))), [answer, dismissed])

  useEffect(() => {
    previewParts(kept.length > 0 ? kept.map(toPreview) : null)
  }, [kept, previewParts])
  useEffect(() => () => previewParts(null), [previewParts])
  useEffect(() => {
    // An open list, menu or dialog keeps its own Esc.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof Element && e.target.closest('[role="listbox"], [role="menu"], [role="dialog"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const approveBlocked = editBlocked ?? insertBlocked
  const approve = (ghosts: readonly CleanoutGhost[]) => {
    setError(null)
    const command = acceptCleanoutsCommand(model, ghosts)
    if (typeof command === 'string') return setError(command)
    const refusal = submit(command, W.undo)
    if (refusal) return setError(refusal)
    setPlaced((n) => n + ghosts.length)
  }
  const dismiss = (g: CleanoutGhost) => setDismissed((d) => new Set([...d, `${g.segmentId}@${Math.round(g.atMm)}`]))

  return (
    <Card className="pointer-events-auto fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] gap-3 py-4" role="region" aria-label={W.title} data-testid="propose-cleanouts-panel">
      <CardHeader className="px-4">
        <CardTitle>{W.title}</CardTitle>
        <CardDescription>{refused ?? ('refused' in answer ? '' : answer.summary)}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label={W.close} onClick={onClose} data-testid="propose-cleanouts-close">
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex max-h-80 flex-col gap-3 overflow-y-auto px-4">
        {refused ? (
          <Alert>
            <CircleAlert />
            <AlertDescription>{refused}</AlertDescription>
          </Alert>
        ) : kept.length === 0 ? (
          <Empty className="border py-6" data-testid="propose-cleanouts-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleCheck />
              </EmptyMedia>
              <EmptyDescription>{placed > 0 ? `Placed ${placed}. ${W.none}` : W.none}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup data-testid="propose-cleanouts-list">
            {kept.map((g) => (
              <Item key={g.key} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>{g.reason}</ItemTitle>
                  <ItemDescription>{g.partType.familyName} {g.partType.typeName}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="ghost" onClick={() => select([g.segmentId])} aria-label={`${W.select}: ${g.reason}`}>
                    <Crosshair />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => dismiss(g)} aria-label={`${W.dismiss}: ${g.reason}`}>
                    <X />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => approve([g])} disabled={approveBlocked !== null} title={approveBlocked ?? undefined}>
                    <Check />
                    {W.approve}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>That didn&apos;t go through</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {approveBlocked && kept.length > 0 && <p className="text-muted-foreground text-xs">{approveBlocked}</p>}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 px-4">
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            {W.close}
          </Button>
          <Button className="flex-1" onClick={() => approve(kept)} disabled={approveBlocked !== null || kept.length === 0} title={approveBlocked ?? (kept.length === 0 ? W.none : undefined)} data-testid="propose-cleanouts-approve-all">
            <CheckCheck />
            {W.approveAll}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{W.escHint}</p>
      </CardFooter>
    </Card>
  )
}
