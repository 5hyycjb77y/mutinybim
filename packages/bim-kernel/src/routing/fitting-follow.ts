import { refuse } from "../command-core";
import type { BimElement } from "../types";
import { chooseFitting } from "./follow-core";
import { familyMismatch, fittingFamily } from "./fittings/library";
import { branchLabelOnFace } from "../registry/fitting-family-point";
import { runLabel } from "./validate";
import type { MepSystem, RunFitting, RunSize } from "./types";

/**
 * A fitting whose ports just took a new size keeps its type when the type is
 * made in that shape. When it isn't (a smooth radius elbow on a run resized
 * to round, a concentric transition whose ends are now rectangular and
 * round, a 45° entry tap on a branch resized to round), it takes the
 * system's choice for the new shape, and the edit says which and why.
 */
export interface Refit {
  readonly fitting: RunFitting;
  /** What changed, in the operator's words; null when the fitting kept its type. */
  readonly note: string | null;
}

export function refitForSize(elements: Readonly<Record<string, BimElement>>, system: MepSystem, f: RunFitting, main?: RunSize): Refit {
  if (!f.family) return { fitting: f, note: null };
  const family = fittingFamily(f.family);
  if (!family) return { fitting: f, note: null };
  const host = f.host ? elements[f.host.segmentId] : undefined;
  const sizes = f.fittingType === "accessory" && host?.kind === "run_segment" ? [host.size] : f.ports.map((p) => p.size);
  const trunk = main ?? (host?.kind === "run_segment" ? host.size : undefined);
  const why = familyMismatch(family, { fittingType: f.fittingType, domain: f.domain, sizes, systemKind: system.systemKind, ...(f.angleDeg !== undefined ? { angleDeg: f.angleDeg } : {}), ...(trunk ? { main: trunk } : {}) });
  if (!why) return { fitting: f, note: null };
  const name = runLabel(elements, f);
  let choice: ReturnType<typeof chooseFitting>;
  try {
    choice = chooseFitting(system, f.fittingType, f.domain, sizes, f.angleDeg, trunk);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    refuse("profile_incompatible", `The ${name} can't follow the new size: ${why}, and ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`, [f.id]);
  }
  const next = fittingFamily(choice.fields.family ?? "");
  const { coefficientOverride: _cleared, family: _old, params: _oldParams, ...rest } = f;
  const label = choice.branchLabel ? branchLabelOnFace(choice.fields.family, choice.branchLabel, rest.host?.face) : null;
  const fitting: RunFitting = { ...rest, ...choice.fields, ...(label ? { label } : {}) };
  return { fitting, note: `The ${name} is now a ${next?.name.toLowerCase() ?? choice.fields.family}: ${why.charAt(0).toLowerCase()}${why.slice(1)}` };
}

/** Refit every touched fitting in a working copy after a resize; returns what changed, in words. */
export function refitTouched(working: Record<string, BimElement>, touched: Iterable<string>): string[] {
  const notes: string[] = [];
  for (const id of touched) {
    const f = working[id];
    if (f?.kind !== "run_fitting") continue;
    const system = working[f.systemId];
    if (system?.kind !== "mep_system") continue;
    const r = refitForSize(working, system, f);
    if (!r.note) continue;
    working[id] = r.fitting;
    notes.push(r.note);
  }
  return notes;
}
