import { unit3 } from "../geometry";
import type { RunPoint, RunSegment } from "../types";
import { MAX_PITCH_IN_PER_FT } from "./design";
import type { FlowTurn } from "./families";

/**
 * The gravity regime of a pipe run, shared by every trade that drains or
 * pitches pipe (building waste, storm, civil laterals, fire protection
 * drains, condensate, process): which way flow turns at a fitting, a
 * segment's slope, and its nominal size in inches.
 *
 * Gravity decides direction: water only runs down a vertical pipe, and
 * along a sloped one towards its low end. So a turn whose vertical leg goes
 * down from the fitting takes flow horizontal to vertical; one whose
 * vertical leg rises takes it vertical to horizontal. A leg at 45° or
 * steeper counts as vertical.
 */

const IN = 25.4;

export const TURN_PHRASE: Readonly<Record<FlowTurn, string>> = { hv: "horizontal to vertical", vh: "vertical to horizontal", hh: "horizontal to horizontal" };

export function isVerticalLeg(d: RunPoint): boolean {
  return Math.abs(unit3(d).z) >= Math.SQRT1_2 - 1e-3;
}

/** Which way flow turns at an elbow whose legs leave it along `da` and `db`. */
export function turnOrientation(da: RunPoint, db: RunPoint): FlowTurn {
  const va = isVerticalLeg(da);
  const vb = isVerticalLeg(db);
  if (!va && !vb) return "hh";
  if (va && vb) return "hv";
  const v = va ? da : db;
  return v.z < 0 ? "hv" : "vh";
}

/** Which way flow turns where a branch leaving along `branchDir` joins a run along `hostAxis`. */
export function branchOrientation(hostAxis: RunPoint, branchDir: RunPoint): FlowTurn {
  if (isVerticalLeg(branchDir)) return "vh";
  return isVerticalLeg(hostAxis) ? "hv" : "hh";
}

/** Slope of a segment's plan run, in inches per foot (0 for vertical or level). */
export function slopeInPerFt(seg: Pick<RunSegment, "start" | "end">): number {
  const plan = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
  if (plan < 0.01) return 0;
  return (Math.abs(seg.end.z - seg.start.z) / plan) * 12;
}

/** A level-ish (not vertical) run, pitched no more than the pitch limit. */
export function isPitchedOrLevel(seg: Pick<RunSegment, "start" | "end">): boolean {
  const plan = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
  return plan > 0.01 && Math.abs(seg.end.z - seg.start.z) <= (plan * MAX_PITCH_IN_PER_FT) / 12 + 0.01;
}

export function nominalInOf(size: RunSegment["size"]): number {
  return size.shape === "pipe" ? Math.round((size.nominalMm / IN) * 1000) / 1000 : 0;
}
