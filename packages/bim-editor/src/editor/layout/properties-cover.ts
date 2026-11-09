/**
 * The Properties rail sits over the canvas's right side, as wide as the
 * person dragged it (a strip when collapsed). A pane that replaces the canvas
 * beside it (a schedule, a form schedule's message) stops at the rail's real
 * edge, and the rail is opaque over such a pane, so the plan underneath never
 * shows in the gap or through the rail.
 */

/** Where a pane beside the Properties rail ends on the right, px. */
export function besidePropertiesRight(propertiesOpen: boolean, propertiesWidthPx: number): number {
  return propertiesOpen ? Math.max(0, propertiesWidthPx) : 0
}

/** The rail's surface: opaque over a printed drawing or a pane, slightly see-through over the live model only. */
export function propertiesSurfaceClass(showDrawing: boolean, paneOpen: boolean): string {
  return showDrawing || paneOpen ? 'bg-background' : 'bg-background/95'
}
