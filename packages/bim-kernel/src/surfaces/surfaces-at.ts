import { ceilingHeightAt } from "../ceilings/ceiling-index";
import { asCeiling, ceilingLabel } from "../ceilings/read";
import { modelLevels, viewFloorMm } from "../levels";
import { containsPoint } from "../spaces/space-geometry";
import { spaceAt } from "../spaces/space-index";
import { partBaseMm } from "../spatial";
import { recordsOfKinds } from "../store";
import type { BimElement, ElementId, Level, ModelState, Vec2 } from "../types";
import { surfaceFaceKinds, surfaceFaceRow, type SurfaceFaceRow } from "./faces";

/**
 * What is under and over a point (ROADMAP S3, NEXT-BATCH 5b-4): the floor or
 * roof it stands on, the ceiling over it, the roof, and the structure above,
 * each with its height and where it came from. Read from what the model
 * already holds: levels, our slabs, a space's stated ceiling height, a part's
 * stated host, and the linked models' slabs, roofs and ceilings that the host
 * indexes (bim-lint's linked index fits `LinkedSurfaceSource` as it is).
 *
 * Statements beat measurements: a part's own host, a typed ceiling drawn over
 * the point and, where none is drawn, a space's stated ceiling height win over
 * what a linked model shows, and the answer says when two disagree. Typed
 * ceilings come from their own plan-grid index (`ceilings/ceiling-index.ts`). No pass over the model per ask: our slabs go into a plan grid
 * once per set of slab objects (an edit that touches no slab keeps it), each
 * linked model's slabs, roofs and ceilings into a plan grid once per linked
 * revision (or index object when it names none), and an ask reads the one
 * cell under the point (plus the few surfaces too wide to grid). The space
 * comes from the space index.
 */

/** A linked model's element as the host indexes it (bim-lint `LinkedElement` fits as is). */
export interface LinkedSurfaceElement {
  readonly globalId: string;
  readonly name: string;
  readonly ifcClass: string;
  readonly kind: string;
  /** World mm: [minX, minY, minZ, maxX, maxY, maxZ]. */
  readonly box: readonly [number, number, number, number, number, number];
  /** Plan hull, flat [x0, y0, x1, y1, …]. Absent: the box's footprint. */
  readonly hull?: readonly number[];
}

export interface LinkedSurfaceSource {
  readonly modelId: string;
  readonly label: string;
  readonly elements: readonly LinkedSurfaceElement[];
  /**
   * What identifies this content of the linked model (the file's content id
   * or the reference's revision). Given, the surface grid is kept per
   * (model, revision), so a source re-read for every ask (a fresh object with
   * the same content) is gridded once; absent, per source object.
   */
  readonly revision?: string;
}

export type SurfaceRole = "floor" | "ceiling" | "roof" | "structure";

export type SurfaceOrigin =
  | { readonly kind: "level"; readonly id: ElementId; readonly name: string }
  | { readonly kind: "slab"; readonly id: ElementId; readonly name: string }
  | { readonly kind: "space"; readonly id: ElementId; readonly name: string }
  /** A typed ceiling (`ceilings/`): its form and surface role as stored (a role this release doesn't know is kept). */
  | { readonly kind: "ceiling"; readonly id: ElementId; readonly name: string; readonly form: string; readonly surfaceRole: string }
  /** One of our own elements an add-on's surface face row reads (a roof, a deck). */
  | { readonly kind: "element"; readonly id: ElementId; readonly name: string; readonly elementKind: string }
  | { readonly kind: "host"; readonly name: string }
  | { readonly kind: "linked"; readonly modelId: string; readonly modelLabel: string; readonly globalId: string; readonly name: string; readonly ifcClass: string };

export interface SurfaceAt {
  readonly role: SurfaceRole;
  /** Model elevation of the face that matters (a floor's top, a ceiling's or structure's underside, a roof's top when standing on it), mm. */
  readonly elevationMm: number;
  /** Height above the floor found under the point, mm (null for the floor itself or with no floor). */
  readonly aboveFloorMm: number | null;
  readonly source: SurfaceOrigin;
}

export type SurfacesTarget = { readonly elementId: ElementId } | { readonly point: Vec2; readonly levelId?: ElementId; readonly elevationMm?: number };

