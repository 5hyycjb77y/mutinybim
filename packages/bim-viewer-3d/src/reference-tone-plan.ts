import type { ResolvedReferenceDisplay } from "@permitzip/bim-kernel";

/**
 * The plan half of a linked model's tone: the view's resolved display turned
 * into a tone description. Pure (no three.js), so the light entry and the
 * React hooks can read it without loading the 3D viewer; `reference-tone.ts`
 * applies it to Fragments materials.
 */

export interface ReferenceBaseTone {
  readonly halftone: boolean;
  /** 0.1–1. */
  readonly opacity: number;
  /** Off for an underlay, so it never hides the view's own work behind it. */
  readonly depthWrite: boolean;
}

/** halftone: an opaque grey overlay on a model in colour. original: the file's colours, opaque, over a toned model. */
export type ReferenceOverlay = "halftone" | "original";

export interface ReferenceToneOverride {
  readonly category: string;
  readonly visible: boolean;
  readonly overlay: ReferenceOverlay | null;
}

export interface ReferenceTone {
  readonly visible: boolean;
  /** Null leaves the file's materials alone. */
  readonly base: ReferenceBaseTone | null;
  readonly overrides: readonly ReferenceToneOverride[];
  /** Greyed or see-through: the view's own elements win picks over it. */
  readonly receded: boolean;
}

export const NORMAL_REFERENCE_TONE: ReferenceTone = { visible: true, base: null, overrides: [], receded: false };

export function referenceTone(display: ResolvedReferenceDisplay): ReferenceTone {
  const opacity = Math.max(0.1, 1 - display.transparencyPct / 100);
  const base: ReferenceBaseTone | null = display.halftone || opacity < 1 ? { halftone: display.halftone, opacity, depthWrite: !display.underlay } : null;
  const overrides = Object.entries(display.categories).map(([category, c]): ReferenceToneOverride => {
    const overlay: ReferenceOverlay | null = c.halftone === display.halftone && opacity === 1 ? null : c.halftone ? "halftone" : base ? "original" : null;
    return { category, visible: c.visible, overlay };
  });
  return { visible: display.visible, base, overrides, receded: display.halftone || display.underlay || opacity < 1 };
}

export function sameReferenceTone(a: ReferenceTone, b: ReferenceTone): boolean {
  const key = (t: ReferenceTone) =>
    `${t.visible}|${t.base ? `${t.base.halftone}:${t.base.opacity}:${t.base.depthWrite}` : "-"}|${t.overrides.map((o) => `${o.category}:${o.visible}:${o.overlay ?? "-"}`).join(",")}`;
  return key(a) === key(b);
}
