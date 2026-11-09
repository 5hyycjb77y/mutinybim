'use client'

import { X } from 'lucide-react'
import type { PackSet } from '@permitzip/bim-kernel/packs'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import {
  MAX_CONTRIBUTOR_CHARS,
  MAX_LINKED_DISCIPLINES,
  isLinkedDiscipline,
  linkedDisciplineChoices,
  linkedDisciplineLabel,
  type LinkedDiscipline,
} from '../../contracts/building-model/linked-contract'
import { LinkedDisciplineSelectItems } from './LinkedDisciplineSelectItems'

/**
 * What a linked model shows: its main discipline (the one older views use)
 * and any others it carries (one firm's model may carry several).
 * Every choice comes from the open model's registry. `value[0]` is the main one.
 */
export function LinkedDisciplinesField({
  id,
  value,
  onChange,
  set,
  disabled,
}: {
  readonly id: string
  readonly value: readonly LinkedDiscipline[]
  readonly onChange: (next: readonly LinkedDiscipline[]) => void
  readonly set?: PackSet
  readonly disabled?: boolean
}) {
  const [main, ...more] = value
  const primary = main ?? 'architecture'
  const left = linkedDisciplineChoices(set).filter((c) => !value.includes(c.value))
  const full = value.length >= MAX_LINKED_DISCIPLINES
  const addBlocked = disabled ? null : full ? `A linked model can show up to ${MAX_LINKED_DISCIPLINES} disciplines.` : left.length === 0 ? 'Every discipline is already picked.' : null
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>What it shows</FieldLabel>
        <Select value={primary} onValueChange={(v) => isLinkedDiscipline(v) && onChange([v, ...more.filter((d) => d !== v)])} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <LinkedDisciplineSelectItems set={set} current={primary} />
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-more`}>Also shows (optional)</FieldLabel>
        {more.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid={`${id}-more-list`}>
            {more.map((d) => {
              const label = linkedDisciplineLabel(d, set)
              return (
                <Badge key={d} variant="secondary" className="gap-1 pr-0.5">
                  {label}
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => onChange([primary, ...more.filter((x) => x !== d)])}>
                    <X />
                  </Button>
                </Badge>
              )
            })}
          </div>
        )}
        <Select value="" onValueChange={(v) => isLinkedDiscipline(v) && !value.includes(v) && onChange([primary, ...more, v])} disabled={disabled || addBlocked !== null}>
          <SelectTrigger id={`${id}-more`} title={addBlocked ?? undefined}>
            <SelectValue placeholder={addBlocked ?? 'Add another discipline…'} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {left.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>One firm&apos;s model can carry several disciplines; pick each one it shows.</FieldDescription>
      </Field>
    </>
  )
}

/** Who contributed a linked model: the company and the person there to ask. Both optional. */
export function LinkedContributorFields({
  id,
  organization,
  contact,
  onChange,
  disabled,
}: {
  readonly id: string
  readonly organization: string
  readonly contact: string
  readonly onChange: (next: { organization: string; contact: string }) => void
  readonly disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-company`}>Company (optional)</FieldLabel>
        <Input id={`${id}-company`} value={organization} maxLength={MAX_CONTRIBUTOR_CHARS} disabled={disabled} placeholder="e.g. Acme Engineering" onChange={(e) => onChange({ organization: e.target.value, contact })} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-contact`}>Contact (optional)</FieldLabel>
        <Input id={`${id}-contact`} value={contact} maxLength={MAX_CONTRIBUTOR_CHARS} disabled={disabled} placeholder="e.g. J. Rao" onChange={(e) => onChange({ organization, contact: e.target.value })} />
      </Field>
    </div>
  )
}
