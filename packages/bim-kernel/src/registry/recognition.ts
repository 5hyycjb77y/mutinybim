import type { PartCategory } from "../parts";
import { elementValues, recordsOfKinds } from "../store";
import type { BimElement, ElementId, ElementKind, ModelState, ParamValue, PartTypeElement } from "../types";
import { elementTypeValue } from "../elements/types";
import type { ClassId, ClassIndex, ObjectClass, RecognitionCondition, Registry } from "./types";

/**
 * Class recognition compiled into one pass over the model. Each class's
 * recognition rule becomes a closure filed under the element kinds (and part
 * categories) it can match, so an element is only tested against classes that
 * could be it. An element belongs to every class that recognizes it directly;
 * ancestors are implied, never stored. Indexes are cached per (registry,
 * element record), so a schedule, a tag pass and an agent read in the same
 * revision share one scan.
 *
 * After an edit the index is carried, not rebuilt (`carryClassIndexes` with
 * the edit's changed ids): a class none of the changed elements was or now is
 * keeps its list, and a class one of them touched is re-listed from the kind
 * index over the kinds it can match, each element recognized once per object
 * (memoised). A record with no carried index is built cold in one pass.
 * An element's classes read in registry order, whatever the model holds.
 *
 * `param.<key>` reads a part's own value over its type's, and any other
 * element's own `values` over its element type's (`elementTypeValue`); a
 * type's edit re-lists the classes that read one.
 *
 * A condition may read the element's system (`system.systemKind`): a run
 * segment on a `civil.storm` system is a storm pipe with no class of its own.
 * Such classes are re-listed when a system changes, as part classes are when
 * a part type does.
 *
 * An element that names its class (`classId`, ElementCore) is in that class
 * when the registry knows it (and it isn't abstract), whatever the class's
 * recognition rule says; recognition rules still answer for everything else
 * it is. An id the registry doesn't know is kept as stored and ignored here.
 */

/** An element, its part type (parts) and its system (run segments, fittings): what a condition can read. */
type Test = (el: BimElement, type: PartTypeElement | undefined, system: BimElement | undefined, coreType: BimElement | undefined) => boolean;

interface Compiled {
  readonly id: ClassId;
  readonly test: Test;
}

interface Recognized {
  readonly type: PartTypeElement | undefined;
  readonly system: BimElement | undefined;
  readonly coreType: BimElement | undefined;
  readonly classes: readonly ClassId[];
}

interface Recognizer {
  readonly byKind: ReadonlyMap<string, readonly Compiled[]>;
  readonly byCategory: ReadonlyMap<PartCategory, readonly Compiled[]>;
  /** Classes with conditions only: tested against every element. */
  readonly anyKind: readonly Compiled[];
  readonly rank: ReadonlyMap<ClassId, number>;
  /** The element kinds a class can recognize directly; null when any kind can be (conditions only). */
  readonly kindsOf: ReadonlyMap<ClassId, readonly string[] | null>;
  /** Classes a part can be: a part type's edit can change any of them without touching the part. */
  readonly partClasses: ReadonlySet<ClassId>;
  /** Classes whose conditions read the element's system (`system.<property>`): a system's edit can change them without touching its runs. */
  readonly systemClasses: ReadonlySet<ClassId>;
  /** Classes whose conditions read `param.<key>`: an element type's edit can change them without touching its elements. */
  readonly paramClasses: ReadonlySet<ClassId>;
  /** Per element object, the classes that recognize it directly and the part type they were read with. */
  readonly memo: WeakMap<BimElement, Recognized>;
  /** Classes an element may name explicitly (`classId`): every class the registry knows that isn't abstract. */
  readonly explicit: ReadonlySet<ClassId>;
}

/** The registry-known class an element names itself (`classId`), or null. */
function explicitClassOf(r: Recognizer, el: BimElement): ClassId | null {
  if (!("classId" in el)) return null;
  const id: unknown = el.classId;
  return typeof id === "string" && r.explicit.has(id) ? id : null;
}

const NONE: readonly ClassId[] = Object.freeze([]);
const NO_RECORD: Readonly<Record<string, BimElement>> = Object.freeze({});

