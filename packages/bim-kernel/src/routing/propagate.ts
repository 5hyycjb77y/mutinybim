import { KernelError, type TrackedReader } from "../model";
import type { BimElement, ElementId, PartInstance } from "../types";
import { add3, dot3, hostedPoints, len3, round3, scale3, segmentAxis, sub3, unit3 } from "./geometry";
import { straightPiece } from "./fittings/geometry";
import { bentFlex } from "./flex";
import { partLabelOf, runLabel } from "./validate";
import type { PortRef, RunFitting, RunPoint, RunSegment } from "./types";

const EPS = 1e-6;

function parallel(d: RunPoint, axis: RunPoint): boolean {
  const u = unit3(d);
  const a = unit3(axis);
  return Math.abs(Math.abs(dot3(u, a)) - 1) < EPS;
}

function perpendicular(d: RunPoint, axis: RunPoint): boolean {
  return Math.abs(dot3(unit3(d), unit3(axis))) < EPS;
}

/** Sloped pipe (a drain pitched up to 1" per ft) moves whole under a push square to its plan run, keeping its slope. */
const PITCH_SIN = Math.sin(Math.atan(1 / 12)) + 1e-6;
function nearlySquare(seg: RunSegment, d: RunPoint, axis: RunPoint): boolean {
  return seg.domain === "pipe" && Math.abs(dot3(unit3(d), unit3(axis))) <= PITCH_SIN;
}

/**
 * The far end of a piece (direction `u`) whose near end moves by `d`, chosen so
 * the next leg (direction `a`) only stretches: the f along `a` with f − d along
 * `u`. Null when `a` runs with `u` or `d` leaves the plane of the two.
 */
export function absorbInto(d: RunPoint, u: RunPoint, a: RunPoint): RunPoint | null {
  const c = dot3(a, u);
  const det = 1 - c * c;
  if (det < 1e-9) return null;
  const alpha = (dot3(a, d) - c * dot3(u, d)) / det;
  const sigma = c * alpha - dot3(u, d);
  const f = scale3(a, alpha);
  const residual = len3(sub3(sub3(f, scale3(u, sigma)), d));
  return residual <= 1e-6 * Math.max(1, len3(d)) ? f : null;
}

/**
 * Translation through routed runs (the routing counterpart of solver.ts).
 * A move `d` enters an element through one of its ports:
 * - a segment square to `d` moves whole and passes `d` on through its far end and its branches;
 * - a segment along `d` stretches or shrinks: only the entered end moves, branches stay where they are;
 * - an elbow, transition or cap moves and passes `d` through its other ports;
 * - a branch entered from its far side slides along its trunk when `d` runs along the trunk;
 * - a part that is not itself being moved refuses: connections are fixed;
 * - anything else (a diagonal push) refuses with the reason.
 */
export class RunPropagator {
  private readonly moved = new Map<ElementId, RunPoint>();

  constructor(
    private readonly reader: TrackedReader,
    private readonly working: Record<string, BimElement>,
    private readonly touched: Set<ElementId>,
    /** Parts the command moves itself: reaching one is not a refusal. */
    private readonly moving: ReadonlySet<string> = new Set(),
  ) {}

  private current(id: ElementId): BimElement {
    this.reader.get(id);
    const el = this.working[id];
    if (!el) throw new KernelError("element_not_found", `Element ${id} does not exist`, [id]);
    return el;
  }

  private set(el: BimElement): void {
    this.working[el.id] = el;
    this.touched.add(el.id);
  }

  private label(el: BimElement): string {
    if (el.kind === "part") return partLabelOf(this.working, el);
    if (el.kind === "run_segment" || el.kind === "run_fitting") return runLabel(this.working, el);
    return el.id;
  }

  /** Push `d` into whatever is linked at `ref` (the port that just moved). */
  pushFrom(ref: PortRef, d: RunPoint): void {
    const el = this.current(ref.elementId);
    const link = linkAt(el, ref.port);
    if (link) this.translateInto(link, d);
  }

