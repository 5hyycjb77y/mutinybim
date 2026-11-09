import { z } from "zod";
import { finish, refuse, type ExecuteResult } from "../command-core";
import { TrackedReader, requireKind } from "../model";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState, type Vec2 } from "../types";
import { widthAxisFor, type Ring } from "./fittings/geometry";
import { add3, connectorSize, dot3, len3, p3, partConnector, portInfo, round3, scale3, sub3, unit3, withLink } from "./geometry";
import { floorForPiece, frameShiftMm, levelsByHeight, partitionOnFloor } from "./levels-across";
import { systemRules, sizeLabel } from "./rules";
import type { RunPoint, RunSegment, RunSize } from "./types";
import { partLabelOf, runLabel } from "./validate";

/**
 * Flexible duct: the short, bendable round duct from a branch's open end
 * (usually a tap off a trunk) to an air device's neck. It is one piece that
 * curves from the end it leaves straight out of to the neck it goes straight
 * into, sized to the neck. A segment with a `flex` path: everything that
 * links, carries airflow and reports pressure treats it as duct; drawings
 * draw the curve.
 */

export interface FlexPath {
  /** Points between the segment's start and end along its curve, mm (heights from the segment's level). */
  readonly path: readonly RunPoint[];
}

/** The run domain flex is made in (its connectors' domain too). */
export const FLEX_DOMAIN = "duct" as const;

const MM_PER_FT = 304.8;
/** Longer than this is past what flex runs are usually held to (many codes and specs say 5 to 6 ft); it is allowed with a warning. */
export const FLEX_LENGTH_WARNING_MM = 6 * MM_PER_FT;
/** Hard limit: past this it isn't a flex connection any more; route duct. */
export const FLEX_LENGTH_LIMIT_MM = 25 * MM_PER_FT;

const idSchema = z.string().min(1).max(200);

export const flexCommandSchemas = [
  z.object({
    type: z.literal("route_flex"),
    /** The new segment's id (a retried request makes the same one). */
    segmentId: idSchema,
    /** The open end the flex leaves: a run end (a tap's branch, a duct's open end). */
    from: z.object({ elementId: idSchema, port: z.string().min(1).max(40) }),
    /** The air device neck it goes into. */
    to: z.object({ partId: idSchema, connectorId: z.string().min(1).max(40) }),
  }),
] as const;

export const flexCommandSchema = z.discriminatedUnion("type", [...flexCommandSchemas]);
export type FlexCommand = z.infer<typeof flexCommandSchema>;

export function isFlexCommand(command: { readonly type: string }): command is FlexCommand {
  return command.type === "route_flex";
}

function feet(mm: number): string {
  return `${Math.round((mm / MM_PER_FT) * 10) / 10} ft`;
}

/** A point on the cubic from `a` (leaving along `da`) to `b` (arriving against `db`). */
function bezier(a: RunPoint, c1: RunPoint, c2: RunPoint, b: RunPoint, t: number): RunPoint {
  const s = 1 - t;
  const k0 = s * s * s;
  const k1 = 3 * s * s * t;
  const k2 = 3 * s * t * t;
  const k3 = t * t * t;
  return p3(a.x * k0 + c1.x * k1 + c2.x * k2 + b.x * k3, a.y * k0 + c1.y * k1 + c2.y * k2 + b.y * k3, a.z * k0 + c1.z * k1 + c2.z * k2 + b.z * k3);
}

/**
 * The curve flex takes from an end facing `outA` to a neck facing `outB`
 * (both pointing out of what they belong to): straight out of each, bending
 * between. Interior points only, enough that each chord is under ~6".
 */
export function flexCurve(a: RunPoint, outA: RunPoint, b: RunPoint, outB: RunPoint, diameterMm: number): RunPoint[] {
  const span = len3(sub3(b, a));
  const reach = Math.min(span * 0.5, Math.max(diameterMm * 1.5, span * 0.35));
  const c1 = add3(a, scale3(unit3(outA), reach));
  const c2 = add3(b, scale3(unit3(outB), reach));
  const n = Math.min(48, Math.max(8, Math.ceil(span / 150)));
  const out: RunPoint[] = [];
  for (let i = 1; i < n; i++) out.push(round3(bezier(a, c1, c2, b, i / n)));
  return out;
}

/**
 * A flex segment with one end moved by `d` (what it connects to moved): it
 * bends to the new place, still leaving and arriving the way it did.
 */
export function bentFlex(seg: RunSegment & { readonly flex: FlexPath }, end: "start" | "end", d: RunPoint): RunSegment {
  const first = seg.flex.path[0] ?? seg.end;
  const last = seg.flex.path[seg.flex.path.length - 1] ?? seg.start;
  const outStart = unit3(sub3(first, seg.start));
  const outEnd = unit3(sub3(last, seg.end));
  const start = end === "start" ? round3(add3(seg.start, d)) : seg.start;
  const finish = end === "end" ? round3(add3(seg.end, d)) : seg.end;
  const dia = seg.size.shape === "round" ? seg.size.diameter : 200;
  return { ...seg, start, end: finish, flex: { path: flexCurve(start, outStart, finish, outEnd, dia) } };
}

