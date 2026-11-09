import { elementsOfKind, type BimElement, type PartInstance, type PartTypeElement } from "@permitzip/bim-kernel";
import { growAabb } from "../../geometry/convex";
import type { Surface } from "../../index-state";
import { clip, feet, feetInches, inches } from "../format";
import { hostFinding } from "./spatial";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Where equipment sits against the building: inside it, on something, not
 * sunk into it (bug log #27). Surfaces are linked slabs, roofs and spaces
 * plus our own slabs and rooms. With no surfaces near a part's height there
 * is nothing to compare with, and these rules stay quiet rather than guess.
 */

const MM_PER_IN = 25.4;
/** Surfaces this far below a part's base still count as "its level" (a diffuser hung 9 ft above its floor). */
const BAND_BELOW_MM = 6000;
const BAND_ABOVE_MM = 300;
/** A base sunk deeper than this is not "buried"; it is on the level below. */
const BURIED_MAX_MM = 1000;

export type Mounting = "standing" | "hung" | "unknown";

/**
 * Whether a part stands on a floor or roof (so it must sit on one) or hangs
 * (so a gap below it is normal). Its `mounting` value says so when set;
 * otherwise equipment whose duct connectors all face down (a downflow
 * rooftop unit) stands. Anything else is unknown and not checked.
 */
export function mountingOf(part: PartInstance, type: PartTypeElement): Mounting {
  const raw = part.values.mounting ?? type.definition.typeValues.mounting;
  const m = typeof raw === "string" ? raw.toLowerCase() : "";
  if (/floor|roof|grade|pad|curb|base|slab/.test(m)) return "standing";
  if (/ceiling|wall|hung|suspend|recess|surface|pendant/.test(m)) return "hung";
  const def = type.definition;
  if (def.category === "mechanical_equipment") {
    const ducts = def.connectors.filter((c) => c.domain === "duct");
    if (ducts.length > 0 && ducts.every((c) => c.direction[2] < 0 && Math.abs(c.direction[0]) < 1e-6 && Math.abs(c.direction[1]) < 1e-6)) return "standing";
  }
  if (def.category === "plumbing_fixture" && /floor/i.test(def.familyName)) return "standing";
  return "unknown";
}

function isSite(part: PartInstance, type: PartTypeElement): boolean {
  const flag = (v: unknown) => v === true || (typeof v === "string" && /^(site|true|yes)$/i.test(v));
  return flag(part.values.site) || flag(type.definition.typeValues.site) || flag(part.values.location);
}

interface Placed {
  readonly part: PartInstance;
  readonly type: PartTypeElement;
  readonly cx: number;
  readonly cy: number;
  readonly bottom: number;
}

function placed(ctx: RuleContext, el: BimElement): Placed | null {
  if (el.kind !== "part") return null;
  const type = ctx.model.elements[el.typeId];
  if (type?.kind !== "part_type") return null;
  const body = ctx.body(el.id);
  if (!body) return null;
  return { part: el, type, cx: (body.box.min.x + body.box.max.x) / 2, cy: (body.box.min.y + body.box.max.y) / 2, bottom: body.box.min.z };
}

function standsOn(s: Surface): number {
  return s.kind === "space" || s.kind === "room" ? s.bottom : s.top;
}

function inBand(s: Surface, bottom: number): boolean {
  return s.bottom <= bottom + BAND_ABOVE_MM && standsOn(s) >= bottom - BAND_BELOW_MM;
}

function edgeDistance(x: number, y: number, poly: Surface["outline"]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as { x: number; y: number };
    const b = poly[i] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y));
  }
  return best;
}

function surfaceLabel(s: Surface): string {
  return `${s.name}${s.linked ? " (linked)" : ""}`;
}

/**
 * Linked slabs that are the site, not the building: an architect models the
 * grass, parking and sidewalk around a building as floor slabs, and those
 * reach far past its walls. The index has only the element name to tell them
 * by (IFC exports them as IfcSlab with no site predefined type).
 */
const SITE_SLAB_NAME = /\b(sidewalks?|parking|paving|pavement|grass|lawn|landscap\w*|hardscape|topo\w*|driveway|asphalt|gravel)\b/i;

export function isSiteSlabName(name: string): boolean {
  return SITE_SLAB_NAME.test(name);
}

function isSiteSurface(s: Surface): boolean {
  return s.linked !== null && s.kind === "slab" && isSiteSlabName(s.name);
}

