import type { BimElement } from "../../types";
import type { ConnectorFace, FittingBody, Plate, Ring, Tube } from "../fittings/geometry";
import type { FittingFamily, ResolvedFitting } from "../fittings/library";
import { add3, dot3, len3, p3, scale3, segmentAxis, sub3, unit3 } from "../geometry";
import { sizeWidth } from "../rules";
import type { RunFitting, RunPoint, RunPort, RunSegment, RunSize } from "../types";
import { pipeDims, pipeJointEndType, pipeProductTable } from "./specs";

/**
 * Pipe fitting bodies and take-outs, in model millimetres.
 *
 * Take-out is how much straight pipe a fitting replaces at each opening
 * (centre to end of the fitting, less the pipe's engagement in it). Routing
 * cuts each segment back by it, so a leg too short for its fittings is
 * refused like duct. Proportions are generic: bends R tan(θ/2) with R =
 * r/D x OD; tees half the other pipe's OD plus a margin (more for a swept
 * branch); inline items their laying length. An engineer's own value in
 * `takeout_mm` wins. Verify against the fittings submitted.
 */

type Elements = Readonly<Record<string, BimElement>>;

const Z = p3(0, 0, 1);
const cross3 = (a: RunPoint, b: RunPoint): RunPoint => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const neg3 = (a: RunPoint): RunPoint => p3(-a.x, -a.y, -a.z);

function rotate(v: RunPoint, k: RunPoint, angle: number): RunPoint {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add3(add3(scale3(v, c), scale3(cross3(k, v), s)), scale3(k, dot3(k, v) * (1 - c)));
}

function axisAcross(t: RunPoint): RunPoint {
  const u = unit3(t);
  return Math.abs(u.z) < 0.999 ? unit3(cross3(Z, u)) : p3(0, 1, 0);
}

/** A round section of diameter `d` square to `t`. */
function ring(center: RunPoint, t: RunPoint, d: number): Ring {
  const a = axisAcross(t);
  const b = unit3(cross3(unit3(t), a));
  return { center, a: scale3(a, d / 2), b: scale3(b, d / 2), shape: "round" };
}

