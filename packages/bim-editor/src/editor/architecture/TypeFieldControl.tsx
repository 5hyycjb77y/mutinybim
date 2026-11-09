'use client'

import type { ReactNode } from 'react'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import type { DraftValue, TypeField } from './type-fields'

const NONE = '__none__'

/** One type parameter's control (Edit type and Firm library › Types). */
export function TypeFieldControl({ idPrefix, field, value, disabled, onChange }: { readonly idPrefix: string; readonly field: TypeField; readonly value: DraftValue; readonly disabled: boolean; readonly onChange: (v: DraftValue) => void }): ReactNode {
  const id = `${idPrefix}-${field.key}`
  const label = field.unit ? `${field.label} (${field.unit})` : field.label
  if (field.control === 'boolean') {
    return (
      <Field orientation="horizontal">
        <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={(on) => onChange(on)} />
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </Field>
    )
  }
  if (field.control === 'choice') {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select value={typeof value === 'string' && value !== '' ? value : NONE} disabled={disabled} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
          <SelectTrigger id={id} aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>Not set</SelectItem>
              {(field.choices ?? []).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      </Field>
    )
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={typeof value === 'string' ? value : ''} disabled={disabled} inputMode={field.control === 'number' ? 'decimal' : undefined} onChange={(e) => onChange(e.target.value)} />
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  )
}