/** Every point of a flex segment, end to end. */
export function flexPoints(seg: Pick<RunSegment, "start" | "end" | "flex">): RunPoint[] {
  return [seg.start, ...(seg.flex?.path ?? []), seg.end];
}

/** Length along the curve, mm. */
export function flexLengthMm(seg: Pick<RunSegment, "start" | "end" | "flex">): number {
  const pts = flexPoints(seg);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) total += len3(sub3(b, a));
  }
  return total;
}

/** Cross-section rings along a flex segment (for the 3D mesh and the printed solid). */
export function flexRings(seg: Pick<RunSegment, "start" | "end" | "flex" | "size">): Ring[] {
  const pts = flexPoints(seg);
  const r = (seg.size.shape === "round" ? seg.size.diameter : seg.size.shape === "pipe" ? seg.size.nominalMm : seg.size.shape === "conduit" ? seg.size.tradeSizeMm : seg.size.width) / 2;
  let prevA = p3(0, 1, 0);
  return pts.map((c, i) => {
    const before = pts[Math.max(0, i - 1)] ?? c;
    const after = pts[Math.min(pts.length - 1, i + 1)] ?? c;
    const t = unit3(sub3(after, before));
    // Carry the ring's frame along so it doesn't twist where the curve turns vertical.
    const a = widthAxisFor(t, prevA);
    prevA = a;
    const b = unit3(p3(t.y * a.z - t.z * a.y, t.z * a.x - t.x * a.z, t.x * a.y - t.y * a.x));
    return { center: c, a: scale3(a, r), b: scale3(b, r), shape: "round" };
  });
}

/** Plan linework of a flex segment: both edges of the curve, with ticks across it every few inches (how flex is drawn). */
export function flexPlanLines(seg: Pick<RunSegment, "start" | "end" | "flex" | "size">): Array<[Vec2, Vec2, "edge" | "tick"]> {
  const pts = flexPoints(seg).map((q) => ({ x: q.x, y: q.y }));
  const half = (seg.size.shape === "round" ? seg.size.diameter : 200) / 2;
  const out: Array<[Vec2, Vec2, "edge" | "tick"]> = [];
  const side = (i: number): Vec2 => {
    const a = pts[Math.max(0, i - 1)] ?? { x: 0, y: 0 };
    const b = pts[Math.min(pts.length - 1, i + 1)] ?? a;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    return l < 1e-6 ? { x: 0, y: 0 } : { x: -dy / l, y: dx / l };
  };
  const TICK_MM = 75;
  let sinceTick = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const na = side(i);
    const nb = side(i + 1);
    out.push([{ x: a.x + na.x * half, y: a.y + na.y * half }, { x: b.x + nb.x * half, y: b.y + nb.y * half }, "edge"]);
    out.push([{ x: a.x - na.x * half, y: a.y - na.y * half }, { x: b.x - nb.x * half, y: b.y - nb.y * half }, "edge"]);
    sinceTick += Math.hypot(b.x - a.x, b.y - a.y);
    if (sinceTick >= TICK_MM && (na.x !== 0 || na.y !== 0)) {
      sinceTick = 0;
      out.push([{ x: b.x + nb.x * half, y: b.y + nb.y * half }, { x: b.x - nb.x * half, y: b.y - nb.y * half }, "tick"]);
    }
  }
  return out;
}

function roundSize(size: RunSize | null): number | null {
  return size?.shape === "round" ? size.diameter : null;
}

