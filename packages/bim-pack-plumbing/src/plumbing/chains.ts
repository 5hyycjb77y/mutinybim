import { levelElevationOf, elementsOfKind } from "@permitzip/bim-kernel";
import type { PortRef, RunFitting, RunSegment, BimElement, ElementId } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Named vertical runs, derived from drawn pipe or duct (ROADMAP P6). A vertical
 * run is the chain of vertical pieces of one system that carry on from floor
 * to floor, through the couplings and bends between them and any offsets (a
 * jog where the walls above and below don't line up). Plumbing reads one as a
 * stack; a duct shaft or an electrical riser is the same chain with another
 * filter, which is why this file knows nothing about drainage.
 *
 * The chain is walked only along the run's own ends (links), never along the
 * branches hosted on it, so a floor's horizontal branch never joins its stack.
 * An offset is a sloped or level piece that joins the top of one vertical piece
 * to the bottom of the next one up; anything else leaving the chain (the
 * building drain at the base, a vent's turn to the roof) ends it, and the bend
 * there is the run's base or top.
 *
 * Performance: `chainAt` walks one chain (its own pieces, never the model).
 * `verticalRunIndex` builds every chain once per model state; after an edit,
 * `advanceVerticalRunIndex` keeps every chain the edit didn't touch and walks
 * again only from the changed ids, so the cost is the size of the changed
 * chains, not of the model.
 */

/** Which run segments can be part of a vertical run (a stack's: sanitary, vent and storm pipe). */
export type VerticalRunFilter = (elements: Elements, seg: RunSegment) => boolean;

export interface VerticalRunBase {
  /** The bend (elbow) at the bottom of the run, when there is one. */
  readonly fittingId: ElementId | null;
  /** The piece leaving the run there (the building drain, a horizontal main). */
  readonly drainId: ElementId;
}

export interface VerticalChain {
  /** Stable while the run keeps its lowest piece: the smallest id among its vertical pieces. */
  readonly key: ElementId;
  readonly systemId: ElementId;
  /** Vertical pieces, bottom to top. */
  readonly pieces: readonly ElementId[];
  /** Sloped or level pieces between two vertical pieces, bottom to top. */
  readonly offsets: readonly ElementId[];
  /** The couplings and bends inside the run (offset bends included). */
  readonly fittings: readonly ElementId[];
  /** Bends at the ends of each offset (where flow turns from vertical to horizontal and back). */
  readonly offsetBends: readonly ElementId[];
  readonly base: VerticalRunBase | null;
  /** Height of the bottom and the top of the run, mm above project zero. */
  readonly bottomMm: number;
  readonly topMm: number;
}

// ------------------------------------------------------------ geometry

function asSegment(el: BimElement | undefined): RunSegment | null {
  return el?.kind === "run_segment" ? el : null;
}

function asInlineFitting(el: BimElement | undefined): RunFitting | null {
  // Hosted fittings (tees, wyes, taps, accessories) are branches on a piece, not a joint between pieces.
  return el?.kind === "run_fitting" && !el.host ? el : null;
}

/** Longest jog that is still an offset (plan length): a building drain that ends in a drop to the sewer is not. */
const MAX_OFFSET_MM = 12 * 304.8;

/** Plan drift a vertical piece may have (an inch); a 45° jog is an offset, not more of the stack. */
const PLUMB_MM = 25.4;

export function isVerticalPiece(seg: Pick<RunSegment, "start" | "end">): boolean {
  const rise = Math.abs(seg.end.z - seg.start.z);
  return rise > 1 && Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y) <= PLUMB_MM;
}

/** Height of a segment end, mm above project zero (heights are stored from the segment's own level). */
export function endHeightMm(elements: Elements, seg: RunSegment, end: "start" | "end"): number {
  return levelElevationOf(elements, seg.levelId) + (end === "start" ? seg.start.z : seg.end.z);
}

/** The end of a vertical piece that is lower. */
export function bottomEnd(elements: Elements, seg: RunSegment): "start" | "end" {
  return endHeightMm(elements, seg, "start") <= endHeightMm(elements, seg, "end") ? "start" : "end";
}

const other = (end: "start" | "end"): "start" | "end" => (end === "start" ? "end" : "start");

interface Step {
  /** The fitting between, if any. */
  readonly fittingId: ElementId | null;
  readonly seg: RunSegment;
  /** Which end of `seg` we arrived at. */
  readonly arrived: "start" | "end";
}

/** What a segment end joins, across at most one inline fitting: the next segment and the end we arrive at. */
function stepFrom(elements: Elements, seg: RunSegment, end: "start" | "end"): Step | null {
  const link: PortRef | undefined = seg.links[end];
  if (!link) return null;
  const next = elements[link.elementId];
  const direct = asSegment(next);
  if (direct) return link.port === "start" || link.port === "end" ? { fittingId: null, seg: direct, arrived: link.port } : null;
  const f = asInlineFitting(next);
  if (!f || f.ports.length !== 2) return null;
  const out = f.ports.find((p) => p.id !== link.port);
  const target = out?.link ? asSegment(elements[out.link.elementId]) : null;
  if (!out?.link || !target || (out.link.port !== "start" && out.link.port !== "end")) return null;
  return { fittingId: f.id, seg: target, arrived: out.link.port };
}

// ------------------------------------------------------------ one chain

interface Walk {
  readonly pieces: Set<ElementId>;
  readonly offsets: Set<ElementId>;
  readonly fittings: Set<ElementId>;
  readonly offsetBends: Set<ElementId>;
}

function belongs(elements: Elements, seg: RunSegment, systemId: ElementId, filter: VerticalRunFilter): boolean {
  return seg.systemId === systemId && filter(elements, seg);
}

/**
 * From a vertical piece's end, the next piece of the same run: a vertical piece
 * met bottom-to-top (directly or through one coupling or bend), or an offset
 * leading to one.
 */
function continueFrom(elements: Elements, seg: RunSegment, end: "start" | "end", up: boolean, filter: VerticalRunFilter, walk: Walk, queue: RunSegment[]): void {
  const s = stepFrom(elements, seg, end);
  if (!s || !belongs(elements, s.seg, seg.systemId, filter)) return;
  const arrivedAtBottom = isVerticalPiece(s.seg) ? bottomEnd(elements, s.seg) === s.arrived : null;
  if (arrivedAtBottom !== null) {
    // Vertical to vertical: going up we must arrive at its bottom, going down at its top.
    if (arrivedAtBottom !== up) return;
    if (s.fittingId) walk.fittings.add(s.fittingId);
    if (!walk.pieces.has(s.seg.id)) {
      walk.pieces.add(s.seg.id);
      queue.push(s.seg);
    }
    return;
  }
  // An offset: a short jog whose far end reaches a vertical piece of the run, continuing the same way.
  if (Math.hypot(s.seg.end.x - s.seg.start.x, s.seg.end.y - s.seg.start.y) > MAX_OFFSET_MM) return;
  const far = stepFrom(elements, s.seg, other(s.arrived));
  if (!far || !belongs(elements, far.seg, seg.systemId, filter) || !isVerticalPiece(far.seg)) return;
  if ((bottomEnd(elements, far.seg) === far.arrived) !== up) return;
  walk.offsets.add(s.seg.id);
  for (const fid of [s.fittingId, far.fittingId]) {
    if (!fid) continue;
    walk.fittings.add(fid);
    walk.offsetBends.add(fid);
  }
  if (!walk.pieces.has(far.seg.id)) {
    walk.pieces.add(far.seg.id);
    queue.push(far.seg);
  }
}

/** The chain through a vertical piece (null when the id is not one the filter takes). */
export function walkChain(elements: Elements, seedId: ElementId, filter: VerticalRunFilter): VerticalChain | null {
  const seed = asSegment(elements[seedId]);
  if (!seed || !isVerticalPiece(seed) || !filter(elements, seed)) return null;
  const walk: Walk = { pieces: new Set([seed.id]), offsets: new Set(), fittings: new Set(), offsetBends: new Set() };
  const queue: RunSegment[] = [seed];
  while (queue.length > 0) {
    const seg = queue.pop() as RunSegment;
    const bottom = bottomEnd(elements, seg);
    continueFrom(elements, seg, other(bottom), true, filter, walk, queue);
    continueFrom(elements, seg, bottom, false, filter, walk, queue);
  }
  const pieces = [...walk.pieces].map((id) => elements[id]).filter((s): s is RunSegment => s?.kind === "run_segment");
  const lowOf = (s: RunSegment) => endHeightMm(elements, s, bottomEnd(elements, s));
  const highOf = (s: RunSegment) => endHeightMm(elements, s, other(bottomEnd(elements, s)));
  pieces.sort((a, b) => lowOf(a) - lowOf(b) || a.id.localeCompare(b.id));
  const lowest = pieces[0] as RunSegment;
  const offsets = [...walk.offsets].map((id) => elements[id]).filter((s): s is RunSegment => s?.kind === "run_segment");
  const midOf = (s: RunSegment) => (endHeightMm(elements, s, "start") + endHeightMm(elements, s, "end")) / 2;
  offsets.sort((a, b) => midOf(a) - midOf(b) || a.id.localeCompare(b.id));
  // The base: what leaves the bottom of the lowest piece, when it isn't more of the run.
  const out = stepFrom(elements, lowest, bottomEnd(elements, lowest));
  const base: VerticalRunBase | null = out && !walk.pieces.has(out.seg.id) && !walk.offsets.has(out.seg.id) && !isVerticalPiece(out.seg) ? { fittingId: out.fittingId, drainId: out.seg.id } : null;
  const key = [...walk.pieces].sort()[0] as ElementId;
  return {
    key,
    systemId: seed.systemId,
    pieces: pieces.map((p) => p.id),
    offsets: offsets.map((o) => o.id),
    fittings: [...walk.fittings].sort(),
    offsetBends: [...walk.offsetBends].sort(),
    base,
    bottomMm: lowOf(lowest),
    topMm: Math.max(...pieces.map(highOf)),
  };
}

function membersOf(c: VerticalChain): ElementId[] {
  return [...c.pieces, ...c.offsets, ...c.fittings];
}

// ------------------------------------------------------------ index

export interface VerticalRunIndex {
  readonly chains: readonly VerticalChain[];
  /** Chain by any member id (a piece, an offset, a joint fitting). */
  readonly byMember: ReadonlyMap<ElementId, VerticalChain>;
}

const indexCache = new WeakMap<VerticalRunFilter, WeakMap<object, VerticalRunIndex>>();
const chainCache = new WeakMap<VerticalRunFilter, WeakMap<object, Map<ElementId, VerticalChain | null>>>();

function cacheFor<T>(root: WeakMap<VerticalRunFilter, WeakMap<object, T>>, filter: VerticalRunFilter): WeakMap<object, T> {
  let m = root.get(filter);
  if (!m) root.set(filter, (m = new WeakMap()));
  return m;
}

function indexOf(chains: readonly VerticalChain[]): VerticalRunIndex {
  const sorted = [...chains].sort((a, b) => a.key.localeCompare(b.key));
  const byMember = new Map<ElementId, VerticalChain>();
  for (const c of sorted) for (const id of membersOf(c)) byMember.set(id, c);
  return { chains: sorted, byMember };
}

/** The run through one element (a piece, an offset or a joint), walked on demand and remembered for this model state. */
export function chainAt(elements: Elements, id: ElementId, filter: VerticalRunFilter): VerticalChain | null {
  const full = cacheFor(indexCache, filter).get(elements);
  if (full) return full.byMember.get(id) ?? null;
  const byState = cacheFor(chainCache, filter);
  let memo = byState.get(elements);
  if (!memo) byState.set(elements, (memo = new Map()));
  if (memo.has(id)) return memo.get(id) ?? null;
  const el = elements[id];
  let seed: ElementId | null = null;
  if (el?.kind === "run_segment") seed = isVerticalPiece(el) ? el.id : (verticalNeighbours(elements, el.id, filter)[0] ?? null);
  else if (el?.kind === "run_fitting" && !el.host) seed = verticalNeighbours(elements, el.id, filter)[0] ?? null;
  const chain = seed ? walkChain(elements, seed, filter) : null;
  const found = chain && membersOf(chain).includes(id) ? chain : null;
  if (found) for (const m of membersOf(found)) memo.set(m, found);
  else memo.set(id, null);
  return found;
}

/** Vertical pieces reachable from an element along run ends within a few joints (an offset's two bends, a coupling). */
function verticalNeighbours(elements: Elements, id: ElementId, filter: VerticalRunFilter): ElementId[] {
  const out: ElementId[] = [];
  const seen = new Set<string>([id]);
  let frontier: string[] = [id];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const n of frontier) {
      const el = elements[n];
      const refs: PortRef[] = el?.kind === "run_segment" ? [el.links.start, el.links.end].filter((r): r is PortRef => r !== undefined) : el?.kind === "run_fitting" && !el.host ? el.ports.flatMap((p) => (p.link ? [p.link] : [])) : [];
      for (const r of refs) {
        if (seen.has(r.elementId)) continue;
        seen.add(r.elementId);
        const t = elements[r.elementId];
        if (t?.kind === "run_segment" && isVerticalPiece(t) && filter(elements, t)) out.push(t.id);
        next.push(r.elementId);
      }
    }
    frontier = next;
  }
  return out.sort();
}

