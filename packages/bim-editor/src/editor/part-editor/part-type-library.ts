import { partTypeDefinitionSchema } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost, EditorPartPublishRequest } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { confirmedPartPublish, isPartPublishRefusal, type LibraryPartTypeEntry } from '../../contracts/bim/firm-part-versions'

/**
 * The browser's side of the firm library's part types
 * (`/api/bim/library/part-types`): read every part type with its revisions'
 * size hashes, and publish a drawn part as its next revision. Shared by the
 * part editor's Publish… and the placed part's update review.
 */

export type PublishAnswer = { readonly ok: true; readonly revision: number; readonly upToDate: boolean } | { readonly ok: false; readonly message: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

async function bodyOf(res: EditorDataAnswer, what: string): Promise<unknown> {
  return res.json().catch((err: unknown) => {
    console.error(`[part-type-library] ${what}: the answer wasn't JSON`, err)
    return null
  })
}

function isEntry(v: unknown): v is LibraryPartTypeEntry {
  return isRecord(v) && typeof v.id === 'string' && typeof v.key === 'string' && typeof v.revision === 'number' && Array.isArray(v.revisions) && partTypeDefinitionSchema.safeParse(v.definition).success
}

/** The firm library refused or failed a read; `status` is its HTTP answer (403: this person may not read the library). */
export class LibraryReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'LibraryReadError'
  }
}

type LibraryPort = EditorDataHost['firmLibrary']
const PART_TYPES = "The firm library's part types"

export async function fetchLibraryPartTypesFrom(port: LibraryPort): Promise<{ readonly canPublish: boolean; readonly partTypes: LibraryPartTypeEntry[] }> {
  // 404: there is no firm library here to read, said like any refused read.
  if (!port) throw new LibraryReadError(unavailableWords(PART_TYPES), 404)
  const res = await port.partTypes()
  const body = await bodyOf(res, 'list')
  if (!res.ok) throw new LibraryReadError(isRecord(body) && typeof body.error === 'string' ? body.error : `The firm library answered HTTP ${res.status}`, res.status)
  if (!isRecord(body) || !Array.isArray(body.partTypes)) throw new Error('The firm library answered without its part types')
  const partTypes: LibraryPartTypeEntry[] = []
  for (const p of body.partTypes) {
    if (isEntry(p)) partTypes.push(p)
    else console.error('[part-type-library] a part type did not parse; leaving it out', isRecord(p) ? p.id : p)
  }
  return { canPublish: body.canPublish === true, partTypes }
}

export async function publishPartTypeFrom(port: LibraryPort, definition: unknown, baseRevision?: number, requestId?: string): Promise<PublishAnswer> {
  if (!port) return { ok: false, message: unavailableWords('Publishing to the firm library') }
  let request: EditorPartPublishRequest | undefined
  let res: EditorDataAnswer
  if (port.publishPartTypeAtRevision) {
    if (baseRevision === undefined || !requestId) return { ok: false, message: 'Open Publish to confirm this edit.' }
    request = { definition, baseRevision, requestId }
    res = await port.publishPartTypeAtRevision(request)
  } else {
    res = await port.publishPartType({ definition })
  }
  const body = await bodyOf(res, 'publish')
  if (request) {
    const confirmed = res.ok && confirmedPartPublish(request, body)
    if (confirmed) return { ok: true, ...confirmed }
    if (!isPartPublishRefusal(res.status)) throw new Error('No matching publish receipt was received.')
  } else {
    if (res.ok && isRecord(body) && body.status === 'saved' && isRecord(body.summary) && typeof body.summary.revision === 'number') return { ok: true, revision: body.summary.revision, upToDate: false }
    if (res.ok && isRecord(body) && body.status === 'up_to_date' && typeof body.revision === 'number') return { ok: true, revision: body.revision, upToDate: true }
  }
  const detail = isRecord(body) && typeof body.message === 'string' ? body.message : isRecord(body) && typeof body.error === 'string' ? body.error : null
  if (res.status === 409) {
    const reason = isRecord(body) && typeof body.currentRevision === 'number' ? `The library is now at revision ${body.currentRevision}.` : detail ?? 'Another editor changed this part.'
    return { ok: false, message: `${reason} Review the current revision before publishing again.` }
  }
  return { ok: false, message: detail ?? (res.ok ? 'The library did not confirm a revision. Reopen Publish to check.' : `The firm library answered HTTP ${res.status}.`) }
}