  translateInto(entering: PortRef, d: RunPoint): void {
    if (len3(d) < EPS) return;
    const el = this.current(entering.elementId);
    const already = this.moved.get(el.id);
    if (already) {
      if (len3(sub3(already, d)) < EPS) return;
      throw new KernelError("unsupported_geometry", `${this.label(el)} would have to move two different ways; the runs form a loop`, [el.id]);
    }
    switch (el.kind) {
      case "part":
        if (this.moving.has(el.id)) return;
        throw new KernelError(
          "anchored_would_move",
          `${this.label(el)} is connected and stays where it is; this would drag it along. Move it too, or disconnect it first`,
          [el.id],
        );
      case "run_segment":
        this.translateSegment(el, entering.port, d);
        return;
      case "run_fitting":
        this.translateFitting(el, entering.port, d);
        return;
      default:
        throw new KernelError("unsupported_geometry", `${el.id} is a ${el.kind}, not part of a run`, [el.id]);
    }
  }

  private translateSegment(seg: RunSegment, end: string, d: RunPoint): void {
    // Flex bends to follow what it connects to; the move stops there.
    if (seg.flex && (end === "start" || end === "end")) {
      this.moved.set(seg.id, d);
      this.set(bentFlex({ ...seg, flex: seg.flex }, end, d));
      return;
    }
    const axis = sub3(seg.end, seg.start);
    if (parallel(d, axis) && this.carryThroughTransition(seg, end, d)) return;
    if (parallel(d, axis)) {
      // Stretch or shrink: only the entered end moves. Branches keep their place in the building.
      if (end === "start") {
        const along = dot3(d, unit3(axis));
        this.set({ ...seg, start: round3(add3(seg.start, d)) });
        for (const id of seg.branches) {
          const b = this.current(id);
          if (b.kind !== "run_fitting" || !b.host) continue;
          this.set({ ...b, host: { ...b.host, s: Math.round((b.host.s - along) * 1000) / 1000 } });
        }
      } else {
        this.set({ ...seg, end: round3(add3(seg.end, d)) });
      }
      this.moved.set(seg.id, scale3(d, 0));
      return;
    }
    if (perpendicular(d, axis) || nearlySquare(seg, d, axis)) {
      this.moved.set(seg.id, d);
      this.set({ ...seg, start: round3(add3(seg.start, d)), end: round3(add3(seg.end, d)) });
      const far = end === "start" ? seg.links.end : seg.links.start;
      if (far) this.translateInto(far, d);
      for (const id of seg.branches) {
        const b = this.current(id);
        if (b.kind !== "run_fitting") continue;
        this.moveFittingBody(b, d);
        for (const p of b.ports) if (p.link) this.translateInto(p.link, d);
      }
      return;
    }
    // At an angle (a 45° leg, a sloped rise): the entered end takes all of `d`, the piece keeps its direction.
    this.bendLeg(seg, end, d);
  }

  /**
   * A piece pushed along itself that would shrink into what its fittings need,
   * with an in-line transition at its far end and duct in line past it (the
   * short piece on its side out of a riser elbow): it keeps its length and the
   * push goes on through the transition, so the duct past it shortens instead.
   */
  private carryThroughTransition(seg: RunSegment, end: string, d: RunPoint): boolean {
    if (seg.branches.length > 0) return false;
    const u = segmentAxis(seg);
    const shrink = end === "start" ? dot3(d, u) : -dot3(d, u);
    if (shrink <= EPS) return false;
    const far = end === "start" ? seg.links.end : seg.links.start;
    const f = far ? this.current(far.elementId) : null;
    if (!far || f?.kind !== "run_fitting" || f.fittingType !== "transition" || f.host || f.ports.length !== 2) return false;
    const beyond = this.legAxisBeyond(far);
    if (!beyond || !parallel(beyond, u)) return false;
    const piece = straightPiece(this.working, seg);
    if (len3(sub3(seg.end, seg.start)) - shrink >= piece.cutStart + piece.cutEnd) return false;
    this.moved.set(seg.id, d);
    this.set({ ...seg, start: round3(add3(seg.start, d)), end: round3(add3(seg.end, d)) });
    this.translateInto(far, d);
    return true;
  }

