import type { CodeChangeNoticesResponse, CodeChangeRecordedResponse, ModelSignoffsResponse, OverrideRecordedResponse } from "./api"
import type { CodeChangeBody, OverrideBody } from "./requests"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/** Browser side of code changes (round 10, C10; the host's `codeChange` port). Errors carry the server's words. */

type CodeChangePort = EditorDataHost["codeChange"]

async function call<T>(port: CodeChangePort, send: (port: NonNullable<CodeChangePort>) => Promise<EditorDataAnswer>, what: string): Promise<T> {
  if (!port) throw new EditorServiceUnavailableError("Code changes and the approvals that relied on them")
  const res = await send(port)
  if (!res.ok) {
    const body: unknown = await res.json().catch((err: unknown) => {
      console.error(`[code-change] ${what}: the error body couldn't be read`, err)
      return null
    })
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Couldn't ${what} (${res.status}). Try again.`
    throw new Error(message)
  }
  return (await res.json()) as T
}

export function fetchCodeChangeNoticesFrom(port: CodeChangePort, signal?: AbortSignal): Promise<CodeChangeNoticesResponse> {
  return call(port, (p) => p.notices({ signal }), "load code changes")
}

export function markCodeChangeNoticesReadFrom(port: CodeChangePort, ids: readonly string[]): Promise<{ readonly read: number }> {
  return call(port, (p) => p.markRead({ ids }), "mark it read")
}

export function fetchModelSignoffsFrom(port: CodeChangePort, projectId: string, modelId: string, signal?: AbortSignal): Promise<ModelSignoffsResponse> {
  return call(port, (p) => p.signoffs({ projectId, modelId }, { signal }), "load the approvals")
}

/** After the code-of-record change is saved in the model: tell the people whose approvals relied on the old code. */
export function postCodeChangeFrom(port: CodeChangePort, projectId: string, body: CodeChangeBody): Promise<CodeChangeRecordedResponse> {
  return call(port, (p) => p.record({ projectId, body }), "tell the people who signed")
}

export function postOverrideFrom(port: CodeChangePort, projectId: string, body: OverrideBody): Promise<OverrideRecordedResponse> {
  return call(port, (p) => p.override({ projectId, body }), "record the override")
}
