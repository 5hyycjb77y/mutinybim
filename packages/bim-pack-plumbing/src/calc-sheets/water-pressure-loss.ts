import { pipeSegmentOf, pipeFamilyOf, type MepSystem, type ModelState } from "@permitzip/bim-kernel";
import type { CalcSheetBuildRequest, CalcSheetSpec, CalcSheetTemplateRow } from "@permitzip/bim-kernel/calc-sheets";

/**
 * Water pressure loss as a live sheet (round 12 P12): street pressure, the
 * losses before the first drawn pipe (meter, backflow preventer), the
 * static head and the friction along the path to the most remote fixture
 * (the add-on's pressure solve, through `water.*` fields), what is left
 * there against what the fixture needs, and the system's top velocity and
 * friction against the firm's limits (8 ft/s, 10 psi by default).
 */

export const WATER_PRESSURE_LOSS_TEMPLATE_ID = "water_pressure_loss";

function systemOf(model: Pick<ModelState, "elements">, id: string): MepSystem | null {
  const el = model.elements[id];
  if (el?.kind === "mep_system") return el;
  const seg = pipeSegmentOf(model.elements, id);
  const sys = seg ? model.elements[seg.systemId] : undefined;
  return sys?.kind === "mep_system" ? sys : null;
}

export function waterPressureLossSpec(model: Pick<ModelState, "elements">, request: CalcSheetBuildRequest): CalcSheetSpec | { readonly refused: string } {
  if (!request.subjectId) return { refused: "Pick the water system this sheet checks" };
  const system = systemOf(model, request.subjectId);
  if (!system || pipeFamilyOf(system.systemKind) !== "water") return { refused: "Water pressure loss needs a domestic water system: pick the system or one of its pipes" };
  const field = (path: string) => ({ from: "field" as const, subjectId: system.id, path });
  return {
    template: WATER_PRESSURE_LOSS_TEMPLATE_ID,
    title: `Water pressure loss, ${system.name}`,
    inputs: [
      { key: "supply", label: "Street pressure", unit: "psi", bind: field("water.supply_psi") },
      { key: "fixed", label: "Meter, backflow preventer and other losses before the piping", unit: "psi", bind: field("water.fixed_losses_psi") },
      { key: "elevation", label: "Static head to the most remote fixture", unit: "psi", bind: field("water.elevation_psi") },
      { key: "friction", label: "Pipe and fitting friction to the most remote fixture", unit: "psi", bind: field("water.friction_psi") },
      { key: "needed", label: "Pressure the most remote fixture needs", unit: "psi", bind: field("water.min_fixture_psi") },
      { key: "velocity", label: "Highest velocity in the system", unit: "ft/s", bind: field("water.max_velocity_fps") },
    ],
    lookups: [],
    steps: [
      { key: "available", label: "Pressure at the most remote fixture", formula: "{supply} - {fixed} - {elevation} - {friction}", unit: "psi" },
      { key: "spare", label: "Over what the fixture needs", formula: "{available} - {needed}", unit: "psi" },
      { key: "passes", label: "Enough pressure at the most remote fixture (1 yes, 0 no)", formula: "{available} >= {needed}", unit: "1" },
    ],
    checks: [
      { key: "velocity_check", label: "Velocity", value: "velocity", limit: { quantity: "velocity", system: system.systemKind } },
      { key: "friction_check", label: "Pressure loss", value: "friction", limit: { quantity: "pressure", system: system.systemKind } },
    ],
    citations: [{ section: "Most remote fixture method", note: "Friction from the add-on's pressure solve along the path to the most remote fixture; static head at 0.433 psi per foot." }],
    result: { key: "available", label: "Pressure at the most remote fixture (psi)" },
  };
}

export const WATER_PRESSURE_LOSS_TEMPLATE: CalcSheetTemplateRow = {
  id: WATER_PRESSURE_LOSS_TEMPLATE_ID,
  label: "Water pressure loss",
  discipline: "plumbing",
  subjectKinds: ["mep_system", "run_segment"],
  build: (model, request) => waterPressureLossSpec(model, request),
};
