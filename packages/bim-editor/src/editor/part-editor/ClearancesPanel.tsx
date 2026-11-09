'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { dedicatedSpaceZone } from '@permitzip/bim-pack-electrical'
import { CLEARANCE_FACES, CLEARANCE_PURPOSES, CLEARANCE_PURPOSE_LABELS, type ClearanceFace, type ClearancePurpose, type ClearanceZone } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { Draft } from './draft'

/**
 * The part type's clearance zones in the part editor: the space every placed
 * part of this type keeps clear (service access, combustibles, economizer
 * access, working space). Saved with the definition; placed parts can change
 * or switch one off for themselves in Properties. Feet here, millimetres in
 * the definition.
 */

const MM_PER_FT = 304.8
const ft = (mm: number) => Math.round((mm / MM_PER_FT) * 1000) / 1000

const DEFAULT_NAME: Readonly<Record<ClearancePurpose, string>> = {
  service_access: 'Service access',
  combustible: 'Clearance to combustibles',
  economizer_access: 'Economizer access',
  working_space: 'Working space',
  keep_out: 'Keep clear',
  dedicated_space: 'Dedicated space above',
}

function withClearances(d: Draft, zones: readonly ClearanceZone[]): Draft {
  const { clearances: _old, ...rest } = d.definition
  return { ...d, definition: zones.length > 0 ? { ...rest, clearances: [...zones] } : rest }
}

function freshZoneId(purpose: ClearancePurpose, used: ReadonlySet<string>): string {
  const base = purpose === 'economizer_access' ? 'economizer' : purpose === 'service_access' ? 'service' : purpose
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}_${i}`)) i += 1
  return `${base}_${i}`
}

export function ClearancesPanel({ draft, canEdit, edit }: { draft: Draft; canEdit: boolean; edit: (next: Draft | ((d: Draft) => Draft)) => void }) {
  const zones = draft.definition.clearances ?? []
  const [purpose, setPurpose] = useState<ClearancePurpose>('service_access')
  const [face, setFace] = useState<ClearanceFace>('front')
  const [depthFt, setDepthFt] = useState('3')
  const [error, setError] = useState<string | null>(null)
  const add = () => {
    const d = Number(depthFt)
    if (purpose !== 'dedicated_space' && (!Number.isFinite(d) || d <= 0)) {
      setError('Depth must be a number of feet greater than 0.')
      return
    }
    setError(null)
    const id = freshZoneId(purpose, new Set(zones.map((z) => z.id)))
    // NEC 110.26(E) fixes the dedicated space (the top face, 6 ft or to structure, ducts and pipes kept out); the side and depth typed here don't apply to it.
    const zone: ClearanceZone =
      purpose === 'dedicated_space'
        ? dedicatedSpaceZone(null, { id, name: DEFAULT_NAME.dedicated_space })
        : { id, name: DEFAULT_NAME[purpose], purpose, face, depth: Math.round(d * MM_PER_FT * 10) / 10, ...(purpose === 'working_space' ? { fromFloor: true } : {}) }
    edit((cur) => withClearances(cur, [...(cur.definition.clearances ?? []), zone]))
  }
  const update = (id: string, change: (z: ClearanceZone) => ClearanceZone) => edit((cur) => withClearances(cur, (cur.definition.clearances ?? []).map((z) => (z.id === id ? change(z) : z))))
  return (
    <FieldGroup className="gap-3" data-testid="part-editor-clearances">
      <span className="text-sm font-medium">Clearances</span>
      <ItemGroup className="gap-2">
        {zones.map((z) => (
          <Item key={z.id} size="xs" variant="outline">
            <ItemContent className="gap-2">
              <ItemTitle className="text-xs">{z.name}</ItemTitle>
              <ItemDescription className="text-xs">
                {CLEARANCE_PURPOSE_LABELS[z.purpose]} · {z.face}
              </ItemDescription>
              <FieldGroup className="grid grid-cols-2 gap-2">
                <Field>
                  <FieldLabel htmlFor={`pe-zone-${z.id}-depth`}>Depth (ft)</FieldLabel>
                  <Input
                    id={`pe-zone-${z.id}-depth`}
                    inputMode="decimal"
                    defaultValue={typeof z.depth === 'number' ? String(ft(z.depth)) : ''}
                    disabled={!canEdit || typeof z.depth !== 'number'}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) update(z.id, (cur) => ({ ...cur, depth: Math.round(n * MM_PER_FT * 10) / 10 }))
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`pe-zone-${z.id}-offset`}>Slide (ft)</FieldLabel>
                  <Input
                    id={`pe-zone-${z.id}-offset`}
                    inputMode="decimal"
                    defaultValue={typeof z.offset === 'number' ? String(ft(z.offset)) : '0'}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      if (!Number.isFinite(n)) return
                      update(z.id, ({ offset: _old, ...cur }) => (n === 0 ? cur : { ...cur, offset: Math.round(n * MM_PER_FT * 10) / 10 }))
                    }}
                  />
                </Field>
              </FieldGroup>
              <Field orientation="horizontal">
                <Checkbox id={`pe-zone-${z.id}-floor`} checked={z.fromFloor === true} onCheckedChange={(v) => update(z.id, (cur) => ({ ...cur, fromFloor: v === true }))} disabled={!canEdit} />
                <FieldLabel htmlFor={`pe-zone-${z.id}-floor`} className="font-normal">
                  Measured from the floor
                </FieldLabel>
              </Field>
            </ItemContent>
            <ItemActions>
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${z.name}`} onClick={() => edit((cur) => withClearances(cur, (cur.definition.clearances ?? []).filter((x) => x.id !== z.id)))} disabled={!canEdit}>
                <Trash2 data-icon="inline-start" />
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {zones.length === 0 && <p className="text-xs text-muted-foreground">No clearances yet. They draw dashed around every placed part and are never solid.</p>}
      <FieldGroup className="grid grid-cols-3 gap-2">
        <Field className="col-span-3">
          <FieldLabel htmlFor="pe-zone-purpose">Kind</FieldLabel>
          <Select value={purpose} onValueChange={(v) => setPurpose(v as ClearancePurpose)} disabled={!canEdit}>
            <SelectTrigger id="pe-zone-purpose" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {CLEARANCE_PURPOSES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {CLEARANCE_PURPOSE_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="col-span-2">
          <FieldLabel htmlFor="pe-zone-face">Side</FieldLabel>
          <Select value={face} onValueChange={(v) => setFace(v as ClearanceFace)} disabled={!canEdit}>
            <SelectTrigger id="pe-zone-face" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {CLEARANCE_FACES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="pe-zone-depth">Depth (ft)</FieldLabel>
          <Input id="pe-zone-depth" inputMode="decimal" value={depthFt} onChange={(e) => setDepthFt(e.target.value)} disabled={!canEdit} />
        </Field>
      </FieldGroup>
      <Button type="button" size="sm" variant="outline" onClick={add} disabled={!canEdit} data-testid="part-editor-add-clearance">
        <Plus data-icon="inline-start" />
        Add clearance
      </Button>
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
      <FieldDescription className="text-xs">For NEC 110.26 working space sized from voltage and condition, use Set NEC 110.26 working space in a placed panel&apos;s Properties.</FieldDescription>
    </FieldGroup>
  )
}
