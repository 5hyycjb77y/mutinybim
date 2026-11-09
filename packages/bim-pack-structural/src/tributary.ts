import { fromCanonical, type Quantity } from "@permitzip/bim-units";
import type { Vec2 } from "@permitzip/bim-kernel/types";

/**
 * Tributary strips of a one-way deck (KERNEL-FOUNDATION §3.15, "tributary
 * areas"). The deck spans along its span direction between parallel supports
 * (beams, joists) running across it. Each support carries the deck from
 * halfway to the support before it to halfway to the support after it; past
 * the first and last support the strip runs to the deck's edge.
 *
 * Plain geometry in the model frame (millimetres), so the derived-zone rule,
 * the load path and the tests share one answer. Limits, said plainly:
 * rectangular one-way decks (the outline's extent is used), supports square
 * to the span (within 1°), and a support's neighbours are the nearest
 * supports whose extent across the span overlaps its own.
 */

export interface DeckSpan {
  readonly id: string;
  /** Counter-clockwise outline, mm. */
  readonly outline: readonly Vec2[];
  /** One-way span direction, counter-clockwise from east. */
  readonly spanDirectionDeg: number;
}

export interface SpanSupport {
  readonly id: string;
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface TributaryStrip {
  readonly supportId: string;
  readonly deckId: string;
  /** Width along the span. */
  readonly width: Quantity<"length">;
  /** Length along the support that the deck bears on. */
  readonly length: Quantity<"length">;
  readonly area: Quantity<"area">;
  /** Plan corners, counter-clockwise, mm. */
  readonly outline: readonly Vec2[];
  /** The supports either side, or null where the strip runs to the deck's edge. */
  readonly previousId: string | null;
  readonly nextId: string | null;
}

/** Square to the span within this angle. */
const SQUARE_TOLERANCE = Math.sin((1 * Math.PI) / 180);
/** A support may sit this far outside the deck's outline and still carry it (an edge beam drawn on the edge). */
const EDGE_TOLERANCE_MM = 50;
/** Two supports closer than this along the span are one line. */
const SAME_LINE_MM = 1;

interface Frame {
  readonly s: Vec2;
  readonly p: Vec2;
  readonly sMin: number;
  readonly sMax: number;
  readonly pMin: number;
  readonly pMax: number;
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

function frameOf(deck: DeckSpan): Frame | null {
  if (deck.outline.length < 3 || !Number.isFinite(deck.spanDirectionDeg)) return null;
  const r = (deck.spanDirectionDeg * Math.PI) / 180;
  const s = { x: Math.cos(r), y: Math.sin(r) };
  const p = { x: -s.y, y: s.x };
  let sMin = Infinity;
  let sMax = -Infinity;
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const v of deck.outline) {
    const a = dot(v, s);
    const b = dot(v, p);
    sMin = Math.min(sMin, a);
    sMax = Math.max(sMax, a);
    pMin = Math.min(pMin, b);
    pMax = Math.max(pMax, b);
  }
  return { s, p, sMin, sMax, pMin, pMax };
}

interface Placed {
  readonly support: SpanSupport;
  /** Where it sits along the span. */
  readonly t: number;
  /** Its extent across the span, clipped to the deck. */
  readonly p0: number;
  readonly p1: number;
}

function placed(f: Frame, support: SpanSupport): Placed | null {
  const dx = support.end.x - support.start.x;
  const dy = support.end.y - support.start.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  if (Math.abs(dx * f.s.x + dy * f.s.y) > SQUARE_TOLERANCE * len) return null;
  const t = (dot(support.start, f.s) + dot(support.end, f.s)) / 2;
  if (t < f.sMin - EDGE_TOLERANCE_MM || t > f.sMax + EDGE_TOLERANCE_MM) return null;
  const a = dot(support.start, f.p);
  const b = dot(support.end, f.p);
  const p0 = Math.max(Math.min(a, b), f.pMin);
  const p1 = Math.min(Math.max(a, b), f.pMax);
  if (p1 - p0 <= SAME_LINE_MM) return null;
  return { support, t, p0, p1 };
}

/** Whether a support carries this deck: square to its span and lying across it. */
export function carriesDeck(deck: DeckSpan, support: SpanSupport): boolean {
  const f = frameOf(deck);
  return f !== null && placed(f, support) !== null;
}

const overlaps = (a: Placed, b: Placed) => Math.min(a.p1, b.p1) - Math.max(a.p0, b.p0) > SAME_LINE_MM;

/** The nearest overlapping support either side, scanning out from `i` in `sorted` (ascending `t`). */
function neighbours(sorted: readonly Placed[], i: number): { prev: Placed | null; next: Placed | null } {
  const me = sorted[i];
  if (!me) return { prev: null, next: null };
  let prev: Placed | null = null;
  let next: Placed | null = null;
  for (let k = i - 1; k >= 0 && !prev; k--) {
    const o = sorted[k];
    if (o && o.t < me.t - SAME_LINE_MM && overlaps(o, me)) prev = o;
  }
  for (let k = i + 1; k < sorted.length && !next; k++) {
    const o = sorted[k];
    if (o && o.t > me.t + SAME_LINE_MM && overlaps(o, me)) next = o;
  }
  return { prev, next };
}

const at = (f: Frame, s: number, p: number): Vec2 => ({ x: s * f.s.x + p * f.p.x, y: s * f.s.y + p * f.p.y });

/** Every carrying support's strip on this deck, by support id. Supports that don't carry it are left out. */
export function tributaryStrips(deck: DeckSpan, supports: readonly SpanSupport[]): Map<string, TributaryStrip> {
  const out = new Map<string, TributaryStrip>();
  const f = frameOf(deck);
  if (!f) return out;
  const sorted = supports
    .map((s) => placed(f, s))
    .filter((x): x is Placed => x !== null)
    .sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const me = sorted[i];
    if (!me) continue;
    const { prev, next } = neighbours(sorted, i);
    const lo = Math.max(f.sMin, prev ? (prev.t + me.t) / 2 : f.sMin);
    const hi = Math.min(f.sMax, next ? (me.t + next.t) / 2 : f.sMax);
    const width = Math.max(0, hi - lo);
    const length = me.p1 - me.p0;
    out.set(me.support.id, {
      supportId: me.support.id,
      deckId: deck.id,
      width: fromCanonical("length", width / 1000),
      length: fromCanonical("length", length / 1000),
      area: fromCanonical("area", (width * length) / 1e6),
      // (s, p) is right-handed, so this order is counter-clockwise.
      outline: [at(f, lo, me.p0), at(f, hi, me.p0), at(f, hi, me.p1), at(f, lo, me.p1)],
      previousId: prev?.support.id ?? null,
      nextId: next?.support.id ?? null,
    });
  }
  return out;
}

