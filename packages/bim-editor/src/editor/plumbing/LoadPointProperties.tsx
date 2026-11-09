'use client'

import { useMemo, useState } from 'react'
import { Link2Off, Trash2 } from 'lucide-react'
import {
  QUANTITIES,
  connectionTypeOfLoadPoint,
  elementValues,
  formatQuantity,
  loadPointFindingsFor,
  loadPointLabel,
  loadPointLoad,
  loadPointQuantities,
  loadPointSystemKind,
  primaryQuantity,
  runEndOf,
  type CatalogTrade,
  type Command,
  type LoadPointElement,
  type ModelState,
  type QuantityKey,
  type SystemKind,
} from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { ConfirmAction } from '../../ui/confirm-action'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { ConnectionTypeSelect } from '../connection-types/ConnectionTypeSelect'

/** Which connection types a pipe end lists: gas on gas, air on duct, plumbing on the rest. */
export function tradeForSystem(kind: SystemKind | null, domain: string | null): CatalogTrade {
  if (domain === 'duct') return 'mechanical'
  if (kind === 'natural_gas') return 'gas'
  return 'plumbing'
}

/** The values a load point's form shows, by trade: few, the ones that trade sizes with. */
const FIELDS: Readonly<Record<CatalogTrade, readonly QuantityKey[]>> = {
  plumbing: ['wsfu_cold', 'wsfu_hot', 'wsfu_total', 'dfu', 'gph_demand'],
  gas: ['mbh', 'min_inlet_pressure'],
  mechanical: ['cfm'],
  electrical: ['va'],
}

const FIXTURE_CATEGORIES = new Set(['plumbing_fixture', 'pipe_accessory', 'mechanical_equipment', 'air_terminal'])

/**
 * A load point's properties: what is connected at this pipe end, its
 * connection type and loads (the type's values, with this point's own on
 * top), the fixture it stands for, and what it adds to the pipe. Every edit
 * is one undoable command, the same one bim_edit_load_point sends.
 */