const recognizers = new WeakMap<Registry, Recognizer>();

function recognizerFor(registry: Registry): Recognizer {
  const cached = recognizers.get(registry);
  if (cached) return cached;
  const byKind = new Map<string, Compiled[]>();
  const byCategory = new Map<PartCategory, Compiled[]>();
  const anyKind: Compiled[] = [];
  const rank = new Map<ClassId, number>();
  const kindsOf = new Map<ClassId, readonly string[] | null>();
  const partClasses = new Set<ClassId>();
  const systemClasses = new Set<ClassId>();
  const paramClasses = new Set<ClassId>();
  const file = <K>(map: Map<K, Compiled[]>, key: K, c: Compiled) => {
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  };
  for (const cls of registry.listClasses()) {
    const rule = cls.recognize;
    if (!rule) continue;
    rank.set(cls.id, rank.size);
    const compiled: Compiled = { id: cls.id, test: compileConditions(rule.where ?? []) };
    const kinds = rule.elementKinds ?? [];
    const categories = rule.partCategories ?? [];
    for (const kind of kinds) if (kind !== "part" || categories.length === 0) file(byKind, kind, compiled);
    for (const category of categories) file(byCategory, category, compiled);
    const any = kinds.length === 0 && categories.length === 0 && (rule.where?.length ?? 0) > 0;
    if (any) anyKind.push(compiled);
    const direct = new Set<string>(kinds.filter((k) => k !== "part" || categories.length === 0));
    if (categories.length > 0) direct.add("part");
    kindsOf.set(cls.id, any ? null : [...direct]);
    if (any || direct.has("part")) partClasses.add(cls.id);
    if ((rule.where ?? []).some((c) => c.path.startsWith(SYSTEM_PATH))) systemClasses.add(cls.id);
    if ((rule.where ?? []).some((c) => c.path.startsWith("param."))) paramClasses.add(cls.id);
  }
  const explicit = new Set(registry.listClasses().map((c) => c.id));
  const built: Recognizer = { byKind, byCategory, anyKind, rank, kindsOf, partClasses, systemClasses, paramClasses, memo: new WeakMap(), explicit };
  recognizers.set(registry, built);
  return built;
}

/** The classes that recognize `el` directly (read with its part type), in registry order; memoised per element object and type. */
function recognizeElement(r: Recognizer, el: BimElement, type: PartTypeElement | undefined, system: BimElement | undefined, coreType: BimElement | undefined): readonly ClassId[] {
  const hit = r.memo.get(el);
  if (hit && hit.type === type && hit.system === system && hit.coreType === coreType) return hit.classes;
  const found: ClassId[] = [];
  const tryAll = (candidates: readonly Compiled[] | undefined) => {
    if (!candidates) return;
    for (const c of candidates) if (c.test(el, type, system, coreType) && !found.includes(c.id)) found.push(c.id);
  };
  if (type) tryAll(r.byCategory.get(type.definition.category));
  tryAll(r.byKind.get(el.kind));
  if (r.anyKind.length > 0) tryAll(r.anyKind);
  const ranked = found.length === 0 ? NONE : found.length > 1 ? found.sort((a, b) => (r.rank.get(a) ?? 0) - (r.rank.get(b) ?? 0)) : found;
  const named = explicitClassOf(r, el);
  const classes = named === null || ranked.includes(named) ? ranked : [named, ...ranked];
  r.memo.set(el, { type, system, coreType, classes });
  return classes;
}

/** The part type a part is recognized with, looked up once per type id per record. */
function typeReader(elements: ModelState["elements"]): (el: BimElement) => PartTypeElement | undefined {
  const seen = new Map<string, PartTypeElement | undefined>();
  return (el) => {
    if (el.kind !== "part") return undefined;
    if (seen.has(el.typeId)) return seen.get(el.typeId);
    const t = elements[el.typeId];
    const type = t?.kind === "part_type" ? t : undefined;
    seen.set(el.typeId, type);
    return type;
  };
}

