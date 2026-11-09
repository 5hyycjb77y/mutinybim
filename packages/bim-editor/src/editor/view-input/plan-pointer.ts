import { modelToPaperPoint, paperToModelPoint, type Vec2, type ViewOnPaper, type ViewType } from '@permitzip/bim-kernel'

/**
 * Screen ↔ plan points for a floor or ceiling plan opened on a sheet, through
 * the sheet's paper. The plan tools (an add-on's Wall, Floor, Door…) ask the
 * host for "the plan point under the pointer" and "where this plan point is
 * on screen"; on a sheet the answer comes from here instead of the 3D viewer,
 * so they draw in the view without leaving the sheet.
 */
export interface PlanPointer {
  /** The view opened on the sheet. */
  readonly viewId: string
  /** The plan point (model mm) under a screen point; null outside the view's crop. */
  toPlan(clientX: number, clientY: number): Vec2 | null
  /** Where a plan point is on screen (client pixels); null when the sheet isn't laid out. */
  toClient(p: Vec2): { readonly x: number; readonly y: number } | null
}

/** A box on screen (a `DOMRect`'s fields). */
export interface ScreenBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const PLAN_VIEW_TYPES: ReadonlySet<ViewType> = new Set<ViewType>(['floor_plan', 'ceiling_plan'])

/** Whether plan tools take points in this kind of view. */
export function takesPlanPoints(viewType: ViewType): boolean {
  return PLAN_VIEW_TYPES.has(viewType)
}

/**
 * The pointer for a view opened on a sheet; null for a section, elevation,
 * 3D or detail view (plan tools have no plan to draw on there).
 * `paper` is the sheet's size in mm; `box` is where the sheet is on screen now (it pans and zooms).
 */
export function planPointerFor(vop: ViewOnPaper | null, paper: Vec2, box: () => ScreenBox | null): PlanPointer | null {
  if (!vop || !takesPlanPoints(vop.view.viewType)) return null
  const laidOut = (): ScreenBox | null => {
    const r = box()
    return r && r.width > 0 && r.height > 0 ? r : null
  }
  return {
    viewId: vop.view.id,
    toPlan: (clientX, clientY) => {
      const r = laidOut()
      if (!r) return null
      const p = paperToModelPoint(vop, { x: ((clientX - r.left) / r.width) * paper.x, y: ((clientY - r.top) / r.height) * paper.y })
      return p ? { x: p.x, y: p.y } : null
    },
    toClient: (p) => {
      const r = laidOut()
      if (!r) return null
      const q = modelToPaperPoint(vop, { x: p.x, y: p.y, z: 0 })
      return { x: r.left + (q.x / paper.x) * r.width, y: r.top + (q.y / paper.y) * r.height }
    },
  }
}

/**
 * Why plan tools can't take points on the open sheet now; null when they can
 * (a floor or ceiling plan is opened on it). `openedViewType`: the view
 * double-clicked open on the sheet, if any.
 */
export function planPointsOffOnSheet(sheetLabel: string, openedViewType: ViewType | null): string | null {
  if (openedViewType && takesPlanPoints(openedViewType)) return null
  if (openedViewType) return 'This tool draws in a floor or ceiling plan. Double-click outside this view, then double-click a plan on the sheet.'
  return `Double-click a floor or ceiling plan on ${sheetLabel} to draw in it, or open the plan from Views and sheets.`
}

/**
 * A key a model tool drawing on the opened plan already took (it listens in
 * capture and marks Enter, Backspace and Esc as handled): the sheet leaves it
 * alone, so Esc stops the wall instead of closing the view on the sheet.
 */
export function keyTakenByModelTool(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean {
  return e.defaultPrevented && (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Backspace')
}
