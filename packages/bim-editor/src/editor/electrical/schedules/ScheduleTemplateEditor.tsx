'use client'

import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronRight, CircleAlert, Plus, Trash2 } from 'lucide-react'
import { fieldPaths, FORM_ALIGNS, formScheduleKindLabel, formTemplateSchema, parseFieldTemplate, formatFieldTemplate, type FieldPathInfo, type FormColumn, type FormHeaderField, type FormNote, type FormScheduleDefinition, type FormTemplate, type ModelState } from '@permitzip/bim-kernel'
import { DEFAULT_SUPPLY_FROM_TEMPLATE } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Button } from '../../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../../../ui/field'
import { Input } from '../../../ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../../../ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import type { SubmitCommand } from '../../views-sheets/types'

type Align = (typeof FORM_ALIGNS)[number]
const ALIGN_LABEL: Record<Align, string> = { left: 'Left', center: 'Centre', right: 'Right' }
const STARTS_FROM: Record<FieldPathInfo['on'], string> = { panel: 'The panel', device: 'A device on a circuit', circuit: 'A circuit', feeder: 'A feeder', pipe: 'A pipe', load_point: 'A load point', any: 'Any part' }

/** A first schema issue in plain words: "Column 3 value: A { has no closing }". */
export function templateIssue(template: FormTemplate): string | null {
  const parsed = formTemplateSchema.safeParse(template)
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  if (!issue) return 'The template doesn’t fit.'
  const [a, b, c, d] = issue.path
  const where =
    a === 'title'
      ? 'Title'
      : a === 'name'
        ? 'Template name'
        : a === 'supplyFrom'
          ? 'Supply from wording'
          : a === 'header' && b === 'fields' && typeof c === 'number'
            ? `Header field ${c + 1} ${d === 'label' ? 'label' : 'value'}`
            : a === 'body' && b === 'columns' && typeof c === 'number'
              ? `Column ${c + 1} ${d === 'heading' ? 'heading' : 'value'}`
              : a === 'body' && b === 'columns'
                ? 'Columns'
                : a === 'notes' && typeof b === 'number'
                  ? `Note ${b + 1} ${typeof c === 'string' ? c : ''}`.trim()
                  : 'The template'
  return `${where}: ${issue.message}`
}

/** A text box for a field template: Insert field ▾ adds `{path}`, a bad template says where, and the value it reads on the schedule's panel shows under it. */
function TemplateInput({
  id,
  label,
  value,
  onChange,
  preview,
  testId,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  /** What it reads on the bound element, or null when there is nothing to read it on. */
  preview: ((template: string) => string) | null
  testId?: string
}) {
  const parsed = parseFieldTemplate(value)
  const reads = parsed.ok && preview ? preview(value) : null
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" aria-invalid={!parsed.ok} data-testid={testId} />
        <InputGroupAddon align="inline-end">
          <FieldPathMenu onPick={(path) => onChange(`${value}{${path}}`)} label={`Insert a field into ${label}`} />
        </InputGroupAddon>
      </InputGroup>
      {!parsed.ok ? (
        <FieldError data-testid={testId ? `${testId}-error` : undefined}>
          {parsed.error} (at character {parsed.at + 1})
        </FieldError>
      ) : (
        reads !== null && (
          <FieldDescription className="text-xs" data-testid={testId ? `${testId}-preview` : undefined}>
            Reads: {reads || '(empty here)'}
          </FieldDescription>
        )
      )}
    </Field>
  )
}

