import { activePackSet, serviceNetworkTotals, type NetworkAdapter, type NetworkAdapterItem, type NetworkAggregation, type NetworkQuantities } from "@permitzip/bim-pack/runtime";
import { derivedZoneRule, derivedZonesOfHost } from "@permitzip/bim-kernel/spaces";
import type { ModelState, Vec2 } from "@permitzip/bim-kernel/types";
import { fromCanonical, type Quantity } from "@permitzip/bim-units";
import { GRAVITY_LOAD_SERVICE_ID, LOAD_KEYS, LOAD_PATH_ADAPTER_ID } from "./catalog";
import { frameOf, type Frame, type FrameBeam, type FrameColumn, type FrameDeck, type FrameFooting, type FrameSupportColumn, type FrameSupports } from "./frame";
import { liveLoadRate } from "./live-loads";
import { simpleBeam, SimpleBeamInputError, type PointLoad } from "./simple-beam";
import { deckPointShares } from "./tributary";
import { TRIBUTARY_RULE_ID } from "./tributary-zone";

/**
 * The gravity load path (KERNEL-FOUNDATION §3.5): a `struct.gravity_load`
 * network whose nodes are members and supports. Each beam is a simple span:
 * its uniform load (self-weight, and live load over its tributary strip) and
 * its point loads (equipment standing on it or on the deck beside it) give
 * two end reactions. Each end bears on a column; each column on a footing or
 * on the column below. The pack contributes that network (`LOAD_PATH_ADAPTER`)
 * and the kernel totals it downward (`serviceNetworkTotals`: `networkTotals`
 * over `accumulateBelow`, each load-case key summed), the same core electrical
 * demand totals through.
 *
 * One service-level case: dead (member self-weight), live (by use, ASCE 7-22
 * Table 4.3-1, unreduced) and equipment (operating weights; ASCE 7 counts
 * fixed equipment as dead load, kept apart here so it can be traced). No load
 * factors or combinations: those are scenarios (round 6). Footing and deck
 * self-weight are not counted.
 */

export const LOAD_CASES = ["dead", "live", "equipment"] as const;
export type LoadCase = (typeof LOAD_CASES)[number];

/** Newtons by case, inside the walk. */
type Vector = Readonly<Record<LoadCase, number>>;

const ZERO: Vector = { dead: 0, live: 0, equipment: 0 };

const addVectors = (a: Vector, b: Vector): Vector => ({ dead: a.dead + b.dead, live: a.live + b.live, equipment: a.equipment + b.equipment });

export interface CaseLoads {
  readonly dead: Quantity<"force">;
  readonly live: Quantity<"force">;
  readonly equipment: Quantity<"force">;
  /** The service-level total: dead + live + equipment, unfactored. */
  readonly total: Quantity<"force">;
}

function loads(v: Vector): CaseLoads {
  return {
    dead: fromCanonical("force", v.dead),
    live: fromCanonical("force", v.live),
    equipment: fromCanonical("force", v.equipment),
    total: fromCanonical("force", v.dead + v.live + v.equipment),
  };
}

export interface BeamLoadResult {
  readonly id: string;
  readonly label: string;
  readonly span: Quantity<"length">;
  readonly uniformDead: Quantity<"line_load">;
  readonly uniformLive: Quantity<"line_load">;
  readonly pointLoads: readonly { readonly from: string; readonly load: Quantity<"force">; readonly at: Quantity<"length"> }[];
  readonly startColumnId: string | null;
  readonly endColumnId: string | null;
  readonly startReaction: CaseLoads;
  readonly endReaction: CaseLoads;
  readonly maxMoment: Quantity<"moment">;
  readonly maxMomentAt: Quantity<"length">;
}

export interface ColumnLoadResult {
  readonly id: string;
  readonly label: string;
  /** What it bears on: a footing, the column below, or nothing. */
  readonly bearsOn: Bearing;
  /** Everything it carries down, its own weight included. */
  readonly load: CaseLoads;
}

