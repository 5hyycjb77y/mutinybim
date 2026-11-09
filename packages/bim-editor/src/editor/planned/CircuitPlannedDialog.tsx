'use client'

import { useMemo, useState } from 'react'
import { Cable, CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { type NecEdition } from '@permitzip/bim-calc'
import { nextStandardRating, CONNECTED_LOAD_ONLY, ElectricalLoadEngine, distributionEquipment, planDedicatedCircuits } from '@permitzip/bim-pack-electrical'
import { asElementId, executeCommand, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import type { SubmitCommand } from '../views-sheets/types'
import { newId } from '../views-sheets/types'
import { AddPlannedPanel } from './AddPlannedPanel'

/** The project's code rules: the engine the panel's loads are read with, and the edition that sizes breakers. */
export interface CircuitRules {
  readonly engine: ElectricalLoadEngine
  readonly necEdition: NecEdition | null
}

/** Without the project's rules: connected loads only, breakers at the panel default. */
const CONNECTED_ONLY = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY)

const kva = (va: number) => (va / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })

/**
 * Not placed yet › Circuit, and Equipment list › Put them on circuits (ROADMAP
 * E1): planned items with an electrical load go on the panel you pick, each on
 * a circuit of its own in the slots that best balance its phases, the breaker
 * sized for the load. Nothing has to be drawn; placing an item later keeps its
 * circuit. What each item gets, or why it can't go on that panel, is shown
 * before you press anything; it is one undo step. Esc or Cancel closes.
 */
export function CircuitPlannedDialog({
  model,
  partIds,
  rules,
  submit,
  onClose,
  onDone,
}: {
  readonly model: ModelState
  readonly partIds: readonly string[]
  readonly rules?: CircuitRules | null
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** After it saved: the panel the circuits are on. */
  readonly onDone?: (panelId: string) => void
}) {
  const engine = rules?.engine ?? CONNECTED_ONLY
  const nec = rules?.necEdition ?? null
  const panels = useMemo(() => distributionEquipment(model.elements).filter((d) => d.kind === 'panelboard' || d.kind === 'switchboard'), [model.elements])
  const [panelId, setPanelId] = useState<string>(() => panels[0]?.id ?? '')
  const chosen = panels.some((p) => p.id === panelId) ? panelId : (panels[0]?.id ?? '')
  /** One id per item for as long as the dialog is open, so a retry makes the same circuits, not new ones. */
  const [linkIds] = useState(() => new Map<string, string>())
  const plan = useMemo(() => {
    if (!chosen) return null
    const linkIdFor = (partId: string) => {
      const known = linkIds.get(partId)
      if (known) return known
      const id = newId('link')
      linkIds.set(partId, id)
      return id
    }
    return planDedicatedCircuits(model, partIds, chosen, { linkIdFor, engine, ...(nec ? { breakerFor: (a: number) => nextStandardRating(nec, a) } : {}) })
  }, [model, partIds, chosen, engine, nec, linkIds])
  /** The panel as it will read once these are on it: the engine's numbers, never added up here. */
  const after = useMemo(() => {
    if (!plan?.command) return null
    const run = executeCommand(model, plan.command)
    return run.ok ? engine.report(run.model, asElementId(chosen)) : null
  }, [model, plan, engine, chosen])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const panelName = panels.find((p) => p.id === chosen)?.name ?? ''
  const why = panels.length === 0 ? 'No panel yet: add a planned panel (MDP) above first.' : !plan ? 'Choose the panel they go on.' : plan.circuits.length === 0 ? (plan.refused[0]?.reason ?? 'Nothing here can be circuited.') : null

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan?.command || why) return
    const refusal = submit(plan.command, plan.label.charAt(0).toLowerCase() + plan.label.slice(1))
    if (refusal) {
      setSubmitError(refusal)
      return
    }
    const left = plan.refused.length
    toast.success(plan.label, left > 0 ? { description: `${left} couldn't go on ${panelName}: ${plan.refused.map((r) => r.name).join(', ')}. ${plan.refused[0]?.reason ?? ''}` } : {})
    onDone?.(chosen)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="circuit-planned-dialog">
        <form onSubmit={send} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              Put {partIds.length === 1 ? 'it' : `${partIds.length} items`} on circuits
            </DialogTitle>
            <DialogDescription>Each goes on a circuit of its own, in the free slots that best balance the panel&apos;s phases. They don&apos;t need to be drawn; placing one later keeps its circuit. You can undo this.</DialogDescription>
          </DialogHeader>
          {panels.length === 0 ? (
            <AddPlannedPanel model={model} partIds={partIds} submit={submit} />
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="bm-circuit-planned-panel">Panel</FieldLabel>
                <Select
                  value={chosen}
                  onValueChange={(v) => {
                    setPanelId(v)
                    setSubmitError(null)
                  }}
                >
                  <SelectTrigger id="bm-circuit-planned-panel" data-testid="circuit-planned-panel">
                    <SelectValue placeholder="Choose the panel they go on" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {panels.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} · {p.system}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{nec ? `Breakers are the next standard size for each load (NEC ${nec.edition}).` : 'Breakers stay at the panel default (20 A unless the item gives a maximum): set the NEC edition in the project’s Code Study to size them.'}</FieldDescription>
              </Field>
              {plan && plan.circuits.length > 0 && (
                <div className="max-h-64 overflow-auto rounded-md border">
                  <Table data-testid="circuit-planned-rows">
                    <TableCaption className="sr-only">The circuit each item gets on {panelName}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Item</TableHead>
                        <TableHead className="text-xs">Circuit</TableHead>
                        <TableHead className="text-right text-xs">Load</TableHead>
                        <TableHead className="text-right text-xs">Breaker</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {plan.circuits.map((c) => (
                        <TableRow key={c.partId} data-testid="circuit-planned-row">
                          <TableCell className="text-xs">
                            {c.name}
                            {c.planned && <span className="text-muted-foreground"> · not placed yet</span>}
                          </TableCell>
                          <TableCell className="text-xs">{c.circuitName}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{kva(c.va)} kVA</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {c.breakerA !== null ? `${c.breakerA} A` : 'default'}, {c.poles}-pole
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {plan && plan.refused.length > 0 && (
                <Alert variant={plan.circuits.length === 0 ? 'destructive' : 'default'} data-testid="circuit-planned-refused">
                  <CircleAlert />
                  <AlertTitle>
                    {plan.refused.length === 1 ? '1 item' : `${plan.refused.length} items`} can&apos;t go on {panelName}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {plan.refused.map((r) => (
                        <li key={r.partId}>{r.reason}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {after && (
                <p className="text-sm" data-testid="circuit-planned-after">
                  {after.name} after this: <span className="font-medium tabular-nums">{kva(after.connectedVa)} kVA = {Math.round(after.connectedA)} A</span>
                  {after.capacity.limitA !== null ? ` of ${Math.round(after.capacity.limitA)} A` : ''} connected
                </p>
              )}
            </>
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
            <Button type="submit" disabled={why !== null} title={why ?? undefined} data-testid="circuit-planned-submit">
              <Cable data-icon="inline-start" />
              {plan && plan.circuits.length > 0 ? `Put ${plan.circuits.length} on circuits` : 'Put on circuits'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
