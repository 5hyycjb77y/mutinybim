'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Cable, Square, X } from 'lucide-react'
import { elementsOfKind, type ModelState } from '@permitzip/bim-kernel'
import { continuePanels, newUncircuitedDevices, panelCircuits, planContinueCircuit } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { newElementId } from '../placement'
import { CLOSES_AT_ONCE } from '../menu-close'
import type { SubmitCommand } from '../views-sheets/types'
import type { ElectricalPlaceKind } from './electrical-tab'

const NEW_CIRCUIT = '__new__'

/** What Continue circuit places, in the words of the Device menu. */
export const CONTINUE_DEVICE_KINDS: readonly { readonly kind: ElectricalPlaceKind; readonly label: string; readonly plural: string }[] = [
  { kind: 'receptacle', label: 'Receptacle', plural: 'receptacles' },
  { kind: 'receptacle_gfci', label: 'Receptacle, GFCI', plural: 'GFCI receptacles' },
  { kind: 'light', label: 'Light', plural: 'lights' },
  { kind: 'downlight', label: 'Downlight', plural: 'downlights' },
  { kind: 'junction_box', label: 'Junction box', plural: 'junction boxes' },
]

interface Active {
  readonly panelId: string
  readonly linkId: string | null
  readonly newLinkId: string
  readonly kind: ElectricalPlaceKind
  readonly added: number
}

/**
 * Electrical › Circuits › Continue circuit: pick the panel and the circuit
 * (or a new one), then every device you place joins it, one edit each (Undo
 * takes the last device off). Esc or Stop ends it; nothing is circuited
 * after that.
 */