export interface FootingLoadResult {
  readonly id: string;
  readonly label: string;
  readonly columnIds: readonly string[];
  readonly load: CaseLoads;
}

export interface LoadPathResult {
  readonly beams: readonly BeamLoadResult[];
  readonly columns: readonly ColumnLoadResult[];
  readonly footings: readonly FootingLoadResult[];
  /** Beam ends that bear on no column, and their reactions (they reach no footing). */
  readonly unsupportedBeamEnds: readonly { readonly beamId: string; readonly end: "start" | "end"; readonly load: CaseLoads }[];
  /** What the walk could not count, in plain words. */
  readonly problems: readonly string[];
  readonly basis: string;
}

export const LOAD_PATH_BASIS = "One service-level case (dead + live + equipment, unfactored). Live load by use from ASCE 7-22 Table 4.3-1, unreduced. Load combinations are not applied.";

/** A beam end this far beyond a column's half-size, in plan, still bears on it. */
const BEARING_SLACK_MM = 50;
/** Heights this close are the same bearing elevation (a beam's depth below its top, a base plate). */
const BEARING_HEIGHT_MM = 600;

const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Station along a beam (mm from its start) and distance off its line. */
function onBeam(beam: FrameBeam, p: Vec2): { readonly station: number; readonly off: number; readonly length: number } {
  const d = sub(beam.end, beam.start);
  const length = Math.hypot(d.x, d.y);
  const q = sub(p, beam.start);
  const station = length > 0 ? (q.x * d.x + q.y * d.y) / length : 0;
  const off = length > 0 ? Math.abs(q.x * d.y - q.y * d.x) / length : Math.hypot(q.x, q.y);
  return { station, off, length };
}

function onFooting(f: FrameFooting, p: Vec2): boolean {
  const r = (-f.rotationDeg * Math.PI) / 180;
  const q = sub(p, f.position);
  const x = q.x * Math.cos(r) - q.y * Math.sin(r);
  const y = q.x * Math.sin(r) + q.y * Math.cos(r);
  return Math.abs(x) <= f.size.x / 2 + 25 && Math.abs(y) <= f.size.y / 2 + 25;
}

