import type { RequirementsSnapshot, RequirementsSourceWriteBack, WriteBackResult } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost, EditorRequirementLink } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError, unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { PERMITZIP_CODE_STUDY_SOURCE_ID } from './code-study-source'

/**
 * The browser's calls to the host's code study (`codeStudy` port; lane P).
 * The server builds the snapshot on the person's own session; this only
 * checks the answer's shape and turns its outcomes into plain states.
 */

type CodeStudyPort = EditorDataHost['codeStudy']
const CODE_STUDY = 'The code study'

export type SnapshotFetch =
  | { readonly kind: 'ok'; readonly snapshot: RequirementsSnapshot; readonly revision: number }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string }

export type RevisionFetch =
  | { readonly kind: 'ok'; readonly revision: number }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string }

/** One link row as the route returns it (the generated row's columns). */
export type RequirementLink = EditorRequirementLink

export { PERMITZIP_CODE_STUDY_SOURCE_ID }
const PROVIDER = PERMITZIP_CODE_STUDY_SOURCE_ID

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRule(value: unknown): boolean {
  return isRecord(value) && typeof value.ruleId === 'string' && value.provider === PROVIDER && isRecord(value.citation) && typeof value.title === 'string' && Array.isArray(value.produces)
}

function isSnapshotAnswer(value: unknown): value is { ok: true; revision: number; snapshot: RequirementsSnapshot } {
  if (!isRecord(value) || value.ok !== true || typeof value.revision !== 'number' || !isRecord(value.snapshot)) return false
  const { snapshot } = value
  return isRecord(snapshot.source) && snapshot.source.id === PROVIDER && typeof snapshot.revision === 'string' && Array.isArray(snapshot.rules) && snapshot.rules.every(isRule)
}

function isLink(value: unknown): value is RequirementLink {
  return isRecord(value) && ['requirement_id', 'model_id', 'target_kind', 'target_id', 'link_kind'].every((key) => typeof value[key] === 'string')
}

async function errorOf(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[code-study-client] error body was not JSON', { status: res.status, err })
    return null
  })
  return isRecord(body) && typeof body.error === 'string' ? body.error : `The server answered HTTP ${res.status}.`
}

