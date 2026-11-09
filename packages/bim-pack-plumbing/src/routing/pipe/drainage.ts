import type { BimElement, MepSystem, RunFitting, RunPoint, RunSegment, FlowTurn, PipeRunCheckDef } from "@permitzip/bim-kernel";
import { fittingFamily, resolveFitting, type FittingFamily, segmentAxis, runLabel, inPerFtLabel, minSlopeFor, serviceOf, type DirectionAllowance, type DirectionRule, type PipeDesign, TURN_PHRASE, branchOrientation, isPitchedOrLevel, isVerticalLeg, nominalInOf, slopeInPerFt, turnOrientation } from "@permitzip/bim-kernel";

/**
 * Drainage rules: slope on horizontal drains, which fittings may change the
 * flow's direction where, and which way flow runs through each fitting. The
 * gravity arithmetic (slope, which way a turn takes flow) is the kernel's
 * (`routing/pipe/gravity.ts`); these are the plumbing code's answers on it.
 */

type Elements = Readonly<Record<string, BimElement>>;

function allows(a: DirectionAllowance, inches: number): boolean {
  if (typeof a === "boolean") return a;
  if (a.minIn !== undefined && inches < a.minIn - 1e-6) return false;
  if (a.maxIn !== undefined && inches > a.maxIn + 1e-6) return false;
  return true;
}

function allowanceWords(a: DirectionAllowance): string {
  if (typeof a === "boolean") return "";
  if (a.minIn !== undefined && a.maxIn !== undefined) return ` only from ${a.minIn}" to ${a.maxIn}"`;
  if (a.minIn !== undefined) return ` only at ${a.minIn}" and larger`;
  if (a.maxIn !== undefined) return ` only up to ${a.maxIn}"`;
  return "";
}

/** A family's direction rule with the project's override on top. */
export function directionRuleOf(family: FittingFamily, design: PipeDesign | undefined): DirectionRule | null {
  const base = family.pipe?.direction;
  const own = design?.directionRules?.find((r) => r.family === family.id);
  if (!base && !own) return null;
  const any = { hv: true, vh: true, hh: true } as const;
  return { ...(base ?? any), ...(own?.hv !== undefined ? { hv: own.hv } : {}), ...(own?.vh !== undefined ? { vh: own.vh } : {}), ...(own?.hh !== undefined ? { hh: own.hh } : {}) };
}

const SUGGEST: Readonly<Record<"turn" | "branch", Readonly<Record<FlowTurn, readonly string[]>>>> = {
  turn: { hv: ["dwv.quarter_bend_short_sweep", "dwv.quarter_bend_long_sweep"], vh: ["dwv.quarter_bend_long_sweep", "dwv.quarter_bend_short_sweep"], hh: ["dwv.quarter_bend_long_sweep"] },
  branch: { hv: ["dwv.sanitary_tee", "dwv.combo_wye_eighth"], vh: ["dwv.combo_wye_eighth"], hh: ["dwv.combo_wye_eighth"] },
};

