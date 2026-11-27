import { walkKeyOf, WALK_START_CODE } from '@permitzip/bim-viewer-3d/light'

/** What a key press means for walking the 3D view: start a walk, feed the camera, leave the walk, or nothing. */
export type WalkKeyAction = 'start' | 'move' | 'stop' | null

/**
 * The rule for the walk keys on the Building Model surface (the keys themselves live in the viewer, three-free).
 *
 * - Walking: W A S D, E and Q go to the camera and nowhere else, so the tool shortcuts stand back. Esc leaves the walk before it does anything else.
 * - Not walking: W starts a walk and holds forward at once. D, S and A stay the tool shortcuts (Route, Split, continue a run) until the walk is on.
 * - With Ctrl, Cmd or Alt held, a key is the browser's or the editor's (Ctrl+S saves), never the camera's.
 */
export function walkKeyAction(key: { readonly code: string; readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean }, walking: boolean): WalkKeyAction {
  const plain = !key.metaKey && !key.ctrlKey && !key.altKey
  if (!walking) return plain && key.code === WALK_START_CODE ? 'start' : null
  if (walkKeyOf(key.code)) return plain ? 'move' : null
  return plain && key.key === 'Escape' ? 'stop' : null
}

/** The live hint while the walk holds. */
export const WALKING_HINT = 'Walking: W A S D move, E and Q go up and down, drag to look around, right-button + scroll for speed. Esc stops.'
