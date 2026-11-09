import { elementsOfKind, nominalInOf, sameInsulation, type DuctInsulation, type ModelState } from "@permitzip/bim-kernel";
import { scheduledPipeInsulation, type PipeInsulationRow } from "../../routing/pipe/plumbing-settings";
import { projectPlumbingSettings } from "../../routing/pipe/plumbing-catalog";

/**
 * Pipe insulation from the project's schedule (thickness by system kind and
 * pipe size band). The adopted energy code's pipe insulation table is not in
 * PermitZIP's code library (the Virginia energy code instrument holds no
 * sections), so the schedule is the project's own. A starter is offered from
 * PermitZIP's issued pipe insulation schedule (Sample Market,
 * 7492, sheet P1): numbers only, to be checked against the adopted energy
 * code before permit work.
 */

const IN = 25.4;

export const STARTER_PIPE_INSULATION_SOURCE = "PermitZIP issued pipe insulation schedule (7492, sheet P1): 105–140 °F service water; verify against the adopted energy code";

/** Domestic hot water and its return at 105–140 °F: 1" below 1-1/2", 1-1/2" from there up. */
export const STARTER_PIPE_INSULATION: readonly PipeInsulationRow[] = [
  { systemKinds: ["domestic_hot_water", "domestic_hot_water_return"], belowNominalIn: 1, thicknessIn: 1, material: "fiberglass" },
  { systemKinds: ["domestic_hot_water", "domestic_hot_water_return"], belowNominalIn: 1.5, thicknessIn: 1, material: "fiberglass" },
  { systemKinds: ["domestic_hot_water", "domestic_hot_water_return"], belowNominalIn: 48, thicknessIn: 1.5, material: "fiberglass" },
];

export interface PipeInsulationPlan {
  readonly systemId: string;
  readonly systemName: string;
  /** Pipes whose insulation the schedule changes, with what they get (null: none). */
  readonly pieces: ReadonlyArray<{ readonly segmentId: string; readonly insulation: DuctInsulation | null }>;
  /** Pipes the schedule has no row for (left as they are). */
  readonly unscheduled: number;
  readonly source: string | null;
}

/** What the project's schedule gives each pipe of one system, against what it has. */
export function pipeInsulationPlan(model: ModelState, systemId: string): PipeInsulationPlan | { readonly reason: string } {
  const system = model.elements[systemId];
  if (system?.kind !== "mep_system" || system.domain !== "pipe") return { reason: `${systemId} isn't a pipe system in this model.` };
  const settings = projectPlumbingSettings(model.elements);
  const rows = settings.pipeInsulation ?? [];
  if (!rows.some((r) => r.systemKinds.includes(system.systemKind))) {
    return { reason: `The project's pipe insulation schedule has no row for ${system.name} (${system.systemKind.replace(/_/g, " ")}). Add rows in Plumbing › Systems › Insulation, or set a thickness on the run.` };
  }
  const pieces: Array<{ segmentId: string; insulation: DuctInsulation | null }> = [];
  let unscheduled = 0;
  for (const seg of elementsOfKind(model.elements, "run_segment")) {
    if (seg.systemId !== system.id || seg.size.shape !== "pipe") continue;
    const row = scheduledPipeInsulation(rows, system.systemKind, nominalInOf(seg.size));
    if (!row) {
      unscheduled += 1;
      continue;
    }
    const insulation: DuctInsulation | null = row.thicknessIn > 0 ? { kind: "wrap", thicknessMm: Math.round(row.thicknessIn * IN * 1000) / 1000, ...(row.material ? { material: row.material } : {}) } : null;
    if (sameInsulation(seg.insulation, insulation ?? undefined)) continue;
    pieces.push({ segmentId: seg.id, insulation });
  }
  return { systemId: system.id, systemName: system.name, pieces: pieces.sort((a, b) => a.segmentId.localeCompare(b.segmentId)), unscheduled, source: settings.pipeInsulationSource ?? null };
}
