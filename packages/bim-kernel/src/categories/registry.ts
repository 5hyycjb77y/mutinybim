import { DRAFTING_CATEGORIES, type DraftingCategory } from "../annotation/detailing";
import { VIEW_CATEGORIES, type ViewCategory } from "../documents";
import { activePackSet } from "../packs/scope";
import { PART_CATEGORY_CLASSES, builtinRegistry } from "../registry/builtin";
import { activeClassRegistry } from "../registry/index";
import type { ClassDiscipline, ClassId, ObjectClass, Registry } from "../registry/types";
import type { PartCategory } from "../parts";
import { activeServiceRegistry, firstPartyServiceRegistry } from "../services/registry";
import { firstPartyBaseRevision } from "../packs/set";
import type { ServiceDef } from "../services/types";
import type { CategoryDef, CategoryId, CategoryOverride } from "./types";

/**
 * The category registry (KERNEL-FOUNDATION §3.12): one list of what a view
 * can show, hide and restyle, generated from the vocabularies that already
 * exist rather than typed in again.
 *
 * - Today's sixteen view categories, with their ids (`duct`, `electrical_devices`…),
 *   so `hiddenCategories`, `hiddenLineCategories` and `lineWeights` keep reading.
 * - Every class of the class registry, the firm's library classes included:
 *   a class whose instances draw under a view category is that category's
 *   subcategory, and a subclass is its parent class's subcategory, so a firm
 *   "fire alarm device" extending `mep.electrical_device` follows
 *   Electrical devices unless a view sets it on its own.
 * - Every service as `service:<id>`, carrying its default line look.
 * - Every drafting category as `drafting:<id>`.
 *
 * A registry is frozen; build a new one when a library or the services
 * change. Its `revision` is the cache key everything resolved from it uses.
 */

/** A registered category: the frozen `CategoryDef` plus what it draws as when no view says otherwise. */
export interface RegisteredCategory extends CategoryDef {
  /** The category's own look before any view override (a service's line colour and pattern). Read by the Visibility/Graphics table as the default it shows. */
  readonly defaults?: CategoryOverride;
  /** The class it was generated from (class and firm categories). */
  readonly classId?: ClassId;
}

export interface CategoryRegistry {
  /** Changes whenever the categories do; the key for anything cached per registry. */
  readonly revision: string;
  /** The class registry the class categories came from (element recognition reads it). */
  readonly classes: Registry;
  list(): readonly RegisteredCategory[];
  get(id: CategoryId): RegisteredCategory | undefined;
  /** The category, its parent, its parent's parent… (only ids the registry knows). */
  lineage(id: CategoryId): readonly CategoryId[];
  /** The category a class's instances draw under: the class itself. */
  categoryOfClass(id: ClassId): CategoryId | undefined;
  /**
   * Some class says where its instances draw (`drawsUnder`) or what symbol
   * they draw (`symbolId`), so drawings recognize elements' classes even in
   * views with no overrides. False for the kernel's own classes.
   */
  readonly classesPlaceElements: boolean;
}

/** What a person reads for each view category (the Visibility/Graphics labels; never ids). */
export const VIEW_CATEGORY_LABELS: Readonly<Record<ViewCategory, string>> = {
  duct: "Duct",
  duct_fitting: "Duct fittings",
  pipe: "Pipe and fittings",
  air_terminal: "Air terminals",
  equipment: "Equipment",
  walls: "Walls",
  doors_windows: "Doors and windows",
  rooms: "Rooms",
  grids: "Grids",
  structure: "Structure",
  tags: "Tags",
  dimensions: "Dimensions",
  electrical_devices: "Electrical devices",
  lighting_fixtures: "Lighting fixtures",
  electrical_equipment: "Panels and electrical equipment",
  insulation: "Duct and pipe insulation",
};

const VIEW_CATEGORY_DISCIPLINE: Readonly<Partial<Record<ViewCategory, ClassDiscipline>>> = {
  duct: "mechanical",
  duct_fitting: "mechanical",
  air_terminal: "mechanical",
  insulation: "mechanical",
  pipe: "plumbing",
  walls: "architecture",
  doors_windows: "architecture",
  rooms: "architecture",
  grids: "structure",
  structure: "structure",
  electrical_devices: "electrical",
  lighting_fixtures: "electrical",
  electrical_equipment: "electrical",
};

