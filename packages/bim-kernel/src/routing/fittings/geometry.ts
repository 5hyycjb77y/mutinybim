import { asElementId, type BimElement } from "../../types";
import { add3, dot3, hostedPoints, len3, p3, portInfo, scale3, segmentAxis, sub3, unit3 } from "../geometry";
import type { RunFitting, RunPoint, RunSegment, RunSize } from "../types";
import { pipeFittingBody } from "../pipe/geometry";
import { pipeDims } from "../pipe/specs";
import { resolveFitting, type FittingFamily, type ResolvedFitting } from "./library";

/**
 * Sheet-metal geometry for routed fittings, in model millimetres.
 *
 * A fitting sits at its insertion point (the corner of an elbow, the
 * connector a transition meets, the trunk face a tap is cut into); its body
 * reaches a `takeoff` distance into each segment it joins, and the segment's
 * straight duct is cut back by that much. Topology never changes when a
 * family is swapped: only the derived body and cut-backs do.
 *
 * A body is a set of tubes (chains of cross-section rings, lofted), thin
 * plates (turning vanes, cap discs) and the connector faces. `fittingMesh`
 * triangulates it for any renderer.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type RingShape = "rect" | "round" | "oval";

/** A cross-section: centre plus two half-axis vectors (a across the width, b across the height). */
export interface Ring {
  readonly center: RunPoint;
  readonly a: RunPoint;
  readonly b: RunPoint;
  readonly shape: RingShape;
}

export interface Tube {
  readonly rings: readonly Ring[];
  /** Straight between rings (gores, mitres) rather than smooth. */
  readonly faceted: boolean;
}

/** A thin sheet: a polyline swept by `extrude` (a turning vane), or a closed disc (`disc`). */
export type Plate = { readonly kind: "sheet"; readonly points: readonly RunPoint[]; readonly extrude: RunPoint } | { readonly kind: "disc"; readonly ring: Ring };

export interface ConnectorFace {
  readonly center: RunPoint;
  /** Out of the fitting. */
  readonly normal: RunPoint;
  readonly size: RunSize;
}

export interface FittingBody {
  readonly family: FittingFamily | null;
  readonly tubes: readonly Tube[];
  readonly plates: readonly Plate[];
  readonly faces: Readonly<Record<string, ConnectorFace>>;
  /** How far the body reaches into the element linked at each port (that element's straight piece is cut back by this). */
  readonly takeoffs: Readonly<Record<string, number>>;
  /** Elbows and offsets: centreline radius (mm). */
  readonly radiusMm?: number;
  /** Transitions: body length; offsets: length along the run. */
  readonly lengthMm?: number;
}

const Z = p3(0, 0, 1);
const cross3 = (a: RunPoint, b: RunPoint): RunPoint => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const neg3 = (a: RunPoint): RunPoint => p3(-a.x, -a.y, -a.z);
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Width axis of a duct travelling along `t`: horizontal and square to it; for vertical travel, `fallback`. */
export function widthAxisFor(t: RunPoint, fallback: RunPoint): RunPoint {
  const u = unit3(t);
  if (Math.abs(u.z) < 0.999) return unit3(cross3(Z, u));
  return unit3(fallback);
}

const isPlumb = (t: RunPoint): boolean => Math.abs(unit3(t).z) >= 0.999;

/** The width axis a riser takes when nothing it joins says otherwise. */
export const RISER_DEFAULT_WIDTH_AXIS: RunPoint = p3(0, 1, 0);

/**
 * Width axis of a routed segment. Level and sloped duct carry the width level
 * and square to travel. A riser has no level of its own: it takes the width
 * that what joins its start leaves it with (the elbow turning up into it, the
 * riser it continues), else what joins its end, so it lines up with the
 * fittings at both ends. Null when nothing it joins decides.
 */
export function riserWidthAxis(elements: Elements, seg: RunSegment, seen: Set<string> = new Set()): RunPoint | null {
  const u = unit3(sub3(seg.end, seg.start));
  if (!isPlumb(u)) return unit3(cross3(Z, u));
  if (seen.has(seg.id)) return null;
  seen.add(seg.id);
  for (const port of ["start", "end"] as const) {
    const link = seg.links[port];
    if (!link || seen.has(link.elementId)) continue;
    const other = elements[link.elementId];
    const w = other?.kind === "run_segment" ? riserWidthAxis(elements, other, seen) : other?.kind === "run_fitting" ? fittingWidthAt(elements, other, link.port, seen) : null;
    if (w) return w;
  }
  return null;
}

