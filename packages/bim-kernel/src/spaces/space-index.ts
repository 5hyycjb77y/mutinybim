import { loadPointPosition } from "../load-points/model";
import { registerRevisionCarry } from "../revision-carry";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Room, Vec2 } from "../types";
import type { SpaceLocator } from "../requirements/locator";
import { boxOf, containsPoint, inBox, spaceAreaM2, spaceOutlines, type Box } from "./space-geometry";
import { designOccupants } from "./space-use";
import type { DrawingUnderlay, Space, Zone } from "./types";
import { zoneSpaceIds } from "./zone-bounds";

/**
 * Where spaces are: by level, by zone, the ones not drawn yet, and a plan grid
 * per level so "which space is this point in" reads a handful of candidates,
 * never every space.
 *
 * Incremental: one index follows a model as it changes. Asking for a new
 * revision compares the spaces, zones and underlays (an `elementsOfKind` read:
 * the matches, not the model) with what the index holds by identity, and
 * re-measures and re-grids only the ones that changed, plus spaces whose rooms
 * changed. `advanceSpaceIndex` takes the changed ids directly when the caller
 * has them. Always query with the elements you hold; the index re-binds to the
 * revision asked for.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Plan grid cell: about a 16 ft bay. */
export const SPACE_GRID_MM = 5000;
/** A space spanning more cells than this sits in its level's wide list instead (a whole-floor block load). */
const MAX_CELLS = 256;

interface SpaceEntry {
  readonly space: Space;
  readonly levelId: ElementId | null;
  readonly outlines: ReadonlyArray<readonly Vec2[]>;
  readonly box: Box | null;
  readonly areaM2: number | null;
  readonly cells: readonly string[];
  /** The rooms it was measured from, by identity, so a room edit re-measures it. */
  readonly rooms: readonly Room[];
}

interface LevelGrid {
  readonly cells: Map<string, Set<ElementId>>;
  readonly wide: Set<ElementId>;
}

export interface SpaceIndexStats {
  /** Spaces measured and gridded since the index was made (all of them once, then only what changed). */
  readonly measured: number;
  readonly syncs: number;
  /** Times every space was re-read because no index was bound to the revision before. */
  readonly fullSyncs: number;
}

class SpaceIndexState {
  bound: Elements;
  readonly spaces = new Map<ElementId, SpaceEntry>();
  readonly zones = new Map<ElementId, Zone>();
  readonly underlays = new Map<ElementId, DrawingUnderlay>();
  readonly byLevel = new Map<ElementId, Set<ElementId>>();
  readonly planned = new Set<ElementId>();
  readonly grids = new Map<ElementId, LevelGrid>();
  readonly zonesOfSpace = new Map<ElementId, Set<ElementId>>();
  readonly spacesOfRoom = new Map<ElementId, Set<ElementId>>();
  /** Spaces bounded by walls, by level: the ones a bounding element's edit may re-trace. */
  readonly boundedByLevel = new Map<ElementId, Set<ElementId>>();
  measured = 0;
  syncs = 0;
  fullSyncs = 0;

  constructor(elements: Elements) {
    this.bound = elements;
  }
}

const byElements = new WeakMap<Elements, SpaceIndexState>();
/** The index most recently synced, which the next revision is diffed from. */
let latest: SpaceIndexState | null = null;

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

function cellsOf(box: Box): string[] | null {
  const x0 = Math.floor(box.minX / SPACE_GRID_MM);
  const x1 = Math.floor(box.maxX / SPACE_GRID_MM);
  const y0 = Math.floor(box.minY / SPACE_GRID_MM);
  const y1 = Math.floor(box.maxY / SPACE_GRID_MM);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(cellKey(x, y));
  return out;
}

function grid(state: SpaceIndexState, levelId: ElementId): LevelGrid {
  let g = state.grids.get(levelId);
  if (!g) {
    g = { cells: new Map(), wide: new Set() };
    state.grids.set(levelId, g);
  }
  return g;
}

