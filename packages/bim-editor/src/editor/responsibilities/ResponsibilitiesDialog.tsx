'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Hand, RefreshCw, Trash2, UserPlus } from 'lucide-react'
import { checkingContextFor, disciplineLabel, writeCheckingContext, type ModelState } from '@permitzip/bim-kernel'
import { responsibilityElementIds } from '../../contracts/bim/responsibilities/pin-scope'
import { SignoffCheckedAgainst } from '../code-change/SignoffCheckedAgainst'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { ConfirmAction } from '../../ui/confirm-action'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Skeleton } from '../../ui/skeleton'
import { Spinner } from '../../ui/spinner'
import { Textarea } from '../../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { ResponsibilitiesResponse, ResponsibilityItem } from '../../contracts/bim/responsibilities/api'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { acceptResponsibilityFrom, decideRequestFrom, fetchResponsibilitiesFrom, nameResponsibleFrom, removeResponsibleFrom, takeResponsibilityFrom } from '../../contracts/bim/responsibilities/client'
import type { StoredScope } from '../../contracts/bim/responsibilities/model'
import { SCOPE_KIND_LABELS, SCOPE_KINDS, SHEET_SCOPE_HINT, scopeChoices, type Choice, type ScopeKind, type ScopeChoices } from './scope-choices'
import { recordedWords, takeOutcomeWords } from './signoff-words'
import { AssuranceButton } from '../signing/AssuranceButton'
import { SignoffSignatureLine } from '../signing/SignoffSignatureLine'
import { useAssuranceOffer, type AssuranceOffer } from '../signing/useAssuranceOffer'
import { secureLatestEntryFrom, secureOutcomeWords, type Assurance } from '../../contracts/bim/signing/client'

/**
 * Building Model › Manage › Responsibilities. The project lead names who is
 * responsible for each discipline (and, optionally, which part of it): a
 * person, or a company whose people approve each or any one of them. Each
 * named person accepts here before they count ("Waiting for J. Rao to
 * accept" until they do), and every acceptance is an entry in this model's
 * sign-off log. Anyone may "Take responsibility" for a discipline: at once
 * when they may edit the project and no one is named, otherwise as a request
 * the lead approves or declines here.
 */

export interface ResponsibilitiesDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly projectId: string
  readonly model: ModelState
}

type Load = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly data: ResponsibilitiesResponse }

export function useResponsibilities(projectId: string, active: boolean): { readonly load: Load; readonly reload: () => void } {
  const port = useEditorHost().data.responsibilities
  const [attempt, setAttempt] = useState(0)
  const key = `${projectId}|${attempt}`
  // Answers are kept with the request they belong to; any other request reads as loading.
  const [answer, setAnswer] = useState<{ readonly key: string; readonly load: Load } | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchResponsibilitiesFrom(port, projectId, controller.signal)
      .then((data) => setAnswer({ key, load: { state: 'ready', data } }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[Responsibilities] loading failed', err)
        setAnswer({ key, load: { state: 'error', message: err instanceof Error ? err.message : 'Who is responsible didn’t load.' } })
      })
    return () => controller.abort()
  }, [port, projectId, active, key])
  const load: Load = answer && answer.key === key ? answer.load : { state: 'loading' }
  return { load, reload: useCallback(() => setAttempt((n) => n + 1), []) }
}

function scopeFor(kind: ScopeKind, values: readonly string[]): StoredScope | undefined {
  if (kind === 'whole' || values.length === 0) return undefined
  return { [kind]: [...values] }
}

type FormMode = 'person' | 'firm' | 'take'

