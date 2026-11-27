/**
 * The keys that walk the 3D camera (`ModelViewer3D.setWalk`), by
 * `KeyboardEvent.code`: the physical key, whatever the keyboard layout, Caps
 * Lock or Shift say. Three-free, so the Building Model surface can route the
 * keys before the 3D view exists.
 *
 * Walking is a mode the person enters and leaves, because these letters are
 * the editor's tool shortcuts the rest of the time (D routes, S splits).
 */
export type WalkKey = "forward" | "back" | "left" | "right" | "up" | "down";

const WALK_KEYS: Readonly<Record<string, WalkKey>> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  KeyE: "up",
  KeyQ: "down",
};

/** The key that starts a walk: the one that then walks forward, so holding it walks at once. */
export const WALK_START_CODE = "KeyW";

/** Which way a pressed key walks (W A S D on the ground plane, E up, Q down); null for any other key. */
export function walkKeyOf(code: string): WalkKey | null {
  return WALK_KEYS[code] ?? null;
}