/** View categories whose members have a plan symbol separate from their 3D body. */
const VIEW_PLAN_SYMBOL: ReadonlySet<ViewCategory> = new Set<ViewCategory>(["air_terminal", "electrical_devices", "lighting_fixtures"]);

/**
 * The view category each built-in class draws under. Classes not listed have
 * none of their own (fittings draw as duct or pipe by their domain, systems
 * and circuits are not drawn as bodies).
 */
export const CLASS_VIEW_CATEGORY: Readonly<Record<ClassId, ViewCategory>> = {
  "mep.mechanical_equipment": "equipment",
  "mep.plumbing_fixture": "equipment",
  "gen.generic_model": "equipment",
  "mep.air_terminal": "air_terminal",
  "mep.duct_accessory": "duct_fitting",
  "mep.pipe_accessory": "pipe",
  "mep.electrical_equipment": "electrical_equipment",
  "mep.electrical_device": "electrical_devices",
  "mep.lighting_fixture": "lighting_fixtures",
  "mep.duct": "duct",
  "mep.pipe": "pipe",
  "arch.wall": "walls",
  "arch.door": "doors_windows",
  "arch.window": "doors_windows",
  "arch.room": "rooms",
};

/** Plan symbols by class: plumbing fixtures draw a fixture symbol, not their body cut. */
const CLASS_PLAN_SYMBOL: ReadonlySet<ClassId> = new Set<ClassId>(["mep.plumbing_fixture"]);

/** The view category a part draws under, by its type's category (the registry's view of the old fixed map). Everything else is Equipment. */
export function viewCategoryOfPartCategory(category: PartCategory): ViewCategory {
  return CLASS_VIEW_CATEGORY[PART_CATEGORY_CLASSES[category]] ?? "equipment";
}

const DRAFTING_LABELS: Readonly<Record<DraftingCategory, string>> = {
  detail_lines: "Detail lines",
  hatching: "Hatching and fills",
  masking: "Masking regions",
  components: "Detail components",
  insulation: "Insulation (drafting)",
  text: "Text and notes",
  dimensions: "Dimensions (drafting)",
  tags: "Tags (drafting)",
  clouds: "Revision clouds",
};

export const SERVICE_CATEGORY_PREFIX = "service:";
export const DRAFTING_CATEGORY_PREFIX = "drafting:";

export const serviceCategoryId = (serviceId: string): CategoryId => `${SERVICE_CATEGORY_PREFIX}${serviceId}`;
export const draftingCategoryId = (category: DraftingCategory): CategoryId => `${DRAFTING_CATEGORY_PREFIX}${category}`;

const VIEW_CATEGORY_SET: ReadonlySet<string> = new Set<string>(VIEW_CATEGORIES);
export function isViewCategory(id: CategoryId): id is ViewCategory {
  return VIEW_CATEGORY_SET.has(id);
}

/** The drafting category a `drafting:<id>` names, or null. */
export function draftingCategoryOf(id: CategoryId): DraftingCategory | null {
  if (!id.startsWith(DRAFTING_CATEGORY_PREFIX)) return null;
  const rest = id.slice(DRAFTING_CATEGORY_PREFIX.length);
  return DRAFTING_CATEGORIES.find((c) => c === rest) ?? null;
}

/** A class's own discipline; "general" says nothing, so the view category's (if any) shows instead. */
function disciplineOf(d: ClassDiscipline | undefined): ClassDiscipline | undefined {
  return d === "general" ? undefined : d;
}
/** A class the registry should list though the class registry it was given lacks it (a firm class known only by its library summary). */
export interface ExtraClass {
  readonly id: ClassId;
  readonly label: string;
  readonly discipline?: ClassDiscipline;
  readonly parent?: ClassId;
  /** The category its instances draw under (`ObjectClass.drawsUnder`). */
  readonly drawsUnder?: CategoryId;
}

