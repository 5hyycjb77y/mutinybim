import { nominalInOf, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { nominalLabel } from "@permitzip/bim-calc";
import type { PipeSizeProposal, PipeSizingFinding, PipeSizingRole } from "./system-sizing";

/** Pieces every plumbing system sizing shares (water, sanitary, vent, storm). */

export const MM_PER_FT = 304.8;
export const MM_PER_IN = 25.4;

export const lengthFt = (s: RunSegment) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z) / MM_PER_FT;

/** A height on a segment's level, above project zero. */
export function absZ(model: ModelState, seg: RunSegment, z: number): number {
  const level = model.elements[seg.levelId];
  return (level?.kind === "level" ? level.elevationMm : 0) + z;
}

/** The pipe segment a walk node is, or null (a fitting, a part end, a load point). */
export function segOf(model: ModelState, n: string): RunSegment | null {
  const el = model.elements[n];
  return el?.kind === "run_segment" && el.size.shape === "pipe" ? el : null;
}

/** `2" pipe san-s1 on Sanitary`. */
export function labelOf(model: ModelState, seg: RunSegment): string {
  const sys = model.elements[seg.systemId];
  return `${nominalLabel(nominalInOf(seg.size))}" pipe ${seg.id}${sys?.kind === "mep_system" ? ` on ${sys.name}` : ""}`;
}

export function proposalOf(seg: RunSegment, label: string, role: PipeSizingRole, proposedIn: number, carries: string, governs: string, extra: Pick<PipeSizeProposal, "frictionPsiPer100Ft" | "velocityFps"> = {}): PipeSizeProposal {
  const current = nominalInOf(seg.size);
  const change = proposedIn > current + 1e-6 ? "up" : proposedIn < current - 1e-6 ? "down" : "same";
  return { segmentId: seg.id, label, role, currentIn: current, proposedIn, current: nominalLabel(current), proposed: nominalLabel(proposedIn), change, carries, governs, ...extra };
}

/** Undersized pipe as errors, pipe larger than needed as notes. */
export function changeFindings(proposals: readonly PipeSizeProposal[], findings: PipeSizingFinding[]): void {
  for (const p of proposals) {
    if (p.change === "up") findings.push({ code: "undersized_pipe", severity: "error", elementId: p.segmentId, message: `The ${p.label} is ${p.current}" and needs ${p.proposed}" (${p.carries}; ${p.governs})` });
    else if (p.change === "down") findings.push({ code: "oversized_pipe", severity: "info", elementId: p.segmentId, message: `The ${p.label} is ${p.current}"; ${p.proposed}" carries it (${p.carries})` });
  }
}