/** Width axis of a routed segment (see `riserWidthAxis`); a riser joined to nothing that decides takes `RISER_DEFAULT_WIDTH_AXIS`. */
export function segmentWidthAxis(elements: Elements, seg: RunSegment): RunPoint {
  return riserWidthAxis(elements, seg) ?? RISER_DEFAULT_WIDTH_AXIS;
}

/** The width axis a fitting leaves at one of its ports, from its other side. An elbow from a level or sloped leg into a riser keeps the level leg's width. */
function fittingWidthAt(elements: Elements, f: RunFitting, portId: string, seen: Set<string>): RunPoint | null {
  seen.add(f.id);
  const others = f.ports.filter((p) => p.id !== portId);
  if (f.fittingType === "elbow") {
    const other = others[0];
    return other && !isPlumb(other.direction) ? unit3(cross3(Z, unit3(other.direction))) : null;
  }
  if (f.fittingType !== "transition" && f.fittingType !== "offset" && f.fittingType !== "accessory") return null;
  for (const p of others) {
    if (!p.link || seen.has(p.link.elementId)) continue;
    const el = elements[p.link.elementId];
    const w = el?.kind === "run_segment" ? riserWidthAxis(elements, el, seen) : el?.kind === "run_fitting" ? fittingWidthAt(elements, el, p.link.port, seen) : null;
    if (w) return w;
  }
  return null;
}

/** Width axis of the duct at a run's port (a segment end or a fitting's port); null when nothing decides, or for a part. */
export function portWidthAxis(elements: Elements, ref: { readonly elementId: string; readonly port: string }): RunPoint | null {
  const el = elements[ref.elementId];
  if (el?.kind === "run_segment") return riserWidthAxis(elements, el);
  if (el?.kind === "run_fitting") return fittingWidthAt(elements, el, ref.port, new Set());
  return null;
}

/** Width axis of the run a fitting joins at `port` (null when that is not a segment, or nothing decides). */
function linkedWidthAxisOf(elements: Elements, f: Pick<RunFitting, "id">, port: RunFitting["ports"][number] | undefined): RunPoint | null {
  const el = port?.link ? elements[port.link.elementId] : undefined;
  return el?.kind === "run_segment" ? riserWidthAxis(elements, el, new Set([f.id])) : null;
}

/** Where a route being drawn would join a run: an open end, or a branch of `size` cut into a trunk's side at `s` from its start. */
export type RouteJoin =
  | { readonly kind: "run_end"; readonly elementId: string; readonly port: string }
  | { readonly kind: "run_branch"; readonly segmentId: string; readonly s: number; readonly side: 1 | -1; readonly size: RunSize };

/** The face a route would meet (an open end's face, or the patch on a trunk's side a branch is cut into) and which way out of it the route leaves. */
export function routeJoinFace(elements: Elements, join: RouteJoin): { ring: Ring; normal: RunPoint } | null {
  if (join.kind === "run_end") {
    const info = portInfo(elements, { elementId: asElementId(join.elementId), port: join.port });
    if (!info?.size) return null;
    const w = widthAxisFor(info.direction, portWidthAxis(elements, join) ?? RISER_DEFAULT_WIDTH_AXIS);
    return { ring: ring(info.position, info.direction, w, info.size), normal: unit3(info.direction) };
  }
  const host = elements[join.segmentId];
  if (host?.kind !== "run_segment") return null;
  const at = hostedPoints(host, join.s, join.side);
  return { ring: ring(at.branch, at.outward, widthAxisFor(at.outward, segmentAxis(host)), join.size), normal: at.outward };
}

/** The two cross-sections of a segment's straight duct (after the fittings at its ends take their share), each square to its axis. */
export function segmentRings(elements: Elements, seg: RunSegment): { start: Ring; end: Ring; lengthMm: number } {
  const piece = straightPiece(elements, seg);
  const t = unit3(sub3(seg.end, seg.start));
  const w = segmentWidthAxis(elements, seg);
  return { start: ring(piece.start, t, w, seg.size), end: ring(piece.end, t, w, seg.size), lengthMm: piece.lengthMm };
}

function dims(size: RunSize): { w: number; h: number; shape: RingShape | null } {
  switch (size.shape) {
    case "rect":
    case "oval":
      return { w: size.width, h: size.height, shape: size.shape };
    case "round":
      return { w: size.diameter, h: size.diameter, shape: "round" };
    case "pipe": {
      const od = pipeDims(size).odMm;
      return { w: od, h: od, shape: null };
    }
    case "conduit":
      return { w: size.tradeSizeMm, h: size.tradeSizeMm, shape: null };
  }
}

