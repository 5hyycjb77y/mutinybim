import { elementsOfKind, kindsWrittenSince, paramValue } from "@permitzip/bim-kernel";
import { elementPlacementOf, elementTypeValue } from "@permitzip/bim-pack/runtime";
import type { BimElement, ElementId, ModelState, Vec2 } from "@permitzip/bim-kernel/types";
import { fromCanonical, qty, type Quantity } from "@permitzip/bim-units";
import { sectionById, type WideFlangeSection } from "./sections";

/**
 * The structural frame as the pack reads it from a model: beams and columns
 * placed along lines, pad footings and equipment at points, decks over areas.
 * Read once per elements record (every edit makes a new one) through the
 * kernel's kind index, never by scanning the record.
 *
 * Placement comes from the kernel's own reader (`elementPlacementOf`): the
 * flat fields are authoritative and the level falls back to the partition's
 * level name, so an older record with no stored placement still reads. An
 * element whose level can't be found is listed in `unplaced` and left out.
 */

/** Parameter keys the pack reads and writes. */
export const STRUCT_KEYS = {
  section: "struct.section",
  occupancy: "struct.occupancy",
  /** The baseline Structural set's operating weight (bim-library parameter-sets.ts), stored on the part as `weight` in pounds. */
  operatingWeight: "struct.operating_weight",
} as const;

/** Where `struct.operating_weight` is stored on a part (the baseline set's storage name), and its stored unit. */
export const OPERATING_WEIGHT_STORAGE = { name: "weight", unit: "lb" } as const;

/** Standard gravity (ISO 80000-3; the lbf definition), turning a mass into its weight. */
export const STANDARD_GRAVITY = 9.80665;

export interface FrameBeam {
  readonly id: string;
  readonly label: string;
  readonly levelId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
  /** Model elevation of each end (the placement's offsets above its level), mm. */
  readonly startZMm: number;
  readonly endZMm: number;
  readonly sectionName: string;
  readonly section: WideFlangeSection | null;
}

/** A column as a support: where it stands and what it reaches, without its section. */
export interface FrameSupportColumn {
  readonly id: string;
  readonly label: string;
  readonly levelId: ElementId;
  readonly position: Vec2;
  /** Half its larger plan size, mm: a beam end this close to its centre bears on it. */
  readonly radiusMm: number;
  readonly baseZMm: number;
  readonly topZMm: number;
  readonly topLevelId: ElementId | null;
}

export interface FrameColumn extends FrameSupportColumn {
  readonly sectionName: string;
  readonly section: WideFlangeSection | null;
}

export interface FrameFooting {
  readonly id: string;
  readonly label: string;
  readonly levelId: ElementId;
  readonly position: Vec2;
  readonly size: Vec2;
  readonly rotationDeg: number;
  /** Top of footing, mm. */
  readonly topZMm: number;
}

export interface FrameDeck {
  readonly id: string;
  readonly label: string;
  readonly levelId: ElementId;
  readonly outline: readonly Vec2[];
  readonly spanDirectionDeg: number;
  readonly useId: string | null;
}

/** What a piece of equipment stands on: a beam at a station from its start, a slab or deck, or nothing the pack reads. */
export type EquipmentHost = { readonly kind: "line"; readonly elementId: string; readonly stationMm: number } | { readonly kind: "slab"; readonly elementId: string } | null;

export interface FrameEquipment {
  readonly id: string;
  readonly label: string;
  readonly levelId: ElementId;
  readonly position: Vec2;
  readonly host: EquipmentHost;
  /** Its operating weight as a load. Parts with none entered are not read. */
  readonly weight: Quantity<"force">;
}

export interface Frame {
  readonly beams: readonly FrameBeam[];
  readonly columns: readonly FrameColumn[];
  readonly footings: readonly FrameFooting[];
  readonly decks: readonly FrameDeck[];
  readonly equipment: readonly FrameEquipment[];
  readonly beamsByLevel: ReadonlyMap<ElementId, readonly FrameBeam[]>;
  readonly decksByLevel: ReadonlyMap<ElementId, readonly FrameDeck[]>;
  readonly byId: ReadonlyMap<string, FrameBeam | FrameColumn | FrameFooting | FrameDeck | FrameEquipment>;
  /** Structural elements left out because they have no placement with a level. */
  readonly unplaced: readonly string[];
}

type Elements = ModelState["elements"];

function levelElevation(elements: Elements, levelId: ElementId): number | null {
  const l = elements[levelId];
  return l?.kind === "level" ? l.elevationMm : null;
}

interface LevelRow {
  readonly id: ElementId;
  readonly elevationMm: number;
}

/** The level whose floor is the next one above `elevationMm`, or null. */
function levelAbove(levels: readonly LevelRow[], elevationMm: number): LevelRow | null {
  let best: LevelRow | null = null;
  for (const l of levels) if (l.elevationMm > elevationMm + 1 && (!best || l.elevationMm < best.elevationMm)) best = l;
  return best;
}

