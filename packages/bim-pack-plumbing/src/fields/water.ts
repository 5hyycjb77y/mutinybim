import { pipeSegmentOf, type BimElement, type FieldPathInfo, type FieldScalar, type MepSystem } from "@permitzip/bim-kernel";
import { pipeSystemReportOf, type WaterReport } from "../routing/pipe/hydraulics";

/**
 * Field paths on a domestic water system (or any of its pipes): the numbers
 * the water pressure loss sheet works from, read from the pressure solve the
 * add-on already runs (`pipeSystemReportOf`), so the sheet never disagrees
 * with the hydraulics panel. Pressures in psi, velocity in ft/s.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Static head of water at about 60 °F, psi per foot of rise (0.433). */
export const WATER_PSI_PER_FT = 0.433;

export const WATER_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "water.supply_psi", label: "Street (supply) pressure (psi)", on: "pipe", example: "60" },
  { path: "water.fixed_losses_psi", label: "Losses before the first drawn pipe: meter, backflow preventer (psi)", on: "pipe", example: "12" },
  { path: "water.elevation_psi", label: "Static head up to the most remote fixture (psi)", on: "pipe", example: "8.7" },
  { path: "water.friction_psi", label: "Pipe and fitting friction to the most remote fixture (psi)", on: "pipe", example: "9.4" },
  { path: "water.residual_psi", label: "Pressure left at the most remote fixture (psi)", on: "pipe", example: "29.9" },
  { path: "water.min_fixture_psi", label: "Pressure the most remote fixture needs (psi)", on: "pipe", example: "15" },
  { path: "water.max_velocity_fps", label: "Highest velocity in the system (ft/s)", on: "pipe", example: "6.8" },
];

const reports = new WeakMap<Elements, Map<string, WaterReport | null>>();

function systemOf(elements: Elements, elementId: string): MepSystem | null {
  const el = elements[elementId];
  if (el?.kind === "mep_system") return el;
  const seg = pipeSegmentOf(elements, elementId);
  const sys = seg ? elements[seg.systemId] : undefined;
  return sys?.kind === "mep_system" ? sys : null;
}

/** The water report of a system, once per model state; null for a system that isn't water. */
export function waterReportOf(elements: Elements, systemId: string): WaterReport | null {
  let bySystem = reports.get(elements);
  if (!bySystem) {
    bySystem = new Map();
    reports.set(elements, bySystem);
  }
  if (!bySystem.has(systemId)) {
    const r = pipeSystemReportOf(elements, systemId);
    bySystem.set(systemId, r?.kind === "water" ? r : null);
  }
  return bySystem.get(systemId) ?? null;
}

const psi = (v: number | null): { value: FieldScalar; text: string } => (v === null || !Number.isFinite(v) ? { value: null, text: "" } : { value: Math.round(v * 100) / 100, text: `${Math.round(v * 10) / 10} psi` });

/** A `water.*` path; null when the path isn't one (the next resolver answers). */
export function resolveWaterField(elements: Elements, elementId: string, path: string): { value: FieldScalar; text: string } | null {
  if (!path.startsWith("water.")) return null;
  const system = systemOf(elements, elementId);
  const report = system ? waterReportOf(elements, system.id) : null;
  if (!system || !report) return { value: null, text: "" };
  const fixed = system.design?.pipe?.fixedLossesPsi ?? 0;
  const critical = report.critical;
  const elevation = critical ? critical.elevationFt * WATER_PSI_PER_FT : null;
  const pathLoss = report.supplyPsi !== null && critical ? report.supplyPsi - fixed - critical.pressure : null;
  switch (path.slice("water.".length)) {
    case "supply_psi":
      return psi(report.supplyPsi);
    case "fixed_losses_psi":
      return psi(fixed);
    case "elevation_psi":
      return psi(elevation);
    case "friction_psi":
      return psi(pathLoss !== null && elevation !== null ? pathLoss - elevation : null);
    case "residual_psi":
      return psi(report.supplyPsi !== null && critical ? critical.pressure : null);
    case "min_fixture_psi":
      return psi(report.minFixturePsi);
    case "max_velocity_fps": {
      if (report.segments.length === 0) return { value: null, text: "" };
      const v = Math.max(...report.segments.map((s) => s.velocityFps));
      return { value: Math.round(v * 100) / 100, text: `${Math.round(v * 10) / 10} ft/s` };
    }
    default:
      return { value: null, text: "" };
  }
}
