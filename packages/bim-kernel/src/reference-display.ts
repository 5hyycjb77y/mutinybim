import { z } from "zod";
import { LINE_WEIGHTS, type LineWeight, type ReferenceCategoryDisplay, type ReferenceDisplay } from "./documents";
import type { ReferenceStroke, SheetReference, Tone } from "./drawing/sheet";
import type { ViewElement } from "./types";

/**
 * How a linked model draws in one view: visible, halftone (lighter
 * linework, grey in 3D), see-through in 3D, or an underlay drawn beneath the
 * view's own work. Stored per view in `props.references` (a person's working
 * 3D view is a view too); this module fills in the defaults so drawings, the
 * 3D canvas, the panels and the agent all read the same answer.
 */

export const MAX_REFERENCE_TRANSPARENCY_PCT = 90;
export const MAX_REFERENCE_CATEGORY_OVERRIDES = 64;
export const IFC_CATEGORY_PATTERN = /^IFC[A-Z0-9]{2,60}$/;
/** What a view stores for one linked model (`set_view_properties`, `create_3d_view`). */
export const referenceDisplaySchema = z
  .object({
    visible: z.boolean(),
    halftone: z.boolean(),
    transparencyPct: z.number().finite().min(0).max(MAX_REFERENCE_TRANSPARENCY_PCT).optional(),
    underlay: z.boolean().optional(),
    categories: z
      .record(z.string().regex(IFC_CATEGORY_PATTERN, "Use an IFC category such as IFCWALL."), z.object({ visible: z.boolean(), halftone: z.boolean() }).partial().strict())
      .refine((c) => Object.keys(c).length <= MAX_REFERENCE_CATEGORY_OVERRIDES, `At most ${MAX_REFERENCE_CATEGORY_OVERRIDES} category overrides per linked model.`)
      .optional(),
    cutPen: z.enum(LINE_WEIGHTS).optional(),
    beyondPen: z.enum(LINE_WEIGHTS).optional(),
  })
  .strict();

/** 3D: halftone architecture is this see-through unless the view says otherwise. */
export const DEFAULT_ARCHITECTURE_TRANSPARENCY_PCT = 30;
/** 3D: an underlay draws at least this see-through, so the view's own work always reads through it. */
export const UNDERLAY_MIN_TRANSPARENCY_PCT = 65;

/** What a linked model holds, as the link records it. Architecture recedes by default; MEP models (and any other registered discipline) stay in colour in 3D. */
export type LinkedModelDiscipline = "architecture" | "mep" | (string & {});

/** Where the linked model is being drawn: paper and drawn plans/sections, or the 3D canvas. */
export type ReferenceSurface = "drawing" | "3d";

export interface ResolvedCategoryDisplay {
  readonly visible: boolean;
  readonly halftone: boolean;
}

export interface ResolvedReferenceDisplay {
  readonly visible: boolean;
  readonly halftone: boolean;
  /** 0–90. Always 0 on a drawing surface (paper has no transparency). */
  readonly transparencyPct: number;
  readonly underlay: boolean;
  readonly categories: Readonly<Record<string, ResolvedCategoryDisplay>>;
  /** Pens the view sets for the model's cut and beyond linework; null keeps the background's own. */
  readonly cutPen: LineWeight | null;
  readonly beyondPen: LineWeight | null;
}

/** The one-click choices in the panels; "custom" is anything else (per-category overrides, a hand-set percentage). */
export const REFERENCE_DISPLAY_PRESETS = ["normal", "halftone", "transparent", "underlay", "hidden"] as const;
export type ReferenceDisplayPreset = (typeof REFERENCE_DISPLAY_PRESETS)[number];

export const REFERENCE_PRESET_LABEL: Record<ReferenceDisplayPreset | "custom", string> = {
  normal: "Normal",
  halftone: "Halftone",
  transparent: "See-through",
  underlay: "Underlay",
  hidden: "Hidden",
  custom: "Custom",
};

/** The transparency the "See-through" preset sets. */
export const SEE_THROUGH_TRANSPARENCY_PCT = 60;

