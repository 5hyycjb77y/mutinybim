import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ModelState } from "../types";
import { isCoreElement } from "../elements/feature";
import { elementTypeValue } from "../elements/types";
import { MATERIAL_ID_KEY, MATERIAL_POINT, type MaterialDef } from "./contract";

/** Every registered material in the active pack set. */
export function allMaterials(packSet: PackSet = activePackSet()): readonly MaterialDef[] {
  return packSet.items(MATERIAL_POINT);
}

/** Look up a material by exact id (e.g. "pack.gypsum_partition"), or case-insensitive name/alias. */
export function materialOf(ref: string | undefined | null, packSet: PackSet = activePackSet()): MaterialDef | null {
  if (!ref || typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const items = packSet.items(MATERIAL_POINT);
  const exact = items.find((m) => m.id === trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  return (
    items.find(
      (m) =>
        m.name.toLowerCase() === lower ||
        m.id.toLowerCase() === lower ||
        m.id.toLowerCase().endsWith(`.${lower.replace(/[^a-z0-9]+/g, "_")}`),
    ) ?? null
  );
}

/** Parse a #rrggbb string to a 24-bit integer color (0xRRGGBB). */
export function parseHexColor(hex: string): number | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return parseInt(hex.slice(1), 16);
}

/** Convert a material's `planCutFill` to a monochrome greyscale value in [0, 1] (0 = black, 1 = white). */
export function materialCutGrey(mat: MaterialDef | null | undefined, fallback = 0.82): number {
  if (!mat || mat.planCutFill === undefined) return fallback;
  if (typeof mat.planCutFill === "number") return Math.max(0, Math.min(1, mat.planCutFill));
  const rgb = parseHexColor(mat.planCutFill);
  if (rgb === null) return fallback;
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return Math.max(0, Math.min(1, lum));
}

/**
 * Resolve the active MaterialDef for an element:
 * 1. `el.values["material.id"]` or its element type's `values["material.id"]`
 * 2. `column.material` (e.g. "concrete", "steel")
 * 3. null when unassigned
 */
export function resolveElementMaterial(
  model: Pick<ModelState, "elements">,
  el: BimElement,
  packSet?: PackSet,
): MaterialDef | null {
  const directValues = (el as { readonly values?: Readonly<Record<string, unknown>> }).values;
  const directId = directValues?.[MATERIAL_ID_KEY];
  if (typeof directId === "string") {
    const found = materialOf(directId, packSet ?? activePackSet());
    if (found) return found;
  }
  if (isCoreElement(el) && el.typeId !== undefined) {
    let ref = elementTypeValue(model.elements, el, MATERIAL_ID_KEY);
    if (ref === undefined) {
      const type = model.elements[el.typeId];
      if (isCoreElement(type)) ref = type.values?.[MATERIAL_ID_KEY];
    }
    if (typeof ref === "string") {
      const found = materialOf(ref, packSet ?? activePackSet());
      if (found) return found;
    }
  }
  if (el.kind === "ceiling") {
    const form = (el as { readonly form?: string }).form;
    const wantGypsum = form === "soffit" || form === "cloud";
    const found = allMaterials(packSet ?? activePackSet()).find((m) => (wantGypsum ? m.category === "gypsum" : m.surfaceHatch === "grid_600x1200" || m.surfaceHatch === "grid_600"));
    if (found) return found;
  }
  if (el.kind === "column" && typeof el.material === "string") {
    const found = materialOf(el.material, packSet ?? activePackSet());
    if (found) return found;
  }
  return null;
}
