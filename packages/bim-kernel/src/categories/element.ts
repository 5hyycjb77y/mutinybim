import type { ViewCategory, ViewProps } from "../documents";
import type { PartCategory } from "../parts";
import { kindRowOf } from "../kinds/rows";
import { recognizes } from "../registry/recognition";
import type { ClassId, ObjectClass } from "../registry/types";
import type { BimElement, ElementKind, ModelState, ViewElement } from "../types";
import { activeCategoryRegistry, serviceCategoryId, viewCategoryOfPartCategory, type CategoryRegistry } from "./registry";
import { hasCategoryOverrides, resolveChain, type CategoryLook } from "./resolve";
import type { CategoryId } from "./types";

/**
 * Which categories an element belongs to, most specific first: its class
 * (a firm subclass before the kernel class it extends), the service its run
 * carries, then the view category it has always drawn under.
 *
 * Nothing here scans the model. A view with no per-category overrides needs
 * only the view category (one record read for a part's type); otherwise
 * each element's class is recognized once per element record and registry
 * (records are replaced on edit, so an edit re-recognizes only what changed).
 */

type Elements = ModelState["elements"];

const KIND_VIEW_CATEGORY: Readonly<Partial<Record<ElementKind, ViewCategory>>> = {
  wall: "walls",
  opening: "doors_windows",
  room: "rooms",
  grid: "grids",
  column: "structure",
  beam: "structure",
  tag: "tags",
  dimension: "dimensions",
};

/** Duct runs are duct, duct fittings duct fittings, every other run pipe (and fittings). */
export function runViewCategory(el: BimElement): "duct" | "duct_fitting" | "pipe" | null {
  if (el.kind === "run_segment") return el.domain === "duct" ? "duct" : "pipe";
  if (el.kind === "run_fitting") return el.domain === "duct" ? "duct_fitting" : "pipe";
  return null;
}

/** The view category of a placed part, by its type's category; null for anything else. */
export function partCategoryViewCategory(elements: Elements, el: BimElement): ViewCategory | null {
  if (el.kind !== "part") return null;
  const type = elements[el.typeId];
  if (type?.kind !== "part_type") return null;
  return viewCategoryOfPartCategory(type.definition.category);
}

/** The view category an element has always drawn under (runs by domain, then its kind or its add-on row, then a part's type), or null. */
export function elementViewCategory(elements: Elements, el: BimElement): ViewCategory | null {
  return runViewCategory(el) ?? KIND_VIEW_CATEGORY[el.kind] ?? kindRowOf(el.kind)?.viewCategory ?? partCategoryViewCategory(elements, el);
}

interface Recognizer {
  readonly byKind: ReadonlyMap<string, readonly ObjectClass[]>;
  readonly byPartCategory: ReadonlyMap<PartCategory, readonly ObjectClass[]>;
  readonly anyKind: readonly ObjectClass[];
  readonly depth: ReadonlyMap<ClassId, number>;
}

const recognizers = new WeakMap<CategoryRegistry, Recognizer>();

function recognizerFor(categories: CategoryRegistry): Recognizer {
  const cached = recognizers.get(categories);
  if (cached) return cached;
  const byKind = new Map<string, ObjectClass[]>();
  const byPartCategory = new Map<PartCategory, ObjectClass[]>();
  const anyKind: ObjectClass[] = [];
  const depth = new Map<ClassId, number>();
  for (const cls of categories.classes.listClasses({ includeAbstract: true })) {
    depth.set(cls.id, categories.classes.ancestors(cls.id).length);
    const rule = cls.recognize;
    if (!rule) continue;
    for (const k of rule.elementKinds ?? []) byKind.set(k, [...(byKind.get(k) ?? []), cls]);
    for (const c of rule.partCategories ?? []) byPartCategory.set(c, [...(byPartCategory.get(c) ?? []), cls]);
    if ((rule.elementKinds?.length ?? 0) === 0 && (rule.partCategories?.length ?? 0) === 0 && (rule.where?.length ?? 0) > 0) anyKind.push(cls);
  }
  const out: Recognizer = { byKind, byPartCategory, anyKind, depth };
  recognizers.set(categories, out);
  return out;
}

const classCache = new WeakMap<CategoryRegistry, WeakMap<BimElement, ClassId | null>>();

/** The most specific class that recognizes the element (deepest in the class tree; the first registered on a tie), or null. */
export function elementClass(elements: Elements, el: BimElement, categories: CategoryRegistry = activeCategoryRegistry()): ClassId | null {
  let perRegistry = classCache.get(categories);
  if (!perRegistry) {
    perRegistry = new WeakMap();
    classCache.set(categories, perRegistry);
  }
  const hit = perRegistry.get(el);
  if (hit !== undefined) return hit;
  const r = recognizerFor(categories);
  const type = el.kind === "part" ? elements[el.typeId] : undefined;
  const candidates = [...(r.byKind.get(el.kind) ?? []), ...(type?.kind === "part_type" ? (r.byPartCategory.get(type.definition.category) ?? []) : []), ...r.anyKind];
  let best: ClassId | null = null;
  let bestDepth = -1;
  for (const cls of candidates) {
    const d = r.depth.get(cls.id) ?? 0;
    if (d <= bestDepth || !recognizes(cls, el, elements)) continue;
    best = cls.id;
    bestDepth = d;
  }
  perRegistry.set(el, best);
  return best;
}