/** `system.<property>`: a property of the element's system (`system.systemKind`), for run segments and fittings. */
const SYSTEM_PATH = "system.";

/** The id of the system an element runs in, or null (only runs, fittings and risers have one). */
function systemIdOf(el: BimElement): string | null {
  if (!("systemId" in el)) return null;
  const id: unknown = el.systemId;
  return typeof id === "string" ? id : null;
}

/** The type a non-part element names (`typeId`: an `element_type`, or a part type), read from its record. */
function coreTypeIn(elements: ModelState["elements"], el: BimElement): BimElement | undefined {
  if (el.kind === "part" || !("typeId" in el)) return undefined;
  const id: unknown = el.typeId;
  return typeof id === "string" ? elements[id] : undefined;
}

/** The system an element is recognised with, read from the record it is in. */
function systemIn(elements: ModelState["elements"], el: BimElement): BimElement | undefined {
  const id = systemIdOf(el);
  return id === null ? undefined : elements[id];
}

function compileConditions(conditions: readonly RecognitionCondition[]): Test {
  if (conditions.length === 0) return () => true;
  const tests = conditions.map(compileCondition);
  return (el, type, system, coreType) => tests.every((t) => t(el, type, system, coreType));
}

type Scalar = string | number | boolean;

function compileCondition(cond: RecognitionCondition): Test {
  const read = compileRead(cond.path);
  const wanted = cond.value;
  const norm = (v: Scalar): Scalar => (typeof v === "string" ? v.toLowerCase() : v);
  switch (cond.op) {
    case "present":
      return (el, type, system, coreType) => present(read(el, type, system, coreType));
    case "absent":
      return (el, type, system, coreType) => !present(read(el, type, system, coreType));
    case "equals":
    case "not_equals": {
      const target = Array.isArray(wanted) ? undefined : (wanted as Scalar | undefined);
      const want = cond.op === "equals";
      return (el, type, system, coreType) => {
        const v = read(el, type, system, coreType);
        const same = v !== undefined && target !== undefined && norm(v) === norm(target);
        return same === want;
      };
    }
    case "contains": {
      const needle = typeof wanted === "string" ? wanted.toLowerCase() : String(wanted ?? "").toLowerCase();
      return (el, type, system, coreType) => {
        const v = read(el, type, system, coreType);
        return v !== undefined && String(v).toLowerCase().includes(needle);
      };
    }
    case "in": {
      const set = new Set((Array.isArray(wanted) ? wanted : wanted === undefined ? [] : [wanted]).map(norm));
      return (el, type, system, coreType) => {
        const v = read(el, type, system, coreType);
        return v !== undefined && set.has(norm(v));
      };
    }
  }
}

function present(v: Scalar | undefined): boolean {
  return v !== undefined && v !== "";
}

function asScalar(v: unknown): Scalar | undefined {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}

function typeValue(type: PartTypeElement | undefined, name: string): ParamValue | undefined {
  if (!type) return undefined;
  const def = type.definition;
  return def.typeValues[name] ?? def.typeParams.find((p) => p.name === name)?.default;
}

function compileRead(path: string): (el: BimElement, type: PartTypeElement | undefined, system: BimElement | undefined, coreType: BimElement | undefined) => Scalar | undefined {
  if (path.startsWith(SYSTEM_PATH)) {
    const key = path.slice(SYSTEM_PATH.length);
    return (_el, _type, system) => (system ? asScalar(property(system, key)) : undefined);
  }
  if (path === "family") return (el, type) => (type ? type.definition.familyName : asScalar(property(el, "familyName")));
  if (path === "type") return (el, type) => (type ? type.definition.typeName : asScalar(property(el, "typeName")));
  if (path.startsWith("type.param.")) {
    const name = path.slice("type.param.".length);
    return (_el, type) => asScalar(typeValue(type, name));
  }
  if (path.startsWith("param.")) {
    const name = path.slice("param.".length);
    return (el, type, _system, coreType) => {
      if (el.kind === "part") return asScalar(el.values[name] ?? typeValue(type, name));
      // Instance over type, as every reader of a building element's values does (`elementTypeValue`).
      const typeRecord: Readonly<Record<string, BimElement>> = coreType ? { [coreType.id]: coreType } : NO_RECORD;
      return asScalar(elementTypeValue(typeRecord, el, name));
    };
  }
  return (el) => asScalar(property(el, path));
}