function bandSurfacesNear(ctx: RuleContext, p: Placed): Surface[] {
  // Surfaces whose box is within reach of this part (the band's height, 200 ft in plan).
  const reach = 60_960;
  const q = growAabb({ min: { x: p.cx, y: p.cy, z: p.bottom - BAND_BELOW_MM }, max: { x: p.cx, y: p.cy, z: p.bottom + BAND_ABOVE_MM } }, 0);
  return ctx.surfacesNear({ min: { x: q.min.x - reach, y: q.min.y - reach, z: q.min.z }, max: { x: q.max.x + reach, y: q.max.y + reach, z: q.max.z } }).filter((s) => inBand(s, p.bottom) && !isSiteSurface(s));
}

/** Floor elevations of our levels and the linked models' storeys. */
function levelElevations(ctx: RuleContext): number[] {
  const out = elementsOfKind(ctx.model.elements, "level").map((l) => l.elevationMm);
  for (const m of ctx.linked) for (const s of m.storeys) out.push(s.elevationMm);
  return out;
}

/**
 * True when a level's floor lies above the surface and at or below the part's
 * own level, so the surface belongs to a level below the part: a Level 1 room
 * or the grass under a roof-top unit is not what the unit stands on. The
 * part's own floor or roof isn't modeled there, and that is not "floating".
 */
function onLowerLevel(s: Surface, ownLevelMm: number, levels: readonly number[], tol: number): boolean {
  const top = standsOn(s);
  return levels.some((e) => e > top + tol && e <= ownLevelMm + tol);
}

function ownLevelElevation(ctx: RuleContext, p: Placed): number {
  const level = ctx.model.elements[p.part.levelId];
  return level?.kind === "level" ? level.elevationMm : p.bottom;
}

function at(ctx: RuleContext, p: Placed) {
  return { level: ctx.levelNameOf(p.part), x_ft: feet(p.cx), y_ft: feet(p.cy), z_ft: feet(p.bottom) };
}

/**
 * The surface a standing part rests on: the highest one under its centre
 * whose top is at or below its base (within tolerance), on the part's own
 * level. "lower" when everything under it is on a level below.
 */
function hostUnder(ctx: RuleContext, p: Placed): Surface | "lower" | null {
  const tol = ctx.config.tolerance_in * MM_PER_IN;
  const levels = levelElevations(ctx);
  const own = ownLevelElevation(ctx, p);
  let best: Surface | null = null;
  let lower = false;
  for (const s of ctx.surfacesAt(p.cx, p.cy)) {
    const top = standsOn(s);
    if (top > p.bottom + tol) continue;
    if (onLowerLevel(s, own, levels, tol)) {
      lower = true;
      continue;
    }
    if (!best || top > standsOn(best)) best = s;
  }
  return best ?? (lower ? "lower" : null);
}

