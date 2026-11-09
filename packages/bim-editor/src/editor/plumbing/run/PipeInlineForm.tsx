'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { fittingFamilies, familyMismatch, type Command, type FittingFamily, type ModelState, type RunSegment } from '@permitzip/bim-kernel'
import { Button } from '../../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../../ui/field'
import { Input } from '../../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../../ui/select'

const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"
const MM_PER_FT = 304.8

type AccessoryKind = NonNullable<NonNullable<FittingFamily['pipe']>['accessory']>

/** How a plumber looks for an inline item (review video V1 3:12: "a menu of these kind of fittings"). */
const GROUPS: readonly { readonly label: string; readonly kinds: readonly AccessoryKind[] }[] = [
  { label: 'Fittings', kinds: ['coupling', 'union'] },
  { label: 'Cleanouts', kinds: ['cleanout', 'test_tee'] },
  { label: 'Valves', kinds: ['valve', 'prv'] },
  { label: 'Traps', kinds: ['trap'] },
  { label: 'Gas', kinds: ['gas_cock', 'drip_leg'] },
]

/** The inline items this pipe takes, by group; empty groups are left out. */
export function inlineChoices(segment: RunSegment, model: ModelState): { label: string; families: FittingFamily[] }[] {
  const system = model.elements[segment.systemId]
  if (system?.kind !== 'mep_system') return []
  const fits = fittingFamilies().filter((f) => f.fittingTypes.includes('accessory') && familyMismatch(f, { fittingType: 'accessory', domain: 'pipe', sizes: [segment.size], systemKind: system.systemKind }) === null)
  const grouped = GROUPS.map((g) => ({ label: g.label, families: fits.filter((f) => f.pipe?.accessory !== undefined && g.kinds.includes(f.pipe.accessory)) }))
  const rest = fits.filter((f) => !GROUPS.some((g) => f.pipe?.accessory !== undefined && g.kinds.includes(f.pipe.accessory)))
  return [...grouped, ...(rest.length > 0 ? [{ label: 'Other', families: rest }] : [])].filter((g) => g.families.length > 0)
}

/**
 * Add inline on the selected pipe: cleanouts, test tees, traps, valves,
 * couplings and gas items, grouped, at the top of the pipe's properties.
 * Placed at the given distance from the pipe's start (the middle by default);
 * drag it in the view to slide it along the pipe.
 */
export function PipeInlineForm({ segment, model, canEdit, onCommand }: { segment: RunSegment; model: ModelState; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y, segment.end.z - segment.start.z)
  const [family, setFamily] = useState<string | undefined>(undefined)
  const [at, setAt] = useState(String(Math.round((length / 2 / MM_PER_FT) * 100) / 100))
  const [error, setError] = useState<string | null>(null)
  const groups = inlineChoices(segment, model)
  if (groups.length === 0) return null
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ft = Number(at)
    if (!family) {
      setError('Choose what to add.')
      return
    }
    if (!(ft > 0)) {
      setError('Enter how far along the pipe, in feet from its start.')
      return
    }
    setError(onCommand({ type: 'place_run_accessory', accessoryId: `acc-${segment.id}-${Date.now().toString(36)}`, segmentId: segment.id, atMm: Math.round(ft * MM_PER_FT * 1000) / 1000, family }))
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="pipe-accessory">
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field>
          <FieldLabel htmlFor="bm-pipe-accessory">Add inline</FieldLabel>
          <Select value={family} onValueChange={setFamily} disabled={!canEdit}>
            <SelectTrigger id="bm-pipe-accessory" size="sm" title={canEdit ? undefined : NOT_LIVE}>
              <SelectValue placeholder="Cleanout, trap, valve…" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.families.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-pipe-accessory-at">Ft from start</FieldLabel>
          <Input id="bm-pipe-accessory-at" inputMode="decimal" value={at} onChange={(e) => setAt(e.target.value)} disabled={!canEdit} />
        </Field>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE}>
        <Plus data-icon="inline-start" />
        Add to this pipe
      </Button>
      {error ? (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      ) : (
        <FieldDescription>Drag it in the view afterwards to slide it along the pipe.</FieldDescription>
      )}
    </form>
  )
}
