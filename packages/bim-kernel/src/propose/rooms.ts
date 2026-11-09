import { add, cross, dot, scale, sub } from "../geometry";
import { partFootprint } from "../parts";
import { elementsOfKind } from "../store";
import { partitionMembers } from "../partition";
import type { BimElement, Component, ModelState, Opening, PartInstance, PartTypeElement, Partition, Room, Vec2, Wall } from "../types";
import { centroid, normalizeOutline, perimeterOf, pointInOutline, project, type Edge } from "./perimeter";
import type { ExistingDevice, FixtureKind, RoomCounter, RoomFixture, RoomGeometry, RoomOpening } from "./types";

/**
 * Reads a room of our model into the proposer's terms: the outline moved
 * in to the wall faces (rooms are often drawn on wall centrelines), the doors
 * and windows on its walls, the counters and fixtures inside it, and the
 * devices already there. Read-only.
 */

const COUNTER_WORDS = /\b(counter|countertop|base cabinet|cabinet|vanity|island|peninsula|work ?surface)\b/i;
const FIXTURE_WORDS: ReadonlyArray<readonly [FixtureKind, RegExp]> = [
  ["basin", /\b(lav|lavatory|basin|vanity sink|wash ?basin)\b/i],
  ["sink", /\bsink\b/i],
  ["range", /\b(range|cooktop|stove|oven)\b/i],
  ["washer", /\bwasher\b/i],
  ["dryer", /\bdryer\b/i],
  ["refrigerator", /\b(refrigerator|fridge)\b/i],
];

export function fixtureKindOf(name: string): FixtureKind | null {
  for (const [kind, re] of FIXTURE_WORDS) if (re.test(name)) return kind;
  return null;
}

export const isCounterName = (name: string): boolean => COUNTER_WORDS.test(name) && fixtureKindOf(name) === null;

function rectOutline(position: Vec2, size: Vec2, rotationDeg: number): Vec2[] {
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hx = size.x / 2;
  const hy = size.y / 2;
  return [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ].map((p) => ({ x: Math.round(position.x + p.x * c - p.y * s), y: Math.round(position.y + p.x * s + p.y * c) }));
}

/** The wall a room edge is drawn on: parallel, overlapping, centreline within half its thickness of the edge. */
function wallOnEdge(walls: readonly Wall[], edge: Edge): { wall: Wall; offset: number } | null {
  for (const w of walls) {
    const d = sub(w.end, w.start);
    const len = Math.hypot(d.x, d.y);
    if (len < 1) continue;
    const u = { x: d.x / len, y: d.y / len };
    if (Math.abs(cross(u, edge.dir)) > 0.02) continue;
    const off = cross(edge.dir, sub(w.start, edge.a));
    if (Math.abs(off) > w.thickness / 2 + 25) continue;
    const ta = dot(sub(w.start, edge.a), edge.dir);
    const tb = dot(sub(w.end, edge.a), edge.dir);
    if (Math.max(ta, tb) < 1 || Math.min(ta, tb) > edge.length - 1) continue;
    // Positive off: the wall centre is inside the room (left of a CCW edge).
    return { wall: w, offset: off };
  }
  return null;
}

/** Each edge moved in by the part of its wall that stands inside the room; corners re-found where the moved edges meet. */
function toWallFaces(outline: readonly Vec2[], walls: readonly Wall[]): { outline: Vec2[]; edgeWalls: Array<Wall | null> } {
  const per = perimeterOf(outline);
  const shifts = per.edges.map((e) => {
    const hit = wallOnEdge(walls, e);
    return { edge: e, wall: hit?.wall ?? null, by: hit ? Math.max(0, hit.wall.thickness / 2 + hit.offset) : 0 };
  });
  const lines = shifts.map((s) => {
    const n = { x: -s.edge.dir.y, y: s.edge.dir.x };
    return { p: add(s.edge.a, scale(n, s.by)), d: s.edge.dir };
  });
  const pts: Vec2[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = lines[(i - 1 + lines.length) % lines.length];
    const here = lines[i];
    if (!prev || !here) continue;
    const den = cross(prev.d, here.d);
    if (Math.abs(den) < 1e-9) {
      pts.push(here.p);
      continue;
    }
    const t = cross(sub(here.p, prev.p), here.d) / den;
    pts.push({ x: Math.round(prev.p.x + prev.d.x * t), y: Math.round(prev.p.y + prev.d.y * t) });
  }
  return { outline: pts, edgeWalls: shifts.map((s) => s.wall) };
}

function partName(type: PartTypeElement | undefined, part: PartInstance): string {
  return [type?.definition.familyName, type?.definition.typeName, part.mark].filter(Boolean).join(" ");
}

/** How a proposer's add-on reads the parts already in a room. */
export interface RoomGeometryOptions {
  /** Marks of devices that serve one appliance and never count ("R.F"). */
  readonly applianceMarks?: readonly string[];
  /** Whether a part of this type is one of the add-on's own devices (listed as `existing`). Absent: none are. */
  readonly isExistingDevice?: (type: PartTypeElement) => boolean;
}

/** What a room reads around it: its level's walls, doors and windows, casework and parts. */
interface Pool {
  readonly walls: readonly Wall[];
  readonly openings: readonly Opening[];
  readonly components: readonly Component[];
  readonly parts: readonly PartInstance[];
}

function poolOf(els: Iterable<BimElement>): Pool {
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  const components: Component[] = [];
  const parts: PartInstance[] = [];
  for (const el of els) {
    if (el.kind === "wall") walls.push(el);
    else if (el.kind === "opening") openings.push(el);
    else if (el.kind === "component") components.push(el);
    else if (el.kind === "part") parts.push(el);
  }
  return { walls, openings, components, parts };
}