  /**
   * The direction of the leg past `ref` (through an in-line elbow, offset or
   * transition, or joined end to end), or null when there is none.
   */
  private legAxisBeyond(ref: PortRef | undefined): RunPoint | null {
    if (!ref) return null;
    const el = this.current(ref.elementId);
    if (el.kind === "run_segment") return segmentAxis(el);
    if (el.kind !== "run_fitting" || el.host || el.ports.length !== 2) return null;
    const out = el.ports.find((p) => p.id !== ref.port)?.link;
    if (!out) return null;
    const next = this.current(out.elementId);
    return next.kind === "run_segment" ? segmentAxis(next) : null;
  }

  /** Where the far end of `seg` goes when its `end` moves by `d`: the next leg stretches if it can, else the piece moves square to itself. */
  private farShift(seg: RunSegment, end: string, d: RunPoint): RunPoint {
    const u = segmentAxis(seg);
    const square = sub3(d, scale3(u, dot3(d, u)));
    const a = this.legAxisBeyond(end === "start" ? seg.links.end : seg.links.start);
    if (!a || len3(square) < EPS) return square;
    return absorbInto(d, u, a) ?? square;
  }

  /**
   * Move `seg`'s start by `ds` and its end by `de` (they differ only along it,
   * so it keeps its direction). Branches keep their place along the length
   * and move with it square to it.
   */
  private shiftSegment(seg: RunSegment, ds: RunPoint, de: RunPoint): RunPoint {
    const u = segmentAxis(seg);
    const shift = dot3(ds, u);
    const square = sub3(ds, scale3(u, shift));
    this.moved.set(seg.id, square);
    this.set({ ...seg, start: round3(add3(seg.start, ds)), end: round3(add3(seg.end, de)) });
    for (const bid of seg.branches) {
      const b = this.current(bid);
      if (b.kind !== "run_fitting") continue;
      if (b.host && Math.abs(shift) > EPS) this.set({ ...b, host: { ...b.host, s: Math.round((b.host.s - shift) * 1000) / 1000 } });
      const fresh = this.current(bid);
      if (len3(square) < EPS || fresh.kind !== "run_fitting") continue;
      this.moveFittingBody(fresh, square);
      for (const p of fresh.ports) if (p.link) this.translateInto(p.link, square);
    }
    return square;
  }

  private moveFittingBody(f: RunFitting, d: RunPoint): void {
    this.moved.set(f.id, d);
    this.set({ ...f, position: round3(add3(f.position, d)), ports: f.ports.map((p) => ({ ...p, position: round3(add3(p.position, d)) })) });
  }

  private translateFitting(f: RunFitting, port: string, d: RunPoint): void {
    if (f.host) {
      const host = this.current(f.host.segmentId);
      if (host.kind !== "run_segment") throw new KernelError("disconnected", `${f.label} isn't on a trunk`, [f.id]);
      const axis = segmentAxis(host);
      if (!parallel(d, axis)) {
        throw new KernelError(
          "unsupported_geometry",
          `${this.label(f)} can only slide along its trunk; this would pull it off. Move the trunk, or disconnect the branch first`,
          [f.id, host.id],
        );
      }
      const s = Math.round((f.host.s + dot3(d, axis)) * 1000) / 1000;
      const at = hostedPoints(host, s, f.host.side, f.host.dir, f.host.face, f.host.t);
      this.moved.set(f.id, d);
      this.set({ ...f, host: { ...f.host, s }, position: at.onAxis, ports: f.ports.map((p) => ({ ...p, position: at.branch })) });
      return;
    }
    this.moveFittingBody(f, d);
    for (const p of f.ports) if (p.id !== port && p.link) this.translateInto(p.link, d);
  }

  /** Slide a branch fitting to `s` on its host, dragging its branch with it. */
  slide(f: RunFitting, s: number): void {
    if (!f.host) throw new KernelError("wrong_kind", `${f.label} isn't on a trunk, so it doesn't slide`, [f.id]);
    const host = this.current(f.host.segmentId);
    if (host.kind !== "run_segment") throw new KernelError("disconnected", `${f.label} isn't on a trunk`, [f.id]);
    const at = hostedPoints(host, s, f.host.side, f.host.dir, f.host.face, f.host.t);
    const d = round3(sub3(at.branch, f.ports[0]?.position ?? at.branch));
    this.moved.set(host.id, scale3(d, 0));
    this.moved.set(f.id, d);
    this.set({ ...f, host: { ...f.host, s }, position: at.onAxis, ports: f.ports.map((p) => ({ ...p, position: at.branch })) });
    const branch = f.ports[0]?.link;
    if (branch) this.translateInto(branch, d);
  }