export interface CategoryRegistryInput {
  /** Absent: the kernel's built-in classes. Pass the library's registry (`registryForLibrary`) for firm classes. */
  readonly classes?: Registry;
  /** Firm classes known only by summary (Visibility/Graphics before the library registry has loaded). */
  readonly extraClasses?: readonly ExtraClass[];
  /** Service rows (`services/`); each becomes `service:<id>` with its default line look. Absent: the built-in services; pass the firm's registry rows to add theirs. */
  readonly services?: readonly ServiceDef[];
}

function isFirm(cls: Pick<ObjectClass, "source"> | ExtraClass): boolean {
  return "source" in cls ? typeof cls.source === "string" && cls.source.startsWith("library:") : true;
}

class FrozenCategories implements CategoryRegistry {
  private readonly byId = new Map<CategoryId, RegisteredCategory>();
  private readonly order: RegisteredCategory[] = [];
  private readonly lineages = new Map<CategoryId, readonly CategoryId[]>();
  readonly revision: string;
  readonly classesPlaceElements: boolean;

  constructor(
    readonly classes: Registry,
    defs: readonly RegisteredCategory[],
    revisionParts: readonly string[],
  ) {
    for (const d of defs) {
      if (this.byId.has(d.id)) continue;
      this.byId.set(d.id, d);
      this.order.push(d);
    }
    this.revision = `cat:${revisionParts.join("|")}`;
    this.classesPlaceElements = classes.listClasses({ includeAbstract: true }).some((c) => c.drawsUnder !== undefined || c.symbolId !== undefined);
  }

  list(): readonly RegisteredCategory[] {
    return this.order;
  }

  get(id: CategoryId): RegisteredCategory | undefined {
    return this.byId.get(id);
  }

  lineage(id: CategoryId): readonly CategoryId[] {
    const cached = this.lineages.get(id);
    if (cached) return cached;
    const out: CategoryId[] = [];
    let at: CategoryId | undefined = id;
    while (at !== undefined && this.byId.has(at) && !out.includes(at)) {
      out.push(at);
      at = this.byId.get(at)?.parent;
    }
    this.lineages.set(id, out);
    return out;
  }

  categoryOfClass(id: ClassId): CategoryId | undefined {
    return this.byId.has(id) ? id : undefined;
  }
}

function classCategory(cls: ObjectClass | ExtraClass): RegisteredCategory {
  // A class that says where it draws (a pack's `fp.sprinkler_head`) needs no kernel row.
  const view = CLASS_VIEW_CATEGORY[cls.id];
  const parent = cls.drawsUnder ?? view ?? cls.parent;
  const discipline = disciplineOf(cls.discipline) ?? (view ? VIEW_CATEGORY_DISCIPLINE[view] : undefined);
  const planSymbol = CLASS_PLAN_SYMBOL.has(cls.id) || (view !== undefined && VIEW_PLAN_SYMBOL.has(view));
  return {
    id: cls.id,
    label: cls.label,
    source: isFirm(cls) ? "firm" : "class",
    classId: cls.id,
    ...(parent !== undefined ? { parent } : {}),
    ...(discipline !== undefined ? { discipline } : {}),
    ...(planSymbol ? { planSymbol } : {}),
  };
}

function serviceCategory(s: ServiceDef): RegisteredCategory {
  const look: CategoryOverride | undefined = s.graphics
    ? { colour: s.graphics.colour, pattern: s.graphics.pattern, ...(s.graphics.weight === "thin" || s.graphics.weight === "medium" || s.graphics.weight === "wide" || s.graphics.weight === "heavy" ? { lineWeights: { projection: s.graphics.weight } } : {}) }
    : undefined;
  return { id: serviceCategoryId(s.id), label: s.label, source: "service", discipline: s.discipline, ...(look ? { defaults: look } : {}) };
}

