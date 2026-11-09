'use client'

import { useEffect, useState } from 'react'
import { STANDARD_SCALES, TITLE_BLOCK_TYPES, formatParameterValue, sheetPaperSize, standardProjectParameter, type ProjectParameterDef, type Sheet, type TitleBlockRow, type TitleBlockType, type ViewElement } from '@permitzip/bim-kernel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { VIEW_TYPE_LABEL, type CreatableViewType } from './types'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { loadTitleBlocksFrom, type TitleBlockChoice } from './title-blocks-client'
import { ParameterInput } from './ParameterInput'

const TITLE_BLOCK_LABEL: Record<TitleBlockType, string> = {
  arch_d_mutinybim: 'ARCH D, 36" x 24"',
  ansi_b_mutinybim: 'ANSI B, 17" x 11"',
}

const SHEET_FIELDS: ReadonlyArray<{ key: string; label: string; hint?: string }> = [
  { key: 'project_name', label: 'Project' },
  { key: 'project_number', label: 'Project no.' },
  { key: 'client', label: 'Client' },
  { key: 'address', label: 'Project address' },
  { key: 'drawn_by', label: 'Drawn by' },
  { key: 'checked_by', label: 'Checked by' },
  { key: 'date', label: 'Date' },
  { key: 'status', label: 'Status' },
]

/** What a firm (library) title block adds to the strip: owner and consultants, the seal, the issue purpose. */
const LIBRARY_SHEET_FIELDS: ReadonlyArray<{ key: string; label: string; hint?: string }> = [
  { key: 'project_state', label: 'Project state', hint: "Two letters (VA); prints the firm's registration number for it" },
  { key: 'owner', label: 'Owner', hint: 'Name, city' },
  { key: 'architect', label: 'Architect', hint: 'Name, city' },
  { key: 'structural', label: 'Structural', hint: 'Name, city' },
  { key: 'civil', label: 'Civil', hint: 'Name, city' },
  { key: 'engineer_name', label: 'Engineer of record' },
  { key: 'engineer_license', label: 'Licence no.' },
  { key: 'engineer_state', label: 'Licence state' },
  { key: 'issue_purpose', label: 'Issue purpose', hint: 'Blank: the status' },
]

/** A sheet field's type: the project parameter of the same key (a date picker for Date, a list for Status), else text. */
function fieldDef(f: { key: string; label: string; hint?: string }): ProjectParameterDef {
  const standard = standardProjectParameter(f.key)
  return { ...(standard ?? { key: f.key, valueType: 'text', group: 'project' }), label: f.label, ...(f.hint ? { hint: f.hint } : {}) }
}

/** Paper as a person says it: 42" x 30". */
const paperWords = (paper: { readonly x: number; readonly y: number }) => `${Math.round(paper.x / 25.4)}" x ${Math.round(paper.y / 25.4)}"`

const BUILT_IN = 'builtin:'
const LIBRARY = 'library:'

/** The title blocks a sheet can take: the built-in ones, then the firm library's (default first). */
function useLibraryTitleBlocks(): { readonly choices: readonly TitleBlockChoice[]; readonly note: string | null; readonly loading: boolean } {
  const titleBlocks = useEditorHost().data.titleBlocks
  const [state, setState] = useState<{ choices: readonly TitleBlockChoice[]; note: string | null; loading: boolean }>({ choices: [], note: null, loading: true })
  useEffect(() => {
    let live = true
    loadTitleBlocksFrom(titleBlocks)
      .then((list) => live && setState({ choices: list.choices, note: null, loading: false }))
      .catch((err: unknown) => {
        console.error('[SheetDialog] library title blocks failed to load', err)
        if (live) setState({ choices: [], note: `The firm's title blocks couldn't be loaded (${err instanceof Error ? err.message : 'unknown error'}); the built-in ones still work.`, loading: false })
      })
    return () => {
      live = false
    }
  }, [titleBlocks])
  return state
}

/** Runs a save; a returned string is the refusal shown in the form (the form stays filled in). */
type Save = () => string | null | Promise<string | null>