function property(el: BimElement, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(el, key) ? (el as unknown as Readonly<Record<string, unknown>>)[key] : undefined;
}

/** One cold pass: per class, the positions in `all` of the elements it recognizes directly, ascending. */
interface ColdPass {
  /** Per explicitly named class, the element kinds that name it. */
  readonly explicitKinds: ReadonlyMap<ClassId, ReadonlySet<ElementKind>>;
  readonly all: readonly BimElement[];
  readonly direct: ReadonlyMap<ClassId, readonly number[]>;
}

function coldPass(recognizer: Recognizer, elements: ModelState["elements"]): ColdPass {
  const all = elementValues(elements);
  const direct = new Map<ClassId, number[]>();
  const add = (cls: ClassId, at: number) => {
    const list = direct.get(cls);
    if (list) {
      if (list[list.length - 1] !== at) list.push(at);
    } else direct.set(cls, [at]);
  };
  let system: BimElement | undefined;
  let coreType: BimElement | undefined;
  const tryAll = (candidates: readonly Compiled[] | undefined, el: BimElement, type: PartTypeElement | undefined, at: number) => {
    if (!candidates) return;
    for (const c of candidates) if (c.test(el, type, system, coreType)) add(c.id, at);
  };
  const explicitKinds = new Map<ClassId, Set<ElementKind>>();
  for (let at = 0; at < all.length; at++) {
    const el = all[at];
    if (el === undefined) continue;
    let type: PartTypeElement | undefined;
    system = recognizer.systemClasses.size > 0 ? systemIn(elements, el) : undefined;
    coreType = recognizer.paramClasses.size > 0 ? coreTypeIn(elements, el) : undefined;
    if (el.kind === "part") {
      const t = elements[el.typeId];
      if (t?.kind === "part_type") {
        type = t;
        tryAll(recognizer.byCategory.get(t.definition.category), el, type, at);
      }
    }
    tryAll(recognizer.byKind.get(el.kind), el, type, at);
    if (recognizer.anyKind.length > 0) tryAll(recognizer.anyKind, el, type, at);
    const named = explicitClassOf(recognizer, el);
    if (named !== null) {
      add(named, at);
      noteExplicit(explicitKinds, named, el.kind);
    }
  }
  return { all, direct, explicitKinds };
}

function noteExplicit(into: Map<ClassId, Set<ElementKind>>, cls: ClassId, kind: ElementKind): void {
  const kinds = into.get(cls);
  if (kinds) kinds.add(kind);
  else into.set(cls, new Set([kind]));
}

interface ClassList {
  /** Every class the list was asked for (an edit touching any of them drops it). */
  readonly classes: readonly ClassId[];
  readonly elements: readonly BimElement[];
}

const NO_CLASSES: ReadonlySet<ClassId> = new Set();

class RecordClassIndex implements ClassIndex {
  readonly fingerprint: string;
  readonly lists = new Map<string, ClassList>();
  private typeOfCache: ((el: BimElement) => PartTypeElement | undefined) | null = null;

  constructor(
    readonly registry: Registry,
    readonly recognizer: Recognizer,
    readonly elements: ModelState["elements"],
    /** The cold pass this index descends from: its positions still hold for every class not in `stale`. */
    readonly cold: ColdPass | null,
    /** Classes an edit since that pass touched. */
    readonly stale: ReadonlySet<ClassId>,
    /** Per class some element names explicitly, the kinds that do (only grows; a superset is safe, every candidate is re-tested). */
    readonly explicitKinds: ReadonlyMap<ClassId, ReadonlySet<ElementKind>>,
  ) {
    this.fingerprint = registry.fingerprint;
  }

  private typeOf(el: BimElement): PartTypeElement | undefined {
    this.typeOfCache ??= typeReader(this.elements);
    return this.typeOfCache(el);
  }