export const placementRules: readonly RuleDef[] = [
  {
    id: "outside-building",
    version: 1,
    pack: "placement",
    severity: "error",
    title: "Equipment outside every slab, roof, space or room on its level",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const p = placed(ctx, el);
      if (!p || isSite(p.part, p.type)) return;
      const band = bandSurfacesNear(ctx, p);
      if (band.length === 0) return;
      const inside = ctx.surfacesAt(p.cx, p.cy).some((s) => inBand(s, p.bottom) && !isSiteSurface(s));
      if (inside) return;
      // Rooms alone are where someone traced, not the building's edge: say what was compared.
      const roomsOnly = band.every((s) => s.kind === "room" || s.kind === "space");
      let nearest: Surface | null = null;
      let d = Infinity;
      for (const s of band) {
        const e = edgeDistance(p.cx, p.cy, s.outline);
        if (e < d) {
          d = e;
          nearest = s;
        }
      }
      const name = ctx.name(el.id);
      ctx.emit({
        rule: "outside-building",
        severity: "error",
        elementIds: [el.id],
        ...(nearest?.linked ? { linked: [nearest.linked] } : {}),
        at: at(ctx, p),
        message: clip(roomsOnly ? `${name} is outside every room on its level: ${feet(d)} ft past ${nearest ? surfaceLabel(nearest) : "the nearest room"}` : `${name} is outside the building: ${feet(d)} ft past the edge of ${nearest ? surfaceLabel(nearest) : "the nearest floor or roof"}`),
        fix: { tool: "bim_move_elements", hint: clip(`move ${name} at least ${feet(d) + 1} ft back over ${nearest ? surfaceLabel(nearest) : "the building"}`, 120) },
      });
    },
  },
  {
    id: "floating-equipment",
    version: 2,
    pack: "placement",
    severity: "warning",
    title: "Standing equipment above the surface under it (or its stated host and curb), or with nothing under it",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const hosted = hostFinding(ctx, el);
      if (hosted !== undefined) {
        if (hosted) ctx.emit(hosted);
        return;
      }
      const p = placed(ctx, el);
      if (!p || isSite(p.part, p.type) || mountingOf(p.part, p.type) !== "standing") return;
      if (bandSurfacesNear(ctx, p).length === 0) return;
      const tol = ctx.config.tolerance_in * MM_PER_IN;
      const host = hostUnder(ctx, p);
      if (host === "lower") return;
      const name = ctx.name(el.id);
      if (!host) {
        ctx.emit({ rule: "floating-equipment", severity: "warning", elementIds: [el.id], at: at(ctx, p), message: clip(`${name} has no floor, roof or curb under it`), fix: { tool: "bim_move_elements", hint: `move ${name} onto a roof or floor` } });
        return;
      }
      const gap = p.bottom - standsOn(host);
      if (gap <= tol) return;
      ctx.emit({
        rule: "floating-equipment",
        severity: "warning",
        elementIds: [el.id],
        ...(host.linked ? { linked: [host.linked] } : {}),
        at: at(ctx, p),
        message: clip(`${name} floats ${gap >= 304.8 ? feetInches(gap) : inches(gap)} above ${surfaceLabel(host)} (top ${feetInches(standsOn(host))})`),
        fix: { tool: "bim_set_part_host", hint: clip(`stand ${name} on ${surfaceLabel(host)} with a ${inches(gap)} curb, or lower it ${inches(gap)}`, 120) },
      });
    },
  },
  {
    id: "buried-equipment",
    version: 1,
    pack: "placement",
    severity: "warning",
    title: "Standing equipment sunk into the surface under it",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      const p = placed(ctx, el);
      if (!p || isSite(p.part, p.type) || mountingOf(p.part, p.type) !== "standing") return;
      const tol = ctx.config.tolerance_in * MM_PER_IN;
      for (const s of ctx.surfacesAt(p.cx, p.cy)) {
        if (s.kind === "space" || s.kind === "room") continue;
        const sunk = s.top - p.bottom;
        if (sunk <= tol || sunk > BURIED_MAX_MM || s.bottom >= p.bottom + sunk) continue;
        const name = ctx.name(el.id);
        ctx.emit({
          rule: "buried-equipment",
          severity: "warning",
          elementIds: [el.id],
          ...(s.linked ? { linked: [s.linked] } : {}),
          at: at(ctx, p),
          message: clip(`${name} is sunk ${inches(sunk)} into ${surfaceLabel(s)} (top ${feetInches(s.top)})`),
          fix: { tool: "bim_set_parameters", hint: `raise ${name} by ${inches(sunk)} (offset)` },
        });
        return;
      }
    },
  },
  {
    id: "no-host",
    version: 1,
    pack: "placement",
    severity: "warning",
    title: "A ceiling air terminal with no ceiling at its height",
    scope: "element",
    kinds: ["part"],
    available: (ctx) => (ctx.hasNativeCeilings || ctx.linked.some((m) => m.elements.some((e) => e.kind === "covering")) ? null : "No ceilings in this model or its linked models to host terminals"),
    run: (ctx, el) => {
      const p = placed(ctx, el);
      if (!p || p.type.definition.category !== "air_terminal") return;
      const body = ctx.body(el.id);
      if (!body) return;
      const reach = 150;
      const linkedCeiling = ctx.bodiesNear(growAabb(body.box, reach)).some((b) => b.linkedKind === "covering");
      const level = p.part.partition?.level;
      const nativeCeiling = ctx.nativeCeilings().some((id) => {
        const e = ctx.model.elements[id];
        return e?.kind === "component" && (!level || e.partition?.level === level) && Math.abs(p.cx - e.position.x) <= e.size.x / 2 && Math.abs(p.cy - e.position.y) <= e.size.y / 2;
      });
      const hosted = linkedCeiling || nativeCeiling;
      if (hosted) return;
      const name = ctx.name(el.id);
      ctx.emit({ rule: "no-host", severity: "warning", elementIds: [el.id], at: at(ctx, p), message: clip(`${name} has no ceiling within 6 in. of it`), fix: { tool: "bim_set_parameters", hint: `set ${name}'s height to the ceiling's` } });
    },
  },
];
