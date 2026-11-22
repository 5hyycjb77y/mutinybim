'use client'

import { allMaterials, boundsRooms, elementsOfKind, elementValueSource, MATERIAL_ID_KEY, resolveElementMaterial, ROOM_BOUNDING_INSTANCE_KEY, starterElementTypes, type BimElement, type ElementTypeElement, type ModelState, type ParamValue } from '@permitzip/bim-kernel'
import { formatRating, ratingKindRow, ratingOf, ratingSourceOf } from '@permitzip/bim-kernel/rated-routes'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import type { SubmitCommand } from '../views-sheets/types'
import { EditTypeDialog, type NewTypeRequest } from './EditTypeDialog'
import { instanceRatingField } from './type-fields'
import { doorFlipCommand } from './tools/door-flips'
import { typeDescription } from './tools/tool-types'
import { WallBaseField, WallTopField } from './WallTopField'
import { OpeningSillField } from './OpeningSillField'

const TYPED_KINDS: ReadonlySet<string> = new Set(['wall', 'opening', 'slab', 'ceiling', 'column'])
const ARCH_ADDON_KINDS: ReadonlySet<string> = new Set(['architecture.roof', 'architecture.stair'])
const NO_TYPE = '__none__'
const NO_MATERIAL = '__default_material__'
const NEW_TYPE = '__new__'
const DUPLICATE_TYPE = '__duplicate__'
const FIRE = 'fire_resistance'

/** What one selected wall, door, window or floor is called here. */
function noun(el: BimElement): string {
  if (el.kind === 'opening') return el.openingType === 'door' || el.openingType === 'window' ? el.openingType : 'opening'
  return el.kind === 'slab' ? 'floor' : el.kind
}

function typeIdOf(el: BimElement): string | null {
  return 'typeId' in el && typeof el.typeId === 'string' ? el.typeId : null
}

type Props = {
  readonly model: ModelState | null
  readonly selectedIds: readonly string[]
  readonly submit: SubmitCommand
  readonly editBlocked: string | null
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  /** The model server stores wall tops tied to a level; absent: it does. */
  readonly tiesStored?: boolean
  /** The model server stores tops and bases bound to surfaces (`walls:surface_binding`); absent: it does. */
  readonly surfacesStored?: boolean
}

/**
 * The Architecture section of the properties panel for one selected wall,
 * door, window, floor or ceiling: its type (pick another, or make one with
 * New type… / Duplicate type…), its own fire rating over its type's, and,
 * for walls, whether it bounds rooms.
 */
