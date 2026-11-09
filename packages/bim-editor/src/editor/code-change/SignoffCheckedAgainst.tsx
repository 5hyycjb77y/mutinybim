'use client'

import { useEffect, useMemo, useState } from 'react'
import { CurrentRuleIndex, contextStanding, currentCodesFor, readCheckingContext, type CheckingContext, type ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchSignoffEntriesFrom } from '../../contracts/bim/signing/client'
import { CheckedAgainstLine } from './CheckedAgainstLine'

type Load = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'none' } | { readonly state: 'ready'; readonly context: CheckingContext | null }

/**
 * Beside a sign-off entry's signature line (Manage › Responsibilities, a
 * merge's approvals, a change order's history): what the entry was checked
 * against, compared with the open model's code of record when the model is
 * given ("Checked against an older rule"), else as pinned.
 */
export function SignoffCheckedAgainst({ projectId, subjectId, seq, model, refreshKey = 0 }: { readonly projectId: string; readonly subjectId: string; readonly seq?: number | null; readonly model?: ModelState | null; readonly refreshKey?: number }) {
  const signing = useEditorHost().data.signing
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void attempt
    void refreshKey
    fetchSignoffEntriesFrom(signing, projectId, subjectId, controller.signal)
      .then((res) => {
        const entry = seq != null ? res.entries.find((e) => e.seq === seq) : res.entries.at(-1)
        setLoad(entry ? { state: 'ready', context: readCheckingContext(entry.payload) } : { state: 'none' })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[SignoffCheckedAgainst] loading the entry failed', { projectId, subjectId, err })
        setLoad({ state: 'error', message: 'Couldn’t read what this was checked against.' })
      })
    return () => controller.abort()
  }, [signing, projectId, subjectId, seq, attempt, refreshKey])
  const current = useMemo(() => (model ? new CurrentRuleIndex(currentCodesFor(model)) : null), [model])

  if (load.state === 'none' || load.state === 'loading') return null
  if (load.state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-danger-600" data-testid="signoff-checked-against-error">
        {load.message}
        <Button size="xs" variant="link" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </span>
    )
  }
  return <CheckedAgainstLine context={load.context} standing={current ? contextStanding(load.context, current) : null} />
}
