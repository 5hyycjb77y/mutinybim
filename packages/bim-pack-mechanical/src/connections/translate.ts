import {
  KernelError,
  TrackedReader,
  add,
  connectionAt,
  isParallel,
  isPerpendicular,
  length,
  otherEnd,
  roundVec,
  sub,
  type ConnectorEnd,
  type ConnectorRef,
  type ElementId,
  type TranslateContext,
  type TranslateFace,
  type Vec2,
} from "@permitzip/bim-kernel";
import {
  type DuctSegment,
} from "../types";

/**
 * How a move travels through an air network (orthogonal routing), moved out
 * of the kernel's `solver.ts` in round 12 as it was. A translation `d`
 * enters an element at one connector:
 * - a duct perpendicular to `d` translates whole and passes `d` on;
 * - a duct parallel to `d` absorbs it: only the entered end moves;
 * - elbows translate and pass `d` on;
 * - anchored terminals and units refuse to move;
 * - anything else is refused with its reason.
 *
 * Taps measure `s` from their host's start, so when a host's start moves or
 * the whole host translates, its taps (and their branches) move with it.
 */
export class AirNetworkMove {
  private hosted: TrackedReader | null = null;

  constructor(readonly ctx: TranslateContext) {}

  /** Push a translation into the element on the far side of `from`. */
  pushAcross(from: ConnectorRef, d: Vec2): void {
    const c = connectionAt(this.ctx.model, from);
    if (!c) return;
    this.translateInto(otherEnd(c, from), d);
  }

  translateInto(entering: ConnectorRef, d: Vec2): void {
    if (length(d) === 0) return;
    const el = this.ctx.current(entering.elementId);
    switch (el.kind) {
      case "duct_segment":
        this.translateSegment(el, entering.end, d);
        return;
      case "elbow": {
        this.ctx.set({ ...el, position: roundVec(add(el.position, d)) });
        const far: ConnectorEnd = entering.end === "in" ? "out" : "in";
        this.pushAcross({ elementId: el.id, end: far }, d);
        return;
      }
      case "terminal":
        if (el.anchored) {
          throw new KernelError("anchored_would_move", `${el.mark} is fixed in place and would have to move`, [el.id]);
        }
        this.ctx.set({ ...el, position: roundVec(add(el.position, d)) });
        return;
      case "equipment":
        throw new KernelError("anchored_would_move", `${el.mark} would have to move; move the unit explicitly instead`, [el.id]);
      case "tap":
        throw new KernelError("unsupported_geometry", `${el.id} cannot be moved from its branch side in v1`, [el.id]);
      default:
        throw new KernelError("unsupported_geometry", `${el.id} is a ${el.kind}, not part of a connected system`, [el.id]);
    }
  }

  /** A unit moves by `d`; the run off its outlet follows. The unit's new position is what a later edit keeps. */
  moveUnit(id: ElementId, d: Vec2): boolean {
    const el = this.ctx.current(id);
    if (el.kind !== "equipment") return false;
    const position = roundVec({ x: el.position.x + d.x, y: el.position.y + d.y });
    this.ctx.set({ ...el, position });
    const out = connectionAt(this.ctx.model, { elementId: el.id, end: "out" });
    if (out) this.translateInto(otherEnd(out, { elementId: el.id, end: "out" }), d);
    this.ctx.author({ elementId: id, field: "position", value: position });
    return true;
  }

  private translateSegment(seg: DuctSegment, end: ConnectorEnd, d: Vec2): void {
    const axis = sub(seg.end, seg.start);
    if (isParallel(d, axis)) {
      // Absorber: only the entered end moves; the run stretches or shrinks.
      const next: DuctSegment = end === "start" ? { ...seg, start: roundVec(add(seg.start, d)) } : { ...seg, end: roundVec(add(seg.end, d)) };
      this.ctx.set(next);
      if (end === "start") this.shiftHostedTaps(seg.id, d);
      return;
    }
    if (isPerpendicular(d, axis)) {
      this.ctx.set({ ...seg, start: roundVec(add(seg.start, d)), end: roundVec(add(seg.end, d)) });
      const far: ConnectorEnd = end === "start" ? "end" : "start";
      this.pushAcross({ elementId: seg.id, end: far }, d);
      this.shiftHostedTaps(seg.id, d);
      return;
    }
    throw new KernelError("unsupported_geometry", `Moving ${seg.id} diagonally is outside the v1 orthogonal envelope`, [seg.id]);
  }

  /**
   * Hosted taps keep their `s` from the host start, so they move in the
   * world with the start; their branches receive the same translation.
   */
  private shiftHostedTaps(hostId: ElementId, d: Vec2): void {
    this.hosted ??= new TrackedReader(this.ctx.model);
    for (const tapId of this.hosted.hostedOn(hostId)) {
      if (this.ctx.model.elements[tapId] === undefined) continue;
      const el = this.ctx.current(tapId);
      if (el.kind !== "tap" || el.hostId !== hostId) continue;
      // Unchanged, but part of the move: the command finishes with it.
      this.ctx.set(el);
      this.pushAcross({ elementId: el.id, end: "branch" }, d);
    }
  }
}

/** The air network's `translate` face: a unit moved on its own carries its run along; every other element is left to the next network. */
export const translateAir: TranslateFace = (ctx, id, delta) => new AirNetworkMove(ctx).moveUnit(id, delta);