export function ArchitectureProperties({ model, selectedIds, submit, editBlocked, notify, tiesStored = true, surfacesStored = true }: Props): ReactNode {
  const [making, setMaking] = useState<NewTypeRequest | null>(null)
  const el = model && selectedIds.length === 1 ? model.elements[selectedIds[0] ?? ''] : undefined
  if (!model || !el) return null
  if (ARCH_ADDON_KINDS.has(el.kind)) {
    return <ArchAddonInspector model={model} el={el} submit={submit} editBlocked={editBlocked} notify={notify} />
  }
  if (!TYPED_KINDS.has(el.kind)) return null
  const types = elementsOfKind(model.elements, 'element_type').filter((t) => !t.forKinds || t.forKinds.includes(el.kind))
  // Starter types the add-ons ship that the model doesn't have yet: picking one adds it with the change.
  const variant = el.kind === 'opening' ? el.openingType : undefined
  const starters = starterElementTypes().filter((r) => r.forKinds.includes(el.kind) && (r.variant === undefined || r.variant === variant) && !model.elements[r.id])
  const current = typeIdOf(el)
  const currentType = current ? model.elements[current] : undefined
  const ownType: ElementTypeElement | null = currentType?.kind === 'element_type' ? currentType : null
  const bounding = el.kind === 'wall' ? boundsRooms(el, model.elements) : null
  const what = noun(el)
  const blocked = editBlocked !== null
  return (
    <FieldGroup data-testid="architecture-properties">
      <Field>
        <FieldLabel htmlFor="architecture-type">Type</FieldLabel>
        <Select
          value={current ?? NO_TYPE}
          disabled={blocked}
          onValueChange={(v) => {
            if (v === NEW_TYPE || v === DUPLICATE_TYPE) {
              setMaking({ kind: el.kind, noun: what, from: v === DUPLICATE_TYPE ? ownType : null, assignTo: el.id })
              return
            }
            const err = submit({ type: 'set_element_type', elementIds: [el.id], typeId: v === NO_TYPE ? null : v }, `Change the ${what}'s type`)
            if (err) {
              console.error('[ArchitectureProperties] type change refused', { elementId: el.id, err })
              notify(err, 'error')
            }
          }}
        >
          <SelectTrigger id="architecture-type" aria-label={`The ${what}'s type`}>
            <SelectValue placeholder="No type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TYPE}>No type</SelectItem>
            {types.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
            {starters.map((r) => (
              <SelectItem key={r.id} value={r.id} data-testid="architecture-starter-type">
                {r.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW_TYPE} data-testid="architecture-new-type">
              New type…
            </SelectItem>
            {ownType ? (
              <SelectItem value={DUPLICATE_TYPE} data-testid="architecture-duplicate-type">
                Duplicate type…
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {blocked ? (
          <FieldDescription>{editBlocked}</FieldDescription>
        ) : ownType ? (
          <FieldDescription data-testid="architecture-type-words">{typeDescription(ownType.id) ?? `${ownType.name}: a type made in this model. Edit type… shows what it is made of.`}</FieldDescription>
        ) : types.length === 0 && starters.length === 0 ? (
          <FieldDescription>No {what} types in this model yet. A type is what the {what} is built as (its fire rating and the rest); pick New type… in this menu to make one.</FieldDescription>
        ) : (
          <FieldDescription data-testid="architecture-type-words">No type yet. A type is what the {what} is built as: choose a starter type, or pick New type… in this menu to make your own.</FieldDescription>
        )}
      </Field>
      {el.kind === 'wall' ? <WallTopField key={`top-${el.id}`} model={model} el={el} submit={submit} editBlocked={editBlocked} notify={notify} tiesStored={tiesStored} surfacesStored={surfacesStored} /> : null}
      {el.kind === 'wall' ? <WallBaseField key={`base-${el.id}`} model={model} el={el} submit={submit} editBlocked={editBlocked} notify={notify} surfacesStored={surfacesStored} /> : null}
      <MaterialField key={`mat-${el.id}`} model={model} el={el} what={what} submit={submit} editBlocked={editBlocked} notify={notify} />
      <FireRatingField key={el.id} model={model} el={el} type={ownType} what={what} submit={submit} editBlocked={editBlocked} notify={notify} />
      {bounding !== null ? (
        <Field orientation="horizontal">
          <Switch
            id="architecture-room-bounding"
            checked={bounding}
            disabled={blocked}
            onCheckedChange={(on) => {
              const err = submit({ type: 'set_element_values', elementIds: [el.id], values: { [ROOM_BOUNDING_INSTANCE_KEY]: on } }, on ? 'Let the wall bound rooms' : 'Stop the wall bounding rooms')
              if (err) {
                console.error('[ArchitectureProperties] room bounding refused', { elementId: el.id, err })
                notify(err, 'error')
              }
            }}
          />
          <FieldLabel htmlFor="architecture-room-bounding">Bounds rooms</FieldLabel>
        </Field>
      ) : null}
      {el.kind === 'opening' && (el.openingType === 'door' || el.openingType === 'window') ? <OpeningSillField key={`sill-${el.id}`} model={model} el={el} submit={submit} editBlocked={editBlocked} notify={notify} /> : null}
      {el.kind === 'opening' && el.openingType === 'door' ? <DoorFlips model={model} el={el} submit={submit} editBlocked={editBlocked} notify={notify} /> : null}
      {making ? <EditTypeDialog model={model} create={making} submit={submit} editBlocked={editBlocked} onClose={() => setMaking(null)} /> : null}
    </FieldGroup>
  )
}

/**
 * The element's own fire rating: empty reads its type's; a value set here
 * wins over the type and says so, with a way back to the type's.
 */
function FireRatingField({ model, el, type, what, submit, editBlocked, notify }: { readonly model: ModelState; readonly el: BimElement; readonly type: ElementTypeElement | null; readonly what: string; readonly submit: SubmitCommand; readonly editBlocked: string | null; readonly notify: Props['notify'] }): ReactNode {
  const row = ratingKindRow(FIRE)
  const source = ratingSourceOf(model.elements, el, FIRE)
  const field = instanceRatingField(el, type)
  const ownKey = field?.key
  const own = ownKey ? elementValueSource(model.elements, el, ownKey) : null
  const ownValue = own?.from === 'instance' ? own.value : undefined
  const shown = ownValue === undefined || ownValue === null ? '' : String(ownValue)
  const [text, setText] = useState(shown)
  const [why, setWhy] = useState<string | null>(null)
  // Undo, another person's edit or the reset button changes the stored value: the box follows it.
  const [synced, setSynced] = useState(shown)
  if (synced !== shown) {
    setSynced(shown)
    setText(shown)
  }
  if (!row || !source || !field || !ownKey) {
    return (
      <Field orientation="horizontal">
        <FieldLabel>Fire rating</FieldLabel>
        <Badge variant="outline" data-testid="architecture-fire-rating">
          Not rated
        </Badge>
      </Field>
    )
  }
  const words = (v: number | null) => (v === null ? 'Not rated' : formatRating(row, v))
  const typeWords = type ? `${type.name}: ${words(source.typeValue)}` : null

  const write = (values: Record<string, ParamValue | null>, label: string): boolean => {
    const err = submit({ type: 'set_element_values', elementIds: [el.id], values }, label)
    if (err) {
      console.error('[ArchitectureProperties] fire rating refused', { elementId: el.id, err })
      notify(err, 'error')
      return false
    }
    return true
  }
  // Clearing every rating key the element sets puts its type's rating back.
  const clearOwn = (): Record<string, null> => Object.fromEntries(source.ownKeys.map((k) => [k, null]))

  const commit = () => {
    const t = text.trim()
    if (t === shown) return setWhy(null)
    if (t === '') {
      setWhy(null)
      if (source.ownKeys.length > 0) write(clearOwn(), `Use the ${what}'s type's fire rating`)
      return
    }
    let value: ParamValue
    if (field.control === 'number') {
      const n = Number(t)
      if (!Number.isFinite(n) || n < 0) return setWhy(`Fire rating needs a number of hours; "${t}" isn't one.`)
      value = n
    } else value = t
    // Read it the way every check will before writing it, so a typo never lands as "not rated".
    const trial = { ...el, values: { ...('values' in el ? el.values : {}), [ownKey]: value } } as BimElement
    if (ratingOf(model.elements, trial, FIRE) === null && t !== '0') return setWhy(`"${t}" doesn't read as a fire rating. Type hours or minutes: 1, 1 hr, 90 min.`)
    setWhy(null)
    write({ ...clearOwn(), [ownKey]: value }, `Set the ${what}'s fire rating`)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      setText(shown)
      setWhy(null)
    }
  }

  return (
    <Field data-testid="architecture-fire-rating-field" data-overrides-type={source.differsFromType ? 'true' : 'false'}>
      <FieldLabel htmlFor="architecture-fire-rating-input">Fire rating</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id="architecture-fire-rating-input"
          className="h-8 w-28"
          value={text}
          disabled={editBlocked !== null}
          placeholder={source.typeValue !== null ? words(source.typeValue) : 'Not rated'}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-describedby="architecture-fire-rating-words"
        />
        <Badge variant={source.value === null ? 'outline' : 'secondary'} data-testid="architecture-fire-rating">
          {words(source.value)}
        </Badge>
      </div>
      <FieldDescription id="architecture-fire-rating-words" data-testid="architecture-fire-rating-source">
        {why ??
          (source.differsFromType
            ? `Differs from its type${typeWords ? ` (${typeWords})` : ''}: this ${what}'s own rating wins.`
            : source.ownKeys.length > 0
              ? `This ${what}'s own rating.`
              : typeWords
                ? `From its type (${typeWords}). Type a rating to set this ${what}'s own.`
                : `Type hours or minutes (1, 1 hr, 90 min) to rate this ${what}.`)}
      </FieldDescription>
      {source.ownKeys.length > 0 && type ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          data-testid="architecture-fire-rating-reset"
          disabled={editBlocked !== null}
          onClick={() => {
            write(clearOwn(), `Use the ${what}'s type's fire rating`)
          }}
        >
          Use the type&apos;s rating
        </Button>
      ) : null}
    </Field>
  )
}

/** Flip hinge (to the other jamb) and Flip swing (to the other side of the wall), as in Revit's flip arrows; the plan and 3D redraw from the edit. */
function DoorFlips({ model, el, submit, editBlocked, notify }: { readonly model: ModelState; readonly el: BimElement; readonly submit: SubmitCommand; readonly editBlocked: string | null; readonly notify: Props['notify'] }): ReactNode {
  const flip = (which: 'hinge' | 'swing') => {
    const command = doorFlipCommand(model.elements, el, which)
    if (typeof command === 'string') {
      notify(command, 'error')
      return
    }
    const err = submit(command, which === 'hinge' ? "Flip the door's hinge" : "Flip the door's swing")
    if (err) {
      console.error('[ArchitectureProperties] door flip refused', { elementId: el.id, which, err })
      notify(err, 'error')
    }
  }
  const hingeWhy = typeof doorFlipCommand(model.elements, el, 'hinge') === 'string' ? 'This door has a leaf on each jamb, or slides: no hinge side to flip' : null
  return (
    <Field data-testid="architecture-door-flips">
      <FieldLabel>Door</FieldLabel>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="architecture-flip-hinge" disabled={editBlocked !== null || hingeWhy !== null} title={hingeWhy ?? undefined} onClick={() => flip('hinge')}>
          Flip hinge
        </Button>
        <Button type="button" size="sm" variant="outline" data-testid="architecture-flip-swing" disabled={editBlocked !== null} onClick={() => flip('swing')}>
          Flip swing
        </Button>
      </div>
      <FieldDescription>{editBlocked ?? hingeWhy ?? 'Hinge: the jamb it hangs on. Swing: the side of the wall it opens to.'}</FieldDescription>
    </Field>
  )
}

/** Material selector for walls, slabs, ceilings, columns, and openings — overrides the type's material on this instance. */
function MaterialField({ model, el, what, submit, editBlocked, notify }: { readonly model: ModelState; readonly el: BimElement; readonly what: string; readonly submit: SubmitCommand; readonly editBlocked: string | null; readonly notify: Props['notify'] }): ReactNode {
  const materials = allMaterials()
  if (materials.length === 0) return null
  const active = resolveElementMaterial(model, el)
  const own = (el as { readonly values?: Readonly<Record<string, unknown>> }).values?.[MATERIAL_ID_KEY]
  const currentId = typeof own === 'string' ? own : NO_MATERIAL
  const blocked = editBlocked !== null
  return (
    <Field data-testid="architecture-material">
      <FieldLabel htmlFor="architecture-material">Material</FieldLabel>
      <Select
        value={currentId}
        disabled={blocked}
        onValueChange={(v) => {
          const err = submit(
            { type: 'set_element_values', elementIds: [el.id], values: { [MATERIAL_ID_KEY]: v === NO_MATERIAL ? null : v } },
            `Change ${what} material`,
          )
          if (err) notify(err, 'error')
        }}
      >
        <SelectTrigger id="architecture-material" aria-label={`The ${what}'s material`}>
          <SelectValue placeholder={active ? `${active.name} (default)` : 'Default material'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_MATERIAL}>{active ? `Type default (${active.name})` : 'Type default'}</SelectItem>
          <SelectSeparator />
          {materials.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {el.kind === 'ceiling' ? (
        <FieldDescription>
          Form: <strong className="capitalize">{((el as { readonly form?: string }).form ?? 'flat').replace(/_/g, ' ')}</strong> — switch between ACT ceiling tile, painted gypsum, or wood slats above.
        </FieldDescription>
      ) : null}
    </Field>
  )
}

/** Readout, live material picker & guidance for architectural add-on kinds (`architecture.roof`, `architecture.stair`). */
function ArchAddonInspector({ model, el, submit, editBlocked, notify }: { readonly model: ModelState; readonly el: BimElement; readonly submit: SubmitCommand; readonly editBlocked: string | null; readonly notify: Props['notify'] }): ReactNode {
  if (String(el.kind) === 'architecture.roof') {
    const r = el as unknown as { readonly form?: string; readonly slopeRise?: number; readonly thicknessMm?: number; readonly baseOffsetMm?: number }
    const form = r.form ?? ((r.slopeRise ?? 0) > 0 ? 'shed' : 'flat')
    const pitch = typeof r.slopeRise === 'number' && r.slopeRise > 0 ? `${Math.round(r.slopeRise * 120) / 10} in 12` : 'Flat (0 in 12)'
    return (
      <FieldGroup data-testid="architecture-roof-properties">
        <Field orientation="horizontal">
          <FieldLabel>Roof form</FieldLabel>
          <Badge variant="outline" className="capitalize">{form}</Badge>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Pitch</FieldLabel>
          <Badge variant="outline">{pitch}</Badge>
        </Field>
        <MaterialField key={`mat-${el.id}`} model={model} el={el} what="roof" submit={submit} editBlocked={editBlocked} notify={notify} />
        <FieldDescription>
          To trim exterior walls cleanly to this roof&apos;s underside, select any wall and set <strong>Wall top → Roof</strong>.
        </FieldDescription>
      </FieldGroup>
    )
  }
  const s = el as unknown as {
    readonly start?: { x: number; y: number }
    readonly end?: { x: number; y: number }
    readonly widthMm?: number
    readonly form?: string
    readonly turn?: string
    readonly values?: Readonly<Record<string, unknown>>
  }
  const runMm = s.start && s.end ? Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) : 0
  const currentForm = String(s.values?.['architecture.stair_form'] ?? s.form ?? 'straight').toLowerCase()
  const currentTurn = String(s.values?.['architecture.stair_turn'] ?? s.turn ?? 'right').toLowerCase()
  const blocked = editBlocked !== null
  return (
    <FieldGroup data-testid="architecture-stair-properties">
      <Field>
        <FieldLabel htmlFor="architecture-stair-form">Configuration</FieldLabel>
        <Select
          value={currentForm}
          disabled={blocked}
          onValueChange={(v) => {
            const err = submit({ type: 'set_element_values', elementIds: [el.id], values: { 'architecture.stair_form': v } }, 'Change stair configuration')
            if (err) notify(err, 'error')
          }}
        >
          <SelectTrigger id="architecture-stair-form" aria-label="Stair configuration">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="straight">Straight run</SelectItem>
            <SelectItem value="l_shape">L-Shape (90° turn + landing)</SelectItem>
            <SelectItem value="u_shape">U-Shape (180° switchback + landing)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {currentForm !== 'straight' ? (
        <Field>
          <FieldLabel htmlFor="architecture-stair-turn">Turn direction</FieldLabel>
          <Select
            value={currentTurn}
            disabled={blocked}
            onValueChange={(v) => {
              const err = submit({ type: 'set_element_values', elementIds: [el.id], values: { 'architecture.stair_turn': v } }, 'Change stair turn direction')
              if (err) notify(err, 'error')
            }}
          >
            <SelectTrigger id="architecture-stair-turn" aria-label="Stair turn direction">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="right">Right (clockwise)</SelectItem>
              <SelectItem value="left">Left (counter-clockwise)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field orientation="horizontal">
        <FieldLabel>Flight span</FieldLabel>
        <Badge variant="outline">{(runMm / 304.8).toFixed(1)} ft</Badge>
      </Field>
      {typeof s.widthMm === 'number' ? (
        <Field orientation="horizontal">
          <FieldLabel>Clear width</FieldLabel>
          <Badge variant="outline">{(s.widthMm / 304.8).toFixed(1)} ft</Badge>
        </Field>
      ) : null}
      <MaterialField key={`mat-${el.id}`} model={model} el={el} what="stair" submit={submit} editBlocked={editBlocked} notify={notify} />
      <FieldDescription>
        IBC/IRC code-compliant stair (min 11&quot; treads, waisted 3D steps + steel guardrails, intermediate landing platforms, AIA cut-break plan graphics).
      </FieldDescription>
    </FieldGroup>
  )
}
