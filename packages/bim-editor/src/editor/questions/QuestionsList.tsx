'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CircleHelp, Mail, MessageSquarePlus, RefreshCw, Trash2 } from 'lucide-react'
import { ownerOf, questionAt, type AuthorRef, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Skeleton } from '../../ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { QuestionCommand } from '../../contracts/bim/questions/kernel'
import type { ForwardCandidate, QuestionNoticeEvent } from '../../contracts/bim/questions/contract'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { postQuestionNoticeFrom } from '../../contracts/bim/questions/notify-client'
import { DEFAULT_HOST_IDENTITY, hostProviderIds } from '../../contracts/bim/identity/host-provider'
import { hostUserOf } from '../../contracts/bim/questions/notices'
import { postThreadReaderFrom } from '../../contracts/bim/questions/readers'
import { sharedThreadOf } from '../../contracts/bim/questions/shared-thread'
import type { ForwardTarget } from './ForwardQuestionDialog'
import { AnswerQuestionDialog } from './AnswerQuestionDialog'
import { AskQuestionDialog } from './AskQuestionDialog'
import { QuestionEmailDialog } from './QuestionEmailDialog'
import { questionRows, type QuestionFilter, type QuestionRow } from './question-rows'
import { QuestionThread } from './QuestionThread'
import type { AnswerChoice } from './thread-rows'

export interface QuestionsListProps {
  /** Null while the model is loading. */
  readonly model: ModelState | null
  readonly error?: string | null
  readonly onRetry?: () => void
  readonly projectName: string
  readonly canEdit: boolean
  /** Why editing is off, in words ("Asking questions needs edit access to this project's model"). */
  readonly blockedReason: string
  /** The session's one edit path: the model's refusal in words, or null (it shows its own Undo toast). */
  readonly submit: (command: QuestionCommand, undoLabel: string) => string | null
  /** What is selected on the plan now: "Ask about selection" pins to it. */
  readonly selection: readonly ElementId[]
  /** "SD-1, SD-2": the selection as the person sees it. */
  readonly selectionLabel: string
  /** A plan pin was clicked: open and scroll to this question. A new object per click, so clicking the same pin again opens it again. */
  readonly focusRequest?: { readonly questionId: ElementId } | null
  /** Select these elements on the plan. */
  readonly onSelect: (ids: readonly string[]) => void
  /** The signed-in person: Ask again says who may press it, and the bell tells the asker. */
  readonly me?: AuthorRef | null
  /** Where the bell's notices go (the project and the model this panel edits). Absent: nobody is told. */
  readonly notices?: { readonly projectId: string; readonly modelId: string } | null
  /** "Revise the design": open a branch (named by the person) and link it to the answer. */
  readonly revise?: { readonly create: (name: string) => Promise<string>; readonly open: (branchId: string) => void } | null
}

const STATUS_VARIANT: Readonly<Record<QuestionRow['status'], 'destructive' | 'secondary' | 'outline' | 'default'>> = { open: 'default', assumed: 'secondary', answered: 'outline', withdrawn: 'outline', declined: 'outline', not_in_scope: 'outline' }

/**
 * Coordination › Questions (ROADMAP F7): questions and assumptions pinned to
 * the model. Open ones first, the ones holding an issue at the top. Ask about
 * the selection, answer, withdraw, and draft the email of what is still open.
 * Four controls always visible; a row's own actions show when it is opened.
 */
