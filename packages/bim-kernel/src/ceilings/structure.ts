import { modelLevels } from "../levels";
import { surfacesAt, type LinkedSurfaceSource } from "../surfaces/surfaces-at";
import type { ModelState, Vec2 } from "../types";
import { ceilingHeightAtPoint, ceilingLabel } from "./read";
import type { Ceiling } from "./types";

/**
 * A ceiling higher than the structure over it is a modelling error every
 * trade trips on (no room for what hangs above it, a height that can't be
 * built). Said in words with the next step; never refused, because the
 * structure may be what is wrong.
 *
 * What counts as the structure, first found wins: what `surfacesAt` finds
 * over the ceiling's corners (our slabs on higher levels and any linked
 * slab or roof the host passes), the hosting space's stated slab-to-slab
 * height, then the next level up.
 */

/** Differences under this are rounding, not a clash. */
const TOLERANCE_MM = 25;
/** Corners probed on a long outline; a plane's highest point is at a corner. */
const MAX_PROBES = 32;

export function ftIn(mm: number): string {
  const sign = mm < 0 ? "-" : "";
  const totalIn = Math.round(Math.abs(mm) / 25.4);
  return `${sign}${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}

interface Clash {
  readonly heightMm: number;
  readonly limitMm: number;
  readonly what: string;
}

function probes(c: Ceiling): Vec2[] {
  const step = Math.max(1, Math.ceil(c.outline.length / MAX_PROBES));
  const out: Vec2[] = [];
  for (let i = 0; i < c.outline.length; i += step) {
    const p = c.outline[i];
    if (p) out.push(p);
  }
  return out;
}

/** Why the ceiling is higher than the structure over it, with what to do; null when it isn't (or nothing over it is known). */
export function ceilingStructureProblem(model: ModelState, c: Ceiling, linked: readonly LinkedSurfaceSource[] = []): string | null {
  const level = model.elements[c.levelId];
  if (level?.kind !== "level") return null;
  const floor = level.elevationMm;
  const clashes: Clash[] = [];
  for (const p of probes(c)) {
    const r = surfacesAt(model, { point: p, levelId: c.levelId }, linked);
    if (r.ok && r.structureAbove) clashes.push({ heightMm: ceilingHeightAtPoint(c, p), limitMm: r.structureAbove.elevationMm - floor, what: r.structureAbove.source.name });
  }
  if (clashes.length === 0) {
    const space = c.spaceId ? model.elements[c.spaceId] : undefined;
    const top = Math.max(...c.outline.map((p) => ceilingHeightAtPoint(c, p)));
    if (space?.kind === "space" && space.slabToSlabMm !== undefined) clashes.push({ heightMm: top, limitMm: space.slabToSlabMm, what: `the slab-to-slab height stated on space ${space.number || space.id}` });
    else {
      let above: { readonly name: string; readonly elevationMm: number } | null = null;
      for (const l of modelLevels(model)) if (l.elevationMm > floor && (!above || l.elevationMm < above.elevationMm)) above = l;
      if (above) clashes.push({ heightMm: top, limitMm: above.elevationMm - floor, what: `the floor of ${above.name}` });
    }
  }
  let worst: Clash | null = null;
  for (const k of clashes) if (k.heightMm - k.limitMm > TOLERANCE_MM && (!worst || k.heightMm - k.limitMm > worst.heightMm - worst.limitMm)) worst = k;
  if (!worst) return null;
  return `${ceilingLabel(c)} reaches ${ftIn(worst.heightMm)} above its floor, ${ftIn(worst.heightMm - worst.limitMm)} higher than ${worst.what} at ${ftIn(worst.limitMm)}. Lower the ceiling, or check that level or slab`;
}