function ring(center: RunPoint, tangent: RunPoint, widthAxis: RunPoint, size: RunSize, stretchW = 1, stretchH = 1): Ring {
  const d = dims(size);
  const w = unit3(widthAxis);
  const hAxis = unit3(cross3(tangent, w));
  return { center, a: scale3(w, (d.w / 2) * stretchW), b: scale3(hAxis, (d.h / 2) * stretchH), shape: d.shape ?? "round" };
}

/** Rotate `v` about unit `k` by `angle` (Rodrigues). */
function rotate(v: RunPoint, k: RunPoint, angle: number): RunPoint {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add3(add3(scale3(v, c), scale3(cross3(k, v), s)), scale3(k, dot3(k, v) * (1 - c)));
}

function num(params: Readonly<Record<string, number | string>>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

// ------------------------------------------------------------------ elbows

export interface ElbowFrame {
  readonly turnDeg: number;
  /** Travel into the elbow and out of it. */
  readonly tin: RunPoint;
  readonly tout: RunPoint;
  /** Normal of the plane of the turn. */
  readonly normal: RunPoint;
  readonly widthAxisIn: RunPoint;
  /** Duct dimension in the plane of the turn (what r/W divides by), and the other one. */
  readonly planeDim: number;
  readonly depthDim: number;
}

/**
 * The elbow's turn and how the duct lies through it. Coming out of a riser,
 * the width is the riser's (pass `elements` so it can be read): the elbow then
 * turns the duct on its height or, if the riser came up from a leg square to
 * this one, on its width.
 */
export function elbowFrame(f: Pick<RunFitting, "id" | "ports">, elements: Elements = {}): ElbowFrame | null {
  const [pa, pb] = f.ports;
  if (!pa || !pb) return null;
  const tin = unit3(neg3(pa.direction));
  const tout = unit3(pb.direction);
  const c = Math.max(-1, Math.min(1, dot3(tin, tout)));
  const turnDeg = (Math.acos(c) * 180) / Math.PI;
  const n = cross3(tin, tout);
  if (len3(n) < 1e-9) return null;
  const normal = unit3(n);
  const riser = isPlumb(tin) ? linkedWidthAxisOf(elements, f, pa) : null;
  const widthAxisIn = riser ?? widthAxisFor(tin, widthAxisFor(tout, p3(0, 1, 0)));
  const d = dims(pa.size);
  // Width square to the plane of the turn: the height is what bends.
  const widthOutOfPlane = Math.abs(dot3(widthAxisIn, normal)) > 0.5;
  return { turnDeg, tin, tout, normal, widthAxisIn, planeDim: widthOutOfPlane ? d.h : d.w, depthDim: widthOutOfPlane ? d.w : d.h };
}

function arcSteps(turnDeg: number): number {
  return Math.max(2, Math.ceil(turnDeg / 7.5));
}

/** How far an elbow of this family reaches into each leg from its corner, for a duct `planeDim` across the turn. */
export function elbowTakeoffMm(rf: ResolvedFitting, planeDim: number, turnDeg: number): number {
  if (rf.family.geometry === "mitred_elbow") return planeDim / 2;
  return num(rf.params, "r_over_w", 1) * planeDim * Math.tan(rad(turnDeg) / 2);
}

function elbowBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const frame = elbowFrame(f, elements);
  const [pa, pb] = f.ports;
  if (!frame || !pa || !pb) return emptyBody(f, rf.family);
  const size = pa.size;
  const C = f.position;
  const half = rad(frame.turnDeg) / 2;
  const geometry = rf.family.geometry;
  const mitred = geometry === "mitred_elbow";
  const radius = mitred ? frame.planeDim / 2 : num(rf.params, "r_over_w", 1) * frame.planeDim;
  const t = elbowTakeoffMm(rf, frame.planeDim, frame.turnDeg);
  const A = add3(C, scale3(pa.direction, t));
  const B = add3(C, scale3(pb.direction, t));
  const faces = { [pa.id]: { center: A, normal: pa.direction, size }, [pb.id]: { center: B, normal: pb.direction, size } };
  const takeoffs = { [pa.id]: t, [pb.id]: t };
  const wIn = frame.widthAxisIn;
  // The width axis turns with the duct about the plane normal.
  const widthAt = (angle: number) => rotate(wIn, frame.normal, angle);
  if (mitred) {
    // Two straight pieces meeting on the mitre plane; the mitre section is longer across the turn by 1/cos(θ/2).
    const tMid = unit3(add3(frame.tin, frame.tout));
    const mid = ring(C, tMid, widthAt(half), size);
    const inPlaneIsA = Math.abs(dot3(wIn, frame.normal)) < 0.5;
    const stretch = 1 / Math.cos(half);
    const mitre: Ring = inPlaneIsA ? { ...mid, a: scale3(mid.a, stretch) } : { ...mid, b: scale3(mid.b, stretch) };
    const rings = [ring(A, frame.tin, widthAt(0), size), mitre, ring(B, frame.tout, widthAt(2 * half), size)];
    const plates: Plate[] = rf.family.loss === "vaned_elbow" ? vanes(frame, rf, C) : [];
    return { family: rf.family, tubes: [{ rings, faceted: true }], plates, faces, takeoffs, radiusMm: 0 };
  }
  // Arc centre: inside the turn, R / cos(θ/2) from the corner along the bisector.
  const bis = unit3(add3(pa.direction, pb.direction));
  const O = add3(C, scale3(bis, radius / Math.cos(half)));
  const va = sub3(A, O);
  const k = frame.normal;
  const sweep = 2 * half;
  const at = (phi: number): { p: RunPoint; t: RunPoint } => {
    const v = rotate(va, k, phi);
    return { p: add3(O, v), t: unit3(rotate(frame.tin, k, phi)) };
  };
  const rings: Ring[] = [];
  if (geometry === "gored_elbow") {
    // n gores: two half-gores at the ends, n − 2 full gores; joints between them.
    const gores = Math.max(3, Math.round(num(rf.params, "gores", 5)));
    const joints = gores - 1;
    const step = sweep / joints;
    rings.push(ring(A, frame.tin, widthAt(0), size));
    for (let j = 1; j <= joints; j++) {
      const phi = (j - 0.5) * step;
      const { p, t: tan } = at(phi);
      // Joint section sits on the mitre plane between two gores: stretched across the turn by 1/cos(step/2).
      const r = ring(p, tan, widthAt(phi), size);
      const s = 1 / Math.cos(step / 2);
      rings.push(Math.abs(dot3(wIn, k)) < 0.5 ? { ...r, a: scale3(r.a, s) } : { ...r, b: scale3(r.b, s) });
    }
    rings.push(ring(B, frame.tout, widthAt(sweep), size));
    return { family: rf.family, tubes: [{ rings, faceted: true }], plates: [], faces, takeoffs, radiusMm: radius };
  }
  const n = arcSteps(frame.turnDeg);
  for (let i = 0; i <= n; i++) {
    const phi = (sweep * i) / n;
    const { p, t: tan } = at(phi);
    rings.push(ring(p, tan, widthAt(phi), size));
  }
  return { family: rf.family, tubes: [{ rings, faceted: false }], plates: [], faces, takeoffs, radiusMm: radius };
}