export async function fetchCodeStudySnapshotFrom(port: CodeStudyPort, projectId: string, signal?: AbortSignal): Promise<SnapshotFetch> {
  if (!port) return { kind: 'unavailable', reason: unavailableWords(CODE_STUDY) }
  try {
    const res = await port.read({ projectId, part: 'snapshot' }, { signal })
    if (res.status === 403) return { kind: 'unavailable', reason: await errorOf(res) }
    if (!res.ok) return { kind: 'error', reason: await errorOf(res) }
    const body: unknown = await res.json()
    if (!isSnapshotAnswer(body)) {
      console.error('[code-study-client] snapshot answer has an unexpected shape', { projectId })
      return { kind: 'error', reason: 'The code study came back in a shape the model does not understand.' }
    }
    return { kind: 'ok', snapshot: body.snapshot, revision: body.revision }
  } catch (err) {
    console.error('[code-study-client] snapshot fetch failed', { projectId, err })
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchCodeStudyRevisionFrom(port: CodeStudyPort, projectId: string, signal?: AbortSignal): Promise<RevisionFetch> {
  if (!port) return { kind: 'unavailable', reason: unavailableWords(CODE_STUDY) }
  try {
    const res = await port.read({ projectId, part: 'revision' }, { signal })
    if (res.status === 403) return { kind: 'unavailable', reason: await errorOf(res) }
    if (!res.ok) return { kind: 'error', reason: await errorOf(res) }
    const body: unknown = await res.json()
    if (!isRecord(body) || body.ok !== true || typeof body.revision !== 'number') {
      console.error('[code-study-client] revision answer has an unexpected shape', { projectId })
      return { kind: 'error', reason: 'The code study revision came back in an unexpected shape.' }
    }
    return { kind: 'ok', revision: body.revision }
  } catch (err) {
    console.error('[code-study-client] revision fetch failed', { projectId, err })
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Requirement ↔ model links for a project (Code Map "Show in model"). Throws with the server's reason. */
export async function fetchRequirementLinksFrom(port: CodeStudyPort, projectId: string, signal?: AbortSignal): Promise<RequirementLink[]> {
  if (!port) throw new EditorServiceUnavailableError(CODE_STUDY)
  const res = await port.read({ projectId, part: 'links' }, { signal })
  if (!res.ok) throw new Error(await errorOf(res))
  const body: unknown = await res.json()
  if (!isRecord(body) || !Array.isArray(body.links) || !body.links.every(isLink)) {
    throw new Error('The requirement links came back in an unexpected shape.')
  }
  return body.links
}

async function post(port: CodeStudyPort, projectId: string, payload: Record<string, unknown>): Promise<WriteBackResult> {
  if (!port) return { ok: false, reason: unavailableWords(CODE_STUDY) }
  try {
    const res = await port.write({ projectId, payload })
    const body: unknown = await res.json().catch((err: unknown) => {
      console.error('[code-study-client] write-back answer was not JSON', { status: res.status, err })
      return null
    })
    if (isRecord(body) && body.ok === true) return { ok: true, ...(typeof body.note === 'string' ? { note: body.note } : {}) }
    if (isRecord(body) && body.ok === false && typeof body.reason === 'string') return { ok: false, reason: body.reason }
    const reason = isRecord(body) && typeof body.error === 'string' ? body.error : `The server answered HTTP ${res.status}.`
    console.error('[code-study-client] write-back failed', { projectId, action: payload.action, reason })
    return { ok: false, reason }
  } catch (err) {
    console.error('[code-study-client] write-back request failed', { projectId, action: payload.action, err })
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** The host's write-back to PermitZIP's code study from the browser (lane K's checklist and the Inspector use it). */
export function createBrowserCodeStudyWriteBackFrom(port: CodeStudyPort, projectId: string): Required<RequirementsSourceWriteBack> {
  return {
    recordDetermination: (input) =>
      post(port, projectId, {
        action: 'record_determination',
        model_id: input.modelId,
        model_revision: input.modelRevision,
        record: { id: input.record.id, determination: input.record.determination },
      }),
    overrideRequirement: (input) =>
      post(port, projectId, {
        action: 'offer_override',
        model_id: input.modelId,
        model_revision: input.modelRevision,
        requirement_id: input.requirementId,
        ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
        anchor_id: input.anchorId,
        value: input.value,
        ...(input.unit ? { unit: input.unit } : {}),
        reason: input.reason,
      }),
    verifyRule: (input) =>
      post(port, projectId, {
        action: 'verify_rule',
        rule_id: input.ruleId,
        ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
        status: input.status,
        reason: input.reason,
      }),
  }
}

export interface RequirementLinkInput {
  /** The code-study requirement id (a PermitZIP rule's `sourceRef.ref`). */
  readonly requirementId: string
  readonly modelId: string
  readonly targetKind: 'element' | 'space' | 'zone' | 'model'
  readonly targetId: string
  readonly linkKind: 'anchor' | 'fulfilment' | 'input'
}

function linkPayload(action: 'link_requirement' | 'unlink_requirement', input: RequirementLinkInput): Record<string, unknown> {
  return {
    action,
    requirement_id: input.requirementId,
    model_id: input.modelId,
    target_kind: input.targetKind,
    target_id: input.targetId,
    link_kind: input.linkKind,
  }
}

/** Link a code-study requirement to a model element, space or zone (Code Map "Show in model" reads it). */
export async function createRequirementLinkFrom(port: CodeStudyPort, projectId: string, input: RequirementLinkInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await post(port, projectId, linkPayload('link_requirement', input))
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

export async function removeRequirementLinkFrom(port: CodeStudyPort, projectId: string, input: RequirementLinkInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await post(port, projectId, linkPayload('unlink_requirement', input))
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

/** One override the model offered back, as the Code Map lists it. */
export interface OverrideOffer {
  readonly id: string
  readonly requirementId: string
  readonly modelId: string
  readonly anchorId: string | null
  readonly value: string
  readonly reason: string
  readonly modelRevision: number | null
  readonly status: string
  readonly offeredAt: string
  readonly decidedAt: string | null
  readonly decisionReason: string | null
}

function offerOf(raw: unknown): OverrideOffer | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.requirement_id !== 'string' || typeof raw.model_id !== 'string' || typeof raw.status !== 'string' || typeof raw.reason !== 'string' || typeof raw.offered_at !== 'string') return null
  const number = typeof raw.value_number === 'number' ? String(raw.value_number) : null
  const text = typeof raw.value_text === 'string' ? raw.value_text : null
  const unit = typeof raw.unit === 'string' ? raw.unit : null
  const value = [number ?? text ?? '', unit ?? ''].filter(Boolean).join(' ')
  return {
    id: raw.id,
    requirementId: raw.requirement_id,
    modelId: raw.model_id,
    anchorId: typeof raw.anchor_id === 'string' ? raw.anchor_id : null,
    value,
    reason: raw.reason,
    modelRevision: typeof raw.model_revision === 'number' ? raw.model_revision : null,
    status: raw.status,
    offeredAt: raw.offered_at,
    decidedAt: typeof raw.decided_at === 'string' ? raw.decided_at : null,
    decisionReason: typeof raw.decision_reason === 'string' ? raw.decision_reason : null,
  }
}

/** Overrides the model offered back on a project, newest first (open, accepted and declined). Throws with the server's reason. */
export async function fetchOverrideOffersFrom(port: CodeStudyPort, projectId: string, signal?: AbortSignal): Promise<OverrideOffer[]> {
  if (!port) throw new EditorServiceUnavailableError(CODE_STUDY)
  const res = await port.read({ projectId, part: 'offers' }, { signal })
  if (!res.ok) throw new Error(await errorOf(res))
  const body: unknown = await res.json()
  if (!isRecord(body) || !Array.isArray(body.offers)) throw new Error('The offers came back in an unexpected shape.')
  const offers = body.offers.map(offerOf)
  if (offers.some((o) => o === null)) throw new Error('An offer came back in an unexpected shape.')
  return offers.filter((o): o is OverrideOffer => o !== null)
}

/** A person with code-study edit rights accepts or declines an offer (a decline needs a reason). */
export async function decideOverrideOfferFrom(port: CodeStudyPort, projectId: string, overrideId: string, decision: 'accepted' | 'declined', reason: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await post(port, projectId, { action: 'decide_override', override_id: overrideId, decision, reason: reason.trim() || null })
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

/** Shown wherever Verify is disabled (product owner decision 3: only code-study editors verify; agents never do). */
export const VERIFY_NEEDS_RIGHTS = 'Only people with code-study edit rights on this project can verify a code requirement.'

/** Whether the person may verify code requirements on the project. Throws with the server's reason. */
export async function fetchCodeStudyRightsFrom(port: CodeStudyPort, projectId: string, signal?: AbortSignal): Promise<{ canVerify: boolean }> {
  if (!port) throw new EditorServiceUnavailableError(CODE_STUDY)
  const res = await port.read({ projectId, part: 'rights' }, { signal })
  if (!res.ok) throw new Error(await errorOf(res))
  const body: unknown = await res.json()
  if (!isRecord(body) || typeof body.canVerify !== 'boolean') throw new Error('Your code-study rights came back in an unexpected shape.')
  return { canVerify: body.canVerify }
}
