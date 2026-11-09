import type { DensityRate } from "../requirements/types";
import type { BimElement, ElementId } from "../types";
import { spaceMeasure } from "./space-index";
import { densityFingerprint, designOccupants, evaluateDensity, pinnedUse, type DensityEvaluation } from "./space-use";
import type { Space } from "./types";

/**
 * Density loads on a space, evaluated once per change that matters: the
 * space's area, its use's pinned rates and default density, or its occupants.
 * Renaming the space, moving it to a zone, or any edit elsewhere returns the
 * cached bag. k2's load engine calls `densityLoad` for each estimate whose
 * basis is `density` and whose anchor is a space.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface SpaceDensity extends DensityEvaluation {
  readonly areaM2: number | null;
  readonly occupants: number | null;
  readonly occupantsBasis: "typed" | "use_default" | null;
}

interface Cached {
  readonly key: string;
  readonly value: SpaceDensity;
}

/** Keyed by space id and the rates' identity; holds one value per pair. */
const cache = new Map<string, Cached>();
const MAX_CACHED = 50_000;
let evaluations = 0;

function ratesKey(rates: readonly DensityRate[]): string {
  return rates.map((r) => `${r.key}/${r.per}/${r.value}`).join(";");
}

/** A space record's density fingerprint, kept with the record so an unchanged space is never re-serialized. */
const fingerprints = new WeakMap<Space, { readonly areaM2: number | null; readonly key: string }>();

function fingerprintOf(space: Space, areaM2: number | null): string {
  const hit = fingerprints.get(space);
  if (hit && hit.areaM2 === areaM2) return hit.key;
  const key = densityFingerprint(space, areaM2);
  fingerprints.set(space, { areaM2, key });
  return key;
}

/** Area and design occupants for a space (occupants from the use's density when not typed). */
export function spaceBasis(elements: Elements, space: Space): { readonly areaM2: number | null; readonly occupants: number | null; readonly occupantsBasis: "typed" | "use_default" | null } {
  const areaM2 = spaceMeasure(elements, space.id)?.areaM2 ?? null;
  const occ = designOccupants(space, areaM2);
  return { areaM2, occupants: occ?.value ?? null, occupantsBasis: occ?.basis ?? null };
}

/**
 * Rates × the space's area or occupants. `rates` absent: the use's own pinned
 * rates (the space's default loads). Null when the space is gone.
 */
export function densityLoad(elements: Elements, spaceId: ElementId, rates?: readonly DensityRate[]): SpaceDensity | null {
  const space = elements[spaceId];
  if (space?.kind !== "space") return null;
  const applied = rates ?? pinnedUse(space)?.rates ?? [];
  const areaM2 = spaceMeasure(elements, space.id)?.areaM2 ?? null;
  const slot = `${space.id}\u0000${rates ? ratesKey(applied) : "use"}`;
  const key = fingerprintOf(space, areaM2);
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit.value;
  evaluations += 1;
  const basis = spaceBasis(elements, space);
  const value: SpaceDensity = { ...evaluateDensity(applied, basis), ...basis };
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(slot, { key, value });
  return value;
}

/** How many density evaluations have run (tests prove an unrelated edit re-uses the value). */
export function densityEvaluationCount(): number {
  return evaluations;
}