function num(params: Readonly<Record<string, number | string>>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

export function odOf(size: RunSize): number {
  return size.shape === "pipe" ? pipeDims(size).odMm : size.shape === "round" ? size.diameter : size.shape === "conduit" ? size.tradeSizeMm : 0;
}

/** Width a run's body draws at in 3D, sections and print: a pipe's real outside diameter by its product standard, otherwise its size. */
export function drawnWidth(size: RunSize): number {
  return size.shape === "pipe" ? pipeDims(size).odMm : sizeWidth(size);
}

/** A joint no product here sizes a hub for draws this one (outside diameter and length over the pipe's OD). */
const GENERIC_HUB = { od: 1.3, len: 0.5 } as const;

/** A fitting's hub (socket, coupling band, threaded end): its joint's, from the pipe products' rows. */
function hubOf(params: Readonly<Record<string, number | string>>): { od: number; len: number } {
  const endType = pipeJointEndType(params);
  const hub = endType !== undefined ? pipeProductTable().hub(endType) : undefined;
  return hub ? { od: hub.odOverPipe, len: hub.lengthOverOd } : GENERIC_HUB;
}

/** A hub at an opening: from the fitting end outward along `out`. */
function hubTube(at: RunPoint, out: RunPoint, od: number, params: Readonly<Record<string, number | string>>): Tube {
  const h = hubOf(params);
  return { rings: [ring(at, out, od * h.od), ring(add3(at, scale3(unit3(out), od * h.len)), out, od * h.od)], faceted: true };
}

function ownTakeout(params: Readonly<Record<string, number | string>>): number | null {
  const t = num(params, "takeout_mm", 0);
  return t > 0 ? t : null;
}

// ------------------------------------------------------------------ proportions (exported for validation and tests)

/** Bend take-out: R tan(θ/2), R = r/D x OD. */
export function bendTakeout(family: FittingFamily, params: Readonly<Record<string, number | string>>, od: number, turnDeg: number): { takeout: number; radius: number } {
  const radius = num(params, "r_over_d", family.pipe?.rOverD ?? 1) * od;
  const own = ownTakeout(params);
  return { takeout: own ?? radius * Math.tan(((turnDeg / 2) * Math.PI) / 180), radius };
}

/** Tee / wye proportions: how far the body reaches along the run each way, and into the branch. */
export function teeProportions(family: FittingFamily, params: Readonly<Record<string, number | string>>, runOd: number, branchOd: number): { runHalf: number; branchTakeout: number } {
  const sweep = family.pipe?.branch?.sweep ?? false;
  const combination = family.id === "dwv.combo_wye_eighth";
  const runHalf = combination ? branchOd / (2 * Math.sin(Math.PI / 4)) + 0.5 * runOd : sweep ? 0.5 * branchOd + 0.5 * runOd : 0.5 * branchOd + 0.2 * runOd;
  const own = ownTakeout(params);
  const branchTakeout = own ?? (combination ? 0.5 * runOd + 1.1 * branchOd : sweep ? 0.5 * runOd + 0.75 * branchOd : 0.5 * runOd + 0.2 * branchOd);
  return { runHalf, branchTakeout };
}

/** Inline item laying length along its pipe. */
export function layingLength(family: FittingFamily, params: Readonly<Record<string, number | string>>, od: number): number {
  return ownTakeout(params) ?? (family.pipe?.layingOverOd ?? 1) * od;
}

/** Reducer length: generic concentric proportion. */
export function reducerLength(params: Readonly<Record<string, number | string>>, odLarge: number, odSmall: number): number {
  return ownTakeout(params) ?? Math.max(0.6 * odLarge, 0.6 * odLarge + 1.5 * Math.abs(odLarge - odSmall));
}

/** How far a hosted pipe fitting (tee, valve, cleanout) reaches along its host each way from its centre: what keeps hosted items apart and off the ends. */
export function hostedHalfLength(elements: Elements, f: RunFitting, rf: ResolvedFitting): number {
  const host = f.host ? elements[f.host.segmentId] : undefined;
  if (host?.kind !== "run_segment") return 0;
  const runOd = odOf(host.size);
  if (f.fittingType === "accessory") return layingLength(rf.family, rf.params, runOd) / 2;
  const branch = f.ports[0];
  return branch ? teeProportions(rf.family, rf.params, runOd, odOf(branch.size)).runHalf : 0;
}

// ------------------------------------------------------------------ bodies

function faceOf(p: RunPort): ConnectorFace {
  return { center: p.position, normal: p.direction, size: p.size };
}

function emptyPipeBody(f: RunFitting, family: FittingFamily): FittingBody {
  const faces: Record<string, ConnectorFace> = {};
  const takeoffs: Record<string, number> = {};
  for (const p of f.ports) {
    faces[p.id] = faceOf(p);
    takeoffs[p.id] = 0;
  }
  return { family, tubes: [], plates: [], faces, takeoffs };
}

function bendBody(f: RunFitting, rf: ResolvedFitting): FittingBody {
  const [pa, pb] = f.ports;
  if (!pa || !pb) return emptyPipeBody(f, rf.family);
  const tin = unit3(neg3(pa.direction));
  const tout = unit3(pb.direction);
  const turn = Math.acos(Math.max(-1, Math.min(1, dot3(tin, tout))));
  const n = cross3(tin, tout);
  if (len3(n) < 1e-9) return emptyPipeBody(f, rf.family);
  const k = unit3(n);
  const od = odOf(pa.size);
  const { takeout, radius } = bendTakeout(rf.family, rf.params, od, (turn * 180) / Math.PI);
  const C = f.position;
  const A = add3(C, scale3(pa.direction, takeout));
  const B = add3(C, scale3(pb.direction, takeout));
  const half = turn / 2;
  // The arc meets both legs at the take-out points (its radius follows from the take-out when that was given).
  const R = Math.tan(half) > 1e-9 ? takeout / Math.tan(half) : radius;
  const bis = unit3(add3(pa.direction, pb.direction));
  const O = add3(C, scale3(bis, R / Math.cos(half)));
  const va = sub3(A, O);
  const steps = Math.max(3, Math.ceil(((turn * 180) / Math.PI) / 7.5));
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (turn * i) / steps;
    rings.push(ring(add3(O, rotate(va, k, phi)), rotate(tin, k, phi), od));
  }
  return {
    family: rf.family,
    tubes: [{ rings, faceted: false }, hubTube(A, pa.direction, od, rf.params), hubTube(B, pb.direction, od, rf.params)],
    plates: [],
    faces: { [pa.id]: { center: A, normal: pa.direction, size: pa.size }, [pb.id]: { center: B, normal: pb.direction, size: pb.size } },
    takeoffs: { [pa.id]: takeout, [pb.id]: takeout },
    radiusMm: R,
  };
}

