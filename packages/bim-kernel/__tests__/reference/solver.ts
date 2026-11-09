// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { add, isParallel, isPerpendicular, length, roundVec, scale, sub, unit } from "../../src/geometry";
import { KernelError, TrackedReader, connectionAt, otherEnd } from "./model";
import type { BimElement, ConnectorEnd, ConnectorRef, DuctSegment, ElementId, Vec2 } from "./types";

/**
 * Typed local propagation (v1 envelope: orthogonal routing).
 *
 * A translation `d` enters an element at one connector:
 * - a segment perpendicular to `d` translates whole and passes `d` on;
 * - a segment parallel to `d` is an absorber: only the entered end moves;
 * - fittings (elbows) translate and pass `d` on;
 * - anchored terminals / equipment refuse to move;
 * - anything else is unsupported and refused with a named reason.
 *
 * Taps measure `s` from their host's start, so when a host's start moves or
 * the whole host translates, its taps (and their branches) move with it.
 */
export class Propagator {
  readonly working: Record<string, BimElement>;
  readonly touched = new Set<ElementId>();

  constructor(private readonly reader: TrackedReader) {
    this.working = { ...reader.model.elements };
  }

  current(id: ElementId): BimElement {
    this.reader.get(id);
    const el = this.working[id];
    if (!el) throw new KernelError("element_not_found", `Element ${id} does not exist`, [id]);
    return el;
  }

  set(el: BimElement): void {
    this.working[el.id] = el;
    this.touched.add(el.id);
  }

  /** Push a translation into the element on the far side of `from`. */
  pushAcross(from: ConnectorRef, d: Vec2): void {
    const c = connectionAt(this.reader.model, from);
    if (!c) return;
    this.translateInto(otherEnd(c, from), d);
  }

  translateInto(entering: ConnectorRef, d: Vec2): void {
    if (length(d) === 0) return;
    const el = this.current(entering.elementId);
    switch (el.kind) {
      case "duct_segment":
        this.translateSegment(el, entering.end, d);
        return;
      case "elbow": {
        this.set({ ...el, position: roundVec(add(el.position, d)) });
        const far: ConnectorEnd = entering.end === "in" ? "out" : "in";
        this.pushAcross({ elementId: el.id, end: far }, d);
        return;
      }
      case "terminal":
        if (el.anchored) {
          throw new KernelError(
            "anchored_would_move",
            `${el.mark} is fixed in place and would have to move`,
            [el.id],
          );
        }
        this.set({ ...el, position: roundVec(add(el.position, d)) });
        return;
      case "equipment":
        throw new KernelError(
          "anchored_would_move",
          `${el.mark} would have to move; move the unit explicitly instead`,
          [el.id],
        );
      case "tap":
        throw new KernelError(
          "unsupported_geometry",
          `${el.id} cannot be moved from its branch side in v1`,
          [el.id],
        );
    }
  }

  private translateSegment(seg: DuctSegment, end: ConnectorEnd, d: Vec2): void {
    const axis = sub(seg.end, seg.start);
    if (isParallel(d, axis)) {
      // Absorber: only the entered end moves; the segment stretches or shrinks.
      const next: DuctSegment =
        end === "start"
          ? { ...seg, start: roundVec(add(seg.start, d)) }
          : { ...seg, end: roundVec(add(seg.end, d)) };
      this.set(next);
      if (end === "start") this.shiftHostedTaps(seg.id, d);
      return;
    }
    if (isPerpendicular(d, axis)) {
      this.set({ ...seg, start: roundVec(add(seg.start, d)), end: roundVec(add(seg.end, d)) });
      const far: ConnectorEnd = end === "start" ? "end" : "start";
      this.pushAcross({ elementId: seg.id, end: far }, d);
      this.shiftHostedTaps(seg.id, d);
      return;
    }
    throw new KernelError(
      "unsupported_geometry",
      `Moving ${seg.id} diagonally is outside the v1 orthogonal envelope`,
      [seg.id],
    );
  }

  /**
   * Hosted taps keep their `s` from the host start, so they move in the
   * world with the start; their branches receive the same translation.
   */
  private shiftHostedTaps(hostId: ElementId, d: Vec2): void {
    for (const el of Object.values(this.working)) {
      if (el.kind !== "tap" || el.hostId !== hostId) continue;
      this.reader.get(el.id);
      this.touched.add(el.id);
      this.pushAcross({ elementId: el.id, end: "branch" }, d);
    }
  }
}

export function alongAxis(seg: DuctSegment, distance: number): Vec2 {
  return scale(unit(sub(seg.end, seg.start)), distance);
}
