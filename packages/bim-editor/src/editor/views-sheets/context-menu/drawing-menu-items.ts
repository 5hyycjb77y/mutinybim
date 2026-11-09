import { elementsOfKind, elementViewCategory, VIEW_CATEGORY_LABELS, viewLevelElements, type BimElement, type ModelState, type ViewCategory, type ViewElement } from '@permitzip/bim-kernel'
import { similarStartFor } from '../../create-similar'

/**
 * Right-click on a printed drawing or a sheet (the product owner, C6: "Right-click also
 * isn't supported yet"). What was under the pointer decides the menu; every
 * item is an operation the model already has. Pure, so the menu is tested
 * without a canvas.
 */

/** What the right-click landed on. */
export type DrawingMenuTarget =
  | { readonly kind: 'element'; readonly elementId: string }
  | { readonly kind: 'viewport'; readonly viewportId: string; readonly view: ViewElement }
  | { readonly kind: 'paper' }

export type DrawingMenuAction = 'properties' | 'select_like' | 'hide_in_view' | 'create_similar' | 'zoom_fit' | 'open_view' | 'remove_from_sheet' | 'add_view'

export interface DrawingMenuItem {
  readonly id: DrawingMenuAction
  readonly label: string
  /** A short line under the label saying what it will do. */
  readonly hint?: string
  /** Set when the item can't run here, in the person's words; the item shows greyed with this reason. */
  readonly disabledReason?: string
  /** Asks first (taking a view off a sheet). */
  readonly confirm?: { readonly title: string; readonly description: string; readonly confirmLabel: string }
  /** Starts a new group (a separator above it). */
  readonly groupStart?: boolean
}

export interface DrawingMenu {
  readonly title: string
  readonly items: readonly DrawingMenuItem[]
}

export interface DrawingMenuContext {
  readonly model: ModelState
  /** The drawing the right-click was in (the open plan or section, or the view being edited on the sheet); null on bare sheet paper. */
  readonly view: ViewElement | null
  readonly onSheet: boolean
  readonly canEdit: boolean
  readonly blockedReason: string
  /** Model selection works in this drawing (the surface passed its edit bridge). */
  readonly canSelect: boolean
  /** The surface handles Create similar from a drawing. */
  readonly canCreateSimilar: boolean
  /** The surface can place a view on this sheet from a list. */
  readonly canAddView: boolean
}

const SELECT_UNAVAILABLE = "Selecting from this drawing isn't available here. Open the plan or section to select."
const CREATE_SIMILAR_UNAVAILABLE = "Create similar can't start from this drawing yet. Select it in the 3D view and press C then S."
const ADD_VIEW_HOW = 'Drag a view or schedule from Views and sheets onto the sheet to place it.'

function live(el: BimElement | undefined): el is BimElement {
  return el !== undefined && !('deleted' in el && el.deleted)
}

/**
 * The element a right-click acts on, from what was under the pointer (nearest
 * first). A placed part wins over whatever touches it (the short piece into
 * its connection), so the menu acts on the whole part.
 */
export function menuElementOf(model: ModelState, ids: readonly string[]): BimElement | null {
  const found = ids.map((id) => model.elements[id]).filter(live)
  return found.find((el) => el.kind === 'part') ?? found[0] ?? null
}

/** Ids drawn in this view that are like `el`: a part's same type; anything else, the same kind (and the same domain for routed pieces). */
export function likeThisIds(model: ModelState, view: ViewElement | null, el: BimElement): string[] {
  const pool: readonly BimElement[] = view ? viewLevelElements(model, view) : elementsOfKind(model.elements, el.kind)
  const domainOf = (e: BimElement): string | null => ('domain' in e && typeof e.domain === 'string' ? e.domain : null)
  return pool
    .filter(live)
    .filter((e) => (el.kind === 'part' ? e.kind === 'part' && e.typeId === el.typeId : e.kind === el.kind && domainOf(e) === domainOf(el)))
    .map((e) => e.id)
}

