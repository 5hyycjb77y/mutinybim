import type { BoxMode, Command, RunPoint } from '@permitzip/bim-kernel'
import type { RouteSplitBridge, RunDragBridge } from './run-drag'

/**
 * What a plan, section or elevation drawing needs from the live model session
 * to edit the model: the same selection, Tab scopes, moves and refusals as the
 * 3D view, by element id. The drawing finds the id (`view-input/drawing-pick.ts`);
 * the session does everything else, so one edit is one command whichever surface
 * it came from.
 */
export interface ModelEditBridge {
  readonly canEdit: boolean
  /** Why editing is off, in the operator's words. */
  readonly blockedReason: string
  /** The model tool the ribbon has on (`select` and `box` work in drawings). */
  readonly tool: string
  /** Ids selected now (one element or a group), drawn highlighted in every drawing. */
  readonly selectedIds: readonly string[]
  /** Pre-highlight what a click would select; returns the hint (Tab widens). */
  hover(id: string | null): string | null
  /** What the pre-highlight covers now; null when nothing is hovered. */
  highlighted(): readonly string[] | null
  /** Whether a click on what is hovered now places something (a previewed room's parts), so the drawing shows the hand. */
  clickPlaces?(): boolean
  /** Tab / Shift+Tab while hovering. */
  tab(direction: 1 | -1): string | null
  select(id: string | null): void
  /** A click on empty paper, offered first to a tool that takes plan clicks (an add-on's Wall or Floor); true when it took it. */
  claimEmptyClick?(): boolean
  /** A box selection's ids, kept to the ribbon's box filter. Returns what happened, in words. */
  selectBox(ids: readonly string[], mode: BoxMode): string
  /** One move in the model. `delta.z` moves parts up or down; returns the model's refusal, or null. */
  moveBy(ids: readonly string[], delta: RunPoint): string | null
  /** Any other edit a drawing makes (a level dragged or renamed in a section), with an Undo toast. Returns the model's refusal, or null. */
  submit(command: Command, undoLabel: string): string | null
  /** Routed duct and pipe: drag a piece, an open end or an elbow, through the session's `drag_run`, as in the 3D view. */
  readonly runDrag: RunDragBridge
  /** Split and Route (from an open end, risers in sections) on the drawing, with the same commands as the 3D view. */
  readonly tools: RouteSplitBridge
  /** The status line under the ribbon. */
  hint(text: string | null): void
  /** Esc with nothing left to back out of: leave the model tool for Select, as the "Esc to stop" hint says. */
  stopTool?(): void
  /** The selected piece's "+" picked on the drawing: route on from that open end, or make the elbow a tee, as in the 3D view. */
  plus?(spot: { readonly kind: 'continue' | 'tee'; readonly elementId: string; readonly port: string; readonly face?: 'top' | 'bottom' }): void
  /** What the model server takes, so a "+" it would refuse isn't drawn. */
  readonly serverFeatures?: readonly string[]
}
