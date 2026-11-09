import { DEDICATED_SPACE_RULE, clearancePurpose, derivedZonesOfHost, derivedZoneTop, disciplineOfCategory, elementsOfKind, hostName, hostState, partClearances, type BimElement, type Discipline, type PartInstance, type PlacedClearance } from "@permitzip/bim-kernel";
import { measurePair, prismConvex, type Aabb, type Convex } from "../../geometry/convex";
import type { BodyRecord } from "../../index-state";
import type { LinkedKind } from "../../types";
import { clip, feet, feetInches, inches } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Space and support, from the parts' own data (kernel spatial.ts):
 *
 * - clearance-intrusion: something solid inside a part's clearance zone
 *   (service access, combustibles, economizer access, NEC 110.26 working
 *   space). Zones are never bodies themselves, so two zones may overlap.
 * - hostFinding: the floating-equipment rule asks this first for a part that
 *   says what it stands on, so a stated host and curb win over a guess from
 *   the surfaces under it, and a host that is gone is said plainly.
 */

const MM_PER_IN = 25.4;
/** Linked things that don't take up the space (rooms, holes, ceilings). */
const NOT_SOLID: ReadonlySet<LinkedKind> = new Set(["space", "opening", "covering"]);

/** The zone as a solid, pulled in by the tolerance on every side so touching its floor or the part's face doesn't count. */
function zoneSolid(z: PlacedClearance, tolMm: number): { convex: Convex; box: Aabb } | null {
  const [c0, c1, , c3] = z.corners;
  const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
  const lu = len(c0, c1);
  const lv = len(c0, c3);
  if (lu <= 2 * tolMm || lv <= 2 * tolMm || z.topMm - z.bottomMm <= 2 * tolMm) return null;
  const u = { x: (c1.x - c0.x) / lu, y: (c1.y - c0.y) / lu };
  const v = { x: (c3.x - c0.x) / lv, y: (c3.y - c0.y) / lv };
  const at = (a: number, b: number) => ({ x: c0.x + u.x * a + v.x * b, y: c0.y + u.y * a + v.y * b });
  const outline = [at(tolMm, tolMm), at(lu - tolMm, tolMm), at(lu - tolMm, lv - tolMm), at(tolMm, lv - tolMm)];
  const z0 = z.bottomMm + tolMm;
  const z1 = z.topMm - tolMm;
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return { convex: prismConvex(outline, z0, z1), box: { min: { x: Math.min(...xs), y: Math.min(...ys), z: z0 }, max: { x: Math.max(...xs), y: Math.max(...ys), z: z1 } } };
}

function depthOf(z: PlacedClearance): number {
  return z.face === "front" || z.face === "back" ? z.max[0] - z.min[0] : z.face === "left" || z.face === "right" ? z.max[1] - z.min[1] : z.max[2] - z.min[2];
}

function intruders(ctx: RuleContext, part: PartInstance, box: Aabb): BodyRecord[] {
  return ctx.bodiesNear(box).filter((b) => {
    if (b.elementId === part.id) return false;
    if (b.linked) return ctx.config.include_linked && !(b.linkedKind && NOT_SOLID.has(b.linkedKind));
    if (b.elementId === null) return false;
    const el = ctx.model.elements[b.elementId];
    // A run connected to this part meets it by design; a slab or room is what the zone stands on, not in it.
    return el !== undefined && el.kind !== "slab" && el.kind !== "room" && !ctx.joined(part.id, b.elementId);
  });
}

