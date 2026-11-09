import { connectToSource, sourcesFor, type Command, type ConnectPlan, type ElementId, type ModelState, type SourceCandidate, type SourceCandidates, type SourceRefusal, type Vec2 } from '@permitzip/bim-kernel'

/**
 * The "+" grip's state, for any network (round 12 E12): a device, terminal,
 * head or detector with nothing serving it shows a "+"; dragging it lights
 * the sources that can take it and dims the rest with their reason; letting
 * go on a lit source makes one ordinary edit (the network's own "add to
 * source" command, one undo step); Esc or letting go anywhere else writes
 * nothing. Every word comes from the add-on's `sourcesFor` answer (board,
 * unit, main, loop), so this file names no trade.
 */

export type GripState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dragging'; readonly elementId: ElementId; readonly answer: SourceCandidates; readonly at: Vec2; readonly over: ElementId | null }

export const GRIP_IDLE: GripState = { kind: 'idle' }

/** What the grip says about one source while dragging: lit (it can take the end) or dimmed with the reason. */
export type GripTarget = { readonly kind: 'candidate'; readonly candidate: SourceCandidate } | { readonly kind: 'refused'; readonly refusal: SourceRefusal }

/** The grip's answer for an element, or null when it needs no source (served already, or no network asks). */
export function gripFor(model: ModelState, elementId: ElementId): SourceCandidates | null {
  return sourcesFor(model, { elementId })
}

export function gripTarget(answer: SourceCandidates, sourceId: ElementId | null): GripTarget | null {
  if (!sourceId) return null
  const candidate = answer.candidates.find((c) => c.sourceId === sourceId)
  if (candidate) return { kind: 'candidate', candidate }
  const refusal = answer.refused.find((r) => r.sourceId === sourceId)
  return refusal ? { kind: 'refused', refusal } : null
}

/** The line under the cursor while dragging: what letting go here does, in the add-on's words. */
/** What the hint line says the first time a person meets the grip: "Drag the + to a panel". */
export function gripFirstUseHint(answer: Pick<SourceCandidates, 'sourceWord'>): string {
  return `Drag the + to a ${answer.sourceWord}`
}

export function gripHint(state: GripState): string {
  if (state.kind === 'idle') return ''
  const t = gripTarget(state.answer, state.over)
  if (!t) return `Drag onto a ${state.answer.sourceWord}. Esc cancels.`
  if (t.kind === 'refused') return t.refusal.reason
  return t.candidate.note ? `Let go to connect to ${t.candidate.note}` : `Let go to connect to ${t.candidate.label}`
}

export type GripEvent =
  | { readonly type: 'press'; readonly elementId: ElementId; readonly answer: SourceCandidates; readonly at: Vec2 }
  | { readonly type: 'move'; readonly at: Vec2; readonly over: ElementId | null }
  | { readonly type: 'escape' }
  | { readonly type: 'release'; readonly over: ElementId | null }

/** A drop the host turns into the network's one edit; null when nothing is to be written. */
export interface GripDrop {
  readonly elementId: ElementId
  readonly candidate: SourceCandidate
}

/** What letting go writes: the network's own connect plan (`connect` face), refused in words when none plans it. `newId` is a fresh id for anything it creates. */
export function planGripDrop(model: ModelState, drop: GripDrop, newId: string): ConnectPlan {
  return connectToSource(model, { elementId: drop.elementId }, drop.candidate, newId)
}

/**
 * Letting go, for every surface that shows the grip (plan drawings, the live plan): the
 * network's connect plan, each command through `submit`. Returns the plain reason when
 * it was refused, else null.
 */
export function submitGripDrop(model: ModelState, drop: GripDrop, newId: string, submit: (command: Command, label: string) => string | null): string | null {
  const plan = planGripDrop(model, drop, newId)
  if (!plan.ok) return plan.reason
  for (let i = 0; i < plan.commands.length; i++) {
    const command = plan.commands[i]
    if (!command) continue
    const refused = submit(command, plan.labels[i] ?? '')
    if (refused) return refused
  }
  return null
}

/** One step of the grip. `drop` is set only when the person let go on a source that can take the end. */
export function gripStep(state: GripState, event: GripEvent): { readonly state: GripState; readonly drop: GripDrop | null } {
  switch (event.type) {
    case 'press':
      return { state: { kind: 'dragging', elementId: event.elementId, answer: event.answer, at: event.at, over: null }, drop: null }
    case 'move':
      return state.kind === 'dragging' ? { state: { ...state, at: event.at, over: event.over }, drop: null } : { state, drop: null }
    case 'escape':
      return { state: GRIP_IDLE, drop: null }
    case 'release': {
      if (state.kind !== 'dragging') return { state: GRIP_IDLE, drop: null }
      const t = gripTarget(state.answer, event.over)
      return { state: GRIP_IDLE, drop: t?.kind === 'candidate' ? { elementId: state.elementId, candidate: t.candidate } : null }
    }
  }
}
