import { loadAnchorOf, type Command, type ModelState } from '@permitzip/bim-kernel'

/** Where the attach control lives, named the same in the hint and on the pipe's properties. */
export const PIPE_LOAD_ROW_LABEL = 'Put a row from the Loads list here'

/**
 * The Loads list's "Show in model" on rows nothing draws yet (typed rows with
 * no place): instead of selecting nothing in the 3D view, say how to pipe
 * them. Null when any of the rows is drawn (then the model shows them).
 */
export function undrawnLoadHint(model: Pick<ModelState, 'elements'>, ids: readonly string[]): string | null {
  const marks: string[] = []
  for (const id of ids) {
    const el = model.elements[id]
    if (el?.kind !== 'load_point' || el.attachedPartId || loadAnchorOf(el).kind !== 'none') return null
    marks.push(el.mark || id)
  }
  if (marks.length === 0) return null
  const shown = marks.length > 3 ? `${marks.slice(0, 3).join(', ')} and ${marks.length - 3} more` : marks.join(', ')
  return `${shown} ${marks.length === 1 ? "isn't" : "aren't"} drawn yet. To pipe ${marks.length === 1 ? 'it' : 'one'}: draw the pipe with Route, select it, and pick the row under "${PIPE_LOAD_ROW_LABEL}".`
}

/** Put a load row on a pipe's open end: the existing kernel move, so the row keeps its id and the totals don't change. */
export function pipeLoadRowCommand(loadId: string, hostId: string, port: string): Command {
  return { type: 'move_load', loadId, to: { kind: 'run_end', hostId, port } }
}