export type SurfacesAtResult =
  | {
      readonly ok: true;
      readonly point: Vec2;
      /** The elevation asked about, mm (a part's base, or the level's floor). */
      readonly probeMm: number;
      readonly level: { readonly id: ElementId; readonly name: string; readonly elevationMm: number } | null;
      readonly floor: SurfaceAt | null;
      readonly ceiling: SurfaceAt | null;
      readonly roof: SurfaceAt | null;
      readonly structureAbove: SurfaceAt | null;
      /** Plain notes: a statement that disagrees with a linked model, nothing found where something was expected. */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** A surface standing this close below the probe still counts as under it (a seated part, rounding in an export). */
const STAND_TOLERANCE_MM = 50;
/** Statements and linked surfaces that differ by more than this are said. */
const DISAGREE_MM = 25;

interface LinkedFace {
  readonly kind: "slab" | "roof" | "covering";
  readonly outline: readonly Vec2[];
  readonly bottom: number;
  readonly top: number;
  readonly origin: Extract<SurfaceOrigin, { kind: "linked" }>;
}

/** Plan grid cell, mm (about a 16 ft bay, as the space index uses). */
const GRID_MM = 5000;
/** A surface spanning more cells than this sits in the grid's wide list (a whole roof, a podium slab). */
const MAX_CELLS = 256;

/** Items bucketed by the plan cells their outline's box covers; the wide ones listed apart. */
class PlanGrid<T extends { readonly outline: readonly Vec2[] }> {
  private readonly cells = new Map<number, T[]>();
  private readonly wide: T[] = [];

  constructor(items: Iterable<T>) {
    for (const item of items) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of item.outline) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      if (!Number.isFinite(x0)) continue;
      const i0 = Math.floor(x0 / GRID_MM);
      const i1 = Math.floor(x1 / GRID_MM);
      const j0 = Math.floor(y0 / GRID_MM);
      const j1 = Math.floor(y1 / GRID_MM);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) {
        this.wide.push(item);
        continue;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = cellKey(i, j);
          const list = this.cells.get(k);
          if (list) list.push(item);
          else this.cells.set(k, [item]);
        }
      }
    }
  }

  /** The items whose outline holds the point. */
  at(p: Vec2): T[] {
    const out: T[] = [];
    for (const item of this.cells.get(cellKey(Math.floor(p.x / GRID_MM), Math.floor(p.y / GRID_MM))) ?? []) if (containsPoint(item.outline, p)) out.push(item);
    for (const item of this.wide) if (containsPoint(item.outline, p)) out.push(item);
    return out;
  }
}

function cellKey(i: number, j: number): number {
  return i * 1_000_003 + j;
}

const facesBySource = new WeakMap<LinkedSurfaceSource, PlanGrid<LinkedFace>>();
/** Grids of sources that name their revision, most recently used last. */
const facesByRevision = new Map<string, PlanGrid<LinkedFace>>();
/** About a project's linked models several times over; a 250k model's grid is tens of MB. */
const MAX_REVISIONS = 16;

function linkedFaceGrid(source: LinkedSurfaceSource): PlanGrid<LinkedFace> {
  const hit = facesBySource.get(source);
  if (hit) return hit;
  // The label is in every answer's source, so a renamed reference is a different grid.
  const revisionKey = source.revision === undefined ? null : `${source.modelId}\u0000${source.revision}\u0000${source.label}`;
  if (revisionKey !== null) {
    const known = facesByRevision.get(revisionKey);
    if (known) {
      facesByRevision.delete(revisionKey);
      facesByRevision.set(revisionKey, known);
      facesBySource.set(source, known);
      return known;
    }
  }
  const grid = new PlanGrid(linkedFaces(source));
  facesBySource.set(source, grid);
  if (revisionKey !== null) {
    facesByRevision.set(revisionKey, grid);
    while (facesByRevision.size > MAX_REVISIONS) {
      const oldest = facesByRevision.keys().next();
      if (oldest.done) break;
      facesByRevision.delete(oldest.value);
    }
  }
  return grid;
}

function linkedFaces(source: LinkedSurfaceSource): LinkedFace[] {
  const out: LinkedFace[] = [];
  for (const e of source.elements) {
    if (e.kind !== "slab" && e.kind !== "roof" && e.kind !== "covering") continue;
    const [x0, y0, z0, x1, y1, z1] = e.box;
    const outline: Vec2[] = [];
    if (e.hull && e.hull.length >= 6) for (let i = 0; i + 1 < e.hull.length; i += 2) outline.push({ x: e.hull[i] as number, y: e.hull[i + 1] as number });
    else outline.push({ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 });
    out.push({ kind: e.kind, outline, bottom: z0, top: z1, origin: { kind: "linked", modelId: source.modelId, modelLabel: source.label, globalId: e.globalId, name: e.name || e.ifcClass, ifcClass: e.ifcClass } });
  }
  return out;
}

