import { elementsOfKind, elementValues, modelLevels, normalizeLevelName, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { aabbOfPoints, boxConvex, p3, prismConvex, type Aabb, type Convex, type PairMeasure } from "./geometry/convex";
import { convexHull2, elementName, elementShape, levelElevation, type BodyRole } from "./shapes";
import { UniformGrid } from "./spatial/grid";
import type { LinkedElement, LinkedKind, LinkedModelIndex, LinkedRef } from "./types";

/**
 * What the engine keeps between edits: a body per element (ours and linked)
 * in one broad-phase grid, the surfaces equipment can stand on or be inside
 * (slabs, roofs, spaces, rooms) in a second grid, which run elements belong
 * to each system, and the clash measurements already made. `apply` updates
 * only the elements an edit changed.
 *
 * Per body only a box (in the grid's typed array) and a few small fields are
 * kept; solids for the narrow phase are rebuilt from the element on demand
 * (with a small cache), so a 350k-body index stays within its memory budget.
 */

type Elements = ModelState["elements"];

export type BodyKind = BodyRole | "linked_obstacle" | "linked_other";

export interface BodyRecord {
  readonly slot: number;
  readonly key: string;
  /** Our element id, or null for a linked element. */
  readonly elementId: string | null;
  readonly linked: LinkedRef | null;
  readonly linkedKind: LinkedKind | null;
  readonly kind: BodyKind;
  readonly box: Aabb;
  /** A duct or pipe running (nearly) plumb: a riser through a floor is expected, not a clash with the slab. */
  readonly plumb: boolean;
  /** A level name when the element's height is assumed: compared only with bodies of the same name (or with known heights). */
  readonly layer: string | null;
  pieces(): readonly Convex[];
}

export interface Surface {
  readonly key: string;
  readonly elementId: string | null;
  readonly linked: LinkedRef | null;
  readonly name: string;
  readonly kind: "slab" | "roof" | "space" | "room";
  readonly outline: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly bottom: number;
  readonly top: number;
  readonly level: string | null;
}

/** Linked kinds other work has to clear. Spaces, openings, ceilings, doors, windows and furniture are not clash obstacles. */
const LINKED_OBSTACLES: ReadonlySet<LinkedKind> = new Set(["slab", "roof", "wall", "column", "beam", "stair", "mep"]);
const NATIVE_SURFACE_KINDS = new Set(["slab", "room"]);
const ROOM_HEIGHT_MM = 3048;
const KINDS: readonly BodyKind[] = ["mep", "equipment", "architecture", "structure", "linked_obstacle", "linked_other"];
const KIND_CODE = new Map<BodyKind, number>(KINDS.map((k, i) => [k, i]));
const PIECE_CACHE_MAX = 4096;
/** Kinds whose body height comes from their level id (`elementShape`). */
const LEVEL_ID_KINDS = ["run_segment", "run_fitting", "part"] as const;
/** Kinds whose body or surface height comes from their partition's level name (`elementShape`, `putSurface`). */
const LEVEL_NAME_KINDS = ["duct_segment", "equipment", "wall", "column", "slab", "room"] as const;
const PAIR_CACHE_MAX = 200_000;

function hullOf(e: LinkedElement): Array<{ x: number; y: number }> {
  if (e.hull && e.hull.length >= 6) {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < e.hull.length; i += 2) pts.push({ x: e.hull[i] as number, y: e.hull[i + 1] as number });
    return pts;
  }
  const [x0, y0, , x1, y1] = e.box;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** One body as the rules read it. A class, so `pieces` is a prototype method rather than a closure per record. */
class Body implements BodyRecord {
  constructor(
    private readonly state: IndexState,
    readonly slot: number,
    readonly key: string,
    readonly elementId: string | null,
    readonly linked: LinkedRef | null,
    readonly linkedKind: LinkedKind | null,
    readonly kind: BodyKind,
    readonly box: Aabb,
    readonly plumb: boolean,
    readonly layer: string | null,
  ) {}

  pieces(): readonly Convex[] {
    return this.state.piecesAt(this.slot);
  }
}

type LinkedSurfaceKind = "slab" | "roof" | "space";

function isLinkedSurfaceKind(kind: LinkedKind): kind is LinkedSurfaceKind {
  return kind === "slab" || kind === "roof" || kind === "space";
}

/** A linked slab, roof or space read from its element when asked for; the outline is built once per read. */
class LinkedSurface implements Surface {
  private hull: Array<{ x: number; y: number }> | null = null;

  constructor(
    private readonly model: LinkedModelIndex,
    private readonly e: LinkedElement,
    readonly kind: LinkedSurfaceKind,
  ) {}

  get key(): string {
    return `linked:${this.model.modelId}:${this.e.globalId}`;
  }

  get elementId(): null {
    return null;
  }

  get linked(): LinkedRef {
    return { modelId: this.model.modelId, globalId: this.e.globalId, name: this.e.name, ifcClass: this.e.ifcClass };
  }

  get name(): string {
    return this.e.name || this.e.ifcClass;
  }

  get outline(): ReadonlyArray<{ readonly x: number; readonly y: number }> {
    this.hull ??= convexHull2(hullOf(this.e));
    return this.hull;
  }

  get bottom(): number {
    return this.e.box[2];
  }

  get top(): number {
    return this.e.box[5];
  }

  get level(): string | null {
    return this.e.storey;
  }
}

export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<{ readonly x: number; readonly y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as { x: number; y: number };
    const b = poly[j] as { x: number; y: number };
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export class IndexState {
  readonly grid = new UniformGrid();
  readonly surfaceGrid = new UniformGrid(3048);
  // Per slot.
  private keyOf: Array<string | null> = [];
  private kindOf = new Uint8Array(1024);
  private plumbOf = new Uint8Array(1024);
  /** The body's layer at a slot, as a code into `layerNames` (0: none). */
  private layerOf = new Uint16Array(1024);
  private readonly layerNames: Array<string | null> = [null];
  private readonly layerCodes = new Map<string, number>();
  private linkedModelOf = new Int32Array(1024).fill(-1);
  private linkedIdxOf = new Int32Array(1024);
  /** Our element's kind at a slot, as a code into `kindNames` (0: none). */
  private elementKindOf = new Uint16Array(1024);
  private readonly kindNames: string[] = [""];
  private readonly kindCodes = new Map<string, number>();
  private readonly slotOf = new Map<string, number>();
  private readonly free: number[] = [];
  private linkedModels: readonly LinkedModelIndex[] = [];
  private readonly pieceCache = new Map<number, readonly Convex[]>();
  // Surfaces: ours as records; linked ones as (model, element) per slot, read on demand.
  private readonly surfaces: Array<Surface | undefined> = [];
  private surfaceLinkedModelOf = new Int32Array(1024).fill(-1);
  private surfaceLinkedIdxOf = new Int32Array(1024);
  private readonly surfaceSlotOf = new Map<string, number>();
  private readonly surfaceFree: number[] = [];
  // Systems and ceilings.
  private readonly systems = new Map<string, Set<string>>();
  private readonly systemOf = new Map<string, string>();
  private readonly ceilings = new Set<string>();
  private levelElevations = new Map<string, number>();
  // Clash measurements, by pair and the far distance they were measured to.
  private readonly pairs = new Map<string, PairMeasure>();
  private readonly pairsOf = new Map<string, Set<string>>();
  private bulkDepth = 0;

  constructor(private elements: Elements) {}

  get model(): Elements {
    return this.elements;
  }

  private ensure(slot: number): void {
    if (slot < this.kindOf.length) return;
    let n = this.kindOf.length;
    while (n <= slot) n *= 2;
    const grow8 = (a: Uint8Array) => {
      const b = new Uint8Array(n);
      b.set(a);
      return b;
    };
    this.kindOf = grow8(this.kindOf);
    this.plumbOf = grow8(this.plumbOf);
    const lm = new Int32Array(n).fill(-1);
    lm.set(this.linkedModelOf);
    this.linkedModelOf = lm;
    const li = new Int32Array(n);
    li.set(this.linkedIdxOf);
    this.linkedIdxOf = li;
    const ek = new Uint16Array(n);
    ek.set(this.elementKindOf);
    this.elementKindOf = ek;
    const ly = new Uint16Array(n);
    ly.set(this.layerOf);
    this.layerOf = ly;
  }

  body(key: string): BodyRecord | undefined {
    const slot = this.slotOf.get(key);
    return slot === undefined ? undefined : this.bodyAt(slot);
  }

  /** True when `key` has a body in the grid (what `body(key)` would return), with no record built. */
  hasBody(key: string): boolean {
    const slot = this.slotOf.get(key);
    return slot !== undefined && this.grid.has(slot);
  }

  bodyAt(slot: number): BodyRecord | undefined {
    const box = this.grid.box(slot);
    if (!box) return undefined;
    const m = this.linkedModelOf[slot] ?? -1;
    const linkedEl = m >= 0 ? this.linkedModels[m]?.elements[this.linkedIdxOf[slot] ?? 0] : undefined;
    const linkedModel = m >= 0 ? this.linkedModels[m] : undefined;
    const elementId = m >= 0 ? null : (this.keyOf[slot] ?? null);
    return new Body(
      this,
      slot,
      elementId ?? `linked:${linkedModel?.modelId ?? ""}:${linkedEl?.globalId ?? ""}`,
      elementId,
      linkedEl && linkedModel ? { modelId: linkedModel.modelId, globalId: linkedEl.globalId, name: linkedEl.name, ifcClass: linkedEl.ifcClass } : null,
      linkedEl?.kind ?? null,
      KINDS[this.kindOf[slot] ?? 0] as BodyKind,
      box,
      this.plumbOf[slot] === 1,
      this.layerNames[this.layerOf[slot] ?? 0] ?? null,
    );
  }

  /** The body's name as "what's here" lists it: ours by `elementName`, a linked one by its name or class. Builds no record. */
  labelAt(slot: number, elements: Elements): string {
    const m = this.linkedModelOf[slot] ?? -1;
    if (m < 0) {
      const id = this.keyOf[slot] ?? null;
      if (id) return elementName(elements, elements[id] as BimElement);
      return id ?? "linked::";
    }
    const model = this.linkedModels[m];
    const e = model?.elements[this.linkedIdxOf[slot] ?? 0];
    if (e && model) return `${e.name || e.ifcClass} (linked)`;
    return `linked:${model?.modelId ?? ""}:${e?.globalId ?? ""}`;
  }

  /** Our element id at a slot; null for a linked body or an empty slot. Builds no record. */
  elementIdAt(slot: number): string | null {
    return (this.linkedModelOf[slot] ?? -1) >= 0 ? null : (this.keyOf[slot] ?? null);
  }

  /** A linked body's kind at a slot; null for ours or an empty slot. Builds no record. */
  linkedKindAt(slot: number): LinkedKind | null {
    const m = this.linkedModelOf[slot] ?? -1;
    return m >= 0 ? (this.linkedModels[m]?.elements[this.linkedIdxOf[slot] ?? 0]?.kind ?? null) : null;
  }

  /** Our element's kind at a slot; null for a linked body or an empty slot. */
  elementKindAt(slot: number): string | null {
    return this.kindNames[this.elementKindOf[slot] ?? 0] || null;
  }

  private kindCode(kind: string): number {
    let code = this.kindCodes.get(kind);
    if (code === undefined) {
      code = this.kindNames.length;
      this.kindNames.push(kind);
      this.kindCodes.set(kind, code);
    }
    return code;
  }

  private layerCode(layer: string | null): number {
    if (layer === null) return 0;
    let code = this.layerCodes.get(layer);
    if (code === undefined) {
      code = this.layerNames.length;
      if (code > 0xffff) throw new Error("The lint index holds at most 65,535 level names; this model names more");
      this.layerNames.push(layer);
      this.layerCodes.set(layer, code);
    }
    return code;
  }

  slotOfKey(key: string): number | undefined {
    return this.slotOf.get(key);
  }

  /** Slots of clash candidates near a box (see obstaclesNear), with no records built. */
  obstacleSlotsNear(box: Aabb): number[] {
    const other = KIND_CODE.get("linked_other");
    const slots = this.grid.query(box);
    let n = 0;
    for (const slot of slots) if (this.kindOf[slot] !== other) slots[n++] = slot;
    slots.length = n;
    return slots;
  }

  /** The narrow-phase solids of the body at a slot (cached). */
  piecesAt(slot: number): readonly Convex[] {
    const known = this.pieceCache.get(slot);
    if (known) return known;
    let pieces: readonly Convex[] = [];
    const m = this.linkedModelOf[slot] ?? -1;
    if (m >= 0) {
      const e = this.linkedModels[m]?.elements[this.linkedIdxOf[slot] ?? 0];
      if (e) {
        const [x0, y0, z0, x1, y1, z1] = e.box;
        pieces = e.hull && e.hull.length >= 6 ? [prismConvex(convexHull2(hullOf(e)), z0, z1)] : [boxConvex({ min: p3(x0, y0, z0), max: p3(x1, y1, z1) })];
      }
    } else {
      const id = this.keyOf[slot];
      const el = id ? this.elements[id] : undefined;
      const shape = el ? elementShape(this.elements, el, (n) => this.elevationOfLevel(n)) : null;
      pieces = shape ? shape.pieces() : [];
    }
    if (this.pieceCache.size >= PIECE_CACHE_MAX) {
      const oldest = this.pieceCache.keys().next();
      if (!oldest.done) this.pieceCache.delete(oldest.value);
    }
    this.pieceCache.set(slot, pieces);
    return pieces;
  }

  /** Clash candidates near a box: our bodies and linked obstacles, never linked spaces, openings, ceilings or furniture. Filtered before any record is built. */
  obstaclesNear(box: Aabb): BodyRecord[] {
    const out: BodyRecord[] = [];
    for (const slot of this.obstacleSlotsNear(box)) {
      const b = this.bodyAt(slot);
      if (b) out.push(b);
    }
    return out;
  }

  surfaceAt(slot: number): Surface | undefined {
    const own = this.surfaces[slot];
    if (own) return own;
    const m = this.surfaceLinkedModelOf[slot] ?? -1;
    if (m < 0) return undefined;
    const model = this.linkedModels[m];
    const e = model?.elements[this.surfaceLinkedIdxOf[slot] ?? 0];
    return model && e && isLinkedSurfaceKind(e.kind) ? new LinkedSurface(model, e, e.kind) : undefined;
  }

  hasNativeCeilings(): boolean {
    return this.ceilings.size > 0;
  }

  nativeCeilings(): string[] {
    return [...this.ceilings];
  }

  systemMembers(systemId: string): readonly string[] {
    return [...(this.systems.get(systemId) ?? [])].sort();
  }

  elevationOfLevel(name: string): number | null {
    return this.levelElevations.get(name) ?? this.levelElevations.get(`~${normalizeLevelName(name)}`) ?? null;
  }

  // ---- clash measurement cache

  pair(a: string, b: string, far: number): PairMeasure | undefined {
    return this.pairs.get(a < b ? `${a}|${b}|${far}` : `${b}|${a}|${far}`);
  }

  setPair(a: string, b: string, far: number, m: PairMeasure): void {
    if (this.pairs.size >= PAIR_CACHE_MAX) this.clearPairs();
    const key = a < b ? `${a}|${b}|${far}` : `${b}|${a}|${far}`;
    this.pairs.set(key, m);
    for (const id of [a, b]) {
      const set = this.pairsOf.get(id) ?? new Set<string>();
      set.add(key);
      this.pairsOf.set(id, set);
    }
  }

  private forgetPairs(id: string): void {
    const keys = this.pairsOf.get(id);
    if (!keys) return;
    for (const k of keys) this.pairs.delete(k);
    this.pairsOf.delete(id);
  }

  private clearPairs(): void {
    this.pairs.clear();
    this.pairsOf.clear();
  }

  private refreshLevels(): void {
    const map = new Map<string, number>();
    for (const l of modelLevels({ elements: this.elements })) {
      map.set(l.name, l.elevationMm);
      map.set(`~${normalizeLevelName(l.name)}`, l.elevationMm);
    }
    this.levelElevations = map;
  }

  /** Index every element of the model. */
  buildAll(): void {
    this.bulkLoad(() => {
      this.refreshLevels();
      for (const el of elementValues(this.elements)) this.put(el);
    });
  }

  /** The model moved to `next` with only `changedIds` changed or removed. */
  apply(next: Elements, changedIds: Iterable<string>): void {
    const prev = this.elements;
    const ids = [...changedIds];
    const kindChanged = (kind: BimElement["kind"]) => ids.some((id) => prev[id]?.kind === kind || next[id]?.kind === kind);
    this.elements = next;
    if (kindChanged("level")) {
      // A level edit moves what stands on that level: re-read only the bodies and surfaces whose height it gives.
      const before = this.levelElevations;
      this.refreshLevels();
      for (const el of this.levelDependents(prev, next, ids, before)) {
        this.forgetPairs(el.id);
        this.put(el);
      }
    }
    if (kindChanged("part_type")) {
      const types = new Set(ids.filter((id) => prev[id]?.kind === "part_type" || next[id]?.kind === "part_type"));
      for (const el of elementsOfKind(next, "part")) {
        if (types.has(el.typeId)) {
          this.forgetPairs(el.id);
          this.put(el);
        }
      }
    }
    for (const id of ids) {
      this.forgetPairs(id);
      const el = next[id];
      if (el) this.put(el);
      else this.drop(id);
    }
  }

  /**
   * Elements not among `ids` whose body or surface height a level edit
   * changes: runs and parts on a level id whose elevation moved, and
   * elements whose partition's level name now resolves to another height.
   * Read from the kind index over the kinds that take a height from a level.
   */
  private levelDependents(prev: Elements, next: Elements, ids: readonly string[], before: ReadonlyMap<string, number>): BimElement[] {
    const movedIds = new Set<string>();
    for (const id of ids) {
      const a = prev[id];
      const b = next[id];
      if (a?.kind !== "level" && b?.kind !== "level") continue;
      if (levelElevation(prev, id) !== levelElevation(next, id)) movedIds.add(id);
    }
    const resolved = new Map<string, boolean>();
    const nameMoved = (name: string): boolean => {
      let moved = resolved.get(name);
      if (moved === undefined) {
        const was = before.get(name) ?? before.get(`~${normalizeLevelName(name)}`) ?? null;
        moved = was !== this.elevationOfLevel(name);
        resolved.set(name, moved);
      }
      return moved;
    };
    const changed = new Set(ids);
    const out: BimElement[] = [];
    if (movedIds.size > 0) for (const el of elementsOfKind(next, ...LEVEL_ID_KINDS)) if (!changed.has(el.id) && movedIds.has(el.levelId)) out.push(el);
    for (const el of elementsOfKind(next, ...LEVEL_NAME_KINDS)) {
      if (changed.has(el.id)) continue;
      const name = el.partition?.level;
      if (name && nameMoved(name)) out.push(el);
    }
    return out;
  }

  private put(el: BimElement): void {
    const id = el.id as string;
    this.trackSystem(el);
    this.putSurface(el);
    if (el.kind === "component" && el.category === "ceiling") this.ceilings.add(id);
    else this.ceilings.delete(id);
    const shape = elementShape(this.elements, el, (n) => this.elevationOfLevel(n));
    if (!shape) {
      this.dropBody(id);
      return;
    }
    let slot = this.slotOf.get(id);
    if (slot === undefined) {
      slot = this.free.pop() ?? this.keyOf.length;
      this.slotOf.set(id, slot);
    }
    this.ensure(slot);
    this.keyOf[slot] = id;
    this.kindOf[slot] = KIND_CODE.get(shape.role) ?? 0;
    this.plumbOf[slot] = el.kind === "run_segment" && Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 0.15 * Math.abs(el.end.z - el.start.z) ? 1 : 0;
    this.layerOf[slot] = this.layerCode(shape.layer ?? null);
    this.linkedModelOf[slot] = -1;
    this.elementKindOf[slot] = this.kindCode(el.kind);
    this.pieceCache.delete(slot);
    this.grid.insert(slot, shape.box);
  }

  private drop(id: string): void {
    this.dropBody(id);
    this.dropSurface(id);
    this.ceilings.delete(id);
    const sys = this.systemOf.get(id);
    if (sys) this.systems.get(sys)?.delete(id);
    this.systemOf.delete(id);
  }

  private trackSystem(el: BimElement): void {
    const id = el.id as string;
    const before = this.systemOf.get(id);
    const now = el.kind === "run_segment" || el.kind === "run_fitting" ? (el.systemId as string) : undefined;
    if (before === now) return;
    if (before) this.systems.get(before)?.delete(id);
    if (now) {
      const set = this.systems.get(now) ?? new Set<string>();
      set.add(id);
      this.systems.set(now, set);
      this.systemOf.set(id, now);
    } else {
      this.systemOf.delete(id);
    }
  }

  private dropBody(key: string): void {
    const slot = this.slotOf.get(key);
    if (slot === undefined) return;
    this.releaseSlot(slot);
    this.slotOf.delete(key);
  }

  private releaseSlot(slot: number): void {
    this.grid.remove(slot);
    this.keyOf[slot] = null;
    this.layerOf[slot] = 0;
    this.linkedModelOf[slot] = -1;
    this.elementKindOf[slot] = 0;
    this.pieceCache.delete(slot);
    this.free.push(slot);
  }

  private putSurface(el: BimElement): void {
    if (!NATIVE_SURFACE_KINDS.has(el.kind)) return;
    const id = el.id as string;
    const levelName = el.partition?.level ?? null;
    const floor = levelName ? this.elevationOfLevel(levelName) : null;
    if (el.kind === "slab" && el.outline.length >= 3) {
      const top = floor ?? 0;
      this.setSurface({ key: id, elementId: id, linked: null, name: "slab", kind: "slab", outline: el.outline, bottom: top - el.thickness, top, level: levelName });
      return;
    }
    if (el.kind === "room" && el.outline.length >= 3) {
      const bottom = floor ?? 0;
      this.setSurface({ key: id, elementId: id, linked: null, name: `room ${[el.number, el.name].filter(Boolean).join(" ")}`.trim(), kind: "room", outline: el.outline, bottom, top: bottom + ROOM_HEIGHT_MM, level: levelName });
      return;
    }
    this.dropSurface(id);
  }

  private ensureSurface(slot: number): void {
    if (slot < this.surfaceLinkedModelOf.length) return;
    let n = this.surfaceLinkedModelOf.length;
    while (n <= slot) n *= 2;
    const lm = new Int32Array(n).fill(-1);
    lm.set(this.surfaceLinkedModelOf);
    this.surfaceLinkedModelOf = lm;
    const li = new Int32Array(n);
    li.set(this.surfaceLinkedIdxOf);
    this.surfaceLinkedIdxOf = li;
  }

  private setSurface(s: Surface): void {
    let slot = this.surfaceSlotOf.get(s.key);
    if (slot === undefined) {
      slot = this.surfaceFree.pop() ?? this.surfaces.length;
      this.surfaceSlotOf.set(s.key, slot);
    }
    this.ensureSurface(slot);
    this.surfaces[slot] = s;
    this.surfaceLinkedModelOf[slot] = -1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of s.outline) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    this.surfaceGrid.insert(slot, { min: p3(x0, y0, s.bottom), max: p3(x1, y1, s.top) });
  }

  /** A linked slab, roof or space: only its (model, element) is kept; `surfaceAt` reads the rest from the element. */
  private setLinkedSurface(mi: number, ei: number, e: LinkedElement): void {
    const slot = this.surfaceFree.pop() ?? this.surfaces.length;
    this.ensureSurface(slot);
    this.surfaces[slot] = undefined;
    this.surfaceLinkedModelOf[slot] = mi;
    this.surfaceLinkedIdxOf[slot] = ei;
    // The plan hull's box is its points' box, so the outline itself is built only when read.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of hullOf(e)) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    this.surfaceGrid.insert(slot, { min: p3(x0, y0, e.box[2]), max: p3(x1, y1, e.box[5]) });
  }

  private dropSurface(key: string): void {
    const slot = this.surfaceSlotOf.get(key);
    if (slot === undefined) return;
    this.surfaceGrid.remove(slot);
    this.surfaces[slot] = undefined;
    this.surfaceSlotOf.delete(key);
    this.surfaceFree.push(slot);
  }

  /** Replace every linked body and surface with these models' (read-only) elements. */
  setLinked(models: readonly LinkedModelIndex[]): void {
    this.bulkLoad(() => {
      const slots = this.keyOf.length;
      for (let slot = 0; slot < slots; slot++) if ((this.linkedModelOf[slot] ?? -1) >= 0) this.releaseSlot(slot);
      const surfaceSlots = this.surfaces.length;
      for (let slot = 0; slot < surfaceSlots; slot++) {
        if ((this.surfaceLinkedModelOf[slot] ?? -1) < 0) continue;
        this.surfaceGrid.remove(slot);
        this.surfaceLinkedModelOf[slot] = -1;
        this.surfaceFree.push(slot);
      }
      this.clearPairs();
      this.linkedModels = models;
      models.forEach((m, mi) => {
        m.elements.forEach((e, ei) => {
          const slot = this.free.pop() ?? this.keyOf.length;
          this.ensure(slot);
          this.keyOf[slot] = null;
          this.kindOf[slot] = KIND_CODE.get(LINKED_OBSTACLES.has(e.kind) ? "linked_obstacle" : "linked_other") ?? 0;
          this.plumbOf[slot] = 0;
          this.layerOf[slot] = 0;
          this.linkedModelOf[slot] = mi;
          this.linkedIdxOf[slot] = ei;
          this.elementKindOf[slot] = 0;
          const [x0, y0, z0, x1, y1, z1] = e.box;
          this.grid.insert(slot, { min: p3(x0, y0, z0), max: p3(x1, y1, z1) });
          if (isLinkedSurfaceKind(e.kind)) this.setLinkedSurface(mi, ei, e);
        });
      });
    });
  }

  /**
   * Run `load` as one bulk load of both grids (an index build, a linked-model
   * swap): bodies are laid out together at the end, with the same answers as
   * one at a time. Nested calls join the outer load.
   */
  bulkLoad(load: () => void): void {
    this.bulkDepth += 1;
    if (this.bulkDepth === 1) {
      this.grid.beginBulk();
      this.surfaceGrid.beginBulk();
    }
    try {
      load();
    } finally {
      this.bulkDepth -= 1;
      if (this.bulkDepth === 0) {
        this.grid.endBulk();
        this.surfaceGrid.endBulk();
      }
    }
  }

  /** Our element's level elevation (runs and parts carry a level id). */
  levelElevation(levelId: string): number {
    return levelElevation(this.elements, levelId);
  }

  /** Plan box of a point list (views' crops, sheets). */
  static planBox(points: ReadonlyArray<{ readonly x: number; readonly y: number }>, z0: number, z1: number): Aabb {
    const b = aabbOfPoints(points.map((q) => p3(q.x, q.y, 0)));
    return { min: p3(b.min.x, b.min.y, z0), max: p3(b.max.x, b.max.y, z1) };
  }
}
