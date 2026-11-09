import { asElementId, type BimElement, type ElementId, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { DrainageBuilding, FT } from "../../bim-kernel/__tests__/drainage-fixtures";

export { FT };
export const IN = 25.4;

/**
 * A basement drain for the round 13 sewer walk: two 4 in sanitary pipes on
 * the Basement (floor 10 ft below Level 1) running to manhole MH-1. Route
 * draws them level; `slope` rewrites their centreline heights so each test
 * owns the inverts it checks. The manhole has no connectors in the drainage
 * fixture, so the drain's last end is linked to it straight in the records
 * (the walk reads only links).
 */
export class SewerSite extends DrainageBuilding {
  /** Upstream first. */
  segments: ElementId[] = [];

  drawDrain(): void {
    this.ok({ type: "route_run", idPrefix: "bd", levelId: "lvl-b", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: 300, system: { id: "san-1", kind: "sanitary", name: "Sanitary" }, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 20 * FT }] });
    const segs = Object.values(this.head.elements).filter((e): e is RunSegment => e.kind === "run_segment" && e.systemId === "san-1");
    const ordered: RunSegment[] = [];
    const start = segs.find((s) => s.links.start === undefined);
    if (!start) throw new Error("no drain routed");
    ordered.push(start);
    while (ordered.length < segs.length) {
      const last = ordered[ordered.length - 1] as RunSegment;
      const fitting = last.links.end ? this.head.elements[last.links.end.elementId] : undefined;
      const next = segs.find((s) => !ordered.includes(s) && fitting?.kind === "run_fitting" && s.links.start?.elementId === fitting.id);
      if (!next) break;
      ordered.push(next);
    }
    this.segments = ordered.map((s) => s.id);
  }

  /** Centreline heights above the Basement floor (mm) at each pipe's start and end, upstream first. */
  slope(heights: readonly (readonly [number, number])[]): void {
    const next: Record<string, BimElement> = { ...this.head.elements };
    this.segments.forEach((id, i) => {
      const seg = next[id];
      const h = heights[i];
      if (seg?.kind !== "run_segment" || !h) return;
      next[id] = { ...seg, start: { ...seg.start, z: h[0] }, end: { ...seg.end, z: h[1] } };
    });
    this.head = { ...this.head, elements: next };
  }

  /** The drain's last end meets `partId` (its `outlet`). */
  linkToPart(partId: string): void {
    const lastId = this.segments[this.segments.length - 1];
    const next: Record<string, BimElement> = { ...this.head.elements };
    const seg = lastId ? next[lastId] : undefined;
    const part = next[partId];
    if (seg?.kind !== "run_segment" || part?.kind !== "part") throw new Error("nothing to link");
    next[seg.id] = { ...seg, links: { ...seg.links, end: { elementId: asElementId(partId), port: "inlet" } } };
    next[partId] = { ...part, links: { ...part.links, inlet: { elementId: seg.id, port: "end" } } };
    this.head = { ...this.head, elements: next };
  }

  model(): ModelState {
    return this.head;
  }
}
