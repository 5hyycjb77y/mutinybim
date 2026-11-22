import type { CategoryLineWeights, DetailLevel } from "../documents";
import type { ClassDiscipline } from "../registry/types";

/**
 * The category override contract (KERNEL-FOUNDATION §3.12): every class is a
 * category, services and drafting add theirs, and a view overrides any of
 * them with one shape. Today's sixteen view categories are categories with
 * their existing ids, so `hiddenCategories` and `lineWeights` keep reading
 * and old views and sheets print exactly as before.
 *
 * This file is the frozen shape; additions are optional fields only.
 * Readers accept category ids they don't know (`ids.ts` grammar) and keep
 * them on save.
 */

/** A category id: a view category (`duct`, `electrical_devices`), a class id (`elec.receptacle`), `service:<id>`, `drafting:<id>`, or `firm:<slug>`. */
export type CategoryId = string;

export type CategorySource = "view" | "class" | "service" | "drafting" | "firm";

export interface CategoryDef {
  readonly id: CategoryId;
  /** What a person reads in Visibility/Graphics. */
  readonly label: string;
  readonly source: CategorySource;
  /** Subcategories name their parent; an override on the parent applies unless the child sets its own. */
  readonly parent?: CategoryId;
  readonly discipline?: ClassDiscipline;
  /** Has a plan symbol separate from its 3D body (receptacles, diffusers, fixtures). */
  readonly planSymbol?: boolean;
}

/** One category's look in one view; absent fields inherit (parent, then the view's legacy fields, then the drawing default). */
export interface CategoryOverride {
  readonly visible?: boolean;
  readonly halftone?: boolean;
  readonly lineWeights?: CategoryLineWeights;
  /** A `SystemLinePattern`. */
  readonly pattern?: string;
  /** `#rrggbb`; screen only unless the view prints in colour. */
  readonly colour?: string;
  /** Plans: draw the plan symbol (absent: on where the category has one) instead of the cut body. */
  readonly planSymbol?: boolean;
  /** Fill this category's outline so what is beneath it doesn't show through (ductwork over the stuff under it). May be unread in this release. */
  readonly maskBeneath?: boolean;
  /** 0 opaque … 1 invisible. May be unread in this release. */
  readonly transparency?: number;
  /** Override the view's detail level for this category or service (coarse = single-line schematic, medium = default double/single mix, fine = double-line). */
  readonly detailLevel?: DetailLevel;
  /** Runs narrower than this nominal width (mm) draw single-line; runs at or above draw double-line. 0 forces double-line regardless of size. */
  readonly singleLineBelowMm?: number;
}

export type CategoryOverrides = Readonly<Record<CategoryId, CategoryOverride>>;

/** The protocol feature a peer must advertise before a writer stores `categoryOverrides` on a view. */
export const CATEGORY_OVERRIDES_FEATURE = "graphics:category_overrides";

/** The protocol feature a peer must advertise before a writer stores per-category `detailLevel` / `singleLineBelowMm`, `ViewProps.showLineCodes`, or `SystemGraphics.lineCode`. */
export const VIEW_SCHEMATIC_DETAIL_FEATURE = "graphics:view_schematic_detail";

/** The protocol feature a peer must advertise before a writer stores `ViewProps.symbolScale`. */
export const VIEW_SYMBOL_SCALE_FEATURE = "graphics:symbol_scale";

/** The protocol feature a peer must advertise before a writer stores multi-vertex spline waypoints, arc flips, per-span hash-mark placement, or movable terminal arrow hints on a plan view. */
export const VIEW_LINK_ROUTING_FEATURE = "graphics:link_routing";
