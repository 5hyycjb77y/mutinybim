import type { CategoryLineWeights, LineWeight, ViewProps } from "../documents";
import type { ViewElement } from "../types";
import { activeCategoryRegistry, builtinCategoryRegistry, draftingCategoryOf, isViewCategory, type CategoryRegistry } from "./registry";
import type { CategoryId, CategoryOverride } from "./types";

/**
 * One resolver for how a category looks in a view (KERNEL-FOUNDATION §3.12).
 * Each field takes the first answer down this list:
 *
 *   1. the view's override for the category (`categoryOverrides`),
 *   2. the view's overrides for its parent, grandparent…,
 *   3. the view's older fields for the nearest view or drafting category on
 *      that line (`hiddenCategories`, `hiddenDraftingCategories`,
 *      `lineWeights`; the view's discipline halftone is per element, so it
 *      stays with the drawing as `halftone: null`),
 *   4. the drawing's own default.
 *
 * A view with no `categoryOverrides` therefore resolves every category to
 * exactly what its older fields said, which is how saved views and old
 * sheets keep printing byte for byte.
 */
export interface CategoryLook {
  readonly visible: boolean;
  /** true / false where an override says; null: the view's discipline decides, element by element. */
  readonly halftone: boolean | null;
  /** Pens where cut and where seen beyond; an absent pen keeps the drawing's. */
  readonly lineWeights: CategoryLineWeights;
  /** A `SystemLinePattern` an override set; null keeps the drawing's linework. */
  readonly pattern: string | null;
  /** `#rrggbb` an override set (screen); null keeps the drawing's. */
  readonly colour: string | null;
  /** Plans: true draws the plan symbol, false the body; null lets the part type decide. */
  readonly planSymbol: boolean | null;
}

/** Nothing overridden: shown, the view's discipline decides the tone, the drawing's pens. */
export const DEFAULT_LOOK: CategoryLook = Object.freeze({ visible: true, halftone: null, lineWeights: Object.freeze({}), pattern: null, colour: null, planSymbol: null });

type PropsOf = Pick<ViewElement, "props">;

/** True when the view stores any per-category override (the fast path skips class recognition when it does not). */
export function hasCategoryOverrides(view: PropsOf): boolean {
  const o = view.props?.categoryOverrides;
  if (o === undefined) return false;
  // Called once per element drawn: no allocation.
  for (const key in o) if (Object.prototype.hasOwnProperty.call(o, key)) return true;
  return false;
}

/** Per view-props object (props are replaced, never mutated), per registry revision, per chain. */
const cache = new WeakMap<ViewProps, Map<string, CategoryLook>>();
const NO_PROPS: ViewProps = Object.freeze({});

function legacyVisible(props: ViewProps, id: CategoryId): boolean | undefined {
  if (isViewCategory(id)) return props.hiddenCategories?.includes(id) ? false : undefined;
  const drafting = draftingCategoryOf(id);
  if (drafting) return props.hiddenDraftingCategories?.includes(drafting) ? false : undefined;
  return undefined;
}

function legacyWeight(props: ViewProps, id: CategoryId, kind: "cut" | "projection"): LineWeight | undefined {
  return isViewCategory(id) ? props.lineWeights?.[id]?.[kind] : undefined;
}

/** Resolve a chain of category ids, most specific first (a category and its ancestors, or an element's class line then its view category line). */
export function resolveChain(view: PropsOf, chain: readonly CategoryId[]): CategoryLook {
  const props = view.props ?? NO_PROPS;
  const overrides = props.categoryOverrides;
  const key = chain.join(">");
  let byChain = cache.get(props);
  const hit = byChain?.get(key);
  if (hit) return hit;
  let visible: boolean | undefined;
  let halftone: boolean | undefined;
  let cut: LineWeight | undefined;
  let projection: LineWeight | undefined;
  let pattern: string | undefined;
  let colour: string | undefined;
  let planSymbol: boolean | undefined;
  if (overrides) {
    for (const id of chain) {
      const o: CategoryOverride | undefined = overrides[id];
      if (!o) continue;
      visible ??= o.visible;
      halftone ??= o.halftone;
      cut ??= o.lineWeights?.cut;
      projection ??= o.lineWeights?.projection;
      pattern ??= o.pattern;
      colour ??= o.colour;
      planSymbol ??= o.planSymbol;
    }
  }
  // The older fields belong to the nearest view or drafting category on the line.
  const legacy = chain.find((id) => isViewCategory(id) || draftingCategoryOf(id) !== null);
  if (legacy !== undefined) {
    visible ??= legacyVisible(props, legacy);
    cut ??= legacyWeight(props, legacy, "cut");
    projection ??= legacyWeight(props, legacy, "projection");
  }
  const lineWeights: CategoryLineWeights = cut === undefined && projection === undefined ? DEFAULT_LOOK.lineWeights : { ...(cut ? { cut } : {}), ...(projection ? { projection } : {}) };
  const look: CategoryLook =
    visible === undefined && halftone === undefined && lineWeights === DEFAULT_LOOK.lineWeights && pattern === undefined && colour === undefined && planSymbol === undefined
      ? DEFAULT_LOOK
      : { visible: visible ?? true, halftone: halftone ?? null, lineWeights, pattern: pattern ?? null, colour: colour ?? null, planSymbol: planSymbol ?? null };
  if (!byChain) {
    byChain = new Map();
    cache.set(props, byChain);
  }
  byChain.set(key, look);
  return look;
}

/** How one category looks in one view: its override, its parents', the view's older fields, then the drawing default. */
export function categoryLook(view: PropsOf, categoryId: CategoryId, categories: CategoryRegistry = activeCategoryRegistry()): CategoryLook {
  const lineage = categories.lineage(categoryId);
  return resolveChain(view, lineage.length > 0 ? lineage : [categoryId]);
}

/**
 * Whether any of these views overrides a category the registry doesn't know
 * (a firm class): only then does a drawing need the firm library's
 * categories. Every other drawing resolves identically under the built-in ones.
 */
export function overridesOutsideRegistry(views: Iterable<PropsOf>, categories: CategoryRegistry = builtinCategoryRegistry()): boolean {
  for (const view of views) {
    const o = view.props?.categoryOverrides;
    if (!o) continue;
    for (const id in o) if (Object.prototype.hasOwnProperty.call(o, id) && categories.get(id) === undefined) return true;
  }
  return false;
}

/** The tone a look gives an element whose own discipline decides when the look says nothing. */
export function lookTone<T extends string>(look: CategoryLook, disciplineTone: T): T | "ink" | "halftone" {
  return look.halftone === null ? disciplineTone : look.halftone ? "halftone" : "ink";
}
