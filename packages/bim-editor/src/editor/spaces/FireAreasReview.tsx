'use client'

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { atLeastWords } from './fire-areas'
import { areaFt2 } from './propose-rooms'
import type { FireAreaControls } from './use-fire-areas'

/**
 * "Fire areas from rated walls": the closed areas the rated walls make on
 * this level, outlined on the plan. Accept adds one as a fire-area zone (one
 * undo step), Accept all adds every one left in one step, Dismiss leaves one
 * out. Close or Esc leaves with nothing more written.
 */
export function FireAreasReview({ fire, editReason, levelName }: { readonly fire: FireAreaControls; readonly editReason: string | null; readonly levelName: string | null }) {
  const [refused, setRefused] = useState<string | null>(null)
  const s = fire.state
  if (s.kind === 'idle') return null
  const kind = fire.kinds.find((k) => k.id === fire.pick?.kindId) ?? null
  const levels = kind?.levels ?? []

  const picker =
    kind && fire.pick ? (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Walls rated</span>
        {fire.kinds.length > 1 ? (
          <Select value={kind.id} onValueChange={(kindId) => fire.setPick({ kindId, atLeast: fire.kinds.find((k) => k.id === kindId)?.levels?.[0] ?? 1 })}>
            <SelectTrigger size="sm" className="h-7 w-40" aria-label="Rating" data-testid="fire-areas-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {fire.kinds.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span>({kind.label})</span>
        )}
        {levels.length > 0 ? (
          <Select value={String(fire.pick.atLeast)} onValueChange={(v) => fire.pick && fire.setPick({ kindId: fire.pick.kindId, atLeast: Number(v) })}>
            <SelectTrigger size="sm" className="h-7 w-36" aria-label="At least" data-testid="fire-areas-at-least">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {levels.map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {atLeastWords(kind, v)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span>{atLeastWords(kind, fire.pick.atLeast)}</span>
        )}
      </div>
    ) : null

  if (s.kind === 'loading')
    return (
      <div className="flex items-center gap-2 text-sm" role="status" data-testid="fire-areas-loading">
        <Spinner />
        Finding the closed rated areas on {levelName ?? 'this level'}…
      </div>
    )
  if (s.kind === 'error' || s.kind === 'empty')
    return (
      <Alert variant={s.kind === 'error' ? 'destructive' : 'default'} data-testid={s.kind === 'error' ? 'fire-areas-error' : 'fire-areas-empty'}>
        <AlertTitle>{s.kind === 'error' ? 'Fire areas couldn’t be found' : 'No fire areas to add'}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{s.message}</span>
          {picker}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={fire.start} disabled={fire.reason !== null} title={fire.reason ?? undefined}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={fire.close} data-testid="fire-areas-close">
              Close
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    )

  const pending = s.rows.filter((r) => r.decision === 'pending').length
  const allReason = editReason ?? (pending === 0 ? 'Every fire area here is already added or dismissed.' : null)
  const act = (why: string | null) => setRefused(why)
  return (
    <section className="flex flex-col gap-2 rounded border p-2" aria-label="Fire areas from rated walls" data-testid="fire-areas-review">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">
          {s.rows.length} {s.rows.length === 1 ? 'fire area' : 'fire areas'} closed by rated walls on {levelName ?? 'this level'}
        </h3>
        <p className="text-xs text-muted-foreground">
          Outlined on the plan. Each Accept adds a fire-area zone you can Undo; Esc or Close leaves the rest.{s.alreadyZones > 0 ? ` ${s.alreadyZones} more already have a fire-area zone.` : ''}
        </p>
        {picker}
      </div>
      {refused ? (
        <Alert variant="destructive" data-testid="fire-areas-refused">
          <AlertDescription>{refused}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup className="max-h-64 overflow-auto">
        {s.rows.map((r, i) => {
          const acceptReason = r.decision === 'added' ? 'Added: it is in the zones list below.' : r.decision === 'dismissed' ? 'Dismissed: press Dismissed to bring it back.' : editReason
          return (
            <Item key={r.proposal.key} size="sm" variant="outline" data-testid="fire-area-proposal" data-area={r.proposal.key} data-decision={r.decision}>
              <ItemContent>
                <ItemTitle>
                  Fire area {i + 1}
                  {r.decision === 'added' ? <Badge variant="secondary">Added</Badge> : r.decision === 'dismissed' ? <Badge variant="outline">Dismissed</Badge> : null}
                </ItemTitle>
                <ItemDescription>
                  {areaFt2(r.proposal).toLocaleString('en-US')} sq ft · closed by {r.proposal.elementIds.length} rated {r.proposal.elementIds.length === 1 ? 'wall' : 'walls'}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" onClick={() => act(fire.accept(r.proposal.key))} disabled={acceptReason !== null} title={acceptReason ?? 'Adds it as a fire-area zone; Undo takes it back'} aria-label={`Accept fire area ${i + 1}`} data-testid="fire-area-accept">
                  <Check data-icon="inline-start" />
                  Accept
                </Button>
                <Button size="sm" variant={r.decision === 'dismissed' ? 'secondary' : 'ghost'} aria-pressed={r.decision === 'dismissed'} onClick={() => fire.dismiss(r.proposal.key)} disabled={r.decision === 'added'} title={r.decision === 'added' ? 'Added: Undo takes it back.' : undefined} aria-label={`Dismiss fire area ${i + 1}`} data-testid="fire-area-dismiss">
                  <X data-icon="inline-start" />
                  {r.decision === 'dismissed' ? 'Dismissed' : 'Dismiss'}
                </Button>
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => act(fire.acceptAll())} disabled={allReason !== null} title={allReason ?? 'Adds every fire area not added or dismissed, in one step; Undo takes them all back'} data-testid="fire-areas-accept-all">
          Accept all
        </Button>
        <Button size="sm" variant="ghost" onClick={fire.close} data-testid="fire-areas-close">
          Close (Esc)
        </Button>
      </div>
    </section>
  )
}