export interface DeckPointShare {
  readonly supportId: string;
  /** Share of the load this support takes (the lever rule across the span). */
  readonly fraction: number;
}

interface SupportIndex {
  readonly f: Frame;
  /** Carrying supports, ascending along the span. */
  readonly sorted: readonly Placed[];
}

const indexes = new WeakMap<readonly SpanSupport[], WeakMap<DeckSpan, SupportIndex | null>>();

/** A deck's carrying supports sorted along its span, once per (supports list, deck). */
function supportIndex(deck: DeckSpan, supports: readonly SpanSupport[]): SupportIndex | null {
  let perDeck = indexes.get(supports);
  if (!perDeck) {
    perDeck = new WeakMap();
    indexes.set(supports, perDeck);
  }
  if (perDeck.has(deck)) return perDeck.get(deck) ?? null;
  const f = frameOf(deck);
  const ix = f
    ? {
        f,
        sorted: supports
          .map((s) => placed(f, s))
          .filter((x): x is Placed => x !== null)
          .sort((a, b) => a.t - b.t),
      }
    : null;
  perDeck.set(deck, ix);
  return ix;
}

/**
 * How a point load standing on the deck splits between the supports either
 * side of it, by the lever rule (the deck strip as a simple span between
 * them). With a support on one side only, it takes the whole load and the
 * caller is told (`cantilever`). Pass the same `supports` array for every
 * point on a deck: the sorted supports are kept per array.
 */
export function deckPointShares(deck: DeckSpan, supports: readonly SpanSupport[], point: Vec2): { readonly shares: readonly DeckPointShare[]; readonly cantilever: boolean } {
  const ix = supportIndex(deck, supports);
  if (!ix) return { shares: [], cantilever: false };
  const { f, sorted } = ix;
  const tp = dot(point, f.s);
  const pp = dot(point, f.p);
  const across = (o: Placed) => pp >= o.p0 - SAME_LINE_MM && pp <= o.p1 + SAME_LINE_MM;
  // First support past the point along the span.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid]?.t ?? Infinity) <= tp) lo = mid + 1;
    else hi = mid;
  }
  let prev: Placed | null = null;
  let next: Placed | null = null;
  for (let k = lo - 1; k >= 0 && !prev; k--) {
    const o = sorted[k];
    if (o && across(o)) prev = o;
  }
  for (let k = lo; k < sorted.length && !next; k++) {
    const o = sorted[k];
    if (o && across(o)) next = o;
  }
  if (prev && next) {
    const d = next.t - prev.t;
    return { shares: [{ supportId: prev.support.id, fraction: (next.t - tp) / d }, { supportId: next.support.id, fraction: (tp - prev.t) / d }], cantilever: false };
  }
  const only = prev ?? next;
  return only ? { shares: [{ supportId: only.support.id, fraction: 1 }], cantilever: Math.abs(only.t - tp) > SAME_LINE_MM } : { shares: [], cantilever: false };
}
