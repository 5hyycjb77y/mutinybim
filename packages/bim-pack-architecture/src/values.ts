import type { BimElement } from "@permitzip/bim-pack/runtime";

type Elements = Readonly<Record<string, BimElement>>;

function valuesOf(el: BimElement | undefined): Readonly<Record<string, unknown>> | null {
  if (!el || !("values" in el)) return null;
  const v: unknown = el.values;
  return typeof v === "object" && v !== null ? (v as Readonly<Record<string, unknown>>) : null;
}

/** An instance value, else its element type's. */
export function valueOf(el: BimElement, elements: Elements, key: string): unknown {
  const own = valuesOf(el)?.[key];
  if (own !== undefined) return own;
  const typeId = "typeId" in el && typeof el.typeId === "string" ? el.typeId : undefined;
  return typeId === undefined ? undefined : valuesOf(elements[typeId])?.[key];
}
