'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, CircleAlert, KeySquare } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/spinner'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchSignoffEntriesFrom } from '../../contracts/bim/signing/client'
import { checkEntrySignatures, type EntrySignature } from '../../contracts/bim/signing/verify'
import { ASSURANCE_LABELS } from '../../contracts/bim/signing/words'
import { DEFAULT_HOST_IDENTITY } from '../../contracts/bim/identity/host-provider'

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'none' }
  | { readonly state: 'ready'; readonly signature: EntrySignature; readonly checkedAt: Date }

/**
 * One sign-off entry's assurance level, plainly: **Signed** ("Signed by J.
 * Rao · Verify", re-checked in this browser with the kernel's verifier),
 * **Verified** (a one-time code, "not a digital signature"), **Recorded**, or
 * "Signature doesn't check" with why. Verify checks a signature again now.
 */
export function SignoffSignatureLine({ projectId, subjectId, seq, refreshKey = 0 }: { readonly projectId: string; readonly subjectId: string; readonly seq?: number | null; readonly refreshKey?: number }) {
  const host = useEditorHost()
  const signing = host.data.signing
  const identity = host.identity.provider ?? DEFAULT_HOST_IDENTITY
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void attempt
    void refreshKey
    fetchSignoffEntriesFrom(signing, projectId, subjectId, controller.signal)
      .then(async (res) => {
        const entry = seq != null ? res.entries.find((e) => e.seq === seq) : res.entries.at(-1)
        if (!entry) return setLoad({ state: 'none' })
        const checked = await checkEntrySignatures({ entries: [entry], keyLogs: res.keyLogs, attachWindowMinutes: res.attachWindowMinutes }, identity)
        const signature = checked.get(entry.id)
        setLoad(signature ? { state: 'ready', signature, checkedAt: new Date() } : { state: 'none' })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[SignoffSignatureLine] loading the entry failed', { projectId, subjectId, err })
        setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Couldn’t check the signature.' })
      })
    return () => controller.abort()
  }, [signing, identity, projectId, subjectId, seq, attempt, refreshKey])

  const verify = useCallback(() => {
    setLoad({ state: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  if (load.state === 'none') return null
  if (load.state === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="signoff-signature-loading" aria-busy="true">
        <Spinner aria-hidden />
        Checking the signature…
      </span>
    )
  }
  if (load.state === 'error') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs text-danger-600" data-testid="signoff-signature-error">
        {load.message}
        <Button size="xs" variant="link" onClick={verify}>
          Retry
        </Button>
      </span>
    )
  }
  const s = load.signature
  const level = s.kind === 'signed' ? ASSURANCE_LABELS.signed : s.kind === 'verified' ? ASSURANCE_LABELS.verified : s.kind === 'recorded' ? ASSURANCE_LABELS.recorded : null
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid="signoff-signature" data-kind={s.kind}>
      {level ? (
        <Badge variant={s.kind === 'recorded' ? 'outline' : 'secondary'} data-testid="signoff-level">
          {level}
        </Badge>
      ) : null}
      {s.kind === 'signed' ? <BadgeCheck aria-hidden className="text-success-700" /> : s.kind === 'verified' ? <KeySquare aria-hidden className="text-muted-foreground" /> : s.kind === 'doesnt_check' ? <CircleAlert aria-hidden className="text-danger-600" /> : null}
      <span className={s.kind === 'doesnt_check' ? 'text-danger-600' : s.kind === 'signed' ? 'text-foreground' : 'text-muted-foreground'}>
        {s.words}
        {s.kind === 'doesnt_check' ? `: ${s.reason}` : null}
      </span>
      {s.kind === 'signed' || s.kind === 'doesnt_check' ? (
        <Button size="xs" variant="link" onClick={verify} title={`Checked in this browser at ${load.checkedAt.toLocaleTimeString()}. Check again.`} data-testid="signoff-signature-verify">
          Verify
        </Button>
      ) : null}
    </span>
  )
}
