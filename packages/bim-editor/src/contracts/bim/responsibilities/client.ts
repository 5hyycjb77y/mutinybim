import type { MergePreview } from "@permitzip/bim-sync"
import type { MergesResponse, ResponsibilitiesResponse, TakeResult } from "./api"
import type { StoredScope } from "./model"
import { suggestedScopeFields } from "./requests"
import type { EditorDataAnswer, EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

/**
 * Browser calls for Manage › Responsibilities, Propose merge and Checklist ›
 * Merges waiting for you. Every failure throws an Error with the server's
 * words, so screens show it (with Retry) instead of a blank pane.
 */

type ResponsibilitiesPort = EditorDataHost["responsibilities"]

async function call<T>(port: ResponsibilitiesPort, send: (port: NonNullable<ResponsibilitiesPort>) => Promise<EditorDataAnswer>, what: string): Promise<T> {
  if (!port) throw new EditorServiceUnavailableError("Responsibilities and merges")
  let res: EditorDataAnswer
  try {
    res = await send(port)
  } catch (err) {
    console.error(`[bim/responsibilities] ${what} unreachable`, err)
    throw new Error(`Couldn't reach the app to ${what}. Check your connection and try again.`)
  }
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[bim/responsibilities] ${what} answered without JSON`, { status: res.status, err })
    return null
  })
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Couldn't ${what} (error ${res.status}).`
    console.error(`[bim/responsibilities] ${what} refused`, { status: res.status, message })
    throw new Error(message)
  }
  return body as T
}

export function fetchResponsibilitiesFrom(port: ResponsibilitiesPort, projectId: string, signal?: AbortSignal): Promise<ResponsibilitiesResponse> {
  return call(port, (p) => p.list({ projectId }, { signal }), "load who is responsible")
}

export type NameInput =
  | { kind: "person"; personId: string; discipline: string; scope?: StoredScope; scopeWords?: string }
  | { kind: "firm"; organizationId: string; discipline: string; approvalRule: "each" | "any_one"; scope?: StoredScope; scopeWords?: string }
  | { kind: "firm_person"; firmEntryId: string; personId: string }

export function nameResponsibleFrom(port: ResponsibilitiesPort, projectId: string, input: NameInput): Promise<{ id: string }> {
  return call(port, (p) => p.name({ projectId, input }), "name them")
}

export function takeResponsibilityFrom(port: ResponsibilitiesPort, projectId: string, input: { discipline: string; scope?: StoredScope; scopeWords?: string }): Promise<TakeResult> {
  return call(port, (p) => p.take({ projectId, input }), "take responsibility")
}

export function decideRequestFrom(port: ResponsibilitiesPort, projectId: string, id: string, input: { grant: boolean; note?: string }): Promise<{ id: string; granted: boolean }> {
  return call(port, (p) => p.decideRequest({ projectId, id, input }), "decide the request")
}

export function removeResponsibleFrom(port: ResponsibilitiesPort, projectId: string, id: string): Promise<{ id: string }> {
  return call(port, (p) => p.remove({ projectId, id }), "remove them")
}

export function acceptResponsibilityFrom(port: ResponsibilitiesPort, projectId: string, id: string, checkingContext?: unknown): Promise<{ id: string; acceptedAt: string; signoffSeq: number | null }> {
  // C10: what the acceptance was checked against rides inside its hashed sign-off payload.
  return call(port, (p) => p.accept({ projectId, id, ...(checkingContext !== undefined ? { checkingContext } : {}) }), "accept it")
}

export function fetchMergesFrom(port: ResponsibilitiesPort, projectId: string, signal?: AbortSignal): Promise<MergesResponse> {
  return call(port, (p) => p.merges({ projectId }, { signal }), "load merges")
}

export function proposeMergeFrom(port: ResponsibilitiesPort, projectId: string, preview: MergePreview): Promise<{ id: string; refreshed: boolean }> {
  const { branchId, branchName, baseRevision, branchHead, mainHead, conflicts } = preview
  const parts = preview.parts.map((p) => ({ discipline: p.discipline, responsibilityIds: [...p.responsibilityIds], elementIds: [...p.elementIds], deltaDigest: p.deltaDigest, lastChangedRevision: p.lastChangedRevision, ...suggestedScopeFields(p) }))
  return call(port, (p) => p.proposeMerge({ projectId, body: { branchId, branchName, baseRevision, branchHead, mainHead, parts, conflicts } }), "propose the merge")
}

export function decideMergePartFrom(
  port: ResponsibilitiesPort,
  projectId: string,
  proposalId: string,
  // C10: `checkingContext` is what the approval was checked against (kernel `writeCheckingContext`).
  input: { responsibilityId: string | null; decision: "approved" | "declined"; note?: string; branchHead: number; deltaDigest: string; checkingContext?: unknown },
): Promise<{ id: string; decision: string; signoffSeq: number }> {
  return call(port, (p) => p.decideMergePart({ projectId, proposalId, input }), "save your decision")
}

export function recordLandedFrom(
  port: ResponsibilitiesPort,
  projectId: string,
  proposalId: string,
  input: { landed: readonly { discipline: string; elementIds: readonly string[]; revision: number; deltaDigest: string }[]; allLanded: boolean },
): Promise<{ id: string; status: string }> {
  return call(port, (p) => p.recordLanded({ projectId, proposalId, input }), "record what landed")
}
