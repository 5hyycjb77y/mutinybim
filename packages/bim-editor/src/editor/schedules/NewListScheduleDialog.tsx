'use client'

import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { SCHEDULE_CATEGORIES, SCHEDULE_CATEGORY_LABELS, documentIndex, formScheduleKinds, formTable, libraryRowsOf, scheduleFields, scheduleV2Paper, type Command, type ModelState, type ScheduleCategory, type ScheduleDefinition, type ScheduleDefinitionV2 } from '@permitzip/bim-kernel'
import { firstPartyPackName, firstPartyStoredOwner } from '@permitzip/bim-kernel/packs'
import { scheduleV1ToV2 } from '@permitzip/bim-kernel/schedules'
import { addonScheduleBlocked, addonScheduleTemplateChoices, type AddonScheduleChoice } from '../../contracts/bim/addon-schedule-templates'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'
import { newId } from '../views-sheets/types'
import { EQUIPMENT_LIST_CHOICE, scheduleChoiceLabel } from '../electrical/schedules/schedule-plan'
import { BUILTIN_LIST_DESCRIPTIONS, BUILTIN_LIST_IDS, BUILTIN_LIST_LABELS, builtinListBlocked, builtinListDefinition, type BuiltinListId } from './builtin-lists'
import { FIRST_PARTY_SCHEDULE_OFFERS } from '../contributions/first-party'
import { nextSheetNumber, planScheduleCreate, sheetSpotOf, type FormScheduleReady, type NewScheduleFormSlot, type NewScheduleProps } from './new-schedule-plan'

/** Categories a list schedule can show (the sheet list is drawn by the drawing set, not here). */
export const LIST_SCHEDULE_CATEGORIES: readonly ScheduleCategory[] = SCHEDULE_CATEGORIES.filter((c) => c !== 'sheet_list')

/** Columns a new schedule starts with: the category's fields as the model has them now, count last and off. */
export function defaultColumns(model: Pick<ModelState, 'elements'>, category: ScheduleCategory): string[] {
  return scheduleFields(model, category)
    .map((f) => f.key)
    .filter((k) => k !== 'count')
    .slice(0, 8)
}

/**
 * Operator words for field keys whose built-in heading isn't ours to print
 * (the part type's "family" name reads as WHAT, as on the Not placed yet list).
 */
export const OPERATOR_HEADINGS: Readonly<Record<string, string>> = { family: 'WHAT' }

/** The category's fields, labelled for the person picking columns. */
export function listScheduleFields(model: Pick<ModelState, 'elements'>, category: ScheduleCategory): { key: string; label: string }[] {
  return scheduleFields(model, category).map((f) => ({ key: f.key, label: OPERATOR_HEADINGS[f.key] ?? f.label }))
}

/** "Plumbing fixtures schedule", made unique against the model's views ("… 2"). */
export function uniqueListScheduleName(model: Pick<ModelState, 'elements' | 'connections'>, category: ScheduleCategory): string {
  return uniqueName(model, `${SCHEDULE_CATEGORY_LABELS[category]} schedule`)
}