/** One of our own elements that offers faces (`kernel.surface_face`): a slab, an add-on's roof or deck. Ceilings have their own index. */
interface NativeFace {
  readonly el: BimElement;
  readonly row: SurfaceFaceRow;
  readonly outline: readonly Vec2[];
}

interface NativeFaceGrid {
  readonly records: readonly BimElement[];
  readonly grid: PlanGrid<NativeFace>;
}

/** Our faced elements in a plan grid per elements record; a revision whose faced elements are the same objects as the last one's reuses its grid. */
const facedByElements = new WeakMap<object, NativeFaceGrid>();
let lastFaceGrid: NativeFaceGrid | null = null;

function nativeFaceGrid(model: ModelState): PlanGrid<NativeFace> {
  const hit = facedByElements.get(model.elements);
  if (hit) return hit.grid;
  const kinds = surfaceFaceKinds().filter((k) => surfaceFaceRow(k)?.role !== "ceiling");
  const records = recordsOfKinds(model.elements, kinds);
  const last = lastFaceGrid;
  const same = last !== null && last.records.length === records.length && records.every((s, i) => last.records[i] === s);
  let entry: NativeFaceGrid;
  if (same && last) entry = last;
  else {
    const faced: NativeFace[] = [];
    for (const el of records) {
      const row = surfaceFaceRow(el.kind);
      const outline = row?.footprint(el, model.elements);
      if (row && outline) faced.push({ el, row, outline });
    }
    entry = { records, grid: new PlanGrid(faced) };
  }
  facedByElements.set(model.elements, entry);
  lastFaceGrid = entry;
  return entry.grid;
}

/** Drop the face grid read from a working record an edit is still writing (a later write must not see a stale grid). */
export function forgetSurfaceIndexes(elements: object): void {
  facedByElements.delete(elements);
}

function faceOrigin(f: NativeFace): SurfaceOrigin {
  if (f.el.kind === "slab") return { kind: "slab", id: f.el.id, name: `slab ${f.el.id}${f.el.partition?.level ? ` on ${f.el.partition.level}` : ""}` };
  return { kind: "element", id: f.el.id, name: `${f.row.label.toLowerCase()} ${f.el.id}`, elementKind: f.el.kind };
}

function levelById(model: ModelState, id: ElementId | undefined): Level | null {
  if (!id) return null;
  const el = model.elements[id];
  return el?.kind === "level" ? el : null;
}

/** The highest level at or below an elevation (a point given without a level). */
function levelBelow(model: ModelState, z: number): Level | null {
  let best: Level | null = null;
  for (const l of modelLevels(model)) if (l.elevationMm <= z + STAND_TOLERANCE_MM && (!best || l.elevationMm > best.elevationMm)) best = l;
  return best;
}

interface Probe {
  readonly point: Vec2;
  readonly z: number;
  readonly level: Level | null;
  /** A part's stated host: its top and what it is. */
  readonly host: { readonly topMm: number; readonly name: string; readonly surface: "slab" | "roof" | null; readonly globalId: string | null } | null;
}

function probeOf(model: ModelState, target: SurfacesTarget): Probe | string {
  if ("elementId" in target) {
    const el = model.elements[target.elementId];
    if (!el) return `There is no element ${target.elementId}`;
    if (el.kind !== "part") return `${target.elementId} is a ${el.kind.replace(/_/g, " ")}; ask about a placed part, or give a point and level`;
    if (el.planned !== undefined) return `${el.mark || el.id} isn't placed yet, so it has no point in the model`;
    const level = levelById(model, el.levelId);
    let host: Probe["host"] = null;
    if (el.host?.kind === "linked") host = { topMm: el.host.topMm, name: `${el.host.name} (linked)`, surface: el.host.surface ?? null, globalId: el.host.globalId ?? null };
    else if (el.host?.kind === "slab") {
      const slab = model.elements[el.host.elementId];
      const top = slab?.kind === "slab" ? viewFloorMm(model, slab.partition?.level) : null;
      if (top !== null) host = { topMm: top, name: `slab ${el.host.elementId}`, surface: "slab", globalId: null };
    }
    return { point: { x: el.position.x, y: el.position.y }, z: partBaseMm(model, el), level, host };
  }
  const level = target.levelId ? levelById(model, target.levelId) : null;
  if (target.levelId && !level) return `There is no level ${target.levelId}`;
  const z = target.elevationMm ?? level?.elevationMm;
  if (z === undefined) return "Say which level the point is on (or its elevation)";
  return { point: target.point, z, level: level ?? levelBelow(model, z), host: null };
}

