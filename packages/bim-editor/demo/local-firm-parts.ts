import { canonicalJson } from '@permitzip/bim-kernel'
import type { EditorPartPublishRequest } from '@permitzip/bim-editor-host'
import { confirmedPartPublish, isPartPublishRefusal } from '../src/contracts/bim/firm-part-versions'
import { jsonAnswer } from '../src/host/local-data'

type RecoveryNotice = (ok: boolean, message: string) => void

/** Keep each confirmed intent until the local catalog answers for that exact request. */
export function createDemoFirmParts(catalogId: string, userId: string, storage: () => Storage, fetcher: typeof fetch = fetch) {
  const url = `/api/bim/library/part-types?library=${encodeURIComponent(catalogId)}`
  const prefix = `mutinybim:part-publish:${encodeURIComponent(catalogId)}:${encodeURIComponent(userId)}:`
  let recovering: Promise<void> | undefined

  async function send(input: EditorPartPublishRequest) {
    const key = prefix + input.requestId
    const bytes = canonicalJson(input)
    const store = storage()
    const pending = store.getItem(key)
    if (pending !== null && pending !== bytes) throw new Error('This pending publish ID belongs to another edit.')
    if (pending === null) store.setItem(key, bytes)
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: pending ?? bytes })
    const body: unknown = await response.json()
    const confirmed = response.ok ? confirmedPartPublish(input, body) : null
    if (!confirmed && !isPartPublishRefusal(response.status)) throw new Error('The catalog has not returned a matching receipt.')
    store.removeItem(key)
    return { answer: jsonAnswer(body, response.status), confirmed }
  }

  async function recover(report: RecoveryNotice) {
    const store = storage()
    // Removing a completed entry changes Storage.key(index). Take the key list before sending any.
    const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => k !== null && k.startsWith(prefix))
    for (const key of keys) {
      const bytes = store.getItem(key)
      if (bytes === null) continue
      try {
        const request = JSON.parse(bytes) as EditorPartPublishRequest
        if (!request || key !== prefix + request.requestId || !Number.isSafeInteger(request.baseRevision) || !request.definition) throw new Error('The pending publish record is incomplete.')
        const { answer, confirmed } = await send(request)
        const def = request.definition
        const name = typeof def === 'object' && 'familyName' in def && typeof def.familyName === 'string' ? def.familyName : 'part'
        if (confirmed) report(true, `Confirmed your earlier publish of ${name} at revision ${confirmed.revision}.`)
        else {
          const body = await answer.json()
          const detail = body && typeof body === 'object' && 'error' in body ? body.error : null
          report(false, answer.status === 409 ? `Your earlier publish of ${name} conflicted with another revision. Open the catalog to review it.` : `The catalog declined your earlier publish of ${name}. ${typeof detail === 'string' ? detail : ''}`.trim())
        }
      } catch (err) {
        report(false, `An earlier publish is still pending. Reopen the editor to retry. ${err instanceof Error ? err.message : ''}`.trim())
      }
    }
  }

  return {
    partTypes: async () => { await recovering; return fetcher(url) },
    publishPartTypeAtRevision: async (request: EditorPartPublishRequest) => (await send(request)).answer,
    recoverPending(report: RecoveryNotice) {
      recovering ??= recover(report).catch(() => report(false, 'Could not read pending publishes from this browser’s local storage.'))
      return recovering
    },
  }
}
