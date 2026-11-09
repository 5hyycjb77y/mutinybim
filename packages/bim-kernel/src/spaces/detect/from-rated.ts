import { ratingOf } from "../../registry/rating-kind-point";
import type { BimElement, ElementId } from "../../types";
import { ratedSegmentsOfLevel } from "../boundaries/boundary-index";
import { faceAround, regionsOf } from "../boundaries/face-walk";
import { containsPoint, outlineAreaMm2, outlineProblem, MM2_PER_M2 } from "../space-geometry";
import type { SpaceDesignCommand } from "../space-commands";
import type { ZonePurpose } from "../types";
import type { DetectedRoomOutline } from "./rooms";
import { lineJoinsOf } from "../../joins/solve";

/**
 * Zones from rated boundaries (proposal only): the closed regions a level's
 * elements rated at least `atLeast` of `ratingKind` make (room-bounding or
 * not: a rated wall above a ceiling still closes a fire area), such as
 * fire areas from walls rated one hour or more. Nothing is stored; the person
 * accepts each as an outlined zone of the purpose they pick.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface RatedZoneProposal extends DetectedRoomOutline {
  /** The rated elements that close it. */
  readonly elementIds: readonly ElementId[];
}

const SAME_AREA = 0.005;

function inBody(elements: Elements, ids: Iterable<ElementId>, at: { readonly x: number; readonly y: number }): boolean {
  for (const id of ids) {
    const o = lineJoinsOf(elements, id)?.outline;
    if (o && o.length >= 3 && containsPoint(o, at)) return true;
  }
  return false;
}

export function proposeRatedZones(elements: Elements, levelId: ElementId, opts: { readonly ratingKind: string; readonly atLeast: number }): RatedZoneProposal[] {
  const rated = new Map<ElementId, boolean>();
  const isRated = (id: ElementId): boolean => {
    let hit = rated.get(id);
    if (hit === undefined) {
      const el = elements[id];
      const r = el ? ratingOf(elements, el, opts.ratingKind) : null;
      hit = r !== null && r >= opts.atLeast;
      rated.set(id, hit);
    }
    return hit;
  };
  const segs = ratedSegmentsOfLevel(elements, levelId, opts.ratingKind).filter((s) => isRated(s.elementId));
  const out = new Map<string, RatedZoneProposal>();
  for (const r of regionsOf(segs)) {
    if (outlineProblem(r.outline) !== null) continue;
    const ids = [...new Set(r.boundary.map((b) => b.elementId))];
    if (inBody(elements, ids, r.inside)) continue;
    const area = outlineAreaMm2(r.outline);
    const traced = faceAround(segs, r.inside);
    if (!traced.ok || Math.abs(outlineAreaMm2(traced.outline) - area) > SAME_AREA * area) continue;
    const key = `${Math.round(r.inside.x / 10) * 10},${Math.round(r.inside.y / 10) * 10}`;
    if (!out.has(key)) out.set(key, { key, outline: r.outline, areaM2: area / MM2_PER_M2, centre: r.inside, openings: [], confidence: 1, elementIds: ids });
  }
  return [...out.values()].sort((a, b) => a.centre.x - b.centre.x || a.centre.y - b.centre.y);
}

/** Accept one proposal as an outlined zone (`create_zone`; written only to peers that read outlined zones). */
export function ratedZoneCommand(p: RatedZoneProposal, levelId: ElementId, zone: { readonly zoneId: string; readonly name: string; readonly purpose: ZonePurpose }): Extract<SpaceDesignCommand, { type: "create_zone" }> {
  return { type: "create_zone", zoneId: zone.zoneId, name: zone.name, purpose: zone.purpose, outline: { levelId, outline: p.outline.map((q) => ({ x: q.x, y: q.y })) } };
}
