import {
  CheckingContextIndex,
  codeChangeCarry,
  codeChangeKey,
  codeOfRecordChanges,
  readCheckingContext,
  type CodeOfRecord,
  type CodeOfRecordChange,
  type CurrentCodes,
} from "@permitzip/bim-kernel"
import type { ModelSignoffsResponse } from "./api"
import type { EditorDataHost } from "@permitzip/bim-editor-host"
import { postCodeChangeFrom } from "./client"

export interface CodeChangeTold {
  readonly change: CodeOfRecordChange
  /** Approvals now reading "checked against an older rule". */
  readonly olderApprovals: number
  /** Notices written (0 when every signer already heard about this change, or on an undo). */
  readonly written: number
}

/**
 * After the project's code of record is saved in the model: for each
 * discipline that moved, find the approvals relying on it (the kernel's carry
 * re-checks only those, and honours "carried forward unchanged") and tell
 * their signers once. Nothing else is ever a code change: a state's adoption
 * table moving rings no bell.
 */
export async function tellSignersOfCodeChangeFrom(port: EditorDataHost["codeChange"], input: {
  readonly projectId: string
  readonly modelId: string
  readonly before: readonly CodeOfRecord[]
  readonly after: readonly CodeOfRecord[]
  readonly log: ModelSignoffsResponse
  readonly current: CurrentCodes
}): Promise<CodeChangeTold[]> {
  const changes = codeOfRecordChanges(input.before, input.after)
  if (changes.length === 0) return []
  const index = new CheckingContextIndex(input.log.records.map((r) => ({ id: r.id, signer: r.actorUserId, signerName: r.actorName, context: readCheckingContext(r.payload) })))
  const out: CodeChangeTold[] = []
  for (const change of changes) {
    const carry = codeChangeCarry(index, { instruments: [change.instrument] }, input.current)
    const recordIds = carry.older.map((o) => o.record.id)
    const { written } = await postCodeChangeFrom(port, input.projectId, {
      modelId: input.modelId,
      discipline: change.discipline,
      instrument: change.instrument,
      from: change.from ? { ...change.from } : null,
      to: change.to ? { ...change.to } : null,
      changeKey: codeChangeKey(input.modelId, change),
      recordIds,
    })
    out.push({ change, olderApprovals: recordIds.length, written })
  }
  return out
}
