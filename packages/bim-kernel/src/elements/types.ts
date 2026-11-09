import type { BimElement, ElementTypeElement, ParamValue } from "../types";
import { isCoreElement, isValuedElement } from "./feature";

/**
 * Type values under instance values (KERNEL-FOUNDATION §3.1 TypeDef): an
 * element reads a value from itself first, then from the type it names —
 * an `element_type` (a section, a wall type) for the building and structure
 * kinds, a `part_type`'s type values for parts.
 */
type Elements = Readonly<Record<string, BimElement>>;

/** The `element_type` an element names, or null (no type, a part type, a deleted one). */
export function elementTypeOf(elements: Elements, el: BimElement): ElementTypeElement | null {
  if (!isCoreElement(el) || el.typeId === undefined) return null;
  const type = elements[el.typeId];
  return type?.kind === "element_type" ? type : null;
}

/** A value by parameter key: the element's own, else its type's. */
export function elementTypeValue(elements: Elements, el: BimElement, key: string): ParamValue | undefined {
  if (el.kind === "part") {
    const own = el.values[key];
    if (own !== undefined) return own;
    const type = elements[el.typeId];
    return type?.kind === "part_type" ? type.definition.typeValues[key] : undefined;
  }
  if (isValuedElement(el)) return el.values?.[key];
  if (!isCoreElement(el)) return undefined;
  const own = el.values?.[key];
  if (own !== undefined) return own;
  if (el.typeId === undefined) return undefined;
  const type = elements[el.typeId];
  if (type?.kind === "element_type") return type.values?.[key];
  return type?.kind === "part_type" ? type.definition.typeValues[key] : undefined;
}

/** Where one parameter's value comes from: the element's own (an override of its type), its type, or nowhere. */
export interface ElementValueSource {
  /** The value in force (`elementTypeValue`). */
  readonly value: ParamValue | undefined;
  readonly from: "instance" | "type" | null;
  /** The type's value under it, whether or not the element overrides it. */
  readonly typeValue: ParamValue | undefined;
  /** The element's own value is set and is not the type's: it differs from its type. */
  readonly overridesType: boolean;
}

/** The type's own value for a key (an `element_type`'s values, a part type's type values). */
function typeValueOf(elements: Elements, el: BimElement): (key: string) => ParamValue | undefined {
  const typeId = el.kind === "part" ? el.typeId : isCoreElement(el) ? el.typeId : undefined;
  const type = typeId === undefined ? undefined : elements[typeId];
  if (type?.kind === "element_type") return (key) => type.values?.[key];
  if (type?.kind === "part_type") return (key) => type.definition.typeValues[key];
  return () => undefined;
}

/** Any parameter, any kind: the element's own value overrides its type's; clearing the own value puts the type's back. */
export function elementValueSource(elements: Elements, el: BimElement, key: string): ElementValueSource {
  const own = el.kind === "part" ? el.values[key] : isValuedElement(el) || isCoreElement(el) ? el.values?.[key] : undefined;
  // A zone, space or system has no type: its own value is all there is.
  const typeValue = isValuedElement(el) ? undefined : typeValueOf(elements, el)(key);
  if (own !== undefined) return { value: own, from: "instance", typeValue, overridesType: typeValue === undefined || JSON.stringify(own) !== JSON.stringify(typeValue) };
  return { value: typeValue, from: typeValue === undefined ? null : "type", typeValue, overridesType: false };
}

/** The elements that name a type (what a type edit reaches). */
export function instancesOfType(elements: Elements, typeId: string): BimElement[] {
  const out: BimElement[] = [];
  for (const el of Object.values(elements)) if (isCoreElement(el) && el.typeId === typeId) out.push(el);
  return out;
}