/** Turning vanes across the mitre diagonal, each an arc turning with the elbow, full duct depth. */
function vanes(frame: ElbowFrame, rf: ResolvedFitting, C: RunPoint): Plate[] {
  const rv = num(rf.params, "vane_radius_mm", 50.8);
  const turn = rad(frame.turnDeg);
  const k = frame.normal;
  // The mitre line runs throat to heel through the corner, along tin − tout.
  const diagDir = unit3(sub3(frame.tin, frame.tout));
  const diag = frame.planeDim / Math.cos(turn / 2);
  const count = Math.max(1, Math.floor(diag / (rv * 1.5)) - 1);
  // A vane turns with the elbow; its arc's mid-point sits on the mitre line.
  const startRadial = neg3(cross3(k, frame.tin));
  const midRadial = rotate(startRadial, k, turn / 2);
  const plates: Plate[] = [];
  for (let i = 1; i <= count; i++) {
    const onDiag = add3(C, scale3(diagDir, -diag / 2 + (diag * i) / (count + 1)));
    const centre = sub3(onDiag, scale3(midRadial, rv));
    const points: RunPoint[] = [];
    const steps = 8;
    for (let s = 0; s <= steps; s++) points.push(sub3(add3(centre, scale3(rotate(startRadial, k, (turn * s) / steps), rv)), scale3(k, frame.depthDim / 2)));
    plates.push({ kind: "sheet", points, extrude: scale3(k, frame.depthDim) });
  }
  return plates;
}

// ------------------------------------------------------------------ transitions

