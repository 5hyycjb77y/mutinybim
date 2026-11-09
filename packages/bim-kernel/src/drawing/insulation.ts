import { fittingBody, segmentRings, type Ring, type Tube } from "../routing/fittings/geometry";
import { len3, p3, scale3 } from "../routing/geometry";
import type { BimElement, ModelState, RunFitting, RunSegment, Vec2 } from "../types";
import { projectSolid, type Projector } from "./projection";
import { ringPoints, type ElementSolid, type Piece } from "./solids";
import type { LineFn } from "./runs";

/**
 * Where a run's insulation shows: the wrap's outside face or the liner's
 * inside face, as rings offset from the sheet metal (a pipe's outside
 * diameter) by the thickness. Plans
 * draw it as thin dashed lines beside the duct, sections as a thin dashed
 * outline where the cut passes through, and the 3D view as a see-through
 * skin over wrapped duct. Single-line (coarse) drawings leave it out.
 */

/** Paper mm, the drafting convention for insulation and lining: thin and dashed. */
export const INSULATION_DASH: number[] = [1.5, 1];

type RunPiece = RunSegment | RunFitting;

function isInsulated(el: BimElement): el is RunPiece {
  return (el.kind === "run_segment" || el.kind === "run_fitting") && (el.domain === "duct" || el.domain === "pipe") && el.insulation !== undefined;
}

function grow(r: Ring, by: number): Ring {
  const k = (v: Ring["a"]) => {
    const l = len3(v);
    return l > 0 ? scale3(v, Math.max(1, l + by) / l) : v;
  };
  return { ...r, a: k(r.a), b: k(r.b) };
}

/** The insulation face as tubes in model millimetres (z above the level floor); none for bare duct or pipe, or fittings without a body. */
export function insulationEnvelope(model: Pick<ModelState, "elements">, el: BimElement): Tube[] {
  if (!isInsulated(el) || !el.insulation) return [];
  const by = el.insulation.kind === "wrap" ? el.insulation.thicknessMm : -el.insulation.thicknessMm;
  if (el.kind === "run_segment") {
    const rings = segmentRings(model.elements, el);
    return rings.lengthMm > 0 ? [{ rings: [grow(rings.start, by), grow(rings.end, by)], faceted: true }] : [];
  }
  if (el.family === undefined) return [];
  return fittingBody(model.elements, el).tubes.map((t) => ({ ...t, rings: t.rings.map((r) => grow(r, by)) }));
}

const plan = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: p.y });

/** Plan linework: both sides of each insulated tube, or the ring outline of a riser seen from above. */
export function drawInsulationPlan(model: Pick<ModelState, "elements">, el: BimElement, line: LineFn): void {
  for (const tube of insulationEnvelope(model, el)) {
    const first = tube.rings[0];
    if (!first) continue;
    const n = p3(first.a.y * first.b.z - first.a.z * first.b.y, first.a.z * first.b.x - first.a.x * first.b.z, first.a.x * first.b.y - first.a.y * first.b.x);
    if (Math.abs(n.z) > 0.9 * len3(n)) {
      // Seen end on: a riser or drop.
      const pts = ringPoints(first).map(plan);
      pts.forEach((q, i) => line(q, pts[(i + 1) % pts.length] ?? q, "thin", INSULATION_DASH));
      continue;
    }
    const side = (r: Ring, k: 1 | -1): Vec2 => {
      const h = Math.abs(r.a.z) <= Math.abs(r.b.z) ? r.a : r.b;
      return { x: r.center.x + k * h.x, y: r.center.y + k * h.y };
    };
    for (let i = 0; i + 1 < tube.rings.length; i++) {
      const r0 = tube.rings[i];
      const r1 = tube.rings[i + 1];
      if (!r0 || !r1) continue;
      line(side(r0, 1), side(r1, 1), "thin", INSULATION_DASH);
      line(side(r0, -1), side(r1, -1), "thin", INSULATION_DASH);
    }
  }
}

function levelElevation(model: Pick<ModelState, "elements">, levelId: string): number {
  const level = model.elements[levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** The insulation face as a solid in world millimetres (level elevation added), for sections. */
export function insulationSolid(model: Pick<ModelState, "elements">, el: BimElement): ElementSolid | null {
  const tubes = insulationEnvelope(model, el);
  if (tubes.length === 0 || !isInsulated(el)) return null;
  const z = levelElevation(model, el.levelId);
  const lift = (r: Ring): Ring => ({ ...r, center: p3(r.center.x, r.center.y, r.center.z + z) });
  const pieces: Piece[] = [];
  for (const tube of tubes) {
    for (let i = 0; i + 1 < tube.rings.length; i++) {
      const r0 = tube.rings[i];
      const r1 = tube.rings[i + 1];
      if (r0 && r1) pieces.push({ r0: ringPoints(lift(r0)), r1: ringPoints(lift(r1)), smooth: r0.shape !== "rect", edge0: false, edge1: false });
    }
  }
  return { owner: el.id, category: el.kind === "run_segment" ? "duct" : "duct_fitting", role: "mep", pieces };
}

/** Section outlines (view u, v) where the cut passes through this element's insulation; none when it doesn't. */
export function insulationSectionCuts(model: Pick<ModelState, "elements">, el: BimElement, projector: Projector): Vec2[][] {
  const solid = insulationSolid(model, el);
  if (!solid) return [];
  return projectSolid(solid, projector).cuts.map((poly) => poly.map((q) => ({ x: q.u, y: q.v })));
}
