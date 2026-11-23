import { isRegistryIdShape, rawRegistryWords } from "../ids";
import { activePackSet } from "../packs/scope";
import { containsPoint } from "../spaces/space-geometry";
import type { BimElement, Vec2 } from "../types";
import { KNOWN_CEILING_FORMS, SURFACE_ROLE_POINT, type Ceiling, type CeilingForm, type CeilingGrid, type CeilingSlope, type SurfaceRoleDef } from "./types";

/**
 * Tolerant readers for stored ceilings (expand, then contract). A form or a
 * role this release doesn't know is kept as stored and read as a ceiling; a
 * slope that isn't a pair of finite numbers reads as flat. Writers are strict
 * (`commands.ts`); readers never refuse a record a newer peer wrote.
 */

export const CEILING_KIND = "ceiling";

export function isCeiling(el: { readonly kind: string } | undefined): el is Ceiling {
  return el !== undefined && el.kind === CEILING_KIND;
}

const KNOWN_FORMS: ReadonlySet<string> = new Set(KNOWN_CEILING_FORMS);

export function isKnownCeilingForm(form: string): boolean {
  return KNOWN_FORMS.has(form);
}

/** The stored form (a newer peer's form kept as it is); a record without one reads as flat. */
export function ceilingForm(c: Ceiling): CeilingForm {
  return typeof c.form === "string" && c.form.length > 0 ? c.form : "flat";
}

/** The plane's slope, or null for a flat plane (no slope, a zero pitch, or numbers this release can't read). */
export function ceilingSlope(c: Ceiling): CeilingSlope | null {
  const s = c.slope;
  if (!s || !Number.isFinite(s.directionDeg) || !Number.isFinite(s.pitch) || s.pitch === 0) return null;
  return s;
}

/** Where the stated height is measured: the reference point, else the outline's first corner. */
export function ceilingReference(c: Ceiling): Vec2 {
  return c.reference ?? c.outline[0] ?? { x: 0, y: 0 };
}

/** A plane's height at a plan point, mm: `heightMm` at `reference`, plus its rise along the slope (none when flat). A tool drawing a ceiling not yet made asks this too. */
export function planeHeightAt(heightMm: number, reference: Vec2, slope: CeilingSlope | null, p: Vec2): number {
  if (!slope) return heightMm;
  const a = (slope.directionDeg * Math.PI) / 180;
  return heightMm + slope.pitch * ((p.x - reference.x) * Math.cos(a) + (p.y - reference.y) * Math.sin(a));
}

/** Height above the level at a plan point, mm: the stated height, plus the rise of a sloped plane from its reference. */
export function ceilingHeightAtPoint(c: Ceiling, p: Vec2): number {
  const slope = ceilingSlope(c);
  return slope ? planeHeightAt(c.heightMm, ceilingReference(c), slope, p) : c.heightMm;
}

/** Lowest and highest height above the level over the whole outline, mm (a plane's extremes are at its corners). */
export function ceilingHeightRange(c: Ceiling): { readonly lowMm: number; readonly highMm: number } {
  if (!ceilingSlope(c) || c.outline.length === 0) return { lowMm: c.heightMm, highMm: c.heightMm };
  let lowMm = Infinity;
  let highMm = -Infinity;
  for (const p of c.outline) {
    const h = ceilingHeightAtPoint(c, p);
    lowMm = Math.min(lowMm, h);
    highMm = Math.max(highMm, h);
  }
  return { lowMm, highMm };
}

/** Whether the ceiling covers a plan point: inside its outline and outside every hole. */
export function ceilingCovers(c: Ceiling, p: Vec2): boolean {
  if (c.outline.length < 3 || !containsPoint(c.outline, p)) return false;
  for (const hole of c.holes ?? []) if (hole.length >= 3 && containsPoint(hole, p)) return false;
  return true;
}

/** The role a form plays when the ceiling names none. */
export function defaultRoleForForm(form: CeilingForm): string {
  return form === "cloud" || form === "soffit" || form === "open_to_structure" ? form : "ceiling";
}