export interface TransitionShape {
  readonly lengthMm: number;
  /** Largest wall angle (each side), degrees. */
  readonly wallAngleDeg: number;
  /** Where the far ring's centre sits off the near ring's, along (width, height). */
  readonly shiftW: number;
  readonly shiftH: number;
}

/** Length and centre shift of a transition from `from` to `to`: largest side change over tan(wall angle). */
export function transitionShape(from: RunSize, to: RunSize, rf: ResolvedFitting): TransitionShape {
  const a = dims(from);
  const b = dims(to);
  const wall = Math.max(5, Math.min(45, num(rf.params, "wall_angle_deg", 30)));
  const flat = rf.family.id === "duct.transition.eccentric" ? String(rf.params.flat ?? "top") : null;
  const dW = (a.w - b.w) / 2;
  const dH = (a.h - b.h) / 2;
  let shiftW = 0;
  let shiftH = 0;
  let sideW = Math.abs(dW);
  let sideH = Math.abs(dH);
  if (flat === "top" || flat === "bottom") {
    shiftH = flat === "top" ? dH : -dH;
    sideH = Math.abs(2 * dH);
  } else if (flat === "left" || flat === "right") {
    shiftW = flat === "left" ? dW : -dW;
    sideW = Math.abs(2 * dW);
  }
  const change = Math.max(sideW, sideH);
  const lengthMm = change < 0.5 ? 0 : Math.max(50, change / Math.tan(rad(wall)));
  return { lengthMm: Math.round(lengthMm * 10) / 10, wallAngleDeg: wall, shiftW, shiftH };
}

/** Which port of a transition its body grows from (the anchor side) and which it grows towards (the run). */
function transitionSides(elements: Elements, f: RunFitting): { near: RunFitting["ports"][number]; far: RunFitting["ports"][number] } | null {
  const [pa, pb] = f.ports;
  if (!pa || !pb) return null;
  const isSeg = (p: typeof pa) => (p.link ? elements[p.link.elementId]?.kind === "run_segment" : false);
  if (isSeg(pb) || !isSeg(pa)) return { near: pa, far: pb };
  return { near: pb, far: pa };
}

function transitionBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const sides = transitionSides(elements, f);
  if (!sides) return emptyBody(f, rf.family);
  const { near, far } = sides;
  const shape = transitionShape(near.size, far.size, rf);
  const t = unit3(far.direction);
  const w = widthAxisFor(t, linkedWidthAxisOf(elements, f, far) ?? linkedWidthAxisOf(elements, f, near) ?? RISER_DEFAULT_WIDTH_AXIS);
  const h = unit3(cross3(t, w));
  const start = near.position;
  const end = add3(add3(add3(start, scale3(t, shape.lengthMm)), scale3(w, shape.shiftW)), scale3(h, shape.shiftH));
  const rings = [ring(start, t, w, near.size), ring(end, t, w, far.size)];
  return {
    family: rf.family,
    tubes: [{ rings, faceted: true }],
    plates: [],
    faces: { [near.id]: { center: start, normal: near.direction, size: near.size }, [far.id]: { center: end, normal: far.direction, size: far.size } },
    takeoffs: { [near.id]: 0, [far.id]: shape.lengthMm },
    lengthMm: shape.lengthMm,
  };
}

// ------------------------------------------------------------------ offsets

/** Ogee offset: an S-curve between two parallel, displaced ports. */
function offsetBody(f: RunFitting, rf: ResolvedFitting): FittingBody {
  const [pa, pb] = f.ports;
  if (!pa || !pb) return emptyBody(f, rf.family);
  const t = unit3(pb.direction);
  const d = sub3(pb.position, pa.position);
  const along = dot3(d, t);
  const across = sub3(d, scale3(t, along));
  const w0 = widthAxisFor(t, p3(0, 1, 0));
  const steps = 12;
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const lateral = (1 - Math.cos(Math.PI * s)) / 2;
    const slope = (Math.PI / 2) * Math.sin(Math.PI * s);
    const p = add3(add3(pa.position, scale3(t, along * s)), scale3(across, lateral));
    const tan = unit3(add3(scale3(t, along), scale3(across, slope)));
    rings.push(ring(p, tan, widthAxisFor(tan, w0), pa.size));
  }
  const phi = Math.max(15, Math.min(60, num(rf.params, "bend_angle_deg", 45)));
  const offsetMm = len3(across);
  const radiusMm = offsetMm / (2 * (1 - Math.cos(rad(phi))));
  return {
    family: rf.family,
    tubes: [{ rings, faceted: false }],
    plates: [],
    faces: { [pa.id]: { center: pa.position, normal: pa.direction, size: pa.size }, [pb.id]: { center: pb.position, normal: pb.direction, size: pb.size } },
    takeoffs: { [pa.id]: 0, [pb.id]: 0 },
    radiusMm,
    lengthMm: along,
  };
}

