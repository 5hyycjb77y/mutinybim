import { KNOWN_MATERIAL_LAYER_FUNCTIONS, type BimElement, type MaterialLayer, type MaterialLayerSet } from "../types";
import { isCoreElement } from "./feature";
import { elementTypeValue } from "./types";

/**
 * Material layer sets (FOUNDATION-COVERAGE §2.1): a wall, slab or roof
 * build-up as ordered layers. Sets live in a catalogue (a pack's or a firm's
 * library data); elements reference one by id through a value, on the
 * element itself or on its type, so values stay scalars and one set serves
 * every wall of that type.
 */
export const MATERIAL_LAYER_SET_KEY = "material.layer_set";

export type MaterialLayerSetRead = { readonly ok: true; readonly set: MaterialLayerSet; readonly unknownFunctions: readonly string[] } | { readonly ok: false; readonly reason: string };

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stored layer set: layers checked, a layer function this release doesn't know kept and listed, other fields kept on their objects. */
export function readMaterialLayerSet(raw: unknown): MaterialLayerSetRead {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) return { ok: false, reason: "a layer set needs an id" };
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) return { ok: false, reason: `layer set ${raw.id} has no layers` };
  const layers: MaterialLayer[] = [];
  const unknownFunctions: string[] = [];
  for (const [i, l] of raw.layers.entries()) {
    if (!isRecord(l) || typeof l.materialId !== "string" || l.materialId.length === 0) return { ok: false, reason: `layer ${i + 1} of ${raw.id} names no material` };
    if (typeof l.thicknessMm !== "number" || !Number.isFinite(l.thicknessMm) || l.thicknessMm < 0) return { ok: false, reason: `layer ${i + 1} of ${raw.id} needs a thickness of 0 mm or more` };
    if (l.function !== undefined && typeof l.function !== "string") return { ok: false, reason: `layer ${i + 1} of ${raw.id} has a function that isn't text` };
    if (typeof l.function === "string" && !(KNOWN_MATERIAL_LAYER_FUNCTIONS as readonly string[]).includes(l.function)) unknownFunctions.push(l.function);
    layers.push({ ...l, materialId: l.materialId, thicknessMm: l.thicknessMm, ...(typeof l.function === "string" ? { function: l.function } : {}) });
  }
  return { ok: true, set: { ...raw, id: raw.id, layers }, unknownFunctions };
}

export function layerSetThicknessMm(set: MaterialLayerSet): number {
  let t = 0;
  for (const l of set.layers) t += l.thicknessMm;
  return t;
}

/**
 * The layer set an element uses: its own `material.layer_set` value, else its
 * type's (an element-core type, or a part type's type values), looked up in
 * `catalogue`. Null when it names none or the catalogue doesn't have it.
 */
export function layerSetOf(elements: Readonly<Record<string, BimElement>>, el: BimElement, catalogue: ReadonlyMap<string, MaterialLayerSet>): MaterialLayerSet | null {
  if (!isCoreElement(el)) return null;
  let ref = elementTypeValue(elements, el, MATERIAL_LAYER_SET_KEY);
  if (ref === undefined && el.typeId !== undefined) {
    const type = elements[el.typeId];
    if (isCoreElement(type)) ref = type.values?.[MATERIAL_LAYER_SET_KEY];
  }
  return typeof ref === "string" ? (catalogue.get(ref) ?? null) : null;
}
