import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult } from "../../command-core";
import { TrackedReader, requireKind } from "../../model";
import { draftElements } from "../../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../../types";
import { familyMismatch, fittingFamily, missingFittingFamilyWords, paramIssue, resolveParams } from "../fittings/library";
import { hostedPoints, len3, p3, round3, sub3 } from "../geometry";
import { RunPropagator } from "../propagate";
import { runLabel } from "../validate";
import type { MepSystem, RunFitting, RunPoint, RunSegment } from "../types";
import { MAX_PITCH_IN_PER_FT, inPerFtLabel, isGravity, minSlopeFor, serviceOf } from "./design";
import { nominalInOf, slopeInPerFt } from "./gravity";
import { jointIssue, pipeParams } from "./families";

/**
 * Pipe commands:
 * - `set_slope` pitches one horizontal pipe segment (a drain at 1/4" per ft):
 *   one end stays, the other rises or drops, and what is connected beyond it
 *   follows (level runs move with it, vertical runs stretch, fixed parts refuse).
 * - `place_run_accessory` puts an inline item (valve, union, cleanout, trap,
 *   drip leg, test tee) on a pipe at a distance along it; the pipe stays one piece.
 */

const idSchema = z.string().min(1).max(200);
const paramsSchema = z.record(z.string().min(1).max(40), z.union([z.number().finite(), z.string().max(40)]));

export const pipeCommandSchemas = [
  z.object({
    type: z.literal("set_slope"),
    segmentId: idSchema,
    /** Inches of fall per foot of run. Absent: the system's minimum for this size. */
    inPerFt: z.number().finite().min(0).max(MAX_PITCH_IN_PER_FT).optional(),
    /** Which way it drains. Absent: the way it already slopes, else into the run it branches into, else towards its end. */
    flow: z.enum(["toward_start", "toward_end"]).optional(),
    /** Which end stays put. Absent: the end that meets a trunk or a fixture, else the upstream end. */
    keep: z.enum(["upstream", "downstream"]).optional(),
  }),
  z.object({
    type: z.literal("place_run_accessory"),
    accessoryId: idSchema,
    segmentId: idSchema,
    /** Centre of the item, along the segment from its start (mm). */
    atMm: z.number().finite().positive(),
    family: z.string().min(1).max(80),
    params: paramsSchema.optional(),
  }),
] as const;

export type PipeCommand = z.infer<(typeof pipeCommandSchemas)[number]>;

const MM_PER_FT = 304.8;
const feet = (mm: number) => `${Math.round((mm / MM_PER_FT) * 100) / 100} ft`;

// ------------------------------------------------------------------ pitching a route

export interface PitchOptions {
  /** True when water flows from the first point towards the last. */
  readonly flowWithPoints: boolean;
  readonly inPerFt: number;
  /** Which node keeps its height. */
  readonly fixed: "first" | "last";
  /** The other end: a fixed connector (its height must be met, a vertical leg beside it can absorb the difference), a branch on a stack that slides to meet it, or free. */
  readonly other: "rigid" | "slide" | "free";
  readonly tol: number;
  readonly minStraightMm: number;
}

function isLevelish(d: RunPoint): boolean {
  const plan = Math.hypot(d.x, d.y);
  return plan > 0.01 && Math.abs(d.z) <= (plan * MAX_PITCH_IN_PER_FT) / 12 + 0.01;
}

/**
 * Re-height a drawn route so every level-ish leg falls `inPerFt` in the flow
 * direction, keeping vertical and 45° legs' own rise. Returns the new nodes, or
 * the reason the other end can't be met.
 */