function FieldPathMenu({ onPick, label }: { onPick: (path: string) => void; label: string }) {
  const groups = (['panel', 'device', 'circuit', 'feeder', 'any'] as const).map((on) => ({ on, paths: fieldPaths().filter((f) => f.on === on) })).filter((g) => g.paths.length > 0)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton aria-label={label} title="Insert a field">
          <Braces />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {groups.map((g, i) => (
          <DropdownMenuGroup key={g.on}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs">{STARTS_FROM[g.on]}</DropdownMenuLabel>
            {g.paths.map((f) => (
              <DropdownMenuItem key={f.path} onSelect={() => onPick(f.path)}>
                <span className="flex-1">{f.label}</span>
                <span className="text-xs text-muted-foreground">{f.example}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start px-1 font-medium">
          {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
          {title}
          {count !== undefined && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2 pl-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  const [item] = out.splice(from, 1)
  if (item !== undefined) out.splice(to, 0, item)
  return out
}

/**
 * Edit template… on a schedule's properties: what its title, header, columns,
 * notes legend and Supply from wording say. Saving changes this schedule only
 * (it keeps its own copy); Save as firm default shares it.
 */
export function ScheduleTemplateEditor({
  model,
  viewId,
  def,
  submit,
  onClose,
}: {
  readonly model: ModelState
  readonly viewId: string
  readonly def: FormScheduleDefinition
  readonly submit: SubmitCommand
  readonly onClose: () => void
}) {
  const [draft, setDraft] = useState<FormTemplate>(def.template)
  const [refusal, setRefusal] = useState<string | null>(null)
  const set = (patch: Partial<FormTemplate>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setRefusal(null)
  }
  const elementId = def.elementId ?? null
  const boundName = elementId ? formatFieldTemplate(model.elements, elementId, '{name}').text || 'the panel' : null
  const preview = elementId ? (template: string) => formatFieldTemplate(model.elements, elementId, template, { rules: def.rules ?? null, ...(draft.supplyFrom ? { supplyFrom: draft.supplyFrom } : {}) }).text : null
  const header = draft.header.fields
  const columns = draft.body.columns
  const setHeader = (fields: readonly FormHeaderField[]) => set({ header: { ...draft.header, fields } })
  const setColumns = (cols: readonly FormColumn[]) => set({ body: { ...draft.body, columns: cols } })
  const setNotes = (notes: readonly FormNote[]) => set({ notes })
  const editColumn = (i: number, patch: Partial<FormColumn>) => setColumns(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const issue = templateIssue(draft)
    if (issue) return setRefusal(issue)
    const parsed = formTemplateSchema.parse(draft)
    const refused = submit({ type: 'set_view_properties', viewId, props: { formSchedule: { ...def, template: parsed } } }, `edit the ${formScheduleKindLabel(def.kind).toLowerCase()} template${boundName ? ` of ${boundName}` : ''}`)
    if (refused) return setRefusal(refused)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="schedule-template-editor">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
            <DialogDescription>
              Braces read the model: {'{bus}'} prints {boundName ? `${boundName}’s` : 'the'} bus rating. Square brackets drop when a field inside is empty: [ via {'{feeder.type}'}]. This changes this schedule only.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="ste-name">Template name</FieldLabel>
                <Input id="ste-name" value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <div className="col-span-2">
                <TemplateInput id="ste-title" label="Title" value={draft.title} onChange={(title) => set({ title })} preview={preview} testId="ste-title" />
              </div>
            </div>
            <Section title="Header" count={header.length} defaultOpen>
              {header.map((f, i) => (
                <div key={i} className="grid grid-cols-[8rem_1fr_auto] items-start gap-2" data-testid={`ste-header-${i}`}>
                  <Field>
                    <FieldLabel htmlFor={`ste-hl-${i}`} className="sr-only">
                      Header label {i + 1}
                    </FieldLabel>
                    <Input id={`ste-hl-${i}`} value={f.label} maxLength={40} onChange={(e) => setHeader(header.map((h, j) => (j === i ? { ...h, label: e.target.value } : h)))} />
                  </Field>
                  <TemplateInput id={`ste-hv-${i}`} label={`${f.label || `Header field ${i + 1}`} value`} value={f.value} onChange={(value) => setHeader(header.map((h, j) => (j === i ? { ...h, value } : h)))} preview={preview} testId={`ste-header-value-${i}`} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove header field ${f.label || i + 1}`} onClick={() => setHeader(header.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setHeader([...header, { label: 'NEW', value: '' }])} disabled={header.length >= 24}>
                <Plus data-icon="inline-start" />
                Add header field
              </Button>
            </Section>
            <Section title={draft.body.layout === 'slots' ? 'Columns (each half of the slot grid)' : 'Columns'} count={columns.length}>
              {columns.map((c, i) => (
                <div key={i} className="grid grid-cols-[7rem_1fr_6rem_auto] items-start gap-2" data-testid={`ste-column-${i}`}>
                  <Field>
                    <FieldLabel htmlFor={`ste-ch-${i}`} className="sr-only">
                      Column {i + 1} heading
                    </FieldLabel>
                    <Input id={`ste-ch-${i}`} value={c.heading} maxLength={40} onChange={(e) => editColumn(i, { heading: e.target.value })} />
                  </Field>
                  <TemplateInput id={`ste-cv-${i}`} label={`${c.heading || `Column ${i + 1}`} value`} value={c.value} onChange={(value) => editColumn(i, { value })} preview={null} testId={`ste-column-value-${i}`} />
                  <Select value={c.align ?? 'left'} onValueChange={(v) => editColumn(i, { align: FORM_ALIGNS.find((a) => a === v) ?? 'left' })}>
                    <SelectTrigger size="sm" aria-label={`Column ${c.heading || i + 1} alignment`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {FORM_ALIGNS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {ALIGN_LABEL[a]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="flex">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move column ${c.heading || i + 1} up`} disabled={i === 0} onClick={() => setColumns(moved(columns, i, i - 1))}>
                      <ArrowUp />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move column ${c.heading || i + 1} down`} disabled={i === columns.length - 1} onClick={() => setColumns(moved(columns, i, i + 1))}>
                      <ArrowDown />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove column ${c.heading || i + 1}`} disabled={columns.length <= 1} onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setColumns([...columns, { heading: 'NEW', value: '' }])} disabled={columns.length >= (draft.body.layout === 'slots' ? 8 : 16)}>
                <Plus data-icon="inline-start" />
                Add column
              </Button>
            </Section>
            <Section title="Notes legend" count={draft.notes.length}>
              <FieldDescription className="text-xs">A mark prints in brackets ([G]) beside each circuit it applies to. “Applies when” is a part setting that is on (gfci) or field=value (load_class=Motor); leave it empty for a general note.</FieldDescription>
              {draft.notes.map((n, i) => (
                <div key={i} className="grid grid-cols-[4rem_1fr_9rem_auto] items-start gap-2" data-testid={`ste-note-${i}`}>
                  <Input aria-label={`Note ${i + 1} mark`} value={n.mark} maxLength={4} onChange={(e) => setNotes(draft.notes.map((x, j) => (j === i ? { ...x, mark: e.target.value } : x)))} />
                  <Input aria-label={`Note ${i + 1} text`} value={n.text} maxLength={120} onChange={(e) => setNotes(draft.notes.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <Input
                    aria-label={`Note ${i + 1} applies when`}
                    placeholder="Applies when"
                    value={n.when ?? ''}
                    maxLength={60}
                    onChange={(e) => {
                      const when = e.target.value
                      setNotes(draft.notes.map((x, j) => (j === i ? (when.trim() ? { ...x, when } : { mark: x.mark, text: x.text }) : x)))
                    }}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove note ${n.mark || i + 1}`} onClick={() => setNotes(draft.notes.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setNotes([...draft.notes, { mark: String.fromCharCode(65 + (draft.notes.length % 26)), text: 'Note' }])} disabled={draft.notes.length >= 16}>
                <Plus data-icon="inline-start" />
                Add note
              </Button>
            </Section>
            {(def.kind === 'panel' || def.kind === 'switchboard') && (
              <Section title="Supply from wording">
                <TemplateInput
                  id="ste-supply"
                  label="Supply from"
                  value={draft.supplyFrom ?? DEFAULT_SUPPLY_FROM_TEMPLATE}
                  onChange={(v) => {
                    if (v.trim() === '' || v === DEFAULT_SUPPLY_FROM_TEMPLATE) {
                      const { supplyFrom: _default, ...rest } = draft
                      setDraft(rest)
                    } else set({ supplyFrom: v })
                  }}
                  preview={preview}
                  testId="ste-supply"
                />
                <FieldDescription className="text-xs">Where {'{supply_from}'} is used, it prints this: the default reads “MDP via 225A/3P via F225”.</FieldDescription>
              </Section>
            )}
          </FieldGroup>
          {refusal && (
            <Alert variant="destructive" data-testid="ste-refusal">
              <CircleAlert />
              <AlertTitle>Not saved</AlertTitle>
              <AlertDescription>{refusal}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" data-testid="ste-save">
              Save to this schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
