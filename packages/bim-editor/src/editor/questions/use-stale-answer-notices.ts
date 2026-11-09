'use client'

import { useEffect, useMemo, useRef } from 'react'
import { isQuestionAnswerRecord, questionAt, readReliance, staleRecords, type AuthorRef, type ModelState } from '@permitzip/bim-kernel'
import { noticeRecipients, staleAnswerDedupeKey } from '../../contracts/bim/questions/notices'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { postQuestionNoticeFrom } from '../../contracts/bim/questions/notify-client'
import { DEFAULT_HOST_IDENTITY, hostProviderIds } from '../../contracts/bim/identity/host-provider'

/**
 * Temporal validity on the bell: when an answer stops holding while this
 * page is open (someone, often this person, changed what it relied on), tell
 * the asker and the owner once: "The answer to Q-3 may no longer hold — Room
 * 104 changed in Rev 52. Nothing was reopened." Answers already stale when
 * the page opened were told by whoever saw them change; the database key
 * keeps each (person, answer, reliance) to one notice whichever page notices.
 */
export function useStaleAnswerNotices(input: { readonly model: ModelState | null; readonly me: AuthorRef | null; readonly projectId: string; readonly modelId: string | null }): void {
  const host = useEditorHost()
  const questions = host.data.questions
  const provider = host.identity.provider
  const providerIds = useMemo(() => hostProviderIds(provider ?? DEFAULT_HOST_IDENTITY), [provider])
  const seen = useRef<Set<string> | null>(null)
  const { model, me, projectId, modelId } = input
  useEffect(() => {
    if (!model || !me || !modelId) return
    const stale = staleRecords(model.elements)
    if (seen.current === null) {
      seen.current = new Set(stale.keys())
      return
    }
    for (const [answerId, validity] of stale) {
      if (seen.current.has(answerId)) continue
      seen.current.add(answerId)
      const el: { readonly kind: string } | undefined = model.elements[answerId]
      if (!isQuestionAnswerRecord(el)) continue
      const question = questionAt(model.elements, el.answer.questionId)
      const reliance = readReliance(el.answer.reliance)
      if (!question || !reliance) continue
      if (noticeRecipients(question, 'may_no_longer_hold', me.subject, undefined, providerIds).length === 0) continue
      postQuestionNoticeFrom(questions, { projectId, modelId, question, event: 'may_no_longer_hold', excerpt: validity.words, actorUserId: me.subject, dedupeKey: staleAnswerDedupeKey(modelId, answerId, reliance.digest), hostProviderIds: providerIds }).catch((err: unknown) => {
        console.error('[useStaleAnswerNotices] telling the asker that an answer may no longer hold failed', { answerId, err })
      })
    }
    for (const id of [...seen.current]) if (!stale.has(id)) seen.current.delete(id)
  }, [questions, model, me, projectId, modelId, providerIds])
}