  private systemOf(el: BimElement): BimElement | undefined {
    return this.recognizer.systemClasses.size > 0 ? systemIn(this.elements, el) : undefined;
  }

  private coreTypeOf(el: BimElement): BimElement | undefined {
    return this.recognizer.paramClasses.size > 0 ? coreTypeIn(this.elements, el) : undefined;
  }

  classesOf(id: ElementId): readonly ClassId[] {
    const el = this.elements[id];
    return el ? recognizeElement(this.recognizer, el, this.typeOf(el), this.systemOf(el), this.coreTypeOf(el)) : NONE;
  }

  elementsOf(id: ClassId, opts?: { readonly includeSubclasses?: boolean }): readonly BimElement[] {
    const withSubclasses = opts?.includeSubclasses !== false;
    const key = `${withSubclasses ? "+" : "="}${id}`;
    const known = this.lists.get(key);
    if (known) return known.elements;
    const asked = withSubclasses ? this.registry.descendants(id) : [id];
    const classes = asked.filter((c) => this.recognizer.kindsOf.has(c) || this.explicitKinds.has(c));
    const elements = classes.length === 0 ? [] : this.cold && classes.every((c) => !this.stale.has(c)) ? this.fromCold(this.cold, classes) : this.fromKinds(classes);
    // Kept against every class asked for: an edit that names one explicitly must drop the list even when no element was in it yet.
    this.lists.set(key, { classes: asked, elements });
    return elements;
  }

  private fromCold(cold: ColdPass, classes: readonly ClassId[]): BimElement[] {
    const lists = classes.map((c) => cold.direct.get(c)).filter((l): l is readonly number[] => l !== undefined && l.length > 0);
    const positions = lists.length === 0 ? [] : lists.length === 1 ? (lists[0] ?? []) : [...new Set(lists.flat())].sort((a, b) => a - b);
    const out: BimElement[] = [];
    for (const at of positions) {
      const el = cold.all[at];
      if (el !== undefined) out.push(el);
    }
    return out;
  }

  /** Re-listed from the kind index over the kinds the classes can match, in model order. */
  private fromKinds(classes: readonly ClassId[]): BimElement[] {
    const kinds = new Set<string>();
    let anyKind = false;
    for (const c of classes) {
      const of = this.recognizer.kindsOf.get(c);
      if (of === null) anyKind = true;
      else for (const k of of ?? []) kinds.add(k);
      for (const k of this.explicitKinds.get(c) ?? []) kinds.add(k);
    }
    const candidates = anyKind ? elementValues(this.elements) : recordsOfKinds(this.elements, [...kinds]);
    const wanted = new Set(classes);
    const out: BimElement[] = [];
    for (const el of candidates) if (recognizeElement(this.recognizer, el, this.typeOf(el), this.systemOf(el), this.coreTypeOf(el)).some((c) => wanted.has(c))) out.push(el);
    return out;
  }

