'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, UserMinus } from 'lucide-react'
import { REVIEW_OUTCOMES, REVIEW_OUTCOME_LABELS, lineageRoleWords, type Lineage } from '@permitzip/bim-kernel/lineages'
import type { LineageRequest } from '@permitzip/bim-sync'
import type { LineageServerMessage } from '@permitzip/bim-sync/lineages'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { Alert, AlertDescription } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { ConfirmAction } from '../../ui/confirm-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { Textarea } from '../../ui/textarea'
import { CAPABILITY_WORDS, readCopyPeople, type CopyPeople } from './copy-people'

/**
 * Manage › Copies: contractor and shop-drawing copies of this model. Pick a
 * copy, then
 *   People: who is named on it and what they may do (Read, Propose, Review, Edit);
 *   Review: record an outcome on everything the copy changed (it lands nothing);
 *   Accept back: land chosen records of the copy on the copy it came from.
 * Reviews and accept backs are signed on the project's sign-off chain as you.
 * The model server decides who may do each and says why when you can't; the
 * calls come in as `ask`, so this screen holds no socket.
 */

export interface CopiesDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly projectId: string
  /** One copy question to the model server (the session's sync client). */
  readonly ask: (msg: LineageRequest) => Promise<LineageServerMessage>
}

type Notice = { readonly tone: 'ok' | 'error'; readonly text: string } | null

