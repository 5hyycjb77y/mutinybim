'use client'

import { useState } from 'react'
import { Hammer, Undo2 } from 'lucide-react'
import { groupIdOf, isOrganized, organizationOf, phaseCreatedOf, phaseDemolishedOf, type BimElement, type ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { SubmitCommand } from '../views-sheets/types'

const NOT_DEMOLISHED = 'none'
const MIXED = 'mixed'

interface Props {
  readonly model: ModelState
  /** What is selected: one element, or a run / branch / system / box selection. */
  readonly ids: readonly string[]
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
}

function common(values: readonly string[]): string {
  const first = values[0]
  return first !== undefined && values.every((v) => v === first) ? first : MIXED
}

/** Group and phases of the selection, with controls to change them. */
export function ElementOrganizationFields({ model, ids, canEdit, blockedReason, submit }: Props) {
  const [error, setError] = useState<string | null>(null)
  const org = organizationOf(model)
  const elements = ids.map((id) => model.elements[id]).filter((el): el is BimElement => el !== undefined && isOrganized(el))
  if (elements.length === 0) return null
  const list = elements.map((el) => el.id)
  const what = elements.length === 1 ? 'it' : `these ${elements.length}`
  const group = common(elements.map((el) => groupIdOf(org, el)))
  const created = common(elements.map((el) => phaseCreatedOf(org, el)))
  const demolished = common(elements.map((el) => phaseDemolishedOf(org, el) ?? NOT_DEMOLISHED))
  const anyDemolished = elements.some((el) => phaseDemolishedOf(org, el) !== null)
  const locked = elements.map((el) => org.groupById.get(groupIdOf(org, el))).find((g) => g?.entry.locked)
  const blocked = !canEdit ? blockedReason : locked ? `"${locked.entry.name}" is locked. Unlock it in Manage › Groups & phases to change ${what}.` : null
  const activePhase = org.phases.find((p) => p.id === org.activePhaseId)
  const run = (refusal: string | null) => setError(refusal)

  return (
    <FieldSet data-testid="element-organization">
      <FieldLegend variant="label">Group and phase</FieldLegend>
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="el-group">Group</FieldLabel>
          <Select
            value={group}
            disabled={blocked !== null}
            onValueChange={(id) => id !== MIXED && run(submit({ type: 'assign_elements_to_group', ids: list, groupId: id }, `move ${what} to ${org.groupById.get(id)?.entry.name ?? 'that group'}`))}
          >
            <SelectTrigger id="el-group" size="sm" data-testid="element-group">
              <SelectValue placeholder="Mixed groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {group === MIXED && (
                  <SelectItem value={MIXED} disabled>
                    Mixed groups
                  </SelectItem>
                )}
                {org.groups.map((g) => (
                  <SelectItem key={g.id} value={g.id} disabled={g.entry.locked}>
                    {g.entry.name}
                    {g.entry.locked ? ' (locked)' : ''}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="el-phase-created">Built in</FieldLabel>
          <Select
            value={created}
            disabled={blocked !== null}
            onValueChange={(id) => id !== MIXED && run(submit({ type: 'set_element_phases', ids: list, phaseCreated: id }, `set ${what} as built in ${org.phases.find((p) => p.id === id)?.entry.name ?? 'that phase'}`))}
          >
            <SelectTrigger id="el-phase-created" size="sm" data-testid="element-phase-created">
              <SelectValue placeholder="Mixed phases" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {created === MIXED && (
                  <SelectItem value={MIXED} disabled>
                    Mixed phases
                  </SelectItem>
                )}
                {org.phases.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.entry.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="el-phase-demolished">Demolished in</FieldLabel>
          <Select
            value={demolished}
            disabled={blocked !== null}
            onValueChange={(id) => id !== MIXED && run(submit({ type: 'set_element_phases', ids: list, phaseDemolished: id === NOT_DEMOLISHED ? null : id }, id === NOT_DEMOLISHED ? `restore ${what}` : `demolish ${what}`))}
          >
            <SelectTrigger id="el-phase-demolished" size="sm" data-testid="element-phase-demolished">
              <SelectValue placeholder="Mixed" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {demolished === MIXED && (
                  <SelectItem value={MIXED} disabled>
                    Mixed
                  </SelectItem>
                )}
                <SelectItem value={NOT_DEMOLISHED}>Not demolished</SelectItem>
                {org.phases.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.entry.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {anyDemolished ? (
          <Button variant="outline" size="sm" disabled={blocked !== null} onClick={() => run(submit({ type: 'undemolish_elements', ids: list }, `restore ${what}`))} data-testid="element-undemolish">
            <Undo2 data-icon="inline-start" />
            Not demolished
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={blocked !== null} onClick={() => run(submit({ type: 'demolish_elements', ids: list }, `demolish ${what}`))} data-testid="element-demolish">
            <Hammer data-icon="inline-start" />
            Demolish in {activePhase?.entry.name ?? 'the active phase'}
          </Button>
        )}
        {(error ?? blocked) && <FieldDescription className={error ? 'text-danger-600' : undefined}>{error ?? blocked}</FieldDescription>}
      </FieldGroup>
    </FieldSet>
  )
}
