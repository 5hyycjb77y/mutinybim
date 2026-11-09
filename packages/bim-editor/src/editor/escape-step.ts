/**
 * Esc always leaves a tool, matching the "Esc to stop" hint, in every view.
 * A nested state backs out one step first (a field being typed in, a drag, a
 * route with points), and the next Esc stops the tool. Review video (Nov 6,
 * 11:03, 13:01, 16:16): Esc didn't leave routing, three times. On a
 * printed plan the drawing's Route layer answered "Nothing is being routed.
 * Choose Select in the ribbon"; in 3D a focused Route field swallowed it.
 */

/** Tools, as the person names what they are doing. */
const DOING: Readonly<Record<string, string>> = {
  route: 'routing',
  place: 'placing',
  move: 'moving',
  split: 'splitting',
  measure: 'measuring',
  box: 'box selecting',
}

/** "routing", "placing"… for a model or drawing tool; a generic word for one this list doesn't name. */
export function doingWord(tool: string): string {
  return DOING[tool] ?? 'using this tool'
}

/** Menus, lists and dialogs answer their own Esc (they close); a field inside one is never ours to leave. */
const OWNS_ESCAPE = '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[data-radix-popper-content-wrapper]'

function isField(target: EventTarget | null): target is HTMLElement {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/**
 * Esc pressed while typing in a tool's own field (Route's width, Place
 * part's height): the field to leave, so the next Esc reaches the tool. Null
 * when it isn't Esc, nothing is armed, something else already handled it, or
 * the field belongs to a dialog or menu that closes on Esc by itself.
 */
export function escapeLeavesField(e: { readonly key: string; readonly target: EventTarget | null; readonly defaultPrevented: boolean }, toolActive: boolean): HTMLElement | null {
  if (e.key !== 'Escape' || e.defaultPrevented || !toolActive || !isField(e.target)) return null
  return e.target.closest(OWNS_ESCAPE) ? null : e.target
}

/** What the hint says after Esc left a field. */
export function leftFieldHint(tool: string): string {
  return `Left the field. Esc again stops ${doingWord(tool)}.`
}

export type DrawingEscapeStep = 'cancel-drag' | 'cancel-route' | 'stop-tool' | null

/**
 * Esc on a drawing (a printed plan, section or a sheet's viewport) with a
 * model tool on: back out one step, else stop the tool. Select has nothing to
 * stop, so the drawing's own Esc (clear the selection) runs.
 */
export function drawingEscapeStep(state: { readonly tool: string; readonly dragging: boolean; readonly routeInProgress: boolean }): DrawingEscapeStep {
  if (state.dragging) return 'cancel-drag'
  if (state.tool === 'route' && state.routeInProgress) return 'cancel-route'
  if (state.tool !== 'select') return 'stop-tool'
  return null
}

/** What the hint says when Esc stopped a tool. */
export function stoppedToolHint(tool: string): string {
  return `Stopped ${doingWord(tool)}. Pick a tool in the ribbon to start again.`
}