export const clearanceRules: readonly RuleDef[] = [
  {
    id: "clearance-intrusion",
    version: 1,
    pack: "clearance",
    severity: "error",
    title: "Something inside a part's service, combustible, economizer or NEC 110.26 working clearance",
    scope: "element",
    kinds: ["part"],
    available: (ctx) => {
      for (const el of elementsOfKind(ctx.model.elements, "part_type", "part")) {
        if ((el.kind === "part_type" && (el.definition.clearances?.length || el.definition.positions?.length)) || (el.kind === "part" && el.clearances)) return null;
      }
      return "No part in this model has clearance zones yet (part editor › Clearances, Properties › Clearances, or bim_set_clearances)";
    },
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      const tol = ctx.config.tolerance_in * MM_PER_IN;
      const owner = ctx.name(el.id);
      const reported = new Set<string>();
      for (const zone of partClearances(ctx.model, el)) {
        // Dedicated zones keep out only foreign systems: dedicated-space-intrusion reports them.
        if (zone.excludes === "foreign_systems") continue;
        const solid = zoneSolid(zone, tol);
        if (!solid) continue;
        for (const body of intruders(ctx, el, solid.box)) {
          if (reported.has(body.key)) continue;
          const m = measurePair([solid.convex], body.pieces(), 0);
          if (m.kind !== "overlap") continue;
          reported.add(body.key);
          const other = body.linked ? `${body.linked.name} (linked)` : ctx.name(body.elementId ?? "");
          const hard = clearancePurpose(zone.purpose)?.severity === "error";
          const cx = (zone.corners[0].x + zone.corners[2].x) / 2;
          const cy = (zone.corners[0].y + zone.corners[2].y) / 2;
          ctx.emit({
            rule: "clearance-intrusion",
            severity: hard ? "error" : "warning",
            elementIds: body.elementId ? [el.id, body.elementId] : [el.id],
            ...(body.linked ? { linked: [body.linked] } : {}),
            at: { level: ctx.levelNameOf(el), x_ft: feet(cx), y_ft: feet(cy), z_ft: feet(zone.bottomMm) },
            message: clip(`${other} is ${inches(m.depthMm)} into ${owner}'s ${zone.name.toLowerCase()} (${feetInches(depthOf(zone))} ${zone.face})`),
            fix: body.linked
              ? { tool: "bim_move_elements", hint: clip(`move ${owner} so its ${zone.name.toLowerCase()} is clear of ${other}`, 120) }
              : { tool: "bim_move_elements", hint: clip(`move ${other} out of ${owner}'s ${zone.name.toLowerCase()}, or move ${owner}`, 120) },
          });
        }
      }
    },
  },
  {
    id: "dedicated-space-intrusion",
    version: 1,
    pack: "clearance",
    severity: "error",
    title: "A duct, pipe or other foreign system in the dedicated space above electrical equipment (NEC 110.26(E))",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      // The dedicated space is a derived zone (kernel spaces/derived-zones.ts), so every pack and the Spaces panel read the same region.
      const regions = derivedZonesOfHost(ctx.model, el, DEDICATED_SPACE_RULE);
      if (regions.length === 0) return;
      const tol = ctx.config.tolerance_in * MM_PER_IN;
      const owner = ctx.name(el.id);
      const own = disciplineOfElement(ctx, el);
      const reported = new Set<string>();
      for (const region of regions) {
        const zone = region.clearance;
        if (!zone) continue;
        const { x: cx, y: cy } = region.centre;
        const top = derivedZoneTop(region, buildingAbove(ctx, zone, cx, cy));
        const cut: PlacedClearance = { ...zone, topMm: top.topMm };
        const solid = zoneSolid(cut, tol);
        if (!solid) continue;
        const cite = zone.cite ?? "its code clause";
        for (const body of intruders(ctx, el, solid.box)) {
          if (reported.has(body.key) || !isForeign(ctx, body, own)) continue;
          const m = measurePair([solid.convex], body.pieces(), 0);
          if (m.kind !== "overlap") continue;
          reported.add(body.key);
          const other = body.linked ? `${body.linked.name} (linked)` : ctx.name(body.elementId ?? "");
          const reach =
            top.endsAt === "suspended_ceiling"
              ? `below its suspended ceiling`
              : top.endsAt === "structure"
                ? `below the structure`
                : top.structureAssumed
                  ? `within ${feetInches(top.topMm - zone.bottomMm)}; no structural ceiling known, so taken to ${feetInches(top.topMm - zone.bottomMm)}`
                  : `within ${feetInches(top.topMm - zone.bottomMm)}`;
          ctx.emit({
            rule: "dedicated-space-intrusion",
            severity: "error",
            elementIds: body.elementId ? [el.id, body.elementId] : [el.id],
            ...(body.linked ? { linked: [body.linked] } : {}),
            at: { level: ctx.levelNameOf(el), x_ft: feet(cx), y_ft: feet(cy), z_ft: feet(zone.bottomMm) },
            message: clip(`${other} is in the dedicated space above ${owner} (${reach}): ${cite}`),
            fix: { tool: "bim_move_elements", hint: clip(`move ${other} out of the space above ${owner} or above a suspended ceiling, or move ${owner}`, 120) },
          });
        }
      }
    },
  },
];

/** The trade an element belongs to, for "foreign to the installation". */
function disciplineOfElement(ctx: RuleContext, el: BimElement): Discipline | null {
  switch (el.kind) {
    case "part": {
      const type = ctx.model.elements[el.typeId];
      return type?.kind === "part_type" ? disciplineOfCategory(type.definition.category) : null;
    }
    case "run_segment":
    case "run_fitting":
      return el.domain === "conduit" ? "electrical" : el.domain === "duct" ? "mechanical" : "plumbing";
    case "duct_segment":
    case "tap":
    case "elbow":
    case "terminal":
    case "equipment":
    case "riser_segment":
      return "mechanical";
    default:
      return null;
  }
}

