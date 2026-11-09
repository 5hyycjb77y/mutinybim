import type { z } from "zod";
import { categoryLook } from "../categories/resolve";
import type { Primitive } from "../drawing/sheet";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { ModelState, PartInstance, Vec2, ViewElement } from "../types";

/**
 * View graphics (contract 1.10.0, `kernel.view_graphics` v1).
 *
 * Plan graphics an add-on derives for a view from the model, drawn after the
 * view's parts: lines between the things a network connects, load-path
 * arrows, loop lines. The view stores each add-on's switches as an opaque
 * record under the row's `hintsKey` (`ViewProps[hintsKey]`); the kernel never
 * reads inside it. Rows draw in `order`, lowest first.
 */

export interface ViewGraphicsContext {
  readonly model: ModelState;
  readonly view: ViewElement;
  /** The parts the view drew, by id (copies of typicals included). */
  readonly shown: ReadonlyMap<string, PartInstance>;
  readonly toPaper: (p: Vec2) => Vec2;
  /** Model mm per paper mm. */
  readonly scale: number;
  /** Paper rectangle the view prints inside: lines clip to it, text must fit in it. */
  readonly window: { readonly min: Vec2; readonly max: Vec2 };
  /** Where the row pushes what it draws. */
  readonly prims: Primitive[];
}

export interface ViewGraphicsRow {
  /** `<pack>.<name>`; a first-party row keeps its bare id. */
  readonly id: string;
  /** What a person calls them ("Loop lines"). */
  readonly label: string;
  /** The `ViewProps` key the view keeps this row's switches under. Frozen once stored. */
  readonly hintsKey: string;
  /** The Visibility/Graphics category that shows, hides and halftones these graphics. Absent: always shown. */
  readonly category?: string;
  /** Draw order among rows, lowest first. */
  readonly order: number;
  /** Draw into `ctx.prims`. `hints` is the view's stored record under `hintsKey` (undefined when the view has none). */
  draw(ctx: ViewGraphicsContext, hints: unknown): void;
  /** Strict writer for the record a view stores under `hintsKey`. Absent: any object. (Round 13, additive.) */
  readonly hintsSchema?: z.ZodType<object>;
  /** Why a parsed record can't be saved on this view, in words (a view type it doesn't draw on, a peer that can't store a switch yet); null when it can. (Round 13, additive.) */
  hintsRefusal?(hints: object, viewType: ViewElement["viewType"]): string | null;
}

/**
 * The records add-ons keep on a view under their rows' `hintsKey`s, for typed
 * reads. Empty in the kernel; an add-on declares its own with a module
 * augmentation (`declare module "@permitzip/bim-kernel" { interface
 * ViewGraphicsHints { … } }`). `ViewProps` extends it.
 */
export interface ViewGraphicsHints {}

export const VIEW_GRAPHICS_POINT = defineExtensionPoint<ViewGraphicsRow>({
  id: "kernel.view_graphics",
  version: 1,
  label: "View graphics",
  idOf: (row) => row.id,
});

/** Problems with view graphics rows (pack conformance), in words. */
export function viewGraphicsRowProblems(rows: readonly ViewGraphicsRow[]): string[] {
  const out: string[] = [];
  const keys = new Map<string, string>();
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`view graphics ${row.id} has no label`);
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(row.hintsKey)) out.push(`view graphics ${row.id}: hints key "${row.hintsKey}" must be one identifier`);
    const other = keys.get(row.hintsKey);
    if (other !== undefined && other !== row.id) out.push(`view graphics ${row.id}: hints key "${row.hintsKey}" is already ${other}'s`);
    keys.set(row.hintsKey, row.id);
    if (!Number.isFinite(row.order)) out.push(`view graphics ${row.id}: order must be a finite number`);
    if (typeof row.draw !== "function") out.push(`view graphics ${row.id}: draw must be a function`);
  }
  return out;
}

/** The row that keeps its record under `hintsKey` in the set in force, or null. */
export function viewGraphicsRowByKey(hintsKey: string): ViewGraphicsRow | null {
  return viewGraphicsRows().find((r) => r.hintsKey === hintsKey) ?? null;
}

/**
 * Why a view setting the kernel doesn't name can't be saved: no row in force
 * keeps a record under that key, the row's schema refuses it, or the row
 * refuses it for this view. Null when it can.
 */
export function viewGraphicsHintsRefusal(hintsKey: string, value: unknown, viewType: ViewElement["viewType"]): string | null {
  const row = viewGraphicsRowByKey(hintsKey);
  if (!row) return `"${hintsKey}" isn't a view setting here (no add-on loaded here keeps it).`;
  if (typeof value !== "object" || value === null) return `${row.label}: the setting must be a record of switches.`;
  if (!row.hintsSchema) return row.hintsRefusal?.(value, viewType) ?? null;
  const parsed = row.hintsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.map(String).join(".")})` : "";
    return `${row.label}${where}: ${issue?.message ?? "not a valid setting"}`;
  }
  return row.hintsRefusal?.(parsed.data, viewType) ?? null;
}

/** The set in force's view graphics rows, in draw order. */
export function viewGraphicsRows(): readonly ViewGraphicsRow[] {
  const set = activePackSet();
  return set.memo("kernel.view_graphics#ordered", (s) => [...s.items(VIEW_GRAPHICS_POINT)].sort((a, b) => a.order - b.order));
}

/**
 * Draw every row in force onto the view, in order (round 12, additive): a row
 * with a category draws only when the view shows that category, and its lines
 * and text turn halftone when the view halftones it. Each row gets the view's
 * stored record under its `hintsKey`.
 */
export function drawViewGraphics(ctx: ViewGraphicsContext): void {
  // The kernel never reads inside a row's record: each is passed through as stored.
  const props = (ctx.view.props ?? {}) as Readonly<Record<string, unknown>>;
  for (const row of viewGraphicsRows()) {
    const look = row.category === undefined ? null : categoryLook(ctx.view, row.category);
    if (look && !look.visible) continue;
    const from = ctx.prims.length;
    row.draw(ctx, props[row.hintsKey]);
    if (look?.halftone !== true) continue;
    for (let i = from; i < ctx.prims.length; i++) {
      const prim = ctx.prims[i];
      if (prim && (prim.kind === "line" || prim.kind === "text")) ctx.prims[i] = { ...prim, tone: "halftone" };
    }
  }
}