function hostOf(elements: Elements, f: RunFitting): RunSegment | null {
  const h = f.host ? elements[f.host.segmentId] : undefined;
  return h?.kind === "run_segment" ? h : null;
}

function teeBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const port = f.ports[0];
  const host = hostOf(elements, f);
  if (!port || !host) return emptyPipeBody(f, rf.family);
  const u = segmentAxis(host);
  const runOd = odOf(host.size);
  const branchOd = odOf(port.size);
  const { runHalf, branchTakeout } = teeProportions(rf.family, rf.params, runOd, branchOd);
  const P = f.position;
  const n = unit3(port.direction);
  const end = add3(P, scale3(n, branchTakeout));
  const run: Tube = { rings: [ring(add3(P, scale3(u, -runHalf)), u, runOd * 1.04), ring(add3(P, scale3(u, runHalf)), u, runOd * 1.04)], faceted: true };
  const sweep = rf.family.pipe?.branch?.sweep ?? false;
  // A swept branch curves into the run's downstream direction; drawn as a lofted throat leaning that way.
  const throat = sweep ? add3(add3(P, scale3(n, 0.5 * runOd)), scale3(u, 0.25 * branchOd)) : add3(P, scale3(n, 0.5 * runOd));
  const branch: Tube = { rings: [ring(P, n, branchOd), ring(throat, n, branchOd), ring(end, n, branchOd)], faceted: !sweep };
  return {
    family: rf.family,
    tubes: [run, branch, hubTube(add3(P, scale3(u, runHalf)), u, runOd, rf.params), hubTube(add3(P, scale3(u, -runHalf)), neg3(u), runOd, rf.params), hubTube(end, n, branchOd, rf.params)],
    plates: [],
    faces: { [port.id]: { center: end, normal: n, size: port.size } },
    takeoffs: { [port.id]: branchTakeout },
    lengthMm: 2 * runHalf,
  };
}

function isSegmentLink(elements: Elements, p: RunPort): boolean {
  return p.link ? elements[p.link.elementId]?.kind === "run_segment" : false;
}

function reducerBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const [pa, pb] = f.ports;
  if (!pa || !pb) return emptyPipeBody(f, rf.family);
  const oa = odOf(pa.size);
  const ob = odOf(pb.size);
  const L = reducerLength(rf.params, Math.max(oa, ob), Math.min(oa, ob));
  const segA = isSegmentLink(elements, pa);
  const segB = isSegmentLink(elements, pb);
  // Centred on the joint between two pipes; against a part or open end, it grows into the pipe side.
  const ta = segA && segB ? L / 2 : segA ? L : 0;
  const tb = L - ta;
  const A = add3(f.position, scale3(pa.direction, ta));
  const B = add3(f.position, scale3(pb.direction, tb));
  return {
    family: rf.family,
    tubes: [{ rings: [ring(A, pb.direction, oa), ring(B, pb.direction, ob)], faceted: true }, hubTube(A, pa.direction, oa, rf.params), hubTube(B, pb.direction, ob, rf.params)],
    plates: [],
    faces: { [pa.id]: { center: A, normal: pa.direction, size: pa.size }, [pb.id]: { center: B, normal: pb.direction, size: pb.size } },
    takeoffs: { [pa.id]: ta, [pb.id]: tb },
    lengthMm: L,
  };
}

