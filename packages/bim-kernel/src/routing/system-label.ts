import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { SystemKind } from "../parts";
import type { BimElement } from "../types";
import { systemRules } from "./rules";
import type { MepSystem } from "./types";

/**
 * What a system is, in words, where its kind's word isn't the whole answer
 * (v1): a fuel line says its fuel ("Propane"), a process line its medium.
 * Read from the system's own design data, never its name. The first row of
 * the set that answers wins; with none, the kind's word.
 */
export interface SystemLabelDef {
  readonly id: string;
  label(system: MepSystem): string | null;
}

export const SYSTEM_LABEL_POINT = defineExtensionPoint<SystemLabelDef>({ id: "kernel.system_label", version: 1, label: "System words", idOf: (r) => r.id });

/** What a system is, in words: its kind's word, unless a row of the set in force names it more exactly. */
export function systemKindLabel(system: MepSystem | null | undefined, kind?: SystemKind): string {
  if (system) {
    for (const row of activePackSet().items(SYSTEM_LABEL_POINT)) {
      const label = row.label(system);
      if (label !== null) return label;
    }
  }
  return systemRules(kind ?? system?.systemKind ?? "other").label;
}

/** The kind word of the system an element belongs to (`run_segment`, `run_fitting`), or of the kind given. */
export function systemKindLabelOf(elements: Readonly<Record<string, BimElement>>, systemId: string | undefined, kind: SystemKind): string {
  const system = systemId ? elements[systemId] : undefined;
  return systemKindLabel(system?.kind === "mep_system" && system.systemKind === kind ? system : null, kind);
}
