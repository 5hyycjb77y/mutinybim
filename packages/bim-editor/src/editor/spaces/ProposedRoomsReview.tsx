'use client'

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Spinner } from '../../ui/spinner'
import { areaFt2 } from './propose-rooms'
import type { ProposeControls } from './use-spaces-tool'

/**
 * The rooms "Propose rooms from this drawing" found, for the engineer to
 * accept or reject one by one (or Accept all). Nothing is in the model until
 * "Add … rooms": then the accepted ones become spaces in one undoable step.
 * Cancel or Esc leaves with nothing written. Loading, nothing found and
 * failures each say so.
 */
export function ProposedRoomsReview({ propose, editReason }: { readonly propose: ProposeControls; readonly editReason: string | null }) {
  const [refused, setRefused] = useState<string | null>(null)
  const s = propose.state
  if (s.kind === 'idle') return null
  if (s.kind === 'loading')
    return (
      <div className="flex items-center gap-2 text-sm" role="status" data-testid="spaces-propose-loading">
        <Spinner />
        Reading the lines on {s.drawing}…
      </div>
    )
  if (s.kind === 'error' || s.kind === 'empty')
    return (
      <Alert variant={s.kind === 'error' ? 'destructive' : 'default'} data-testid={s.kind === 'error' ? 'spaces-propose-error' : 'spaces-propose-empty'}>
        <AlertTitle>{s.kind === 'error' ? 'Rooms couldn’t be proposed' : 'No rooms to propose'}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{s.message}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={propose.start} disabled={propose.reason !== null}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={propose.cancel}>
              Close
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    )

  const accepted = s.proposals.filter((p) => p.decision === 'accepted').length
  const pending = s.proposals.filter((p) => p.decision === 'pending').length
  const addReason = editReason ?? (accepted === 0 ? 'Accept at least one room first.' : null)
  const add = () => {
    const why = propose.commit()
    setRefused(why)
  }
  return (
    <section className="flex flex-col gap-2 rounded border p-2" aria-label="Proposed rooms" data-testid="spaces-propose-review">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">
          {s.proposals.length} {s.proposals.length === 1 ? 'room' : 'rooms'} proposed from {s.drawing}
        </h3>
        <p className="text-xs text-muted-foreground">
          Dashed on the plan. Nothing is saved until you add them; Esc or Cancel leaves nothing behind.{s.alreadySpaces > 0 ? ` ${s.alreadySpaces} more already have a space.` : ''}
        </p>
      </div>
      {refused ? (
        <Alert variant="destructive" data-testid="spaces-propose-refused">
          <AlertDescription>{refused}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup className="max-h-64 overflow-auto">
        {s.proposals.map((p, i) => (
          <Item key={p.room.key} size="sm" variant="outline" data-testid="spaces-proposal" data-room={p.room.key} data-decision={p.decision}>
            <ItemContent>
              <ItemTitle>
                Room {i + 1}
                {p.decision === 'accepted' ? <Badge variant="secondary">Accepted</Badge> : p.decision === 'rejected' ? <Badge variant="outline">Rejected</Badge> : null}
              </ItemTitle>
              <ItemDescription>
                {areaFt2(p.room).toLocaleString('en-US')} sq ft · {p.room.openings.length === 0 ? 'no openings' : `${p.room.openings.length} ${p.room.openings.length === 1 ? 'opening' : 'openings'} kept`} · {Math.round(p.room.confidence * 100)}% along drawn lines
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant={p.decision === 'accepted' ? 'default' : 'outline'} aria-pressed={p.decision === 'accepted'} aria-label={`Accept room ${i + 1}`} onClick={() => propose.decide(p.room.key, p.decision === 'accepted' ? 'pending' : 'accepted')} data-testid="spaces-proposal-accept">
                <Check data-icon="inline-start" />
                Accept
              </Button>
              <Button size="sm" variant={p.decision === 'rejected' ? 'secondary' : 'ghost'} aria-pressed={p.decision === 'rejected'} aria-label={`Reject room ${i + 1}`} onClick={() => propose.decide(p.room.key, p.decision === 'rejected' ? 'pending' : 'rejected')} data-testid="spaces-proposal-reject">
                <X data-icon="inline-start" />
                Reject
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={propose.acceptAll} disabled={pending === 0} title={pending === 0 ? 'Every room is already accepted or rejected.' : 'Accept every room you haven’t rejected'} data-testid="spaces-propose-accept-all">
          Accept all
        </Button>
        <Button size="sm" onClick={add} disabled={addReason !== null} title={addReason ?? 'Adds the accepted rooms as spaces in one step; Undo takes them all back'} data-testid="spaces-propose-add">
          Add {accepted} accepted {accepted === 1 ? 'room' : 'rooms'}
        </Button>
        <Button size="sm" variant="ghost" onClick={propose.cancel} data-testid="spaces-propose-cancel">
          Cancel (Esc)
        </Button>
      </div>
    </section>
  )
}
