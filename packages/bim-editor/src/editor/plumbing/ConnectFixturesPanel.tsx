'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, CircleX, Crosshair, Link2, X } from 'lucide-react'
import { withUpgradePolicy, type ModelState } from '@permitzip/bim-kernel'
import { FIXTURE_CONNECT_WORDS as W, previewFixtureConnect, type FixtureConnectTarget } from '@permitzip/bim-pack-plumbing'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../ui/card'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '../../ui/item'
import type { SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly model: ModelState
  /** The fixtures selected when Connect was pressed. */
  readonly selectedIds: readonly string[]
  readonly target: FixtureConnectTarget
  /** Null when this person may edit; otherwise why not, in words. */
  readonly editBlocked: string | null
  /** What the model server advertises; the preview is planned as it will decide. Absent: planned with no newer features. */
  readonly serverFeatures?: readonly string[]
  /** Null when the model server connects fixtures into pipes; otherwise why Connect is off. */
  readonly connectBlocked: string | null
  readonly submit: SubmitCommand
  readonly select: (ids: readonly string[]) => void
  readonly onClose: () => void
}

/**
 * Plumbing › Connect › To drain / To vent / To cold water / To hot water:
 * the plan for the selection, one line per connection (the fittings and
 * slope, or why it can't), and one Connect that builds every one that can as
 * a single undo. Nothing changes until Connect; Esc or Cancel closes.
 */
export function ConnectFixturesPanel({ model, selectedIds, target, editBlocked, serverFeatures, connectBlocked, submit, select, onClose }: Props) {
  const [idPrefix] = useState(() => `cf-${Date.now().toString(36)}`)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const words = W.target[target]

  const preview = useMemo(() => {
    const plan = () => previewFixtureConnect(model, selectedIds, target, idPrefix)
    return serverFeatures ? withUpgradePolicy((f) => serverFeatures.includes(f), plan) : plan()
  }, [model, selectedIds, target, idPrefix, serverFeatures])
  const refused = 'refused' in preview ? preview.refused : null
  const lines = 'refused' in preview ? [] : preview.lines
  const joinable = 'refused' in preview ? 0 : preview.joinable

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

  const blocked = editBlocked ?? connectBlocked ?? (joinable === 0 && !done ? W.noneJoin : null)
  const connect = () => {
    if ('refused' in preview) return
    setError(null)
    const refusal = submit({ type: 'connect_into', from: preview.plan.sources.map((s) => s.source), into: 'nearest', idPrefix }, words.undo)
    if (refusal) {
      console.error('[ConnectFixturesPanel] connect_into refused', { target, refusal })
      return setError(refusal)
    }
    setDone(W.done(joinable, lines.length))
  }

  return (
    <Card className="pointer-events-auto fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] gap-3 py-4" role="region" aria-label={W.title} data-testid="connect-fixtures-panel">
      <CardHeader className="px-4">
        <CardTitle>
          {W.title} · {words.label}
        </CardTitle>
        <CardDescription>{done ?? refused ?? words.description}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label={W.close} onClick={onClose} data-testid="connect-fixtures-close">
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex max-h-80 flex-col gap-3 overflow-y-auto px-4">
        {done ? null : refused ? (
          <Alert>
            <CircleAlert />
            <AlertDescription>{refused}</AlertDescription>
          </Alert>
        ) : (
          <ItemGroup data-testid="connect-fixtures-list">
            {lines.map((l) => (
              <Item key={l.key} variant="outline" size="sm" data-ok={l.ok}>
                <ItemMedia variant="icon">{l.ok ? <CircleCheck className="text-success-700" /> : <CircleX className="text-danger-600" />}</ItemMedia>
                <ItemContent>
                  <ItemTitle className="font-normal whitespace-normal">{l.text}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="ghost" onClick={() => select([l.elementId])} aria-label={`${W.select}: ${l.text}`}>
                    <Crosshair />
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
        {blocked && !refused && !done && <p className="text-muted-foreground text-xs">{blocked}</p>}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 px-4">
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            {done ? W.closeDone : W.close}
          </Button>
          <Button className="flex-1" onClick={connect} disabled={blocked !== null || refused !== null || done !== null} title={blocked ?? refused ?? undefined} data-testid="connect-fixtures-connect">
            <Link2 data-icon="inline-start" />
            {W.connectAll(joinable)}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{W.escHint}</p>
      </CardFooter>
    </Card>
  )
}