const textValue = (el: { readonly values?: Readonly<Record<string, unknown>> }, key: string): string | null => {
  const v = el.values?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** A text value on the element, else on its element type (`typeId`): a shared section. */
const typedText = (elements: Elements, el: BimElement, key: string): string | null => {
  const v = elementTypeValue(elements, el, key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

const nameOf = (el: BimElement & { readonly values?: Readonly<Record<string, unknown>> }, fallback: string) => textValue(el, "mark") ?? fallback;

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

type PlacementOf = (el: BimElement) => { readonly p: NonNullable<ReturnType<typeof elementPlacementOf>>["placement"]; readonly z0: number } | null;

function placementReader(elements: Elements): PlacementOf {
  return (el) => {
    const view = elementPlacementOf(elements, el);
    if (!view?.levelKnown) return null;
    const z0 = levelElevation(elements, view.placement.levelId);
    return z0 === null ? null : { p: view.placement, z0 };
  };
}

const levelRows = (elements: Elements): LevelRow[] => elementsOfKind(elements, "level").map((l) => ({ id: l.id, elevationMm: l.elevationMm }));

type ColumnElement = Extract<BimElement, { kind: "column" }>;
type ComponentElement = Extract<BimElement, { kind: "component" }>;

/** A column as the frame reads it, without its section; null when it has no placement with a level. */
function readColumn(levels: readonly LevelRow[], placementOf: PlacementOf, c: ColumnElement): FrameSupportColumn | null {
  const at = placementOf(c);
  const p = at?.p;
  if (!at || !p || (p.kind !== "line" && p.kind !== "point")) return null;
  const z0 = at.z0;
  const radiusMm = Math.max(c.size.x, c.size.y) / 2;
  if (p.kind === "line") {
    const top = p.topLevelId ? levels.find((l) => l.id === p.topLevelId)?.elevationMm ?? null : null;
    return { id: c.id, label: nameOf(c, c.id), levelId: p.levelId, position: c.position, radiusMm, baseZMm: z0 + Math.min(p.startOffsetMm, p.endOffsetMm), topZMm: top ?? z0 + Math.max(p.startOffsetMm, p.endOffsetMm), topLevelId: p.topLevelId ?? null };
  }
  // A point-placed column runs from its level to the next level up.
  const above = levelAbove(levels, z0);
  return { id: c.id, label: nameOf(c, c.id), levelId: p.levelId, position: c.position, radiusMm, baseZMm: z0 + p.offsetMm, topZMm: above?.elevationMm ?? z0 + p.offsetMm, topLevelId: above?.id ?? null };
}

const isFooting = (k: ComponentElement) => k.category === "footing" || k.classId === "struct.footing_pad";

/** A pad footing as the frame reads it; null when it has no point placement with a level. */
function readFooting(placementOf: PlacementOf, k: ComponentElement): FrameFooting | null {
  const at = placementOf(k);
  const p = at?.p;
  if (!at || p?.kind !== "point") return null;
  return { id: k.id, label: nameOf(k, k.typeName || k.id), levelId: p.levelId, position: k.position, size: k.size, rotationDeg: k.rotationDeg, topZMm: at.z0 + p.offsetMm };
}

function read(elements: Elements): Frame {
  const levels = levelRows(elements);
  const unplaced: string[] = [];
  const beams: FrameBeam[] = [];
  const columns: FrameColumn[] = [];
  const footings: FrameFooting[] = [];
  const decks: FrameDeck[] = [];
  const equipment: FrameEquipment[] = [];

  const placementOf = placementReader(elements);

  for (const b of elementsOfKind(elements, "beam")) {
    const at = placementOf(b);
    const p = at?.p;
    if (!at || p?.kind !== "line") {
      unplaced.push(b.id);
      continue;
    }
    const sectionName = typedText(elements, b, STRUCT_KEYS.section) ?? b.sectionName;
    beams.push({ id: b.id, label: nameOf(b, b.id), levelId: p.levelId, start: b.start, end: b.end, startZMm: at.z0 + p.startOffsetMm, endZMm: at.z0 + p.endOffsetMm, sectionName, section: sectionById(sectionName) });
  }

  for (const c of elementsOfKind(elements, "column")) {
    const column = readColumn(levels, placementOf, c);
    if (!column) {
      unplaced.push(c.id);
      continue;
    }
    const sectionName = typedText(elements, c, STRUCT_KEYS.section) ?? "";
    columns.push({ ...column, sectionName, section: sectionById(sectionName) });
  }

  for (const k of elementsOfKind(elements, "component")) {
    if (!isFooting(k)) continue;
    const footing = readFooting(placementOf, k);
    if (footing) footings.push(footing);
    else unplaced.push(k.id);
  }

  for (const sl of elementsOfKind(elements, "slab")) {
    // Only a one-way deck (a span direction) is structure; other slabs are not read.
    if (sl.placement?.kind !== "area" || sl.placement.spanDirectionDeg === undefined) continue;
    const at = placementOf(sl);
    const p = at?.p;
    if (!at || p?.kind !== "area" || p.spanDirectionDeg === undefined) {
      unplaced.push(sl.id);
      continue;
    }
    decks.push({ id: sl.id, label: nameOf(sl, sl.id), levelId: p.levelId, outline: sl.outline, spanDirectionDeg: p.spanDirectionDeg, useId: textValue(sl, STRUCT_KEYS.occupancy) });
  }

  for (const part of elementsOfKind(elements, "part")) {
    const type = elements[part.typeId];
    const raw = type?.kind === "part_type" ? paramValue(type.definition, part.values, OPERATING_WEIGHT_STORAGE.name) : part.values[OPERATING_WEIGHT_STORAGE.name];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    // Mass in pounds times standard gravity: the weight in newtons.
    const weight = fromCanonical("force", qty("mass", raw, OPERATING_WEIGHT_STORAGE.unit) * STANDARD_GRAVITY);
    const h = part.host;
    const host: EquipmentHost = h?.kind === "element" ? { kind: "line", elementId: h.elementId, stationMm: h.stationMm } : h?.kind === "slab" ? { kind: "slab", elementId: h.elementId } : null;
    equipment.push({ id: part.id, label: part.mark.trim() || part.id, levelId: part.levelId, position: part.position, host, weight });
  }

  const beamsByLevel = new Map<ElementId, FrameBeam[]>();
  for (const b of beams) push(beamsByLevel, b.levelId, b);
  const decksByLevel = new Map<ElementId, FrameDeck[]>();
  for (const d of decks) push(decksByLevel, d.levelId, d);
  const byId = new Map<string, FrameBeam | FrameColumn | FrameFooting | FrameDeck | FrameEquipment>();
  for (const list of [beams, columns, footings, decks, equipment]) for (const x of list) byId.set(x.id, x);
  return { beams, columns, footings, decks, equipment, beamsByLevel, decksByLevel, byId, unplaced };
}

const frames = new WeakMap<Elements, Frame>();

/** The frame of a model, read once per elements record. */
export function frameOf(model: Pick<ModelState, "elements">): Frame {
  const hit = frames.get(model.elements);
  if (hit) return hit;
  const f = read(model.elements);
  frames.set(model.elements, f);
  return f;
}

/** Columns and pad footings only: what a column bears on, without the rest of the frame. */
export interface FrameSupports {
  readonly columns: readonly FrameSupportColumn[];
  readonly footings: readonly FrameFooting[];
  readonly columnById: ReadonlyMap<string, FrameSupportColumn>;
}

interface SupportInputs {
  readonly levels: readonly BimElement[];
  readonly columns: readonly BimElement[];
  readonly components: readonly BimElement[];
}

const supportsByRecord = new WeakMap<Elements, FrameSupports>();
/** The last supports read, the record it was for, and the element objects it was read from. */
let lastSupports: { readonly record: WeakRef<Elements>; readonly inputs: SupportInputs; readonly supports: FrameSupports } | null = null;

const SUPPORT_KINDS = ["level", "column", "component"] as const;

const sameObjects = (a: readonly BimElement[], b: readonly BimElement[]) => a.length === b.length && a.every((el, i) => el === b[i]);

/**
 * The frame's columns and footings of a model, read once per elements record
 * through the kernel's kind index. An edit that changed no level, column or
 * component (every edit makes a new record) reuses the last read: placement
 * of either reads only the element and the levels, so the same objects read
 * the same. The edit's own writes say so when the record was made on the
 * last one (`kindsWrittenSince`); otherwise the three kinds are compared.
 * Lint runs this on every edit; the whole frame (every part's operating
 * weight) is a whole-model read it doesn't need.
 */
export function frameSupportsOf(model: Pick<ModelState, "elements">): FrameSupports {
  const elements = model.elements;
  const hit = supportsByRecord.get(elements);
  if (hit) return hit;
  const last = lastSupports;
  const previous = last?.record.deref();
  const written = previous ? kindsWrittenSince(elements, previous) : null;
  if (last && written && !SUPPORT_KINDS.some((k) => written.has(k))) {
    lastSupports = { record: new WeakRef(elements), inputs: last.inputs, supports: last.supports };
    supportsByRecord.set(elements, last.supports);
    return last.supports;
  }
  const inputs: SupportInputs = { levels: elementsOfKind(elements, "level"), columns: elementsOfKind(elements, "column"), components: elementsOfKind(elements, "component") };
  let supports: FrameSupports;
  if (last && sameObjects(last.inputs.levels, inputs.levels) && sameObjects(last.inputs.columns, inputs.columns) && sameObjects(last.inputs.components, inputs.components)) {
    supports = last.supports;
  } else {
    const levels = levelRows(elements);
    const placementOf = placementReader(elements);
    const columns: FrameSupportColumn[] = [];
    for (const c of inputs.columns) {
      const column = c.kind === "column" ? readColumn(levels, placementOf, c) : null;
      if (column) columns.push(column);
    }
    const footings: FrameFooting[] = [];
    for (const k of inputs.components) {
      const footing = k.kind === "component" && isFooting(k) ? readFooting(placementOf, k) : null;
      if (footing) footings.push(footing);
    }
    supports = { columns, footings, columnById: new Map(columns.map((c) => [c.id, c])) };
  }
  lastSupports = { record: new WeakRef(elements), inputs, supports };
  supportsByRecord.set(elements, supports);
  return supports;
}