/** The answer of the expected kind, else the model server's words as an error. */
async function answerOf<T extends LineageServerMessage['type']>(ask: CopiesDialogProps['ask'], msg: LineageRequest, type: T): Promise<Extract<LineageServerMessage, { type: T }>> {
  const answer = await ask(msg)
  if (answer.type === type) return answer as Extract<LineageServerMessage, { type: T }>
  throw new Error(answer.type === 'request_refused' ? answer.reason : "The model server's answer didn't match the question. Try again.")
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function CopiesDialog({ open, onOpenChange, projectId, ask }: CopiesDialogProps) {
  const [copies, setCopies] = useState<{ readonly state: 'loading' } | { readonly state: 'error'; readonly text: string } | { readonly state: 'ready'; readonly list: readonly Lineage[]; readonly all: readonly Lineage[] }>({ state: 'loading' })
  const [chosen, setChosen] = useState<string | null>(null)
  const [listAttempt, setListAttempt] = useState(0)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    answerOf(ask, { type: 'lineage_list' }, 'lineages')
      .then((a) => {
        if (!live) return
        const list = a.lineages.filter((l) => l.parent !== null)
        setCopies({ state: 'ready', list, all: a.lineages })
        setChosen((c) => c ?? list[0]?.id ?? null)
      })
      .catch((err: unknown) => {
        console.error('[Copies] listing the copies failed', err)
        if (live) setCopies({ state: 'error', text: errorText(err, 'The copies didn’t load. Try again.') })
      })
    return () => {
      live = false
    }
  }, [open, ask, listAttempt])

  const copy = copies.state === 'ready' ? (copies.list.find((l) => l.id === chosen) ?? null) : null
  const parentName = copy?.parent && copies.state === 'ready' ? (copies.all.find((l) => l.id === copy.parent?.lineageId)?.name ?? 'the design') : 'the design'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="copies-dialog">
        <DialogHeader>
          <DialogTitle>Copies</DialogTitle>
          <DialogDescription>Contractors and shops work in their own copy of the model. Name who works in each, review what they changed, and accept chosen records back.</DialogDescription>
        </DialogHeader>
        {copies.state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading the copies…
          </p>
        )}
        {copies.state === 'error' && (
          <Alert variant="destructive" data-testid="copies-error">
            <AlertDescription>{copies.text}</AlertDescription>
          </Alert>
        )}
        {copies.state === 'ready' && (
          <div className="flex flex-col gap-2">
            {creating ? (
              <NewCopyForm
                ask={ask}
                onCancel={() => setCreating(false)}
                onMade={(id) => {
                  setCreating(false)
                  setChosen(id)
                  setListAttempt((n) => n + 1)
                }}
              />
            ) : (
              <div>
                <Button size="sm" variant="outline" onClick={() => setCreating(true)} data-testid="copies-new">
                  <Plus data-icon="inline-start" />
                  New copy
                </Button>
              </div>
            )}
          </div>
        )}
        {copies.state === 'ready' && copies.list.length === 0 && !creating && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No copies yet</EmptyTitle>
              <EmptyDescription>Start one with New copy for a contractor’s shop drawings, coordination or a submittal. You can then name who works in it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {copies.state === 'ready' && copies.list.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
            <ul className="flex flex-col gap-1" aria-label="Copies">
              {copies.list.map((l) => (
                <li key={l.id}>
                  <Button variant={l.id === chosen ? 'secondary' : 'ghost'} className="h-auto w-full justify-start py-2 text-left" onClick={() => setChosen(l.id)} data-testid="copies-item">
                    <Copy data-icon="inline-start" />
                    <span className="flex flex-col">
                      <span>{l.name}</span>
                      <span className="text-xs text-muted-foreground">{[lineageRoleWords(l.role), l.owner?.party].filter(Boolean).join(' · ')}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {copy && (
              <Tabs defaultValue="people" key={copy.id}>
                <TabsList>
                  <TabsTrigger value="people">People</TabsTrigger>
                  <TabsTrigger value="review">Review</TabsTrigger>
                  <TabsTrigger value="accept">Accept back</TabsTrigger>
                </TabsList>
                <TabsContent value="people">
                  <PeopleTab projectId={projectId} copyId={copy.id} />
                </TabsContent>
                <TabsContent value="review">
                  <ReviewTab ask={ask} copy={copy} parentName={parentName} />
                </TabsContent>
                <TabsContent value="accept">
                  <AcceptBackTab ask={ask} copy={copy} parentName={parentName} />
                </TabsContent>
              </Tabs>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function NoticeLine({ notice }: { readonly notice: Notice }) {
  if (!notice) return null
  return (
    <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'} data-testid="copies-notice">
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  )
}

function PeopleTab({ projectId, copyId }: { readonly projectId: string; readonly copyId: string }) {
  const port = useEditorHost().data.copies
  const [people, setPeople] = useState<{ readonly state: 'loading' } | { readonly state: 'error'; readonly text: string } | { readonly state: 'ready'; readonly value: CopyPeople }>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [who, setWho] = useState('')
  const [capability, setCapability] = useState<keyof typeof CAPABILITY_WORDS>('edit')
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    if (!port) return
    const ctrl = new AbortController()
    readCopyPeople(port, { projectId, copyId }, ctrl.signal)
      .then((value) => setPeople({ state: 'ready', value }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        console.error('[Copies] People didn’t load', err)
        setPeople({ state: 'error', text: errorText(err, 'People didn’t load. Try again.') })
      })
    return () => ctrl.abort()
  }, [port, projectId, copyId, attempt])

  const act = useCallback(
    async (run: () => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>, done: string) => {
      setNotice(null)
      try {
        const res = await run()
        if (!res.ok) {
          const body = await res.text()
          let words = 'That didn’t save. Try again.'
          try {
            const parsed: unknown = JSON.parse(body)
            if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') words = parsed.error
          } catch (err) {
            console.error('[Copies] People answer wasn’t JSON', err)
          }
          setNotice({ tone: 'error', text: words })
          return
        }
        setNotice({ tone: 'ok', text: done })
        setWho('')
        setAttempt((n) => n + 1)
      } catch (err) {
        console.error('[Copies] People change failed', err)
        setNotice({ tone: 'error', text: 'The app didn’t answer. Check your connection and try again.' })
      }
    },
    [],
  )

  if (!port) return <p className="text-sm text-muted-foreground">This app doesn’t keep who is named on copies, so People can’t be shown here.</p>
  if (people.state === 'loading') return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading People…</p>
  if (people.state === 'error') return <NoticeLine notice={{ tone: 'error', text: people.text }} />
  const { rows, candidates } = people.value
  const whoLabel = candidates?.find((c) => c.userId === who)?.label ?? ''
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody is named on this copy yet besides whoever started it.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="People on this copy">
          {rows.map((p) => (
            <li key={p.grantId} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2" data-testid="copies-person">
              <span>{p.label}</span>
              <span className="flex items-center gap-2">
                <Badge variant="secondary">{CAPABILITY_WORDS[p.capability]}</Badge>
                <ConfirmAction title={`Take ${p.label} off this copy?`} description="They lose what they could do on the copy. What they already changed stays." confirmLabel="Take off" destructive onConfirm={() => act(() => port.remove({ projectId, grantId: p.grantId }), `${p.label} is off this copy.`)}>
                  <Button size="icon-sm" variant="ghost" aria-label={`Take ${p.label} off this copy`}>
                    <UserMinus />
                  </Button>
                </ConfirmAction>
              </span>
            </li>
          ))}
        </ul>
      )}
      {candidates === null ? (
        <p className="text-sm text-muted-foreground">Only the project team can see everyone on the project. Ask them to name someone on this copy.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-56">
            <FieldLabel htmlFor="copies-who">Person</FieldLabel>
            <Select value={who} onValueChange={setWho}>
              <SelectTrigger id="copies-who" size="sm" data-testid="copies-who">
                <SelectValue placeholder="Someone on the project" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.userId} value={c.userId}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="w-36">
            <FieldLabel htmlFor="copies-capability">May</FieldLabel>
            <Select value={capability} onValueChange={(v) => setCapability(v as keyof typeof CAPABILITY_WORDS)}>
              <SelectTrigger id="copies-capability" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CAPABILITY_WORDS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button size="sm" disabled={!who} title={who ? undefined : 'Pick someone first'} onClick={() => act(() => port.name({ projectId, copyId, userId: who, capability }), `${whoLabel} is named on this copy (${CAPABILITY_WORDS[capability]}).`)} data-testid="copies-name">
            Name on this copy
          </Button>
        </div>
      )}
      <NoticeLine notice={notice} />
    </div>
  )
}

type Delta = Extract<LineageServerMessage, { type: 'lineage_delta_result' }>

function useCopyDelta(ask: CopiesDialogProps['ask'], copyId: string) {
  const [delta, setDelta] = useState<{ readonly state: 'loading' } | { readonly state: 'error'; readonly text: string } | { readonly state: 'ready'; readonly value: Delta }>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    answerOf(ask, { type: 'lineage_delta', lineageId: copyId }, 'lineage_delta_result')
      .then((value) => live && setDelta({ state: 'ready', value }))
      .catch((err: unknown) => {
        console.error('[Copies] the copy’s changes didn’t load', err)
        if (live) setDelta({ state: 'error', text: errorText(err, 'The copy’s changes didn’t load. Try again.') })
      })
    return () => {
      live = false
    }
  }, [ask, copyId, attempt])
  return { delta, reload: () => setAttempt((n) => n + 1) }
}