function routeFlex(model: ModelState, cmd: FlexCommand): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const id = asElementId(cmd.segmentId);
  if (reader.find(id)) refuse("already_exists", `${cmd.segmentId} already exists; choose a new id`, [id]);
  const fromEl = reader.get(asElementId(cmd.from.elementId));
  if (fromEl.kind !== "run_segment" && fromEl.kind !== "run_fitting") refuse("wrong_kind", "Flex leaves the open end of a duct (a tap's branch or a duct end)", [fromEl.id]);
  if (fromEl.domain !== FLEX_DOMAIN) refuse("wrong_kind", `${runLabel(working, fromEl)} isn't duct; flex is duct`, [fromEl.id]);
  const from = portInfo(working, { elementId: fromEl.id, port: cmd.from.port });
  if (!from) refuse("element_not_found", `${runLabel(working, fromEl)} has no end called ${cmd.from.port}`, [fromEl.id]);
  if (from.link) refuse("already_exists", `That end of ${runLabel(working, fromEl)} is already connected`, [fromEl.id]);
  const part = requireKind(reader.get(asElementId(cmd.to.partId)), "part");
  const type = requireKind(reader.get(part.typeId), "part_type");
  const name = partLabelOf(working, part);
  const neck = partConnector(part, type, cmd.to.connectorId);
  if (!neck) refuse("element_not_found", `${name} has no connector ${cmd.to.connectorId}`, [part.id]);
  const neckName = `${name}'s ${neck.connector.label.toLowerCase()}`;
  if (part.links?.[cmd.to.connectorId]) refuse("already_exists", `${neckName} is already connected`, [part.id]);
  if (neck.connector.domain !== FLEX_DOMAIN) refuse("profile_incompatible", `${neckName} isn't a duct connection`, [part.id]);
  const system = working[fromEl.systemId];
  if (system?.kind !== "mep_system") refuse("element_not_found", `${runLabel(working, fromEl)} has no system`, [fromEl.id]);
  if (neck.connector.systemKind !== system.systemKind) refuse("profile_incompatible", `${neckName} is ${systemRules(neck.connector.systemKind).label.toLowerCase()}; this duct is ${system.name}`, [part.id]);
  // Flex is round and sized to the neck it serves.
  const neckSize = connectorSize(neck.connector, { shape: "round", diameter: 1 });
  const neckDia = roundSize(neckSize);
  if (neckDia === null) refuse("profile_incompatible", `${neckName} is ${neckSize ? sizeLabel(neckSize) : "unsized"}; flex is round, so it needs a round neck`, [part.id]);
  const endDia = roundSize(from.size);
  if (endDia === null || Math.abs(endDia - neckDia) > 0.5) {
    refuse("profile_incompatible", `Flex is sized to ${neckName} (${neckDia / 25.4}" round), but the end it leaves is ${from.size ? sizeLabel(from.size) : "unsized"}; make that branch ${neckDia / 25.4}" round, or add a transition, then run the flex`, [fromEl.id, part.id]);
  }
  // Heights from the flex's own floor (the duct it leaves); the neck may be on the floor below.
  const shift = frameShiftMm(working, part.levelId, fromEl.levelId);
  const neckAt = round3(p3(neck.position.x, neck.position.y, neck.position.z + shift));
  const span = len3(sub3(neckAt, from.position));
  if (span < model.settings.minStraightMm) refuse("min_straight_length", `${neckName} is ${Math.round(span)} mm from the end; flex needs at least ${model.settings.minStraightMm} mm`, [fromEl.id, part.id]);
  // The flex has to leave the end out of it and come into the neck from outside it, not double back through either.
  if (dot3(sub3(neckAt, from.position), from.direction) <= 0) refuse("unsupported_geometry", `${neckName} is behind the end the flex would leave; run the branch toward it first`, [fromEl.id, part.id]);
  if (dot3(sub3(from.position, neckAt), neck.direction) <= 0) refuse("unsupported_geometry", `The end is behind ${neckName}; flex has to come into the neck from the side it faces`, [fromEl.id, part.id]);
  const size: RunSize = { shape: "round", diameter: neckDia };
  const path = flexCurve(from.position, from.direction, neckAt, neck.direction, neckDia);
  const base = fromEl.partition ?? { level: "L1", zone: "Z1", discipline: "mechanical" as const };
  const ownLevel = working[fromEl.levelId];
  const mid = path[Math.floor(path.length / 2)] ?? from.position;
  const floor = ownLevel?.kind === "level" ? floorForPiece(levelsByHeight(model), ownLevel, ownLevel.elevationMm + mid.z) : null;
  const seg: RunSegment = {
    id,
    kind: "run_segment",
    version: 0,
    authoredRev: {},
    partition: partitionOnFloor(base, floor),
    domain: FLEX_DOMAIN,
    systemId: system.id,
    levelId: fromEl.levelId,
    start: round3(from.position),
    end: neckAt,
    size,
    links: { start: { elementId: fromEl.id, port: cmd.from.port }, end: { elementId: part.id, port: cmd.to.connectorId } },
    branches: [],
    flow: 0,
    flex: { path },
  };
  const length = flexLengthMm(seg);
  if (length > FLEX_LENGTH_LIMIT_MM) refuse("unsupported_geometry", `That flex would be ${feet(length)} long; past ${feet(FLEX_LENGTH_LIMIT_MM)} route duct closer to ${neckName} and run a short flex from it`, [fromEl.id, part.id]);
  working[id] = seg;
  const linkedFrom = withLink(fromEl, cmd.from.port, { elementId: id, port: "start" });
  const linkedPart = withLink(part, cmd.to.connectorId, { elementId: id, port: "end" });
  if (!linkedFrom || !linkedPart) refuse("element_not_found", "One of those ends can't be connected", [fromEl.id, part.id]);
  working[linkedFrom.id] = linkedFrom;
  working[linkedPart.id] = linkedPart;
  const touched: ElementId[] = [id, linkedFrom.id, linkedPart.id];
  const summary = [`${neckDia / 25.4}" flex, ${feet(length)}, from ${runLabel(working, fromEl)} to ${neckName}`];
  if (length > FLEX_LENGTH_WARNING_MM) summary.push(`Longer than ${feet(FLEX_LENGTH_WARNING_MM)}: flex runs are usually held to 5 to 6 ft; check the project's specification, or route duct closer`);
  return finish(reader, working, touched, [{ elementId: id, field: "size", value: size }], () => [], { summary });
}

export function executeFlexCommand(model: ModelState, command: FlexCommand): ExecuteResult {
  return routeFlex(model, command);
}

/** Is this segment a flex run? */
export function isFlex(el: BimElement | undefined): el is RunSegment & { readonly flex: FlexPath } {
  return el?.kind === "run_segment" && el.flex !== undefined;
}