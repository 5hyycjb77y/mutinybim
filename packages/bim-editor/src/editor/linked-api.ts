'use client'

import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'
import type {
  DocsAddItem,
  DocsAddResult,
  DocsBrowseResponse,
  LinkedFreshnessView,
  LinkedModelsResponse,
  LinkedUpdateOutcome,
  PlacementAdjustment,
  StartUploadRequest,
  StartUploadResponse,
} from '../contracts/building-model/linked-contract'

/** Browser calls for the Building Model's linked models (the host's `linkedModels` port); every failure carries the server's plain-English reason. */

type LinkedPort = EditorDataHost['linkedModels']

function portOf(port: LinkedPort): NonNullable<LinkedPort> {
  if (!port) throw new EditorServiceUnavailableError('Linked models')
  return port
}

async function readJson<T>(res: EditorDataAnswer, guard: (v: unknown) => v is T, what: string): Promise<T> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error(`[linked-api] ${what}: response was not JSON`, err)
    return null
  })
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null
    throw new Error(message ?? `${what} failed (HTTP ${res.status}).`)
  }
  if (!guard(body)) throw new Error(`${what}: the server sent an unexpected answer.`)
  return body
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isOk = (v: unknown): v is { ok: true } => isObject(v) && v.ok === true

function isLinkedModelsResponse(v: unknown): v is LinkedModelsResponse {
  return isObject(v) && typeof v.canEdit === 'boolean' && Array.isArray(v.references) && 'revitModel' in v && 'autodeskExport' in v
}

function isStartUploadResponse(v: unknown): v is StartUploadResponse {
  return isObject(v) && typeof v.referenceId === 'string' && typeof v.versionId === 'string' && typeof v.sourcePath === 'string'
}

export async function fetchLinkedModelsFrom(port: LinkedPort, projectId: string, signal?: AbortSignal): Promise<LinkedModelsResponse> {
  return readJson(await portOf(port).list({ projectId }, { signal }), isLinkedModelsResponse, 'Loading linked models')
}

export async function startUploadFrom(port: LinkedPort, projectId: string, request: StartUploadRequest): Promise<StartUploadResponse> {
  return readJson(await portOf(port).startUpload({ projectId, request }), isStartUploadResponse, 'Starting the upload')
}

export async function completeUploadFrom(port: LinkedPort, projectId: string, versionId: string): Promise<void> {
  await readJson(await portOf(port).convert({ projectId, versionId }), isOk, 'Queuing the conversion')
}

export async function retryVersionFrom(port: LinkedPort, projectId: string, versionId: string): Promise<void> {
  await readJson(await portOf(port).convert({ projectId, versionId }), isOk, 'Trying the conversion again')
}

export async function startAutodeskExportFrom(port: LinkedPort, projectId: string): Promise<void> {
  await readJson(await portOf(port).autodeskExport({ projectId }), isOk, 'Starting the export from Revit')
}

function isDocsBrowseResponse(v: unknown): v is DocsBrowseResponse {
  return isObject(v) && Array.isArray(v.folders) && Array.isArray(v.files)
}

function isDocsAddResponse(v: unknown): v is { results: DocsAddResult[] } {
  return isObject(v) && Array.isArray(v.results)
}

function isDocsRefreshResponse(v: unknown): v is { outcome: 'up_to_date' | 'queued' | 'already_running'; versionNumber: number | null } {
  return isObject(v) && (v.outcome === 'up_to_date' || v.outcome === 'queued' || v.outcome === 'already_running')
}

/** One folder of the project's Autodesk Docs project (null = its top folders), or a search below it. */
export async function browseDocsFrom(
  port: LinkedPort,
  projectId: string,
  request: { readonly folderId: string | null; readonly query?: string },
  signal?: AbortSignal,
): Promise<DocsBrowseResponse> {
  return readJson(await portOf(port).browseDocs({ projectId, request }, { signal }), isDocsBrowseResponse, 'Opening Autodesk Docs')
}

