'use client'

import { useEffect, useRef, useState } from 'react'
import type { EditorModelMembersPort } from '@permitzip/bim-editor-host'
import { Alert, AlertDescription, Button, Field, Input, Label, NativeSelect } from '@permitzip/bim-ui'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { readMembers, roleName, roles, saveMember, type Member, type Role, type Roster } from './members'

type ListState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; roster: Roster }
type Draft = { step: 'edit' | 'review'; member: Member; next: Role }
  | { step: 'conflict'; member: Member; next: Role; previous: Role }
interface Props { port: EditorModelMembersPort; modelId: string; actorId: string; onClose: () => void }
const messageOf = (err: unknown, fallback: string) => err instanceof Error && !(err instanceof TypeError) ? err.message : fallback

export function ManageMembersDialog({ port, modelId, actorId, onClose }: Props) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    readMembers(port, modelId, undefined, controller.signal).then(roster => {
      if (!controller.signal.aborted) setList({ kind: 'ready', roster })
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setList({ kind: 'error', message: messageOf(err, 'Members could not be loaded. Try again.') })
    })
    return () => controller.abort()
  }, [port, modelId, reload])
  useEffect(() => { heading.current?.focus() }, [draft?.step])

  function showRoster(message = '') {
    setDraft(null)
    setNotice(message)
    setError('')
    setQuery('')
    setList({ kind: 'loading' })
    setReload(n => n + 1)
  }
  const ownerId = list.kind === 'ready' ? list.roster.ownerId : null
  const isOwner = ownerId === actorId
  function canChange(member: Member) {
    return ownerId !== null && member.personId !== ownerId && member.personId !== actorId && (isOwner || member.role !== 'manager')
  }
  function edit(member: Member) {
    setNotice('')
    setError('')
    if (!canChange(member)) { setError('You cannot change this person’s membership.'); return }
    setDraft({ step: 'edit', member, next: member.role ?? 'viewer' })
  }
  async function lookup() {
    if (pending.current || !query.trim()) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const id = query.trim().toLowerCase()
      const result = await readMembers(port, modelId, id)
      const member = result.members[0]
      if (result.members.length !== 1 || member?.personId !== id) throw new Error('The server could not identify that person.')
      edit(member)
    } catch (err) {
      setError(messageOf(err, 'The person could not be loaded. Try again.'))
    } finally { pending.current = false; setBusy(false) }
  }
  async function confirm() {
    if (draft?.step !== 'review' || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const { member, next } = draft
      const answer = await saveMember(port, modelId, member, next)
      if (answer.conflict) {
        setDraft({ step: 'conflict', member: { ...member, role: answer.role }, next, previous: member.role })
      } else {
        const saved = next === null ? `${member.displayName}’s model access was removed.` : `${member.displayName}’s ${roleName(next)} role was saved.`
        showRoster(saved + ' Open editors update when the server rechecks access.')
      }
    } catch (err) {
      showRoster()
      setError(messageOf(err, 'The change is unconfirmed. Review the current role before trying again.'))
    } finally { pending.current = false; setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Manage members</DialogTitle>
        <DialogDescription>Model access for {modelId}</DialogDescription>
      </DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!draft ? <>
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <Field>
          <Label htmlFor="member-self">Your person ID</Label>
          <Input id="member-self" readOnly value={actorId} onFocus={e => e.currentTarget.select()} />
        </Field>
        {list.kind === 'loading' && <p role="status">Loading members…</p>}
        {list.kind === 'error' && <>
          <Alert><AlertDescription>{list.message}</AlertDescription></Alert>
          <Button variant="outline" onClick={() => showRoster()}>Refresh members</Button>
        </>}
        {list.kind === 'ready' && <>
          <ul aria-label="Model members" className="divide-y divide-(--mutiny-border)">
            {list.roster.members.map(member => <li key={member.personId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><div className="break-words text-sm font-medium">{member.displayName}</div>
                <div className="text-sm text-(--mutiny-muted)">{member.personId === ownerId ? 'Owner' : roleName(member.role)}</div>
              </div>
              {canChange(member) && <Button variant="outline" size="sm" disabled={busy} aria-label={`Change role for ${member.displayName}`} onClick={() => edit(member)}>Change role</Button>}
            </li>)}
          </ul>
          <form onSubmit={e => { e.preventDefault(); void lookup() }} className="flex flex-wrap items-end gap-2">
            <Field className="min-w-48 flex-1"><Label htmlFor="member-person">Person ID</Label>
              <Input id="member-person" value={query} disabled={busy} onChange={e => setQuery(e.target.value)} autoComplete="off" /></Field>
            <Button type="submit" variant="outline" disabled={busy || !query.trim()}>Look up person</Button>
          </form>
        </>}
      </> : <>
        <div><h3 ref={heading} tabIndex={-1} className="text-base font-semibold">
          {draft.step === 'conflict' ? `${draft.member.displayName}’s role changed before you confirmed.` : draft.member.displayName}
        </h3><p className="break-all text-xs text-(--mutiny-muted)">{draft.member.personId}</p></div>
        {draft.step === 'conflict' && <Alert><AlertDescription>Your requested change was not applied.</AlertDescription></Alert>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-sm">
          {draft.step === 'conflict' && <><dt>Role at review</dt><dd>{roleName(draft.previous)}</dd></>}
          <dt>Current role</dt><dd>{roleName(draft.member.role)}</dd>
          {draft.step !== 'edit' && <><dt>Requested role</dt><dd>{roleName(draft.next)}</dd></>}
        </dl>
        {draft.step === 'edit' && <Field><Label htmlFor="member-role">New role</Label>
          <NativeSelect id="member-role" value={draft.next ?? 'none'} onChange={e => {
            const role = roles.find(value => value === e.target.value) ?? null
            setDraft({ ...draft, next: role })
          }}>
            {roles.filter(role => isOwner || role !== 'manager').map(role => <option key={role} value={role}>{roleName(role)}</option>)}
            <option value="none">No access</option>
          </NativeSelect>
        </Field>}
        <DialogFooter>
          {draft.step === 'edit' && <>
            <Button variant="outline" onClick={() => showRoster()}>Cancel</Button>
            <Button disabled={draft.next === draft.member.role} onClick={() => setDraft({ ...draft, step: 'review' })}>Review change</Button>
          </>}
          {draft.step === 'review' && <>
            <Button variant="outline" disabled={busy} onClick={() => setDraft({ ...draft, step: 'edit' })}>Back</Button>
            <Button disabled={busy} onClick={() => void confirm()}>{busy ? 'Saving…' : 'Confirm change'}</Button>
          </>}
          {draft.step === 'conflict' && <>
            <Button variant="outline" onClick={() => showRoster()}>Keep current role</Button>
            {canChange(draft.member) && draft.member.role !== draft.next && <Button onClick={() => setDraft({ step: 'review', member: draft.member, next: draft.next })}>Review again</Button>}
          </>}
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog>
}
