import { elementClass } from "../categories/element";
import { elementTypeValue } from "../elements/types";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { polygonAreaAndCentroid } from "../placement/geometric-math";
import { activeClassRegistry } from "../registry";
import { spaceAreaM2 } from "../spaces/space-geometry";
import type { BimElement } from "../types";
import { hostVoidsOf, voidAreaM2 } from "../hosting/voids";
import { BOUNDARY_MEASURES, boundaryQuantities, boundaryQuantityReads } from "./boundary";
import { hostedIds } from "./hosted";
import { MEASURE_RULE_POINT, type MeasureDef, type MeasureRuleDef } from "./types";

/**
 * How every element measures itself (KERNEL-FOUNDATION §3.13): the
 * `MEASURE_RULE_POINT` rows of the set in force, then the kernel's own rules
 * for its building classes. One rule measures an element: a rule naming the
 * element's class (nearest class first, a pack's before the kernel's) wins
 * over one naming its kind; `appliesTo` narrows either.
 *
 * Values are SI (m, m², m³, ea, kg) and read only the element, its type and
 * the elements its rule names in `reads`, so a measure is cached per record
 * and re-runs only when one of those records changed.
 */

type Elements = Readonly<Record<string, BimElement>>;

const MM_PER_M = 1000;
const MM2_PER_M2 = 1e6;

/** Type parameters the kernel's rules read for weight. */
export const QTO_UNIT_MASS_KEY = "qto.unit_mass";
export const QTO_MASS_PER_LENGTH_KEY = "qto.mass_per_length";

const COUNT: MeasureDef = { key: "qto.count", kind: "count", unit: "ea", from: "one per element", label: "Count" };
const LENGTH: MeasureDef = { key: "qto.length", kind: "length", unit: "m", from: "centreline length", label: "Length" };
const MASS_UNIT: MeasureDef = { key: "qto.mass", kind: "mass", unit: "kg", from: `count × the type's unit weight (${QTO_UNIT_MASS_KEY})`, label: "Weight" };
const MASS_LINEAR: MeasureDef = { key: "qto.mass", kind: "mass", unit: "kg", from: `length × the type's weight per length (${QTO_MASS_PER_LENGTH_KEY})`, label: "Weight" };

const primary = (m: MeasureDef): MeasureDef => ({ ...m, primary: true });

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function typeNumber(elements: Elements, el: BimElement, key: string): number | null {
  return num(elementTypeValue(elements, el, key));
}

function planLength(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y) / MM_PER_M;
}

function withUnitMass(out: Record<string, number>, elements: Elements, el: BimElement, count: number): void {
  const m = typeNumber(elements, el, QTO_UNIT_MASS_KEY);
  if (m !== null) out["qto.mass"] = m * count;
}

function withLinearMass(out: Record<string, number>, elements: Elements, el: BimElement, lengthM: number): void {
  const m = typeNumber(elements, el, QTO_MASS_PER_LENGTH_KEY);
  if (m !== null) out["qto.mass"] = m * lengthM;
}