  /** A host's branch ports move when the host gets wider or narrower: push that into each branch. */
  rehost(host: RunSegment): void {
    this.moved.set(host.id, scale3({ x: 0, y: 0, z: 0 }, 0));
    for (const id of host.branches) {
      const b = this.current(id);
      if (b.kind !== "run_fitting" || !b.host) continue;
      const at = hostedPoints(host, b.host.s, b.host.side, b.host.dir, b.host.face, b.host.t);
      const old = b.ports[0]?.position;
      if (!old) continue;
      const d = round3(sub3(at.branch, old));
      this.moved.set(b.id, d);
      this.set({ ...b, position: at.onAxis, ports: b.ports.map((p) => ({ ...p, position: at.branch })) });
      const link = b.ports[0]?.link;
      if (link && len3(d) > EPS) this.translateInto(link, d);
    }
  }

  markFixed(id: ElementId): void {
    this.moved.set(id, { x: 0, y: 0, z: 0 });
  }

  /**
   * Move a run element the command moves itself, whole, by `d`. Everything in
   * `moving` goes with it; what it is linked to outside that set is pushed the
   * usual way (square runs follow, runs along the move stretch, fixed parts
   * refuse). Call for every moved run element before pushing into parts.
   */
  moveWhole(id: ElementId, d: RunPoint): void {
    const el = this.current(id);
    const already = this.moved.get(el.id);
    if (already) {
      if (len3(sub3(already, d)) < EPS) return;
      throw new KernelError("unsupported_geometry", `${this.label(el)} would have to move two different ways`, [el.id]);
    }
    if (el.kind === "run_segment") {
      this.moved.set(el.id, d);
      this.set({ ...el, start: round3(add3(el.start, d)), end: round3(add3(el.end, d)), ...(el.flex ? { flex: { path: el.flex.path.map((q) => round3(add3(q, d))) } } : {}) });
      for (const bid of el.branches) {
        const b = this.current(bid);
        if (b.kind !== "run_fitting" || this.moving.has(b.id)) continue;
        this.moveFittingBody(b, d);
      }
      return;
    }
    if (el.kind === "run_fitting") {
      const host = el.host ? this.current(el.host.segmentId) : null;
      if (el.host && host && !this.moving.has(host.id)) {
        this.translateFitting(el, el.ports[0]?.id ?? "", d);
        return;
      }
      this.moveFittingBody(el, d);
      return;
    }
    throw new KernelError("wrong_kind", `${this.label(el)} isn't part of a run`, [el.id]);
  }

  /**
   * Drag one piece directly. A straight piece moves whole, square to itself
   * or along itself (what it meets follows: square neighbours move, parallel
   * ones stretch, fixed parts refuse). Pushed square to itself between legs at
   * an angle to the push (a 45° offset), each end slides along its leg instead,
   * so those legs only stretch. An elbow or other in-line fitting moves its
   * corner by `d`: each leg keeps its direction, its entered end takes all of
   * `d` and the rest of it what keeps the next leg straight. With `grip`, only
   * that end of a straight piece moves: the elbow there is dragged, or an open
   * end stretches.
   */
  drag(id: ElementId, d: RunPoint, grip?: "start" | "end"): void {
    const el = this.current(id);
    if (el.kind === "run_segment" && grip) {
      const link = el.links[grip];
      const other = link ? this.current(link.elementId) : null;
      if (other?.kind === "run_fitting" && !other.host && other.ports.length === 2) {
        this.drag(other.id, d);
        return;
      }
      this.bendLeg(el, grip, d);
      if (link) this.translateInto(link, d);
      return;
    }
    if (el.kind === "run_segment") {
      const axis = sub3(el.end, el.start);
      if (!parallel(d, axis) && !perpendicular(d, axis)) {
        throw new KernelError("unsupported_geometry", `Drag the ${this.label(el)} square to it or along it, not at an angle`, [el.id]);
      }
      if (perpendicular(d, axis) && el.branches.length === 0) {
        const u = segmentAxis(el);
        const ends = (["start", "end"] as const).map((end) => {
          const a = this.legAxisBeyond(el.links[end]);
          return a && !parallel(d, a) && !perpendicular(d, a) ? (absorbInto(d, u, a) ?? d) : d;
        });
        const [ds, de] = ends;
        if (ds && de && (ds !== d || de !== d)) {
          this.shiftSegment(el, ds, de);
          if (el.links.start) this.translateInto(el.links.start, ds);
          if (el.links.end) this.translateInto(el.links.end, de);
          return;
        }
      }
      this.moveWhole(el.id, d);
      this.pushOutOf(el.id, d);
      return;
    }
    if (el.kind !== "run_fitting") throw new KernelError("wrong_kind", `${this.label(el)} isn't part of a run`, [el.id]);
    if (el.host) {
      this.translateFitting(el, el.ports[0]?.id ?? "", d);
      const link = el.ports[0]?.link;
      if (link) this.translateInto(link, d);
      return;
    }
    this.moveFittingBody(el, d);
    for (const p of el.ports) {
      if (!p.link) continue;
      const other = this.current(p.link.elementId);
      if (other.kind === "run_segment") this.bendLeg(other, p.link.port, d);
      else this.translateInto(p.link, d);
    }
  }

