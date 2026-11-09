import { canonicalJson, elementsOfKind } from "@permitzip/bim-kernel";
import type { BimElement } from "@permitzip/bim-kernel";
import { VERTICAL_RUN_SETTINGS_ID, type NamedVerticalRun, type VerticalRunElement, type VerticalRunSettings } from "./types";

/**
 * The one seam between vertical runs and the element store. Everything else in
 * this folder reads and writes the records through these names, so the module
 * compiles and runs the same before and after "vertical_run" joins the
 * kernel's element union (`types.ts`, `registry/element-kinds.ts`, `model.ts`,
 * `network.ts`).
 * At runtime the store indexes any kind string. Same pattern as
 * questions/element.ts used before "question" was registered.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const VERTICAL_RUN_KIND = "vertical_run";

const KIND_KEY = VERTICAL_RUN_KIND as string as BimElement["kind"];

export function isVerticalRunRecord(el: { readonly kind: string } | undefined): el is VerticalRunElement {
  return el !== undefined && el.kind === VERTICAL_RUN_KIND;
}

export function isNamedVerticalRun(el: { readonly kind: string } | undefined): el is NamedVerticalRun {
  return isVerticalRunRecord(el) && el.role !== "settings";
}

const recordsCache = new WeakMap<object, NamedVerticalRun[]>();

/** Every named run in the model, from the store's kind index, once per model state. */
export function namedVerticalRuns(elements: Elements): readonly NamedVerticalRun[] {
  const hit = recordsCache.get(elements);
  if (hit) return hit;
  const out: NamedVerticalRun[] = [];
  for (const el of elementsOfKind(elements, KIND_KEY)) if (isNamedVerticalRun(el)) out.push(el);
  out.sort((a, b) => a.id.localeCompare(b.id));
  recordsCache.set(elements, out);
  return out;
}

export function verticalRunRecordAt(elements: Elements, id: string): VerticalRunElement | undefined {
  const el: { readonly kind: string } | undefined = elements[id];
  return isVerticalRunRecord(el) ? el : undefined;
}

export function verticalRunSettings(elements: Elements): VerticalRunSettings | null {
  const el = verticalRunRecordAt(elements, VERTICAL_RUN_SETTINGS_ID);
  return el?.role === "settings" ? el : null;
}

/** Write a record into a command's working copy (a record of elements accepts its own kind's values). */
export function putVerticalRun(working: Record<string, BimElement | VerticalRunElement>, r: VerticalRunElement): void {
  working[r.id] = r;
}

/** What undo and conflict checks compare (authored field "vertical_run"): everything a person set. */
export const VERTICAL_RUN_FIELD = "vertical_run";

export function verticalRunFingerprint(r: VerticalRunElement): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = r;
  return canonicalJson(rest);
}
