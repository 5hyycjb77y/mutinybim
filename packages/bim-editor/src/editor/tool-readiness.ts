/**
 * What a model tool still needs before a click in the view can do anything,
 * in the person's words, with the one-click fixes the notice offers. A tool
 * that is selected but can't act shows this at the tool and keeps showing it
 * until the cause is gone: pointer moves never clear it (fail-loud, Nielsen 1 and 9).
 * The same answer in every view: the 3D model, a live plan, a printed drawing
 * and a sheet (review video, Nov 6: routing on a printed plan with no level
 * did nothing, and "Add a level first" only showed in 3D).
 */

export type ToolFixId = 'add-first-level' | 'add-level' | 'use-architect-levels' | 'retry-now'

export interface ToolFix {
  readonly id: ToolFixId
  readonly label: string
}

export interface ToolBlocker {
  readonly id: 'no-level' | 'no-part' | 'route-size' | 'no-system' | 'read-only' | 'paused' | 'no-model-view'
  readonly title: string
  readonly message: string
  readonly fixes: readonly ToolFix[]
}

export interface ToolReadinessInput {
  readonly tool: string
  readonly canEdit: boolean
  /** Why editing is off, when it is (shown as is). */
  readonly blockedReason: string | null
  /** Why pointer edits are paused while the live connection is down (`ModelSession.editPausedReason`), or null. */
  readonly editPaused?: string | null
  readonly levelCount: number
  readonly partChosen: boolean
  /** The route panel's size problem ("Width must be a number"), or null when the size is good. */
  readonly routeSizeProblem: string | null
  readonly routeSystemKnown: boolean
  /** A sheet is open and none of its plans or sections is being worked in, so model clicks have nowhere to land. */
  readonly modelToolsOff?: boolean
  /** The sheet's number, for the no-view message. */
  readonly sheetLabel?: string | null
  /** A linked model has storeys the model could take as its levels (offers "Use the architect's levels"). */
  readonly architectLevelsAvailable?: boolean
}

/** The first level a fresh project gets with one click: at grade. */
export const FIRST_LEVEL = { name: 'Level 1', elevationMm: 0 } as const

const TOOL_WORDS: Readonly<Record<string, string>> = { place: 'place parts', route: 'route', move: 'move', split: 'split' }

export function toolBlocker(input: ToolReadinessInput): ToolBlocker | null {
  const doing = TOOL_WORDS[input.tool]
  if (!doing) return null
  if (!input.canEdit) {
    return { id: 'read-only', title: `Can't ${doing} here`, message: input.blockedReason ?? "Live editing isn't connected, so nothing can be added.", fixes: [] }
  }
  if (input.editPaused) {
    return { id: 'paused', title: `Can't ${doing} while reconnecting`, message: input.editPaused, fixes: [{ id: 'retry-now', label: 'Try now' }] }
  }
  if (input.modelToolsOff) {
    return {
      id: 'no-model-view',
      title: 'Open a plan on this sheet first',
      message: `Double-click a plan or section on ${input.sheetLabel ?? 'this sheet'} to work in it. Until then your clicks won't ${doing} anything.`,
      fixes: [],
    }
  }
  if (input.tool !== 'place' && input.tool !== 'route') return null
  if (input.levelCount === 0) {
    return {
      id: 'no-level',
      title: 'Add a level first',
      message: `${input.tool === 'place' ? 'Parts' : 'Ducts and pipes'} sit on a level, and this model has none yet. Your clicks won't add anything until it has one. A linked model's storeys don't count until you add them.`,
      fixes: [
        ...(input.architectLevelsAvailable ? [{ id: 'use-architect-levels' as const, label: "Use the architect's levels" }] : []),
        { id: 'add-first-level', label: `Add ${FIRST_LEVEL.name} at 0'-0"` },
        { id: 'add-level', label: 'Add a level…' },
      ],
    }
  }
  if (input.tool === 'place' && !input.partChosen) {
    return { id: 'no-part', title: 'Choose a part', message: 'Pick a part type on the left, then click on a floor, a roof or the model to place it.', fixes: [] }
  }
  if (input.tool === 'route' && input.routeSizeProblem) {
    return { id: 'route-size', title: 'Fix the size first', message: `${input.routeSizeProblem} Clicks won't draw until the size on the left is valid.`, fixes: [] }
  }
  if (input.tool === 'route' && !input.routeSystemKnown) {
    return { id: 'no-system', title: 'Choose a system', message: 'Pick the system this run belongs to on the left (or a new one), then click to start.', fixes: [] }
  }
  return null
}
