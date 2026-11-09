'use client'

import { useState } from 'react'
import { workingSpaceZone } from '@permitzip/bim-pack-electrical/host'
import {
  CLEARANCE_FACES,
  CLEARANCE_PURPOSE_LABELS,
  hostState,
  localBounds,
  partClearances,
  resolveGeometry,
  slabsUnder,
  type ClearanceFace,
  type ClearanceOverride,
  type Command,
  type ModelState,
  type PartInstance,
  type PartTypeDefinition,
} from '@permitzip/bim-kernel'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { Input } from '../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { MM_PER_FT, MM_PER_IN, feetInches } from './placement'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { NEC_EDITIONS, useNecRulesFrom } from './electrical/use-nec-rules'

/**
 * Where a placed part stands and the space it needs, in the Properties
 * panel: its host (our slab or a linked roof) with the curb, and its
 * clearance zones, each changeable for this part only. Every button sends the
 * same kernel command the agent's tools send (set_part_host,
 * set_part_clearances).
 */

interface Props {
  projectId: string
  model: ModelState
  part: PartInstance
  type: PartTypeDefinition | null
  canEdit: boolean
  onCommand: (command: Command) => string | null
}

const STATUS_BADGE = { seated: 'secondary', floating: 'destructive', buried: 'destructive', missing: 'destructive', none: 'outline' } as const
const STATUS_WORDS = { seated: 'On its host', floating: 'Floating', buried: 'Sunk in', missing: 'Host gone', none: 'No host' } as const
const NO_EDIT = "Live editing isn't connected, so changes can't be saved"

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

