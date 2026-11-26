import { MODEL_PATH } from './paths'

interface NativeConfig { authority: 'native'; authorityUrl: string }
interface PendingSignIn { id: string; state: string; target: string }
const pendingKey = 'mutinybim.native.signin'
const callbackPath = '/auth/native/callback'

async function post(path: string, fields: object) {
  const response = await fetch('/auth/native/' + path, { method: 'POST', mode: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error(typeof body?.error === 'string' ? body.error : 'Sign-in could not finish. Reopen the model to sign in again.')
  }
  return body
}

function pending(): PendingSignIn | null {
  const value = sessionStorage.getItem(pendingKey)
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).id === 'string' &&
      typeof (parsed as Record<string, unknown>).state === 'string' &&
      typeof (parsed as Record<string, unknown>).target === 'string'
    ) {
      return parsed as PendingSignIn
    }
  } catch {
    // Malformed sessionStorage state is cleared below so sign-in can recover cleanly.
  }
  sessionStorage.removeItem(pendingKey)
  return null
}

// Capture the callback before loading configuration. Never send the code as a referrer or keep it in history.
export function readNativeCallback() {
  if (location.pathname !== callbackPath) return null
  const params = new URLSearchParams(location.search)
  history.replaceState(null, '', callbackPath)
  return { code: params.get('code'), state: params.get('state') }
}

export async function nativeSignIn(config: NativeConfig, callback: ReturnType<typeof readNativeCallback>) {
  if (!callback) {
    if (!MODEL_PATH.test(location.pathname)) throw new Error('Open a model to sign in.')
    const target = location.pathname + location.search
    const { transactionId, authorizationUrl } = await post('start', {})
    const state = new URL(authorizationUrl).searchParams.get('state')
    if (typeof transactionId !== 'string' || !state) throw new Error('Could not start sign-in.')
    sessionStorage.setItem(pendingKey, JSON.stringify({ id: transactionId, state, target }))
    location.replace(authorizationUrl)
    return null
  }
  const login = pending()
  if (!login || login.state !== callback.state) throw new Error('This reply belongs to a different sign-in. Reopen the model.')
  const target = new URL(login.target, location.origin)
  if (target.origin !== location.origin || !MODEL_PATH.test(target.pathname)) throw new Error('Open a model to sign in.')
  history.replaceState(null, '', target.pathname + target.search)
  if (!callback.code) throw new Error('Sign-in was cancelled. Reload to try again.')
  const result = await post('finish', { state: callback.state, code: callback.code, transactionId: login.id })
  if (pending()?.id !== login.id || result.transactionId !== login.id || typeof result.token !== 'string' ||
      typeof result.userId !== 'string' || typeof result.displayName !== 'string') throw new Error('The active sign-in changed. Reopen the model.')
  sessionStorage.removeItem(pendingKey)
  return { authority: 'external' as const, authorityUrl: config.authorityUrl, userId: result.userId as string,
    displayName: result.displayName as string, token: result.token as string, requireWriteGrant: true }
}