/** Length an ogee offset of `offsetMm` needs along the run at bend angle φ: offset x cot(φ/2). */
export function ogeeLength(offsetMm: number, bendAngleDeg: number): number {
  return offsetMm / Math.tan(rad(bendAngleDeg) / 2);
}

// ------------------------------------------------------------------ branch takeoffs

export function takeoffDepth(rf: ResolvedFitting, branch: RunSize): number {
  const d = dims(branch);
  switch (rf.family.geometry) {
    case "collar_tap":
      return num(rf.params, "collar_mm", 50.8);
    case "shoe_tap":
      return Math.max(101.6, d.w / 4);
    case "conical_tap":
      return 101.6;
    case "bellmouth_tap":
      return Math.max(50.8, 0.2 * d.w);
    case "boot_tap":
      return Math.max(101.6, d.w / 2);
    case "lateral_tap":
      return Math.max(101.6, d.w / 2);
    default:
      return 0;
  }
}

function tapBody(elements: Elements, f: RunFitting, rf: ResolvedFitting): FittingBody {
  const port = f.ports[0];
  const host = f.host ? elements[f.host.segmentId] : undefined;
  if (!port || host?.kind !== "run_segment") return emptyBody(f, rf.family);
  const n = unit3(port.direction);
  const trunk = unit3(sub3(host.end, host.start));
  const w = widthAxisFor(n, trunk);
  const L = takeoffDepth(rf, port.size);
  const face = port.position;
  const out = add3(face, scale3(n, L));
  const d = dims(port.size);
  const upstream = neg3(trunk);
  const faces = { [port.id]: { center: out, normal: n, size: port.size } };
  const takeoffs = { [port.id]: L };
  const base = { family: rf.family, plates: [] as Plate[], faces, takeoffs };
  // Width runs along the trunk for a branch leaving sideways; `along` stretches the opening up the trunk.
  const alongIsA = Math.abs(dot3(w, trunk)) > 0.5;
  const opening = (extra: number, shiftUp: number, size: RunSize, shape?: RingShape): Ring => {
    const r = ring(add3(face, scale3(upstream, shiftUp)), n, w, size);
    const grow = (v: RunPoint, base0: number) => scale3(unit3(v), base0 / 2 + extra / 2);
    const withShape = shape ? { ...r, shape } : r;
    return alongIsA ? { ...withShape, a: grow(r.a, d.w) } : { ...withShape, b: grow(r.b, d.h) };
  };
  switch (rf.family.geometry) {
    case "shoe_tap": {
      const e = L;
      return { ...base, tubes: [{ rings: [opening(e, e / 2, port.size), ring(out, n, w, port.size)], faceted: true }] };
    }
    case "boot_tap": {
      const e = L;
      const rect: RunSize = { shape: "rect", width: d.w, height: d.h };
      return { ...base, tubes: [{ rings: [opening(e, e / 2, rect, "rect"), ring(add3(face, scale3(n, L * 0.6)), n, w, port.size), ring(out, n, w, port.size)], faceted: true }] };
    }
    case "lateral_tap": {
      const e = d.w * (1 / Math.sin(rad(45)) - 1);
      return { ...base, tubes: [{ rings: [opening(e, -e / 2, port.size), ring(out, n, w, port.size)], faceted: false }] };
    }
    case "conical_tap": {
      const flare = 50.8;
      return { ...base, tubes: [{ rings: [ring(face, n, w, grownRound(port.size, flare)), ring(add3(face, scale3(n, L * 0.7)), n, w, port.size), ring(out, n, w, port.size)], faceted: true }] };
    }
    case "bellmouth_tap": {
      const rb = L;
      const rings: Ring[] = [];
      const steps = 5;
      for (let i = 0; i <= steps; i++) {
        const x = (rb * i) / steps;
        const grow = rb - Math.sqrt(Math.max(0, rb * rb - (rb - x) * (rb - x)));
        rings.push(ring(add3(face, scale3(n, x)), n, w, grownRound(port.size, 2 * (rb - grow))));
      }
      return { ...base, tubes: [{ rings, faceted: false }] };
    }
    default:
      return { ...base, tubes: [{ rings: [ring(face, n, w, port.size), ring(out, n, w, port.size)], faceted: true }] };
  }
}