/** What the view stores for a preset. Halftone leaves transparency to the default, so architecture is also slightly see-through in 3D. */
export function referencePresetDisplay(preset: ReferenceDisplayPreset): ReferenceDisplay {
  switch (preset) {
    case "normal":
      return { visible: true, halftone: false, transparencyPct: 0 };
    case "halftone":
      return { visible: true, halftone: true };
    case "transparent":
      return { visible: true, halftone: true, transparencyPct: SEE_THROUGH_TRANSPARENCY_PCT };
    case "underlay":
      return { visible: true, halftone: true, underlay: true };
    case "hidden":
      return { visible: false, halftone: true };
  }
}

/** A preset's display carrying the pens the previous display set (pens are independent of the presets). */
export function withPens(next: ReferenceDisplay, previous: ReferenceDisplay | undefined): ReferenceDisplay {
  return { ...next, ...(previous?.cutPen ? { cutPen: previous.cutPen } : {}), ...(previous?.beyondPen ? { beyondPen: previous.beyondPen } : {}) };
}

/** The preset a stored display matches, or "custom". Absent counts as the view's default (halftone). */
export function referenceDisplayPreset(display: ReferenceDisplay | undefined): ReferenceDisplayPreset | "custom" {
  if (!display) return "halftone";
  if (display.categories && Object.keys(display.categories).length > 0) return "custom";
  if (!display.visible) return "hidden";
  if (display.underlay) return display.halftone && display.transparencyPct === undefined ? "underlay" : "custom";
  if (!display.halftone) return (display.transparencyPct ?? 0) === 0 ? "normal" : "custom";
  if (display.transparencyPct === undefined) return "halftone";
  return display.transparencyPct === SEE_THROUGH_TRANSPARENCY_PCT ? "transparent" : "custom";
}

function clampPct(pct: number): number {
  return Math.min(MAX_REFERENCE_TRANSPARENCY_PCT, Math.max(0, Math.round(pct)));
}

/** Resolve a stored display (or none) for one surface. */
export function resolveReferenceDisplay(stored: ReferenceDisplay | undefined, surface: ReferenceSurface, discipline: LinkedModelDiscipline): ResolvedReferenceDisplay {
  const visible = stored?.visible ?? true;
  const underlay = stored?.underlay === true;
  // Drawings have always defaulted linked models to halftone; 3D keeps MEP models in colour unless the view asks.
  const halftone = stored ? stored.halftone || underlay : surface === "drawing" || discipline === "architecture";
  let transparencyPct = 0;
  if (surface === "3d") {
    const fallback = halftone && discipline === "architecture" ? DEFAULT_ARCHITECTURE_TRANSPARENCY_PCT : 0;
    transparencyPct = clampPct(stored?.transparencyPct ?? fallback);
    if (underlay) transparencyPct = Math.max(transparencyPct, UNDERLAY_MIN_TRANSPARENCY_PCT);
  }
  const categories: Record<string, ResolvedCategoryDisplay> = {};
  for (const [category, c] of Object.entries(stored?.categories ?? {})) {
    categories[category] = { visible: c.visible ?? true, halftone: (c.halftone ?? halftone) || underlay };
  }
  return { visible, halftone, transparencyPct, underlay, categories, cutPen: stored?.cutPen ?? null, beyondPen: stored?.beyondPen ?? null };
}

/**
 * How a linked model draws in the live canvas for a view on `surface`. The
 * canvas is a 3D renderer even when a plan's or section's live model is in
 * it, so See-through keeps its amount and an Underlay is see-through beneath
 * our work, as in 3D; resolved for paper they were opaque and looked the same
 * as Halftone (Electrical Demo 2, 10:37). A view with no setting is unchanged.
 */
export function resolveCanvasDisplay(stored: ReferenceDisplay | undefined, surface: ReferenceSurface, discipline: LinkedModelDiscipline): ResolvedReferenceDisplay {
  const resolved = resolveReferenceDisplay(stored, surface, discipline);
  if (surface === "3d") return resolved;
  const pct = clampPct(stored?.transparencyPct ?? 0);
  return { ...resolved, transparencyPct: resolved.underlay ? Math.max(pct, UNDERLAY_MIN_TRANSPARENCY_PCT) : pct };
}

