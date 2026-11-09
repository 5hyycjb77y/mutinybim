import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { CLASSIFICATION_POINT, type ClassificationSystemDef } from "../qto/types";

/**
 * Classification systems (KERNEL-FOUNDATION §3.13): a firm's own cost codes
 * first, then any list a provider ships and holds the right to (product owner
 * decision 5). The kernel ships one system only, the firm's own codes, with
 * no codes in it: whatever code a person types is kept and named as typed.
 * MasterFormat and Uniformat are licensed and are never bundled; OmniClass
 * arrives as a provider's data, never kernel data.
 */

/** The firm's own cost codes: open (no list), so any code is accepted and kept. */
export const FIRM_COST_CODES_SYSTEM: ClassificationSystemDef = Object.freeze({
  id: "firm:cost_codes",
  label: "Firm cost codes",
  version: "1",
  licenceNote: "Your firm's own codes. Nothing is bundled; codes are kept exactly as typed.",
});

export interface ClassificationTable {
  readonly systems: readonly ClassificationSystemDef[];
  readonly byId: ReadonlyMap<string, ClassificationSystemDef>;
  /** Per system id, its codes by code (systems that ship codes only). */
  readonly codes: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** The systems of a set: the firm's cost codes, then every pack's, in set order. Built once per set. */
export function classificationTable(set: PackSet = activePackSet()): ClassificationTable {
  return set.memo("kernel.classification#table", () => {
    const systems = [FIRM_COST_CODES_SYSTEM, ...set.packItems(CLASSIFICATION_POINT)];
    const byId = new Map<string, ClassificationSystemDef>();
    const codes = new Map<string, ReadonlyMap<string, string>>();
    for (const s of systems) {
      if (byId.has(s.id)) {
        console.error("[classification] two systems share an id; the first is used", { id: s.id });
        continue;
      }
      byId.set(s.id, s);
      if (s.codes) codes.set(s.id, new Map(s.codes.map((c) => [c.code, c.label])));
    }
    return { systems: [...byId.values()], byId, codes };
  });
}

export function classificationSystems(set: PackSet = activePackSet()): readonly ClassificationSystemDef[] {
  return classificationTable(set).systems;
}

/** What a code is, read against the systems in force. Never drops a code: an unknown system or code is named with why. */
export interface CodeReading {
  readonly system: string;
  readonly code: string;
  /** The system's words for the code, when the system lists it. */
  readonly label: string | null;
  /** The system's name, or the stored id when the system isn't loaded. */
  readonly systemLabel: string;
  /** `known`: listed (or the system is open). `unknown_code`: the system lists codes and this isn't one. `unknown_system`: no loaded system has this id. */
  readonly status: "known" | "unknown_code" | "unknown_system";
  /** For anything but `known`: what a person sees, in words. */
  readonly warning: string | null;
}

export function readCode(system: string, code: string, set: PackSet = activePackSet()): CodeReading {
  const t = classificationTable(set);
  const def = t.byId.get(system);
  if (!def) {
    return { system, code, label: null, systemLabel: system, status: "unknown_system", warning: `${code} is from "${system}", a code list this model's add-ons don't include. It is kept as it was saved.` };
  }
  const list = t.codes.get(system);
  if (!list) return { system, code, label: null, systemLabel: def.label, status: "known", warning: null };
  const label = list.get(code);
  if (label !== undefined) return { system, code, label, systemLabel: def.label, status: "known", warning: null };
  return { system, code, label: null, systemLabel: def.label, status: "unknown_code", warning: `${code} isn't in ${def.label} ${def.version}. It is kept as typed; check the code or the list's version.` };
}