function useSave(onDone: () => void) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (save: Save) => {
    setBusy(true)
    setError(null)
    try {
      const refusal = await save()
      if (refusal) setError(refusal)
      else onDone()
    } catch (err) {
      console.error('[ViewsSheetsDialogs] save failed', err)
      setError(err instanceof Error ? err.message : "That couldn't be saved. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run, setError }
}

function ScaleSelect({ id, value, onChange }: { id: string; value: number; onChange: (scale: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {STANDARD_SCALES.map((s) => (
            <SelectItem key={s.scale} value={String(s.scale)}>
              {s.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function NewViewDialog({
  viewType,
  levels,
  onCancel,
  onCreate,
}: {
  viewType: Exclude<CreatableViewType, 'section'>
  levels: readonly string[]
  onCancel: () => void
  onCreate: (input: { name: string; level: string | null; scale: number }) => string | null | Promise<string | null>
}) {
  const needsLevel = viewType === 'floor_plan' || viewType === 'ceiling_plan'
  const [level, setLevel] = useState(levels[0] ?? '')
  const suggested = (lvl: string) =>
    viewType === 'floor_plan' ? `${lvl || 'Level'} Mechanical plan` : viewType === 'ceiling_plan' ? `${lvl || 'Level'} Ceiling plan` : viewType === 'three_d' ? '3D - Mechanical' : 'Detail'
  const [name, setName] = useState(suggested(levels[0] ?? ''))
  const [nameTouched, setNameTouched] = useState(false)
  const [scale, setScale] = useState(viewType === 'detail' ? 8 : 48)
  const { error, busy, run } = useSave(onCancel)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsLevel && !level.trim()) return
    void run(() => onCreate({ name: name.trim(), level: needsLevel ? level.trim() : null, scale }))
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New {VIEW_TYPE_LABEL[viewType].toLowerCase()}</DialogTitle>
            <DialogDescription>
              {viewType === 'detail'
                ? 'A drawing-only view: draw lines, text and dimensions, then place it on a sheet.'
                : viewType === 'three_d'
                  ? 'A saved 3D view of the work. On a sheet it prints as an isometric outline.'
                  : 'Shows one level, cut at the height you set, with the linked models underneath.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {needsLevel && (
              <Field>
                <FieldLabel htmlFor="nv-level">Level</FieldLabel>
                {levels.length > 0 ? (
                  <Select
                    value={level}
                    onValueChange={(v) => {
                      setLevel(v)
                      if (!nameTouched) setName(suggested(v))
                    }}
                  >
                    <SelectTrigger id="nv-level">
                      <SelectValue placeholder="Pick a level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {levels.map((l) => (
                          <SelectItem key={l} value={l}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="nv-level" value={level} onChange={(e) => setLevel(e.target.value)} placeholder="L1" required />
                )}
                <FieldDescription>{levels.length > 0 ? "Levels come from the linked architect's model." : 'No linked model levels yet; type the level name your ductwork uses (L1).'}</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="nv-name">Name</FieldLabel>
              <Input
                id="nv-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameTouched(true)
                }}
                required
                maxLength={120}
                autoFocus
              />
            </Field>
            {viewType !== 'three_d' && (
              <Field>
                <FieldLabel htmlFor="nv-scale">Scale</FieldLabel>
                <ScaleSelect id="nv-scale" value={scale} onChange={setScale} />
              </Field>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || (needsLevel && !level.trim())}>
              {busy && <Spinner data-icon="inline-start" />}
              Create and open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SheetDialog({
  sheet,
  suggestedNumber,
  projectValues = {},
  onProjectInfo,
  onCancel,
  onSave,
}: {
  /** Absent: a new sheet. */
  sheet: Sheet | null
  suggestedNumber: string
  /** The project's facts (Sheets › Project info), stored form: a blank field prints these. */
  projectValues?: Readonly<Record<string, string>>
  /** Open Project info, where the facts every sheet prints are filled in once. */
  onProjectInfo?: () => void
  onCancel: () => void
  /** `titleBlockRow`: a firm title block copied onto the sheet; null: the built-in `titleBlock`. */
  onSave: (input: { number: string; name: string; titleBlock: TitleBlockType; titleBlockRow: TitleBlockRow | null; fields: Record<string, string> }) => string | null | Promise<string | null>
}) {
  const [number, setNumber] = useState(sheet?.number ?? suggestedNumber)
  const [name, setName] = useState(sheet?.title ?? 'Mechanical plan')
  const [titleBlock, setTitleBlock] = useState<TitleBlockType>(sheet?.props?.titleBlock ?? 'arch_d_mutinybim')
  const library = useLibraryTitleBlocks()
  const keptRow = sheet?.props?.titleBlockRow ?? null
  // Absent: not picked yet — a new sheet starts on the firm default once the library answers.
  const [picked, setPicked] = useState<string | null>(sheet ? (keptRow ? `${LIBRARY}${keptRow.id}` : `${BUILT_IN}${sheet.props?.titleBlock ?? 'arch_d_mutinybim'}`) : null)
  const firmDefault = library.choices.find((c) => c.isDefault)
  const choice = picked ?? (firmDefault ? `${LIBRARY}${firmDefault.id}` : library.loading ? null : `${BUILT_IN}arch_d_mutinybim`)
  const libraryChoice = choice?.startsWith(LIBRARY) ? library.choices.find((c) => `${LIBRARY}${c.id}` === choice) : undefined
  // The sheet's own copy stays as it was unless another title block is picked.
  const row: TitleBlockRow | null = choice?.startsWith(LIBRARY) ? (keptRow && choice === `${LIBRARY}${keptRow.id}` ? keptRow : (libraryChoice?.row ?? null)) : null
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(sheet?.props?.fields ?? {}) }))
  const { error, busy, run } = useSave(onCancel)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void run(() => onSave({ number: number.trim(), name: name.trim(), titleBlock, titleBlockRow: row, fields }))
  }
  const pick = (value: string) => {
    // In a form, the dropdown reports an empty pick when its value moves to an option that has not rendered
    // yet (the firm default, as the library answers). Nobody can pick "nothing" here.
    if (value === '') return
    setPicked(value)
    const builtIn = TITLE_BLOCK_TYPES.find((t) => `${BUILT_IN}${t}` === value)
    if (builtIn) setTitleBlock(builtIn)
  }
  const shownFields = row ? [...SHEET_FIELDS.filter((f) => f.key !== 'client' && f.key !== 'status'), ...LIBRARY_SHEET_FIELDS] : SHEET_FIELDS
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{sheet ? `Sheet ${sheet.number}` : 'New sheet'}</DialogTitle>
            <DialogDescription>{sheet ? 'Number, name and title block text.' : 'After it opens, drag views from the panel onto it.'}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="sh-number">Number</FieldLabel>
                <Input id="sh-number" value={number} onChange={(e) => setNumber(e.target.value)} required maxLength={40} autoFocus={!sheet} />
              </Field>
              <Field className="col-span-2">
                <FieldLabel htmlFor="sh-name">Name</FieldLabel>
                <Input id="sh-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="sh-tb">Title block</FieldLabel>
              <Select value={choice ?? undefined} onValueChange={pick} disabled={choice === null}>
                <SelectTrigger id="sh-tb">
                  <SelectValue placeholder="Loading the firm's title blocks…" />
                </SelectTrigger>
                <SelectContent>
                  {library.choices.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Firm library</SelectLabel>
                      {library.choices.map((c) => (
                        <SelectItem key={c.id} value={`${LIBRARY}${c.id}`}>
                          {c.name}
                          {c.isDefault ? ' (default)' : ''}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {keptRow && !library.choices.some((c) => c.id === keptRow.id) && (
                    <SelectGroup>
                      <SelectLabel>On this sheet</SelectLabel>
                      <SelectItem value={`${LIBRARY}${keptRow.id}`}>{keptRow.name}</SelectItem>
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectLabel>Built in</SelectLabel>
                    {TITLE_BLOCK_TYPES.map((t) => (
                      <SelectItem key={t} value={`${BUILT_IN}${t}`}>
                        {TITLE_BLOCK_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {library.note ? <FieldDescription>{library.note}</FieldDescription> : <FieldDescription>Firm title blocks and the default: Settings › MutinyBIM library › Title blocks.</FieldDescription>}
            </Field>
            <FieldDescription>
              A blank field prints the project&apos;s information, filled in once for every sheet
              {onProjectInfo ? (
                <>
                  {' '}
                  in{' '}
                  <Button type="button" variant="link" className="h-auto p-0" onClick={onProjectInfo} data-testid="sheet-dialog-project-info">
                    Project information
                  </Button>
                </>
              ) : null}
              .
            </FieldDescription>
            <div className="grid grid-cols-2 gap-3">
              {shownFields.map((f) => {
                const def = fieldDef(f)
                // A blank issue purpose prints the status (the title block's rule), so it says so.
                const fromProject = projectValues[f.key] || (f.key === 'issue_purpose' ? fields.status || projectValues.status : undefined)
                return (
                  <Field key={f.key}>
                    <FieldLabel htmlFor={`sh-f-${f.key}`}>{f.label}</FieldLabel>
                    <ParameterInput def={def} id={`sh-f-${f.key}`} value={fields[f.key] ?? ''} fallback={fromProject ? formatParameterValue(def, fromProject) : undefined} onChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))} />
                    {f.hint && <FieldDescription>{f.hint}</FieldDescription>}
                  </Field>
                )
              })}
            </div>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !number.trim() || !name.trim() || choice === null} title={choice === null ? "Waiting for the firm's title blocks to load" : undefined}>
              {busy && <Spinner data-icon="inline-start" />}
              {sheet ? 'Save' : 'Create and open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RenameViewDialog({ view, onCancel, onRename }: { view: ViewElement; onCancel: () => void; onRename: (name: string) => string | null }) {
  const [name, setName] = useState(view.name)
  const { error, busy, run } = useSave(onCancel)
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => onRename(name.trim()))
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename view</DialogTitle>
            <DialogDescription>The new name shows on every sheet this view is placed on.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rv-name">Name</FieldLabel>
            <Input id="rv-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || name.trim() === view.name}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => string | null
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault()
              const refusal = onConfirm()
              if (refusal) setError(refusal)
              else onCancel()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type PrintChoice = 'saved' | 'wait'

/**
 * Print a sheet. When your own unsaved edits touch this sheet (its views, the
 * levels they show, its notes), choose explicitly: print what is saved now, or
 * wait for those edits to save first.
 */
export function PrintDialog({
  sheet,
  savedRevision,
  pendingOnSheet,
  onCancel,
  onPrint,
}: {
  sheet: Sheet
  savedRevision: number
  pendingOnSheet: number
  onCancel: () => void
  onPrint: (choice: PrintChoice) => Promise<string | null>
}) {
  const [choice, setChoice] = useState<PrintChoice>(pendingOnSheet > 0 ? 'wait' : 'saved')
  const { error, busy, run } = useSave(onCancel)
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Print {sheet.number} to PDF</DialogTitle>
          <DialogDescription>A vector PDF at true scale, {paperWords(sheetPaperSize(sheet))}. Printing doesn&apos;t issue the sheet.</DialogDescription>
        </DialogHeader>
        {pendingOnSheet > 0 ? (
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v === 'saved' ? 'saved' : 'wait')} className="gap-3">
            <div className="flex items-start gap-2">
              <RadioGroupItem id="pr-wait" value="wait" />
              <Label htmlFor="pr-wait" className="flex flex-col items-start gap-0.5 font-normal">
                <span className="font-medium">Wait for my pending edits, then print</span>
                <span className="text-xs text-muted-foreground">
                  {pendingOnSheet} of your changes on this sheet {pendingOnSheet === 1 ? "isn't" : "aren't"} saved yet. If one is refused, nothing prints and you&apos;ll see why.
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem id="pr-saved" value="saved" />
              <Label htmlFor="pr-saved" className="flex flex-col items-start gap-0.5 font-normal">
                <span className="font-medium">Print the last saved revision (Rev {savedRevision})</span>
                <span className="text-xs text-muted-foreground">Leaves out your changes still on their way.</span>
              </Label>
            </div>
          </RadioGroup>
        ) : (
          <p className="text-sm">Everything on this sheet is saved. It prints from Rev {savedRevision}.</p>
        )}
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run(() => onPrint(choice))} disabled={busy} data-testid="print-pdf-confirm">
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? (choice === 'wait' && pendingOnSheet > 0 ? 'Waiting for edits to save…' : 'Drawing the PDF…') : 'Print PDF'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
