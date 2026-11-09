'use client'

import { useMemo, useState } from 'react'
import { Plus, Server } from 'lucide-react'
import { elementsOfKind, type ModelState } from '@permitzip/bim-kernel'
import { SERVICE_SYSTEMS, planServiceLayout, type ServiceSystem } from '@permitzip/bim-pack-electrical'
import { Button } from '../../ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { SubmitCommand } from '../views-sheets/types'

const PICKED = 'data-[state=off]:border-transparent data-[state=off]:bg-transparent data-[state=on]:bg-primary data-[state=on]:text-primary-foreground'
const SYSTEM_WORDS: Record<ServiceSystem, string> = { '208Y/120': '208Y/120 V, 3-phase', '480Y/277': '480Y/277 V, 3-phase', '120/240': '120/240 V, 1-phase' }

function isServiceSystem(v: string): v is ServiceSystem {
  return (SERVICE_SYSTEMS as readonly string[]).includes(v)
}

/** The system the items ask for: any 480/277 V item → 480Y/277, any 3-phase or 208 V → 208Y/120, all 120/240 V single-phase → 120/240. */
export function systemForItems(model: Pick<ModelState, 'elements'>, partIds: readonly string[]): ServiceSystem {
  let three = false
  let split = false
  for (const id of partIds) {
    const part = model.elements[id]
    if (part?.kind !== 'part') continue
    const volts = part.values.voltage
    const phases = part.values.phases
    if (typeof volts === 'number' && (volts >= 440 || volts === 277)) return '480Y/277'
    if (phases === 3 || volts === 208) three = true
    else if (volts === 240) split = true
  }
  return three || !split ? '208Y/120' : '120/240'
}

/**
 * "No panel yet" inside Circuit / Circuit all: plan the main panel (MDP) right
 * here instead of sending the person to Electrical › Service size. It is the
 * same plan-only service layout (nothing drawn, waits in Not placed yet), one
 * undoable edit; once it exists the dialog goes straight on to the circuits.
 */
export function AddPlannedPanel({
  model,
  partIds,
  canEdit = true,
  blockedReason = null,
  submit,
}: {
  readonly model: ModelState
  readonly partIds: readonly string[]
  readonly canEdit?: boolean
  readonly blockedReason?: string | null
  readonly submit: SubmitCommand
}) {
  const levels = useMemo(() => [...elementsOfKind(model.elements, 'level')].sort((a, b) => a.elevationMm - b.elevationMm), [model.elements])
  const hinted = useMemo(() => {
    for (const id of partIds) {
      const part = model.elements[id]
      const hint = part?.kind === 'part' ? part.planned?.levelHint : undefined
      if (hint && model.elements[hint]?.kind === 'level') return hint
    }
    return null
  }, [model.elements, partIds])
  const [levelId, setLevelId] = useState<string>(() => hinted ?? levels[0]?.id ?? '')
  const [system, setSystem] = useState<ServiceSystem>(() => systemForItems(model, partIds))
  const [amps, setAmps] = useState('400')
  const [error, setError] = useState<string | null>(null)

  const serviceA = Number(amps)
  const layout = useMemo(
    () => (levelId && Number.isInteger(serviceA) && serviceA > 0 ? planServiceLayout(model, { levelId, serviceA, system, meter: false, planOnly: true, distribution: { name: 'MDP' }, equipment: [] }) : null),
    [model, levelId, serviceA, system],
  )
  const why = !canEdit
    ? (blockedReason ?? "The model can't be changed right now.")
    : levels.length === 0
      ? 'Add a level first (Model › Level): the panel is planned for a level.'
      : !layout
        ? 'Type the service size in whole amps (400).'
        : !layout.ok
          ? layout.reason
          : null

  const add = () => {
    if (why || !layout?.ok) return
    const refusal = submit(layout.command, `add a planned ${serviceA}A ${system} MDP`)
    setError(refusal)
  }

  return (
    <Empty className="border" data-testid="circuit-planned-no-panel">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Server />
        </EmptyMedia>
        <EmptyTitle>No panel yet</EmptyTitle>
        <EmptyDescription>Add a planned main panel (MDP) here; it isn&apos;t drawn and waits in Not placed yet. Then these go on its circuits. You can undo it.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-md items-stretch gap-3 text-left">
        <Field>
          <FieldLabel id="bm-add-mdp-system-label">System</FieldLabel>
          <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby="bm-add-mdp-system-label" value={system} onValueChange={(v) => isServiceSystem(v) && setSystem(v)} data-testid="add-planned-panel-system">
            {SERVICE_SYSTEMS.map((s) => (
              <ToggleGroupItem key={s} value={s} className={PICKED} aria-label={SYSTEM_WORDS[s]}>
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>Picked from what the items need; {SYSTEM_WORDS[system]}.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-add-mdp-amps">Service size (A)</FieldLabel>
          <Input id="bm-add-mdp-amps" inputMode="numeric" value={amps} onChange={(e) => setAmps(e.target.value)} data-testid="add-planned-panel-amps" />
        </Field>
        {levels.length > 1 && (
          <Field>
            <FieldLabel htmlFor="bm-add-mdp-level">For level</FieldLabel>
            <Select value={levelId} onValueChange={setLevelId}>
              <SelectTrigger id="bm-add-mdp-level">
                <SelectValue placeholder="Choose a level" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {levels.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
        {(error ?? why) && (
          <FieldDescription className={error ? 'text-danger-600' : undefined} role={error ? 'alert' : 'status'} data-testid="add-planned-panel-why">
            {error ?? why}
          </FieldDescription>
        )}
        <Button type="button" disabled={why !== null} title={why ?? undefined} onClick={add} data-testid="add-planned-panel">
          <Plus data-icon="inline-start" />
          Add a planned panel (MDP)
        </Button>
      </EmptyContent>
    </Empty>
  )
}
