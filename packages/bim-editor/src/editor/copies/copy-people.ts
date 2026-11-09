import type { EditorCopiesPort } from '@permitzip/bim-editor-host'

/** What a person named on a copy may do, in the words People shows. */
export const CAPABILITY_WORDS = { read: 'Read', propose: 'Propose', review: 'Review', edit: 'Edit' } as const
export type CopyCapabilityWord = keyof typeof CAPABILITY_WORDS

// db-shape: the host's JSON answer for People (a route body), not a table row.
export interface CopyPersonView {
  readonly grantId: string
  readonly label: string
  readonly capability: CopyCapabilityWord
}

export interface CopyPeople {
  readonly rows: readonly CopyPersonView[]
  /** People who may be named; null when the viewer may not see the project's roster. */
  readonly candidates: readonly { readonly userId: string; readonly label: string }[] | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** People on a copy, through the host; the body's shape is checked here (the host only relays). */
export async function readCopyPeople(port: EditorCopiesPort, input: { readonly projectId: string; readonly copyId: string }, signal: AbortSignal): Promise<CopyPeople> {
  const res = await port.people(input, { signal })
  const body: unknown = await res.json()
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : 'People didn’t load. Try again.')
  if (!isRecord(body) || !Array.isArray(body.people)) throw new Error('People came back in a shape this screen can’t read. Reload the page.')
  const rows = body.people.flatMap((p): CopyPersonView[] => {
    if (!isRecord(p) || typeof p.grantId !== 'string' || typeof p.label !== 'string' || typeof p.capability !== 'string' || !(p.capability in CAPABILITY_WORDS)) return []
    return [{ grantId: p.grantId, label: p.label, capability: p.capability as CopyCapabilityWord }]
  })
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.flatMap((c) => (isRecord(c) && typeof c.userId === 'string' && typeof c.label === 'string' ? [{ userId: c.userId, label: c.label }] : []))
    : null
  return { rows, candidates }
}
