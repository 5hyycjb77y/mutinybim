import type { RequirementsSnapshot } from '@permitzip/bim-kernel'
import type { RevisionFetch, SnapshotFetch } from './code-study-client'

/**
 * Keeps one model's PermitZIP code-study snapshot bound: bind on open, and on
 * each check rebind only when the project's code study revision moved
 * (REQUIREMENTS-GRAPH §7.3 item 7). No React here, so the change signal is
 * tested directly (p7-change-signal).
 */

export interface CodeStudyBinderDeps {
  fetchSnapshot(projectId: string): Promise<SnapshotFetch>
  fetchRevision(projectId: string): Promise<RevisionFetch>
  /** Lane G's `bindRequirementsSnapshot(modelId, snapshot)`. */
  bind(modelId: string, snapshot: RequirementsSnapshot): void
  /** Lane G's `unbindRequirementsSnapshot(modelId, ourSourceId)`: the model closed or was swapped. */
  unbind(modelId: string): void
}

export type CodeStudyBindingState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'bound'; readonly revision: number; readonly ruleCount: number }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }

export type CheckOutcome = 'unchanged' | 'rebound' | 'skipped' | 'unavailable' | 'error'

export class CodeStudyBinder {
  private modelId: string | null = null
  private boundRevision: number | null = null
  private state: CodeStudyBindingState = { status: 'idle' }
  /** Bumped on every open and on dispose, so a late answer for an old model is dropped. */
  private token = 0
  private inFlight: Promise<CheckOutcome> | null = null

  constructor(
    private readonly projectId: string,
    private readonly deps: CodeStudyBinderDeps,
    private readonly onState: (state: CodeStudyBindingState) => void,
  ) {}

  current(): CodeStudyBindingState {
    return this.state
  }

  private set(state: CodeStudyBindingState): void {
    this.state = state
    this.onState(state)
  }

  /** Fetch and bind for this model. */
  async open(modelId: string): Promise<CheckOutcome> {
    if (this.modelId !== null && this.modelId !== modelId) this.release()
    this.modelId = modelId
    this.boundRevision = null
    const token = ++this.token
    this.set({ status: 'loading' })
    const run = this.load(modelId, token)
    this.inFlight = run
    try {
      return await run
    } finally {
      if (this.inFlight === run) this.inFlight = null
    }
  }

  private async load(modelId: string, token: number): Promise<CheckOutcome> {
    const answer = await this.deps.fetchSnapshot(this.projectId)
    if (token !== this.token) return 'skipped'
    if (answer.kind === 'unavailable') {
      this.set({ status: 'unavailable', reason: answer.reason })
      return 'unavailable'
    }
    if (answer.kind === 'error') {
      this.set({ status: 'error', reason: answer.reason })
      return 'error'
    }
    try {
      this.deps.bind(modelId, answer.snapshot)
    } catch (err) {
      console.error('[code-study-binder] binding the code study to the model failed', { projectId: this.projectId, modelId, err })
      this.set({ status: 'error', reason: err instanceof Error ? err.message : String(err) })
      return 'error'
    }
    this.boundRevision = answer.revision
    this.set({ status: 'bound', revision: answer.revision, ruleCount: answer.snapshot.rules.length })
    return 'rebound'
  }

  /**
   * The focus check: read the revision and rebind only when it moved (or the
   * last bind failed). Someone without code-study access is not asked again.
   */
  async check(): Promise<CheckOutcome> {
    const modelId = this.modelId
    if (modelId === null || this.state.status === 'unavailable') return 'skipped'
    if (this.inFlight) return 'skipped'
    const token = this.token
    const run = (async (): Promise<CheckOutcome> => {
      if (this.state.status === 'error') return this.load(modelId, token)
      const answer = await this.deps.fetchRevision(this.projectId)
      if (token !== this.token) return 'skipped'
      if (answer.kind === 'unavailable') {
        this.set({ status: 'unavailable', reason: answer.reason })
        return 'unavailable'
      }
      if (answer.kind === 'error') {
        // Keep the snapshot that is bound; say the check failed.
        console.error('[code-study-binder] code study revision check failed', { projectId: this.projectId, reason: answer.reason })
        return 'error'
      }
      if (answer.revision === this.boundRevision) return 'unchanged'
      return this.load(modelId, token)
    })()
    this.inFlight = run
    try {
      return await run
    } finally {
      if (this.inFlight === run) this.inFlight = null
    }
  }

  /** Take our snapshot off the current model (only if one was bound). */
  private release(): void {
    const modelId = this.modelId
    if (modelId === null || this.boundRevision === null) return
    this.boundRevision = null
    try {
      this.deps.unbind(modelId)
    } catch (err) {
      console.error('[code-study-binder] taking the code study off the model failed', { projectId: this.projectId, modelId, err })
    }
  }

  /** The model closed: unbind ours, and drop any answer still on its way. */
  close(): void {
    this.release()
    this.token += 1
    this.modelId = null
    this.inFlight = null
  }

  dispose(): void {
    this.close()
  }
}
