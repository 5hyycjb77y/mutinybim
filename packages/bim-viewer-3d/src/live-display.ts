/**
 * How each element shows in the live model for the open view: its group and
 * phase (`displayResolver`), then the view's Visibility/Graphics switches
 * for its category line (`elementLook`), the same answer the printed
 * drawing reads. A category switched off is not drawn or picked; one set to
 * halftone draws see-through.
 */
import { displayResolver, elementLook, leftOutOfDisciplineView, planViewRangeExcludes, type BimElement, type DisplayContext, type ElementDisplay, type ModelState, type ViewElement } from "@permitzip/bim-kernel";

/** The open view, as far as its Visibility/Graphics switches go. */
export type CategoryView = Pick<ViewElement, "props">;

const SHOWN: ElementDisplay = { visible: true, halftone: false, dashed: false };
const HIDDEN: ElementDisplay = { visible: false, halftone: false, dashed: false };

/** Null when nothing narrows the live model (no open view and no display choices). */
export function liveDisplayOf(model: ModelState, ctx: DisplayContext | null, view: CategoryView | null): ((el: BimElement) => ElementDisplay) | null {
  const resolve = ctx ? displayResolver(model, ctx) : null;
  const lookView = view?.props ? view : null;
  if (!resolve && !lookView) return null;
  return (el) => {
    const d = resolve ? resolve(el) : SHOWN;
    if (!d.visible || !lookView) return d;
    const look = elementLook(model, lookView, el);
    if (!look.visible) return HIDDEN;
    return look.halftone === true && !d.halftone ? { ...d, halftone: true } : d;
  };
}

/**
 * In plan, the live model leaves out what the plan's printed drawing leaves
 * out, by the same tests: work wholly above the view's top or below its
 * bottom (`planViewRangeExcludes`), and, on a plan drawn for one discipline,
 * other disciplines' runs (`leftOutOfDisciplineView`). Null outside plan, or
 * when the view leaves nothing out.
 */
export function liveViewRangeExcludes(model: ModelState, view: CategoryView | null, planMode: boolean): ((el: BimElement) => boolean) | null {
  if (!planMode || !view?.props) return null;
  const range = planViewRangeExcludes(model, { viewType: "floor_plan", props: view.props });
  if (!view.props.discipline) return range;
  return (el) => leftOutOfDisciplineView(view, el) || (range?.(el) ?? false);
}