function geometryOf(elements: Readonly<Record<string, BimElement>>, room: Room, pool: Pool, marks: ReadonlySet<string>, isExisting: RoomGeometryOptions["isExistingDevice"]): RoomGeometry {
  const raw = normalizeOutline(room.outline);
  if (raw.length < 3) return { id: room.id, number: room.number, name: room.name, source: "model", outline: raw, openings: [], counters: [], fixtures: [], existing: [] };
  const rx = raw.map((p) => p.x);
  const ry = raw.map((p) => p.y);
  const reach = { minX: Math.min(...rx) - 1000, maxX: Math.max(...rx) + 1000, minY: Math.min(...ry) - 1000, maxY: Math.max(...ry) + 1000 };
  const touches = (w: Wall) => Math.max(w.start.x, w.end.x) >= reach.minX && Math.min(w.start.x, w.end.x) <= reach.maxX && Math.max(w.start.y, w.end.y) >= reach.minY && Math.min(w.start.y, w.end.y) <= reach.maxY;
  const { outline } = toWallFaces(raw, pool.walls.filter(touches));
  const face = normalizeOutline(outline);
  const per = perimeterOf(face);
  const xs = face.map((p) => p.x);
  const ys = face.map((p) => p.y);
  const box = { minX: Math.min(...xs) - 600, maxX: Math.max(...xs) + 600, minY: Math.min(...ys) - 600, maxY: Math.max(...ys) + 600 };
  const near = (q: Vec2) => q.x >= box.minX && q.x <= box.maxX && q.y >= box.minY && q.y <= box.maxY;
  const inside = (q: Vec2) => near(q) && (pointInOutline(q, face) || project(per, q).offset < 300);

  const openings: RoomOpening[] = [];
  for (const o of pool.openings) {
    if (!near(o.position)) continue;
    const host = elements[o.hostId];
    if (host?.kind !== "wall") continue;
    const pr = project(per, o.position);
    if (pr.offset > host.thickness / 2 + 100) continue;
    openings.push({ kind: o.openingType === "door" ? "door" : o.openingType === "window" ? "window" : "opening", label: o.mark || o.openingType, from: pr.s - o.width / 2, to: pr.s + o.width / 2 });
  }

  const counters: RoomCounter[] = [];
  const fixtures: RoomFixture[] = [];
  for (const c of pool.components) {
    if ((c.category !== "casework" && c.category !== "furniture") || !inside(c.position)) continue;
    const outlineC = rectOutline(c.position, c.size, c.rotationDeg);
    const kind = fixtureKindOf(c.typeName);
    if (kind) fixtures.push({ id: c.id, kind, label: c.typeName, outline: outlineC });
    else if (c.category === "casework" && isCounterName(c.typeName)) counters.push({ id: c.id, label: c.typeName, outline: outlineC });
  }

  const existing: ExistingDevice[] = [];
  for (const part of pool.parts) {
    if (!inside(part.position)) continue;
    const typeEl = elements[part.typeId];
    const type = typeEl?.kind === "part_type" ? typeEl : undefined;
    const name = partName(type, part);
    if (type && isExisting?.(type)) {
      const appliance = part.values.appliance === true || marks.has(part.mark.toUpperCase());
      existing.push({ id: part.id, position: part.position, appliance, label: name });
      continue;
    }
    const kind = fixtureKindOf(name);
    if (kind && type) fixtures.push({ id: part.id, kind, label: name, outline: partFootprint(type, part) });
    else if (type && isCounterName(name) && type.definition.category === "generic") counters.push({ id: part.id, label: name, outline: partFootprint(type, part) });
  }

  return { id: room.id, number: room.number, name: room.name, source: "model", outline: face, openings, counters, fixtures, existing };
}

/**
 * A proposer's view of our rooms, in the order asked (ids that aren't rooms
 * are left out). Each level's walls, doors, casework and parts are read once
 * from the shared level index, however many of its rooms are asked for. The
 * add-on says which parts are its own devices (`options.isExistingDevice`).
 */
export function roomGeometriesFromModel(model: Pick<ModelState, "elements" | "connections">, roomIds: readonly string[], options: RoomGeometryOptions = {}): RoomGeometry[] {
  const marks = new Set((options.applianceMarks ?? []).map((m) => m.toUpperCase()));
  const pools = new Map<string, Pool>();
  const out: RoomGeometry[] = [];
  for (const id of roomIds) {
    const room = model.elements[id];
    if (room?.kind !== "room") continue;
    const level = room.partition?.level ?? null;
    const key = level ?? "\u0000any";
    let pool = pools.get(key);
    if (!pool) {
      pool = level === null ? poolOf(elementsOfKind(model.elements, "wall", "opening", "component", "part")) : poolOf(partitionMembers(model, (p: Partition) => p.level === level));
      pools.set(key, pool);
    }
    out.push(geometryOf(model.elements, room, pool, marks, options.isExistingDevice));
  }
  return out;
}

/** One room's view (see roomGeometriesFromModel); null when `roomId` isn't a room. */
export function roomGeometryFromModel(model: Pick<ModelState, "elements" | "connections">, roomId: string, options: RoomGeometryOptions = {}): RoomGeometry | null {
  return roomGeometriesFromModel(model, [roomId], options)[0] ?? null;
}

/** Our rooms on a level (by the level's name in their partition), for a picker. */
export function roomsOnLevel(model: Pick<ModelState, "elements">, levelName: string | null): Room[] {
  return elementsOfKind(model.elements, "room")
    .filter((r) => !levelName || !r.partition || r.partition.level === levelName)
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

export const roomCentre = (room: Room): Vec2 => centroid(room.outline);