/** Why `family` can't change the flow's direction this way at this size, or null. The reason names a fitting that can. */
export function directionIssue(family: FittingFamily, turn: FlowTurn, inches: number, design: PipeDesign | undefined, what: "turn" | "branch"): string | null {
  const rule = directionRuleOf(family, design);
  if (!rule || allows(rule[turn], inches)) return null;
  const alt = SUGGEST[what][turn]
    .map((id) => fittingFamily(id))
    .find((f): f is FittingFamily => f !== null && f.id !== family.id && (() => {
      const r = directionRuleOf(f, design);
      return !r || allows(r[turn], inches);
    })());
  const limit = allowanceWords(rule[turn]);
  return `A ${family.name.toLowerCase()} can't take flow ${TURN_PHRASE[turn]}${limit ? ` here (${limit.trim()}; this is ${inches}")` : ""}${alt ? `; use a ${alt.name.toLowerCase()}` : ""}`;
}

/** Does the segment drain towards the end that meets `port`? Null when it is level or vertical. */
function drainsToward(seg: RunSegment, port: "start" | "end"): boolean | null {
  if (!isPitchedOrLevel(seg)) return null;
  const here = port === "start" ? seg.start.z : seg.end.z;
  const far = port === "start" ? seg.end.z : seg.start.z;
  if (Math.abs(here - far) < 0.1) return null;
  return here < far;
}

function linkedSegment(elements: Elements, f: RunFitting, portId: string): { seg: RunSegment; end: "start" | "end" } | null {
  const p = f.ports.find((q) => q.id === portId);
  const el = p?.link ? elements[p.link.elementId] : undefined;
  if (el?.kind !== "run_segment" || !p?.link) return null;
  return p.link.port === "start" || p.link.port === "end" ? { seg: el, end: p.link.port } : null;
}

function systemOf(elements: Elements, el: RunSegment | RunFitting): MepSystem | null {
  const s = elements[el.systemId];
  return s?.kind === "mep_system" ? s : null;
}

/** Drainage reasons a fitting is wrong where it is: direction change, flow direction through it, drains getting smaller. */
export function drainageFittingIssue(elements: Elements, f: RunFitting): string | null {
  const system = systemOf(elements, f);
  if (!system || serviceOf(system.systemKind) !== "drainage") return null;
  const rf = resolveFitting(system, f);
  if (!rf?.family.pipe) return null;
  const design = system.design?.pipe;
  const name = runLabel(elements, f);
  const size = f.ports[0]?.size;
  const inches = size ? nominalInOf(size) : 0;
  if (f.fittingType === "elbow") {
    const [pa, pb] = f.ports;
    if (!pa || !pb) return null;
    const turn = turnOrientation(pa.direction, pb.direction);
    const why = directionIssue(rf.family, turn, inches, design, "turn");
    if (why) return why;
    const a = linkedSegment(elements, f, pa.id);
    const b = linkedSegment(elements, f, pb.id);
    const ta = a ? drainsToward(a.seg, a.end) : null;
    const tb = b ? drainsToward(b.seg, b.end) : null;
    if (turn === "hh" && ta !== null && tb !== null && ta === tb) {
      return ta ? `Both drains at the ${name} slope down into it, so they meet head-on; one has to slope away from it` : `Both drains at the ${name} slope away from it; flow can't split at an elbow, so one has to slope towards it`;
    }
    if (turn !== "hh") {
      const horiz = isVerticalLeg(pa.direction) ? { t: tb, s: b } : { t: ta, s: a };
      if (horiz.t !== null && horiz.s) {
        if (turn === "hv" && horiz.t === false) return `The ${runLabel(elements, horiz.s.seg)} slopes away from the ${name}, but flow goes down the pipe below it; slope it down towards the ${name}`;
        if (turn === "vh" && horiz.t === true) return `The ${runLabel(elements, horiz.s.seg)} slopes down into the ${name}, against the flow coming down the pipe above it; slope it away`;
      }
    }
    return null;
  }
  if ((f.fittingType === "tee" || f.fittingType === "wye") && f.host) {
    const host = elements[f.host.segmentId];
    const port = f.ports[0];
    if (host?.kind !== "run_segment" || !port) return null;
    const turn = branchOrientation(segmentAxis(host), port.direction);
    const why = directionIssue(rf.family, turn, inches, design, "branch");
    if (why) return why;
    const b = linkedSegment(elements, f, port.id);
    const t = b ? drainsToward(b.seg, b.end) : null;
    if (b && t === false) return `The ${runLabel(elements, b.seg)} slopes away from the ${name}, so it can't drain into the run it joins; slope it down towards the ${name}`;
    return null;
  }
  if (f.fittingType === "transition") {
    const [pa, pb] = f.ports;
    if (!pa || !pb || pa.size.shape !== "pipe" || pb.size.shape !== "pipe") return null;
    // The downstream side is the one whose pipe leaves the fitting downward (vertical) or slopes away from it.
    const downstreamOf = (pid: string, dir: RunPoint): boolean | null => {
      if (isVerticalLeg(dir)) return dir.z < 0;
      const s = linkedSegment(elements, f, pid);
      const t = s ? drainsToward(s.seg, s.end) : null;
      return t === null ? null : !t;
    };
    const aDown = downstreamOf(pa.id, pa.direction);
    const bDown = downstreamOf(pb.id, pb.direction);
    const down = aDown === true ? pa : bDown === true ? pb : aDown === false ? pb : bDown === false ? pa : null;
    const up = down === pa ? pb : down === pb ? pa : null;
    if (down && up && down.size.shape === "pipe" && up.size.shape === "pipe" && down.size.nominalMm < up.size.nominalMm - 0.5) {
      return `A drain can't get smaller in the direction of flow; the ${name} goes from ${nominalInOf(up.size)}" down to ${nominalInOf(down.size)}"`;
    }
  }
  return null;
}

/** Slope a gravity drain needs, or the reason it falls short. */
export function slopeIssue(elements: Elements, seg: RunSegment): string | null {
  const system = systemOf(elements, seg);
  if (!system || serviceOf(system.systemKind) !== "drainage" || seg.size.shape !== "pipe" || !isPitchedOrLevel(seg)) return null;
  const inches = nominalInOf(seg.size);
  const need = minSlopeFor(inches, system.design?.pipe);
  const has = slopeInPerFt(seg);
  if (has + 1e-3 >= need) return null;
  const name = runLabel(elements, seg);
  return has < 1e-3
    ? `The ${name} is level; ${inches}" ${system.name} drains need at least ${inPerFtLabel(need)}. Slope it (set_slope), or change the system's slope rule`
    : `The ${name} slopes ${inPerFtLabel(has)}; ${inches}" ${system.name} drains need at least ${inPerFtLabel(need)}`;
}

/** Drainage's pipe run checks (`PIPE_RUN_CHECK_POINT`): slope on a drain, direction and flow through its fittings. */
export const DRAINAGE_RUN_CHECK: PipeRunCheckDef = {
  id: "drainage",
  segment(elements, seg) {
    const slope = slopeIssue(elements, seg);
    return slope ? [{ code: "invalid_value", message: slope, elementIds: [seg.id] }] : [];
  },
  fitting(elements, f) {
    const drain = drainageFittingIssue(elements, f);
    return drain ? [{ code: "profile_incompatible", message: drain, elementIds: [f.id] }] : [];
  },
};