export function pitchNodes(nodes: readonly RunPoint[], o: PitchOptions): { nodes: RunPoint[] } | { refusal: string } {
  const n = nodes.length;
  if (n < 2) return { nodes: [...nodes] };
  const k = o.inPerFt / 12;
  const z: number[] = new Array<number>(n).fill(0);
  const legDz = (i: number): number => {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (!a || !b) return 0;
    const d = sub3(b, a);
    return isLevelish(d) ? (o.flowWithPoints ? -k : k) * Math.hypot(d.x, d.y) : d.z;
  };
  for (let i = 0; i + 1 < n; i++) z[i + 1] = (z[i] ?? 0) + legDz(i);
  const anchorIdx = o.fixed === "first" ? 0 : n - 1;
  const shift = (nodes[anchorIdx]?.z ?? 0) - (z[anchorIdx] ?? 0);
  const out = nodes.map((p, i) => round3(p3(p.x, p.y, (z[i] ?? 0) + shift)));
  if (o.other !== "rigid") return { nodes: out };
  const otherIdx = o.fixed === "first" ? n - 1 : 0;
  const want = nodes[otherIdx]?.z ?? 0;
  const got = out[otherIdx]?.z ?? 0;
  const miss = want - got;
  if (Math.abs(miss) <= o.tol) {
    out[otherIdx] = round3(p3(out[otherIdx]?.x ?? 0, out[otherIdx]?.y ?? 0, want));
    return { nodes: out };
  }
  // The vertical leg nearest the fixed connector takes up the difference: it and everything past it move by the miss.
  const towardAnchor = o.fixed === "first" ? -1 : 1;
  for (let i = otherIdx; i !== anchorIdx; i += towardAnchor) {
    const a = nodes[i + towardAnchor];
    const b = nodes[i];
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) >= 0.01 || Math.abs(b.z - a.z) < 0.01) continue;
    const before = b.z - a.z;
    const after = (out[i]?.z ?? 0) + miss - (out[i + towardAnchor]?.z ?? 0);
    if (Math.sign(after) === Math.sign(before) && Math.abs(after) >= o.minStraightMm) {
      for (let j = i; j !== otherIdx - towardAnchor; j -= towardAnchor) {
        const q = out[j];
        if (q) out[j] = round3(p3(q.x, q.y, q.z + miss));
      }
      out[otherIdx] = round3(p3(out[otherIdx]?.x ?? 0, out[otherIdx]?.y ?? 0, want));
      return { nodes: out };
    }
    break;
  }
  // No such leg: a drop of its own on the last level leg, just short of the fixed connector, when it falls the way the water runs.
  const dropped = withDropAtEnd(nodes, out, o, otherIdx, want);
  if (dropped) return { nodes: dropped };
  return {
    refusal: `Sloped at ${inPerFtLabel(o.inPerFt)}, the drain would reach its other end ${Math.round((Math.abs(miss) / 25.4) * 100) / 100} in ${miss > 0 ? "below" : "above"} the connection there. Leave that end open, add a rise or drop next to it, or connect into a stack, where the branch finds its own height`,
  };
}

/**
 * A sloped route finishing on a connector at a fixed height, with no vertical
 * leg to take up the miss: put a drop on its last level leg, between one and
 * two shortest straight pieces from the connector, so the short piece into the
 * connector keeps the fall and meets it at its height. Only a drop the water
 * runs down (into a downstream connector, or out of an upstream one) at least
 * the shortest straight piece long; otherwise null.
 */
function withDropAtEnd(nodes: readonly RunPoint[], out: readonly RunPoint[], o: PitchOptions, otherIdx: number, want: number): RunPoint[] | null {
  const nb = o.fixed === "first" ? otherIdx - 1 : otherIdx + 1;
  const near = out[nb];
  const far = out[otherIdx];
  const origNear = nodes[nb];
  const origFar = nodes[otherIdx];
  if (!near || !far || !origNear || !origFar || !isLevelish(sub3(origFar, origNear))) return null;
  const plan = Math.hypot(near.x - far.x, near.y - far.y);
  const back = Math.min(plan / 2, 2 * o.minStraightMm);
  if (back < o.minStraightMm) return null;
  const t = back / plan;
  const downstream = (o.fixed === "first") === o.flowWithPoints;
  const s = downstream ? 1 : -1;
  const x = far.x + (near.x - far.x) * t;
  const y = far.y + (near.y - far.y) * t;
  const zRoute = far.z + (near.z - far.z) * t;
  const zConnector = want + (s * o.inPerFt * back) / 12;
  if (s * (zRoute - zConnector) < o.minStraightMm) return null;
  const onRoute = round3(p3(x, y, zRoute));
  const onConnector = round3(p3(x, y, zConnector));
  const end = round3(p3(far.x, far.y, want));
  return o.fixed === "first" ? [...out.slice(0, otherIdx), onRoute, onConnector, end] : [end, onConnector, onRoute, ...out.slice(1)];
}

// ------------------------------------------------------------------ set_slope

function systemOf(working: Readonly<Record<string, BimElement>>, el: RunSegment | RunFitting): MepSystem {
  const s = working[el.systemId];
  if (s?.kind !== "mep_system") refuse("element_not_found", `${el.id} belongs to system ${el.systemId}, which does not exist`, [el.id]);
  return s;
}

