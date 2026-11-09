import { defineExtensionPoint } from "../packs/contract";
import type { PackRefusal } from "../packs/points";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import type { DiagramHints } from "../diagrams/definition";
import type { DiagramGraph, DiagramNode } from "../diagrams/graph";
import type { OneLineItem, OneLineOrientation } from "./one-line";

/**
 * Diagram layouts (contract 1.10.0, `kernel.diagram_layout` v1).
 *
 * A drafting view can hold a diagram an add-on draws from a stored spec (a
 * power one-line, a fire alarm riser, a site service one-line). The kernel
 * keeps the generic diagram items (`OneLineItem`: components, lines, text,
 * ovals) and the view that holds them; the add-on that owns the diagram
 * kind reads its stored spec and lays it out into those items. Stored specs
 * are never rewritten by a layout: without the add-on, the view keeps its
 * bytes and says which add-on draws it.
 */

export interface DiagramLayoutContext {
  /** The model the diagram reads live values from (equipment, ratings, calculated values). */
  readonly model: ModelState;
  readonly orientation?: OneLineOrientation;
  /** The view's own switches for this diagram (show fault current…), kept as stored. */
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface DiagramLayoutNode {
  readonly id: string;
  readonly name: string;
  readonly center: Vec2;
  readonly depth: number;
  /** The add-on's own word for what the node is. */
  readonly kind: string;
}

export interface DiagramLayoutResult {
  readonly items: readonly OneLineItem[];
  readonly extent: { readonly min: Vec2; readonly max: Vec2 };
  readonly nodes: readonly DiagramLayoutNode[];
  /** Items [start, end) each node and everything below it drew, in `items` order. */
  readonly ranges?: Readonly<Record<string, readonly [number, number]>>;
  /** Where each node's feed leaves what feeds it, so a pinned node can be joined back (round 12, additive). */
  readonly entries?: Readonly<Record<string, Vec2>>;
}

/**
 * What a live diagram's graph layout reads (contract 1.12.0, additive): the
 * graph its pack built from the model, the roots as decorated for drawing, and
 * the engineer's hints. Positions come from these alone, so the same model and
 * hints give the same drawing.
 */
export interface DiagramGraphLayoutInput {
  readonly elements: Readonly<Record<string, BimElement>>;
  readonly graph: DiagramGraph;
  readonly roots: readonly DiagramNode[];
  readonly hints: DiagramHints;
}

/** A drawn piece (a run between two stations): what a click on it selects, and every element it stands for. */
export interface DiagramPieceRef {
  /** The element a click selects. */
  readonly elementId: ElementId;
  /** Everything the drawn piece stands for: selecting any of them in the model lights it. */
  readonly elementIds: readonly ElementId[];
  readonly name: string;
}

export interface DiagramGraphLayoutResult extends DiagramLayoutResult {
  /** The drawn pieces by the node id of the items that draw them; each is its own click target. */
  readonly pieces?: Readonly<Record<string, DiagramPieceRef>>;
}

export interface DiagramLayoutRow {
  /** The stored diagram kind. Frozen once specs are stored; a first-party row keeps its bare id, another add-on's is `<pack>.<name>`. */
  readonly kind: string;
  /** What a person calls it ("One-line diagram"). */
  readonly label: string;
  /** Null when `stored` is a spec this row reads; otherwise the reason in words. Tolerant: fields it doesn't know are kept. */
  check(stored: unknown): string | null;
  /** Lay the stored spec out into generic diagram items. */
  layout(stored: unknown, ctx: DiagramLayoutContext): DiagramLayoutResult | PackRefusal;
  /**
   * Contract 1.12.0, additive: lay a live diagram view's graph out (the view
   * stores only its kind and hints). `evaluateDiagram` asks this before its
   * own layouts; absent, the kernel draws the kind with its generic one-line
   * or riser layout.
   */
  layoutGraph?(input: DiagramGraphLayoutInput): DiagramGraphLayoutResult | PackRefusal;
  /**
   * Contract 1.12.0, additive: false when the diagram draws one line across
   * services (a heater's outlet continuing another system), so the kernel
   * draws only the engineer's own section boxes. Absent: a dashed box goes
   * round each service that differs from what feeds it.
   */
  readonly serviceSections?: boolean;
}

export const DIAGRAM_LAYOUT_POINT = defineExtensionPoint<DiagramLayoutRow>({
  id: "kernel.diagram_layout",
  version: 1,
  label: "Diagram layouts",
  idOf: (row) => row.kind,
  // Stored diagram kinds are bare (`one_line`); a pack's own is checked below.
  namespaced: false,
});

const KIND_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

/** Problems with diagram layout rows (pack conformance), in words. */
export function diagramLayoutRowProblems(rows: readonly DiagramLayoutRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!KIND_ID.test(row.kind)) out.push(`diagram kind "${row.kind}" must be lower case words with underscores (a pack's own: <pack>.<name>)`);
    if (seen.has(row.kind)) out.push(`diagram kind ${row.kind} is registered twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`diagram kind ${row.kind} has no label`);
    if (typeof row.check !== "function") out.push(`diagram kind ${row.kind}: check must be a function`);
    if (typeof row.layout !== "function") out.push(`diagram kind ${row.kind}: layout must be a function`);
    if (row.layoutGraph !== undefined && typeof row.layoutGraph !== "function") out.push(`diagram kind ${row.kind}: layoutGraph must be a function when given`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, DiagramLayoutRow> => new Map(set.items(DIAGRAM_LAYOUT_POINT).map((r) => [r.kind, r] as const));

/** The row that draws a stored diagram kind in the set in force, or null (the view keeps its spec and names the missing add-on). */
export function diagramLayoutRow(kind: string): DiagramLayoutRow | null {
  return activePackSet().memo("kernel.diagram_layout#table", tableOf).get(kind) ?? null;
}