const WALL_RULE: MeasureRuleDef = {
  id: "kernel.wall",
  label: "Walls",
  kinds: ["wall"],
  measures: [
    primary(LENGTH),
    { key: "qto.area_gross", kind: "area", unit: "m2", from: "length × height, one face", label: "Face area" },
    { key: "qto.area_net", kind: "area", unit: "m2", from: "length × height, one face, less hosted doors and windows", label: "Net face area" },
    { key: "qto.volume", kind: "volume", unit: "m3", from: "net face area × thickness", label: "Volume" },
    COUNT,
    MASS_UNIT,
  ],
  reads: (el, elements) => [...hostedIds(elements, el.id)],
  measure(el, elements) {
    if (el.kind !== "wall") return {};
    const length = planLength(el.start, el.end);
    const out: Record<string, number> = { "qto.length": length, "qto.count": 1 };
    const height = num(el.height);
    if (height !== null && height > 0) {
      const gross = (length * height) / MM_PER_M;
      let openings = 0;
      for (const v of hostVoidsOf(elements, el.id)) openings += voidAreaM2(v);
      const net = Math.max(0, gross - openings);
      out["qto.area_gross"] = gross;
      out["qto.area_net"] = net;
      const t = num(el.thickness);
      if (t !== null && t > 0) out["qto.volume"] = (net * t) / MM_PER_M;
    }
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

const OPENING_RULE: MeasureRuleDef = {
  id: "kernel.opening",
  label: "Doors and windows",
  kinds: ["opening"],
  measures: [primary(COUNT), { key: "qto.area", kind: "area", unit: "m2", from: "width × height", label: "Area" }, MASS_UNIT],
  measure(el, elements) {
    if (el.kind !== "opening") return {};
    const out: Record<string, number> = { "qto.count": 1, "qto.area": (Math.max(0, el.width) * Math.max(0, el.height)) / MM2_PER_M2 };
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

function holesOfPlacement(el: BimElement): readonly (readonly { readonly x: number; readonly y: number }[])[] {
  if (!("placement" in el)) return [];
  const p: unknown = el.placement;
  if (typeof p !== "object" || p === null || (p as { kind?: unknown }).kind !== "area") return [];
  const holes: unknown = (p as { holes?: unknown }).holes;
  return Array.isArray(holes) ? (holes as readonly (readonly { readonly x: number; readonly y: number }[])[]) : [];
}

const SLAB_RULE: MeasureRuleDef = {
  id: "kernel.slab",
  label: "Floors and slabs",
  kinds: ["slab"],
  measures: [primary({ key: "qto.area", kind: "area", unit: "m2", from: "plan area less its holes", label: "Area" }), { key: "qto.volume", kind: "volume", unit: "m3", from: "area × thickness", label: "Volume" }, COUNT, MASS_UNIT],
  measure(el, elements) {
    if (el.kind !== "slab") return {};
    const area = Math.abs(polygonAreaAndCentroid(el.outline, holesOfPlacement(el)).areaMm2) / MM2_PER_M2;
    const out: Record<string, number> = { "qto.area": area, "qto.count": 1 };
    const t = num(el.thickness);
    if (t !== null && t > 0) out["qto.volume"] = (area * t) / MM_PER_M;
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

const CEILING_RULE: MeasureRuleDef = {
  id: "kernel.ceiling",
  label: "Ceilings",
  kinds: ["ceiling"],
  measures: [
    primary({ key: "qto.area", kind: "area", unit: "m2", from: "plan area less its holes", label: "Area" }),
    { key: "qto.area_surface", kind: "area", unit: "m2", from: "surface area along its slope, less its holes", label: "Surface area" },
    COUNT,
  ],
  measure(el): Readonly<Record<string, number>> {
    if (el.kind !== "ceiling") return {};
    const plan = Math.abs(polygonAreaAndCentroid(el.outline, el.holes ?? []).areaMm2) / MM2_PER_M2;
    const pitch = num(el.slope?.pitch) ?? 0;
    return { "qto.area": plan, "qto.area_surface": plan * Math.sqrt(1 + pitch * pitch), "qto.count": 1 };
  },
};

const ROOM_RULE: MeasureRuleDef = {
  id: "kernel.room",
  label: "Rooms",
  kinds: ["room"],
  measures: [primary({ key: "qto.area", kind: "area", unit: "m2", from: "the room's floor area", label: "Area" }), COUNT],
  measure(el): Readonly<Record<string, number>> {
    if (el.kind !== "room") return {};
    const stated = num(el.areaSqM);
    const area = stated !== null && stated > 0 ? stated : Math.abs(polygonAreaAndCentroid(el.outline).areaMm2) / MM2_PER_M2;
    return { "qto.area": area, "qto.count": 1 };
  },
};

const SPACE_RULE: MeasureRuleDef = {
  id: "kernel.space",
  label: "Spaces",
  kinds: ["space"],
  measures: [primary({ key: "qto.area", kind: "area", unit: "m2", from: "floor area from its outline or rooms", label: "Area" }), { key: "qto.volume", kind: "volume", unit: "m3", from: "floor area × stated ceiling height", label: "Volume" }, COUNT, ...BOUNDARY_MEASURES],
  reads: (el, elements) => (el.kind === "space" && el.bounds.kind === "rooms" ? el.bounds.roomIds : el.kind === "space" ? boundaryQuantityReads(elements, el) : []),
  measure(el, elements) {
    if (el.kind !== "space") return {};
    const out: Record<string, number> = { "qto.count": 1, ...boundaryQuantities(elements, el) };
    const area = spaceAreaM2(elements, el);
    if (area !== null) {
      out["qto.area"] = area;
      const h = num(el.ceilingHeightMm);
      if (h !== null && h > 0) out["qto.volume"] = (area * h) / MM_PER_M;
    }
    return out;
  },
};

const COLUMN_RULE: MeasureRuleDef = {
  id: "kernel.column",
  label: "Columns",
  kinds: ["column"],
  measures: [primary(COUNT), MASS_UNIT],
  measure(el, elements) {
    if (el.kind !== "column") return {};
    const out: Record<string, number> = { "qto.count": 1 };
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

const BEAM_RULE: MeasureRuleDef = {
  id: "kernel.beam",
  label: "Beams",
  kinds: ["beam"],
  measures: [primary(LENGTH), COUNT, MASS_LINEAR],
  measure(el, elements) {
    if (el.kind !== "beam") return {};
    const length = planLength(el.start, el.end);
    const out: Record<string, number> = { "qto.length": length, "qto.count": 1 };
    withLinearMass(out, elements, el, length);
    return out;
  },
};

const COMPONENT_RULE: MeasureRuleDef = {
  id: "kernel.component",
  label: "Components",
  kinds: ["component"],
  measures: [primary(COUNT), { key: "qto.area", kind: "area", unit: "m2", from: "plan footprint", label: "Footprint" }, MASS_UNIT],
  measure(el, elements) {
    if (el.kind !== "component") return {};
    const out: Record<string, number> = { "qto.count": 1, "qto.area": (Math.abs(el.size.x) * Math.abs(el.size.y)) / MM2_PER_M2 };
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

const PART_RULE: MeasureRuleDef = {
  id: "kernel.part",
  label: "Placed and planned parts",
  kinds: ["part"],
  measures: [primary(COUNT), MASS_UNIT],
  measure(el, elements) {
    if (el.kind !== "part") return {};
    const out: Record<string, number> = { "qto.count": 1 };
    withUnitMass(out, elements, el, 1);
    return out;
  },
};

const RUN_RULE: MeasureRuleDef = {
  id: "kernel.run_segment",
  label: "Runs",
  kinds: ["run_segment"],
  measures: [primary({ ...LENGTH, from: "centreline length, slope included" }), COUNT, MASS_LINEAR],
  measure(el, elements) {
    if (el.kind !== "run_segment") return {};
    const length = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z) / MM_PER_M;
    const out: Record<string, number> = { "qto.length": length, "qto.count": 1 };
    withLinearMass(out, elements, el, length);
    return out;
  },
};

/** The kernel's own rules, one per building kind it measures. */
export const BUILTIN_MEASURE_RULES: readonly MeasureRuleDef[] = Object.freeze([WALL_RULE, OPENING_RULE, SLAB_RULE, CEILING_RULE, ROOM_RULE, SPACE_RULE, COLUMN_RULE, BEAM_RULE, COMPONENT_RULE, PART_RULE, RUN_RULE]);

interface RuleTable {
  readonly byClass: ReadonlyMap<string, readonly MeasureRuleDef[]>;
  readonly byKind: ReadonlyMap<string, readonly MeasureRuleDef[]>;
  readonly all: readonly MeasureRuleDef[];
  readonly measures: ReadonlyMap<string, MeasureDef>;
}

function push(map: Map<string, MeasureRuleDef[]>, key: string, rule: MeasureRuleDef): void {
  const list = map.get(key);
  if (list) list.push(rule);
  else map.set(key, [rule]);
}

function ruleTable(set: PackSet): RuleTable {
  return set.memo("kernel.measure_rule#table", () => {
    const all = [...set.packItems(MEASURE_RULE_POINT), ...BUILTIN_MEASURE_RULES];
    const byClass = new Map<string, MeasureRuleDef[]>();
    const byKind = new Map<string, MeasureRuleDef[]>();
    const measures = new Map<string, MeasureDef>();
    for (const rule of all) {
      for (const c of rule.classes ?? []) push(byClass, c, rule);
      if ((rule.classes?.length ?? 0) === 0) for (const k of rule.kinds ?? []) push(byKind, k, rule);
      for (const m of rule.measures) if (!measures.has(m.key)) measures.set(m.key, m);
    }
    return { byClass, byKind, all, measures };
  });
}

/** Every rule in force: packs' first, then the kernel's. */
export function measureRules(set: PackSet = activePackSet()): readonly MeasureRuleDef[] {
  return ruleTable(set).all;
}

/** Every measure the rules in force can take, by key (the first rule's definition of a key). */
export function measureDefs(set: PackSet = activePackSet()): ReadonlyMap<string, MeasureDef> {
  return ruleTable(set).measures;
}

/** The class an element is: a class set on it explicitly, else what recognition makes of it (a class the upgrade filled in by recognition follows recognition, packs' classes included). */
export function measureClassOf(elements: Elements, el: BimElement): string | null {
  const recognised = "classSource" in el && el.classSource === "recognised";
  if (!recognised && "classId" in el && typeof el.classId === "string" && el.classId !== "") return el.classId;
  try {
    return elementClass(elements, el);
  } catch (err) {
    console.error("[qto] recognising an element's class failed; measured by its kind", { elementId: el.id, err });
    return null;
  }
}

function lineage(classId: string | null): readonly string[] {
  if (classId === null) return [];
  const reg = activeClassRegistry();
  return reg.getClass(classId) ? reg.ancestors(classId) : [classId];
}

function applies(rule: MeasureRuleDef, el: BimElement, elements: Elements): boolean {
  if (!rule.appliesTo) return true;
  try {
    return rule.appliesTo(el, elements);
  } catch (err) {
    console.error("[qto] a measure rule's appliesTo threw; the rule is skipped for this element", { ruleId: rule.id, elementId: el.id, err });
    return false;
  }
}

/** The one rule that measures an element in the set in force, or null. */
export function measureRuleFor(elements: Elements, el: BimElement, set: PackSet = activePackSet()): MeasureRuleDef | null {
  const t = ruleTable(set);
  for (const cls of lineage(measureClassOf(elements, el))) for (const rule of t.byClass.get(cls) ?? []) if (applies(rule, el, elements)) return rule;
  for (const rule of t.byKind.get(el.kind) ?? []) if (applies(rule, el, elements)) return rule;
  return null;
}

export interface ElementMeasure {
  readonly elementId: string;
  readonly rule: MeasureRuleDef;
  /** Values by `qto.*` key, SI; a measure the rule couldn't take is absent. */
  readonly values: Readonly<Record<string, number>>;
  readonly sizeGroup: string | null;
  /** Records the measure read beyond the element (its type, hosted openings). */
  readonly reads: readonly string[];
}

interface Cached {
  readonly set: PackSet;
  readonly measure: ElementMeasure | null;
  /** The records read, identity-checked on a hit. */
  readonly readRecords: readonly (readonly [string, BimElement | undefined])[];
}

const cache = new WeakMap<BimElement, Cached>();

function typeIdOf(el: BimElement): string | null {
  if (!("typeId" in el)) return null;
  const t: unknown = el.typeId;
  return typeof t === "string" ? t : null;
}

function readIdsOf(rule: MeasureRuleDef | null, el: BimElement, elements: Elements): string[] {
  const ids: string[] = [];
  const typeId = typeIdOf(el);
  if (typeId !== null) ids.push(typeId);
  if (rule?.reads) {
    try {
      ids.push(...rule.reads(el, elements));
    } catch (err) {
      console.error("[qto] a measure rule's reads threw; measured without them", { ruleId: rule.id, elementId: el.id, err });
    }
  }
  return ids;
}

function stillValid(hit: Cached, set: PackSet, el: BimElement, elements: Elements): boolean {
  if (hit.set !== set) return false;
  const ids = readIdsOf(hit.measure?.rule ?? null, el, elements);
  if (ids.length !== hit.readRecords.length) return false;
  for (let i = 0; i < ids.length; i++) {
    const prior = hit.readRecords[i];
    if (!prior || prior[0] !== ids[i] || elements[prior[0]] !== prior[1]) return false;
  }
  return true;
}

function finiteValues(raw: Readonly<Record<string, number>>, rule: MeasureRuleDef, el: BimElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else console.error("[qto] a measure rule returned a value that isn't a number; left out", { ruleId: rule.id, elementId: el.id, key: k });
  }
  return out;
}

/** An element's measured quantities in the set in force, or null when no rule measures it. Cached per record. */
export function measureElement(elements: Elements, el: BimElement, set: PackSet = activePackSet()): ElementMeasure | null {
  const hit = cache.get(el);
  if (hit && stillValid(hit, set, el, elements)) return hit.measure;
  const rule = measureRuleFor(elements, el, set);
  let measure: ElementMeasure | null = null;
  const reads = readIdsOf(rule, el, elements);
  if (rule) {
    let values: Record<string, number> = {};
    let sizeGroup: string | null = null;
    try {
      values = finiteValues(rule.measure(el, elements), rule, el);
      sizeGroup = rule.sizeGroup?.(el, elements) ?? null;
    } catch (err) {
      console.error("[qto] a measure rule threw; the element reads as unmeasured", { ruleId: rule.id, elementId: el.id, err });
    }
    measure = { elementId: el.id, rule, values: Object.freeze(values), sizeGroup, reads: Object.freeze(reads) };
  }
  cache.set(el, { set, measure, readRecords: reads.map((id) => [id, elements[id]] as const) });
  return measure;
}

/** One `qto.*` value of an element by id; null when it has none. */
export function measuredValue(elements: Elements, elementId: string, key: string): number | null {
  const el = elements[elementId];
  if (!el) return null;
  return measureElement(elements, el)?.values[key] ?? null;
}
