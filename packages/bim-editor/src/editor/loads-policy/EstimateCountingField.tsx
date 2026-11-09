'use client'

import { useMemo, useState } from 'react'
import {
  ALLOCATION_POLICY_HELP,
  ALLOCATION_POLICY_LABELS,
  allocationPolicyOf,
  estimateVsDevicesText,
  requirementsEngineOf,
  typicalCount,
  typicalOf,
  type AllocationPolicy,
  type Command,
  type ModelState,
} from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

interface Props {
  readonly model: ModelState
  readonly spaceId: string
  readonly canEdit: boolean
  /** Why the control is read-only (shown under it when `canEdit` is false). */
  readonly blockedReason: string
  /** Sends one kernel command with its undo label; returns the refusal, or null when it committed. */
  readonly submit: (command: Command, undoLabel: string) => string | null
}

const POLICIES: readonly AllocationPolicy[] = ['max', 'actual_only', 'allocation_only']
const MODEL = 'model'

function isPolicy(v: string): v is AllocationPolicy {
  return POLICIES.some((p) => p === v)
}

/**
 * How this space's estimates count once devices are placed in it: the
 * model's setting (default: the estimate until the devices exceed it), or the
 * space's own. Under it, what the space counts right now, and how a typical
 * unit's space counts once here and once per copy in the project.
 */
export function EstimateCountingField({ model, spaceId, canEdit, blockedReason, submit }: Props) {
  const [error, setError] = useState<string | null>(null)
  const space = model.elements[spaceId]
  const modelPolicy = allocationPolicyOf(model.elements)
  const own = space?.kind === 'space' ? space.estimateCounting : undefined
  const effective = own ?? modelPolicy
  const now = useMemo(() => {
    if (space?.kind !== 'space') return null
    const f = requirementsEngineOf(model.elements).scopeFigures(model, { kind: 'space', id: space.id })
    return f.estimateIds.length > 0 ? estimateVsDevicesText(f) : null
  }, [model, space])
  const typical = space?.kind === 'space' ? typicalOf(model.elements, space) : null

  if (space?.kind !== 'space') {
    return (
      <Alert data-testid="estimate-counting-missing">
        <AlertDescription>This space is no longer in the model. Someone may have deleted it; pick another space.</AlertDescription>
      </Alert>
    )
  }

  const choose = (v: string) => {
    const next = v === MODEL ? null : isPolicy(v) ? v : undefined
    if (next === undefined || (next ?? undefined) === own) return
    const label = next === null ? 'count estimates as the model says' : `count estimates: ${ALLOCATION_POLICY_LABELS[next].toLowerCase()}`
    setError(submit({ type: 'edit_space', spaceId: space.id, estimateCounting: next }, `${label} in ${space.number || space.name}`))
  }

  const id = `estimate-counting-${space.id}`
  return (
    <Field data-testid="estimate-counting">
      <FieldLabel htmlFor={id}>Estimates count</FieldLabel>
      <Select value={own ?? MODEL} disabled={!canEdit} onValueChange={choose}>
        <SelectTrigger id={id} size="sm" aria-label="How this space's estimates count" title={canEdit ? undefined : blockedReason} data-testid="estimate-counting-trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={MODEL}>As the model says ({ALLOCATION_POLICY_LABELS[modelPolicy].toLowerCase()})</SelectItem>
            {POLICIES.map((p) => (
              <SelectItem key={p} value={p}>
                {ALLOCATION_POLICY_LABELS[p]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription data-testid="estimate-counting-help">
        {canEdit ? ALLOCATION_POLICY_HELP[effective] : blockedReason}
        {now ? ` Now: ${now}.` : ''}
        {typical ? ` In typical ${typical.spec.label.toLowerCase()} ${typical.spec.mark}: counted once here, ${typicalCount(typical.spec)}× in the project totals.` : ''}
      </FieldDescription>
      {error && (
        <Alert variant="destructive" data-testid="estimate-counting-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Field>
  )
}