export function PartSpaceProperties({ projectId, model, part, type, canEdit, onCommand }: Props) {
  const host = hostState(model, part)
  const zones = partClearances(model, part)
  const decks = slabsUnder(model, part.position)
  const [curbIn, setCurbIn] = useState(String(round((part.curbMm ?? 0) / MM_PER_IN, 2)))
  const [deck, setDeck] = useState<string>(decks[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const send = (command: Command) => setError(onCommand(command))
  const curbMm = (): number | null | undefined => {
    const n = Number(curbIn)
    if (!Number.isFinite(n) || n < 0) {
      setError('Curb height must be a number of inches, 0 or more.')
      return undefined
    }
    return n === 0 ? null : round(n * MM_PER_IN, 1)
  }
  const sitOn = () => {
    const c = curbMm()
    if (c === undefined) return
    if (part.host && host.status !== 'missing') send({ type: 'set_part_host', ids: [part.id], host: part.host, curbMm: c })
    else if (deck) send({ type: 'set_part_host', ids: [part.id], host: { kind: 'slab', elementId: deck }, curbMm: c })
  }
  const sitDisabled = !canEdit ? NO_EDIT : !part.host && !deck ? 'None of our slabs is under it; place it again by pointing at the roof or floor in 3D' : null

  return (
    <div className="flex flex-col gap-3" data-testid="part-space-properties">
      <FieldSet>
        <FieldLegend variant="label">Stands on</FieldLegend>
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs" data-testid="part-host-label">
            {host.label}
          </span>
          <Badge variant={STATUS_BADGE[host.status]} data-testid="part-host-status" data-state={host.status}>
            {STATUS_WORDS[host.status]}
          </Badge>
        </div>
        {(!part.host || host.status === 'missing') && decks.length > 0 && (
          <Field>
            <FieldLabel htmlFor="bm-part-deck">Our slab under it</FieldLabel>
            <Select value={deck || undefined} onValueChange={setDeck} disabled={!canEdit}>
              <SelectTrigger id="bm-part-deck" size="sm">
                <SelectValue placeholder="Choose a slab" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {decks.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} (top {feetInches(d.topMm)})
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="bm-part-curb">Curb or rail (in)</FieldLabel>
          <Input id="bm-part-curb" inputMode="decimal" value={curbIn} onChange={(e) => setCurbIn(e.target.value)} disabled={!canEdit} />
        </Field>
        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-1">
                <Button type="button" size="sm" className="w-full" onClick={sitOn} disabled={sitDisabled !== null} data-testid="part-host-seat">
                  Sit on it
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{sitDisabled ?? 'Moves the part onto its host plus the curb'}</TooltipContent>
          </Tooltip>
          <Button type="button" size="sm" variant="outline" onClick={() => send({ type: 'set_part_host', ids: [part.id], host: null, curbMm: null })} disabled={!canEdit || !part.host}>
            Remove host
          </Button>
        </div>
      </FieldSet>
      <ClearanceList projectId={projectId} model={model} part={part} type={type} zones={zones} canEdit={canEdit} send={send} />
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </div>
  )
}

function ClearanceList({
  projectId,
  part,
  type,
  zones,
  canEdit,
  send,
}: {
  projectId: string
  model: ModelState
  part: PartInstance
  type: PartTypeDefinition | null
  zones: ReturnType<typeof partClearances>
  canEdit: boolean
  send: (command: Command) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const typeIds = new Set((type?.clearances ?? []).map((z) => z.id))
  const offZones = Object.entries(part.clearances ?? {}).filter(([id, o]) => o.off && typeIds.has(id))
  return (
    <FieldSet>
      <FieldLegend variant="label">Clearances</FieldLegend>
      {zones.length === 0 && offZones.length === 0 && <p className="text-xs text-muted-foreground">No clearance zones. Add them in the part editor (every part of the type), or add working space below.</p>}
      <ItemGroup className="gap-1" aria-label="Clearance zones">
        {zones.map((z) => {
          const depth = z.face === 'front' || z.face === 'back' ? z.max[0] - z.min[0] : z.face === 'left' || z.face === 'right' ? z.max[1] - z.min[1] : z.max[2] - z.min[2]
          return (
            <Item key={z.id} size="xs" data-testid={`clearance-${z.id}`}>
              <ItemContent>
                <ItemTitle className="text-xs font-normal">
                  {z.name}
                  {z.overridden ? ' (this part)' : ''}
                </ItemTitle>
                <ItemDescription className="text-xs">
                  {CLEARANCE_PURPOSE_LABELS[z.purpose]} · {z.face} · {feetInches(depth)} deep{z.basis ? ` · NEC ${z.basis.edition} 110.26, condition ${z.basis.condition}` : ''}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(editing === z.id ? null : z.id)} disabled={!canEdit}>
                  {editing === z.id ? 'Close' : 'Change'}
                </Button>
              </ItemActions>
            </Item>
          )
        })}
        {offZones.map(([id]) => (
          <Item key={id} size="xs">
            <ItemContent>
              <ItemTitle className="text-xs font-normal">{type?.clearances?.find((z) => z.id === id)?.name ?? id} (off for this part)</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button type="button" size="sm" variant="ghost" onClick={() => send({ type: 'set_part_clearances', id: part.id, scope: 'instance', overrides: { [id]: null } })} disabled={!canEdit}>
                Turn back on
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {editing && <ZoneEditor key={editing} part={part} zone={zones.find((z) => z.id === editing) ?? null} fromType={typeIds.has(editing)} send={send} onDone={() => setEditing(null)} />}
      {type && (type.category === 'electrical_equipment' || type.connectors.some((c) => c.domain === 'electrical')) && <WorkingSpaceForm projectId={projectId} part={part} type={type} canEdit={canEdit} send={send} />}
    </FieldSet>
  )
}

function ZoneEditor({ part, zone, fromType, send, onDone }: { part: PartInstance; zone: ReturnType<typeof partClearances>[number] | null; fromType: boolean; send: (command: Command) => void; onDone: () => void }) {
  const depthOf = (z: NonNullable<typeof zone>) => (z.face === 'front' || z.face === 'back' ? z.max[0] - z.min[0] : z.face === 'left' || z.face === 'right' ? z.max[1] - z.min[1] : z.max[2] - z.min[2])
  const [depthFt, setDepthFt] = useState(zone ? String(round(depthOf(zone) / MM_PER_FT, 3)) : '')
  const [offsetFt, setOffsetFt] = useState(String(round((part.clearances?.[zone?.id ?? '']?.offset ?? 0) / MM_PER_FT, 3)))
  const [face, setFace] = useState<ClearanceFace>(zone?.face ?? 'front')
  if (!zone) return null
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const d = Number(depthFt)
    const o = Number(offsetFt)
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(o)) return
    const override: ClearanceOverride = { ...(part.clearances?.[zone.id] ?? {}), depth: round(d * MM_PER_FT, 1), offset: round(o * MM_PER_FT, 1), face }
    send({ type: 'set_part_clearances', id: part.id, scope: 'instance', overrides: { [zone.id]: override } })
    onDone()
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-md border border-border p-2" data-testid="clearance-editor">
      <FieldGroup className="grid grid-cols-3 gap-2">
        <Field>
          <FieldLabel htmlFor="bm-zone-depth">Depth (ft)</FieldLabel>
          <Input id="bm-zone-depth" inputMode="decimal" value={depthFt} onChange={(e) => setDepthFt(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-zone-offset">Slide (ft)</FieldLabel>
          <Input id="bm-zone-offset" inputMode="decimal" value={offsetFt} onChange={(e) => setOffsetFt(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-zone-face">Side</FieldLabel>
          <Select value={face} onValueChange={(v) => setFace(v as ClearanceFace)}>
            <SelectTrigger id="bm-zone-face" size="sm">
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
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">
          Save for this part
        </Button>
        {fromType && (
          <Button type="button" size="sm" variant="outline" onClick={() => (send({ type: 'set_part_clearances', id: part.id, scope: 'instance', overrides: { [zone.id]: { off: true } } }), onDone())}>
            Turn off here
          </Button>
        )}
        {part.clearances?.[zone.id] && (
          <Button type="button" size="sm" variant="ghost" onClick={() => (send({ type: 'set_part_clearances', id: part.id, scope: 'instance', overrides: { [zone.id]: null } }), onDone())}>
            {fromType ? 'Back to the type' : 'Remove'}
          </Button>
        )}
      </div>
    </form>
  )
}

function WorkingSpaceForm({ projectId, part, type, canEdit, send }: { projectId: string; part: PartInstance; type: PartTypeDefinition; canEdit: boolean; send: (command: Command) => void }) {
  const nec = useNecRulesFrom(useEditorHost().data.codeAdoption, projectId)
  const saved = part.clearances?.working_space?.basis ?? type.clearances?.find((z) => z.purpose === 'working_space')?.basis
  const [volts, setVolts] = useState(String(saved?.voltageToGround ?? 120))
  const [condition, setCondition] = useState<'1' | '2' | '3'>(saved ? (String(saved.condition) as '1' | '2' | '3') : '1')
  const [double, setDouble] = useState((saved?.depthMultiplier ?? 1) > 1)
  const [error, setError] = useState<string | null>(null)
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const v = Number(volts)
    if (!nec.necEdition) {
      setError('Choose the NEC edition first: the Code Study has none.')
      return
    }
    const b = localBounds(resolveGeometry(type, part.values))
    const made = workingSpaceZone(nec.necEdition, { voltageToGround: v, condition: Number(condition) as 1 | 2 | 3, equipmentWidthMm: b.max[1] - b.min[1], equipmentHeightMm: b.max[2] - b.min[2], ...(double ? { depthMultiplier: 2 } : {}) })
    if (!made.zone) {
      setError(made.reason)
      return
    }
    setError(null)
    const { space, zone } = made
    send({ type: 'set_part_clearances', id: part.id, scope: 'instance', overrides: { [zone.id]: { name: zone.name, purpose: zone.purpose, face: zone.face, depth: space.depthMm, width: space.widthMm, height: space.heightMm, fromFloor: true, ...(zone.basis ? { basis: zone.basis } : {}) } } })
  }
  return (
    <form onSubmit={add} className="flex flex-col gap-2" data-testid="working-space-form">
      <FieldGroup className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="bm-ws-volts">Volts to ground</FieldLabel>
          <Input id="bm-ws-volts" inputMode="decimal" value={volts} onChange={(e) => setVolts(e.target.value)} disabled={!canEdit} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-ws-condition">Condition</FieldLabel>
          <Select value={condition} onValueChange={(v) => setCondition(v as '1' | '2' | '3')} disabled={!canEdit}>
            <SelectTrigger id="bm-ws-condition" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="1">1: nothing opposite</SelectItem>
                <SelectItem value="2">2: grounded parts opposite</SelectItem>
                <SelectItem value="3">3: live parts opposite</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      <FieldDescription className="text-xs">{nec.label}</FieldDescription>
      {nec.source !== 'project' && (
        <Field>
          <FieldLabel htmlFor="bm-ws-edition">NEC edition</FieldLabel>
          <Select value={nec.edition ?? undefined} onValueChange={(v) => nec.pick(NEC_EDITIONS.find((e) => e === v) ?? null)} disabled={!canEdit}>
            <SelectTrigger id="bm-ws-edition" size="sm">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {NEC_EDITIONS.map((e) => (
                  <SelectItem key={e} value={e}>
                    NEC {e}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field orientation="horizontal">
        <Checkbox id="bm-ws-double" checked={double} onCheckedChange={(v) => setDouble(v === true)} disabled={!canEdit} />
        <FieldLabel htmlFor="bm-ws-double" className="font-normal">
          Double the depth (as noted on the drawings)
        </FieldLabel>
      </Field>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button type="submit" size="sm" variant="outline" className="w-full" disabled={!canEdit} data-testid="working-space-add">
              Set NEC 110.26 working space
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? 'Depth from Table 110.26(A)(1); at least 30 in. wide and 6½ ft high, from the floor' : NO_EDIT}</TooltipContent>
      </Tooltip>
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </form>
  )
}