const SYSTEM_DISCIPLINES: ReadonlySet<Discipline> = new Set(["mechanical", "plumbing", "fire_protection", "electrical"]);
const ELECTRICAL_IFC = /cable|conduit|electric|lightfixture|lamp|outlet|switchingdevice|protectivedevice/i;

/** A duct, pipe or another trade's equipment: a system foreign to the part's own trade. Walls, slabs and rooms are not systems. */
function isForeign(ctx: RuleContext, body: BodyRecord, own: Discipline | null): boolean {
  if (body.linked) return body.linkedKind === "mep" && !(own === "electrical" && ELECTRICAL_IFC.test(body.linked.ifcClass));
  const el = body.elementId ? ctx.model.elements[body.elementId] : undefined;
  if (!el) return false;
  const d = disciplineOfElement(ctx, el);
  return d !== null && SYSTEM_DISCIPLINES.has(d) && d !== own;
}

/** The structure (lowest slab or roof underside above the zone's base) and a linked suspended ceiling over the zone's centre, as model elevations. */
function buildingAbove(ctx: RuleContext, zone: PlacedClearance, x: number, y: number): { structureMm: number | null; suspendedCeilingMm: number | null } {
  let structureMm: number | null = null;
  for (const s of ctx.surfacesAt(x, y)) {
    if ((s.kind !== "slab" && s.kind !== "roof") || s.bottom <= zone.bottomMm) continue;
    if (structureMm === null || s.bottom < structureMm) structureMm = s.bottom;
  }
  let suspendedCeilingMm: number | null = null;
  const probe = { min: { x: x - 1, y: y - 1, z: zone.bottomMm }, max: { x: x + 1, y: y + 1, z: zone.topMm } };
  for (const b of ctx.bodiesNear(probe)) {
    if (b.linkedKind !== "covering" || b.box.min.z <= zone.bottomMm) continue;
    if (suspendedCeilingMm === null || b.box.min.z < suspendedCeilingMm) suspendedCeilingMm = b.box.min.z;
  }
  return { structureMm, suspendedCeilingMm };
}

/**
 * For a part that names its host: the floating-equipment finding (or none
 * when it sits on it), worded from the host. Undefined when the part names no
 * host and the surface rules should decide.
 */
export function hostFinding(ctx: RuleContext, el: BimElement): Parameters<RuleContext["emit"]>[0] | null | undefined {
  if (el.kind !== "part" || !el.host) return undefined;
  const state = hostState(ctx.model, el);
  const name = ctx.name(el.id);
  const at = { level: ctx.levelNameOf(el), x_ft: feet(el.position.x), y_ft: feet(el.position.y), z_ft: feet(state.topMm ?? 0) };
  if (state.status === "missing") {
    return { rule: "floating-equipment", severity: "warning", elementIds: [el.id], at, message: clip(`${name} has nothing under it: its host ${hostName(ctx.model, el.host)} is gone`), fix: { tool: "bim_set_part_host", hint: `stand ${name} on another slab or roof, or remove_host` } };
  }
  const host = el.host;
  if (host.kind === "linked" && ctx.config.include_linked) {
    const model = ctx.linked.find((m) => m.modelId === host.referenceId);
    const element = host.globalId ? model?.elements.find((e) => e.globalId === host.globalId) : undefined;
    if (model && host.globalId && !element) {
      return { rule: "floating-equipment", severity: "warning", elementIds: [el.id], at, message: clip(`${name}'s host ${host.name} is no longer in ${model.label}`), fix: { tool: "bim_set_part_host", hint: `stand ${name} on the roof as the linked model has it now` } };
    }
    if (element) {
      const top = element.box[5];
      const moved = top - host.topMm;
      if (Math.abs(moved) > ctx.config.tolerance_in * MM_PER_IN) {
        return { rule: "floating-equipment", severity: "warning", elementIds: [el.id], linked: [{ modelId: model?.modelId ?? host.referenceId, globalId: element.globalId, name: element.name, ifcClass: element.ifcClass }], at, message: clip(`${host.name} (linked) moved ${moved > 0 ? "up" : "down"} ${inches(Math.abs(moved))} since ${name} was stood on it`), fix: { tool: "bim_set_part_host", hint: `stand ${name} on it again (top ${feet(top)} ft)` } };
      }
    }
  }
  if (state.status === "floating") {
    const gap = state.gapMm ?? 0;
    return {
      rule: "floating-equipment",
      severity: "warning",
      elementIds: [el.id],
      at,
      message: clip(`${name} is ${state.label}`),
      fix: { tool: "bim_set_part_host", hint: clip(`seat ${name} on its host (lower it ${gap >= 304.8 ? feetInches(gap) : inches(gap)}), or set its curb`, 120) },
    };
  }
  // Sunk below its host plus curb: the surface rules (buried-equipment) judge it against what is really there.
  if (state.status === "buried") return undefined;
  return null;
}
