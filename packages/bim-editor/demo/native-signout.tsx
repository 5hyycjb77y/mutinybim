import { useEffect, useState } from 'react'
import { Button } from '@permitzip/bim-ui'

async function revokeSession(token: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch('/auth/native/sign-out', {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    return response.status === 204
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function confirmRevocation(token: string, retry: boolean): Promise<boolean> {
  const confirmed = await revokeSession(token)
  if (confirmed || !retry) return confirmed
  await new Promise(resolve => setTimeout(resolve, 500))
  return revokeSession(token)
}

/** Hold only the session that was signed out; concurrent callers share a pending attempt. */
export function nativeRevocation(sessionToken: string): () => Promise<boolean> {
  let token: string | null = sessionToken
  let pending: Promise<boolean> | null = null
  let automaticRetry = true
  return () => {
    if (pending) return pending
    if (token === null) return Promise.resolve(true)
    pending = confirmRevocation(token, automaticRetry).then(confirmed => {
      if (confirmed) token = null
      pending = null
      return confirmed
    })
    automaticRetry = false
    return pending
  }
}

export function NativeSignedOut({ confirm, signIn }: { confirm: () => Promise<boolean>; signIn: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'pending' | 'unconfirmed' | 'confirmed'>('pending')
  useEffect(() => {
    let current = true
    void confirm().then(confirmed => {
      if (current) setStatus(confirmed ? 'confirmed' : 'unconfirmed')
    })
    return () => { current = false }
  }, [attempt, confirm])
  return (
    <main className="grid flex-1 place-items-center p-6 text-(--mutiny-text)">
      <section className="flex max-w-md flex-col items-start gap-4" aria-labelledby="native-sign-out-heading">
        <h1 id="native-sign-out-heading" className="text-2xl font-semibold">{status === 'confirmed' ? 'Signed out' : 'Sign-out pending'}</h1>
        <p role="status" className="text-(--mutiny-muted)">
          {status === 'confirmed' ? 'You’re signed out of this tab.'
            : status === 'unconfirmed' ? 'Editing stopped in this tab. The model server hasn’t confirmed sign-out.'
            : 'Editing stopped in this tab. Waiting for the model server to confirm sign-out.'}
        </p>
        {status === 'unconfirmed' && <Button onClick={() => { setStatus('pending'); setAttempt(n => n + 1) }}>Retry sign-out</Button>}
        {status === 'confirmed' && <Button onClick={signIn}>Sign in again</Button>}
      </section>
    </main>
  )
}