/** Plan buckets so a bearing search reads the few nearby supports, not all of them. */
class Buckets<T extends { readonly position: Vec2 }> {
  private readonly cells = new Map<string, T[]>();
  constructor(
    items: readonly T[],
    private readonly cellMm: number,
  ) {
    for (const it of items) {
      const k = this.key(it.position.x, it.position.y);
      const list = this.cells.get(k);
      if (list) list.push(it);
      else this.cells.set(k, [it]);
    }
  }
  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellMm)},${Math.floor(y / this.cellMm)}`;
  }
  near(p: Vec2): T[] {
    const cx = Math.floor(p.x / this.cellMm);
    const cy = Math.floor(p.y / this.cellMm);
    const out: T[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(this.cells.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  }
}

function bearingColumn(columns: Buckets<FrameColumn>, beam: FrameBeam, at: Vec2, z: number): FrameColumn | null {
  let best: FrameColumn | null = null;
  let bestD = Infinity;
  for (const c of columns.near(at)) {
    const reaches = c.topLevelId === beam.levelId || Math.abs(c.topZMm - z) <= BEARING_HEIGHT_MM;
    const d = dist(c.position, at);
    if (reaches && d <= c.radiusMm + BEARING_SLACK_MM && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export type Bearing = { readonly kind: "footing" | "column"; readonly id: string } | null;

const columnBucketCache = new WeakMap<Frame, Buckets<FrameColumn>>();
const bearingCache = new WeakMap<object, ReadonlyMap<string, Bearing>>();

function columnBucketsOf(frame: Frame): Buckets<FrameColumn> {
  let b = columnBucketCache.get(frame);
  if (!b) {
    b = new Buckets(frame.columns, 2000);
    columnBucketCache.set(frame, b);
  }
  return b;
}

/**
 * What each column bears on: a footing under its base (in plan, top of
 * footing within a bearing height of the column's base), else a column whose
 * top meets its base, else nothing. Once per frame read.
 */
export function columnBearings(frame: Frame): ReadonlyMap<string, Bearing> {
  const hit = bearingCache.get(frame);
  if (hit) return hit;
  const out = bearingsOf(frame.columns, columnBucketsOf(frame), frame.footings);
  bearingCache.set(frame, out);
  return out;
}

/** `columnBearings` from the columns and footings alone (`frameSupportsOf`), once per supports read. */
export function supportBearings(supports: FrameSupports): ReadonlyMap<string, Bearing> {
  const hit = bearingCache.get(supports);
  if (hit) return hit;
  const out = bearingsOf(supports.columns, new Buckets(supports.columns, 2000), supports.footings);
  bearingCache.set(supports, out);
  return out;
}

function bearingsOf<C extends FrameSupportColumn>(list: readonly C[], columns: Buckets<C>, footingList: readonly FrameFooting[]): Map<string, Bearing> {
  const footings = new Buckets(footingList, 4000);
  const out = new Map<string, Bearing>();
  for (const c of list) {
    const footing = footings.near(c.position).find((f) => onFooting(f, c.position) && Math.abs(f.topZMm - c.baseZMm) <= BEARING_HEIGHT_MM);
    const below = footing ? null : columns.near(c.position).find((o) => o !== c && Math.abs(o.topZMm - c.baseZMm) <= BEARING_HEIGHT_MM && dist(o.position, c.position) <= o.radiusMm + BEARING_SLACK_MM);
    out.set(c.id, footing ? { kind: "footing", id: footing.id } : below ? { kind: "column", id: below.id } : null);
  }
  return out;
}

function vectorOf(c: LoadCase, newtons: number): Vector {
  return { ...ZERO, [c]: newtons };
}

interface BeamWork {
  readonly beam: FrameBeam;
  readonly lengthM: number;
  readonly deadNPerM: number;
  liveNPerM: number;
  readonly points: { readonly from: string; readonly newtons: number; readonly atM: number }[];
}

function readBeams(model: ModelState, frame: Frame, problems: string[]): Map<string, BeamWork> {
  const work = new Map<string, BeamWork>();
  for (const beam of frame.beams) {
    const lengthM = dist(beam.start, beam.end) / 1000;
    if (!(lengthM > 0)) {
      problems.push(`${beam.label} has no length, so it carries nothing`);
      continue;
    }
    if (!beam.section) problems.push(`${beam.label}'s section "${beam.sectionName}" isn't in the catalogue, so its own weight isn't counted`);
    work.set(beam.id, { beam, lengthM, deadNPerM: beam.section?.weight ?? 0, liveNPerM: 0, points: [] });
  }

  const tributaryOn = derivedZoneRule(TRIBUTARY_RULE_ID) !== null;
  if (!tributaryOn && frame.decks.length > 0) problems.push("Tributary areas aren't computed for this model (the Structural pack isn't in its pack set), so no live load reaches the beams");
  const decks = new Map<string, FrameDeck>(frame.decks.map((d) => [d.id, d]));
  for (const deck of frame.decks) {
    if (!deck.useId) problems.push(`${deck.label} has no use, so it carries no live load`);
    else if (!liveLoadRate(deck.useId)) problems.push(`${deck.label}'s use "${deck.useId}" has no live load in the Structural pack, so it carries none`);
  }
  if (tributaryOn) {
    for (const w of work.values()) {
      const el = model.elements[w.beam.id];
      if (!el) continue;
      for (const region of derivedZonesOfHost(model, el, TRIBUTARY_RULE_ID)) {
        const deck = decks.get(region.clearanceId);
        const rate = deck?.useId ? liveLoadRate(deck.useId) : null;
        const [o0, o1, o2] = region.outline;
        if (!rate || !o0 || !o1 || !o2) continue;
        // The strip is width (across the beam) by length (along it); spread over the span.
        const widthM = dist(o0, o1) / 1000;
        const coveredM = dist(o1, o2) / 1000;
        w.liveNPerM += (rate.value * widthM * coveredM) / w.lengthM;
      }
    }
  }

  const decksById = new Map<string, FrameDeck>(frame.decks.map((d) => [d.id, d]));
  for (const eq of frame.equipment) {
    const host = eq.host;
    if (host?.kind === "line") {
      const w = work.get(host.elementId);
      if (!w) {
        problems.push(`${eq.label} stands on ${host.elementId}, which isn't a beam the Structural pack reads, so its weight isn't in the load path`);
        continue;
      }
      const lengthMm = w.lengthM * 1000;
      if (host.stationMm > lengthMm + 1) problems.push(`${eq.label} stands ${(host.stationMm / 304.8).toFixed(2)} ft along ${w.beam.label}, past its end; it is taken at the end`);
      w.points.push({ from: eq.label, newtons: eq.weight, atM: Math.min(host.stationMm, lengthMm) / 1000 });
      continue;
    }
    const deck = host?.kind === "slab" ? decksById.get(host.elementId) : undefined;
    if (!deck) {
      problems.push(`${eq.label} stands on no beam or deck the Structural pack reads, so its weight isn't in the load path`);
      continue;
    }
    const { shares, cantilever } = deckPointShares(deck, frame.beamsByLevel.get(deck.levelId) ?? [], eq.position);
    if (shares.length === 0) problems.push(`${eq.label} stands on ${deck.label}, which no beam carries, so its weight isn't in the load path`);
    if (cantilever) problems.push(`${eq.label} stands on ${deck.label} past its last beam; that beam takes all of its weight`);
    for (const sh of shares) {
      const w = work.get(sh.supportId);
      if (!w) continue;
      const o = onBeam(w.beam, eq.position);
      w.points.push({ from: eq.label, newtons: eq.weight * sh.fraction, atM: Math.min(Math.max(o.station, 0), o.length) / 1000 });
    }
  }
  return work;
}