function unplace(state: SpaceIndexState, entry: SpaceEntry): void {
  const id = entry.space.id;
  state.planned.delete(id);
  for (const r of entry.rooms) state.spacesOfRoom.get(r.id)?.delete(id);
  if (entry.space.bounds.kind === "rooms") for (const r of entry.space.bounds.roomIds) state.spacesOfRoom.get(r)?.delete(id);
  if (entry.space.bounds.kind === "bounded") state.boundedByLevel.get(entry.space.bounds.levelId)?.delete(id);
  if (!entry.levelId) return;
  state.byLevel.get(entry.levelId)?.delete(id);
  const g = state.grids.get(entry.levelId);
  if (!g) return;
  g.wide.delete(id);
  for (const c of entry.cells) g.cells.get(c)?.delete(id);
}

function place(state: SpaceIndexState, elements: Elements, space: Space): void {
  const prior = state.spaces.get(space.id);
  if (prior) unplace(state, prior);
  state.measured += 1;
  const outlines = spaceOutlines(elements, space).filter((o) => o.length >= 3);
  const rooms: Room[] = [];
  if (space.bounds.kind === "rooms") {
    for (const r of space.bounds.roomIds) {
      const room = elements[r];
      if (room?.kind === "room") rooms.push(room);
      let set = state.spacesOfRoom.get(r);
      if (!set) {
        set = new Set();
        state.spacesOfRoom.set(r, set);
      }
      set.add(space.id);
    }
  }
  if (space.bounds.kind === "bounded") {
    let set = state.boundedByLevel.get(space.bounds.levelId);
    if (!set) {
      set = new Set();
      state.boundedByLevel.set(space.bounds.levelId, set);
    }
    set.add(space.id);
  }
  const box = outlines.length > 0 ? boxOf(outlines.flat()) : null;
  const levelId = space.levelId ?? null;
  let cells: string[] = [];
  if (!levelId || !box) state.planned.add(space.id);
  if (levelId) {
    let ids = state.byLevel.get(levelId);
    if (!ids) {
      ids = new Set();
      state.byLevel.set(levelId, ids);
    }
    ids.add(space.id);
    if (box) {
      const g = grid(state, levelId);
      const c = cellsOf(box);
      if (c === null) g.wide.add(space.id);
      else {
        cells = c;
        for (const k of c) {
          let set = g.cells.get(k);
          if (!set) {
            set = new Set();
            g.cells.set(k, set);
          }
          set.add(space.id);
        }
      }
    }
  }
  state.spaces.set(space.id, { space, levelId, outlines, box, areaM2: spaceAreaM2(elements, space), cells, rooms });
}

function forget(state: SpaceIndexState, id: ElementId): void {
  const entry = state.spaces.get(id);
  if (!entry) return;
  unplace(state, entry);
  state.spaces.delete(id);
}

function setZone(state: SpaceIndexState, zone: Zone | null, id: ElementId): void {
  const prior = state.zones.get(id);
  if (prior) for (const s of zoneSpaceIds(prior)) state.zonesOfSpace.get(s)?.delete(id);
  if (!zone) {
    state.zones.delete(id);
    return;
  }
  state.zones.set(id, zone);
  for (const s of zoneSpaceIds(zone)) {
    let set = state.zonesOfSpace.get(s);
    if (!set) {
      set = new Set();
      state.zonesOfSpace.set(s, set);
    }
    set.add(id);
  }
}

function roomsChanged(elements: Elements, entry: SpaceEntry): boolean {
  if (entry.space.bounds.kind !== "rooms") return false;
  const ids = entry.space.bounds.roomIds;
  const present = ids.filter((r) => elements[r]?.kind === "room").length;
  if (present !== entry.rooms.length) return true;
  return entry.rooms.some((r) => elements[r.id] !== r);
}

function sync(state: SpaceIndexState, elements: Elements): void {
  state.syncs += 1;
  state.fullSyncs += 1;
  const seen = new Set<ElementId>();
  for (const s of elementsOfKind(elements, "space")) {
    seen.add(s.id);
    const entry = state.spaces.get(s.id);
    if (!entry || entry.space !== s || roomsChanged(elements, entry)) place(state, elements, s);
  }
  for (const id of [...state.spaces.keys()]) if (!seen.has(id)) forget(state, id);
  const zoneSeen = new Set<ElementId>();
  for (const z of elementsOfKind(elements, "zone")) {
    zoneSeen.add(z.id);
    if (state.zones.get(z.id) !== z) setZone(state, z, z.id);
  }
  for (const id of [...state.zones.keys()]) if (!zoneSeen.has(id)) setZone(state, null, id);
  state.underlays.clear();
  for (const u of elementsOfKind(elements, "drawing_underlay")) state.underlays.set(u.id, u);
  rebind(state, elements);
}