function grownRound(size: RunSize, by: number): RunSize {
  return size.shape === "round" ? { shape: "round", diameter: size.diameter + by } : size;
}

// ------------------------------------------------------------------ caps and pipe

function capBody(elements: Elements, f: RunFitting, rf: ResolvedFitting | null): FittingBody {
  const port = f.ports[0];
  if (!port) return emptyBody(f, rf?.family ?? null);
  const into = unit3(port.direction);
  const w = widthAxisFor(into, linkedWidthAxisOf(elements, f, port) ?? RISER_DEFAULT_WIDTH_AXIS);
  const sleeve = 25.4;
  const face = ring(f.position, into, w, port.size, 1.02, 1.02);
  return {
    family: rf?.family ?? null,
    tubes: [{ rings: [face, ring(add3(f.position, scale3(into, sleeve)), into, w, port.size, 1.02, 1.02)], faceted: true }],
    plates: [{ kind: "disc", ring: face }],
    faces: { [port.id]: { center: f.position, normal: port.direction, size: port.size } },
    takeoffs: { [port.id]: 0 },
  };
}

function emptyBody(f: RunFitting, family: FittingFamily | null): FittingBody {
  const faces: Record<string, ConnectorFace> = {};
  const takeoffs: Record<string, number> = {};
  for (const p of f.ports) {
    faces[p.id] = { center: p.position, normal: p.direction, size: p.size };
    takeoffs[p.id] = 0;
  }
  return { family, tubes: [], plates: [], faces, takeoffs };
}

function systemOf(elements: Elements, f: RunFitting) {
  const s = elements[f.systemId];
  return s?.kind === "mep_system" ? s : null;
}

interface BodyMemo {
  /** Every element the body was built from, as it was then (undefined: it was absent). */
  readonly reads: ReadonlyArray<readonly [string, BimElement | undefined]>;
  readonly body: FittingBody;
}
const bodyMemo = new WeakMap<RunFitting, BodyMemo>();

/**
 * The body of a routed fitting: its family (authored, or its system's default) built at its ports.
 * Element records are never mutated in place, so a body is reused while the fitting and every element
 * read to build it (system, linked segments, a riser chain's neighbours) are the same objects; the
 * solid rebuild on every preview and each segment's cut-back otherwise rebuild every fitting.
 */
export function fittingBody(elements: Elements, f: RunFitting): FittingBody {
  const memo = bodyMemo.get(f);
  if (memo && memo.reads.every(([id, el]) => elements[id] === el)) return memo.body;
  const reads = new Map<string, BimElement | undefined>();
  const tracked = new Proxy(elements, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key === "string") reads.set(key, target[key]);
      return value;
    },
    has(target, key) {
      if (typeof key === "string") reads.set(key, target[key]);
      return Reflect.has(target, key);
    },
  });
  const body = buildFittingBody(tracked, f);
  bodyMemo.set(f, { reads: [...reads], body });
  return body;
}

function buildFittingBody(elements: Elements, f: RunFitting): FittingBody {
  const rf = resolveFitting(systemOf(elements, f), f);
  if (!rf) return emptyBody(f, null);
  if (rf.family.geometry === "pipe_fitting") return pipeFittingBody(elements, f, rf);
  switch (f.fittingType) {
    case "elbow":
      return elbowBody(elements, f, rf);
    case "transition":
      return transitionBody(elements, f, rf);
    case "offset":
      return offsetBody(f, rf);
    case "tap":
    case "tee":
    case "wye":
      return tapBody(elements, f, rf);
    case "cap":
      return capBody(elements, f, rf);
    case "accessory":
      return emptyBody(f, rf.family);
  }
}

/** How far the fitting at the other end of `port`'s link reaches into `seg` there (0 when nothing is linked). */
export function segmentCutback(elements: Elements, seg: RunSegment, port: "start" | "end"): number {
  const link = seg.links[port];
  if (!link) return 0;
  const other = elements[link.elementId];
  if (other?.kind !== "run_fitting") return 0;
  return fittingBody(elements, other).takeoffs[link.port] ?? 0;
}