/** The stored role id: the one it names, else its form's. */
export function ceilingRoleId(c: Ceiling): string {
  return typeof c.role === "string" && c.role.length > 0 ? c.role : defaultRoleForForm(ceilingForm(c));
}

/** Exact imperial tile pitch constants (2 ft = 609.6 mm, 4 ft = 1219.2 mm). */
export const TILE_2FT_MM = 609.6;
export const TILE_4FT_MM = 1219.2;

/** The stored tile grid of a ceiling when valid, else null. */
export function ceilingGrid(c: Ceiling): Required<CeilingGrid> | null {
  const g = c.grid;
  if (!g || !Number.isFinite(g.spacingXMm) || g.spacingXMm <= 0 || !Number.isFinite(g.spacingYMm) || g.spacingYMm <= 0) return null;
  const origin = g.origin && Number.isFinite(g.origin.x) && Number.isFinite(g.origin.y) ? g.origin : { x: 0, y: 0 };
  const rotationDeg = typeof g.rotationDeg === "number" && Number.isFinite(g.rotationDeg) ? g.rotationDeg : 0;
  return { spacingXMm: g.spacingXMm, spacingYMm: g.spacingYMm, origin, rotationDeg };
}

/**
 * Snap a plan point to the exact center of the nearest tile cell (or half-cell
 * when a square 2×2 device seats cleanly inside half of a 2×4 tile).
 */
export function ceilingGridCellCenter(
  grid: Pick<CeilingGrid, "spacingXMm" | "spacingYMm" | "origin" | "rotationDeg">,
  near: Vec2,
  opts?: { readonly deviceWidthMm?: number; readonly deviceDepthMm?: number },
): Vec2 {
  const ox = grid.origin?.x ?? 0;
  const oy = grid.origin?.y ?? 0;
  const rad = ((grid.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = near.x - ox;
  const dy = near.y - oy;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  // A 2×2 device placed in a 2×4 ceiling grid seats cleanly in either 2×2 half of a 2×4 tile.
  const cellX = opts?.deviceWidthMm && opts.deviceWidthMm <= grid.spacingXMm * 0.55 && grid.spacingXMm >= grid.spacingYMm * 1.8 ? grid.spacingXMm / 2 : grid.spacingXMm;
  const cellY = opts?.deviceDepthMm && opts.deviceDepthMm <= grid.spacingYMm * 0.55 && grid.spacingYMm >= grid.spacingXMm * 1.8 ? grid.spacingYMm / 2 : grid.spacingYMm;
  const su = (Math.floor(u / cellX) + 0.5) * cellX;
  const sv = (Math.floor(v / cellY) + 0.5) * cellY;
  return {
    x: Math.round((ox + su * cos - sv * sin) * 10) / 10,
    y: Math.round((oy + su * sin + sv * cos) * 10) / 10,
  };
}

/** The surface roles in force: the built-ins and every role the model's add-ons contribute. */
export function surfaceRoles(): readonly SurfaceRoleDef[] {
  return activePackSet().items(SURFACE_ROLE_POINT);
}

/** The surface role a ceiling plays. A role no add-on in force defines is kept and read as a ceiling that hosts devices, in its own words. */
export function ceilingRole(c: Ceiling): SurfaceRoleDef {
  const id = ceilingRoleId(c);
  const known = surfaceRoles().find((r) => r.id === id);
  if (known) return known;
  return { id, label: isRegistryIdShape(id) ? rawRegistryWords(id) : id, hostsDevices: true };
}

/** How a ceiling is named in answers and refusals: "Ceiling C-3", "Cloud c-12". */
export function ceilingLabel(c: Ceiling): string {
  const role = ceilingRole(c);
  return `${role.label} ${c.id}`;
}

/** The ceilings in an element record that names `kind: "ceiling"` (a record of any kind narrows here). */
export function asCeiling(el: BimElement | undefined): Ceiling | null {
  return isCeiling(el) ? el : null;
}
