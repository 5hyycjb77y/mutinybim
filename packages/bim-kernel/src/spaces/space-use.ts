import { z } from "zod";
import { REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import { QUANTITY_KEYS, type QuantityBag, type QuantityKey } from "../quantities";
import type { DensityRate } from "../requirements/types";
import type { Space } from "./types";

/**
 * A space's use, pinned into the model when it is set: the library row's name,
 * default occupant density and density rates, copied at that moment. The
 * firm library can change later; a model keeps what it was designed with
 * until someone sets the use again (the same rule as pinned calculations).
 *
 * The rows themselves live in `@permitzip/bim-library` (space-uses.ts) with
 * their code clauses; `@permitzip/bim-calc` (density.ts) converts a row's code
 * units into these canonical rates. The kernel only multiplies.
 *
 * Canonical units: occupants per m² of floor; a rate is the quantity bag's own
 * unit (VA, CFM, …) per m² or per occupant.
 */

export const densityRateSchema = z
  .object({
    key: z.enum(QUANTITY_KEYS),
    per: z.enum(["area", "occupant"]),
    value: z.number().finite().min(0).max(100_000),
  })
  .strict();

/** Peers that read and store `PinnedSpaceUse.parameterRates`. A writer pins them only to a peer that lists it. */
export const SPACES_PARAMETER_RATES_FEATURE = "spaces:parameter_rates";

export const parameterRateSchema = z
  .object({
    key: z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN),
    per: z.enum(["area", "occupant"]),
    value: z.number().finite().min(0).max(1e9),
  })
  .strict();

export const pinnedSpaceUseSchema = z
  .object({
    libraryId: z.string().trim().min(1).max(200),
    useId: z.string().trim().min(1).max(200),
    /** As the row reads: "Restaurant dining rooms". */
    name: z.string().trim().min(1).max(120),
    /** Library row revision that was pinned. */
    revision: z.number().int().min(0).max(1_000_000).optional(),
    /** Default occupants per m² (the code's people per 1,000 ft², converted). */
    occupantsPerM2: z.number().finite().min(0).max(10).optional(),
    rates: z.array(densityRateSchema).max(20).optional(),
    /**
     * Rates onto an add-on's parameter keys (a live load onto `struct.live_load`),
     * in the parameter's unit per m² or per occupant. Read by every reader of
     * this release; written only to peers advertising `spaces:parameter_rates`.
     */
    parameterRates: z.array(parameterRateSchema).max(20).optional(),
  })
  .strict();

export type PinnedSpaceUse = z.infer<typeof pinnedSpaceUseSchema>;

/** The pinned values of a space's use, or null for a bare reference (or none). Records from older clients read as bare. */
export function pinnedUse(space: Pick<Space, "use">): PinnedSpaceUse | null {
  const parsed = pinnedSpaceUseSchema.safeParse(space.use);
  return parsed.success ? parsed.data : null;
}

/**
 * Occupants used for design: the typed number, else the use's default density
 * times the floor area, rounded up (IMC 403.3.1.1: "not less than the number
 * determined from the estimated maximum occupant load rate"). Null when
 * neither is known.
 */
export function designOccupants(space: Pick<Space, "occupants" | "use">, areaM2: number | null): { readonly value: number; readonly basis: "typed" | "use_default" } | null {
  if (space.occupants !== undefined) return { value: space.occupants, basis: "typed" };
  const density = pinnedUse(space)?.occupantsPerM2;
  if (density === undefined || areaM2 === null) return null;
  // The epsilon keeps 600 ft² × 70/1,000 ft² at 42, not 43 from float noise.
  return { value: Math.ceil(areaM2 * density - 1e-9), basis: "use_default" };
}

export interface DensityInputs {
  readonly areaM2: number | null;
  readonly occupants: number | null;
}

export interface DensityEvaluation {
  readonly bag: QuantityBag;
  /** Rates that couldn't be applied, in words ("per person, but the space has no occupants yet"). */
  readonly missing: readonly string[];
}

/** Rate × area (or × occupants), summed per quantity: ASHRAE 62.1's Rp·Pz + Ra·Az is two rates on one key. */
export function evaluateDensity(rates: readonly DensityRate[], inputs: DensityInputs): DensityEvaluation {
  const out: Partial<Record<QuantityKey, number>> = {};
  const missing: string[] = [];
  for (const r of rates) {
    const basis = r.per === "area" ? inputs.areaM2 : inputs.occupants;
    if (basis === null) {
      missing.push(r.per === "area" ? `${r.key} per area, but the space isn't drawn yet` : `${r.key} per person, but the space has no occupants yet`);
      continue;
    }
    out[r.key] = (out[r.key] ?? 0) + r.value * basis;
  }
  for (const k of Object.keys(out) as QuantityKey[]) out[k] = Math.round((out[k] ?? 0) * 1e6) / 1e6;
  return { bag: out, missing };
}

/** What a density evaluation reads off a space: changes to anything else never re-evaluate it. */
export function densityFingerprint(space: Pick<Space, "use" | "occupants">, areaM2: number | null): string {
  const use = pinnedUse(space);
  const parts: unknown[] = [areaM2 === null ? null : Math.round(areaM2 * 1e6), space.occupants ?? null, use?.occupantsPerM2 ?? null, use?.rates ?? null];
  // Appended only when present, so a space with no add-on rates keeps the fingerprint it always had.
  if (use?.parameterRates) parts.push(use.parameterRates);
  return JSON.stringify(parts);
}

/**
 * An add-on's parameter totals for a space: each pinned parameter rate × area
 * (or × occupants), by parameter key. Kept apart from the quantity bag, whose
 * keys are the kernel's own.
 */
export function evaluateParameterRates(space: Pick<Space, "use">, inputs: DensityInputs): { readonly values: Readonly<Record<string, number>>; readonly missing: readonly string[] } {
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const r of pinnedUse(space)?.parameterRates ?? []) {
    const basis = r.per === "area" ? inputs.areaM2 : inputs.occupants;
    if (basis === null) {
      missing.push(r.per === "area" ? `${r.key} per area, but the space isn't drawn yet` : `${r.key} per person, but the space has no occupants yet`);
      continue;
    }
    out[r.key] = Math.round(((out[r.key] ?? 0) + r.value * basis) * 1e6) / 1e6;
  }
  return { values: out, missing };
}