export function uniqueName(model: Pick<ModelState, 'elements' | 'connections'>, base: string): string {
  const taken = new Set(documentIndex(model).views.map((v) => v.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
  return `${base} ${Date.now()}`
}

/** A list of one category with these columns, made the one way every new list is: a v2 schedule. */
export function listScheduleDefinition(name: string, category: ScheduleCategory, columns: readonly string[], headings: Readonly<Record<string, string>> = {}): ScheduleDefinitionV2 {
  const v1: ScheduleDefinition = {
    category,
    title: name.trim(),
    columns: columns.map((field) => {
      const heading = headings[field] ?? OPERATOR_HEADINGS[field]
      return heading ? { field, heading } : { field }
    }),
  }
  return { ...scheduleV1ToV2(v1), name: name.trim() }
}

type SchedulePick =
  | { readonly kind: 'category'; readonly category: ScheduleCategory }
  /** The add-on's equipment list with its live columns (made as v2, like every list). */
  | { readonly kind: 'builtin' }
  | { readonly kind: 'list'; readonly list: BuiltinListId }
  /** A schedule template an add-on's library rows bring (a door schedule from Architecture). */
  | { readonly kind: 'addon'; readonly key: string }
  /** A form kind an add-on owns; its fields come from that add-on's slot. */
  | { readonly kind: 'form'; readonly form: string }

function pickValue(p: SchedulePick): string {
  return p.kind === 'category' ? `category:${p.category}` : p.kind === 'list' ? `list:${p.list}` : p.kind === 'addon' ? `addon:${p.key}` : p.kind === 'form' ? `form:${p.form}` : 'builtin:equipment'
}

/** A pick named by its value (`form:<kind>`, `builtin:equipment`, `addon:<key>`, `list:<id>`, `category:<id>`), or null. */
function parsePick(value: string | undefined): SchedulePick | null {
  if (!value) return null
  const at = value.indexOf(':')
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  if (kind === 'form' && id) return { kind: 'form', form: id }
  if (kind === 'builtin') return { kind: 'builtin' }
  if (kind === 'addon' && id) return { kind: 'addon', key: id }
  const list = BUILTIN_LIST_IDS.find((l) => l === id)
  if (kind === 'list' && list) return { kind: 'list', list }
  const category = LIST_SCHEDULE_CATEGORIES.find((c) => c === id)
  if (kind === 'category' && category) return { kind: 'category', category }
  return null
}

const NO_SHEET = 'none'
const NEW_SHEET = 'new'

/** Add-ons as the window groups them: their templates and form kinds, in the order the add-ons come. */
interface AddonGroup {
  readonly addon: string
  readonly label: string
  readonly templates: AddonScheduleChoice[]
  readonly forms: string[]
  readonly equipmentList: boolean
}

function addonGroups(templates: readonly AddonScheduleChoice[], forms: readonly string[], slot: NewScheduleFormSlot | null): AddonGroup[] {
  const groups = new Map<string, AddonGroup>()
  const group = (addon: string): AddonGroup => {
    const known = groups.get(addon)
    if (known) return known
    const made: AddonGroup = { addon, label: firstPartyPackName(addon) ?? addon, templates: [], forms: [], equipmentList: false }
    groups.set(addon, made)
    return made
  }
  for (const t of templates) group(t.addon).templates.push(t)
  for (const k of forms) group(firstPartyStoredOwner('form', k) ?? 'other').forms.push(k)
  const slotOwner = slot?.kinds[0] ? (firstPartyStoredOwner('form', slot.kinds[0]) ?? 'other') : null
  if (slotOwner) groups.set(slotOwner, { ...group(slotOwner), equipmentList: true })
  return [...groups.values()].map((g) => (g.addon === 'other' ? { ...g, label: 'Other add-ons' } : g))
}

export interface NewScheduleWindowProps {
  readonly model: ModelState
  readonly initialCategory: ScheduleCategory
  /** Start on a built-in list (Equipment list, Not placed yet, Loads) instead of a category. */
  readonly initialList?: BuiltinListId
  /** Start on this pick (`form:<kind>`, `builtin:equipment`, `addon:<key>`): a trade's Documents › schedule button. */
  readonly initialPick?: string
  /** The open sheet: a form schedule goes there unless another is picked. */
  readonly initialSheetId?: string | null
  /** The fields for the form kinds an add-on owns; null while its tools load. */
  readonly formSlot?: NewScheduleFormSlot | null
  /** Sends the command (one undo step); returns why it was refused, or null. */
  readonly submit: (command: Command, label: string) => string | null
  /** Made: open the sheet it went on, or the schedule itself. */
  readonly onCreated: (viewId: string, sheetId: string | null) => void
  readonly onClose: () => void
}

/**
 * The one New schedule window, behind every New schedule button (Views and
 * sheets, each trade's Documents group): lists,
 * each add-on's schedule templates and form kinds grouped under the add-on,
 * and any item in the model. Every new list is the same kind of schedule (v2),
 * opens in the same grid, and can go straight onto a sheet. One undo step.
 */
export function NewScheduleWindow({ model, initialCategory, initialList, initialPick, initialSheetId = null, formSlot = null, submit, onCreated, onClose }: NewScheduleWindowProps) {
  const [pick, setPick] = useState<SchedulePick>(() => parsePick(initialPick) ?? (initialList ? { kind: 'list', list: initialList } : { kind: 'category', category: initialCategory }))
  const listBlocked = useMemo(() => Object.fromEntries(BUILTIN_LIST_IDS.map((id) => [id, builtinListBlocked(model, id)])) as Record<BuiltinListId, string | null>, [model])
  const addonChoices = useMemo(() => addonScheduleTemplateChoices(libraryRowsOf(), FIRST_PARTY_SCHEDULE_OFFERS), [])
  const groups = useMemo(() => addonGroups(addonChoices, formScheduleKinds(), formSlot), [addonChoices, formSlot])
  const addonChoice: AddonScheduleChoice | null = pick.kind === 'addon' ? (addonChoices.find((c) => c.key === pick.key) ?? null) : null
  const addonBlocked = useMemo(() => (addonChoice ? addonScheduleBlocked(model, addonChoice) : null), [model, addonChoice])
  const category: ScheduleCategory = pick.kind === 'category' ? pick.category : pick.kind === 'builtin' ? EQUIPMENT_LIST_CHOICE.definition.category : initialCategory
  const [typedName, setTypedName] = useState<string | null>(null)
  const [formReady, setFormReady] = useState<{ kind: string; ready: FormScheduleReady } | null>(null)
  const formKindPicked = pick.kind === 'form' ? pick.form : null
  const onFormReady = useCallback((ready: FormScheduleReady) => formKindPicked && setFormReady({ kind: formKindPicked, ready }), [formKindPicked])
  const fields = useMemo(() => listScheduleFields(model, category), [model, category])
  const pickKey = pickValue(pick)
  const builtinColumns = EQUIPMENT_LIST_CHOICE.definition.columns.map((c) => c.field)
  const builtinHeadings: Readonly<Record<string, string>> = Object.fromEntries(EQUIPMENT_LIST_CHOICE.definition.columns.flatMap((c) => (c.heading ? [[c.field, c.heading]] : [])))
  const startColumns = pick.kind === 'builtin' ? builtinColumns : defaultColumns(model, category)
  const [picked, setPicked] = useState<{ pick: string; keys: ReadonlySet<string> }>(() => ({ pick: pickKey, keys: new Set(startColumns) }))
  const keys = picked.pick === pickKey ? picked.keys : new Set(startColumns)
  const sheets = useMemo(() => [...documentIndex(model).sheets].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })), [model])
  const isForm = pick.kind === 'form'
  const defaultSheet = isForm ? (initialSheetId && sheets.some((s) => s.id === initialSheetId) ? initialSheetId : NEW_SHEET) : NO_SHEET
  const [sheetPicked, setSheetPicked] = useState<{ pick: string; value: string } | null>(null)
  const sheetPick = sheetPicked?.pick === pickKey ? sheetPicked.value : defaultSheet
  const suggestedSheet = isForm && formSlot ? formSlot.newSheet(model) : { number: nextSheetNumber(model), name: 'Schedules' }
  const [typedSheet, setTypedSheet] = useState<{ number?: string; name?: string }>({})
  const sheetNumber = typedSheet.number ?? suggestedSheet.number
  const sheetName = typedSheet.name ?? suggestedSheet.name
  const ready = isForm && formReady && formReady.kind === formKindPicked ? formReady.ready : null
  const name =
    typedName ??
    (pick.kind === 'builtin'
      ? uniqueName(model, EQUIPMENT_LIST_CHOICE.label)
      : pick.kind === 'list'
        ? uniqueName(model, BUILTIN_LIST_LABELS[pick.list])
        : pick.kind === 'addon'
          ? uniqueName(model, addonChoice?.name ?? 'Schedule')
          : pick.kind === 'form'
            ? (ready?.suggestedName ?? uniqueName(model, scheduleChoiceLabel(pick.form)))
            : uniqueListScheduleName(model, category))
  const [refusal, setRefusal] = useState<string | null>(null)

  const columns = pick.kind === 'builtin' ? builtinColumns.filter((k) => keys.has(k)) : fields.map((f) => f.key).filter((k) => keys.has(k))
  const columnChoices = pick.kind === 'builtin' ? [...builtinColumns.map((k) => ({ key: k, label: builtinHeadings[k] ?? fields.find((f) => f.key === k)?.label ?? k.toUpperCase() })), ...fields.filter((f) => !builtinColumns.includes(f.key))] : fields
  const pickWhy =
    name.trim() === ''
      ? 'Give the schedule a name.'
      : pick.kind === 'list'
        ? listBlocked[pick.list]
        : pick.kind === 'addon'
          ? addonChoice
            ? addonBlocked
            : "That add-on schedule isn't offered here any more. Pick another."
          : pick.kind === 'form'
            ? !formSlot || !formSlot.kinds.includes(pick.form)
              ? `${scheduleChoiceLabel(pick.form)} needs its add-on's tools, which are still loading. Try again in a moment.`
              : ready && !ready.ok
                ? ready.reason
                : null
            : columns.length === 0
              ? 'Pick at least one column.'
              : null
  const why = pickWhy ?? (pick.kind === 'form' && !ready ? 'Getting the choices ready…' : sheetPick === NEW_SHEET && (!sheetNumber.trim() || !sheetName.trim()) ? 'Give the new sheet a number and a name.' : null)

  const toggle = (key: string, on: boolean) => {
    const next = new Set(keys)
    if (on) next.add(key)
    else next.delete(key)
    setPicked({ pick: pickKey, keys: next })
  }

  const propsFor = (): { props: NewScheduleProps; subject: string } | null => {
    if (pick.kind === 'form') return ready?.ok ? { props: { formSchedule: ready.form }, subject: ready.subject } : null
    if (pick.kind === 'list') return { props: { scheduleV2: { ...builtinListDefinition(model, pick.list), name: name.trim() } }, subject: name.trim() }
    if (pick.kind === 'addon') return addonChoice?.kind === 'available' ? { props: { scheduleV2: { ...addonChoice.definition, name: name.trim() } }, subject: name.trim() } : null
    const v1Category = pick.kind === 'builtin' ? EQUIPMENT_LIST_CHOICE.definition.category : category
    return { props: { scheduleV2: listScheduleDefinition(name, v1Category, columns, pick.kind === 'builtin' ? builtinHeadings : {}) }, subject: name.trim() }
  }

  const create = (e: FormEvent) => {
    e.preventDefault()
    if (why) return
    const made = propsFor()
    if (!made) return
    const size = 'formSchedule' in made.props ? formTable(model, made.props.formSchedule).size : scheduleV2Paper(model, made.props.scheduleV2).table.size
    const sheet = sheets.find((s) => s.id === sheetPick) ?? null
    const viewId = newId('view')
    const plan = planScheduleCreate(model, {
      viewId,
      name,
      props: made.props,
      size,
      subject: made.subject,
      viewportId: newId('vp'),
      sheet: sheet ? sheetSpotOf(sheet) : null,
      ...(sheetPick === NEW_SHEET ? { newSheet: { sheetId: newId('sheet'), number: sheetNumber, name: sheetName } } : {}),
    })
    if (!plan.ok) {
      setRefusal(plan.reason)
      return
    }
    const refused = submit(plan.command, plan.label)
    if (refused) {
      setRefusal(refused)
      return
    }
    onCreated(viewId, plan.sheetId)
  }

  const choose = (v: string) => {
    const next = parsePick(v)
    if (!next || (next.kind === 'addon' && !addonChoices.some((c) => c.key === next.key))) return
    setRefusal(null)
    setPick(next)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* One window for every kind; the test id keeps its first name. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="new-list-schedule-dialog">
        <form onSubmit={create} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
            <DialogDescription>It reads the model live; changes you type in a list go back into the model. Lists open as a spreadsheet; columns change one at a time from Columns. You can undo this.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="bm-list-schedule-category">What it lists</FieldLabel>
              <Select value={pickKey} onValueChange={choose}>
                <SelectTrigger id="bm-list-schedule-category" data-testid="list-schedule-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Lists for planning</SelectLabel>
                    {BUILTIN_LIST_IDS.map((l) => (
                      <SelectItem key={l} value={`list:${l}`} data-testid={`list-schedule-builtin-${l}`}>
                        {BUILTIN_LIST_LABELS[l]}
                        {listBlocked[l] ? ' (not available yet)' : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {groups.map((g) => (
                    <SelectGroup key={g.addon} data-testid={`list-schedule-group-${g.addon}`}>
                      <SelectLabel>{g.label}</SelectLabel>
                      {g.templates.map((c) => (
                        <SelectItem key={`addon:${c.key}`} value={`addon:${c.key}`} disabled={c.kind === 'off'} data-testid={`list-schedule-addon-${c.key}`}>
                          {c.name}
                          {c.kind === 'off' ? ` (${c.why})` : ''}
                        </SelectItem>
                      ))}
                      {g.forms.map((k) => (
                        <SelectItem key={`form:${k}`} value={`form:${k}`} data-testid={`list-schedule-form-${k}`}>
                          {scheduleChoiceLabel(k)} (laid out on a sheet)
                        </SelectItem>
                      ))}
                      {g.equipmentList && (
                        <SelectItem value="builtin:equipment" data-testid="list-schedule-builtin-equipment">
                          {EQUIPMENT_LIST_CHOICE.label}
                        </SelectItem>
                      )}
                    </SelectGroup>
                  ))}
                  <SelectGroup>
                    <SelectLabel>Any items in the model</SelectLabel>
                    {LIST_SCHEDULE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={`category:${c}`}>
                        {SCHEDULE_CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {pick.kind === 'form' && formSlot?.kinds.includes(pick.form) && formSlot.renderFields({ model, kind: pick.form, onReady: onFormReady })}
            <Field>
              <FieldLabel htmlFor="bm-list-schedule-name">Name</FieldLabel>
              <Input id="bm-list-schedule-name" value={name} maxLength={120} onChange={(e) => setTypedName(e.target.value)} data-testid="list-schedule-name" />
            </Field>
            {pick.kind === 'addon' ? (
              <Field>
                <FieldDescription data-testid="list-schedule-addon-description">
                  {addonChoice?.kind === 'available' && addonChoice.description ? `${addonChoice.description}. ` : ''}Its columns come with the add-on; Columns in the schedule changes them later.
                </FieldDescription>
                {why && name.trim() !== '' && (
                  <FieldDescription className="text-warning-700" data-testid="list-schedule-addon-blocked">
                    {why}
                  </FieldDescription>
                )}
              </Field>
            ) : pick.kind === 'list' ? (
              <Field>
                <FieldDescription data-testid="list-schedule-builtin-description">
                  {BUILTIN_LIST_DESCRIPTIONS[pick.list]}. Its columns are set; Columns in the schedule changes them later.
                </FieldDescription>
                {listBlocked[pick.list] && (
                  <FieldDescription className="text-warning-700" data-testid="list-schedule-builtin-blocked">
                    {listBlocked[pick.list]}
                  </FieldDescription>
                )}
              </Field>
            ) : pick.kind === 'form' ? null : (
              <FieldSet>
                <FieldLegend variant="label">Columns</FieldLegend>
                <FieldDescription>Start with these. Columns in the schedule changes them later, one at a time.</FieldDescription>
                <FieldGroup className="grid grid-cols-2 gap-2">
                  {columnChoices.map((f) => (
                    <Field key={f.key} orientation="horizontal">
                      <Checkbox id={`bm-list-col-${f.key}`} checked={keys.has(f.key)} onCheckedChange={(v) => toggle(f.key, v === true)} aria-label={f.label} />
                      <FieldContent>
                        <FieldLabel htmlFor={`bm-list-col-${f.key}`} className="font-normal">
                          {f.label}
                        </FieldLabel>
                      </FieldContent>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            )}
            <Field>
              <FieldLabel htmlFor="bm-schedule-sheet">Place on sheet</FieldLabel>
              <Select value={sheetPick} onValueChange={(value) => setSheetPicked({ pick: pickKey, value })}>
                <SelectTrigger id="bm-schedule-sheet" data-testid="schedule-sheet-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_SHEET}>Not on a sheet yet</SelectItem>
                    <SelectItem value={NEW_SHEET}>New sheet…</SelectItem>
                    {sheets.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.number} · {s.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{sheetPick === NO_SHEET ? 'It opens as its own tab; place it on a sheet later from Views and sheets.' : 'It goes beside what is already on the sheet, and the sheet opens.'}</FieldDescription>
            </Field>
            {sheetPick === NEW_SHEET && (
              <div className="grid grid-cols-3 gap-3">
                <Field>
                  <FieldLabel htmlFor="bm-schedule-sheet-number">Sheet number</FieldLabel>
                  <Input id="bm-schedule-sheet-number" value={sheetNumber} maxLength={40} onChange={(e) => setTypedSheet((t) => ({ ...t, number: e.target.value }))} data-testid="schedule-sheet-number" />
                </Field>
                <Field className="col-span-2">
                  <FieldLabel htmlFor="bm-schedule-sheet-name">Sheet name</FieldLabel>
                  <Input id="bm-schedule-sheet-name" value={sheetName} maxLength={200} onChange={(e) => setTypedSheet((t) => ({ ...t, name: e.target.value }))} />
                </Field>
              </div>
            )}
          </FieldGroup>
          {(refusal ?? (pick.kind === 'form' ? why : null)) && (
            <Alert variant="destructive" data-testid="list-schedule-refusal">
              <AlertDescription>{refusal ? `The schedule wasn't made: ${refusal}` : why}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={why !== null} title={why ?? undefined} data-testid="list-schedule-create">
              {sheetPick === NO_SHEET ? 'Create and open' : 'Create and open the sheet'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The window's first name, kept for callers and tests that still use it. */
export const NewListScheduleDialog = NewScheduleWindow
