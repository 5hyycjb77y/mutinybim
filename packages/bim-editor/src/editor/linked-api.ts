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

/** The places a model can be linked from that this host serves. A source it doesn't serve is not offered. */
export interface LinkSources {
  /** An IFC file from the person's computer. */
  readonly ifcUpload: boolean
  /** The project's connected Revit model, with the models linked in it. */
  readonly revitExport: boolean
  /** Files picked from the project's Autodesk Docs. */
  readonly autodeskDocs: boolean
}

/** What the host's port can link from: a source counts only when every method it needs is there. */
export function linkSourcesOf(port: LinkedPort): LinkSources {
  return {
    ifcUpload: Boolean(port?.startUpload && port.putFile && port.convert),
    revitExport: Boolean(port?.autodeskExport && port.updateFromRevit),
    autodeskDocs: Boolean(port?.browseDocs && port.addDocs && port.refreshDocs && port.lineUp),
  }
}

/** Whether Link (the dialog) has anything to offer: an upload or the Revit model. Autodesk Docs has its own picker. */
export function canLinkFrom(sources: LinkSources): boolean {
  return sources.ifcUpload || sources.revitExport
}

/** What Link a model does here, in words, naming only the sources this host serves. */
export function linkDescription(sources: LinkSources): string {
  const autodesk = sources.revitExport || sources.autodeskDocs
  if (autodesk && sources.ifcUpload) return "Bring in the architect's model from Autodesk Docs or an IFC file"
  if (autodesk) return "Bring in the architect's model from Autodesk Docs"
  if (sources.ifcUpload) return "Bring in the architect's model from an IFC file"
  return 'Linking a model is not available here'
}

/** What the Link button opens, in words. */
export function linkButtonHint(sources: LinkSources): string {
  if (sources.revitExport && sources.ifcUpload) return 'Bring in the models linked in our Revit file, or upload an IFC file'
  if (sources.revitExport) return 'Bring in the models linked in our Revit file'
  return 'Upload an IFC file'
}

/** Why nothing can be linked where the editor runs, in words; null when something can. */
export function linkUnavailableReason(sources: LinkSources, hostName: string): string | null {
  if (canLinkFrom(sources) || sources.autodeskDocs) return null
  return `Linked models aren't available here: ${hostName} doesn't keep linked model files. You can model without one.`
}

const UPLOAD_SERVICE = 'Uploading an IFC file'
const REVIT_SERVICE = "Bringing in the project's Revit model"
const DOCS_SERVICE = 'Adding models from Autodesk Docs'

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
  const p = portOf(port)
  if (!p.startUpload) throw new EditorServiceUnavailableError(UPLOAD_SERVICE)
  return readJson(await p.startUpload({ projectId, request }), isStartUploadResponse, 'Starting the upload')
}

export async function completeUploadFrom(port: LinkedPort, projectId: string, versionId: string): Promise<void> {
  const p = portOf(port)
  if (!p.convert) throw new EditorServiceUnavailableError(UPLOAD_SERVICE)
  await readJson(await p.convert({ projectId, versionId }), isOk, 'Queuing the conversion')
}

export async function retryVersionFrom(port: LinkedPort, projectId: string, versionId: string): Promise<void> {
  const p = portOf(port)
  if (!p.convert) throw new EditorServiceUnavailableError(UPLOAD_SERVICE)
  await readJson(await p.convert({ projectId, versionId }), isOk, 'Trying the conversion again')
}

export async function startAutodeskExportFrom(port: LinkedPort, projectId: string): Promise<void> {
  const p = portOf(port)
  if (!p.autodeskExport) throw new EditorServiceUnavailableError(REVIT_SERVICE)
  await readJson(await p.autodeskExport({ projectId }), isOk, 'Starting the export from Revit')
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
  const p = portOf(port)
  if (!p.browseDocs) throw new EditorServiceUnavailableError(DOCS_SERVICE)
  return readJson(await p.browseDocs({ projectId, request }, { signal }), isDocsBrowseResponse, 'Opening Autodesk Docs')
}

export async function addDocsItemsFrom(port: LinkedPort, projectId: string, items: readonly DocsAddItem[]): Promise<DocsAddResult[]> {
  const p = portOf(port)
  if (!p.addDocs) throw new EditorServiceUnavailableError(DOCS_SERVICE)
  const body = await readJson(await p.addDocs({ projectId, items }), isDocsAddResponse, 'Adding the models')
  return body.results
}

export async function refreshDocsReferenceFrom(
  port: LinkedPort,
  projectId: string,
  referenceId: string,
  mode: 'check' | 'relink',
): Promise<{ outcome: 'up_to_date' | 'queued' | 'already_running'; versionNumber: number | null }> {
  const p = portOf(port)
  if (!p.refreshDocs) throw new EditorServiceUnavailableError(DOCS_SERVICE)
  return readJson(
    await p.refreshDocs({ projectId, referenceId, mode }),
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
  const p = portOf(port)
  if (!p.freshness) throw new EditorServiceUnavailableError('Checking Autodesk Docs for new versions')
  const body = await readJson(await p.freshness({ projectId }, { signal }), isFreshnessResponse, 'Checking Autodesk Docs for new versions')
  return body.models
}

/** Update a linked model from Revit; `force` exports it again even when Docs has nothing newer. */
export async function updateFromRevitFrom(port: LinkedPort, projectId: string, referenceId: string, force: boolean): Promise<LinkedUpdateOutcome> {
  const p = portOf(port)
  if (!p.updateFromRevit) throw new EditorServiceUnavailableError(REVIT_SERVICE)
  return readJson(await p.updateFromRevit({ projectId, referenceId, force }), isUpdateOutcome, 'Updating from Revit')
}

export async function lineUpDocsReferenceFrom(port: LinkedPort, projectId: string, referenceId: string): Promise<void> {
  const p = portOf(port)
  if (!p.lineUp) throw new EditorServiceUnavailableError(DOCS_SERVICE)
  await readJson(await p.lineUp({ projectId, referenceId }), isOk, 'Lining it up with the project model')
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
  const p = portOf(port)
  if (!p.putFile) throw new EditorServiceUnavailableError(UPLOAD_SERVICE)
  const handle = await p.putFile({ sourcePath, file }, onProgress)
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
