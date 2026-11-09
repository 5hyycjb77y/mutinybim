'use client'

import {
  codeLabel,
  codeOfRecordDecision,
  codesOfRecord,
  currentCodesFor,
  elementsOfKind,
  isDeterminationRecord,
  jurisdictionKey,
  projectJurisdiction,
  JURISDICTION_KEY,
  type BimElement,
  type CodeOfRecord,
  type Command,
  type JurisdictionId,
  type ModelState,
} from '@permitzip/bim-kernel'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchModelSignoffsFrom } from '../../contracts/bim/code-change/client'
import { tellSignersOfCodeChangeFrom } from '../../contracts/bim/code-change/notify'
import type { SubmitCommand } from '../views-sheets/types'
import { CodesOfRecordForm } from './CodesOfRecordForm'

/** The model-wide determination in force for a key, so a new code supersedes it instead of standing beside it. */
function inForceId(model: ModelState, key: string): string | null {
  for (const el of elementsOfKind(model.elements, 'determination' as BimElement['kind'])) {
    if (!isDeterminationRecord(el)) continue
    const d = el.determination
    if (d.status === 'recorded' && d.key === key && d.subject.kind === 'model') return el.id
  }
  return null
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

/** One decision as a record or a supersede of the one in force (one undo step either way). */
function decisionCommand(model: ModelState, key: string, decision: { readonly value: string; readonly edition?: string; readonly inputs: ReadonlyArray<{ readonly key: string; readonly value: string }>; readonly reasoning: string; readonly decidedBy: string }): Command {
  const current = inForceId(model, key)
  const body = { value: decision.value, inputs: [...decision.inputs], reasoning: decision.reasoning, decidedBy: decision.decidedBy, decidedAt: new Date().toISOString(), confidence: 'high' as const, ...(decision.edition ? { edition: decision.edition } : {}) }
  return current
    ? { type: 'supersede_determination', determinationId: current, newDeterminationId: newId('det'), ...body }
    : { type: 'record_determination', determinationId: newId('det'), subject: { kind: 'model' }, key, ...body }
}

function toldWords(olderApprovals: number, written: number): string {
  if (olderApprovals === 0) return 'Saved. No approvals relied on the old code.'
  const approvals = `${olderApprovals} approval${olderApprovals === 1 ? '' : 's'} now read “checked against an older rule”`
  return written === 0 ? `Saved. ${approvals}; their signers already heard about this change.` : `Saved. ${approvals}; ${written} ${written === 1 ? 'person was' : 'people were'} told.`
}

/**
 * Building Model › Manage › Model settings › **Codes** (round 10, C10 mount):
 * the form in a dialog. Saving a code is one model edit (it can be undone),
 * then each signer whose approvals relied on the old code hears it once.
 */
export function CodesOfRecordDialog({
  projectId,
  modelId,
  model,
  canEdit,
  actorName,
  submit,
  onClose,
}: {
  readonly projectId: string
  readonly modelId: string
  readonly model: ModelState
  readonly canEdit: boolean
  readonly actorName: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
}) {
  const codeChange = useEditorHost().data.codeChange
  const codes = codesOfRecord(model.elements)

  const saveCode = async (code: CodeOfRecord): Promise<string> => {
    const decision = codeOfRecordDecision(code)
    const refusal = submit(
      decisionCommand(model, decision.key, { ...decision, reasoning: `The project's ${code.discipline.replace(/_/g, ' ')} code of record is ${codeLabel(code)}.`, decidedBy: actorName }),
      `set the ${code.discipline.replace(/_/g, ' ')} code to ${codeLabel(code)}`,
    )
    if (refusal) throw new Error(refusal)
    const after = [...codes.filter((c) => c.discipline !== code.discipline), code]
    const log = await fetchModelSignoffsFrom(codeChange, projectId, modelId)
    const told = await tellSignersOfCodeChangeFrom(codeChange, { projectId, modelId, before: codes, after, log, current: { ...currentCodesFor(model), codesOfRecord: after } })
    const older = told.reduce((n, t) => n + t.olderApprovals, 0)
    const written = told.reduce((n, t) => n + t.written, 0)
    return toldWords(older, written)
  }

  const saveJurisdiction = async (j: JurisdictionId): Promise<void> => {
    const refusal = submit(
      decisionCommand(model, JURISDICTION_KEY, { value: jurisdictionKey(j), inputs: [], reasoning: 'Where the project is.', decidedBy: actorName }),
      'set where the project is',
    )
    if (refusal) throw new Error(refusal)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="codes-of-record-dialog">
        <DialogHeader>
          <DialogTitle>Codes</DialogTitle>
          <DialogDescription>The code the project is checked against, per discipline, and where the project is. Approvals record the code they were checked against; changing it here tells their signers once.</DialogDescription>
        </DialogHeader>
        <CodesOfRecordForm codes={codes} jurisdiction={projectJurisdiction(model.elements)} canEdit={canEdit} onSaveCode={saveCode} onSaveJurisdiction={saveJurisdiction} />
      </DialogContent>
    </Dialog>
  )
}