function rebind(state: SpaceIndexState, elements: Elements): void {
  if (state.bound !== elements) byElements.delete(state.bound);
  state.bound = elements;
  byElements.set(elements, state);
  latest = state;
}

function indexFor(elements: Elements): SpaceIndexState {
  const hit = byElements.get(elements);
  if (hit && hit.bound === elements) return hit;
  const stepped = previewIndex(elements);
  if (stepped) return stepped;
  const state = latest ?? new SpaceIndexState(elements);
  sync(state, elements);
  return state;
}

/**
 * Move an index along by the ids a command changed or removed (an `ExecuteOk`'s
 * `changedIds` / `removedIds`): O(changed), no kind read at all.
 */
export function advanceSpaceIndex(previous: Elements, next: Elements, changedIds: readonly ElementId[], removedIds: readonly ElementId[]): void {
  const state = byElements.get(previous);
  if (!state || state.bound !== previous) {
    indexFor(next);
    return;
  }
  state.syncs += 1;
  const touchedRooms = new Set<ElementId>();
  for (const id of [...changedIds, ...removedIds]) {
    const el = next[id];
    if (el?.kind === "space") place(state, next, el);
    else if (el?.kind === "zone") setZone(state, el, id);
    else if (el?.kind === "drawing_underlay") state.underlays.set(id, el);
    else if (!el) {
      forget(state, id);
      if (state.zones.has(id)) setZone(state, null, id);
      state.underlays.delete(id);
    }
    if ((el?.kind === "room" || !el) && state.spacesOfRoom.has(id)) touchedRooms.add(id);
  }
  for (const r of touchedRooms) {
    for (const s of [...(state.spacesOfRoom.get(r) ?? [])]) {
      const space = next[s];
      if (space?.kind === "space") place(state, next, space);
    }
  }
  rebind(state, next);
}

/**
 * Runs `read` with the index moved to `next` (one edit's result on
 * `previous`, not committed: a preflight), then moves it back. O(changed)
 * both ways: the preview never re-reads every space, and the head keeps its
 * index for the next preview. With no index bound to `previous`, `read`
 * builds what it needs as before.
 */
export function withSpaceIndexAt<T>(previous: Elements, next: Elements, changedIds: readonly ElementId[], removedIds: readonly ElementId[], read: () => T): T {
  // The command may already have moved the head's index onto its result; either side will do.
  const holds = (e: Elements) => byElements.get(e)?.bound === e;
  if (previous === next || (!holds(previous) && !holds(next))) return read();
  const outer = preview;
  preview = { head: previous, next, changedIds, removedIds, neutral: !touchesIndex(previous, next, [...changedIds, ...removedIds]) };
  try {
    return read();
  } finally {
    preview = outer;
    // Ids the edit created are gone from `previous` (forgotten); ids it removed are there again (re-placed).
    if (byElements.get(next)?.bound === next) advanceSpaceIndex(next, previous, [...changedIds, ...removedIds], []);
  }
}

/** The preflight in progress: its head, its preview, the ids between them, and whether any of them is something this index holds. */
let preview: { readonly head: Elements; readonly next: Elements; readonly changedIds: readonly ElementId[]; readonly removedIds: readonly ElementId[]; readonly neutral: boolean } | null = null;

const INDEXED_KINDS: ReadonlySet<string> = new Set(["space", "zone", "drawing_underlay", "room"]);

function touchesIndex(a: Elements, b: Elements, ids: readonly ElementId[]): boolean {
  return ids.some((id) => INDEXED_KINDS.has(a[id]?.kind ?? "") || INDEXED_KINDS.has(b[id]?.kind ?? ""));
}

/** During a preflight, the index for its head or its preview without a full read: shared when the edit touches nothing indexed, else stepped by the edit's ids. */
function previewIndex(elements: Elements): SpaceIndexState | null {
  const p = preview;
  if (!p || (elements !== p.head && elements !== p.next)) return null;
  const other = elements === p.head ? p.next : p.head;
  const held = byElements.get(other);
  if (!held || held.bound !== other) return null;
  if (p.neutral) return held;
  if (elements === p.next) advanceSpaceIndex(p.head, p.next, p.changedIds, p.removedIds);
  else advanceSpaceIndex(p.next, p.head, [...p.changedIds, ...p.removedIds], []);
  const moved = byElements.get(elements);
  return moved && moved.bound === elements ? moved : null;
}

