'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, Plus, Printer, Stamp, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { elementsOfKind, scaleLabel, setOrder, type ModelState, type Sheet, type SheetRevision } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { nextRevisionNumber, revisionTableProblem, sheetLayoutCommand } from '../../contracts/building-model/sheet-commands'
import type { IssueSetResult, PrintSetResult } from '../../contracts/bim/drawing-set-results'
import { fetchSetStatusFrom, issueSetFrom, printSetFrom, type SetStatus } from './drawing-set-client'
import type { SubmitCommand } from './types'
import { useEditorHost, useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { IssueBlockedNotice } from '../code-change/IssueBlockedNotice'

/**
 * A person's drawing-set workflow in Views & Sheets: arrange a sheet's views,
 * keep its revision table, print the set and issue it. Arrange and the
 * revision table send the same kernel commands as the agent's
 * bim_auto_layout_sheet and bim_set_sheet_properties; Print set and Issue set
 * run on the server through the agent's own print and issue path.
 */

const IN = 25.4
const today = () => new Date().toISOString().slice(0, 10)

/** Refusal shown in the dialog, or null when the edit went through. */
type Submit = SubmitCommand

// ── Arrange views ────────────────────────────────────────────────────────────

export function ArrangeSheetDialog({ model, sheet, onCancel, submit }: { model: ModelState; sheet: Sheet; onCancel: () => void; submit: Submit }) {
  const [mode, setMode] = useState<'pack' | 'grid'>('pack')
  const [columns, setColumns] = useState('2')
  const [gapIn, setGapIn] = useState('0.5')
  const [fitScales, setFitScales] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const gap = Number(gapIn)
  const cols = Number(columns)
  const valid = Number.isFinite(gap) && gap >= 0 && gap <= 4 && (mode === 'pack' || (Number.isInteger(cols) && cols >= 1 && cols <= 12))
  const plan = useMemo(() => {
    if (!valid) return null
    try {
      return sheetLayoutCommand(model, sheet.id, { mode, gapMm: gap * IN, fitScales, ...(mode === 'grid' ? { columns: cols } : {}) })
    } catch (err) {
      console.error('[ArrangeSheetDialog] working out the layout failed', { sheetId: sheet.id, err })
      return null
    }
  }, [model, sheet.id, mode, gap, cols, fitScales, valid])
  const apply = () => {
    if (!plan?.command) return
    const refusal = submit(plan.command, `arrange the views on ${sheet.number}`)
    if (refusal) setError(refusal)
    else {
      toast(`${sheet.number} arranged. Ctrl+Z puts the views back.`)
      onCancel()
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="arrange-sheet-dialog">
        <DialogHeader>
          <DialogTitle>Arrange views on {sheet.number}</DialogTitle>
          <DialogDescription>Places every view and schedule inside the border and left of the title block, with room for each view&apos;s title. Same sheet, same answer every time.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Arrangement</FieldLabel>
            <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => (v === 'pack' || v === 'grid') && setMode(v)}>
              <ToggleGroupItem value="pack">Rows, in order</ToggleGroupItem>
              <ToggleGroupItem value="grid">Even grid</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {mode === 'grid' && (
              <Field>
                <FieldLabel htmlFor="ar-cols">Columns</FieldLabel>
                <Input id="ar-cols" inputMode="numeric" value={columns} onChange={(e) => setColumns(e.target.value)} />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="ar-gap">Space between (in)</FieldLabel>
              <Input id="ar-gap" inputMode="decimal" value={gapIn} onChange={(e) => setGapIn(e.target.value)} />
            </Field>
          </div>
          <Field orientation="horizontal">
            <Checkbox id="ar-fit" checked={fitScales} onCheckedChange={(c) => setFitScales(c === true)} />
            <FieldLabel htmlFor="ar-fit" className="font-normal">Shrink a view to the next standard scale when it doesn&apos;t fit (never enlarges)</FieldLabel>
          </Field>
          {!valid ? (
            <FieldError>Space is 0 to 4 inches; a grid has 1 to 12 columns.</FieldError>
          ) : plan === null ? (
            <FieldError>The layout couldn&apos;t be worked out for this sheet. Check its views, then try again.</FieldError>
          ) : (
            <div className="flex flex-col gap-1 text-sm" data-testid="arrange-preview">
              <p>{plan.command ? `${plan.layout.moves.length} view${plan.layout.moves.length === 1 ? '' : 's'} move${plan.layout.moves.length === 1 ? 's' : ''}.` : 'Everything is already where this arrangement puts it.'}</p>
              {plan.layout.moves.filter((m) => m.scale !== undefined).map((m) => (
                <p key={m.viewportId} className="text-xs text-muted-foreground">{m.viewName} drops to {scaleLabel(m.scale ?? 1)} to fit.</p>
              ))}
              {plan.layout.unplaced.map((u) => (
                <p key={u.viewportId} className="text-xs text-danger-600">{u.viewName} can&apos;t fit: {u.reason}</p>
              ))}
            </div>
          )}
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={apply} disabled={!plan?.command} data-testid="arrange-apply">Arrange</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Revision table ───────────────────────────────────────────────────────────

export function RevisionsDialog({ sheet, allSheets, onCancel, submit }: { sheet: Sheet; allSheets: readonly Sheet[]; onCancel: () => void; submit: Submit }) {
  const [rows, setRows] = useState<SheetRevision[]>(() => [...(sheet.props?.revisions ?? [])])
  const [error, setError] = useState<string | null>(null)
  const set = (i: number, key: keyof SheetRevision, value: string) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)))
  const add = () => setRows((prev) => [...prev, { number: nextRevisionNumber([{ props: { revisions: prev } }, ...allSheets.filter((s) => s.id !== sheet.id)]), date: today(), description: '' }])
  const save = () => {
    const trimmed = rows.map((r) => ({ number: r.number.trim(), date: r.date.trim(), description: r.description.trim() }))
    const problem = revisionTableProblem(sheet.number, trimmed)
    if (problem) {
      setError(problem)
      return
    }
    const refusal = submit({ type: 'set_sheet_properties', sheetId: sheet.id, revisions: trimmed }, `update the revisions on ${sheet.number}`)
    if (refusal) setError(refusal)
    else onCancel()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-2xl" data-testid="revisions-dialog">
        <DialogHeader>
          <DialogTitle>Revisions on {sheet.number}</DialogTitle>
          <DialogDescription>The revision table printed in the title block, oldest first. Issue set adds one row to every issued sheet for you.</DialogDescription>
        </DialogHeader>
        <Table>
          <TableCaption className="sr-only">Revision rows on {sheet.number}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Rev</TableHead>
              <TableHead className="w-36">Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-10"><span className="sr-only">Remove</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-sm text-muted-foreground">No revisions yet. Add one, or let Issue set add it.</TableCell>
              </TableRow>
            ) : (
              rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell><Input aria-label={`Revision ${i + 1} number`} value={r.number} maxLength={10} onChange={(e) => set(i, 'number', e.target.value)} /></TableCell>
                  <TableCell><Input aria-label={`Revision ${i + 1} date`} value={r.date} maxLength={20} onChange={(e) => set(i, 'date', e.target.value)} /></TableCell>
                  <TableCell><Input aria-label={`Revision ${i + 1} description`} value={r.description} maxLength={80} placeholder="ISSUED FOR PERMIT" onChange={(e) => set(i, 'description', e.target.value)} /></TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove revision ${r.number || i + 1}`} onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <div>
          <Button variant="outline" size="sm" onClick={add} disabled={rows.length >= 20} data-testid="revisions-add">
            <Plus data-icon="inline-start" />
            Add revision
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} data-testid="revisions-save">Save revisions</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared: which sheets, and saving first ──────────────────────────────────

function SheetPicker({ sheets, picked, onChange }: { sheets: readonly Sheet[]; picked: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Sheets ({picked.size} of {sheets.length}, in printed order)</FieldLegend>
      <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-md border p-2" data-testid="set-sheet-picker">
        {sheets.map((s) => (
          <Field key={s.id} orientation="horizontal">
            <Checkbox
              id={`set-sheet-${s.id}`}
              checked={picked.has(s.id)}
              onCheckedChange={(c) => {
                const next = new Set(picked)
                if (c === true) next.add(s.id)
                else next.delete(s.id)
                onChange(next)
              }}
            />
            <FieldLabel htmlFor={`set-sheet-${s.id}`} className="font-normal">
              <span className="font-medium">{s.number}</span> {s.title}
            </FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
  )
}

/** The picked sheets in printed order; undefined when every sheet is picked (the server's binding order). */
function pickedList(sheets: readonly Sheet[], picked: ReadonlySet<string>): string[] | undefined {
  return picked.size === sheets.length ? undefined : sheets.filter((s) => picked.has(s.id)).map((s) => s.id)
}

export interface SaveState {
  /** Your own edits still on their way to the model server. */
  readonly pending: number
  /** Resolves true once they're saved, false after the wait. */
  readonly waitForSaved: (ms: number) => Promise<boolean>
}

async function saveFirst(save: SaveState): Promise<string | null> {
  if (save.pending === 0) return null
  return (await save.waitForSaved(30_000)) ? null : "Your edits still aren't saved after 30 seconds. Wait until the status says All changes saved, then try again."
}

/** Where a host lists an issued set's Verify pages, when this one has none. */
const NO_ISSUED_SHEET_LINKS = 'This app keeps no published copies of issued sheets, so there are no Verify pages to open here. The issued PDF is the record of the set.'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── Print set ────────────────────────────────────────────────────────────────

export function PrintSetDialog({ projectId, modelId, model, save, onCancel }: { projectId: string; modelId: string; model: ModelState; save: SaveState; onCancel: () => void }) {
  const drawingSets = useEditorHost().data.drawingSets
  const sheets = useMemo(() => setOrder(elementsOfKind(model.elements, 'sheet').filter((e) => !e.deleted)), [model])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sheets.map((s) => s.id)))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printed, setPrinted] = useState<Extract<PrintSetResult, { status: 'printed' }> | null>(null)
  const run = async () => {
    setError(null)
    setBusy(save.pending > 0 ? 'Waiting for your edits to save…' : 'Drawing the set…')
    try {
      const notSaved = await saveFirst(save)
      if (notSaved) return setError(notSaved)
      setBusy('Drawing the set…')
      const result = await printSetFrom(drawingSets, projectId, modelId, { sheets: pickedList(sheets, picked) })
      if (result.status === 'refused') return setError(result.message)
      setPrinted(result)
      toast.success(`Printed ${result.sheets.length} sheet${result.sheets.length === 1 ? '' : 's'} from Rev ${result.revision}.`)
    } catch (err) {
      console.error('[PrintSetDialog] printing the set failed', err)
      setError(err instanceof Error ? err.message : "The set couldn't be printed. Try again.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-lg" data-testid="print-set-dialog">
        <DialogHeader>
          <DialogTitle>Print the set</DialogTitle>
          <DialogDescription>One vector PDF at true scale, a page per sheet, from the last saved revision. Printing doesn&apos;t issue; Issue set checks against this print.</DialogDescription>
        </DialogHeader>
        {sheets.length === 0 ? (
          <p className="text-sm">This model has no sheets yet. Make one with + in Views and sheets.</p>
        ) : printed ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="print-set-result">
            <p>
              Printed {printed.sheets.length} sheet{printed.sheets.length === 1 ? '' : 's'} from Rev {printed.revision}: {printed.sheets.map((s) => s.number).join(', ')}.
            </p>
            {printed.titleBlockNote && <p className="text-xs text-warning-700">{printed.titleBlockNote}</p>}
            {printed.backgroundsMissing.length > 0 && <p className="text-xs text-warning-700">Printed without some linked backgrounds: {printed.backgroundsMissing.join('; ')}</p>}
            {printed.printNotes.map((note) => <p key={note} className="text-xs text-warning-700">{note}</p>)}
            <Button asChild variant="outline" className="self-start">
              <a href={printed.downloadUrl} target="_blank" rel="noopener noreferrer" data-testid="print-set-download">
                <Download data-icon="inline-start" />
                Open the PDF
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">The link works for {Math.round(printed.expiresInSeconds / 60)} minutes.</p>
          </div>
        ) : (
          <SheetPicker sheets={sheets} picked={picked} onChange={setPicked} />
        )}
        {save.pending > 0 && !printed && <p className="text-xs text-muted-foreground">{save.pending} of your changes {save.pending === 1 ? "isn't" : "aren't"} saved yet; the set prints once they are.</p>}
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy !== null}>{printed ? 'Done' : 'Cancel'}</Button>
          {!printed && (
            <Button onClick={() => void run()} disabled={busy !== null || picked.size === 0} data-testid="print-set-confirm">
              {busy ? <Spinner data-icon="inline-start" /> : <Printer data-icon="inline-start" />}
              {busy ?? 'Print set'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Issue set ────────────────────────────────────────────────────────────────

export function IssueSetDialog({ projectId, modelId, model, save, canIssue, blockedReason, onCancel, onPrintAgain }: {
  projectId: string
  modelId: string
  model: ModelState
  save: SaveState
  canIssue: boolean
  blockedReason: string
  onCancel: () => void
  /** Close and open Print set. */
  onPrintAgain: () => void
}) {
  const IssuedSheetLinks = useOptionalEditorHost()?.shell.IssuedSheetLinks
  const drawingSets = useEditorHost().data.drawingSets
  const sheets = useMemo(() => setOrder(elementsOfKind(model.elements, 'sheet').filter((e) => !e.deleted)), [model])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sheets.map((s) => s.id)))
  const [status, setStatus] = useState<SetStatus | null>(null)
  const [loading, setLoading] = useState<string | null>(save.pending > 0 ? 'Waiting for your edits to save…' : 'Checking the set…')
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('Issued for permit')
  const [addRow, setAddRow] = useState(true)
  const [revNumber, setRevNumber] = useState(() => nextRevisionNumber(sheets))
  const [revDate, setRevDate] = useState(today)
  const [revText, setRevText] = useState('ISSUED FOR PERMIT')
  const [accepted, setAccepted] = useState(false)
  const [issued, setIssued] = useState<Extract<IssueSetResult, { status: 'issued' | 'already_issued' }> | null>(null)
  const [verifyIssue, setVerifyIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = pickedList(sheets, picked)
  const listKey = list?.join(',') ?? 'all'
  const { pending, waitForSaved } = save

  const [checkRun, setCheckRun] = useState(0)
  /** Check again (after a refusal, or when the sheets picked change). */
  const recheck = () => {
    setError(null)
    setLoading('Checking the set…')
    setCheckRun((n) => n + 1)
  }

  useEffect(() => {
    let live = true
    const run = async () => {
      try {
        const notSaved = await saveFirst({ pending, waitForSaved })
        if (!live) return
        if (notSaved) {
          setError(notSaved)
          return
        }
        const next = await fetchSetStatusFrom(drawingSets, projectId, modelId, listKey === 'all' ? undefined : listKey.split(','))
        if (!live) return
        setStatus(next)
        if (next.check.status === 'ready') setRevNumber(next.check.nextRevision)
        setAccepted(false)
      } catch (err) {
        console.error('[IssueSetDialog] checking the set failed', err)
        if (live) setError(err instanceof Error ? err.message : "The set couldn't be checked. Try again.")
      } finally {
        if (live) setLoading(null)
      }
    }
    void run()
    return () => {
      live = false
    }
  }, [drawingSets, projectId, modelId, listKey, pending, waitForSaved, checkRun])

  const ready = status?.check.status === 'ready' ? status.check : null
  const differs = ready && ready.comparison.status !== 'matches_print'
  const issue = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await issueSetFrom(drawingSets, projectId, modelId, {
        name: name.trim(),
        expectedRevision: ready.revision,
        ...(list ? { sheets: list } : {}),
        ...(addRow ? { addRevision: { number: revNumber.trim(), date: revDate.trim(), description: revText.trim() } } : {}),
        ...(differs ? { acceptChangesSincePrint: accepted } : {}),
      })
      if (result.status === 'issued' || result.status === 'already_issued') {
        setIssued(result)
        toast.success(result.message)
      } else {
        setError(result.message)
        if (result.status === 'needs_print' || result.status === 'refused') recheck()
      }
    } catch (err) {
      console.error('[IssueSetDialog] issuing the set failed', err)
      setError(err instanceof Error ? err.message : "The set couldn't be issued. Try again.")
    } finally {
      setBusy(false)
    }
  }
  const rowMissing = addRow && (!revNumber.trim() || !revDate.trim() || !revText.trim())
  const codeBlocked = status?.codeCheck && !status.codeCheck.ok ? status.codeCheck.words : null
  const reason = !canIssue ? blockedReason : !ready ? null : picked.size === 0 ? 'Pick at least one sheet.' : codeBlocked ? `${codeBlocked}. Each signer opens the sheet and chooses Re-check and sign, or Override with a reason.` : !name.trim() ? 'Name the issue.' : rowMissing ? 'The revision row needs a number, a date and a description.' : differs && !accepted ? 'Print the set again, or confirm you checked the sheets that changed.' : null

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto" data-testid="issue-set-dialog">
        <DialogHeader>
          <DialogTitle>Issue the set</DialogTitle>
          <DialogDescription>Adds the revision row, captures the model, draws the set from that capture and files the PDF in the project&apos;s Workspace › Issued drawings. Later edits never change an issued set.</DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="issue-set-result">
            <p>{issued.message}</p>
            <p className="text-xs text-muted-foreground">
              {issued.sheets.map((s) => `${s.number}${s.revision ? ` rev ${s.revision}` : ''}`).join(', ')}
            </p>
            <Button asChild variant="outline" className="self-start">
              <a href={issued.downloadUrl} target="_blank" rel="noopener noreferrer" data-testid="issue-set-download">
                <Download data-icon="inline-start" />
                Open the issued PDF
              </a>
            </Button>
            {/* V10: each sheet's Verify page and own PDF. */}
            {IssuedSheetLinks ? (
              <IssuedSheetLinks modelRef={projectId} issueId={issued.issueId} />
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="issued-sheet-links-unavailable">{NO_ISSUED_SHEET_LINKS}</p>
            )}
          </div>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm"><Spinner />{loading}</p>
        ) : status?.check.status === 'refused' ? (
          <p className="text-sm text-danger-600" role="alert">{status.check.message}</p>
        ) : ready ? (
          <FieldGroup>
            <Alert className={differs ? 'border-warning-300 bg-warning-50' : 'border-success-300 bg-success-50'} data-testid="issue-print-check" data-status={ready.comparison.status}>
              <AlertTitle>{differs ? 'Changed since the last print' : 'Matches the last print'}</AlertTitle>
              <AlertDescription>
                <p>{ready.message}</p>
                {status?.history.lastPrint && (
                  <p className="text-xs">
                    Last set print: Rev {status.history.lastPrint.modelRevision}, {when(status.history.lastPrint.printedAt)}
                    {status.history.lastPrint.printedByName ? ` by ${status.history.lastPrint.printedByName}` : ''}.{' '}
                    <a className="underline" href={status.history.lastPrint.downloadUrl} target="_blank" rel="noopener noreferrer">Open it</a>
                  </p>
                )}
                {differs && (
                  <div className="mt-2 flex flex-col gap-2">
                    <Button variant="outline" size="sm" className="self-start" onClick={onPrintAgain} data-testid="issue-print-again">
                      <Printer data-icon="inline-start" />
                      Print the set again
                    </Button>
                    <Field orientation="horizontal">
                      <Checkbox id="is-accept" checked={accepted} onCheckedChange={(c) => setAccepted(c === true)} data-testid="issue-accept-changes" />
                      <FieldLabel htmlFor="is-accept" className="font-normal">I&apos;ve checked these sheets as they draw now. Issue them anyway.</FieldLabel>
                    </Field>
                  </div>
                )}
              </AlertDescription>
            </Alert>
            {/* C10: approvals checked against an older rule block a reissue until their signer acts. */}
            {status?.codeCheck && <IssueBlockedNotice check={status.codeCheck} />}
            <Field>
              <FieldLabel htmlFor="is-name">Issue</FieldLabel>
              <Input id="is-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              <FieldDescription>Prints as the PDF title, e.g. Issued for permit, Bid set, Addendum 1.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="is-row" checked={addRow} onCheckedChange={(c) => setAddRow(c === true)} />
              <FieldLabel htmlFor="is-row" className="font-normal">Add a revision row to every issued sheet</FieldLabel>
            </Field>
            {addRow && (
              <div className="grid grid-cols-[5rem_8rem_1fr] gap-2">
                <Field>
                  <FieldLabel htmlFor="is-rev">Rev</FieldLabel>
                  <Input id="is-rev" value={revNumber} maxLength={10} onChange={(e) => setRevNumber(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="is-date">Date</FieldLabel>
                  <Input id="is-date" value={revDate} maxLength={20} onChange={(e) => setRevDate(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="is-desc">Description</FieldLabel>
                  <Input id="is-desc" value={revText} maxLength={80} onChange={(e) => setRevText(e.target.value)} />
                </Field>
              </div>
            )}
            <SheetPicker
              sheets={sheets}
              picked={picked}
              onChange={(next) => {
                setPicked(next)
                recheck()
              }}
            />
            <p className="text-xs text-muted-foreground">Issues from saved Rev {ready.revision}. If anyone saves before you press Issue, nothing is issued and you&apos;re asked to check again.</p>
            {status && status.history.issues.length > 0 && (
              <FieldSet>
                <FieldLegend variant="label">Earlier issues</FieldLegend>
                <ul className="flex flex-col gap-1 text-xs" data-testid="issue-history">
                  {status.history.issues.map((i) => (
                    <li key={i.issueId}>
                      <a className="underline" href={i.downloadUrl} target="_blank" rel="noopener noreferrer">{i.name}</a>, Rev {i.modelRevision}, {when(i.issuedAt)}
                      {i.issuedByName ? ` by ${i.issuedByName}` : ''} ({i.sheets.length} sheet{i.sheets.length === 1 ? '' : 's'})
                      {/* V10: the issue's Verify pages, on demand. */}
                      {IssuedSheetLinks && (
                        <Button variant="link" size="sm" onClick={() => setVerifyIssue(verifyIssue === i.issueId ? null : i.issueId)} aria-expanded={verifyIssue === i.issueId} data-testid="issue-history-verify">
                          {verifyIssue === i.issueId ? 'Hide Verify pages' : 'Verify pages'}
                        </Button>
                      )}
                      {IssuedSheetLinks && verifyIssue === i.issueId && <IssuedSheetLinks modelRef={projectId} issueId={i.issueId} withdraw={{ issueName: i.name, disabledReason: canIssue ? null : blockedReason }} />}
                    </li>
                  ))}
                </ul>
              </FieldSet>
            )}
          </FieldGroup>
        ) : null}
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>{issued ? 'Done' : 'Cancel'}</Button>
          {!issued && (
            <Button onClick={() => void issue()} disabled={busy || !ready || reason !== null} title={reason ?? undefined} data-testid="issue-set-confirm">
              {busy ? <Spinner data-icon="inline-start" /> : <Stamp data-icon="inline-start" />}
              {busy ? 'Issuing…' : 'Issue set'}
            </Button>
          )}
        </DialogFooter>
        {!issued && reason && ready && <p className="text-right text-xs text-muted-foreground" data-testid="issue-blocked-reason">{reason}</p>}
      </DialogContent>
    </Dialog>
  )
}