  /** This index moved onto `to`, a record that differs from this one only at `changedIds`. */
  carried(to: ModelState["elements"], changedIds: readonly string[]): RecordClassIndex {
    const r = this.recognizer;
    const toType = typeReader(to);
    const touched = new Set<ClassId>();
    let partTypeChanged = false;
    let systemChanged = false;
    let elementTypeChanged = false;
    const readsSystem = r.systemClasses.size > 0;
    const readsParams = r.paramClasses.size > 0;
    const note = (el: BimElement | undefined, type: PartTypeElement | undefined, system: BimElement | undefined, coreType: BimElement | undefined) => {
      if (!el) return;
      if (el.kind === "part_type") partTypeChanged = true;
      if (el.kind === "mep_system") systemChanged = true;
      if (el.kind === "element_type") elementTypeChanged = true;
      for (const c of recognizeElement(r, el, type, system, coreType)) touched.add(c);
    };
    let explicitKinds = this.explicitKinds;
    for (const id of changedIds) {
      const before = this.elements[id];
      const after = to[id];
      if (before === after) continue;
      note(before, before ? this.typeOf(before) : undefined, before && readsSystem ? systemIn(this.elements, before) : undefined, before && readsParams ? coreTypeIn(this.elements, before) : undefined);
      note(after, after ? toType(after) : undefined, after && readsSystem ? systemIn(to, after) : undefined, after && readsParams ? coreTypeIn(to, after) : undefined);
      const named = after ? explicitClassOf(r, after) : null;
      if (after && named !== null && !explicitKinds.get(named)?.has(after.kind)) {
        const next = new Map<ClassId, Set<ElementKind>>([...explicitKinds].map(([c, k]) => [c, new Set(k)]));
        noteExplicit(next, named, after.kind);
        explicitKinds = next;
      }
    }
    if (partTypeChanged) for (const c of r.partClasses) touched.add(c);
    if (systemChanged) for (const c of r.systemClasses) touched.add(c);
    if (elementTypeChanged) for (const c of r.paramClasses) touched.add(c);
    const stale = touched.size === 0 ? this.stale : new Set([...this.stale, ...touched]);
    // Once every class has been touched the cold positions answer nothing: let them go.
    const cold = this.cold && stale.size < r.rank.size ? this.cold : null;
    const child = new RecordClassIndex(this.registry, r, to, cold, cold ? stale : NO_CLASSES, explicitKinds);
    for (const [key, list] of this.lists) if (!list.classes.some((c) => touched.has(c))) child.lists.set(key, list);
    return child;
  }
}

/** Per element record, its index under each registry. */
const indexesByRecord = new WeakMap<object, Map<Registry, RecordClassIndex>>();

/** The model's elements by class under `registry`: carried from the revision before when it was (`carryClassIndexes`), else one pass; cached per element record. */
export function buildClassIndex(registry: Registry, model: Pick<ModelState, "elements">): ClassIndex {
  let held = indexesByRecord.get(model.elements);
  const hit = held?.get(registry);
  if (hit) return hit;
  const recognizer = recognizerFor(registry);
  const cold = coldPass(recognizer, model.elements);
  const index = new RecordClassIndex(registry, recognizer, model.elements, cold, NO_CLASSES, cold.explicitKinds);
  if (!held) {
    held = new Map();
    indexesByRecord.set(model.elements, held);
  }
  held.set(registry, index);
  return index;
}

/**
 * Moves every class index built on `from` onto `to`, a record that differs
 * from it only at `changedIds` (added, written or removed), so the next read
 * of `to` re-lists only the classes those elements were or now are. Call it
 * where a revision is made from the one before (as `shareLoadIndex` is). A
 * record nothing indexed is left alone; `to` keeps an index it already has.
 */
export function carryClassIndexes(from: ModelState["elements"], to: ModelState["elements"], changedIds: Iterable<string>): void {
  if (from === to) return;
  const held = indexesByRecord.get(from);
  if (!held) return;
  const ids = [...changedIds];
  let target = indexesByRecord.get(to);
  for (const [registry, index] of held) {
    if (target?.has(registry)) continue;
    if (!target) {
      target = new Map();
      indexesByRecord.set(to, target);
    }
    target.set(registry, index.carried(to, ids));
  }
}

/** True when the element (and its part type, for parts) passes the class's own recognition rule. */
export function recognizes(cls: ObjectClass, el: BimElement, elements: ModelState["elements"]): boolean {
  const rule = cls.recognize;
  if (!rule) return false;
  const type = el.kind === "part" ? elements[el.typeId] : undefined;
  const partType = type?.kind === "part_type" ? type : undefined;
  const kinds = rule.elementKinds ?? [];
  const categories = rule.partCategories ?? [];
  const kindMatch = kinds.includes(el.kind) && !(el.kind === "part" && categories.length > 0);
  const categoryMatch = partType !== undefined && categories.includes(partType.definition.category);
  const anyKind = kinds.length === 0 && categories.length === 0 && (rule.where?.length ?? 0) > 0;
  if (!kindMatch && !categoryMatch && !anyKind) return false;
  return compileConditions(rule.where ?? [])(el, partType, systemIn(elements, el), coreTypeIn(elements, el));
}
