import { z } from "zod";
import { viewFloorMm } from "./levels";
import { localBounds, resolveDim, resolveGeometry } from "./parts";
import { placeClearance, resolveClearances, resolvePositionEnvelopes, type PlacedClearance } from "./part-model/clearance";
import type { Dim } from "./part-dim";
import { pathLength, profileElevationAt } from "./placement/geometric-math";
import { elementsOfKind } from "./store";
import type { BimElement, ElementId, ModelState, PartInstance } from "./types";

/**
 * Where equipment sits and the space it needs, read from the model: the
 * surface a placed part stands on (its host: one of our slabs, or a linked
 * slab or roof), its curb, and its clearance zones placed in the world.
 *
 * A host is the engineer's statement "this unit stands on that deck". The
 * kernel keeps it and checks it against heights; it never picks a host by
 * itself. Linked hosts carry the surface top the person or agent picked,
 * because the linked model lives outside the kernel; the lint engine
 * re-checks that against the current linked index.
 */

const idSchema = z.string().min(1).max(200);

export const HOST_SURFACES = ["slab", "roof"] as const;
export type HostSurface = (typeof HOST_SURFACES)[number];

export const partHostSchema = z.discriminatedUnion("kind", [
  /** One of our slabs; its top is its level's floor. */
  z.object({ kind: z.literal("slab"), elementId: idSchema }).strict(),
  /** A linked model's slab or roof. */
  z
    .object({
      kind: z.literal("linked"),
      /** The linked model (reference) id. */
      referenceId: idSchema,
      /** IFC GlobalId of the slab or roof, when known. */
      globalId: z.string().min(1).max(64).optional(),
      /** The viewer's item id, when the host was picked in 3D. */
      localId: z.number().int().min(0).optional(),
      name: z.string().trim().min(1).max(120),
      /** Slab or roof, when known (a pick in 3D may not know yet). */
      surface: z.enum(HOST_SURFACES).optional(),
      /** Top of the surface under the part, model elevation (mm), when it was chosen. */
      topMm: z.number().finite().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  /**
   * One of our elements placed along a line or path (a beam, a wall, a
   * curb), at a station along it from its start. Written only to peers
   * advertising `parts:line_host` (part-model/unit-gate.ts).
   */
  z.object({ kind: z.literal("element"), elementId: idSchema, stationMm: z.number().finite().min(0).max(10_000_000) }).strict(),
]);
export type PartHost = z.infer<typeof partHostSchema>;

/** Curbs and rails taller than this are not curbs (a typo for millimetres or a raised platform). */
export const MAX_CURB_MM = 3048;
/** Base this close to the host top plus curb is seated. */
export const SEATED_TOLERANCE_MM = 13;

export type HostStatus = "seated" | "floating" | "buried" | "missing" | "none";

export interface HostState {
  readonly status: HostStatus;
  /** Plain words: "Stands on Roof deck (linked) on a 14" curb". */
  readonly label: string;
  /** Top of the host surface (model elevation, mm); null with no host or a missing one. */
  readonly topMm: number | null;
  readonly curbMm: number;
  /** Part base minus (host top + curb); positive floats, negative buries. Null without a usable host. */
  readonly gapMm: number | null;
}

/** Model elevation of a placed part's base (its insertion point). */
export function partBaseMm(model: ModelState, part: PartInstance): number {
  const level = model.elements[part.levelId];
  return (level?.kind === "level" ? level.elevationMm : 0) + part.offsetMm;
}

/** The protocol feature for a part standing on a line-placed element (`PartHost` kind `element`). */
export const PARTS_LINE_HOST_FEATURE = "parts:line_host";

/** Kinds a part may stand on as a line host: what has a line or path, its stored placement or its flat start and end. */
const LINE_HOST_KINDS: ReadonlySet<string> = new Set(["beam", "wall", "grid", "component"]);

function levelElevation(model: ModelState, levelId: string | undefined, levelName: string | undefined): number {
  const byId = levelId !== undefined ? model.elements[levelId] : undefined;
  if (byId?.kind === "level") return byId.elevationMm;
  return viewFloorMm(model, levelName) ?? 0;
}

/**
 * The top of a line host at a station, model elevation in mm, or null when
 * the element is gone or has no line. A stored line placement gives the top
 * between its end offsets (its vertical justification says which face the
 * line is; the placement's own line is taken as the top); a path its profile;
 * a wall without one its height; a beam or grid without one its level's floor.
 */
export function lineHostTopMm(model: ModelState, elementId: string, stationMm: number): number | null {
  const el: BimElement | undefined = model.elements[elementId];
  if (!el || !LINE_HOST_KINDS.has(el.kind)) return null;
  const placement = "placement" in el ? el.placement : undefined;
  const levelName = el.partition?.level;
  if (placement?.kind === "line") {
    const len = Math.hypot(placement.end.x - placement.start.x, placement.end.y - placement.start.y);
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, stationMm / len));
    return levelElevation(model, placement.levelId, levelName) + placement.startOffsetMm + (placement.endOffsetMm - placement.startOffsetMm) * t;
  }
  if (placement?.kind === "path") {
    const s = Math.min(Math.max(0, stationMm), pathLength(placement)) + (placement.startStationMm ?? 0);
    return levelElevation(model, placement.levelId, levelName) + profileElevationAt(placement, s);
  }
  if (el.kind === "wall") return levelElevation(model, undefined, levelName) + el.height;
  if (el.kind === "beam" || el.kind === "grid") return levelElevation(model, undefined, levelName);
  return null;
}

