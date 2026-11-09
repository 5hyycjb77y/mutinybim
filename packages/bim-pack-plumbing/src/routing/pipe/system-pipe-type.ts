import { catalogKey, familyTurnAngles, fittingFamilies, pipeFamilyOf, type FittingSlot, type PipeMaterial, type PipeServiceOf, type SystemKind } from "@permitzip/bim-kernel";
import { BUILTIN_PIPE_TYPES, pipeTypeAllowsSize, pipeTypeMismatch, type PipeTypeEntry } from "./pipe-types";
import type { PipeTypeRecord } from "./plumbing-catalog";

/**
 * Which pipe type a new run on a system draws with (round 16: the product owner picked
 * Sanitary in the Route panel and got 1" copper with sweat elbows, and the
 * Pipe types he saved were never read by routing).
 *
 * The project's own saved types come first, then the firm's built-in types in
 * the order the firm lists them; a type that names the system kind beats one
 * that only suits its material; a system that already has pipe keeps that
 * material. Fittings then follow the type's material (DWV materials take the
 * drainage families: long sweeps, combination wye & 1/8 bend, sanitary tee),
 * plus any fitting the engineer picked on the type.
 */

/** The size a new run of each service starts at, in inches, before the type's own size range. */
export const SERVICE_START_SIZE_IN: Readonly<Record<PipeServiceOf, number>> = {
  water: 0.75,
  drainage: 3,
  vent: 2,
  gas: 1,
};

const builtinRank = new Map(BUILTIN_PIPE_TYPES.map((t, i) => [catalogKey(t.name), i]));

/** Every pipe type that can carry this system kind, in the order a pick prefers them. */
export function pipeTypesForSystem(records: readonly PipeTypeRecord[], kind: SystemKind): readonly PipeTypeEntry[] {
  const fit = records.filter((r) => pipeTypeMismatch(r.entry, kind) === null);
  const rank = (r: PipeTypeRecord) => [r.entry.systemKinds.includes(kind) ? 0 : 1, r.saved ? 0 : 1, r.saved ? 0 : (builtinRank.get(catalogKey(r.entry.name)) ?? BUILTIN_PIPE_TYPES.length)] as const;
  return [...fit]
    .sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.entry.name.localeCompare(b.entry.name);
    })
    .map((r) => r.entry);
}

/**
 * The pipe type a new run on this system draws with: the first in
 * `pipeTypesForSystem`, one of the existing pipe's material when the system
 * already has some, preferring one that comes in `nominalIn`. Null when no
 * type carries the kind (the person picks the material by hand).
 */
export function pipeTypeForSystem(records: readonly PipeTypeRecord[], kind: SystemKind, existing?: { readonly material: PipeMaterial; readonly nominalIn?: number }): PipeTypeEntry | null {
  const all = pipeTypesForSystem(records, kind);
  const same = existing ? all.filter((t) => t.material === existing.material) : [];
  const pool = same.length > 0 ? same : all;
  const size = existing?.nominalIn;
  return (size !== undefined ? pool.find((t) => pipeTypeAllowsSize(t, size)) : undefined) ?? pool[0] ?? null;
}

/** The size (inches) a new run on this system starts at with this type: the service's start size, kept inside the type's range. */
export function startSizeFor(t: PipeTypeEntry, kind: SystemKind): number {
  const service = pipeFamilyOf(kind);
  const start = service ? SERVICE_START_SIZE_IN[service] : 1;
  return Math.min(t.maxIn ?? start, Math.max(t.minIn ?? start, start));
}

/** Fittings a route on this type places over the material's defaults: only the ones the engineer picked on the type. */
export function pipeTypeRouteFittings(t: PipeTypeEntry): Partial<Record<FittingSlot, { readonly family: string }>> {
  const out: Partial<Record<FittingSlot, { readonly family: string }>> = {};
  for (const [slot, family] of Object.entries(t.fittings) as Array<[FittingSlot, string | undefined]>) if (family) out[slot] = { family };
  return out;
}

/** The bend angles (degrees) the library makes in this type's material for this system's service, smallest first: 22.5, 45, 60, 90 for PVC DWV. */
export function pipeTypeBendAngles(t: PipeTypeEntry, kind: SystemKind): readonly number[] {
  const service = pipeFamilyOf(kind);
  if (!service) return [];
  const want = service === "vent" ? "drainage" : service;
  const out = new Set<number>();
  for (const f of fittingFamilies()) {
    if (f.domain !== "pipe" || !f.fittingTypes.includes("elbow") || !f.pipe || !f.pipe.materials.includes(t.material)) continue;
    if (!f.pipe.services.includes(want) && !f.pipe.services.includes(service)) continue;
    for (const a of familyTurnAngles(f)) out.add(a);
  }
  return [...out].sort((a, b) => a - b);
}
