'use client'

import { useState } from 'react'
import { codeLabel, jurisdictionWords, parseJurisdiction, type CodeOfRecord, type JurisdictionId } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { CODE_OF_RECORD_DISCIPLINES as DISCIPLINES, CODE_OF_RECORD_DISCIPLINE_LABELS } from '../../contracts/bim/code-change/words'

type Save = { readonly state: 'idle' } | { readonly state: 'saving' } | { readonly state: 'saved'; readonly words: string } | { readonly state: 'error'; readonly message: string }

/**
 * Building Model › Manage › Model settings › **Codes** (round 10, C10): the
 * project's code of record, per discipline (building, fire, energy, …), and
 * where the project is (any country: country, region, locality). This, and
 * only this, is "the project's code": changing it tells each person whose
 * approvals relied on the old code, once. A state adopting a new edition
 * changes nothing here (projects keep the code they were permitted under).
 */
export function CodesOfRecordForm({
  codes,
  jurisdiction,
  canEdit,
  onSaveCode,
  onSaveJurisdiction,
}: {
  readonly codes: readonly CodeOfRecord[]
  readonly jurisdiction: JurisdictionId | null
  readonly canEdit: boolean
  /** Saves the discipline's code of record in the model, then tells the signers; resolves with the words to show ("2 people were told"). */
  readonly onSaveCode: (code: CodeOfRecord) => Promise<string>
  readonly onSaveJurisdiction: (j: JurisdictionId) => Promise<void>
}) {
  const [view, setView] = useState<'codes' | 'place'>('codes')
  const [discipline, setDiscipline] = useState<string>('building')
  const existing = codes.find((c) => c.discipline === discipline)
  const [instrument, setInstrument] = useState(existing?.instrument ?? '')
  const [edition, setEdition] = useState(existing?.edition ?? '')
  const [adoptedAs, setAdoptedAs] = useState(existing?.adoptedAs ?? '')
  const [save, setSave] = useState<Save>({ state: 'idle' })
  const [place, setPlace] = useState({
    country: jurisdiction?.country ?? '',
    subdivision: jurisdiction?.subdivision ?? '',
    locality: jurisdiction?.locality ?? '',
  })
  const [placeSave, setPlaceSave] = useState<Save>({ state: 'idle' })

  const pick = (d: string) => {
    setDiscipline(d)
    const c = codes.find((x) => x.discipline === d)
    setInstrument(c?.instrument ?? '')
    setEdition(c?.edition ?? '')
    setAdoptedAs(c?.adoptedAs ?? '')
    setSave({ state: 'idle' })
  }

  const parsedPlace = parseJurisdiction({
    country: place.country,
    subdivision: place.subdivision || undefined,
    locality: place.locality || undefined,
  })
  const ready = instrument.trim() !== '' && edition.trim() !== ''
  const unchanged = existing && existing.instrument === instrument.trim() && existing.edition === edition.trim() && (existing.adoptedAs ?? '') === adoptedAs.trim()
  const why = !canEdit ? 'Changing the project’s code needs permission to edit this model.' : !ready ? 'Name the code and its edition first.' : unchanged ? 'Nothing changed yet.' : null

  const submit = async () => {
    setSave({ state: 'saving' })
    try {
      const words = await onSaveCode({
        discipline,
        instrument: instrument.trim(),
        edition: edition.trim(),
        ...(adoptedAs.trim() ? { adoptedAs: adoptedAs.trim() } : {}),
        ...(parsedPlace ? { jurisdiction: parsedPlace } : {}),
      })
      setSave({ state: 'saved', words })
    } catch (err) {
      console.error('[CodesOfRecordForm] saving the code of record failed', {
        discipline,
        err,
      })
      setSave({
        state: 'error',
        message: err instanceof Error ? err.message : 'The code wasn’t saved.',
      })
    }
  }

  const submitPlace = async () => {
    if (!parsedPlace) return
    setPlaceSave({ state: 'saving' })
    try {
      await onSaveJurisdiction(parsedPlace)
      setPlaceSave({
        state: 'saved',
        words: `Saved: ${jurisdictionWords(parsedPlace)}`,
      })
    } catch (err) {
      console.error('[CodesOfRecordForm] saving where the project is failed', err)
      setPlaceSave({
        state: 'error',
        message: err instanceof Error ? err.message : 'Where the project is wasn’t saved.',
      })
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="codes-of-record">
      <Table>
        <TableCaption className="sr-only">The project’s code of record by discipline</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Discipline</TableHead>
            <TableHead>Code of record</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {DISCIPLINES.map((d) => {
            const c = codes.find((x) => x.discipline === d)
            return (
              <TableRow key={d}>
                <TableCell>{CODE_OF_RECORD_DISCIPLINE_LABELS[d] ?? d}</TableCell>
                <TableCell className={c ? '' : 'text-muted-foreground'}>{c ? codeLabel(c) : 'Not set'}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <ToggleGroup type="single" value={view} onValueChange={(v) => (v === 'codes' || v === 'place') && setView(v)} aria-label="What to change">
        <ToggleGroupItem value="codes">Codes</ToggleGroupItem>
        <ToggleGroupItem value="place">Where the project is</ToggleGroupItem>
      </ToggleGroup>

      {view === 'codes' ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="codes-discipline">Discipline</FieldLabel>
            <Select value={discipline} onValueChange={pick}>
              <SelectTrigger id="codes-discipline">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {DISCIPLINES.map((d) => (
                    <SelectItem key={d} value={d}>
                      {CODE_OF_RECORD_DISCIPLINE_LABELS[d] ?? d}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="codes-instrument">Code</FieldLabel>
            <Input id="codes-instrument" value={instrument} onChange={(e) => setInstrument(e.target.value)} placeholder="IBC" disabled={!canEdit} />
          </Field>
          <Field>
            <FieldLabel htmlFor="codes-edition">Edition</FieldLabel>
            <Input id="codes-edition" value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="2021" disabled={!canEdit} />
          </Field>
          <Field>
            <FieldLabel htmlFor="codes-adopted">Adopted as (optional)</FieldLabel>
            <Input id="codes-adopted" value={adoptedAs} onChange={(e) => setAdoptedAs(e.target.value)} placeholder="Virginia USBC 2021" disabled={!canEdit} />
            <FieldDescription>The code the authority enforces, when it isn’t the model code itself.</FieldDescription>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void submit()} disabled={why !== null || save.state === 'saving'} data-testid="codes-save">
              {save.state === 'saving' ? <Spinner data-icon="inline-start" /> : null}
              Save {CODE_OF_RECORD_DISCIPLINE_LABELS[discipline]?.toLowerCase() ?? discipline} code
            </Button>
            {why ? (
              <span className="text-xs text-muted-foreground" data-testid="codes-why">
                {why}
              </span>
            ) : null}
            {save.state === 'saved' ? (
              <span className="text-xs text-success-700" role="status">
                {save.words}
              </span>
            ) : null}
          </div>
          {save.state === 'error' ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {save.message}
                <Button size="xs" variant="outline" onClick={() => void submit()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      ) : (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="codes-country">Country</FieldLabel>
            <Input
              id="codes-country"
              value={place.country}
              onChange={(e) =>
                setPlace((p) => ({
                  ...p,
                  country: e.target.value.toUpperCase().slice(0, 2),
                }))
              }
              placeholder="US"
              disabled={!canEdit}
            />
            <FieldDescription>Two letters: US, CA, GB, SE…</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="codes-region">Region (optional)</FieldLabel>
            <Input
              id="codes-region"
              value={place.subdivision}
              onChange={(e) =>
                setPlace((p) => ({
                  ...p,
                  subdivision: e.target.value.toUpperCase(),
                }))
              }
              placeholder="US-VA"
              disabled={!canEdit}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="codes-locality">County or city (optional)</FieldLabel>
            <Input id="codes-locality" value={place.locality} onChange={(e) => setPlace((p) => ({ ...p, locality: e.target.value }))} placeholder="Fairfax County" disabled={!canEdit} />
            <FieldDescription>
              {parsedPlace ? jurisdictionWords(parsedPlace) : place.country ? 'That isn’t a place yet: check the country and region codes.' : 'Where the project is.'}
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void submitPlace()} disabled={!canEdit || !parsedPlace || placeSave.state === 'saving'} data-testid="codes-save-place">
              {placeSave.state === 'saving' ? <Spinner data-icon="inline-start" /> : null}
              Save where the project is
            </Button>
            {placeSave.state === 'saved' ? (
              <span className="text-xs text-success-700" role="status">
                {placeSave.words}
              </span>
            ) : null}
            {placeSave.state === 'error' ? <span className="text-xs text-danger-600">{placeSave.message}</span> : null}
          </div>
        </FieldGroup>
      )}
    </div>
  )
}
