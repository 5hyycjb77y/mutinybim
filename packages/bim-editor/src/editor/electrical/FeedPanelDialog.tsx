'use client'

import { useState } from 'react'
import { CircleAlert, Unplug } from 'lucide-react'
import { ampsFromVa, q } from '@permitzip/bim-calc'
import { type ModelState } from '@permitzip/bim-kernel'
import { distributionEquipment, distributionOf, feederPolesFor, panelSchedule, slotChoiceLabel, slotChoices, planFeed } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { SubmitCommand } from '../views-sheets/types'

/**
 * Electrical › Feed panel: the selected panel or transformer gets its feeder
 * from a breaker in the panel or switchboard you pick, or straight from a
 * transformer's secondary. A panel that is already fed moves to the new
 * source. Voltage, phase and pole mismatches are said before you press Feed.
 */
export function FeedPanelDialog({
  model,
  fedId,
  newLinkId,
  submit,
  onClose,
  onDone,
}: {
  readonly model: ModelState
  readonly fedId: string
  readonly newLinkId: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
  readonly onDone: (sourceId: string) => void
}) {
  const els = model.elements
  const fed = panelSchedule(els, fedId)
  const sources = distributionEquipment(els).filter((d) => d.id !== fedId)
  const [sourceId, setSourceId] = useState(fed?.fedBy?.sourceId ?? '')
  const source = sourceId ? panelSchedule(els, sourceId) : null
  const poles = feederPolesFor(els, fedId)
  const choices = sourceId && poles && source?.spaces !== null ? slotChoices(els, sourceId, poles, fed?.fedBy?.linkId) : []
  const [slotsPick, setSlotsPick] = useState<{ source: string; key: string } | null>(null)
  const current = fed?.fedBy && fed.fedBy.sourceId === sourceId ? fed.fedBy.positions.join(',') : null
  const slotsKey = slotsPick?.source === sourceId && choices.some((c) => c.join(',') === slotsPick.key) ? slotsPick.key : (current ?? choices[0]?.join(',') ?? '')
  const [breaker, setBreaker] = useState('')
  const [feederType, setFeederType] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  if (!fed) return null

  const breakerA = breaker.trim() === '' ? null : Number(breaker)
  const breakerBad = breakerA !== null && (!Number.isFinite(breakerA) || breakerA <= 0)
  // A transformer has no main or bus to take the feeder breaker from: the engineer sizes its primary breaker.
  const fedPart = els[fedId]
  const fedInfo = fedPart?.kind === 'part' ? distributionOf(els, fedPart) : null
  const primaryFla = fedInfo?.kind === 'transformer' && fedInfo.kva ? ampsFromVa(q(fedInfo.kva * 1000, 'VA'), q(fedInfo.supply.lineToLine, 'V'), fedInfo.supply.phases) : null
  const needsBreaker = fedInfo?.kind === 'transformer' && source?.spaces !== null && breakerA === null
  const plan = sourceId ? planFeed(model, fedId, sourceId, { linkId: newLinkId, positions: source?.spaces !== null && slotsKey ? slotsKey.split(',').map(Number) : null, ratingA: breakerBad ? null : breakerA, feederType }) : null
  const why = !sourceId
    ? `Choose what feeds ${fed.name}.`
    : breakerBad
      ? 'The breaker is amps, a number above 0 (or leave it empty for the default).'
      : plan && !plan.ok
        ? plan.reason
        : needsBreaker
          ? `Type ${fed.name}’s primary breaker: a transformer has no main to take it from.`
          : null

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan?.ok || why) return
    for (const command of plan.commands) {
      const refusal = submit(command, plan.label)
      if (refusal) {
        setSubmitError(refusal)
        return
      }
    }
    onDone(sourceId)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="feed-dialog">
        <form onSubmit={send} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Feed {fed.name}</DialogTitle>
            <DialogDescription>
              {fed.name} needs {fed.supply ?? fed.system}. {fed.fedBy ? `It is fed from ${fed.fedBy.sourceName} now; this moves its feeder.` : 'Pick what feeds it.'} You can undo this.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="bm-feed-source">Fed from</FieldLabel>
              <Select
                value={sourceId}
                onValueChange={(v) => {
                  setSourceId(v)
                  setSubmitError(null)
                }}
              >
                <SelectTrigger id="bm-feed-source" data-testid="feed-source-select">
                  <SelectValue placeholder="Choose a panel, switchboard or transformer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id} data-testid={`feed-source-option-${s.id}`}>
                        {s.name} · {s.system}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {sources.length === 0 && <FieldDescription>Nothing else to feed it from yet: place a switchboard, panel or transformer from Electrical › Panel.</FieldDescription>}
            </Field>
            {source && source.spaces === null ? (
              <FieldDescription>A transformer’s secondary feeds its panel directly: no breaker slots on {source.name}.</FieldDescription>
            ) : (
              sourceId && (
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="bm-feed-slots">Slots on {source?.name}</FieldLabel>
                    <Select value={slotsKey} onValueChange={(key) => setSlotsPick({ source: sourceId, key })} disabled={choices.length === 0}>
                      <SelectTrigger id="bm-feed-slots" data-testid="feed-slots-select">
                        <SelectValue placeholder={choices.length === 0 ? 'No free slots' : 'Slots'} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {choices.map((c) => (
                            <SelectItem key={c.join(',')} value={c.join(',')}>
                              {slotChoiceLabel(els, sourceId, c)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>{poles ? `${poles}-pole breaker` : ''}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bm-feed-breaker">Breaker (A)</FieldLabel>
                    <Input id="bm-feed-breaker" inputMode="numeric" placeholder={fedInfo?.kind === 'transformer' ? 'Required' : 'Default'} value={breaker} onChange={(e) => setBreaker(e.target.value)} data-testid="feed-breaker" />
                    <FieldDescription>{primaryFla !== null ? `${fed.name} draws ${Math.round(primaryFla)} A at full load on its primary; size the breaker to your calc` : `Empty: ${fed.name}’s main, else its bus`}</FieldDescription>
                  </Field>
                </FieldGroup>
              )
            )}
            <Field>
              <FieldLabel htmlFor="bm-feed-type">Feeder type (optional)</FieldLabel>
              <Input id="bm-feed-type" placeholder="F225" maxLength={40} value={feederType} onChange={(e) => setFeederType(e.target.value)} />
            </Field>
          </FieldGroup>
          {why ? (
            <Alert variant="destructive" data-testid="feed-refusal">
              <CircleAlert />
              <AlertTitle>Can’t feed it from there</AlertTitle>
              <AlertDescription>{why}</AlertDescription>
            </Alert>
          ) : (
            plan?.ok && (
              <p className="text-sm" data-testid="feed-summary">
                Makes <span className="font-medium">{plan.summary}</span>
              </p>
            )
          )}
          {submitError && (
            <FieldDescription className="text-danger-600" role="alert">
              {submitError}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={why !== null} data-testid="feed-submit">
              <Unplug data-icon="inline-start" />
              Feed {fed.name}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