export function LoadPointProperties({ model, point, canEdit, onCommand }: { readonly model: ModelState; readonly point: LoadPointElement; readonly canEdit: boolean; readonly onCommand: (command: Command) => string | null }) {
  const runEnd = runEndOf(point)
  const host = runEnd ? model.elements[runEnd.elementId] : undefined
  const kind = loadPointSystemKind(model.elements, point)
  const trade = tradeForSystem(kind, host?.kind === 'run_segment' || host?.kind === 'run_fitting' ? host.domain : null)
  const bag = loadPointQuantities(model.elements, point)
  const type = connectionTypeOfLoadPoint(model.elements, point)
  const findings = loadPointFindingsFor(model.elements, point)
  const adds = primaryQuantity(kind)
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS[trade].map((k) => [k, point.values[k] === undefined ? '' : String(point.values[k])])))
  const [mark, setMark] = useState(point.mark ?? '')
  const [fixture, setFixture] = useState('')
  const [error, setError] = useState<string | null>(null)
  const blocked = canEdit ? null : "Live editing isn't connected, so changes can't be saved"
  const fixtures = useMemo(
    () =>
      elementValues(model.elements).flatMap((el) => {
        if (el.kind !== 'part') return []
        const t = model.elements[el.typeId]
        return t?.kind === 'part_type' && FIXTURE_CATEGORIES.has(t.definition.category) ? [{ id: el.id, name: `${el.mark || t.definition.familyName}${el.mark ? ` · ${t.definition.familyName}` : ''}` }] : []
      }),
    [model.elements],
  )
  const send = (command: Command) => setError(onCommand(command))

  const saveValues = (e: React.FormEvent) => {
    e.preventDefault()
    const values: Record<string, number> = {}
    const reset: QuantityKey[] = []
    for (const k of FIELDS[trade]) {
      const raw = (draft[k] ?? '').trim()
      if (raw === '') {
        if (point.values[k] !== undefined) reset.push(k)
        continue
      }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return setError(`${QUANTITIES[k].label} must be a number, 0 or more.`)
      values[k] = n
    }
    send({ type: 'edit_load_point', loadPointId: point.id, values, ...(reset.length > 0 ? { reset } : {}), ...(mark.trim() !== (point.mark ?? '') ? { mark: mark.trim() } : {}) })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="load-point-properties" data-load-point-id={point.id}>
      <span className="text-sm font-medium">{loadPointLabel(model.elements, point)}</span>
      {findings.map((f) => (
        <Alert key={f.code} className="border-warning-300 bg-warning-50">
          <AlertDescription className="text-xs">{f.message}</AlertDescription>
        </Alert>
      ))}
      <FieldDescription className="text-xs" data-testid="load-point-adds">
        {adds ? `Adds ${formatQuantity(adds, loadPointLoad(model.elements, point))} to this pipe` : 'Adds nothing this pipe sizes on (vent)'}
        {point.schematic ? ' · a lump to break out later' : ''}
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor={`lp-type-${point.id}`} className="text-xs">
          Connection type
        </FieldLabel>
        <ConnectionTypeSelect
          model={model}
          trade={trade}
          id={`lp-type-${point.id}`}
          value={point.connectionType || '__none__'}
          noneLabel="None (only this point's own values)"
          disabled={!canEdit}
          testId="load-point-connection-type"
          onChange={(v) => send({ type: 'edit_load_point', loadPointId: point.id, connectionType: v === '__none__' ? '' : v })}
        />
        {type && <FieldDescription className="text-xs">{type.comments ? `${type.comments}. ` : ''}Editing the type changes every point and fixture naming it.</FieldDescription>}
      </Field>
      <form onSubmit={saveValues} className="flex flex-col gap-2" data-testid="load-point-values">
        <FieldGroup className="grid grid-cols-2 gap-2">
          {FIELDS[trade].map((k) => (
            <Field key={k}>
              <FieldLabel htmlFor={`lp-${k}-${point.id}`} className="text-xs">
                {QUANTITIES[k].label} ({QUANTITIES[k].unit})
              </FieldLabel>
              <Input
                id={`lp-${k}-${point.id}`}
                inputMode="decimal"
                value={draft[k] ?? ''}
                placeholder={bag[k] === undefined ? '—' : `${bag[k]} from ${point.connectionType || 'type'}`}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                disabled={!canEdit}
              />
            </Field>
          ))}
          <Field>
            <FieldLabel htmlFor={`lp-mark-${point.id}`} className="text-xs">
              Fixture mark
            </FieldLabel>
            <Input id={`lp-mark-${point.id}`} value={mark} placeholder="K01-2" onChange={(e) => setMark(e.target.value)} disabled={!canEdit} />
          </Field>
        </FieldGroup>
        <FieldDescription className="text-xs">Blank uses the connection type&apos;s value. A fixture&apos;s cold and hot points share its mark, so the service counts its total units.</FieldDescription>
        <Button type="submit" size="sm" disabled={!canEdit} title={blocked ?? undefined} data-testid="load-point-save">
          Save loads
        </Button>
      </form>
      <Separator />
      {point.attachedPartId ? (
        <div className="flex items-center gap-2">
          <FieldDescription className="flex-1 text-xs" data-testid="load-point-fixture">
            Stands for {fixtures.find((f) => f.id === point.attachedPartId)?.name ?? point.attachedPartId}; its loads are this point&apos;s.
          </FieldDescription>
          <Button size="sm" variant="outline" disabled={!canEdit} title={blocked ?? 'The point keeps its loads'} onClick={() => send({ type: 'detach_part_from_load_point', loadPointId: point.id })}>
            <Link2Off data-icon="inline-start" />
            Detach
          </Button>
        </div>
      ) : (
        <Field>
          <FieldLabel htmlFor={`lp-fixture-${point.id}`} className="text-xs">
            Attach a fixture
          </FieldLabel>
          <div className="flex gap-1">
            <Select value={fixture} onValueChange={setFixture} disabled={!canEdit || fixtures.length === 0}>
              <SelectTrigger id={`lp-fixture-${point.id}`} size="sm" className="flex-1">
                <SelectValue placeholder={fixtures.length === 0 ? 'No fixtures placed yet' : 'Pick the fixture'} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {fixtures.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!canEdit || fixture === ''} title={fixture === '' ? 'Pick the fixture first' : (blocked ?? undefined)} onClick={() => send({ type: 'attach_part_to_load_point', loadPointId: point.id, partId: fixture })}>
              Attach
            </Button>
          </div>
          <FieldDescription className="text-xs">It takes this point&apos;s connection type and loads; totals don&apos;t change.</FieldDescription>
        </Field>
      )}
      {error && (
        <FieldDescription className="text-xs text-danger-600" role="alert" data-testid="load-point-error">
          {error}
        </FieldDescription>
      )}
      <ConfirmAction title="Delete this load point?" description="The pipe stops carrying its loads. An attached fixture stays, with its connection type. Undo brings it back." confirmLabel="Delete" destructive onConfirm={() => send({ type: 'delete_load_points', loadPointIds: [point.id] })}>
        <Button variant="outline" size="sm" disabled={!canEdit} title={blocked ?? undefined}>
          <Trash2 data-icon="inline-start" />
          Delete load point
        </Button>
      </ConfirmAction>
    </div>
  )
}
