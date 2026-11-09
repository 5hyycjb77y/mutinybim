import { readCode } from "../classification/registry";
import { classificationTypeOf, resolveClassification, type ResolvedClassification } from "../classification/resolve";
import { activeClassRegistry } from "../registry";
import type { BimElement } from "../types";
import { measureClassOf, type ElementMeasure } from "./measure";

/**
 * What a measured element's quantities group under: its classification code
 * when it has one (in the asked system, else its first), else its type's
 * name, else its class, else its kind. Every group has words a person reads
 * ("TEST-0100 Partitions", "1-hour wall", "Doors").
 */

type Elements = Readonly<Record<string, BimElement>>;

export type QtoGroupKind = "classification" | "type" | "class" | "kind";

export interface QtoGroup {
  /** Stable within a model: `code:<system>:<code>`, `type:<id>`, `class:<id>`, `kind:<kind>`. */
  readonly key: string;
  readonly kind: QtoGroupKind;
  /** As a person reads it ("TEST-0100", "1-hour wall", "Doors"). */
  readonly label: string;
  readonly classification?: ResolvedClassification;
  /** Set for a classification code the model's code lists don't know (named, never dropped). */
  readonly warning?: string;
}

function kindWords(kind: string): string {
  const w = kind.replace(/_/g, " ");
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}s`;
}

/** The group of one measured element. `system`: group by that code system; absent, by the element's first code. */
export function qtoGroupOf(elements: Elements, el: BimElement, system?: string): QtoGroup {
  const codes = resolveClassification(elements, el);
  const code = system === undefined ? codes[0] : codes.find((c) => c.system === system);
  if (code) {
    const read = readCode(code.system, code.code);
    return {
      key: `code:${code.system}:${code.code}`,
      kind: "classification",
      label: read.label ? `${code.code} ${read.label}` : code.code,
      classification: code,
      ...(read.warning ? { warning: read.warning } : {}),
    };
  }
  const type = classificationTypeOf(elements, el);
  if (type && type.name.trim() !== "") return { key: `type:${type.id}`, kind: "type", label: type.name.trim() };
  const cls = measureClassOf(elements, el);
  if (cls !== null) {
    const label = activeClassRegistry().getClass(cls)?.label;
    return { key: `class:${cls}`, kind: "class", label: label ?? cls };
  }
  return { key: `kind:${el.kind}`, kind: "kind", label: kindWords(el.kind) };
}

/** The stage an element is built in, by stored id (absent: none). */
export function constructionStageIdOf(el: BimElement): string | null {
  if (!("constructionStageId" in el)) return null;
  const v: unknown = el.constructionStageId;
  return typeof v === "string" && v !== "" ? v : null;
}

/** For a measured element: its group, size group and stage at once. */
export function qtoKeysOf(elements: Elements, el: BimElement, measure: ElementMeasure, system?: string): { readonly group: QtoGroup; readonly sizeGroup: string | null; readonly stageId: string | null } {
  return { group: qtoGroupOf(elements, el, system), sizeGroup: measure.sizeGroup, stageId: constructionStageIdOf(el) };
}
