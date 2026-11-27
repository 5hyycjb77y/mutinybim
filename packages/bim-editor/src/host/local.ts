import { BRANCH_SEPARATOR, branchModelId, isBranchId } from '@permitzip/bim-kernel'
import type {
  EditorHost,
  EditorLocation,
  EditorModelMembersPort,
  EditorPreferenceState,
  EditorPreferences,
  EditorPreferenceValue,
  EditorRouter,
} from '@permitzip/bim-editor-host'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createLocalDataHost, type LocalFirmPartsPort } from './local-data'
import { createLocalShellHost } from './local-shell'
import { sonnerNotifier } from './sonner-notifier'

// The standalone host's whole surface. It imports the kernel, so it is its own entry
// (`@permitzip/bim-editor/host/local`), never part of `@permitzip/bim-editor/host`.
export { createLocalDataHost, jsonAnswer, type LocalFirmPartsPort } from './local-data'
export { CONNECT_AGENT_DOC_HREF, MUTINYBIM_REPOSITORY_URL, createLocalShellHost, type LocalShellHostOptions } from './local-shell'
export { sonnerNotifier }

/**
 * The standalone host: one person on this computer, the local model server,
 * no built-in agent and no file storage. Outside AIs connect to the model
 * through the tool server, not through the editor.
 */
export interface LocalEditorHostOptions {
  /** The authority issued this tab a native session and serves model memberships. */
  readonly nativeMembership?: boolean
  readonly requireWriteGrant?: boolean
  /** The local model server's WebSocket address, e.g. `ws://127.0.0.1:3095/sync`. */
  readonly authorityUrl: string
  readonly userId?: string
  readonly displayName?: string
  /** What the local model server accepts; the in-process dev server accepts anything. */
  readonly token?: string | null
  /** The local host's versioned parts catalog, when connected. */
  readonly firmParts?: LocalFirmPartsPort
  /** Where this app tells people to connect storage or an AI, in words; null when it has no such place. */
  readonly connectHint?: string | null
}

const SERVER_LOCATION: EditorLocation = { pathname: '/', search: '' }
const LOCATION_CHANGED = 'mutinybim:location'

let cachedKey = ''
let cachedLocation: EditorLocation = SERVER_LOCATION

function currentLocation(): EditorLocation {
  const { pathname, search } = window.location
  const key = `${pathname}?${search}`
  if (key !== cachedKey) {
    cachedKey = key
    cachedLocation = { pathname, search: search.startsWith('?') ? search.slice(1) : search }
  }
  return cachedLocation
}

function subscribeLocation(listener: () => void): () => void {
  window.addEventListener('popstate', listener)
  window.addEventListener(LOCATION_CHANGED, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(LOCATION_CHANGED, listener)
  }
}

/** The browser's own history, for a page that is not inside a framework router. */
export const historyRouter: EditorRouter = {
  useLocation() {
    return useSyncExternalStore(subscribeLocation, currentLocation, () => SERVER_LOCATION)
  },
  push(href) {
    window.history.pushState(null, '', href)
    window.dispatchEvent(new Event(LOCATION_CHANGED))
  },
  replace(href) {
    window.history.replaceState(null, '', href)
    window.dispatchEvent(new Event(LOCATION_CHANGED))
  },
}

type Stored = Readonly<Record<string, EditorPreferenceValue | undefined>>

/** Preferences for this tab only: the standalone app has one local person and nothing to sign in to. */
export function memoryPreferences(): EditorPreferences {
  const namespaces = new Map<string, Stored>()
  const listeners = new Set<() => void>()
  const EMPTY: Stored = {}
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    usePreferences<T extends Record<string, EditorPreferenceValue | undefined>>(namespace: string, defaults: T): EditorPreferenceState<T> {
      const stored = useSyncExternalStore(subscribe, () => namespaces.get(namespace) ?? EMPTY, () => EMPTY)
      const set = useCallback(
        async <K extends keyof T & string>(key: K, value: T[K]) => {
          namespaces.set(namespace, { ...(namespaces.get(namespace) ?? EMPTY), [key]: value })
          for (const listener of listeners) listener()
        },
        [namespace],
      )
      return useMemo(() => ({ values: { ...defaults, ...stored } as T, loaded: true, set }), [defaults, stored, set])
    },
  }
}

function nativeModelMembers(authorityUrl: string, token: string): EditorModelMembersPort {
  const origin = new URL(authorityUrl)
  if (origin.protocol === 'wss:') origin.protocol = 'https:'
  else if (origin.protocol === 'ws:') origin.protocol = 'http:'
  const address = (modelId: string) => new URL('/models/' + encodeURIComponent(modelId) + '/members', origin)
  const auth = { Authorization: 'Bearer ' + token }
  return {
    read(modelId, personId, signal) {
      const url = address(modelId)
      if (personId !== undefined) url.searchParams.set('personId', personId)
      return fetch(url, { headers: auth, signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
    },
    change(modelId, input) {
      return fetch(address(modelId), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(input), credentials: 'omit', cache: 'no-store', redirect: 'error' })
    },
  }
}

export function createLocalEditorHost(options: LocalEditorHostOptions): EditorHost {
  const token = options.token === undefined ? 'local' : options.token
  return {
    data: { ...createLocalDataHost(options.firmParts), ...(options.nativeMembership && options.token
      ? { modelMembers: nativeModelMembers(options.authorityUrl, options.token) } : {}) },
    shell: createLocalShellHost(),
    identity: { userId: options.userId ?? 'local-user', displayName: options.displayName ?? 'You' },
    session: {
      async openConfig(modelRef, openOptions) {
        const branch = openOptions?.branch ?? null
        // A branch of this model lives on the same local model server under `<model>~<branch>`.
        const modelId = branch && isBranchId(branch) && !modelRef.includes(BRANCH_SEPARATOR) ? branchModelId(modelRef, branch) : modelRef
        return { references: [], authority: { url: options.authorityUrl, modelId } }
      },
      async getAccessToken() {
        return token
      },
    },
    router: historyRouter,
    links: { hrefFor: () => null },
    notify: sonnerNotifier,
    preferences: memoryPreferences(),
    capabilities: { hostName: 'this computer', connectHint: options.connectHint ?? null, requireWriteGrant: options.requireWriteGrant },
  }
}
