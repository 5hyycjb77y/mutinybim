import { type Command, type ModelState } from '@permitzip/bim-kernel'
import { inchText, nextStackNumber, type StackView } from './stacks'
import { FIRM_STACK_BASE_DIAMETERS } from './types'

/**
 * Plumbing › Stacks: the edits the panel sends. Every one is a kernel command
 * (undoable, the same the agent tools send); nothing here decides a value the
 * kernel derives from the drawn pipe.
 */

/** Names every unnamed stack, next numbers up, in one undo step. Null when every stack has a name. */
export function nameAllStacksCommand(model: Pick<ModelState, 'elements'>, stacks: readonly StackView[], newId: (prefix: string) => string): Command | null {
  const unnamed = stacks.filter((s) => !s.record)
  if (unnamed.length === 0) return null
  const taken: string[] = []
  const entries = unnamed.map((s) => {
    const number = nextStackNumber(model.elements, taken)
    taken.push(number)
    return { stackId: newId('stack'), pipeId: s.key, number }
  })
  return { type: 'name_stacks', stacks: entries }
}

export interface StackDraft {
  readonly number: string
  readonly name: string
  readonly systemCode: string
  readonly serves: string
}

export function draftOf(s: StackView): StackDraft {
  return { number: s.number ?? '', name: s.name ?? '', systemCode: s.systemCodeTyped ? s.systemCode : '', serves: s.servesTyped ? s.servesCode : '' }
}

/**
 * What saving the panel's fields sends: `name_stacks` for a stack with no name
 * yet, `edit_stack` with only what changed for one that has. A blank code goes
 * back to the derived one. Null with a reason when there is nothing to send.
 */
export function saveStackCommand(s: StackView, draft: StackDraft, newId: (prefix: string) => string): { readonly command: Command } | { readonly refused: string } {
  const number = draft.number.trim()
  const name = draft.name.trim()
  const systemCode = draft.systemCode.trim()
  const serves = draft.serves.trim()
  if (!s.record) {
    if (!number) return { refused: 'Give the stack a number first (19).' }
    return { command: { type: 'name_stacks', stacks: [{ stackId: newId('stack'), pipeId: s.key, number, ...(name ? { name } : {}), ...(systemCode ? { systemCode } : {}), ...(serves ? { serves } : {}) }] } }
  }
  if (!number) return { refused: 'A named stack keeps a number. Use Remove name to take it off.' }
  const was = draftOf(s)
  const command: Extract<Command, { type: 'edit_stack' }> = {
    type: 'edit_stack',
    stackId: s.record.id,
    ...(number !== was.number ? { number } : {}),
    ...(name !== was.name ? { name: name || null } : {}),
    ...(systemCode !== was.systemCode ? { systemCode: systemCode || null } : {}),
    ...(serves !== was.serves ? { serves: serves || null } : {}),
  }
  if (Object.keys(command).length === 2) return { refused: 'Nothing to save: the stack already reads that way.' }
  return { command }
}

export function checksCommand(on: boolean): Command {
  return { type: 'set_stack_checks', baseClearanceDiameters: on ? FIRM_STACK_BASE_DIAMETERS : null }
}

/** "3 floors, 4\" at the base, 30 DFU". */
export function stackSummary(s: StackView): string {
  const parts = [`${s.floors.length} floor${s.floors.length === 1 ? '' : 's'}`]
  if (s.sizeIn !== null) parts.push(`${inchText(s.sizeIn)} at the base`)
  if (s.dfuAtBase !== null) parts.push(`${s.dfuAtBase} DFU`)
  return parts.join(', ')
}