/** True when this end meets the branch port of a tee or wye on a trunk (the segment drains into that trunk). */
function meetsTrunk(working: Readonly<Record<string, BimElement>>, seg: RunSegment, end: "start" | "end"): boolean {
  const link = seg.links[end];
  const el = link ? working[link.elementId] : undefined;
  return el?.kind === "run_fitting" && el.host !== undefined;
}

function meetsPart(working: Readonly<Record<string, BimElement>>, seg: RunSegment, end: "start" | "end"): boolean {
  const link = seg.links[end];
  return link ? working[link.elementId]?.kind === "part" : false;
}

function setSlope(model: ModelState, cmd: Extract<PipeCommand, { type: "set_slope" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const seg = requireKind(reader.get(asElementId(cmd.segmentId)), "run_segment");
  const working = draftElements(model.elements);
  const touched = new Set<ElementId>();
  const name = runLabel(working, seg);
  if (seg.domain !== "pipe" || seg.size.shape !== "pipe") refuse("unsupported_geometry", `${name} is ${seg.domain}; slope is set on pipe`, [seg.id]);
  const system = systemOf(working, seg);
  const plan = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
  if (plan < 1) refuse("unsupported_geometry", `${name} is vertical; slope is set on level pipe`, [seg.id]);
  const current = slopeInPerFt(seg);
  if (current > MAX_PITCH_IN_PER_FT + 1e-3) refuse("unsupported_geometry", `${name} runs at 45°; slope is set on level pipe`, [seg.id]);
  for (const end of ["start", "end"] as const) {
    const link = seg.links[end];
    if (link) reader.get(link.elementId);
  }
  const inches = nominalInOf(seg.size);
  const gravity = isGravity(system.systemKind);
  const need = gravity ? minSlopeFor(inches, system.design?.pipe) : 0;
  const target = cmd.inPerFt ?? (gravity ? need : current);
  if (gravity && target + 1e-9 < need) {
    refuse("invalid_value", `${inPerFtLabel(target)} is flatter than the ${inPerFtLabel(need)} ${system.name} needs for ${inches}" pipe; change the system's slope rule to go flatter`, [seg.id]);
  }
  if (serviceOf(system.systemKind) === "water" || serviceOf(system.systemKind) === "gas") {
    if (cmd.inPerFt === undefined) refuse("invalid_value", `${system.name} isn't a drain; give the slope you want`, [seg.id]);
  }
  // Which way it drains.
  const fallsToEnd = seg.start.z - seg.end.z;
  const flow = cmd.flow ?? (Math.abs(fallsToEnd) > 0.1 ? (fallsToEnd > 0 ? "toward_end" : "toward_start") : meetsTrunk(working, seg, "start") || meetsPart(working, seg, "end") ? "toward_start" : "toward_end");
  const downstream: "start" | "end" = flow === "toward_end" ? "end" : "start";
  const upstream: "start" | "end" = downstream === "end" ? "start" : "end";
  const keep = cmd.keep ?? (meetsTrunk(working, seg, downstream) || meetsPart(working, seg, downstream) ? "downstream" : "upstream");
  const fixedEnd = keep === "downstream" ? downstream : upstream;
  const movingEnd = fixedEnd === "start" ? "end" : "start";
  const fall = (target / 12) * plan;
  const fixedZ = seg[fixedEnd].z;
  const newZ = movingEnd === downstream ? fixedZ - fall : fixedZ + fall;
  const dz = Math.round((newZ - seg[movingEnd].z) * 1000) / 1000;
  if (Math.abs(dz) <= model.settings.connectorToleranceMm && Math.abs(current - target) < 1e-3) refuse("invalid_value", `${name} already slopes ${inPerFtLabel(target)}`, [seg.id]);
  const moved: RunSegment = { ...seg, [movingEnd]: round3(p3(seg[movingEnd].x, seg[movingEnd].y, newZ)) };
  working[seg.id] = moved;
  touched.add(seg.id);
  const prop = new RunPropagator(reader, working, touched);
  prop.markFixed(seg.id);
  // Hosted items keep their plan position; a branch off one follows it up or down.
  const oldLen = len3(sub3(seg.end, seg.start));
  const newLen = len3(sub3(moved.end, moved.start));
  for (const id of seg.branches) {
    reader.find(id);
    const b = working[id];
    if (b?.kind !== "run_fitting" || !b.host) continue;
    const s = Math.round(((b.host.s * newLen) / oldLen) * 1000) / 1000;
    const at = hostedPoints(moved, s, b.host.side, b.host.dir, b.host.face, b.host.t);
    const port = b.ports[0];
    const next: RunFitting = { ...b, host: { ...b.host, s }, position: at.onAxis, ports: b.ports.map((p) => ({ ...p, position: at.branch })) };
    working[b.id] = next;
    touched.add(b.id);
    prop.markFixed(b.id);
    if (port?.link) {
      const d = round3(sub3(at.branch, port.position));
      if (len3(d) > 1e-6) prop.translateInto(port.link, d);
    }
  }
  const beyond = seg.links[movingEnd];
  if (beyond) prop.translateInto(beyond, p3(0, 0, dz));
  const authored: AuthoredWrite[] = [{ elementId: seg.id, field: "size", value: seg.size }];
  const summary = [`${name} now slopes ${inPerFtLabel(target)} towards its ${downstream}; the ${movingEnd} ${dz < 0 ? "dropped" : "rose"} ${Math.round((Math.abs(dz) / 25.4) * 100) / 100} in and what is connected there followed`];
  return finish(reader, working, touched, authored, () => [], { summary });
}

// ------------------------------------------------------------------ place_run_accessory

function placeAccessory(model: ModelState, cmd: Extract<PipeCommand, { type: "place_run_accessory" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const seg = requireKind(reader.get(asElementId(cmd.segmentId)), "run_segment");
  const working = draftElements(model.elements);
  const name = runLabel(working, seg);
  if (seg.domain !== "pipe") refuse("unsupported_geometry", `${name} is ${seg.domain}; inline accessories go on pipe`, [seg.id]);
  const system = systemOf(working, seg);
  const family = fittingFamily(cmd.family);
  if (!family) refuse("element_not_found", missingFittingFamilyWords(cmd.family), [seg.id]);
  if (!family.fittingTypes.includes("accessory")) refuse("profile_incompatible", `${family.name} isn't an inline accessory; valves, unions, cleanouts, traps and drip legs are`, [seg.id]);
  const why = familyMismatch(family, { fittingType: "accessory", domain: "pipe", sizes: [seg.size], systemKind: system.systemKind });
  if (why) refuse("profile_incompatible", `A ${family.name} can't go on the ${name}: ${why}`, [seg.id]);
  const bad = paramIssue(family, cmd.params);
  if (bad) refuse("invalid_value", `${family.name}: ${bad}`, [seg.id]);
  const params = resolveParams(family, pipeParams(family, seg.size, cmd.params));
  const joint = jointIssue(family, params, seg.size);
  if (joint) refuse("profile_incompatible", joint, [seg.id]);
  const id = asElementId(cmd.accessoryId);
  if (reader.find(id)) refuse("already_exists", `${id} already exists; choose a new id`, [id]);
  const total = len3(sub3(seg.end, seg.start));
  const s = Math.round(cmd.atMm * 1000) / 1000;
  if (s >= total) refuse("outside_host", `${name} is ${feet(total)} long; ${feet(s)} is past its end`, [seg.id]);
  const at = hostedPoints(seg, s, 1);
  const item: RunFitting = {
    id,
    kind: "run_fitting",
    version: 0,
    authoredRev: {},
    ...(seg.partition ? { partition: seg.partition } : {}),
    fittingType: "accessory",
    label: family.name,
    domain: "pipe",
    systemId: seg.systemId,
    levelId: seg.levelId,
    position: at.onAxis,
    ports: [],
    host: { segmentId: seg.id, s, side: 1 },
    family: family.id,
    params,
  };
  working[id] = item;
  working[seg.id] = { ...seg, branches: [...seg.branches, id] };
  const authored: AuthoredWrite[] = [{ elementId: id, field: "family", value: family.id }];
  return finish(reader, working, [id, seg.id], authored, () => [{ kind: "field_equals", elementId: id, field: "family", value: family.id }], { summary: [`A ${family.name.toLowerCase()} on the ${name}, ${feet(s)} from its start`] });
}

export function executePipeCommand(model: ModelState, command: PipeCommand): ExecuteResult {
  switch (command.type) {
    case "set_slope":
      return setSlope(model, command);
    case "place_run_accessory":
      return placeAccessory(model, command);
  }
}