/** The floor, ceiling, roof and structure over a placed part or a point on a level. Heights in mm. */
export function surfacesAt(model: ModelState, target: SurfacesTarget, linked: readonly LinkedSurfaceSource[] = []): SurfacesAtResult {
  const probe = probeOf(model, target);
  if (typeof probe === "string") return { ok: false, reason: probe };
  const { point, z } = probe;
  const notes: string[] = [];
  const faces = linked.flatMap((s) => linkedFaceGrid(s).at(point));

  // Floor: the part's stated host, else the highest surface under the probe (our slabs, linked slabs and roofs, the level's floor).
  type Candidate = { readonly elevationMm: number; readonly source: SurfaceOrigin; readonly roof: boolean };
  const under: Candidate[] = [];
  if (probe.level) under.push({ elevationMm: probe.level.elevationMm, source: { kind: "level", id: probe.level.id, name: probe.level.name }, roof: false });
  const nativeAbove: Candidate[] = [];
  let nativeRoof: Candidate | null = null;
  for (const f of nativeFaceGrid(model).at(point)) {
    const face = f.row.faceAt(f.el, model.elements, point);
    if (!face) continue;
    const source = faceOrigin(f);
    const isRoof = f.row.role === "roof";
    if (face.top <= z + STAND_TOLERANCE_MM) under.push({ elevationMm: face.top, source, roof: isRoof });
    else {
      const c: Candidate = { elevationMm: face.underside, source, roof: isRoof };
      nativeAbove.push(c);
      if (isRoof && (!nativeRoof || c.elevationMm < nativeRoof.elevationMm)) nativeRoof = c;
    }
  }
  for (const f of faces) if (f.kind !== "covering" && f.top <= z + STAND_TOLERANCE_MM) under.push({ elevationMm: f.top, source: f.origin, roof: f.kind === "roof" });
  let floorPick: Candidate | null = null;
  // The highest; at the same height a real surface beats the level's nominal floor.
  for (const c of under) if (!floorPick || c.elevationMm > floorPick.elevationMm || (c.elevationMm === floorPick.elevationMm && floorPick.source.kind === "level")) floorPick = c;
  if (probe.host) {
    const stated: Candidate = { elevationMm: probe.host.topMm, source: { kind: "host", name: probe.host.name }, roof: probe.host.surface === "roof" };
    if (floorPick && Math.abs(floorPick.elevationMm - stated.elevationMm) > DISAGREE_MM && floorPick.source.kind === "linked") {
      notes.push(`It is stood on ${probe.host.name} at ${ftIn(stated.elevationMm)}, but the linked model shows ${floorPick.source.name} at ${ftIn(floorPick.elevationMm)} under it; the stated host is used`);
    }
    floorPick = stated;
  }
  const floorMm = floorPick?.elevationMm ?? null;
  const above = (elevationMm: number) => (floorMm === null ? null : Math.round(elevationMm - floorMm));
  const floor: SurfaceAt | null = floorPick ? { role: "floor", elevationMm: floorPick.elevationMm, aboveFloorMm: null, source: floorPick.source } : null;

  // Roof: the roof it stands on, else the lowest roof over it.
  let roof: SurfaceAt | null = null;
  if (floorPick?.roof) roof = { role: "roof", elevationMm: floorPick.elevationMm, aboveFloorMm: 0, source: floorPick.source };
  else {
    let best: LinkedFace | null = null;
    for (const f of faces) if (f.kind === "roof" && f.bottom > z && (!best || f.bottom < best.bottom)) best = f;
    // Our own roof over the point (an add-on's roof row), when it is lower than any linked one.
    if (nativeRoof && (!best || nativeRoof.elevationMm <= best.bottom)) roof = { role: "roof", elevationMm: nativeRoof.elevationMm, aboveFloorMm: above(nativeRoof.elevationMm), source: nativeRoof.source };
    else if (best) roof = { role: "roof", elevationMm: best.bottom, aboveFloorMm: above(best.bottom), source: best.origin };
  }

  // Structure above: the lowest underside over the probe (our slabs on higher levels, linked slabs and roofs).
  let structure: Candidate | null = null;
  for (const c of nativeAbove) if (!structure || c.elevationMm < structure.elevationMm) structure = c;
  for (const f of faces) if (f.kind !== "covering" && f.bottom > z + STAND_TOLERANCE_MM && (!structure || f.bottom < structure.elevationMm)) structure = { elevationMm: f.bottom, source: f.origin, roof: f.kind === "roof" };
  const structureAbove: SurfaceAt | null = structure ? { role: "structure", elevationMm: structure.elevationMm, aboveFloorMm: above(structure.elevationMm), source: structure.source } : null;

  // Ceiling: a typed ceiling over the point, else the space's stated ceiling height, else a linked ceiling over the probe below the structure.
  let ceiling: SurfaceAt | null = null;
  let linkedCeiling: LinkedFace | null = null;
  for (const f of faces) if (f.kind === "covering" && f.bottom > z && (structure === null || f.bottom < structure.elevationMm) && (!linkedCeiling || f.bottom < linkedCeiling.bottom)) linkedCeiling = f;
  const space = probe.level ? spaceAt(model.elements, probe.level.id, point) : null;
  const typed = probe.level ? ceilingHeightAt(model.elements, probe.level.id, point) : null;
  const typedCeiling = typed ? asCeiling(model.elements[typed.ceilingId]) : null;
  if (typed && typedCeiling && probe.level) {
    // A typed ceiling is a statement too, and the more specific one: it is drawn where it is.
    const at = probe.level.elevationMm + typed.heightMm;
    const name = ceilingLabel(typedCeiling);
    ceiling = { role: "ceiling", elevationMm: at, aboveFloorMm: above(at), source: { kind: "ceiling", id: typed.ceilingId, name, form: typed.form, surfaceRole: typed.role } };
    if (space?.ceilingHeightMm !== undefined && Math.abs(space.ceilingHeightMm - typed.heightMm) > DISAGREE_MM) notes.push(`Space ${space.number} states its ceiling at ${ftIn(space.ceilingHeightMm)}, but ${name} is drawn at ${ftIn(typed.heightMm)} here; the drawn ceiling is used`);
    if (linkedCeiling && Math.abs(linkedCeiling.bottom - at) > DISAGREE_MM) notes.push(`${name} is at ${ftIn(typed.heightMm)}, but the linked model shows ${linkedCeiling.origin.name} at ${ftIn(linkedCeiling.bottom - probe.level.elevationMm)} above the floor; the drawn ceiling is used`);
  } else if (space?.ceilingHeightMm !== undefined && probe.level) {
    const at = probe.level.elevationMm + space.ceilingHeightMm;
    ceiling = { role: "ceiling", elevationMm: at, aboveFloorMm: above(at), source: { kind: "space", id: space.id, name: `${space.number} ${space.name}`.trim() } };
    if (linkedCeiling && Math.abs(linkedCeiling.bottom - at) > DISAGREE_MM) notes.push(`Space ${space.number} says its ceiling is at ${ftIn(space.ceilingHeightMm)}, but the linked model shows ${linkedCeiling.origin.name} at ${ftIn(linkedCeiling.bottom - probe.level.elevationMm)} above the floor; the space's height is used`);
  } else if (linkedCeiling) ceiling = { role: "ceiling", elevationMm: linkedCeiling.bottom, aboveFloorMm: above(linkedCeiling.bottom), source: linkedCeiling.origin };

  if (!floor) notes.push("Nothing under this point: no level, slab or roof the model knows");
  if (linked.length === 0) notes.push("No linked model was read, so roofs and ceilings come only from this model");
  return { ok: true, point, probeMm: z, level: probe.level ? { id: probe.level.id, name: probe.level.name, elevationMm: probe.level.elevationMm } : null, floor, ceiling, roof, structureAbove, notes };
}

function ftIn(mm: number): string {
  const sign = mm < 0 ? "-" : "";
  const totalIn = Math.round(Math.abs(mm) / 25.4);
  return `${sign}${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}