export function ContinueCircuitPanel({ model, editBlocked, submit, place, onClose, notify }: { readonly model: ModelState; readonly editBlocked: string | null; readonly submit: SubmitCommand; readonly place: (kind: ElectricalPlaceKind) => string | null; readonly onClose: () => void; readonly notify: (message: string, kind?: 'info' | 'error') => void }) {
  const panels = useMemo(() => continuePanels(model), [model])
  const [panelId, setPanelId] = useState<string>(panels[0]?.panelId ?? '')
  const circuits = useMemo(() => (panelId ? panelCircuits(model, panelId) : []), [model, panelId])
  const [circuit, setCircuit] = useState<string>(NEW_CIRCUIT)
  const [kind, setKind] = useState<ElectricalPlaceKind>('receptacle')
  const [active, setActive] = useState<Active | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const known = useRef<Set<string>>(new Set())

  const panelName = panels.find((p) => p.panelId === (active?.panelId ?? panelId))?.name ?? ''
  const device = CONTINUE_DEVICE_KINDS.find((d) => d.kind === (active?.kind ?? kind)) ?? CONTINUE_DEVICE_KINDS[0]
  const circuitLabel = (linkId: string | null) => (linkId ? (panelCircuits(model, active?.panelId ?? panelId).find((c) => c.linkId === linkId)?.label ?? 'the circuit') : `a new circuit on ${panelName}`)

  const startBlocked = editBlocked ?? (panels.length === 0 ? 'Place a panel first: Electrical › Panel, then name it in its properties.' : !panelId ? 'Pick the panel.' : null)

  const start = () => {
    if (startBlocked) return
    const refusal = place(kind)
    if (refusal) {
      setProblem(refusal)
      return
    }
    known.current = new Set(elementsOfKind(model.elements, 'part').map((el) => el.id))
    setProblem(null)
    setActive({ panelId, linkId: circuit === NEW_CIRCUIT ? null : circuit, newLinkId: newElementId('ckt'), kind, added: 0 })
  }
  const stop = () => {
    if (active && active.added > 0) notify(`Added ${active.added} ${active.added === 1 ? device?.label.toLowerCase() : device?.plural} to ${circuitLabel(active.linkId)}.`)
    setActive(null)
    onClose()
  }
  const stopRef = useRef(stop)
  useEffect(() => {
    stopRef.current = stop
  })

  // Esc ends it (Place part leaves on the same key).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // Each device placed while it is on joins the circuit: one per model change, so the next plans against the circuit the last one made.
  useEffect(() => {
    if (!active) return
    const id = newUncircuitedDevices(model, known.current)[0]
    if (id === undefined) return
    known.current.add(id)
    const alive = active.linkId !== null && model.elements[active.linkId]?.kind === 'service_link'
    // A circuit undone while this is on: the next device starts a new one.
    const target = { panelId: active.panelId, linkId: alive ? active.linkId : null, newLinkId: alive || active.linkId === null ? active.newLinkId : newElementId('ckt') }
    const plan = planContinueCircuit(model, id, target)
    if (!plan.ok) {
      setProblem(plan.reason)
      return
    }
    for (const command of plan.commands) {
      const refusal = submit(command, plan.label)
      if (refusal) {
        setProblem(refusal)
        return
      }
    }
    setProblem(null)
    setActive({ ...active, linkId: plan.linkId, newLinkId: newElementId('ckt'), added: active.added + 1 })
  }, [model, active, submit])

  return (
    <div className="absolute bottom-3 left-3 z-20 flex w-96 flex-col gap-3 rounded-lg border bg-background/95 p-3 shadow-md" data-testid="continue-circuit-panel" role="region" aria-label="Continue circuit">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Cable data-icon="inline-start" />
          Continue circuit
        </span>
        {!active && (
          <Button variant="ghost" size="icon-sm" aria-label="Close Continue circuit" onClick={onClose} data-testid="continue-circuit-close">
            <X />
          </Button>
        )}
      </div>
      {active ? (
        <>
          <p className="text-sm" data-testid="continue-circuit-status">
            Each {device?.label.toLowerCase()} you place joins {circuitLabel(active.linkId)}. Added {active.added}.
          </p>
          <p className="text-xs text-muted-foreground">Click in the plan to place. Undo takes the last one off the circuit. Esc stops placing and circuiting; Stop ends circuiting only (Place part stays on).</p>
          <Button onClick={stop} data-testid="continue-circuit-stop">
            <Square data-icon="inline-start" />
            Stop
          </Button>
        </>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="continue-circuit-panel-pick">Panel</FieldLabel>
            <Select
              value={panelId}
              onValueChange={(v) => {
                setPanelId(v)
                setCircuit(NEW_CIRCUIT)
              }}
            >
              <SelectTrigger id="continue-circuit-panel-pick" data-testid="continue-circuit-panel-pick">
                <SelectValue placeholder="Pick a panel" />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                <SelectGroup>
                  {panels.map((p) => (
                    <SelectItem key={p.panelId} value={p.panelId}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="continue-circuit-circuit-pick">Circuit</FieldLabel>
            <Select value={circuit} onValueChange={setCircuit}>
              <SelectTrigger id="continue-circuit-circuit-pick" data-testid="continue-circuit-circuit-pick">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                <SelectGroup>
                  <SelectItem value={NEW_CIRCUIT}>New circuit (best-balanced free spaces)</SelectItem>
                  {circuits.map((c) => (
                    <SelectItem key={c.linkId} value={c.linkId}>
                      {c.label} · {c.members} on it
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="continue-circuit-device-pick">Place</FieldLabel>
            <Select value={kind} onValueChange={(v) => setKind(CONTINUE_DEVICE_KINDS.find((d) => d.kind === v)?.kind ?? 'receptacle')}>
              <SelectTrigger id="continue-circuit-device-pick" data-testid="continue-circuit-device-pick">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                <SelectGroup>
                  {CONTINUE_DEVICE_KINDS.map((d) => (
                    <SelectItem key={d.kind} value={d.kind}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Button onClick={start} disabled={startBlocked !== null} title={startBlocked ?? undefined} data-testid="continue-circuit-start">
            <Cable data-icon="inline-start" />
            Start placing
          </Button>
          {startBlocked && <p className="text-xs text-muted-foreground">{startBlocked}</p>}
        </>
      )}
      {problem && (
        <Alert variant="destructive" data-testid="continue-circuit-problem">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
