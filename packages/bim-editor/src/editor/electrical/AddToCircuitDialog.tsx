'use client'

import { useMemo, useState } from 'react'
import { Cable, CircleAlert, Server } from 'lucide-react'
import { type ModelState } from '@permitzip/bim-kernel'
import { defaultCircuitDescription, distributionEquipment, electricalConnections, isCircuitableLoad, memberName, panelSchedule, polesForMembers, slotChoiceLabel, slotChoices, planAddToCircuit, type CircuitTarget } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { SubmitCommand } from '../views-sheets/types'

const NEW = 'new'
/** Let the model pick: the next free slots that best even out the panel's phases. */
const AUTO = 'auto'

/**
 * Electrical › Add to circuit: what you selected goes on a circuit of the
 * panel you pick, in the free slots that best balance its phases (or the ones you choose),
 * or on a circuit that is already there. Why it can't is said before you
 * press anything. Esc or Cancel closes; nothing is saved until Add.
 */
export function AddToCircuitDialog({
  model,
  memberIds,
  initialPanelId,
  newLinkId,
  submit,
  onClose,
  onDone,
  onPlacePanel,
}: {
  readonly model: ModelState
  readonly memberIds: readonly string[]
  /** The panel to start on: the one they are on, or the last one used here. */
  readonly initialPanelId: string | null
  /** Id the new circuit gets (kept while the dialog is open, so a retry makes one circuit). */
  readonly newLinkId: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** After it saved: the panel the circuit is on. */
  readonly onDone: (panelId: string) => void
  readonly onPlacePanel: () => void
}) {
  const els = model.elements
  const loads = memberIds.filter((id) => {
    const el = els[id]
    return el?.kind === 'part' && isCircuitableLoad(els, el)
  })
  const panels = useMemo(() => distributionEquipment(els).filter((d) => d.kind === 'panelboard' || d.kind === 'switchboard' || d.kind === 'disconnect'), [els])
  const [panelId, setPanelId] = useState<string>(() => (initialPanelId && panels.some((p) => p.id === initialPanelId) ? initialPanelId : panels.length === 1 ? (panels[0]?.id ?? '') : ''))
  const poles = polesForMembers(els, loads.map((elementId) => ({ elementId })))
  const schedule = panelId ? panelSchedule(els, panelId) : null
  const existing = (schedule?.circuits ?? []).filter((c) => c.role === 'branch' && c.poles === poles)
  const [circuit, setCircuit] = useState<string>(NEW)
  const choices = panelId && poles ? slotChoices(els, panelId, poles) : []
  const [slotsPick, setSlotsPick] = useState<{ panel: string; key: string } | null>(null)
  const slotsKey = slotsPick && slotsPick.panel === panelId && (slotsPick.key === AUTO || choices.some((c) => c.join(',') === slotsPick.key)) ? slotsPick.key : AUTO
  const [breaker, setBreaker] = useState('')
  const [description, setDescription] = useState(() => defaultCircuitDescription(els, loads))
  const [submitError, setSubmitError] = useState<string | null>(null)

  const breakerA = breaker.trim() === '' ? null : Number(breaker)
  const breakerBad = breakerA !== null && (!Number.isFinite(breakerA) || breakerA <= 0)
  const target: CircuitTarget = circuit === NEW ? { kind: 'new', linkId: newLinkId, positions: slotsKey && slotsKey !== AUTO ? slotsKey.split(',').map(Number) : null, ratingA: breakerBad ? null : breakerA, description } : { kind: 'existing', linkId: circuit }
  const plan = panelId ? planAddToCircuit(model, loads, panelId, target) : null
  const moving = loads.filter((id) => electricalConnections(els, id).some((c) => c.circuit !== null)).length
  const only = loads.length === 1 ? els[loads[0] ?? ''] : undefined
  const noun = only?.kind === 'part' ? memberName(els, only) : `${loads.length} devices`
  const why = !panelId ? 'Choose the panel it goes on.' : breakerBad ? 'The breaker is amps, a number above 0 (or leave it empty for the default).' : plan && !plan.ok ? plan.reason : null

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan?.ok || why) return
    for (let i = 0; i < plan.commands.length; i++) {
      const command = plan.commands[i]
      if (!command) continue
      const refusal = submit(command, i === plan.commands.length - 1 ? plan.label : 'take devices off their old circuit')
      if (refusal) {
        setSubmitError(refusal)
        return
      }
    }
    onDone(panelId)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="circuit-dialog">
        <form onSubmit={send} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{moving > 0 ? `Change the circuit of ${noun}` : `Add ${noun} to a circuit`}</DialogTitle>
            <DialogDescription>
              {moving > 0 ? `${moving === loads.length ? 'Everything selected is' : `${moving} of these are`} on a circuit now; they come off it first.` : 'Pick the panel. The free slots that best even out its phases are chosen for you; you can pick others.'} You can undo this.
            </DialogDescription>
          </DialogHeader>
          {panels.length === 0 ? (
            <Empty className="border" data-testid="circuit-no-panel">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Server />
                </EmptyMedia>
                <EmptyTitle>No panel to circuit to yet</EmptyTitle>
                <EmptyDescription>Place a panelboard (Electrical › Panel), name it in its properties, then select these again and press Add to circuit.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="outline" onClick={onPlacePanel}>
                  <Server data-icon="inline-start" />
                  Place a 120/208 V panel
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bm-circuit-panel">Panel</FieldLabel>
                <Select
                  value={panelId}
                  onValueChange={(v) => {
                    setPanelId(v)
                    setCircuit(NEW)
                    setSubmitError(null)
                  }}
                >
                  <SelectTrigger id="bm-circuit-panel" data-testid="circuit-panel-select">
                    <SelectValue placeholder="Choose the panel it goes on" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {panels.map((p) => (
                        <SelectItem key={p.id} value={p.id} data-testid={`circuit-panel-option-${p.id}`}>
                          {p.name} · {p.system}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {existing.length > 0 && (
                <Field>
                  <FieldLabel>Circuit</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={circuit === NEW ? NEW : 'existing'} onValueChange={(v) => v && setCircuit(v === NEW ? NEW : (existing[0]?.linkId ?? NEW))} aria-label="New or existing circuit">
                    <ToggleGroupItem value={NEW}>New circuit</ToggleGroupItem>
                    <ToggleGroupItem value="existing">Add to one on {schedule?.name}</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              )}
              {circuit !== NEW ? (
                <Field>
                  <FieldLabel htmlFor="bm-circuit-existing">Existing circuit</FieldLabel>
                  <Select value={circuit} onValueChange={setCircuit}>
                    <SelectTrigger id="bm-circuit-existing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {existing.map((c) => (
                          <SelectItem key={c.linkId} value={c.linkId}>
                            {c.name} · {c.description || 'no description'} · {c.members.length} on it
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                panelId && (
                  <FieldGroup className="grid grid-cols-2 gap-3">
                    <Field>
                      <FieldLabel htmlFor="bm-circuit-slots">Slots</FieldLabel>
                      <Select value={slotsKey} onValueChange={(key) => setSlotsPick({ panel: panelId, key })} disabled={choices.length === 0}>
                        <SelectTrigger id="bm-circuit-slots" data-testid="circuit-slots-select" aria-label="Slots">
                          <SelectValue placeholder={choices.length === 0 ? 'No free slots' : 'Slots'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value={AUTO}>Balance the phases (recommended)</SelectItem>
                            {choices.map((c) => (
                              <SelectItem key={c.join(',')} value={c.join(',')}>
                                {slotChoiceLabel(els, panelId, c)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>{poles ? `${poles}-pole breaker` : 'These need different breakers'}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="bm-circuit-breaker">Breaker (A)</FieldLabel>
                      <Input id="bm-circuit-breaker" inputMode="numeric" placeholder="Default" value={breaker} onChange={(e) => setBreaker(e.target.value)} />
                      <FieldDescription>Empty: the unit’s MOCP, else 20 A</FieldDescription>
                    </Field>
                    <Field className="col-span-2">
                      <FieldLabel htmlFor="bm-circuit-description">Description</FieldLabel>
                      <Input id="bm-circuit-description" value={description} maxLength={120} onChange={(e) => setDescription(e.target.value)} />
                    </Field>
                  </FieldGroup>
                )
              )}
            </FieldGroup>
          )}
          <ItemGroup className="max-h-40 gap-1 overflow-y-auto" aria-label="What goes on the circuit">
            {loads.map((id) => {
              const el = els[id]
              const conn = electricalConnections(els, id)[0]
              return (
                <Item key={id} size="sm" variant="muted">
                  <ItemContent>
                    <ItemTitle className="text-xs">{el?.kind === 'part' ? memberName(els, el) : id}</ItemTitle>
                    <ItemDescription className="text-xs">
                      {conn?.voltage ? `${conn.voltage} V, ${conn.poles ?? 1} pole${(conn.poles ?? 1) === 1 ? '' : 's'}` : 'no voltage set'}
                      {conn?.loadVa ? `, ${Math.round(conn.loadVa)} VA` : ''}
                      {conn?.circuit ? ` · now on ${conn.circuit.name}` : ''}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )
            })}
          </ItemGroup>
          {why ? (
            panels.length > 0 && (
              <Alert variant="destructive" data-testid="circuit-refusal">
                <CircleAlert />
                <AlertTitle>Can’t add this circuit</AlertTitle>
                <AlertDescription>{why}</AlertDescription>
              </Alert>
            )
          ) : (
            plan?.ok && (
              <p className="text-sm" data-testid="circuit-summary">
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
            <Button type="submit" disabled={why !== null || panels.length === 0} data-testid="circuit-submit">
              <Cable data-icon="inline-start" />
              {circuit === NEW ? 'Add to circuit' : 'Add to this circuit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
