import type { Selection } from './model-session'

/**
 * What Delete (or Backspace) asks to delete: the same as Modify › Delete…,
 * whatever kind of element is selected (a wall, a door, a floor, a mounting
 * plane as much as a part or a run). Both go through the confirm dialog, and
 * undo brings it back. Null when the key means nothing for this selection,
 * or a drawing tool already took it (Backspace takes a wall corner back).
 */
export type DeleteKeyTarget = { readonly kind: 'group'; readonly ids: readonly string[] } | { readonly kind: 'element'; readonly id: string }

export function deleteKeyTarget(key: string, selection: Selection | null, takenByTool = false): DeleteKeyTarget | null {
  if (takenByTool || (key !== 'Delete' && key !== 'Backspace')) return null
  if (selection?.kind === 'group') return selection.ids.length > 0 ? { kind: 'group', ids: selection.ids } : null
  if (selection?.kind === 'authored') return { kind: 'element', id: selection.element.id }
  return null
}