/** The service a run or system carries, by its system's kind. */
function serviceOf(elements: Elements, el: BimElement): string | null {
  if (el.kind === "mep_system") return el.systemKind;
  if (el.kind !== "run_segment" && el.kind !== "run_fitting") return null;
  const sys = elements[el.systemId];
  return sys?.kind === "mep_system" ? sys.systemKind : null;
}

/**
 * The element's categories, most specific first: its class line (firm
 * subclass, kernel class), the service it carries, then the view category
 * it has always drawn under. A service sits above the view category, so
 * "Grease waste: dashed" beats "Pipe: thin" on a grease waste pipe.
 */
export function elementCategoryChain(elements: Elements, el: BimElement, categories: CategoryRegistry = activeCategoryRegistry()): readonly CategoryId[] {
  const specific: CategoryId[] = [];
  const general: CategoryId[] = [];
  const cls = elementClass(elements, el, categories);
  if (cls !== null) for (const id of categories.lineage(cls)) (categories.get(id)?.source === "view" ? general : specific).push(id);
  const service = serviceOf(elements, el);
  if (service !== null) {
    const id = serviceCategoryId(service);
    const line = categories.lineage(id);
    specific.push(...(line.length > 0 ? line : [id]));
  }
  // The class's own view category first (a pack class's `drawsUnder`); for the kernel's classes it is the element's anyway.
  const view = elementViewCategory(elements, el);
  if (view !== null) general.push(view);
  const out: CategoryId[] = [];
  for (const id of [...specific, ...general]) if (!out.includes(id)) out.push(id);
  return out;
}

/** The symbol a class names for its instances (`symbolId`), the nearest class up the line that names one; null when none does. */
export function elementSymbolId(elements: Elements, el: BimElement, categories: CategoryRegistry = activeCategoryRegistry()): string | null {
  if (!categories.classesPlaceElements) return null;
  const cls = elementClass(elements, el, categories);
  if (cls === null) return null;
  for (const id of categories.classes.ancestors(cls)) {
    const symbolId = categories.classes.getClass(id)?.symbolId;
    if (symbolId !== undefined) return symbolId;
  }
  return null;
}

const NO_CHAIN: readonly CategoryId[] = [];
const NO_PROPS: ViewProps = Object.freeze({});

type Nested<T> = Map<string, Map<string, Map<string, T>>>;
/** Per view props, per registry: looks by (class, service, view category). No strings are built per element on a hit. */
const elementLooks = new WeakMap<ViewProps, WeakMap<CategoryRegistry, Nested<CategoryLook>>>();
/** Per view props: looks by view category alone (views with no overrides). */
const viewLooks = new WeakMap<ViewProps, Map<string, CategoryLook>>();

/**
 * How an element looks in a view. A view with no per-category overrides
 * resolves the element's view category alone (exactly the older fields);
 * one with overrides resolves the element's whole category line. Both are
 * cached per view props, so a redraw after an edit resolves only what the
 * edit changed (a replaced record is recognized again; its look is a hit).
 */
export function elementLook(model: Pick<ModelState, "elements">, view: Pick<ViewElement, "props">, el: BimElement, categories: CategoryRegistry = activeCategoryRegistry()): CategoryLook {
  const props = view.props ?? NO_PROPS;
  const view0 = elementViewCategory(model.elements, el);
  if (!hasCategoryOverrides(view) && !categories.classesPlaceElements) {
    let byView = viewLooks.get(props);
    if (!byView) {
      byView = new Map();
      viewLooks.set(props, byView);
    }
    const key = view0 ?? "";
    let look = byView.get(key);
    if (!look) {
      look = resolveChain(view, view0 === null ? NO_CHAIN : [view0]);
      byView.set(key, look);
    }
    return look;
  }
  let perRegistry = elementLooks.get(props);
  if (!perRegistry) {
    perRegistry = new WeakMap();
    elementLooks.set(props, perRegistry);
  }
  let byClass = perRegistry.get(categories);
  if (!byClass) {
    byClass = new Map();
    perRegistry.set(categories, byClass);
  }
  const cls = elementClass(model.elements, el, categories) ?? "";
  const service = serviceOf(model.elements, el) ?? "";
  let byService = byClass.get(cls);
  if (!byService) {
    byService = new Map();
    byClass.set(cls, byService);
  }
  let byView = byService.get(service);
  if (!byView) {
    byView = new Map();
    byService.set(service, byView);
  }
  const key = view0 ?? "";
  let look = byView.get(key);
  if (!look) {
    look = resolveChain(view, elementCategoryChain(model.elements, el, categories));
    byView.set(key, look);
  }
  return look;
}