/** Build the categories for a class registry, firm classes and services. Pure; call again when any input changes. */
export function buildCategoryRegistry(input: CategoryRegistryInput = {}): CategoryRegistry {
  const classes = input.classes ?? activeClassRegistry();
  const services = input.services ?? activeServiceRegistry().rows;
  const defs: RegisteredCategory[] = [];
  for (const c of VIEW_CATEGORIES) {
    const discipline = VIEW_CATEGORY_DISCIPLINE[c];
    defs.push({ id: c, label: VIEW_CATEGORY_LABELS[c], source: "view", ...(discipline ? { discipline } : {}), ...(VIEW_PLAN_SYMBOL.has(c) ? { planSymbol: true } : {}) });
  }
  for (const cls of classes.listClasses({ includeAbstract: true })) defs.push(classCategory(cls));
  const extras = (input.extraClasses ?? []).filter((c) => classes.getClass(c.id) === undefined);
  for (const cls of extras) defs.push(classCategory(cls));
  for (const s of services) defs.push(serviceCategory(s));
  for (const d of DRAFTING_CATEGORIES) defs.push({ id: draftingCategoryId(d), label: DRAFTING_LABELS[d], source: "drafting" });
  const revisionParts = [classes.fingerprint, extras.map((c) => `${c.id}<${c.drawsUnder ?? c.parent ?? ""}`).join(","), services.map((s) => s.id).join(",")];
  return new FrozenCategories(classes, defs, revisionParts);
}

/** Classes that never draw in a view (documents, levels, groupings), so Visibility/Graphics leaves them out. */
export const CLASSES_NOT_DRAWN: ReadonlySet<ClassId> = new Set<ClassId>(["doc.view", "doc.sheet", "gen.level", "gen.zone", "mep.system", "mep.load_point", "mep.equipment", "civil.site", "doc.drawing_underlay"]);

/**
 * The categories a view can show and restyle: everything but classes that
 * never draw, and built-in classes that are their view category under the
 * same name (the Electrical devices class under Electrical devices), which
 * would list one thing twice.
 */
export function drawnCategories(categories: CategoryRegistry): readonly RegisteredCategory[] {
  return categories.list().filter((c) => {
    if (c.classId !== undefined && CLASSES_NOT_DRAWN.has(c.classId)) return false;
    const parent = c.parent === undefined ? undefined : categories.get(c.parent);
    return !(c.source === "class" && parent?.source === "view" && parent.label === c.label);
  });
}

let builtinCategories: { readonly revision: number; readonly registry: CategoryRegistry } | undefined;

/** Every model's base categories (the kernel's and the installed first-party add-ons' classes and services, drafting), rebuilt when that install changes. */
export function builtinCategoryRegistry(): CategoryRegistry {
  const revision = firstPartyBaseRevision();
  if (builtinCategories?.revision !== revision) builtinCategories = { revision, registry: buildCategoryRegistry({ classes: builtinRegistry(), services: firstPartyServiceRegistry().rows }) };
  return builtinCategories.registry;
}

let active: CategoryRegistry | null = null;

function isThenable(v: unknown): boolean {
  return typeof v === "object" && v !== null && "then" in v && typeof v.then === "function";
}

/**
 * Draw `fn` with `registry` as the categories drawings resolve against (the
 * library's classes, the firm's services). Without it drawings use the
 * built-in categories, which is exactly how every view drew before the
 * registry existed.
 *
 * The model server draws many firms' models in one process, so the registry
 * is in force only while `fn` runs synchronously: nothing else can run in
 * that window, and it is restored before `fn`'s caller continues, so one
 * firm's classes never reach another model's drawing. An async `fn` is
 * refused: its steps after the first await would silently draw without the
 * registry. Build the scene inside, await outside.
 */
export function withCategoryRegistry<T>(registry: CategoryRegistry, fn: () => T): T {
  const previous = active;
  active = registry;
  let result: T;
  try {
    result = fn();
  } finally {
    active = previous;
  }
  if (isThenable(result)) throw new Error("[categories] withCategoryRegistry takes a synchronous draw: build the scene inside it and await the PDF outside; the steps after an await would draw without these categories.");
  return result;
}

/** The categories of the pack set in force: its classes (by `drawsUnder` or parent) and services join the built-in ones; built once per set. */
function packCategoryRegistry(): CategoryRegistry {
  const set = activePackSet();
  if (set.packs.length === 0) return builtinCategoryRegistry();
  return set.memo("kernel.category.registry", () => buildCategoryRegistry());
}

/** The categories drawings resolve against right now: the scope's registry, else the pack set's, else the built-in one. */
export function activeCategoryRegistry(): CategoryRegistry {
  return active ?? packCategoryRegistry();
}