/** The surface a view draws linked models on. */
export function referenceSurfaceOf(view: Pick<ViewElement, "viewType"> | null): ReferenceSurface {
  return view === null || view.viewType === "three_d" ? "3d" : "drawing";
}

/** How the linked model `referenceId` draws in `view` (null: the free model, which is 3D). */
export function referenceDisplayFor(view: ViewElement | null, referenceId: string, discipline: LinkedModelDiscipline): ResolvedReferenceDisplay {
  return resolveReferenceDisplay(view?.props?.references?.[referenceId], referenceSurfaceOf(view), discipline);
}

/** A copy of `current` with one linked model's display replaced (null clears it back to the default). */
export function withReferenceDisplay(current: Readonly<Record<string, ReferenceDisplay>> | undefined, referenceId: string, next: ReferenceDisplay | null): Record<string, ReferenceDisplay> {
  const out: Record<string, ReferenceDisplay> = { ...(current ?? {}) };
  if (next === null) delete out[referenceId];
  else out[referenceId] = next;
  return out;
}

/** One category's override merged into a stored display (null clears the override). */
export function withCategoryDisplay(display: ReferenceDisplay, category: string, next: ReferenceCategoryDisplay | null): ReferenceDisplay {
  const categories: Record<string, ReferenceCategoryDisplay> = { ...(display.categories ?? {}) };
  if (next === null) delete categories[category];
  else categories[category] = next;
  const { categories: _old, ...rest } = display;
  return Object.keys(categories).length > 0 ? { ...rest, categories } : rest;
}

const UNDERLAY_TONE: Tone = "screened";

function toned(stroke: ReferenceStroke, halftone: boolean, underlay: boolean): ReferenceStroke {
  if (underlay) return { ...stroke, tone: UNDERLAY_TONE };
  if (!halftone) return stroke;
  return { ...stroke, tone: stroke.tone === "screened" ? "screened" : "halftone" };
}

/**
 * A linked background as a view draws it on paper: dropped when hidden,
 * hidden categories removed, halftone layers screened, underlays screened
 * lighter still. Null when nothing of it draws.
 */
export function applyReferenceDisplay(ref: SheetReference, display: ResolvedReferenceDisplay): SheetReference | null {
  if (!display.visible) return null;
  const categories = display.categories;
  const hasOverrides = Object.keys(categories).length > 0;
  const layers = hasOverrides ? ref.plan.layers.filter((l) => categories[l.category]?.visible !== false) : ref.plan.layers;
  if (layers.length === 0 && ref.plan.labels.length === 0) return null;
  const base: ReferenceStroke = { pen: ref.pen, tone: ref.tone };
  const strokes: Record<string, ReferenceStroke> = {};
  for (const [key, stroke] of Object.entries(ref.strokes ?? {})) {
    const category = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
    const halftone = category ? (categories[category]?.halftone ?? display.halftone) : display.halftone;
    strokes[key] = toned(stroke, halftone, display.underlay);
  }
  // A category whose tone differs from the model's needs its own stroke for every layer kind it appears in.
  if (hasOverrides) {
    for (const layer of layers) {
      const override = categories[layer.category];
      if (!override || override.halftone === display.halftone) continue;
      const key = `${layer.kind}:${layer.category}`;
      if (strokes[key]) continue;
      strokes[key] = toned(ref.strokes?.[layer.kind] ?? base, override.halftone, display.underlay);
    }
  }
  // The view's pens for this model replace the background's on every cut or beyond layer.
  for (const [kind, pen] of [["cut", display.cutPen], ["projection", display.beyondPen]] as const) {
    if (!pen) continue;
    strokes[kind] ??= toned(ref.strokes?.[kind] ?? base, display.halftone, display.underlay);
    for (const key of Object.keys(strokes)) if (key === kind || key.startsWith(`${kind}:`)) strokes[key] = { ...(strokes[key] as ReferenceStroke), pen };
  }
  const tone: Tone = display.underlay ? UNDERLAY_TONE : display.halftone ? "halftone" : ref.tone;
  return { ...ref, tone, plan: layers === ref.plan.layers ? ref.plan : { ...ref.plan, layers }, ...(Object.keys(strokes).length > 0 ? { strokes } : {}) };
}