export function QuestionsList({ model, error, onRetry, projectName, canEdit, blockedReason, submit, selection, selectionLabel, focusRequest, onSelect, me, notices, revise }: QuestionsListProps) {
  const host = useEditorHost()
  const questions = host.data.questions
  const hostIdentity = host.identity.provider ?? DEFAULT_HOST_IDENTITY
  const [filter, setFilter] = useState<QuestionFilter>('open')
  const [openRow, setOpenRow] = useState<ElementId | null>(null)
  const [asking, setAsking] = useState(false)
  /** Asking a kept-closed question anew: its elements and the words it links back with. */
  const [askingAnew, setAskingAnew] = useState<{ readonly id: ElementId; readonly words: string; readonly elementIds: readonly ElementId[] } | null>(null)
  const [answering, setAnswering] = useState<QuestionRow | null>(null)
  const [deleting, setDeleting] = useState<QuestionRow | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const rows = useMemo(() => (model ? questionRows(model, filter) : []), [model, filter])
  const openCount = useMemo(() => (model ? questionRows(model, 'open').filter((r) => r.status === 'open').length : 0), [model])

  // A new pin click: open its row (showing all when it isn't open), adjusted during render rather than in an effect.
  const [seenFocus, setSeenFocus] = useState<QuestionsListProps['focusRequest']>(null)
  if (focusRequest && focusRequest !== seenFocus && model) {
    setSeenFocus(focusRequest)
    setOpenRow(focusRequest.questionId)
    if (!questionRows(model, 'open').some((r) => r.id === focusRequest.questionId)) setFilter('all')
  }

  useEffect(() => {
    if (!openRow) return
    const el = listRef.current?.querySelector(`[data-question="${CSS.escape(openRow)}"]`)
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ block: 'nearest' })
  }, [openRow, rows])

  const send = (command: QuestionCommand, label: string): boolean => {
    const refused = submit(command, label)
    setNotice(refused)
    return refused === null
  }

  /** After an act is saved: tell the asker and the person asked. A notice that fails never undoes the act. */
  const tell = (questionId: ElementId, event: QuestionNoticeEvent, excerpt: string) => {
    const question = model ? questionAt(model.elements, questionId) : undefined
    if (!notices || !me || !question) return
    const previousOwner = event === 'took_over' ? ownerOf(question) : undefined
    postQuestionNoticeFrom(questions, { projectId: notices.projectId, modelId: notices.modelId, question, event, excerpt, actorUserId: me.subject, hostProviderIds: hostProviderIds(hostIdentity), ...(previousOwner ? { previousOwner } : {}) }).catch((err: unknown) => {
      console.error('[QuestionsList] telling the asker failed (the act is saved)', err)
      setNotice(`Saved, but the asker wasn't told: ${err instanceof Error ? err.message : 'try again later'}.`)
    })
  }

  const [readersVersion, setReadersVersion] = useState(0)

  /**
   * After a forward is saved (round 10): the new person hears "forwarded to
   * you", the owner and everyone it was asked of before hear "forwarded", and
   * whoever it moved away from keeps this one conversation if they aren't on
   * the project; an outside company's person (by email) gets it read-only.
   * A notice or share that fails never undoes the forward: it is said.
   */
  const forwarded = (questionId: ElementId, target: ForwardTarget, people: readonly ForwardCandidate[] | null) => {
    const question = model ? questionAt(model.elements, questionId) : undefined
    if (!notices || !me || !question || !model) return
    const newUser = target.kind === 'person' ? target.person.userId : null
    const label = target.kind === 'person' ? target.person.name : target.company
    const { askOfAuthor: priorAskOf, ...rest } = question
    const after = {
      ...rest,
      askOf: label,
      ...(target.kind === 'person' ? { askOfAuthor: { provider: hostIdentity.id, subject: target.person.userId, kind: 'person' as const, displayName: target.person.name } } : {}),
      formerAddressees: [...(question.formerAddressees ?? []), { label: question.askOf, ...(priorAskOf ? { author: priorAskOf } : {}) }],
    }
    const failed = (what: string) => (err: unknown) => {
      console.error(`[QuestionsList] ${what} failed (the forward is saved)`, err)
      setNotice(`Forwarded, but ${what}: ${err instanceof Error ? err.message : 'try again later'}.`)
    }
    if (newUser) postQuestionNoticeFrom(questions, { projectId: notices.projectId, modelId: notices.modelId, question: after, event: 'forwarded_to_you', excerpt: '', actorUserId: me.subject, hostProviderIds: hostProviderIds(hostIdentity) }).catch(failed(`${label} wasn't told`))
    postQuestionNoticeFrom(questions, { projectId: notices.projectId, modelId: notices.modelId, question: after, event: 'forwarded', excerpt: `Now asked of ${label}`, actorUserId: me.subject, hostProviderIds: hostProviderIds(hostIdentity) }).catch(failed('the others weren’t told'))
    const thread = sharedThreadOf(model, questionId)
    if (!thread) return
    const shares: Promise<unknown>[] = []
    const formerUser = hostUserOf(question.askOfAuthor, hostProviderIds(hostIdentity))
    const formerOnProject = people ? people.some((p) => p.userId === formerUser) : false
    if (formerUser && formerUser !== me.subject && formerUser !== newUser && !formerOnProject)
      shares.push(postThreadReaderFrom(questions, notices.projectId, { modelId: notices.modelId, questionId, reason: 'former_addressee', thread, readerUserId: formerUser }).catch(failed(`${question.askOf} couldn't keep reading it`)))
    if (target.kind === 'outside' && target.email)
      shares.push(
        postThreadReaderFrom(questions, notices.projectId, { modelId: notices.modelId, questionId, reason: 'forwarded_outside', thread, readerEmail: target.email })
          .then((r) => setNotice(`Forwarded to ${target.company}. ${r.name} can read this conversation, read-only, once signed in as a guest.`))
          .catch(failed(`it couldn't be shared with ${target.email}`)),
      )
    if (shares.length > 0) void Promise.all(shares).then(() => setReadersVersion((v) => v + 1))
  }

  const answered = (row: QuestionRow, choice: AnswerChoice | 'assumed' | 'kept_closed', text: string) => {
    if (choice === 'assumed') return
    tell(row.id, choice === 'kept_closed' ? 'kept_closed' : choice === 'decline' ? 'declined' : choice === 'not_in_scope' ? 'not_in_scope' : 'answered', text)
  }

  const editReason = canEdit ? null : blockedReason
  const askReason = editReason ?? (selection.length === 0 ? 'Select what the question is about on the plan first.' : null)

  if (error)
    return (
      <section className="flex flex-col gap-2" aria-label="Questions" data-testid="questions-list">
        <Alert variant="destructive" data-testid="questions-error">
          <AlertTitle>The questions didn’t load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw data-icon="inline-start" />
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </section>
    )
  if (!model)
    return (
      <section className="flex flex-col gap-2" aria-label="Questions" aria-busy="true" data-testid="questions-list">
        <span className="sr-only">Loading the questions</span>
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </section>
    )

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Questions" data-testid="questions-list">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <CircleHelp className="size-4" /> Questions
        <Badge variant={openCount > 0 ? 'default' : 'outline'} data-testid="questions-open-count">
          {openCount} open
        </Badge>
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setAsking(true)} disabled={askReason !== null} title={askReason ?? `Ask about ${selectionLabel}`} data-testid="questions-ask">
          <MessageSquarePlus data-icon="inline-start" />
          Ask about selection
        </Button>
        <ToggleGroup type="single" size="sm" variant="outline" value={filter} onValueChange={(v) => (v === 'open' || v === 'all') && setFilter(v)} aria-label="Show">
          <ToggleGroupItem value="open" data-testid="questions-filter-open">
            Open
          </ToggleGroupItem>
          <ToggleGroupItem value="all" data-testid="questions-filter-all">
            All
          </ToggleGroupItem>
        </ToggleGroup>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEmailing(true)} data-testid="questions-email">
          <Mail data-icon="inline-start" />
          Draft email
        </Button>
      </div>
      {editReason ? <p className="text-xs text-muted-foreground">{editReason}</p> : null}
      {notice ? (
        <Alert variant="destructive" data-testid="questions-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <Empty className="border" data-testid="questions-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleHelp />
            </EmptyMedia>
            <EmptyTitle>{filter === 'open' ? 'No open questions' : 'No questions yet'}</EmptyTitle>
            <EmptyDescription>Select something on the plan, then Ask about selection. Questions marked to hold the issue stop the sheets that show them from going out until answered.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div ref={listRef}>
          <ItemGroup className="gap-2">
            {rows.map((r) => {
              const expanded = openRow === r.id
              return (
                <Item key={r.id} variant="outline" size="sm" data-testid="questions-row" data-question={r.id} data-status={r.status}>
                  <ItemContent>
                    <ItemTitle className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{r.number}</span>
                      <Badge variant={STATUS_VARIANT[r.status]}>{r.type === 'question' ? r.statusLabel : `${r.typeLabel}: ${r.statusLabel.toLowerCase()}`}</Badge>
                      {r.blocksIssue && r.status === 'open' ? <Badge variant="destructive">Holds the issue</Badge> : null}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-foreground">{r.text}</ItemDescription>
                    <ItemDescription>
                      For {r.askOfLabel}
                      {r.about ? ` · ${r.about}` : ''}
                      {r.closeBy ? ` · needed by ${r.closeBy}` : ''}
                    </ItemDescription>
                    {r.answer ? <ItemDescription>{r.status === 'assumed' ? 'Going ahead on: ' : 'Answer: '}{r.answer}</ItemDescription> : null}
                    {r.modelAnswer ? <ItemDescription data-testid="questions-model-answer">The model already says: {r.modelAnswer}. It is left out of the email.</ItemDescription> : null}
                    {r.anchorGone ? <ItemDescription className="text-danger-600">What it was pinned to was deleted.</ItemDescription> : null}
                    {r.staleWords ? <ItemDescription className="text-warning-700" data-testid="questions-stale">{r.staleWords}. Nothing was reopened.</ItemDescription> : null}
                  </ItemContent>
                  <ItemActions>
                    <Button variant="ghost" size="icon-sm" aria-label={expanded ? `Hide actions for ${r.number}` : `Actions for ${r.number}`} aria-expanded={expanded} onClick={() => setOpenRow(expanded ? null : r.id)} data-testid="questions-row-toggle">
                      {expanded ? <ChevronUp /> : <ChevronDown />}
                    </Button>
                  </ItemActions>
                  {expanded ? (
                    <div className="flex w-full flex-wrap gap-2" data-testid="questions-row-actions">
                      <Button size="sm" variant="outline" onClick={() => onSelect(r.elementIds)} disabled={r.elementIds.length === 0 || r.anchorGone} title={r.elementIds.length === 0 ? 'It is pinned to a spot, not to elements.' : r.anchorGone ? 'What it was pinned to was deleted.' : 'Select what it is about on the plan'}>
                        Show on plan
                      </Button>
                      <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete ${r.number}`} onClick={() => setDeleting(r)} disabled={editReason !== null} title={editReason ?? undefined} data-testid="questions-delete">
                        <Trash2 />
                      </Button>
                      <QuestionThread
                        model={model}
                        row={r}
                        editReason={editReason}
                        me={me}
                        send={send}
                        onAnswer={() => setAnswering(r)}
                        onActed={(event, text) => tell(r.id, event, text)}
                        onForwarded={(target, people) => forwarded(r.id, target, people)}
                        readersVersion={readersVersion}
                        onAskAnew={(before) => setAskingAnew({ id: r.id, words: before.words, elementIds: r.elementIds })}
                        links={notices ?? null}
                      />
                    </div>
                  ) : null}
                </Item>
              )
            })}
          </ItemGroup>
        </div>
      )}

      <AskQuestionDialog open={asking} elementIds={selection} aboutLabel={selectionLabel} submit={submit} onClose={() => setAsking(false)} />
      <AskQuestionDialog open={askingAnew !== null} elementIds={askingAnew?.elementIds ?? []} aboutLabel={askingAnew?.words ?? ''} submit={submit} onClose={() => setAskingAnew(null)} askedBefore={askingAnew ? { id: askingAnew.id, words: askingAnew.words } : null} />
      <AnswerQuestionDialog row={answering} submit={submit} onClose={() => setAnswering(null)} onSaved={(choice, text) => answering && answered(answering, choice, text)} revise={revise} />
      <QuestionEmailDialog open={emailing} model={model} projectName={projectName} onClose={() => setEmailing(false)} />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent data-testid="questions-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.number}?</AlertDialogTitle>
            <AlertDialogDescription>It comes off the plan and out of the history. Withdraw keeps the history instead. Undo puts it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) send({ type: 'delete_questions', questionIds: [deleting.id] }, 'Delete question')
                setDeleting(null)
              }}
              data-testid="questions-delete-confirm-action"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
