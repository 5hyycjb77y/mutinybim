'use client'

import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'
import { isLinkedLevelsResponse, type LinkedLevelsResponse } from '../../contracts/building-model/linked-levels-contract'

/** Every linked model's storeys, placed in this model (the host's `levels` port). Failures carry the server's reason. */
export async function fetchLinkedLevelsFrom(port: EditorDataHost['levels'], projectId: string, signal?: AbortSignal): Promise<LinkedLevelsResponse> {
  if (!port) throw new EditorServiceUnavailableError("The linked models' storeys")
  const res = await port.linked({ projectId }, { signal })
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error("[levels-api] the architect's levels: response was not JSON", err)
    return null
  })
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null
    throw new Error(message ?? `Reading the linked models' storeys failed (HTTP ${res.status}).`)
  }
  if (!isLinkedLevelsResponse(body)) throw new Error("Reading the linked models' storeys: the server sent an unexpected answer.")
  return body
}