/** Hide in view: the element's category added to the view's hidden categories; null when it has none this view can hide. */
export function hideInViewPatch(model: ModelState, view: ViewElement, el: BimElement): { readonly category: ViewCategory; readonly label: string; readonly hiddenCategories: readonly ViewCategory[] } | null {
  const category = elementViewCategory(model.elements, el)
  if (!category) return null
  const hidden = view.props?.hiddenCategories ?? []
  return { category, label: VIEW_CATEGORY_LABELS[category], hiddenCategories: hidden.includes(category) ? hidden : [...hidden, category] }
}

/** The element in words, for the menu's title ("SD-9", a part's type name, or its category). */
export function elementTitle(model: ModelState, el: BimElement): string {
  if ('mark' in el && typeof el.mark === 'string' && el.mark) return el.mark
  if (el.kind === 'part') {
    const type = model.elements[el.typeId]
    if (type?.kind === 'part_type') return type.definition.typeName
  }
  const category = elementViewCategory(model.elements, el)
  return category ? VIEW_CATEGORY_LABELS[category] : 'Model element'
}

const ZOOM_FIT: DrawingMenuItem = { id: 'zoom_fit', label: 'Zoom to fit', hint: 'F', groupStart: true }

export function drawingMenuItems(target: DrawingMenuTarget, ctx: DrawingMenuContext): DrawingMenu {
  if (target.kind === 'viewport') {
    const schedule = target.view.viewType === 'schedule'
    return {
      title: target.view.name,
      items: [
        { id: 'open_view', label: schedule ? 'Open schedule' : 'Open view' },
        {
          id: 'remove_from_sheet',
          label: 'Remove from sheet…',
          hint: `The ${schedule ? 'schedule' : 'view'} itself stays in Views and sheets.`,
          ...(ctx.canEdit ? {} : { disabledReason: ctx.blockedReason }),
          confirm: { title: `Remove ${target.view.name} from this sheet?`, description: `The ${schedule ? 'schedule' : 'view'} stays in Views and sheets; only its place on this sheet goes. Undo brings it back.`, confirmLabel: 'Remove from sheet' },
        },
        ZOOM_FIT,
      ],
    }
  }
  if (target.kind === 'paper') {
    const items: DrawingMenuItem[] = []
    if (ctx.onSheet) items.push({ id: 'add_view', label: 'Add view…', ...(!ctx.canEdit ? { disabledReason: ctx.blockedReason } : ctx.canAddView ? {} : { disabledReason: ADD_VIEW_HOW }) })
    items.push({ ...ZOOM_FIT, groupStart: items.length > 0 })
    return { title: ctx.onSheet ? 'Sheet' : (ctx.view?.name ?? 'Drawing'), items }
  }

  const el = ctx.model.elements[target.elementId]
  if (!live(el)) return { title: 'Drawing', items: [{ ...ZOOM_FIT, groupStart: false }] }
  const like = likeThisIds(ctx.model, ctx.view, el)
  const hide = ctx.view ? hideInViewPatch(ctx.model, ctx.view, el) : null
  const similar = similarStartFor(el)
  const hideWhy = !ctx.canEdit
    ? ctx.blockedReason
    : !ctx.view
      ? 'Double-click the view on the sheet (or open it) to change what it shows.'
      : !hide
        ? "This element has no category this view can hide."
        : ctx.view.props?.hiddenCategories?.includes(hide.category)
          ? `${hide.label} is already hidden in this view.`
          : null
  const similarWhy = !ctx.canEdit ? ctx.blockedReason : similar.kind === 'refused' ? similar.reason : !ctx.canCreateSimilar ? CREATE_SIMILAR_UNAVAILABLE : null
  return {
    title: elementTitle(ctx.model, el),
    items: [
      { id: 'properties', label: 'Properties', hint: 'Selects it and shows its properties.', ...(ctx.canSelect ? {} : { disabledReason: SELECT_UNAVAILABLE }) },
      { id: 'select_like', label: 'Select all like this', hint: `${like.length} in this view`, ...(ctx.canSelect ? {} : { disabledReason: SELECT_UNAVAILABLE }) },
      { id: 'hide_in_view', label: 'Hide in view', ...(hide ? { hint: `Hides every ${hide.label} in this view.` } : {}), ...(hideWhy ? { disabledReason: hideWhy } : {}) },
      { id: 'create_similar', label: 'Create similar', hint: 'C S', ...(similarWhy ? { disabledReason: similarWhy } : {}) },
      ZOOM_FIT,
    ],
  }
}