// Each new revision moves a bound index along by the ids it changed, so the next read does not re-read every space.
registerRevisionCarry("spaces.index", (from, to, changedIds) => {
  const state = byElements.get(from);
  if (!state || state.bound !== from) return;
  // Removed ids are in the list too; advanceSpaceIndex forgets an id the new revision no longer has.
  advanceSpaceIndex(from, to, changedIds.flatMap((id) => { const el = to[id] ?? from[id]; return el ? [el.id] : []; }), []);
});

// ---------------------------------------------------------------- reads

export interface SpaceIndexMeasure {
  readonly areaM2: number | null;
  readonly levelId: ElementId | null;
  readonly box: Box | null;
}

export function spaceMeasure(elements: Elements, spaceId: ElementId): SpaceIndexMeasure | null {
  const e = indexFor(elements).spaces.get(spaceId);
  return e ? { areaM2: e.areaM2, levelId: e.levelId, box: e.box } : null;
}

export function spacesOnLevel(elements: Elements, levelId: ElementId): Space[] {
  const state = indexFor(elements);
  return [...(state.byLevel.get(levelId) ?? [])].flatMap((id) => {
    const e = state.spaces.get(id);
    return e ? [e.space] : [];
  });
}

/** Spaces typed into a table and not drawn yet (no level, or no outline). */
export function plannedSpaces(elements: Elements): Space[] {
  const state = indexFor(elements);
  return [...state.planned].flatMap((id) => {
    const e = state.spaces.get(id);
    return e ? [e.space] : [];
  });
}

export function zonesOfSpace(elements: Elements, spaceId: ElementId): Zone[] {
  const state = indexFor(elements);
  return [...(state.zonesOfSpace.get(spaceId) ?? [])].flatMap((id) => {
    const z = state.zones.get(id);
    return z ? [z] : [];
  });
}

export function spacesOfZone(elements: Elements, zoneId: ElementId): Space[] {
  const state = indexFor(elements);
  const zone = state.zones.get(zoneId);
  if (!zone) return [];
  return zoneSpaceIds(zone).flatMap((id) => {
    const e = state.spaces.get(id);
    return e ? [e.space] : [];
  });
}

/** Zones a piece of equipment serves (RTU-2 → Zone 2 Kitchen). */
export function zonesServedBy(elements: Elements, equipmentId: ElementId): Zone[] {
  return [...indexFor(elements).zones.values()].filter((z) => z.servedBy === equipmentId);
}

export function underlaysOnLevel(elements: Elements, levelId: ElementId): DrawingUnderlay[] {
  return [...indexFor(elements).underlays.values()].filter((u) => u.levelId === levelId);
}

/** Levels that hold a space bounded by walls. */
export function levelsWithBoundedSpaces(elements: Elements): ElementId[] {
  return [...indexFor(elements).boundedByLevel].flatMap(([levelId, ids]) => (ids.size > 0 ? [levelId] : []));
}

