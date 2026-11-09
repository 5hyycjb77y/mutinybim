import { DUCT_MATERIALS, type RunSize } from "@permitzip/bim-kernel";
import { DUCT_ROUGHNESS_MM, PA_PER_IN_WC, airProperties, ductSection, frictionRate, systemPressure, type SystemPressureReport } from "../../routing/pressure";
import { z } from "zod";
import { defineCalc, fToC, ftToM, inToMm, methodCite, q, round, type CalcIssue, type CalcValue, type Citation } from "@permitzip/bim-calc";

/**
 * Duct calcs on the plugin interface. Both call the kernel's own pressure
 * engine (packages/bim-kernel/src/routing/pressure.ts) unchanged, so results
 * are the same numbers the properties panel and bim_pressure_report show; the
 * plugin adds units, citations and the common run envelope.
 */

const M3S_PER_CFM = 0.00047194745;
const FPM_PER_MPS = 196.850394;

const DARCY: Citation = methodCite("ASHRAE Handbook—Fundamentals, Duct Design", "Darcy–Weisbach with the Colebrook friction factor");
const ALTSHUL: Citation = methodCite("ASHRAE Handbook—Fundamentals, Duct Design", "Darcy–Weisbach with the Altshul–Tsal friction factor");
const AIR: Citation = methodCite("Air properties", "standard atmosphere pressure at altitude, ideal-gas density, Sutherland viscosity");
const CONTINUITY: Citation = methodCite("Continuity", "V = Q / A");
const HYDRAULIC_DIAMETER: Citation = methodCite("Hydraulic diameter", "Dh = 4A / P");
const roughnessCite = (material: string, mm: number): Citation => methodCite("Duct roughness", `${material}: ${mm} mm absolute roughness`, "typical handbook value, verify for the product used");

const ductFrictionInput = z
  .object({
    cfm: z.number().positive().max(200_000),
    diameter_in: z.number().positive().max(240).optional().describe("Round duct diameter, inches."),
    width_in: z.number().positive().max(240).optional().describe("Rectangular width, inches (with height_in)."),
    height_in: z.number().positive().max(240).optional(),
    material: z.enum(DUCT_MATERIALS).default("galvanized"),
    altitude_ft: z.number().min(-1000).max(15_000).default(0),
    air_temp_f: z.number().min(-40).max(250).default(68),
    method: z.enum(["colebrook", "altshul_tsal"]).default("colebrook"),
  })
  .strict()
  .refine((v) => v.diameter_in !== undefined || (v.width_in !== undefined && v.height_in !== undefined), { message: "Give diameter_in, or width_in and height_in." });

