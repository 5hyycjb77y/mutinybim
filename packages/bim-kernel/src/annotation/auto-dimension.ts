import type { BatchCommand } from "../commands/batch";
import type { ViewCommand } from "../commands/views";
import type { ModelState, Vec2, ViewElement } from "../types";
import { anchorInView, type AnchorRef } from "./annotations";

/**
 * Automatic dimensions in a plan or section: `each` puts one aligned
 * dimension along every run, wall or grid line given (start to end); `chain`
 * puts one continuous string across them through each one's centreline. Every
 * dimension follows its elements. bim_auto_dimension and a script's
 * documents.autoDimension send this same edit.
 */

export interface AutoDimensionOptions {
  readonly mode: "each" | "chain";
  /** Chain only (default horizontal). */
  readonly direction?: "horizontal" | "vertical";
  /** Paper mm from the measured points. */
  readonly offsetMm: number;
  /** Prefix for new item ids (stable per call, so a retry makes the same ids). */
  readonly idPrefix: string;
}

/** The one edit that dimensions these elements, or why not, in words. */
export function autoDimensionCommand(model: Pick<ModelState, "elements">, viewId: string, view: ViewElement, elementIds: readonly string[], opts: AutoDimensionOptions): ViewCommand | BatchCommand | string {
  if (view.viewType === "detail") return "Automatic dimensions measure model elements; give a plan or a section.";
  const steps: ViewCommand[] = [];
  if (opts.mode === "each") {
    for (const id of elementIds) {
      const start: AnchorRef = { elementId: id, anchor: "start" };
      const end: AnchorRef = { elementId: id, anchor: "end" };
      const a = anchorInView(model, view, start);
      const b = anchorInView(model, view, end);
      if (!a || !b) return `Element ${id} isn't a run, wall or grid line in this view (no start and end).`;
      steps.push({ type: "add_drawing_item", itemId: `${opts.idPrefix}-${id}`.slice(0, 200), ownerId: viewId, shape: "dimension", points: [a, b], dim: { kind: "aligned", refs: [start, end], offsetMm: opts.offsetMm } });
    }
  } else {
    const direction = opts.direction ?? "horizontal";
    const refs: AnchorRef[] = elementIds.map((id) => ({ elementId: id, anchor: "mid" }));
    const points: Vec2[] = [];
    for (const ref of refs) {
      const at = anchorInView(model, view, ref);
      if (!at) return `Element ${ref.elementId} has no centreline or insertion point in this view.`;
      points.push(at);
    }
    if (points.length < 2) return "A chain needs at least two elements.";
    steps.push({ type: "add_drawing_item", itemId: `${opts.idPrefix}-chain`.slice(0, 200), ownerId: viewId, shape: "dimension", points, dim: { kind: "linear", direction, chain: "continuous", refs, offsetMm: opts.offsetMm } });
  }
  return steps.length === 1 && steps[0] ? steps[0] : { type: "batch_documents", label: `Dimension ${steps.length} element${steps.length === 1 ? "" : "s"}`, commands: steps };
}