/** Bounded spaces on a level whose outline box meets `box`, in id order. */
export function boundedSpacesMeeting(elements: Elements, levelId: ElementId, box: Box): Space[] {
  const state = indexFor(elements);
  const out: Space[] = [];
  for (const id of state.boundedByLevel.get(levelId) ?? []) {
    const e = state.spaces.get(id);
    if (e?.box && e.box.minX <= box.maxX && e.box.maxX >= box.minX && e.box.minY <= box.maxY && e.box.maxY >= box.minY) out.push(e.space);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Bounded spaces whose walls left them open (`bounds.open`), in id order. */
export function openBoundedSpaces(elements: Elements): Space[] {
  const state = indexFor(elements);
  const out: Space[] = [];
  for (const ids of state.boundedByLevel.values()) for (const id of ids) {
    const s = state.spaces.get(id)?.space;
    if (s?.bounds.kind === "bounded" && s.bounds.open) out.push(s);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The space on a level whose floor holds a plan point. When spaces overlap (a
 * dwelling block drawn over its rooms) the smallest one wins: it is the more
 * specific answer.
 */
export function spaceAt(elements: Elements, levelId: ElementId, point: Vec2): Space | null {
  const state = indexFor(elements);
  const g = state.grids.get(levelId);
  if (!g) return null;
  const cell = g.cells.get(cellKey(Math.floor(point.x / SPACE_GRID_MM), Math.floor(point.y / SPACE_GRID_MM)));
  let best: SpaceEntry | null = null;
  for (const id of [...(cell ?? []), ...g.wide]) {
    const e = state.spaces.get(id);
    if (!e?.box || !inBox(point, e.box)) continue;
    if (!e.outlines.some((o) => containsPoint(o, point))) continue;
    if (!best || (e.areaM2 ?? Infinity) < (best.areaM2 ?? Infinity)) best = e;
  }
  return best ? best.space : null;
}

/** Where an element is, for `spaceOf`: a level and a plan point, or the space it names. */
function locate(elements: Elements, el: BimElement): { readonly levelId: ElementId; readonly point: Vec2 } | { readonly spaceId: ElementId } | null {
  switch (el.kind) {
    case "part":
      if (el.planned) return el.planned.spaceHint ? { spaceId: el.planned.spaceHint } : null;
      return { levelId: el.levelId, point: el.position };
    case "load_point": {
      const anchor = el.anchor;
      if (anchor?.kind === "space") return { spaceId: anchor.id };
      if (anchor?.kind === "point") return { levelId: anchor.levelId, point: anchor.position };
      if (anchor?.kind === "part") {
        const part = elements[anchor.partId];
        return part ? locate(elements, part) : null;
      }
      if (anchor?.kind === "zone" || anchor?.kind === "none") return null;
      const at = loadPointPosition(elements, el);
      return at ? { levelId: at.levelId, point: { x: at.point.x, y: at.point.y } } : null;
    }
    case "run_segment":
      return { levelId: el.levelId, point: { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 } };
    case "run_fitting":
      return { levelId: el.levelId, point: { x: el.position.x, y: el.position.y } };
    default:
      return null;
  }
}

/**
 * Which space a placed part, load point or point is in. Planned parts answer
 * with their space hint; a load anchored to a space answers with that space;
 * a load on a zone, or a row with no anchor, is in no one space (null).
 */
export function spaceOf(elements: Elements, target: ElementId | { readonly levelId: ElementId; readonly point: Vec2 }): Space | null {
  if (typeof target !== "string") return spaceAt(elements, target.levelId, target.point);
  const el = elements[target];
  if (!el) return null;
  if (el.kind === "space") return el;
  const at = locate(elements, el);
  if (!at) return null;
  if ("spaceId" in at) {
    const s = elements[at.spaceId];
    return s?.kind === "space" ? s : null;
  }
  return spaceAt(elements, at.levelId, at.point);
}

/**
 * The model's spaces as the requirements seam reads them (requirements/locator.ts):
 * every answer an indexed read. Occupants are the design occupants (typed, or
 * the use's density × area); a space not drawn yet has no measure.
 */
export function modelSpaceLocator(elements: Elements): SpaceLocator {
  return {
    spaceOf: (id) => spaceOf(elements, id)?.id,
    spaceAt: (levelId, position) => spaceAt(elements, levelId, position)?.id,
    zonesOf: (spaceId) => zonesOfSpace(elements, spaceId).map((z) => z.id),
    spacesOf: (zoneId) => spacesOfZone(elements, zoneId).map((s) => s.id),
    measureOf: (spaceId) => {
      const space = elements[spaceId];
      const areaSqM = spaceMeasure(elements, spaceId)?.areaM2 ?? null;
      if (space?.kind !== "space" || areaSqM === null) return undefined;
      return { areaSqM, occupants: designOccupants(space, areaSqM)?.value ?? 0 };
    },
    dependenciesOf: (id) => {
      const s = spaceOf(elements, id);
      if (!s) return [id];
      return [id, s.id, ...(s.bounds.kind === "rooms" ? s.bounds.roomIds : []), ...zonesOfSpace(elements, s.id).map((z) => z.id)];
    },
  };
}

export function spaceIndexStats(elements: Elements): SpaceIndexStats {
  const s = indexFor(elements);
  return { measured: s.measured, syncs: s.syncs, fullSyncs: s.fullSyncs };
}

/** Test seam: forget every index (a fresh process). */
export function resetSpaceIndexes(): void {
  latest = null;
}