/** Top of the surface a host names, or null when it is gone. */
export function hostTopMm(model: ModelState, host: PartHost): number | null {
  if (host.kind === "linked") return host.topMm;
  if (host.kind === "element") return lineHostTopMm(model, host.elementId, host.stationMm);
  const slab = model.elements[host.elementId];
  if (slab?.kind !== "slab") return null;
  return viewFloorMm(model, slab.partition?.level) ?? 0;
}

export function hostName(model: ModelState, host: PartHost): string {
  if (host.kind === "linked") return `${host.name} (linked)`;
  if (host.kind === "element") {
    const el = model.elements[host.elementId];
    const station = `${Math.round((host.stationMm / 304.8) * 100) / 100} ft along it`;
    return el ? `${el.kind.replace(/_/g, " ")} ${el.id}, ${station}` : `${host.elementId} (deleted)`;
  }
  const slab = model.elements[host.elementId];
  return slab?.kind === "slab" ? `slab ${slab.id}${slab.partition?.level ? ` on ${slab.partition.level}` : ""}` : `slab ${host.elementId} (deleted)`;
}

function inches(mm: number): string {
  return `${Math.round((mm / 25.4) * 10) / 10}"`;
}

/** What a placed part stands on, and whether it actually sits there. */
export function hostState(model: ModelState, part: PartInstance): HostState {
  const curbMm = part.curbMm ?? 0;
  if (part.planned !== undefined) return { status: "none", label: "Not placed yet", topMm: null, curbMm, gapMm: null };
  if (!part.host) return { status: "none", label: "No host", topMm: null, curbMm, gapMm: null };
  const top = hostTopMm(model, part.host);
  const name = hostName(model, part.host);
  if (top === null) return { status: "missing", label: `Its host ${name} is gone`, topMm: null, curbMm, gapMm: null };
  const gap = partBaseMm(model, part) - (top + curbMm);
  const on = `${name}${curbMm > 0 ? ` on a ${inches(curbMm)} curb` : ""}`;
  if (gap > SEATED_TOLERANCE_MM) return { status: "floating", label: `${inches(gap)} above ${on}`, topMm: top, curbMm, gapMm: gap };
  if (gap < -SEATED_TOLERANCE_MM) return { status: "buried", label: `${inches(-gap)} below the top of ${on}`, topMm: top, curbMm, gapMm: gap };
  return { status: "seated", label: `Stands on ${on}`, topMm: top, curbMm, gapMm: gap };
}

/**
 * The elevation a placed part's floor-measured clearances start from: its
 * host's top when it has one, else its level's floor.
 */
export function partFloorMm(model: ModelState, part: PartInstance): number {
  const top = part.host ? hostTopMm(model, part.host) : null;
  if (top !== null) return top;
  const level = model.elements[part.levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** A placed part's clearance zones in the world (type zones with its overrides, then the envelopes of its current and travel positions). Empty when its type has none. */
export function partClearances(model: ModelState, part: PartInstance): PlacedClearance[] {
  if (part.planned !== undefined) return [];
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  const def = type.definition;
  if (!def.clearances?.length && !part.clearances && !def.positions?.length) return [];
  const box = localBounds(resolveGeometry(def, part.values));
  const dim = (d: Dim) => resolveDim(def, part.values, d);
  const zones = [...resolveClearances(def.clearances, part.clearances, box, dim), ...resolvePositionEnvelopes(def.positions, part.positionId, box, dim)];
  if (zones.length === 0) return [];
  const base = partBaseMm(model, part);
  const floor = partFloorMm(model, part);
  return zones.map((z) => placeClearance(z, part, base, floor));
}

/**
 * Parts standing on a slab being deleted. They keep their host link (it now
 * names a slab that is gone, which Properties and the coordination lint say);
 * undoing the delete puts the deck back under them. Scans parts only when a
 * slab is among the deleted.
 */
export function partsHostedOn(model: ModelState, removed: ReadonlySet<string>): ElementId[] {
  let hostGone = false;
  for (const id of removed) {
    const k = model.elements[id]?.kind;
    if (k === "slab" || (k !== undefined && LINE_HOST_KINDS.has(k))) hostGone = true;
  }
  if (!hostGone) return [];
  return elementsOfKind(model.elements, "part")
    .filter((el) => (el.host?.kind === "slab" || el.host?.kind === "element") && removed.has(el.host.elementId) && !removed.has(el.id))
    .map((el) => el.id);
}

function insideOutline(p: { readonly x: number; readonly y: number }, poly: readonly { readonly x: number; readonly y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Our slabs whose outline holds a plan point, highest top first, with their tops: the decks a part there could stand on. */
export function slabsUnder(model: ModelState, point: { readonly x: number; readonly y: number }): Array<{ readonly id: ElementId; readonly name: string; readonly topMm: number }> {
  return elementsOfKind(model.elements, "slab")
    .filter((s) => s.outline.length >= 3 && insideOutline(point, s.outline))
    .map((s) => ({ id: s.id, name: hostName(model, { kind: "slab", elementId: s.id }), topMm: viewFloorMm(model, s.partition?.level) ?? 0 }))
    .sort((a, b) => b.topMm - a.topMm);
}