export async function addDocsItemsFrom(port: LinkedPort, projectId: string, items: readonly DocsAddItem[]): Promise<DocsAddResult[]> {
  const body = await readJson(await portOf(port).addDocs({ projectId, items }), isDocsAddResponse, 'Adding the models')
  return body.results
}

export async function refreshDocsReferenceFrom(
  port: LinkedPort,
  projectId: string,
  referenceId: string,
  mode: 'check' | 'relink',
): Promise<{ outcome: 'up_to_date' | 'queued' | 'already_running'; versionNumber: number | null }> {
  return readJson(
    await portOf(port).refreshDocs({ projectId, referenceId, mode }),
    isDocsRefreshResponse,
    mode === 'check' ? 'Checking Autodesk Docs' : 'Re-linking from Autodesk Docs',
  )
}

const FRESHNESS_STATES = new Set(['up_to_date', 'newer_available', 'never_recorded', 'updating', 'unknown', 'manual'])

function isFreshnessResponse(v: unknown): v is { models: LinkedFreshnessView[] } {
  return isObject(v) && Array.isArray(v.models) && v.models.every((m) => isObject(m) && typeof m.referenceId === 'string' && typeof m.state === 'string' && FRESHNESS_STATES.has(m.state))
}

function isUpdateOutcome(v: unknown): v is LinkedUpdateOutcome {
  return isObject(v) && (v.outcome === 'up_to_date' || v.outcome === 'queued' || v.outcome === 'already_running') && typeof v.kind === 'string'
}

/** Whether each linked model is behind Autodesk Docs (asks Autodesk, so it loads after the list). */
export async function fetchLinkedFreshnessFrom(port: LinkedPort, projectId: string, signal?: AbortSignal): Promise<LinkedFreshnessView[]> {
  const body = await readJson(await portOf(port).freshness({ projectId }, { signal }), isFreshnessResponse, 'Checking Autodesk Docs for new versions')
  return body.models
}

/** Update a linked model from Revit; `force` exports it again even when Docs has nothing newer. */
export async function updateFromRevitFrom(port: LinkedPort, projectId: string, referenceId: string, force: boolean): Promise<LinkedUpdateOutcome> {
  return readJson(await portOf(port).updateFromRevit({ projectId, referenceId, force }), isUpdateOutcome, 'Updating from Revit')
}

export async function lineUpDocsReferenceFrom(port: LinkedPort, projectId: string, referenceId: string): Promise<void> {
  await readJson(await portOf(port).lineUp({ projectId, referenceId }), isOk, 'Lining it up with the project model')
}

export async function updateLinkedReferenceFrom(
  port: LinkedPort,
  projectId: string,
  referenceId: string,
  patch: { readonly currentVersionId?: string; readonly adjustment?: PlacementAdjustment; readonly disciplines?: readonly string[]; readonly contributor?: { readonly organization?: string; readonly contact?: string } },
): Promise<void> {
  await readJson(await portOf(port).update({ projectId, referenceId, patch }), isOk, 'Saving the linked model')
}

export async function unlinkReferenceFrom(port: LinkedPort, projectId: string, referenceId: string): Promise<void> {
  await readJson(await portOf(port).unlink({ projectId, referenceId }), isOk, 'Unlinking')
}

export interface UploadHandle {
  readonly done: Promise<void>
  cancel(): void
}

/**
 * Upload the file to the one path the server handed back, as the signed-in
 * person (the host's storage only accepts that exact path while it awaits
 * this upload, and never overwrites a file), reporting progress (0–1).
 */
export async function putFileFrom(port: LinkedPort, sourcePath: string, file: File, onProgress: (fraction: number) => void): Promise<UploadHandle> {
  const handle = await portOf(port).putFile({ sourcePath, file }, onProgress)
  // The host rejects a cancelled upload with an AbortError; callers tell it apart by `UploadCancelled`.
  const done = handle.done.catch((err: unknown) => {
    throw typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError' ? new UploadCancelled() : err
  })
  return { done, cancel: () => handle.cancel() }
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled.')
    this.name = 'UploadCancelled'
  }
}
