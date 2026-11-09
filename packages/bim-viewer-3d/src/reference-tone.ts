import * as THREE from "three";
import type { ReferenceBaseTone, ReferenceOverlay, ReferenceTone } from "./reference-tone-plan";

/**
 * How a linked model draws in the 3D canvas: the view's resolved display
 * (`referenceDisplayFor`) turned into a tone on the model's own materials
 * (grey, see-through) plus per-category exceptions.
 *
 * Fragments draws a highlight as extra index groups over the item's normal
 * groups, so a see-through highlight cannot reveal what is behind an opaque
 * base. The whole-model tone therefore changes the model's base materials
 * (each Fragments model has its own); exceptions and the selection are opaque
 * highlights on top, which overlays do draw correctly.
 */

/** The grey a halftone linked model draws in (lit, so walls still read as walls). */
export const HALFTONE_REFERENCE_COLOR = 0xb4bac2;
/** How far a halftone model's own colours move toward that grey. */
const HALFTONE_MIX = 0.8;
/** Marks the selection highlight's material so the tone never fades it. */
export const PICK_HIGHLIGHT_ID = "permitzip-reference-pick";

export { NORMAL_REFERENCE_TONE, referenceTone, sameReferenceTone, type ReferenceBaseTone, type ReferenceOverlay, type ReferenceTone, type ReferenceToneOverride } from "./reference-tone-plan";

/** The opaque overlay an exception draws with (Fragments material definition). */
export function overlayMaterial(overlay: ReferenceOverlay): { color: THREE.Color; renderedFaces: 0; opacity: 1; transparent: false } | null {
  return overlay === "halftone" ? { color: new THREE.Color(HALFTONE_REFERENCE_COLOR), renderedFaces: 0, opacity: 1, transparent: false } : null;
}

interface Original {
  readonly color: THREE.Color | null;
  readonly opacity: number;
  readonly transparent: boolean;
  readonly depthWrite: boolean;
}

/** What each toned material looked like before, to put back when the tone clears. */
const originals = new WeakMap<THREE.Material, Original>();

function colorOf(material: THREE.Material): THREE.Color | null {
  return "color" in material && material.color instanceof THREE.Color ? material.color : null;
}

/** Tone one Fragments base material (null puts it back as the file had it). Idempotent. */
export function toneMaterial(material: THREE.Material, tone: ReferenceBaseTone | null): void {
  if (material.userData.customId === PICK_HIGHLIGHT_ID) return;
  let original = originals.get(material);
  if (!original) {
    if (!tone) return;
    original = { color: colorOf(material)?.clone() ?? null, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
    originals.set(material, original);
  }
  const color = colorOf(material);
  if (tone) {
    if (color && original.color) {
      color.copy(original.color);
      if (tone.halftone) color.lerp(new THREE.Color(HALFTONE_REFERENCE_COLOR), HALFTONE_MIX);
    }
    material.opacity = original.opacity * tone.opacity;
    material.transparent = original.transparent || material.opacity < 1;
    material.depthWrite = tone.depthWrite && original.depthWrite;
  } else {
    if (color && original.color) color.copy(original.color);
    material.opacity = original.opacity;
    material.transparent = original.transparent;
    material.depthWrite = original.depthWrite;
    originals.delete(material);
  }
  material.needsUpdate = true;
}

/** The model's base materials: Fragments keeps them first on each mesh; highlight overlays follow. */
export function baseMaterials(root: THREE.Object3D): THREE.Material[] {
  const out = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const list: THREE.Material[] = Array.isArray(o.material) ? o.material.slice(0, 2) : [o.material];
    for (const m of list) out.add(m);
  });
  return [...out];
}

/**
 * Which hit a click selects when the view's own element and a linked model
 * are both under the pointer: the nearer one, except that a receded (halftone
 * or see-through) linked model never takes a pick from our own element, even
 * one behind it. The architect's walls are there to be seen past.
 */
export function referenceMayWinPick(tone: ReferenceTone, nativeHit: boolean): boolean {
  return !(nativeHit && tone.receded);
}