export const ductFrictionCalc = defineCalc({
  id: "mech.duct_friction",
  version: "1.0.0",
  domain: "mechanical",
  title: "Duct friction rate and velocity",
  summary: "Velocity, velocity pressure and friction rate (in. w.c. per 100 ft) for an airflow in a round or rectangular duct: Darcy–Weisbach with Colebrook (or Altshul–Tsal), the material's roughness, and air density and viscosity at the altitude and temperature. The same engine as the duct pressure report.",
  codeFamily: null,
  needsModel: false,
  input: ductFrictionInput,
  example: { cfm: 400, diameter_in: 10, material: "galvanized" },
  run: (input) => {
    const size: RunSize = input.diameter_in !== undefined ? { shape: "round", diameter: inToMm(q(input.diameter_in, "in")) } : { shape: "rect", width: inToMm(q(input.width_in ?? 0, "in")), height: inToMm(q(input.height_in ?? 0, "in")) };
    const air = airProperties(ftToM(q(input.altitude_ft, "ft")), fToC(input.air_temp_f));
    const roughness = DUCT_ROUGHNESS_MM[input.material];
    const section = ductSection(size);
    const rate = frictionRate(input.cfm, size, air, roughness, input.method);
    const v = section && section.areaM2 > 0 ? (input.cfm * M3S_PER_CFM) / section.areaM2 : 0;
    const vpPa = (air.densityKgM3 * v * v) / 2;
    const cite = [input.method === "colebrook" ? DARCY : ALTSHUL, AIR, roughnessCite(input.material, roughness)];
    const values: CalcValue[] = [
      { key: "velocity_fpm", label: "Velocity", value: round(v * FPM_PER_MPS, 1), unit: "fpm", cite: [CONTINUITY] },
      { key: "velocity_pressure_in_wc", label: "Velocity pressure", value: round(vpPa / PA_PER_IN_WC, 4), unit: "in_wc", cite: [AIR] },
      { key: "friction_in_wc_per_100ft", label: "Friction rate", value: round((rate * 30.48) / PA_PER_IN_WC, 4), unit: "in_wc_per_100ft", cite },
      { key: "hydraulic_diameter_in", label: "Hydraulic diameter", value: section ? round((section.dhM * 1000) / 25.4, 3) : null, unit: "in", cite: [HYDRAULIC_DIAMETER] },
    ];
    return { values, steps: [{ label: "Friction", detail: `${input.cfm} CFM in ${input.diameter_in !== undefined ? `${input.diameter_in}" round` : `${input.width_in}x${input.height_in}`} ${input.material}: ${round(v * FPM_PER_MPS, 0)} fpm, ${round((rate * 30.48) / PA_PER_IN_WC, 4)} in. w.c./100 ft`, cite }], issues: [], detail: { frictionRatePaPerM: rate, air, roughnessMm: roughness } };
  },
});

const systemInput = z
  .object({
    system_id: z.string().min(1).max(200).describe("The duct system (mep_system) id."),
    element_id: z.string().min(1).max(200).optional().describe("Any run in the system, so the engine doesn't have to search for one."),
  })
  .strict();

function pressureCitations(report: SystemPressureReport): Citation[] {
  const cites: Citation[] = [report.air.frictionMethod === "colebrook" ? DARCY : ALTSHUL, AIR, roughnessCite(report.air.material, report.air.roughnessMm)];
  const seen = new Set<string>();
  for (const e of Object.values(report.elements)) {
    if (e.kind !== "fitting") continue;
    for (const p of e.paths) {
      if (seen.has(p.source.label)) continue;
      seen.add(p.source.label);
      cites.push(methodCite("Fitting loss coefficient", p.source.label, p.method));
    }
  }
  return cites;
}

export const ductSystemPressureCalc = defineCalc({
  id: "mech.duct_system_pressure",
  version: "1.0.0",
  domain: "mechanical",
  title: "Duct system static pressure (fan ESP)",
  summary: "The kernel's duct pressure report for one system on the plugin interface: friction for every stretch, each fitting's C x VP with its coefficient source, the critical path, and the external static pressure the fan needs. Identical numbers to bim_pressure_report.",
  codeFamily: null,
  needsModel: true,
  input: systemInput,
  example: { system_id: "sys-sa" },
  run: (input, ctx) => {
    const report = ctx.model ? systemPressure(ctx.model, input.system_id, { hint: input.element_id }) : null;
    if (!report) return { values: [], steps: [], issues: [{ severity: "error", message: `No system ${input.system_id} in this model.`, cite: [] }], detail: null };
    const issues: CalcIssue[] = [...(report.calculable ? [] : [{ severity: "error" as const, message: report.reason ?? "Not calculated", cite: [] }]), ...report.warnings.map((w): CalcIssue => ({ severity: "warning", message: w, cite: [] }))];
    const cite = pressureCitations(report);
    const values: CalcValue[] = report.calculable
      ? [
          { key: "required_esp_in_wc", label: "External static pressure the fan needs", value: report.requiredEspInWc, unit: "in_wc", cite },
          { key: "total_pa", label: "Critical path loss", value: report.totalPa, unit: "Pa", cite },
          { key: "fan", label: "Counted from", value: report.rootLabel, unit: null, cite },
          { key: "critical_end", label: "Critical path ends at", value: report.ends.find((e) => e.pathPa === report.totalPa)?.label ?? null, unit: null, cite },
        ]
      : [];
    return { values, steps: report.criticalPath.map((s) => ({ label: s.label, detail: `+${s.lossPa} Pa (cumulative ${s.cumulativePa} Pa)`, cite: [] })), issues, detail: report };
  },
});

export const MECHANICAL_CALCS = [ductFrictionCalc, ductSystemPressureCalc] as const;