function PickOne({ id, label, placeholder, value, onChange, options }: { id: string; label: string; placeholder: string; value: string; onChange: (v: string) => void; options: readonly Choice[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** Name a person or a company (the lead), or take responsibility yourself: discipline and, optionally, which part. */
function NameForm({ mode, projectId, data, choices, onDone, onCancel }: { mode: FormMode; projectId: string; data: ResponsibilitiesResponse; choices: ScopeChoices; onDone: (notice: string | null) => void; onCancel: () => void }) {
  const port = useEditorHost().data.responsibilities
  const [who, setWho] = useState('')
  const [discipline, setDiscipline] = useState('')
  const [rule, setRule] = useState<'each' | 'any_one'>('each')
  const [kind, setKind] = useState<ScopeKind>('whole')
  const [values, setValues] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options: readonly Choice[] = kind === 'whole' ? [] : choices[kind]
  const people: readonly Choice[] = data.candidates.map((c) => ({ value: c.id, label: c.label }))
  const firms: readonly Choice[] = data.firms.map((f) => ({ value: f.organizationId, label: f.name }))
  const blocked =
    mode !== 'take' && who === ''
      ? mode === 'firm'
        ? 'Pick a company.'
        : 'Pick a person.'
      : discipline === ''
        ? 'Pick a discipline.'
        : kind !== 'whole' && values.length === 0
          ? `Tick at least one of ${SCOPE_KIND_LABELS[kind].toLowerCase()}, or choose All of it.`
          : null

  async function save() {
    if (blocked) return
    setSaving(true)
    setError(null)
    try {
      const scope = scopeFor(kind, values)
      const words = kind === 'whole' ? undefined : options.filter((o) => values.includes(o.value)).map((o) => o.label).join(', ')
      const extra = { ...(scope ? { scope } : {}), ...(words ? { scopeWords: words } : {}) }
      if (mode === 'take') {
        const out = await takeResponsibilityFrom(port, projectId, { discipline, ...extra })
        onDone(takeOutcomeWords(out, choices.disciplines.find((d) => d.value === discipline)?.label ?? discipline))
      } else if (mode === 'firm') {
        await nameResponsibleFrom(port, projectId, { kind: 'firm', organizationId: who, discipline, approvalRule: rule, ...extra })
        onDone(null)
      } else {
        await nameResponsibleFrom(port, projectId, { kind: 'person', personId: who, discipline, ...extra })
        onDone(null)
      }
    } catch (err) {
      console.error('[Responsibilities] saving failed', { mode, err })
      setError(err instanceof Error ? err.message : 'Couldn’t save that. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="rounded-md border p-3"
      data-testid={`responsibility-${mode}-form`}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <FieldGroup>
        {mode === 'person' ? (
          <Field>
            <FieldLabel htmlFor="resp-person">Person</FieldLabel>
            {people.length === 0 ? <p className="text-sm text-muted-foreground">No one else can see this project yet. Add people to the project first.</p> : <PickOne id="resp-person" label="Person" placeholder="Who is responsible" value={who} onChange={setWho} options={people} />}
          </Field>
        ) : null}
        {mode === 'firm' ? (
          <>
            <Field>
              <FieldLabel htmlFor="resp-firm">Company</FieldLabel>
              {firms.length === 0 ? (
                <p className="text-sm text-muted-foreground">No company has people who can see this project yet. Give a company’s people portal access first.</p>
              ) : (
                <PickOne id="resp-firm" label="Company" placeholder="Which company" value={who} onChange={setWho} options={firms} />
              )}
            </Field>
            <Field>
              <FieldLabel>Who approves</FieldLabel>
              <ToggleGroup type="single" variant="outline" size="sm" value={rule} onValueChange={(v) => (v === 'each' || v === 'any_one') && setRule(v)} aria-label="Who approves">
                <ToggleGroupItem value="each">Each of them</ToggleGroupItem>
                <ToggleGroupItem value="any_one">Any one of them</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`resp-${mode}-discipline`}>Discipline</FieldLabel>
          <PickOne id={`resp-${mode}-discipline`} label="Discipline" placeholder="For which discipline" value={discipline} onChange={setDiscipline} options={choices.disciplines} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`resp-${mode}-part`}>Which part</FieldLabel>
          <Select
            value={kind}
            onValueChange={(v) => {
              const next = SCOPE_KINDS.find((k) => k === v)
              if (next) {
                setKind(next)
                setValues([])
              }
            }}
          >
            <SelectTrigger id={`resp-${mode}-part`} aria-label="Which part">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SCOPE_KINDS.map((k) => (
                  <SelectItem key={k} value={k} disabled={k !== 'whole' && choices[k].length === 0}>
                    {SCOPE_KIND_LABELS[k]}
                    {k !== 'whole' && choices[k].length === 0 ? ' (none in this model)' : ''}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {kind === 'sheets' ? <FieldDescription>{SHEET_SCOPE_HINT}</FieldDescription> : null}
          {kind !== 'whole' ? (
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto" role="group" aria-label={SCOPE_KIND_LABELS[kind]}>
              {options.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <Checkbox aria-label={o.label} checked={values.includes(o.value)} onCheckedChange={(on) => setValues((v) => (on === true ? [...v, o.value] : v.filter((x) => x !== o.value)))} />
                  {o.label}
                </label>
              ))}
            </div>
          ) : null}
        </Field>
        {error ? <FieldError data-testid="responsibility-form-error">{error}</FieldError> : null}
      </FieldGroup>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={blocked !== null || saving} title={blocked ?? undefined} data-testid="responsibility-form-save">
          {saving ? <Spinner aria-hidden /> : null}
          {mode === 'take' ? 'Take responsibility' : 'Name them'}
        </Button>
      </div>
    </form>
  )
}

function Row({
  item,
  data,
  busy,
  projectId,
  signing,
  signedTick,
  model,
  onAccept,
  onAcceptSecured,
  onRemove,
  onDecide,
  onNameFromFirm,
}: {
  model: ModelState
  item: ResponsibilityItem
  data: ResponsibilitiesResponse
  busy: boolean
  projectId: string
  signing: AssuranceOffer
  signedTick: number
  onAccept: () => void
  onAcceptSecured: (assurance: Assurance) => void
  onRemove: () => Promise<void>
  onDecide: (grant: boolean, note?: string) => Promise<void>
  onNameFromFirm: (personId: string) => void
}) {
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [picking, setPicking] = useState('')
  const canName = data.powers.canName
  const deciders = data.deciders.map((d) => d.label).join(', ') || 'the project lead'
  const firmPeople = item.partyKind === 'firm' ? (data.firms.find((f) => f.organizationId === item.organizationId)?.people ?? []) : []
  const status =
    item.partyKind === 'firm' ? (
      <Badge variant="outline">{item.approvalRule === 'any_one' ? 'Any one of its people approves' : 'Each of its people approves'}</Badge>
    ) : item.pendingRequest ? (
      <Badge variant="outline" data-testid="responsibility-requested">
        Asked to be responsible · waiting for {deciders}
      </Badge>
    ) : item.acceptedAt ? (
      <Badge variant="secondary">Accepted</Badge>
    ) : (
      <Badge variant="outline" data-testid="responsibility-waiting">
        Waiting for {item.label} to accept
      </Badge>
    )
  return (
    <li className="flex flex-col gap-1.5 py-1.5" data-testid="responsibility-row" data-id={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {item.label}
            {item.firmEntryId ? <span className="font-normal text-muted-foreground"> (from {data.responsibilities.find((r) => r.id === item.firmEntryId)?.label ?? 'a company'})</span> : null}
          </span>
          <span className="text-xs text-muted-foreground">{item.wholeDiscipline ? 'All of it' : item.scopeWords}</span>
          {item.acceptedAt && item.acceptedSignoffSeq !== null ? (
            <span className="text-xs text-muted-foreground" data-testid="responsibility-recorded">
              {recordedWords(item.acceptedAt, item.acceptedSignoffSeq)}
            </span>
          ) : null}
          {item.acceptedAt && item.acceptedSignoffSeq !== null ? <><SignoffSignatureLine projectId={projectId} subjectId={item.id} seq={item.acceptedSignoffSeq} refreshKey={signedTick} /><SignoffCheckedAgainst projectId={projectId} subjectId={item.id} seq={item.acceptedSignoffSeq} model={model} refreshKey={signedTick} /></> : null}
        </div>
        {status}
        {item.isMine && !item.acceptedAt && item.partyKind === 'person' ? (
          <>
            <Button size="sm" onClick={onAccept} disabled={busy} data-testid="responsibility-accept">
              Accept
            </Button>
            <AssuranceButton size="sm" offer={signing} busy={busy} onSecure={onAcceptSecured} action="Accept" testId="responsibility-accept-signed" />
          </>
        ) : null}
        {item.pendingRequest && data.canDecideRequests && !declining ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void onDecide(true)} data-testid="responsibility-grant">
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeclining(true)} data-testid="responsibility-decline">
              Decline…
            </Button>
          </>
        ) : null}
        {canName && !item.pendingRequest ? (
          <ConfirmAction title={`Remove ${item.label}?`} description="They stop approving this part. What they already approved stays in the sign-off log." confirmLabel="Remove" destructive onConfirm={onRemove}>
            <Button size="icon" variant="ghost" aria-label={`Remove ${item.label}`} disabled={busy} data-testid="responsibility-remove">
              <Trash2 aria-hidden />
            </Button>
          </ConfirmAction>
        ) : null}
      </div>
      {item.pendingRequest && data.canDecideRequests ? (
        <p className="text-xs" data-testid="responsibility-request-words">
          {item.label} asked to be responsible for {disciplineLabel(item.discipline)}
          {item.wholeDiscipline ? '' : ` (${item.scopeWords})`}. Approve or decline.
        </p>
      ) : null}
      {declining ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (note.trim() !== '') void onDecide(false, note.trim()).then(() => setDeclining(false))
          }}
        >
          <Textarea aria-label={`Why you decline ${item.label}'s request`} placeholder="Why, so they know" value={note} maxLength={2000} autoFocus onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" variant="destructive" disabled={busy || note.trim() === ''} title={note.trim() === '' ? 'Say why you decline, so they know.' : undefined}>
              Decline
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDeclining(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {item.partyKind === 'firm' && canName ? (
        <div className="flex flex-wrap items-center gap-2 pl-4">
          {firmPeople.length === 0 ? (
            <span className="text-xs text-muted-foreground">No one at this company can see the project yet, so this entry approves nothing.</span>
          ) : (
            <>
              <PickOne id={`firm-person-${item.id}`} label={`A person from ${item.label}`} placeholder={`Name a person from ${item.label}`} value={picking} onChange={setPicking} options={firmPeople.map((p) => ({ value: p.id, label: p.label }))} />
              <Button size="sm" variant="outline" disabled={picking === '' || busy} title={picking === '' ? 'Pick a person first.' : undefined} onClick={() => onNameFromFirm(picking)} data-testid="responsibility-name-from-firm">
                Name them
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function ResponsibilitiesDialog({ open, onOpenChange, projectId, model }: ResponsibilitiesDialogProps) {
  const host = useEditorHost().data
  const { load, reload } = useResponsibilities(projectId, open)
  const [mode, setMode] = useState<FormMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | null>(null)
  const signing = useAssuranceOffer(open)
  const [signedTick, setSignedTick] = useState(0)
  const choices = useMemo<ScopeChoices>(() => (open ? scopeChoices(model) : { disciplines: [], levels: [], systems: [], groups: [], sheets: [] }), [open, model])

  const act = async (fn: () => Promise<string | null>, what: string) => {
    setBusy(true)
    setNotice(null)
    try {
      const done = await fn()
      if (done) setNotice({ tone: 'ok', text: done })
      reload()
    } catch (err) {
      console.error(`[Responsibilities] ${what} failed`, err)
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : `Couldn’t ${what}. Try again.` })
    } finally {
      setBusy(false)
    }
  }

  const grouped = useMemo(() => {
    if (load.state !== 'ready') return []
    const by = new Map<string, ResponsibilityItem[]>()
    for (const r of load.data.responsibilities) by.set(r.discipline, [...(by.get(r.discipline) ?? []), r])
    const named = new Map(choices.disciplines.map((c) => [c.value, c.label]))
    return [...by.entries()].map(([d, items]) => ({ discipline: d, label: named.get(d) ?? disciplineLabel(d), items }))
  }, [load, choices])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="responsibilities-dialog">
        <DialogHeader>
          <DialogTitle>Responsibilities</DialogTitle>
          <DialogDescription>Who is responsible for each discipline, and which part of it. A merge into Main needs each covering person’s approval.</DialogDescription>
        </DialogHeader>
        {load.state === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading who is responsible</span>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : load.state === 'error' ? (
          <Alert variant="destructive" data-testid="responsibilities-error">
            <AlertTitle>Who is responsible didn’t load</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{load.message}</span>
              <Button size="sm" variant="outline" onClick={reload}>
                <RefreshCw data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            <p className="text-sm text-muted-foreground" data-testid="responsibilities-lead">
              {load.data.leads.length > 0
                ? `Project lead: ${load.data.leads.map((l) => l.label).join(', ')}. They approve parts no one is named for.`
                : 'No project lead is named, so parts no one is named for wait until someone takes responsibility for them.'}
            </p>
            {notice ? (
              <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'} data-testid="responsibilities-notice">
                <AlertDescription>{notice.text}</AlertDescription>
              </Alert>
            ) : null}
            {grouped.length === 0 ? (
              <Empty data-testid="responsibilities-empty">
                <EmptyHeader>
                  <EmptyTitle>No one is named yet</EmptyTitle>
                  <EmptyDescription>{load.data.powers.canName ? 'Name who is responsible for each discipline. Each person accepts before they approve merges.' : 'The project lead names who is responsible for each discipline, or you can take responsibility for one.'}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              grouped.map((g) => (
                <section key={g.discipline} aria-label={g.label}>
                  <h3 className="text-sm font-semibold">{g.label}</h3>
                  <ul className="divide-y">
                    {g.items.map((item) => (
                      <Row
                        key={item.id}
                        item={item}
                        data={load.data}
                        busy={busy}
                        projectId={projectId}
                        signing={signing}
                        signedTick={signedTick}
                        model={model}
                        onAccept={() =>
                          void act(async () => {
                            const out = await acceptResponsibilityFrom(host.responsibilities, projectId, item.id, writeCheckingContext(checkingContextFor(model, { elementIds: responsibilityElementIds(model, item) })))
                            return out.signoffSeq !== null ? `Accepted. ${recordedWords(out.acceptedAt, out.signoffSeq)}.` : 'Accepted.'
                          }, 'accept it')
                        }
                        onAcceptSecured={(assurance) =>
                          void act(async () => {
                            const out = await acceptResponsibilityFrom(host.responsibilities, projectId, item.id, writeCheckingContext(checkingContextFor(model, { elementIds: responsibilityElementIds(model, item) })))
                            const secured = await secureLatestEntryFrom(host.signing, projectId, item.id, assurance)
                            setSignedTick((n) => n + 1)
                            return `Accepted. ${secureOutcomeWords(secured)}${secured.level === 'recorded' && out.signoffSeq !== null ? ` ${recordedWords(out.acceptedAt, out.signoffSeq)}.` : ''}`
                          }, 'accept it')
                        }
                        onRemove={() =>
                          act(async () => {
                            await removeResponsibleFrom(host.responsibilities, projectId, item.id)
                            return `${item.label} is no longer responsible here.`
                          }, 'remove them')
                        }
                        onDecide={(grant, note) =>
                          act(async () => {
                            await decideRequestFrom(host.responsibilities, projectId, item.id, { grant, ...(note ? { note } : {}) })
                            return grant ? `${item.label} is now responsible.` : `Declined. ${item.label} sees why.`
                          }, 'decide the request')
                        }
                        onNameFromFirm={(personId) =>
                          void act(async () => {
                            await nameResponsibleFrom(host.responsibilities, projectId, { kind: 'firm_person', firmEntryId: item.id, personId })
                            return 'Named. They accept for themselves before they approve.'
                          }, 'name them')
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
            {mode ? (
              <NameForm
                key={mode}
                mode={mode}
                projectId={projectId}
                data={load.data}
                choices={choices}
                onCancel={() => setMode(null)}
                onDone={(text) => {
                  setMode(null)
                  if (text) setNotice({ tone: 'ok', text })
                  reload()
                }}
              />
            ) : null}
          </div>
        )}
        <DialogFooter>
          {load.state === 'ready' && mode === null ? (
            <>
              <Button variant="outline" onClick={() => setMode('take')} data-testid="responsibility-take">
                <Hand data-icon="inline-start" />
                Take responsibility…
              </Button>
              <Button
                variant="outline"
                onClick={() => setMode('person')}
                disabled={!load.data.powers.canName}
                title={load.data.powers.canName ? undefined : 'Only the project lead names who is responsible.'}
                data-testid="responsibility-name"
              >
                <UserPlus data-icon="inline-start" />
                Name someone
              </Button>
              {load.data.powers.canName ? (
                <Button variant="ghost" onClick={() => setMode('firm')} data-testid="responsibility-name-firm">
                  Name a company
                </Button>
              ) : null}
            </>
          ) : null}
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
