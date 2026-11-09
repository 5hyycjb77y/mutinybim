import { documentIndex } from "../commands/views";
import { viewLevelNames } from "../levels";
import { recordsOfKinds } from "../store";
import { DEFAULT_PARTITION, type BimElement, type ElementId, type ModelState, type Sheet, type Vec2 } from "../types";
import type { RenderedBlock } from "../blocks/types";

/**
 * Keynotes (round 15, SH15): a short key on a drawing ("3") standing for a
 * longer note ("Provide fire damper at rated wall"), listed once per sheet.
 * One concept for every trade: any element carries its keynote as its own
 * value (`keynote`), a tag with the `keynote` field prints the key, and a
 * sheet's keynote list (a field block table of kind `keynotes`) lists only
 * the keys that appear on the views placed on it, with the words from the
 * keynote table it was given (a library `keynote_table` row, copied). Trade
 * keynote lists are library rows from add-ons or the firm, never kernel code.
 */

export const KEYNOTE_FIELD = "keynote";

export interface KeynoteRow {
  readonly key: string;
  readonly text: string;
  readonly group?: string;
}

/** A keynote table as a sheet's keynote list keeps it: the library row's id, revision and rows, copied when placed. */
export interface KeynoteTableSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly keynotes: readonly KeynoteRow[];
}

export interface KeynotesTableSpec {
  readonly kind: "keynotes";
  /** The sheet whose placed views the list reads. */
  readonly sheetId: ElementId;
  readonly table: KeynoteTableSnapshot;
}

/** The keynote an element carries ("3"), or null. */
export function keynoteOf(el: BimElement): string | null {
  const values = "values" in el ? (el.values as Readonly<Record<string, unknown>> | undefined) : undefined;
  const v = values?.[KEYNOTE_FIELD];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function anchorOf(el: BimElement): Vec2 | null {
  if ("position" in el && el.position && typeof el.position === "object" && "x" in el.position) return { x: el.position.x, y: el.position.y };
  if ("start" in el && "end" in el && el.start && el.end && typeof el.start === "object" && typeof el.end === "object" && "x" in el.start && "x" in el.end) return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
  return null;
}

/** Per model revision (the elements record): the elements that carry a keynote, found once and shared by every sheet's list. */
const carrierCache = new WeakMap<object, readonly BimElement[]>();

function keynoteCarriers(elements: ModelState["elements"]): readonly BimElement[] {
  const hit = carrierCache.get(elements);
  if (hit) return hit;
  const found = Object.values(elements).filter((el) => keynoteOf(el) !== null);
  carrierCache.set(elements, found);
  return found;
}

/** Natural order: 2 before 10, M-3 before M-12. */
export function compareKeynoteKeys(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The keys that appear on a sheet: carried by elements its placed plans and
 * sections show (on their levels, inside their crop). One per key, in natural
 * order.
 */
export function sheetKeynoteKeys(model: Pick<ModelState, "elements">, sheet: Sheet): string[] {
  const keys = new Set<string>();
  const views = (documentIndex({ elements: model.elements, connections: [] }).viewportsBySheet.get(sheet.id) ?? []).flatMap((vp) => {
    const view = model.elements[vp.viewId];
    return view?.kind === "view" && !view.deleted && (view.viewType === "floor_plan" || view.viewType === "ceiling_plan" || view.viewType === "section") ? [view] : [];
  });
  if (views.length === 0) return [];
  const carriers = keynoteCarriers(model.elements);
  for (const view of views) {
    const levels = view.viewType === "section" ? null : viewLevelNames(model, view.props?.level, view.props?.levelElevationMm);
    for (const el of carriers) {
      if (levels && !levels.has((("partition" in el ? el.partition : undefined) ?? DEFAULT_PARTITION).level)) continue;
      const at = anchorOf(el);
      if (view.viewType !== "section" && at && (at.x < view.cropMin.x || at.x > view.cropMax.x || at.y < view.cropMin.y || at.y > view.cropMax.y)) continue;
      const key = keynoteOf(el);
      if (key) keys.add(key);
    }
  }
  return [...keys].sort(compareKeynoteKeys);
}

/** The sheet's keynote list as a block's text: "KEY  words" per line, grouped as the table groups them; a key the table lacks says so. */
export function renderKeynotesTable(model: Pick<ModelState, "elements">, spec: KeynotesTableSpec): RenderedBlock {
  const sheet = model.elements[spec.sheetId];
  if (sheet?.kind !== "sheet" || sheet.deleted) return { text: "This keynote list's sheet no longer exists", unresolved: ["sheet"], dependsOn: [] };
  const keys = sheetKeynoteKeys(model, sheet);
  const byKey = new Map(spec.table.keynotes.map((k) => [k.key, k] as const));
  const missing = keys.filter((k) => !byKey.has(k));
  const lines: string[] = [];
  let group: string | undefined;
  for (const key of keys) {
    const row = byKey.get(key);
    if (row?.group && row.group !== group) {
      group = row.group;
      lines.push(row.group.toUpperCase());
    }
    lines.push(`${key}  ${row ? row.text : `(not in ${spec.table.name})`}`);
  }
  const dependsOn = [spec.sheetId, ...recordsOfKinds(model.elements, ["viewport"]).flatMap((vp) => (vp.kind === "viewport" && vp.sheetId === spec.sheetId ? [vp.id, vp.viewId] : []))];
  return { text: lines.length > 0 ? lines.join("\n") : "No keynotes on this sheet yet", unresolved: missing, dependsOn };
}