/** The load path of a model: every footing's, column's and beam's loads by case. */
interface BeamShare {
  readonly startColumnId: string | null;
  readonly endColumnId: string | null;
  readonly start: Vector;
  readonly end: Vector;
}

interface Built {
  readonly beams: readonly BeamLoadResult[];
  readonly network: NetworkAdapter<string, NetworkQuantities>;
  readonly bearsOn: ReadonlyMap<string, Bearing>;
  readonly unsupportedEnds: readonly { readonly beamId: string; readonly end: "start" | "end"; readonly load: Vector }[];
  readonly problems: readonly string[];
}

const toQuantities = (v: Vector): NetworkQuantities => ({ [LOAD_KEYS.dead]: v.dead, [LOAD_KEYS.live]: v.live, [LOAD_KEYS.equipment]: v.equipment });
const fromQuantities = (q: NetworkQuantities | undefined): Vector => ({ dead: q?.[LOAD_KEYS.dead] ?? 0, live: q?.[LOAD_KEYS.live] ?? 0, equipment: q?.[LOAD_KEYS.equipment] ?? 0 });
const CASE_OF_KEY: ReadonlyMap<string, LoadCase> = new Map([
  [LOAD_KEYS.dead, "dead"],
  [LOAD_KEYS.live, "live"],
  [LOAD_KEYS.equipment, "equipment"],
]);

/**
 * The load path's network, every node an element: footings are roots,
 * columns their children (and a column on a column the lower one's child),
 * each beam a child of the column under each of its ends. A beam's own
 * quantities are its whole load by case; `across` hands each column that
 * end's simple-span reaction, case by case (a uniform load splits evenly, an
 * off-centre point load doesn't). Built once per frame read and pack set
 * (the live load reads the set).
 */