  /**
   * A leg whose `end` moves by `d` while it keeps its direction: the rest of
   * it moves by what lets the next leg only stretch (`absorbInto`), or else by
   * the part of `d` square to it, and that is pushed on through its far end.
   */
  private bendLeg(seg: RunSegment, end: string, d: RunPoint): void {
    const axis = segmentAxis(seg);
    if (len3(sub3(d, scale3(axis, dot3(d, axis)))) < EPS) {
      this.translateInto({ elementId: seg.id, port: end }, d);
      return;
    }
    const moved = this.moved.get(seg.id);
    if (moved) throw new KernelError("unsupported_geometry", `${this.label(seg)} would have to move two different ways; the runs form a loop`, [seg.id]);
    const f = this.farShift(seg, end, d);
    this.shiftSegment(seg, end === "start" ? d : f, end === "start" ? f : d);
    const far = end === "start" ? seg.links.end : seg.links.start;
    if (far && len3(f) > EPS) this.translateInto(far, f);
  }

  /** After `moveWhole`: push `d` across every link from a moved run element to something outside the moved set. */
  pushOutOf(id: ElementId, d: RunPoint): void {
    const el = this.current(id);
    const links: PortRef[] = [];
    if (el.kind === "run_segment") {
      if (el.links.start) links.push(el.links.start);
      if (el.links.end) links.push(el.links.end);
      for (const bid of el.branches) {
        const b = this.current(bid);
        if (b.kind === "run_fitting" && !this.moving.has(b.id)) for (const p of b.ports) if (p.link) links.push(p.link);
      }
    } else if (el.kind === "run_fitting") {
      for (const p of el.ports) if (p.link) links.push(p.link);
    }
    for (const link of links) if (!this.moving.has(link.elementId)) this.translateInto(link, d);
  }
}

/**
 * A part the command itself moved by `d` carries the runs connected to it, the
 * same way for every command that moves a part (Move, seating it on its host,
 * a mounting plane's height through Move): square runs move, runs along the
 * move stretch, fixed parts refuse. `explain` turns a refusal at one connector
 * into the command's own words; without it the refusal is passed on as is.
 */
export function carryConnectedRuns(runs: RunPropagator, part: PartInstance, d: RunPoint, explain?: (link: PortRef, why: KernelError) => never): void {
  for (const link of Object.values(part.links ?? {})) {
    try {
      runs.translateInto(link, d);
    } catch (err) {
      if (explain && err instanceof KernelError) explain(link, err);
      throw err;
    }
  }
}

export function linkAt(el: BimElement, port: string): PortRef | undefined {
  switch (el.kind) {
    case "run_segment":
      return port === "start" ? el.links.start : port === "end" ? el.links.end : undefined;
    case "run_fitting":
      return el.ports.find((p) => p.id === port)?.link;
    case "part":
      return el.links?.[port];
    default:
      return undefined;
  }
}
