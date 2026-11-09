import type { BimElement, ElementTypeElement } from "../types";
import type { ClassificationAssignment } from "../qto/types";

/**
 * An element's classification: its own codes, then its type's for every
 * system it doesn't code itself (an instance's code for a system wins over
 * its type's). Readers are tolerant: a malformed stored list is reported and
 * read as empty, an unknown system or code is kept as stored.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface ResolvedClassification extends ClassificationAssignment {
  /** Where the code came from. */
  readonly from: "instance" | "type";
}

const NONE: readonly ClassificationAssignment[] = Object.freeze([]);

function isAssignment(v: unknown): v is ClassificationAssignment {
  if (typeof v !== "object" || v === null) return false;
  const system: unknown = (v as { system?: unknown }).system;
  const code: unknown = (v as { code?: unknown }).code;
  return typeof system === "string" && system !== "" && typeof code === "string" && code !== "";
}

const warned = new WeakSet<object>();

/** The codes stored on a record (an instance or a type), read tolerantly. */
export function storedClassification(el: BimElement | undefined): readonly ClassificationAssignment[] {
  if (!el || !("classification" in el)) return NONE;
  const raw: unknown = el.classification;
  if (raw === undefined) return NONE;
  if (!Array.isArray(raw)) {
    if (!warned.has(el)) {
      warned.add(el);
      console.error("[classification] a stored classification isn't a list; read as none", { elementId: el.id });
    }
    return NONE;
  }
  const list: readonly unknown[] = raw;
  if (list.every(isAssignment)) return list;
  if (!warned.has(el)) {
    warned.add(el);
    console.error("[classification] dropped unreadable classification entries", { elementId: el.id });
  }
  return list.filter(isAssignment);
}

/** The `element_type` an element takes its type codes from, or null. */
export function classificationTypeOf(elements: Elements, el: BimElement): ElementTypeElement | null {
  if (!("typeId" in el)) return null;
  const typeId: unknown = el.typeId;
  if (typeof typeId !== "string") return null;
  const type = elements[typeId];
  return type?.kind === "element_type" ? type : null;
}

const resolvedCache = new WeakMap<BimElement, { readonly type: ElementTypeElement | null; readonly out: readonly ResolvedClassification[] }>();

/** Instance codes first, then the type's for systems the instance doesn't code. */
export function resolveClassification(elements: Elements, el: BimElement): readonly ResolvedClassification[] {
  const type = el.kind === "element_type" ? null : classificationTypeOf(elements, el);
  const hit = resolvedCache.get(el);
  if (hit && hit.type === type) return hit.out;
  const own = storedClassification(el);
  const out: ResolvedClassification[] = own.map((a) => ({ system: a.system, code: a.code, from: "instance" }));
  if (type) {
    const coded = new Set(own.map((a) => a.system));
    for (const a of storedClassification(type)) if (!coded.has(a.system)) out.push({ system: a.system, code: a.code, from: "type" });
  }
  const frozen = Object.freeze(out);
  resolvedCache.set(el, { type, out: frozen });
  return frozen;
}

/** The code an element has in one system, instance over type; null when it has none there. */
export function classificationIn(elements: Elements, el: BimElement, system: string): ResolvedClassification | null {
  return resolveClassification(elements, el).find((a) => a.system === system) ?? null;
}