function build(model: ModelState): Built {
  const frame = frameOf(model);
  const set = activePackSet();
  let perSet = builtCache.get(frame);
  if (!perSet) {
    perSet = new WeakMap();
    builtCache.set(frame, perSet);
  }
  const hit = perSet.get(set);
  if (hit) return hit;
  const problems: string[] = [];
  for (const id of frame.unplaced) problems.push(`${id} has no placement with a level, so the Structural pack can't place it in the load path`);
  const work = readBeams(model, frame, problems);

  const columnBuckets = columnBucketsOf(frame);
  const own = new Map<string, NetworkQuantities>();
  const shares = new Map<string, BeamShare>();
  const children = new Map<string, string[]>();
  const addChild = (parent: string, child: string) => {
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  };
  const roots: string[] = [];
  const beams: BeamLoadResult[] = [];
  const unsupportedEnds: { beamId: string; end: "start" | "end"; load: Vector }[] = [];

  for (const w of work.values()) {
    const span = fromCanonical("length", w.lengthM);
    const point = (c: LoadCase): PointLoad[] => (c === "equipment" ? w.points.map((p) => ({ load: fromCanonical("force", p.newtons), at: fromCanonical("length", p.atM), label: p.from })) : []);
    const uniform = (c: LoadCase) => fromCanonical("line_load", c === "dead" ? w.deadNPerM : c === "live" ? w.liveNPerM : 0);
    let start = ZERO;
    let end = ZERO;
    let all: ReturnType<typeof simpleBeam>;
    try {
      for (const c of LOAD_CASES) {
        const r = simpleBeam({ span, uniform: uniform(c), pointLoads: point(c) });
        start = addVectors(start, vectorOf(c, r.startReaction));
        end = addVectors(end, vectorOf(c, r.endReaction));
      }
      all = simpleBeam({ span, uniform: fromCanonical("line_load", w.deadNPerM + w.liveNPerM), pointLoads: point("equipment") });
    } catch (err) {
      if (!(err instanceof SimpleBeamInputError)) throw err;
      console.error("[struct.load_path] beam skipped", { beamId: w.beam.id, message: err.message });
      problems.push(`${w.beam.label}: ${err.message}`);
      continue;
    }
    const startCol = bearingColumn(columnBuckets, w.beam, w.beam.start, w.beam.startZMm);
    const endCol = bearingColumn(columnBuckets, w.beam, w.beam.end, w.beam.endZMm);
    own.set(w.beam.id, toQuantities(addVectors(start, end)));
    shares.set(w.beam.id, { startColumnId: startCol?.id ?? null, endColumnId: endCol?.id ?? null, start, end });
    if (startCol) addChild(startCol.id, w.beam.id);
    else unsupportedEnds.push({ beamId: w.beam.id, end: "start", load: start });
    if (endCol && endCol !== startCol) addChild(endCol.id, w.beam.id);
    else if (!endCol) unsupportedEnds.push({ beamId: w.beam.id, end: "end", load: end });
    if (!startCol && !endCol) roots.push(w.beam.id);
    beams.push({
      id: w.beam.id,
      label: w.beam.label,
      span,
      uniformDead: fromCanonical("line_load", w.deadNPerM),
      uniformLive: fromCanonical("line_load", w.liveNPerM),
      pointLoads: w.points.map((p) => ({ from: p.from, load: fromCanonical("force", p.newtons), at: fromCanonical("length", p.atM) })),
      startColumnId: startCol?.id ?? null,
      endColumnId: endCol?.id ?? null,
      startReaction: loads(start),
      endReaction: loads(end),
      maxMoment: all.maxMoment,
      maxMomentAt: all.maxMomentAt,
    });
  }

  const bearsOn = columnBearings(frame);
  for (const c of frame.columns) {
    const heightM = Math.max(0, c.topZMm - c.baseZMm) / 1000;
    if (!c.section) problems.push(`${c.label}'s section "${c.sectionName}" isn't in the catalogue, so its own weight isn't counted`);
    own.set(c.id, toQuantities({ ...ZERO, dead: (c.section?.weight ?? 0) * heightM }));
    const on = bearsOn.get(c.id) ?? null;
    if (on) addChild(on.id, c.id);
    else roots.push(c.id);
  }
  roots.unshift(...frame.footings.filter((f) => children.has(f.id)).map((f) => f.id));

  const network: NetworkAdapter<string, NetworkQuantities> = {
    roots: () => roots,
    children: (n) => children.get(n) ?? [],
    ownQuantities: (n) => own.get(n),
    across: (child, parent, total) => {
      const sh = shares.get(child);
      if (!sh || sh.startColumnId === sh.endColumnId) return total;
      const part = parent === sh.startColumnId ? sh.start : parent === sh.endColumnId ? sh.end : null;
      if (!part) return total;
      const whole = fromQuantities(own.get(child));
      const out: Record<string, number> = {};
      for (const [key, v] of Object.entries(total)) {
        const c = CASE_OF_KEY.get(key);
        out[key] = c === undefined ? v : whole[c] === 0 ? 0 : (v * part[c]) / whole[c];
      }
      return out;
    },
  };
  const built: Built = { beams, network, bearsOn, unsupportedEnds, problems };
  perSet.set(set, built);
  return built;
}

