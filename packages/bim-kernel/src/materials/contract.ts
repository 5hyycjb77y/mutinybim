import { defineExtensionPoint } from "../packs/contract";

/**
 * Element/type value key pointing to a registered material id (`kernel.material`).
 * Any element or element type may store this scalar string in `values`.
 */
export const MATERIAL_ID_KEY = "material.id";

export const MATERIAL_PATTERNS = [
  "solid",
  "concrete",
  "brick",
  "gypsum",
  "wood",
  "metal",
  "tile",
  "glass",
  "insulation",
  "earth",
] as const;

export type MaterialPattern = (typeof MATERIAL_PATTERNS)[number];

export const MATERIAL_CUT_HATCHES = ["solid", "diagonal", "cross", "none"] as const;
export type MaterialCutHatch = (typeof MATERIAL_CUT_HATCHES)[number];

export const MATERIAL_SURFACE_HATCHES = [
  "none",
  "grid_600",
  "grid_600x1200",
  "diagonal",
  "brick",
] as const;
export type MaterialSurfaceHatch = (typeof MATERIAL_SURFACE_HATCHES)[number];

/**
 * Shared material definition contributed by add-ons (`kernel.material` v1).
 * Drives both 2D plan/section poché and 3D surface appearance.
 */
export interface MaterialDef {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  /** Surface color as #rrggbb hex string. */
  readonly color: string;
  /** Physically based roughness in [0, 1] (default 0.8). */
  readonly roughness?: number;
  /** Physically based metalness in [0, 1] (default 0). */
  readonly metalness?: number;
  /** Opacity in (0, 1] (default 1). */
  readonly opacity?: number;
  /** Procedural surface texture pattern for 3D rendering. */
  readonly pattern?: MaterialPattern;
  /**
   * 2D plan/section cut poché fill: #rrggbb hex or greyscale shade in [0, 1]
   * (where 0 = black, 1 = white). Omit to use a light neutral cut fill.
   */
  readonly planCutFill?: string | number;
  /** 2D cut hatch style (default "solid"). */
  readonly planCutHatch?: MaterialCutHatch;
  /** 2D surface hatch pattern for floors, ceilings, or elevations. */
  readonly surfaceHatch?: MaterialSurfaceHatch;
  /** Building-envelope thermal conductivity λ in W/(m·K) (ISO 6946 / ASHRAE). */
  readonly thermalConductivityWPerMK?: number;
  /** Material bulk density in kg/m³ (for thermal mass and dead-load takeoffs). */
  readonly densityKgPerM3?: number;
  /** Specific heat capacity in J/(kg·K). */
  readonly specificHeatJPerKgK?: number;
  /** Solar heat gain coefficient in (0, 1] for glazing materials. */
  readonly shgc?: number;
}

export const MATERIAL_POINT = defineExtensionPoint<MaterialDef>({
  id: "kernel.material",
  version: 1,
  label: "Materials",
  idOf: (row) => row.id,
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function materialRowProblems(items: readonly MaterialDef[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      out.push(`material ${item.id} has no name`);
    }
    if (typeof item.color !== "string" || !HEX_COLOR_RE.test(item.color)) {
      out.push(`material ${item.id} color "${String(item.color)}" must be #rrggbb`);
    }
    if (item.roughness !== undefined && (!Number.isFinite(item.roughness) || item.roughness < 0 || item.roughness > 1)) {
      out.push(`material ${item.id} roughness must be in [0, 1]`);
    }
    if (item.metalness !== undefined && (!Number.isFinite(item.metalness) || item.metalness < 0 || item.metalness > 1)) {
      out.push(`material ${item.id} metalness must be in [0, 1]`);
    }
    if (item.opacity !== undefined && (!Number.isFinite(item.opacity) || item.opacity <= 0 || item.opacity > 1)) {
      out.push(`material ${item.id} opacity must be in (0, 1]`);
    }
    if (item.pattern !== undefined && !(MATERIAL_PATTERNS as readonly string[]).includes(item.pattern)) {
      out.push(`material ${item.id} has unknown pattern "${item.pattern}"`);
    }
    if (item.planCutFill !== undefined) {
      if (typeof item.planCutFill === "number") {
        if (!Number.isFinite(item.planCutFill) || item.planCutFill < 0 || item.planCutFill > 1) {
          out.push(`material ${item.id} numeric planCutFill must be in [0, 1]`);
        }
      } else if (typeof item.planCutFill !== "string" || !HEX_COLOR_RE.test(item.planCutFill)) {
        out.push(`material ${item.id} string planCutFill must be #rrggbb`);
      }
    }
    if (item.planCutHatch !== undefined && !(MATERIAL_CUT_HATCHES as readonly string[]).includes(item.planCutHatch)) {
      out.push(`material ${item.id} has unknown planCutHatch "${item.planCutHatch}"`);
    }
    if (item.surfaceHatch !== undefined && !(MATERIAL_SURFACE_HATCHES as readonly string[]).includes(item.surfaceHatch)) {
      out.push(`material ${item.id} has unknown surfaceHatch "${item.surfaceHatch}"`);
    }
  }
  return out;
}