function ReviewTab({ ask, copy, parentName }: { readonly ask: CopiesDialogProps['ask']; readonly copy: Lineage; readonly parentName: string }) {
  const { delta, reload } = useCopyDelta(ask, copy.id)
  const [outcome, setOutcome] = useState<(typeof REVIEW_OUTCOMES)[number]>('approved_as_noted')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  if (delta.state === 'loading') return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading what the copy changed…</p>
  if (delta.state === 'error') return <NoticeLine notice={{ tone: 'error', text: delta.text }} />
  const changed = delta.value.changedIds.length
  async function record(d: Delta) {
    setBusy(true)
    setNotice(null)
    try {
      const done = await answerOf(ask, { type: 'lineage_review', lineageId: copy.id, outcome, ...(reason.trim() ? { reason: reason.trim() } : {}), deltaDigest: d.deltaDigest }, 'lineage_act_recorded')
      setNotice({ tone: 'ok', text: `${REVIEW_OUTCOME_LABELS[outcome]} recorded and signed${done.seq ? ` (sign-off #${done.seq})` : ''}. Nothing changed on ${parentName}.` })
    } catch (err) {
      console.error('[Copies] the review wasn’t recorded', err)
      setNotice({ tone: 'error', text: errorText(err, 'The review wasn’t recorded. Try again.') })
      reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" data-testid="copies-review-changed">
        {changed === 0 ? `${copy.name} hasn’t changed anything since it was made from ${parentName}.` : `${copy.name} changed ${changed} record${changed === 1 ? '' : 's'} since it was made from ${parentName}. Your review covers all of them.`}
      </p>
      <Field className="w-60">
        <FieldLabel htmlFor="copies-outcome">Outcome</FieldLabel>
        <Select value={outcome} onValueChange={(v) => setOutcome(v as (typeof REVIEW_OUTCOMES)[number])}>
          <SelectTrigger id="copies-outcome" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_OUTCOMES.map((o) => (
              <SelectItem key={o} value={o}>
                {REVIEW_OUTCOME_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="copies-reason">Notes (optional)</FieldLabel>
        <Textarea id="copies-reason" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div>
        <Button size="sm" disabled={busy || changed === 0} title={changed === 0 ? 'Nothing to review yet' : undefined} onClick={() => void record(delta.value)} data-testid="copies-review">
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Record review
        </Button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  )
}

function AcceptBackTab({ ask, copy, parentName }: { readonly ask: CopiesDialogProps['ask']; readonly copy: Lineage; readonly parentName: string }) {
  const { delta, reload } = useCopyDelta(ask, copy.id)
  const [picked, setPicked] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  if (delta.state === 'loading') return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading what the copy changed…</p>
  if (delta.state === 'error') return <NoticeLine notice={{ tone: 'error', text: delta.text }} />
  const ids = delta.value.changedIds
  async function accept(d: Delta) {
    setBusy(true)
    setNotice(null)
    try {
      // The digest of exactly these records at the copy's head you looked at: a copy that moved since is refused in words.
      const some = await answerOf(ask, { type: 'lineage_delta', lineageId: copy.id, recordIds: [...picked], atRevision: d.headRevision }, 'lineage_delta_result')
      const done = await answerOf(ask, { type: 'lineage_accept_back', from: copy.id, recordIds: [...some.changedIds], deltaDigest: some.deltaDigest }, 'lineage_act_recorded')
      setNotice({ tone: 'ok', text: `${picked.length} record${picked.length === 1 ? '' : 's'} accepted back onto ${parentName}${done.revision !== undefined ? ` (version ${done.revision})` : ''}, signed as you.` })
      setPicked([])
    } catch (err) {
      console.error('[Copies] the accept back didn’t land', err)
      setNotice({ tone: 'error', text: errorText(err, 'Nothing was accepted back. Try again.') })
    } finally {
      setBusy(false)
      reload()
    }
  }
  if (ids.length === 0) return <p className="text-sm text-muted-foreground">{copy.name} hasn’t changed anything since it was made, so there is nothing to accept back.</p>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">Pick the records to land on {parentName}. Anything both copies changed is refused, with the records named.</p>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Records the copy changed">
        {ids.map((id) => (
          <li key={id} className="flex items-center gap-2">
            <Checkbox id={`copies-rec-${id}`} checked={picked.includes(id)} onCheckedChange={(on) => setPicked((p) => (on === true ? [...p, id] : p.filter((x) => x !== id)))} data-testid="copies-record" />
            <label htmlFor={`copies-rec-${id}`} className="text-sm">
              {id}
            </label>
          </li>
        ))}
      </ul>
      <div>
        <ConfirmAction title={`Accept ${picked.length} record${picked.length === 1 ? '' : 's'} back onto ${parentName}?`} description={`They land on ${parentName} as one change you can undo there, and the accept back is signed as you on the project’s sign-off chain.`} confirmLabel="Accept back" onConfirm={() => accept(delta.value)}>
          <Button size="sm" disabled={busy || picked.length === 0} title={picked.length === 0 ? 'Pick at least one record' : undefined} data-testid="copies-accept">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Accept back
          </Button>
        </ConfirmAction>
      </div>
      <NoticeLine notice={notice} />
    </div>
  )
}

/** The purposes a contractor's or shop's copy has: their records can be accepted back. */
const CONTRACTOR_ROLES = ['shop', 'coordination', 'submittal'] as const

function NewCopyForm({ ask, onCancel, onMade }: { readonly ask: CopiesDialogProps['ask']; readonly onCancel: () => void; readonly onMade: (lineageId: string) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<(typeof CONTRACTOR_ROLES)[number]>('shop')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  async function make() {
    setBusy(true)
    setNotice(null)
    try {
      const saved = await answerOf(ask, { type: 'lineage_create', name: name.trim(), role, ...(company.trim() ? { owner: { party: company.trim() } } : {}) }, 'lineage_saved')
      onMade(saved.lineage.id)
    } catch (err) {
      console.error('[Copies] the copy wasn’t made', err)
      setNotice({ tone: 'error', text: errorText(err, 'The copy wasn’t made. Try again.') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="copies-new-form">
      <div className="flex flex-wrap items-end gap-2">
        <Field className="w-60">
          <FieldLabel htmlFor="copies-new-name">Copy name</FieldLabel>
          <Input id="copies-new-name" value={name} maxLength={80} placeholder="Acme shop drawings" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field className="w-44">
          <FieldLabel htmlFor="copies-new-role">For</FieldLabel>
          <Select value={role} onValueChange={(v) => setRole(v as (typeof CONTRACTOR_ROLES)[number])}>
            <SelectTrigger id="copies-new-role" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTRACTOR_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {lineageRoleWords(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-52">
          <FieldLabel htmlFor="copies-new-company">Company (optional)</FieldLabel>
          <Input id="copies-new-company" value={company} maxLength={200} placeholder="Acme Contracting" onChange={(e) => setCompany(e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !name.trim()} title={name.trim() ? undefined : 'Give the copy a name'} onClick={() => void make()} data-testid="copies-new-make">
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Make the copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  )
}
