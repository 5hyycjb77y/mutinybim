'use client'

import { useEffect, useMemo, useState } from 'react'
import { disciplineLabel, requirementsOf, type Command, type ModelState, type Requirement } from '@permitzip/bim-kernel'
import { withModelStatePacks } from '@permitzip/bim-kernel/packs'
import { CoordinationPane } from '../coordination/CoordinationPane'
import type { QuestionsListProps } from '../questions/QuestionsList'
import type { SubmittalsPanelProps } from '../submittals/SubmittalsPanel'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchCodeStudyRightsFrom } from '../code-study/code-study-client'
import { ChecklistNeeds } from './ChecklistNeeds'
import { needsCount } from './checklist-model'
import { MergesWaiting } from './MergesWaiting'
import { SensitivityHeader } from './SensitivityHeader'
import { ReopenedAgainstMain } from '../branches/ReopenedAgainstMain'
import type { BranchChannel } from '../branches/useBranches'

/**
 * The Building Model's Checklist (replaces Coordination; rail › Checklist,
 * Manage › Coordination opens it too): Needs from the requirements graph,
 * Checks (the coordination findings), Questions and Submittals, one list
 * each, chosen by four chips.
 */

export interface ChecklistPaneProps {
  readonly projectId: string
  readonly modelId: string
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly actorName: string
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly onSelect: (ids: readonly string[]) => void
  readonly onClose: () => void
  readonly questions?: QuestionsListProps
  /** Submittals beside the design: a fourth chip. */
  readonly submittals?: SubmittalsPanelProps
  /** The model socket: on a branch, Re-opened against Main reads which elements differ from Main. */
  readonly branchChannel?: BranchChannel | null
}

/** The requirements on a model, or why they couldn't be read (fail loud: shown with Retry). */
export function useModelRequirements(model: ModelState, attempt: number): { readonly requirements: readonly Requirement[]; readonly problem: string | null } {
  return useMemo(() => {
    void attempt
    try {
      return { requirements: requirementsOf(model), problem: null }
    } catch (err) {
      console.error('[Checklist] reading the requirements failed', err)
      return { requirements: [], problem: err instanceof Error ? err.message : String(err) }
    }
  }, [model, attempt])
}

/** Whether the person may verify code requirements on the project; null while checking. A failed check reads as no, and is logged. */
export function useCanVerify(projectId: string): boolean | null {
  const codeStudy = useEditorHost().data.codeStudy
  const [canVerify, setCanVerify] = useState<boolean | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetchCodeStudyRightsFrom(codeStudy, projectId, controller.signal)
      .then((r) => setCanVerify(r.canVerify))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[Checklist] checking code-study rights failed; Verify stays off', err)
        setCanVerify(false)
      })
    return () => controller.abort()
  }, [codeStudy, projectId])
  return canVerify
}

export function ChecklistPane({ projectId, modelId, model, canEdit, blockedReason, actorName, submit, onSelect, onClose, questions, submittals, branchChannel = null }: ChecklistPaneProps) {
  const [attempt, setAttempt] = useState(0)
  const { requirements, problem } = useModelRequirements(model, attempt)
  const canVerify = useCanVerify(projectId)
  return (
    <CoordinationPane
      projectId={projectId}
      modelId={modelId}
      model={model}
      acceptBlocked={canEdit ? null : blockedReason}
      onSelect={onSelect}
      onClose={onClose}
      {...(questions ? { questions } : {})}
      {...(submittals ? { submittals } : {})}
      title="Checklist"
      needs={{
        count: needsCount(requirements),
        node: (
          <>
            <SensitivityHeader model={model} requirements={requirements} onSelect={onSelect} />
            <ReopenedAgainstMain channel={branchChannel} requirements={requirements} onSelect={onSelect} />
            <MergesWaiting projectId={projectId} labelOf={(d) => withModelStatePacks(model, () => disciplineLabel(d))} model={model} />
            <ChecklistNeeds
              projectId={projectId}
              modelId={modelId}
              model={model}
              requirements={requirements}
              canVerify={canVerify}
              canEdit={canEdit}
              blockedReason={blockedReason}
              actorName={actorName}
              submit={submit}
              onSelect={onSelect}
              problem={problem}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          </>
        ),
      }}
    />
  )
}