/** Every vertical run in the model, once per model state (an index read of run segments, then one walk per run). */
export function verticalRunIndex(elements: Elements, filter: VerticalRunFilter): VerticalRunIndex {
  const cache = cacheFor(indexCache, filter);
  const hit = cache.get(elements);
  if (hit) return hit;
  const chains: VerticalChain[] = [];
  const done = new Set<ElementId>();
  for (const seg of elementsOfKind(elements, "run_segment")) {
    if (done.has(seg.id) || !isVerticalPiece(seg) || !filter(elements, seg)) continue;
    const c = walkChain(elements, seg.id, filter);
    if (!c) continue;
    for (const p of c.pieces) done.add(p);
    chains.push(c);
  }
  const idx = indexOf(chains);
  cache.set(elements, idx);
  return idx;
}

/** Counts for the perf case and tests: how many chains the last advances walked. */
export const verticalRunStats = { walked: 0, full: 0 };

/**
 * The index after an edit: every chain the edit didn't touch is kept as it was;
 * the runs through the changed ids (and the runs they now join or split from)
 * are walked again. Equal to `verticalRunIndex(next)`, at the cost of the
 * changed runs only. `changedIds` are the edit's changed and removed ids.
 */
export function advanceVerticalRunIndex(base: Elements, next: Elements, changedIds: Iterable<string>, filter: VerticalRunFilter): VerticalRunIndex {
  const cache = cacheFor(indexCache, filter);
  const hit = cache.get(next);
  if (hit) return hit;
  const prior = cache.get(base);
  if (!prior) {
    verticalRunStats.full++;
    return verticalRunIndex(next, filter);
  }
  const dirty = new Set<VerticalChain>();
  const seeds = new Set<ElementId>();
  for (const raw of changedIds) {
    const id = raw as ElementId;
    const was = prior.byMember.get(id);
    if (was) dirty.add(was);
    const now = next[id];
    const then = base[id];
    if (now?.kind !== "run_segment" && now?.kind !== "run_fitting" && then?.kind !== "run_segment" && then?.kind !== "run_fitting") continue;
    if (now?.kind === "run_segment" && isVerticalPiece(now) && filter(next, now)) seeds.add(now.id);
    // A new joint or offset can join two runs; one removed can split one. Seed from both sides, in both states.
    for (const v of verticalNeighbours(next, id, filter)) seeds.add(v);
    for (const v of verticalNeighbours(base, id, filter)) {
      const c = prior.byMember.get(v);
      if (c) dirty.add(c);
    }
  }
  for (const c of dirty) for (const p of c.pieces) if (asSegment(next[p])) seeds.add(p);
  const kept = prior.chains.filter((c) => !dirty.has(c));
  const keptMembers = new Map<ElementId, VerticalChain>();
  for (const c of kept) for (const m of membersOf(c)) keptMembers.set(m, c);
  const walked: VerticalChain[] = [];
  const covered = new Set<ElementId>();
  const absorbed = new Set<VerticalChain>();
  for (const s of [...seeds].sort()) {
    if (covered.has(s)) continue;
    const c = walkChain(next, s, filter);
    if (!c) continue;
    verticalRunStats.walked++;
    for (const p of c.pieces) covered.add(p);
    // A kept run this one now reaches through (a new coupling between two stacks) is part of it.
    for (const m of membersOf(c)) {
      const k = keptMembers.get(m);
      if (k) absorbed.add(k);
    }
    walked.push(c);
  }
  const idx = indexOf([...kept.filter((c) => !absorbed.has(c)), ...walked]);
  cache.set(next, idx);
  return idx;
}
