/**
 * Picking a tool switches tools: one tool takes the clicks at a time. Review video
 * (Nov 6, 29:04): with Draw space on, Place part lit up in the ribbon
 * but the plan kept tracing a space ("Why didn't it switch me over to
 * equipment?"). The side tools (Draw space, Room from walls, the ceiling
 * tracer) and the drawing tools (dimension, text, tag…) live outside the
 * model tool, so picking one has to stop the others.
 */

/** Tools that run beside the ribbon's model tool and keep the view's clicks while they are on. */
export interface OtherToolsOn {
  /** Spaces: Draw space, Redraw, Room from walls or a separation line is waiting for clicks. */
  readonly spacesDrawing: boolean
  /** The ceiling plan's tracer is on. */
  readonly ceilingTracing: boolean
  /** The drawing's own tool (`select` when none). */
  readonly drawingTool: string
}

export type OtherTool = 'spaces' | 'ceiling' | 'drawing-tool'

/** What a model tool pick stops. Select stops nothing: Draw space itself starts from Select. */
export function stoppedByModelTool(next: string, on: OtherToolsOn): readonly OtherTool[] {
  if (next === 'select') return []
  const out: OtherTool[] = []
  if (on.spacesDrawing) out.push('spaces')
  if (on.ceilingTracing) out.push('ceiling')
  if (on.drawingTool !== 'select') out.push('drawing-tool')
  return out
}

/** A drawing tool (dimension, text, tag…) picked while a model tool is on: the model tool goes back to Select. */
export function drawingToolStopsModelTool(nextDrawingTool: string, modelTool: string): boolean {
  return nextDrawingTool !== 'select' && modelTool !== 'select'
}