function capBody(f: RunFitting, rf: ResolvedFitting): FittingBody {
  const port = f.ports[0];
  if (!port) return emptyPipeBody(f, rf.family);
  const od = odOf(port.size);
  const h = hubOf(rf.params);
  const into = unit3(port.direction);
  const outer = add3(f.position, scale3(into, -0.15 * od));
  const face = ring(outer, into, od * h.od);
  return {
    family: rf.family,
    tubes: [{ rings: [face, ring(add3(f.position, scale3(into, od * h.len)), into, od * h.od)], faceted: true }],
    plates: [{ kind: "disc", ring: face }],
    faces: { [port.id]: faceOf(port) },
    takeoffs: { [port.id]: 0 },
  };
}

/** Inline items hosted on a pipe: a body along the pipe, plus a valve stem, a cleanout plug, a trap's U, or a drip leg's capped nipple. */
function inlineBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const host = hostOf(elements, f);
  if (!host) return emptyPipeBody(f, rf.family);
  const u = segmentAxis(host);
  const od = odOf(host.size);
  const L = layingLength(rf.family, rf.params, od);
  const P = f.position;
  const kind = rf.family.pipe?.accessory;
  const along = (d: number, s: number) => add3(P, scale3(u, s * d));
  const up = Math.abs(u.z) > 0.7 ? axisAcross(u) : Z;
  const tubes: Tube[] = [];
  const plates: Plate[] = [];
  const bodyOd = kind === "valve" || kind === "gas_cock" || kind === "prv" ? 1.5 : kind === "union" ? 1.4 : kind === "coupling" ? 1.15 : 1.25;
  if (kind === "trap") {
    // P-trap: the arm dips into a U below the pipe and comes back up.
    const dip = 1.6 * od;
    const pts = [along(L / 2, -1), add3(along(L / 4, -1), scale3(up, -dip * 0.8)), add3(P, scale3(up, -dip)), add3(along(L / 4, 1), scale3(up, -dip * 0.8)), along(L / 2, 1)];
    tubes.push({ rings: pts.map((p, i) => ring(p, i + 1 < pts.length ? sub3(pts[i + 1] ?? p, p) : sub3(p, pts[i - 1] ?? p), od)), faceted: false });
  } else {
    tubes.push({ rings: [ring(along(L / 2, -1), u, od * bodyOd), ring(along(L / 2, 1), u, od * bodyOd)], faceted: true });
  }
  if (kind === "valve" || kind === "gas_cock" || kind === "prv") {
    tubes.push({ rings: [ring(P, up, od * 0.4), ring(add3(P, scale3(up, od * 1.4)), up, od * 0.4)], faceted: true });
  }
  if (kind === "cleanout" || kind === "test_tee") {
    const side = Math.abs(u.z) > 0.7 ? axisAcross(u) : up;
    const plug = add3(P, scale3(side, 0.9 * od));
    tubes.push({ rings: [ring(P, side, od), ring(plug, side, od)], faceted: true });
    plates.push({ kind: "disc", ring: ring(plug, side, od * 1.1) });
  }
  if (kind === "drip_leg") {
    const nipple = num(rf.params, "nipple_mm", 76.2);
    const down = Math.abs(u.z) > 0.7 ? scale3(u, Math.sign(u.z) || 1) : neg3(Z);
    const bottom = add3(along(L / 2, u.z > 0 ? -1 : 1), scale3(down, -nipple));
    const top = along(L / 2, u.z > 0 ? -1 : 1);
    tubes.push({ rings: [ring(top, sub3(bottom, top), od), ring(bottom, sub3(bottom, top), od)], faceted: true });
    plates.push({ kind: "disc", ring: ring(bottom, sub3(bottom, top), od * 1.2) });
  }
  return { family: rf.family, tubes, plates, faces: {}, takeoffs: {}, lengthMm: L };
}

/** The body of a pipe fitting from the pipe library. */
export function pipeFittingBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  switch (rf.family.pipe?.form) {
    case "bend":
      return f.fittingType === "elbow" ? bendBody(f, rf) : emptyPipeBody(f, rf.family);
    case "tee":
      return teeBody(elements, f, rf);
    case "reducer":
      return reducerBody(elements, f, rf);
    case "cap":
      return capBody(f, rf);
    case "inline":
    case "trap":
    case "drip_leg":
      return inlineBody(elements, f, rf);
    default:
      return emptyPipeBody(f, rf.family);
  }
}
