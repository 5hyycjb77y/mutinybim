import type { DrawingItem } from "../documents";
import { currentSchemaVersion, registerSchemaStep, schemaVersionOf } from "../schema-version/registry";
import type { AnchorRef } from "./annotations";
import { rectangleLines } from "./detail-lines";

/**
 * Versioned upgrades of stored drafting. Old documents keep loading and
 * printing exactly as they were drawn; an item is upgraded the first time an
 * edit touches it, inside that edit's batch, so undo puts the old record back.
 *
 *   1 → 2  rectangle_to_joined_lines: a `rect` item becomes four joined detail
 *          lines (same style, category and detail group). Dimensions that
 *          follow a corner follow the matching line end.
 *
 * The steps live in the record schema registry (`schema-version/`) as the
 * `drawing_item` chain. Drafting records were never stamped, so each step
 * recognises its old records by shape (`detect`), and the upgrade itself
 * stays here because it rewrites several records at once.
 */

export interface DraftingMigration {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  /** Whether this stored item is from before this step. */
  readonly applies: (item: DrawingItem) => boolean;
}

export const DRAFTING_MIGRATIONS: readonly DraftingMigration[] = [{ from: 1, to: 2, name: "rectangle_to_joined_lines", applies: (i) => i.shape === "rect" && !i.deleted }];

for (const m of DRAFTING_MIGRATIONS) {
  registerSchemaStep({ kind: "drawing_item", from: m.from, to: m.to, name: m.name, feature: null, detect: (r) => r.kind === "drawing_item" && m.applies(r) });
}

export const DRAFTING_SCHEMA_VERSION = currentSchemaVersion("drawing_item");

/** The schema version an item is stored at (the lowest version whose migration still applies to it, else current). */
export function draftingVersionOf(item: DrawingItem): number {
  return schemaVersionOf(item);
}

/** One stored change of an upgrade, in views/sheets command shape. */
export type MigrationStep =
  | { readonly type: "delete_drawing_item"; readonly itemId: string }
  | { readonly type: "add_drawing_item"; readonly itemId: string; readonly ownerId: string; readonly shape: "line"; readonly points: DrawingItem["points"][number][]; readonly lineStyle?: DrawingItem["lineStyle"]; readonly category?: DrawingItem["category"]; readonly detailGroup?: string }
  | { readonly type: "update_drawing_item"; readonly itemId: string; readonly dim: NonNullable<DrawingItem["dim"]> };

export interface Upgrade {
  /** The items as they read after the upgrade (upgraded ones replaced, the rest unchanged). */
  readonly items: DrawingItem[];
  /** What to write, ahead of the edit, to store the upgrade. */
  readonly steps: MigrationStep[];
  /** Old id → the ids that replace it. */
  readonly replaced: ReadonlyMap<string, readonly string[]>;
}

/** The id of side `k` (0..3) of an upgraded rectangle. */
export const rectSideId = (rectId: string, k: number) => `${rectId}~s${k}`.slice(0, 200);

/**
 * Upgrade the named items (and only those) to the current schema. Returns a
 * reason instead when an upgrade would lose something: a dimension that
 * follows a rectangle's middle has no one line to follow.
 */
export function upgradeForEdit(items: readonly DrawingItem[], ids: ReadonlySet<string>): Upgrade | string {
  const targets = items.filter((i) => ids.has(i.id) && draftingVersionOf(i) < DRAFTING_SCHEMA_VERSION);
  if (targets.length === 0) return { items: [...items], steps: [], replaced: new Map() };
  const steps: MigrationStep[] = [];
  const replaced = new Map<string, string[]>();
  const added: DrawingItem[] = [];
  for (const rect of targets) {
    const [a, b] = rect.points;
    if (!a || !b) continue;
    const sides = rectangleLines(a, b);
    const sideIds = sides.map((_, k) => rectSideId(rect.id, k));
    replaced.set(rect.id, sideIds);
    steps.push({ type: "delete_drawing_item", itemId: rect.id });
    sides.forEach(([p, q], k) => {
      const itemId = sideIds[k] ?? rectSideId(rect.id, k);
      steps.push({ type: "add_drawing_item", itemId, ownerId: rect.ownerId, shape: "line", points: [p, q], ...(rect.lineStyle ? { lineStyle: rect.lineStyle } : {}), ...(rect.category ? { category: rect.category } : {}), ...(rect.detailGroup ? { detailGroup: rect.detailGroup } : {}) });
      const { lineStyle, category, detailGroup, closed: _c, ccw: _w, ...meta } = rect;
      added.push({ ...meta, id: itemId as DrawingItem["id"], shape: "line", points: [p, q], ...(lineStyle ? { lineStyle } : {}), ...(category ? { category } : {}), ...(detailGroup ? { detailGroup } : {}) });
    });
  }
  // Dimensions that follow a rectangle corner follow the line end on that corner.
  for (const it of items) {
    if (it.deleted || !it.dim?.refs) continue;
    let changed = false;
    const refs: Array<AnchorRef | null> = [];
    for (const r of it.dim.refs) {
      const sides = r ? replaced.get(r.elementId) : undefined;
      if (!r || !sides) {
        refs.push(r);
        continue;
      }
      if (r.anchor === "mid" || r.anchor === "center" || r.anchor === "insertion" || r.anchor === "edge_left" || r.anchor === "edge_right") {
        return "A dimension follows the middle of this rectangle, and its four sides have no one middle. Delete or redraw that dimension first.";
      }
      const corner = r.anchor === "end" ? 1 : (r.index ?? 0);
      // Corner a is side 0's start; corner b is side 1's end.
      refs.push(corner === 0 ? { elementId: sides[0] ?? r.elementId, anchor: "start" } : { elementId: sides[1] ?? r.elementId, anchor: "end" });
      changed = true;
    }
    if (changed) steps.push({ type: "update_drawing_item", itemId: it.id, dim: { ...it.dim, refs } });
  }
  const gone = new Set(replaced.keys());
  return { items: [...items.filter((i) => !gone.has(i.id)), ...added], steps, replaced };
}
