'use client'

import { useState } from 'react'
import { parseFormula, type Dim, type ParamDef } from '@permitzip/bim-kernel'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { MM_PER_IN, dimText } from './draft'

/** Text to a dimension: a number is inches, a parameter's name binds to it, anything else is a formula. */
export function parseDim(text: string, params: readonly ParamDef[], unit: 'in' | 'deg' = 'in'): { dim: Dim } | { error: string } {
  const t = text.trim()
  if (t === '') return { error: 'Give a number, a parameter name or a formula' }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { dim: unit === 'in' ? Math.round(Number(t) * MM_PER_IN * 1000) / 1000 : Number(t) }
  const param = params.find((p) => p.name === t)
  if (param) return { dim: { param: param.name } }
  try {
    parseFormula(t)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Not a formula' }
  }
  const known = new Set(params.map((p) => p.name))
  const unknown = t.match(/[a-z_][a-z0-9_]*/gi)?.filter((w) => !known.has(w) && !['in', 'ft', 'mm', 'if', 'min', 'max', 'abs', 'sqrt', 'round', 'floor', 'ceil', 'sin', 'cos', 'tan', 'and', 'or', 'not', 'true', 'false'].includes(w))
  if (unknown && unknown.length > 0) return { error: `${unknown[0]} is not a parameter` }
  return { dim: { formula: t } }
}

interface Props {
  id: string
  label: string
  value: Dim
  params: readonly ParamDef[]
  unit?: 'in' | 'deg'
  onChange: (dim: Dim) => void
  disabled?: boolean
}

export function DimField({ id, label, value, params, unit = 'in', onChange, disabled }: Props) {
  const shown = unit === 'deg' && typeof value === 'number' ? String(value) : dimText(value)
  const [text, setText] = useState(shown)
  const [lastShown, setLastShown] = useState(shown)
  const [error, setError] = useState<string | null>(null)
  // The value changed elsewhere (undo, another field): show it.
  if (lastShown !== shown) {
    setLastShown(shown)
    setText(shown)
  }
  const commit = () => {
    const r = parseDim(text, params, unit)
    if ('error' in r) {
      setError(r.error)
      return
    }
    setError(null)
    // Leaving the field without a change (e.g. clicking Undo) must not add a step to undo.
    if (JSON.stringify(r.dim) !== JSON.stringify(value)) onChange(r.dim)
  }
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <FieldDescription className={error ? 'text-danger-600' : undefined} role={error ? 'alert' : undefined}>
        {error ?? (unit === 'in' ? 'Inches, a parameter (e.g. height) or a formula (e.g. height / 2 + 1in)' : 'Degrees, a parameter or a formula')}
      </FieldDescription>
    </Field>
  )
}