/** A segment's straight duct after the fittings at both ends take their share: start, end and length. */
export function straightPiece(elements: Elements, seg: RunSegment): { start: RunPoint; end: RunPoint; lengthMm: number; cutStart: number; cutEnd: number } {
  if (seg.flex) {
    // Flex: its whole length along the curve, end to end.
    const pts = [seg.start, ...seg.flex.path, seg.end];
    let lengthMm = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a && b) lengthMm += len3(sub3(b, a));
    }
    return { start: seg.start, end: seg.end, lengthMm, cutStart: 0, cutEnd: 0 };
  }
  const axis = sub3(seg.end, seg.start);
  const total = len3(axis);
  const u = unit3(axis);
  const cutStart = segmentCutback(elements, seg, "start");
  const cutEnd = segmentCutback(elements, seg, "end");
  const lengthMm = total - cutStart - cutEnd;
  return { start: add3(seg.start, scale3(u, cutStart)), end: sub3(seg.end, scale3(u, cutEnd)), lengthMm, cutStart, cutEnd };
}

// ------------------------------------------------------------------ mesh

export interface FittingMesh {
  /** x, y, z per vertex, model millimetres (plan x/y, z above the level floor). */
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

const RING_SAMPLES = 32;

/** One point of a ring's outline at parameter angle φ. Rectangles hit their corners at 45°, 135°… */
export function ringPoint(r: Ring, phi: number): RunPoint {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  let x = c;
  let y = s;
  if (r.shape === "rect") {
    const m = Math.max(Math.abs(c), Math.abs(s));
    x = c / m;
    y = s / m;
  } else if (r.shape === "oval") {
    const ha = len3(r.a);
    const hb = len3(r.b);
    const wide = ha >= hb;
    const big = wide ? ha : hb;
    const small = wide ? hb : ha;
    const k = big - small;
    const cx = wide ? c : s;
    const cy = wide ? s : c;
    let px: number;
    let py: number;
    const tStraight = Math.abs(cy) > 1e-9 ? small / Math.abs(cy) : Number.POSITIVE_INFINITY;
    if (Math.abs(tStraight * cx) <= k) {
      px = tStraight * cx;
      py = tStraight * cy;
    } else {
      const sg = Math.sign(cx) || 1;
      const t = sg * cx * k + Math.sqrt(Math.max(0, (cx * k) ** 2 - k * k + small * small));
      px = t * cx;
      py = t * cy;
    }
    x = wide ? px / ha : py / ha;
    y = wide ? py / hb : px / hb;
  }
  return add3(r.center, add3(scale3(r.a, x), scale3(r.b, y)));
}

const meshMemo = new WeakMap<FittingBody, FittingMesh>();

/** Triangulate a body: tubes lofted ring to ring, vanes as strips and cap discs as fans, all two-sided. */
export function fittingMesh(body: FittingBody): FittingMesh {
  const memo = meshMemo.get(body);
  if (memo) return memo;
  const mesh = triangulate(body);
  meshMemo.set(body, mesh);
  return mesh;
}

function triangulate(body: FittingBody): FittingMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (p: RunPoint) => {
    positions.push(p.x, p.y, p.z);
    return positions.length / 3 - 1;
  };
  for (const tube of body.tubes) {
    let prev: number[] | null = null;
    for (const r of tube.rings) {
      const row: number[] = [];
      for (let i = 0; i < RING_SAMPLES; i++) row.push(push(ringPoint(r, (2 * Math.PI * i) / RING_SAMPLES)));
      if (prev) {
        for (let i = 0; i < RING_SAMPLES; i++) {
          const j = (i + 1) % RING_SAMPLES;
          const a = prev[i];
          const b = prev[j];
          const c = row[i];
          const d = row[j];
          if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
          // Both windings: sheet metal is seen from outside and, at open ends, from inside.
          indices.push(a, c, b, b, c, d, a, b, c, b, d, c);
        }
      }
      prev = row;
    }
  }
  for (const plate of body.plates) {
    if (plate.kind === "sheet") {
      const lower = plate.points.map(push);
      const upper = plate.points.map((p) => push(add3(p, plate.extrude)));
      for (let i = 0; i + 1 < lower.length; i++) {
        const a = lower[i];
        const b = lower[i + 1];
        const c = upper[i];
        const d = upper[i + 1];
        if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
        indices.push(a, c, b, b, c, d, a, b, c, b, d, c);
      }
    } else {
      const centre = push(plate.ring.center);
      const rim: number[] = [];
      for (let i = 0; i < RING_SAMPLES; i++) rim.push(push(ringPoint(plate.ring, (2 * Math.PI * i) / RING_SAMPLES)));
      for (let i = 0; i < RING_SAMPLES; i++) {
        const a = rim[i];
        const b = rim[(i + 1) % RING_SAMPLES];
        if (a === undefined || b === undefined) continue;
        indices.push(centre, a, b, centre, b, a);
      }
    }
  }
  return { positions, indices };
}
