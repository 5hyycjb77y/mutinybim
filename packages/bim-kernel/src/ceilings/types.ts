import { defineExtensionPoint } from "../packs/contract";
import type { ElementCore, ElementId, ModelElementBase, Vec2 } from "../types";

/**
 * Ceilings as typed surfaces (contract 1.4.0, lane C). A ceiling is one
 * generic element every discipline reads: heights, finishes and rated
 * assemblies; what hangs from it; terminals, lights and plenum depth; device
 * spacing by height; obstructions, slopes, clouds and soffits; finish
 * quantities. Nothing on it is one discipline's field.
 *
 * A typed ceiling is a statement, so `surfacesAt` reads it ahead of a space's
 * stated ceiling height. Models without ceilings keep reading the space's
 * stated height.
 */

/** Peers read and store `ceiling` records. */
export const CEILINGS_FEATURE = "elements:ceilings";

export const KNOWN_CEILING_FORMS = ["flat", "sloped", "cloud", "soffit", "open_to_structure"] as const;
export type CeilingForm = (typeof KNOWN_CEILING_FORMS)[number] | (string & {});

/** A plane's slope: it rises `pitch` (rise over run) toward `directionDeg` (degrees counter-clockwise from east). */
export interface CeilingSlope {
  readonly directionDeg: number;
  readonly pitch: number;
}

export interface Ceiling extends ModelElementBase, ElementCore {
  readonly kind: "ceiling";
  readonly levelId: ElementId;
  /** The space it is hosted in, when there is one. */
  readonly spaceId?: ElementId;
  /** Plan outline, mm. A cloud is its own outline. */
  readonly outline: readonly Vec2[];
  /** Openings in it (an atrium, a skylight well), mm. */
  readonly holes?: readonly (readonly Vec2[])[];
  readonly form: CeilingForm;
  /** Height above the level at `reference` (or anywhere, when flat), mm. */
  readonly heightMm: number;
  /** Where `heightMm` is measured, for a sloped ceiling. Absent: the outline's first point. */
  readonly reference?: Vec2;
  /** Absent: flat. */
  readonly slope?: CeilingSlope;
  /** Its surface role (`SURFACE_ROLE_POINT`). Absent: `ceiling`. */
  readonly role?: string;
}

/**
 * A role a horizontal surface plays (v1): ceiling, soffit, cloud, open to
 * structure, or a pack's own (`fp.baffle`). Readers keep a role this release
 * doesn't know and treat it as a ceiling.
 */
export interface SurfaceRoleDef {
  readonly id: string;
  readonly label: string;
  /** Whether devices may be hosted on it (a cloud: yes; open to structure: no, they hang from structure). */
  readonly hostsDevices: boolean;
}

export const BUILTIN_SURFACE_ROLES: readonly SurfaceRoleDef[] = [
  { id: "ceiling", label: "Ceiling", hostsDevices: true },
  { id: "soffit", label: "Soffit", hostsDevices: true },
  { id: "cloud", label: "Cloud", hostsDevices: true },
  { id: "open_to_structure", label: "Open to structure", hostsDevices: false },
];

export const SURFACE_ROLE_POINT = defineExtensionPoint<SurfaceRoleDef>({
  id: "kernel.surface_role",
  version: 1,
  label: "Surface roles",
  idOf: (role) => role.id,
  builtins: () => BUILTIN_SURFACE_ROLES,
});
