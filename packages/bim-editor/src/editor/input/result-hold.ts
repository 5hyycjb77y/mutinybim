/**
 * Keeps what an action said ("Routed.", a refusal) on screen while the pointer
 * stays where it was. The view re-runs the hover preview under a still pointer
 * when the camera or the surface under it changes; a finished route puts a new
 * run under the pointer, so without this the result was replaced in the same
 * frame by "Start on the open end of …" and never seen. Moving or pressing the
 * pointer lets the preview take over again.
 */
export interface ResultHold {
  /** The action's answer is showing; `at` is where the pointer was. */
  hold(at: { readonly x: number; readonly y: number } | null): void
  /** A still-pointer refresh at `at`: true when it may replace the hint. */
  mayRefresh(at: { readonly x: number; readonly y: number }): boolean
  /** The pointer pressed or the tool changed: previews speak again. */
  release(): void
}

export function resultHold(): ResultHold {
  let held: { x: number; y: number } | null = null
  return {
    hold(at) {
      held = at ? { x: at.x, y: at.y } : null
    },
    mayRefresh(at) {
      if (held === null) return true
      if (held.x === at.x && held.y === at.y) return false
      held = null
      return true
    },
    release() {
      held = null
    },
  }
}
