'use client'

import { useState } from 'react'
import { Columns3, Plus } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Spinner } from '../../ui/spinner'
import { NEW_FIELD_UNITS, type EquipmentLibrary, type NewFieldType } from './library-fields'
import type { EquipmentParameter, ParameterSource } from './parameters'

const SOURCE_LABELS: Readonly<Record<ParameterSource, string>> = { builtin: 'Built-in', firm: 'Firm', project: 'This project' }

interface Props {
  readonly library: EquipmentLibrary
  /** Parameter names the list already shows. */
  readonly shown: ReadonlySet<string>
  /** Null when this person may change the model; otherwise why not. */
  readonly editBlocked: string | null
  readonly onClose: () => void
  /** Show the column (in the Equipment list schedule and the paste grid); null when shown, else why not. */
  readonly onAdd: (parameter: EquipmentParameter) => string | null
}

/**
 * Equipment list › Add column (decision 3): show a column the library
 * already has (the baseline, the firm's, this project's), or make a new
 * column for this project. Firm columns are made in Settings › MutinyBIM
 * library by a library editor; they appear here with no code change.
 */
export function AddColumnDialog({ library, shown, editBlocked, onClose, onAdd }: Props) {
  const available = library.parameters.filter((p) => !shown.has(p.name))
  const [pick, setPick] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState<NewFieldType>('text')
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const show = (p: EquipmentParameter | undefined) => {
    if (!p) return
    const refused = onAdd(p)
    if (refused) setProblem(refused)
    else onClose()
  }

  const create = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const made = await library.addProjectField({ label, type, ...(type === 'number' ? { unit } : {}) })
      if (!made.ok) {
        setProblem(made.message)
        return
      }
      show(made.parameter)
    } finally {
      setBusy(false)
    }
  }

  const newBlocked = editBlocked ?? (library.project.allowed ? null : (library.project.reason ?? "You can't add columns to this project's library."))
  const createWhy = newBlocked ?? (label.trim() === '' ? 'Give the column a name first.' : type === 'number' && unit === '' ? 'Choose the unit first.' : null)
  const bySource = (['project', 'firm', 'builtin'] as const).map((s) => ({ source: s, items: available.filter((p) => p.source === s) })).filter((g) => g.items.length > 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="equipment-add-column-dialog">
        <DialogHeader>
          <DialogTitle>Add a column to the equipment list</DialogTitle>
          <DialogDescription>Columns are parameters: once added, the value shows in the list, the Inspector and tags, and a pasted sheet can fill it.</DialogDescription>
        </DialogHeader>
        {library.status === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner data-icon="inline-start" />
            Loading the firm&rsquo;s and this project&rsquo;s columns…
          </p>
        )}
        {library.error && (
          <Alert variant="destructive" data-testid="equipment-columns-error">
            <AlertTitle>Some columns are missing</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {library.error}
              <Button size="sm" variant="outline" onClick={library.retry}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <FieldSet>
          <FieldLegend variant="label">From the library</FieldLegend>
          <FieldGroup className="gap-2">
            <Field>
              <FieldLabel htmlFor="bm-add-column-pick">Column</FieldLabel>
              <Select value={pick || undefined} onValueChange={setPick} disabled={editBlocked !== null || available.length === 0}>
                <SelectTrigger id="bm-add-column-pick" data-testid="equipment-add-column-pick">
                  <SelectValue placeholder={available.length === 0 ? 'Every library column is already shown' : 'Choose a column'} />
                </SelectTrigger>
                <SelectContent>
                  {bySource.map((g) => (
                    <SelectGroup key={g.source}>
                      <SelectLabel>{SOURCE_LABELS[g.source]}</SelectLabel>
                      {g.items.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.label}
                          {p.unit && p.unit !== '1' ? ` (${p.unit})` : ''}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Firm columns are added by a library editor in Settings › MutinyBIM library.</FieldDescription>
            </Field>
            <Button size="sm" onClick={() => show(available.find((p) => p.name === pick))} disabled={editBlocked !== null || pick === ''} title={editBlocked ?? (pick === '' ? 'Choose a column first.' : undefined)} data-testid="equipment-add-column-show">
              <Columns3 data-icon="inline-start" />
              Show this column
            </Button>
          </FieldGroup>
        </FieldSet>
        <Separator />
        <FieldSet>
          <FieldLegend variant="label">New column for this project</FieldLegend>
          <FieldGroup className="gap-2">
            <Field>
              <FieldLabel htmlFor="bm-add-column-label">Name</FieldLabel>
              <Input id="bm-add-column-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hood ID" disabled={newBlocked !== null} data-testid="equipment-add-column-label" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel htmlFor="bm-add-column-type">Holds</FieldLabel>
                <Select value={type} onValueChange={(v) => setType(v === 'number' || v === 'yes_no' ? v : 'text')} disabled={newBlocked !== null}>
                  <SelectTrigger id="bm-add-column-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="number">A number</SelectItem>
                      <SelectItem value="yes_no">Yes or no</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {type === 'number' && (
                <Field>
                  <FieldLabel htmlFor="bm-add-column-unit">Unit</FieldLabel>
                  <Select value={unit || undefined} onValueChange={setUnit} disabled={newBlocked !== null}>
                    <SelectTrigger id="bm-add-column-unit">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {NEW_FIELD_UNITS.map((u) => (
                          <SelectItem key={u.unit} value={u.unit}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            {newBlocked && (
              <FieldDescription data-testid="equipment-add-column-blocked">{newBlocked}</FieldDescription>
            )}
            <Button size="sm" variant="outline" onClick={() => void create()} disabled={createWhy !== null || busy} title={createWhy ?? undefined} data-testid="equipment-add-column-create">
              {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
              {busy ? 'Saving…' : 'Make the column'}
            </Button>
          </FieldGroup>
        </FieldSet>
        {problem && (
          <Alert variant="destructive" data-testid="equipment-add-column-problem">
            <AlertTitle>Column not added</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
