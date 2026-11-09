import { hazenWilliamsPsiPer100Ft, pipeSystemReport, type PipeSystemReport } from "../../routing/pipe/hydraulics";
import { z } from "zod";
import { methodCite, defineCalc, round } from "@permitzip/bim-calc";
import type { CalcIssue, CalcValue, Citation } from "@permitzip/bim-calc";
import { PLUMBING_CODE_CALCS } from "./code-calcs";
import { DRAINAGE_CALCS } from "./drainage-checks";
import { gasSystemCalc } from "./gas-system";
import { sizeSystemCalc } from "./system-sizing";

/**
 * Pipe calcs on the plugin interface, calling the kernel's hydraulics
 * (packages/bim-kernel/src/routing/pipe/hydraulics.ts) unchanged: the same
 * numbers as bim_pipe_report, with units, citations and the run envelope.
 * The kernel bundles no plumbing-code sizing table; its "verify for permit
 * work" basis lines become method citations here.
 */

const HAZEN: Citation = methodCite("Hazen–Williams", "psi per 100 ft = 4.52 Q^1.852 / (C^1.852 d^4.8704) x 100");

const waterFrictionInput = z
  .object({
    gpm: z.number().positive().max(100_000),
    inside_diameter_in: z.number().positive().max(120),
    hazen_c: z.number().min(60).max(160).describe("Hazen-Williams C: 140–150 copper and plastic, 100–120 older steel."),
  })
  .strict();

export const waterFrictionCalc = defineCalc({
  id: "plumbing.water_friction",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water pipe friction (Hazen–Williams)",
  summary: "Friction loss per 100 ft and velocity for a water flow in a pipe of a given inside diameter and C factor. The same equation the pipe hydraulics report uses.",
  codeFamily: null,
  needsModel: false,
  input: waterFrictionInput,
  example: { gpm: 10, inside_diameter_in: 0.785, hazen_c: 140 },
  run: (input) => {
    const psi = hazenWilliamsPsiPer100Ft(input.gpm, input.hazen_c, input.inside_diameter_in);
    const fps = input.gpm / 448.831 / ((Math.PI * (input.inside_diameter_in / 12) ** 2) / 4);
    const values: CalcValue[] = [
      { key: "friction_psi_per_100ft", label: "Friction loss", value: round(psi, 4), unit: "psi_per_100ft", cite: [HAZEN] },
      { key: "velocity_fps", label: "Velocity", value: round(fps, 3), unit: "fps", cite: [methodCite("Continuity", "V = Q / A")] },
    ];
    return { values, steps: [{ label: "Friction", detail: `${input.gpm} gpm, ${input.inside_diameter_in}" bore, C ${input.hazen_c}: ${round(psi, 3)} psi/100 ft at ${round(fps, 2)} ft/s`, cite: [HAZEN] }], issues: [], detail: { psiPer100Ft: psi, velocityFps: fps } };
  },
});

const systemInput = z
  .object({
    system_id: z.string().min(1).max(200).describe("The pipe system (mep_system) id."),
    element_id: z.string().min(1).max(200).optional().describe("Any pipe in the system (picks the connected piece the report covers)."),
  })
  .strict();

function summary(report: PipeSystemReport): CalcValue[] {
  const cite = report.basis.map((b) => methodCite("Pipe hydraulics basis", b));
  switch (report.kind) {
    case "water":
      return [
        { key: "peak_gpm", label: "Peak demand", value: report.peakGpm, unit: "gpm", cite },
        { key: "total_fixture_units", label: "Fixture units", value: report.totalFixtureUnits, unit: null, cite },
        { key: "critical_fixture", label: "Critical fixture", value: report.critical?.label ?? null, unit: null, cite },
        { key: "critical_pressure_psi", label: "Pressure at the critical fixture", value: report.critical?.pressure ?? null, unit: "psi", cite },
        { key: "pass", label: "Meets the required fixture pressure", value: report.pass, unit: null, cite },
      ];
    case "drainage":
      return [
        { key: "total_fixture_units", label: "Drainage fixture units", value: report.totalFixtureUnits, unit: null, cite },
        { key: "pass", label: "Every pipe carries its flow", value: report.pass, unit: null, cite },
      ];
    case "gas":
      return [
        { key: "total_mbh", label: "Connected input", value: report.totalMbh, unit: null, cite },
        { key: "longest_run_ft", label: "Longest run", value: report.longestRunFt, unit: "ft", cite },
        { key: "critical_pressure_in_wc", label: "Pressure at the critical outlet", value: report.critical?.pressure ?? null, unit: "in_wc_gas", cite },
        { key: "pass", label: "Within the allowable drop", value: report.pass, unit: null, cite },
      ];
    case "not_calculated":
      return [];
  }
}

export const pipeSystemCalc = defineCalc({
  id: "plumbing.pipe_system",
  version: "1.0.0",
  domain: "plumbing",
  title: "Pipe system hydraulics (water, drainage, gas)",
  summary: "The kernel's pipe hydraulics report for one system on the plugin interface: water pressures to the critical fixture, drainage capacity at slope and stacks, or gas drop over the longest run. Identical numbers to bim_pipe_report.",
  codeFamily: null,
  needsModel: true,
  input: systemInput,
  example: { system_id: "sys-cw" },
  run: (input, ctx) => {
    const report = ctx.model ? pipeSystemReport(ctx.model, input.system_id, { hint: input.element_id }) : null;
    if (!report) return { values: [], steps: [], issues: [{ severity: "error", message: `No system ${input.system_id} in this model.`, cite: [] }], detail: null };
    const issues: CalcIssue[] = [...(report.kind === "not_calculated" ? [{ severity: "error" as const, message: report.reason, cite: [] }] : []), ...report.warnings.map((w): CalcIssue => ({ severity: "warning", message: w.message, cite: [] }))];
    return { values: summary(report), steps: report.basis.map((b) => ({ label: "Basis", detail: b, cite: [] })), issues, detail: report };
  },
});

export const PLUMBING_CALCS = [waterFrictionCalc, pipeSystemCalc, ...PLUMBING_CODE_CALCS, gasSystemCalc, sizeSystemCalc, ...DRAINAGE_CALCS] as const;
