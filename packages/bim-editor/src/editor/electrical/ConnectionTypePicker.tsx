'use client'

import { useMemo, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { connectionTypeSummary, type ModelState } from '@permitzip/bim-kernel'
import { connectionTypesFor } from '../connection-types/ConnectionTypeSelect'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { SubmitCommand } from '../views-sheets/types'

const NONE = '__none__'
const MIXED = '__mixed__'

/**
 * Connection type on the selected devices: pick a designator (E.05) and their
 * load, voltage, poles and class come from it; None goes back to the part's
 * own values. One undoable edit per device. Manage opens Electrical types.
 */
export function ConnectionTypePicker({ model, ids, submit, editBlocked, onManage }: { readonly model: ModelState; readonly ids: readonly string[]; readonly submit: SubmitCommand; readonly editBlocked: string | null; readonly onManage: () => void }) {
  // Electrical records, and any other trade's record with a power connection (a dishwasher's one record).
  const records = useMemo(() => connectionTypesFor(model, 'electrical').map((entry) => ({ entry })), [model])
  const [error, setError] = useState<string | null>(null)
  const values = new Set(
    ids.map((id) => {
      const el = model.elements[id]
      const v = el?.kind === 'part' ? el.values.connection_type : undefined
      return typeof v === 'string' && v.trim() !== '' ? v : NONE
    }),
  )
  const current = values.size === 1 ? ([...values][0] ?? NONE) : MIXED
  const known = records.find((r) => r.entry.designator.toUpperCase() === current.toUpperCase())
  const choose = (v: string) => {
    if (v === MIXED) return
    for (const id of ids) {
      const refusal = submit({ type: 'set_parameters', id, scope: 'instance', values: { connection_type: v === NONE ? '' : v } }, v === NONE ? 'clear the connection type' : `use connection type ${v}`)
      if (refusal) return setError(refusal)
    }
    setError(null)
  }
  return (
    <Field>
      <FieldLabel htmlFor="bm-connection-type" className="text-xs">
        Connection type
      </FieldLabel>
      <div className="flex gap-1">
        <Select value={current} onValueChange={choose} disabled={editBlocked !== null}>
          <SelectTrigger id="bm-connection-type" size="sm" className="flex-1" title={editBlocked ?? undefined} data-testid="electrical-props-connection-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>None (the part&apos;s own values)</SelectItem>
              {current === MIXED && <SelectItem value={MIXED}>Different on each</SelectItem>}
              {current !== NONE && current !== MIXED && !known && <SelectItem value={current}>{current} (not in the project&apos;s types)</SelectItem>}
              {records.map((r) => (
                <SelectItem key={r.entry.designator} value={r.entry.designator}>
                  {r.entry.designator} · {r.entry.description || connectionTypeSummary(r.entry)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" aria-label="Manage connection types" onClick={onManage}>
          <Settings2 />
        </Button>
      </div>
      {known && <FieldDescription className="text-xs">{connectionTypeSummary(known.entry)}, {known.entry.loadClass}</FieldDescription>}
      {error && (
        <FieldDescription className="text-xs text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </Field>
  )
}