const builtCache = new WeakMap<Frame, WeakMap<object, Built>>();

/** The network-to-total the pack contributes for `struct.gravity_load`: the kernel walks and totals it (`serviceNetworkTotals`). */
export const LOAD_PATH_AGGREGATION: NetworkAggregation = {
  quantities: [LOAD_KEYS.dead, LOAD_KEYS.live, LOAD_KEYS.equipment],
  direction: "downward",
  over: ["physical"],
  network: (model) => {
    const frame = frameOf(model);
    return frame.columns.length === 0 && frame.beams.length === 0 ? null : build(model).network;
  },
};

export const LOAD_PATH_ADAPTER: NetworkAdapterItem = { id: LOAD_PATH_ADAPTER_ID, aggregation: LOAD_PATH_AGGREGATION };

/**
 * The load path of a model, totalled by the kernel through the service's
 * network (`serviceNetworkTotals`), so it is only computed where the
 * Structural pack is in force: every footing's, column's and beam's loads by
 * case.
 */
export function structuralLoadPath(model: ModelState): LoadPathResult {
  const built = build(model);
  const problems = [...built.problems];
  const walked = serviceNetworkTotals(model, GRAVITY_LOAD_SERVICE_ID);
  if (!walked.ok) problems.push(`The gravity load path wasn't totalled: ${walked.reason}`);
  const total = (n: string) => loads(fromQuantities(walked.ok ? walked.totals.get(n) : undefined));
  const frame = frameOf(model);
  const onFooting = new Map<string, string[]>();
  for (const c of frame.columns) {
    const on = built.bearsOn.get(c.id);
    if (on?.kind === "footing") onFooting.set(on.id, [...(onFooting.get(on.id) ?? []), c.id]);
  }
  return {
    beams: built.beams,
    columns: frame.columns.map((c) => ({ id: c.id, label: c.label, bearsOn: built.bearsOn.get(c.id) ?? null, load: total(c.id) })),
    footings: frame.footings.map((f) => ({ id: f.id, label: f.label, columnIds: onFooting.get(f.id) ?? [], load: total(f.id) })),
    unsupportedBeamEnds: built.unsupportedEnds.map((u) => ({ beamId: u.beamId, end: u.end, load: loads(walked.ok ? u.load : ZERO) })),
    problems,
    basis: LOAD_PATH_BASIS,
  };
}
