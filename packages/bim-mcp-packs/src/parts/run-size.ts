import { z } from "zod";
import { LINER_SURFACES, PIPE_MATERIALS, PIPE_SPEC_IDS, type DuctInsulation, type RunSize } from "@permitzip/bim-kernel";

const MM_PER_IN = 25.4;
/** Inches to millimetres, to the micron, so 14" is 355.6 and not 355.59999999999997. */
const inch = (v: number) => Math.round(v * MM_PER_IN * 1000) / 1000;

/** A run size from inches: width/height (rect, or oval), a diameter (round duct), or a nominal size and material (pipe). */
export const runSizeArgs = {
  width_in: z.number().positive().max(240).optional().describe("Rectangular or oval duct width in inches."),
  height_in: z.number().positive().max(240).optional().describe("Rectangular or oval duct height in inches."),
  oval: z.boolean().optional().describe("Flat oval duct (with width_in / height_in)."),
  diameter_in: z.number().positive().max(240).optional().describe("Round duct diameter in inches."),
  nominal_in: z.number().positive().max(72).optional().describe("Pipe nominal size in inches (with material)."),
  material: z.enum(PIPE_MATERIALS).optional().describe("Pipe material (with nominal_in)."),
  spec: z.enum(PIPE_SPEC_IDS).optional().describe("Pipe product spec: type_k / type_l / type_m copper, sch40, no_hub or service_weight cast iron… Leave out for the material's usual one."),
};

/** Duct insulation as an agent gives it: none, or a wrap (outside) / liner (inside) with its thickness in inches. */
export const insulationArg = z
  .object({
    kind: z.enum(["none", "wrap", "liner"]).describe("none: bare. wrap: outside (grows the outside size). liner: inside (narrows the airway)."),
    thickness_in: z.number().min(0.25).max(6).optional().describe("Inches; needed for wrap and liner."),
    material: z.string().trim().min(1).max(60).optional().describe("As the spec names it."),
    r_value: z.number().positive().max(60).optional(),
    surface: z.enum(LINER_SURFACES).optional().describe("Liner: faced (default) or spray_coated (rougher)."),
  })
  .describe("Duct insulation or liner; pipe takes a wrap.");

export function insulationFrom(a: z.infer<typeof insulationArg>): DuctInsulation | null | string {
  if (a.kind === "none") return null;
  if (a.thickness_in === undefined) return `Give thickness_in for the ${a.kind}.`;
  if (a.surface && a.kind !== "liner") return "surface (faced or spray_coated) applies to a liner; a wrap is outside the air.";
  return { kind: a.kind, thicknessMm: inch(a.thickness_in), ...(a.material ? { material: a.material } : {}), ...(a.r_value !== undefined ? { rValue: a.r_value } : {}), ...(a.surface ? { surface: a.surface } : {}) };
}

export function runSizeFrom(a: { width_in?: number; height_in?: number; oval?: boolean; diameter_in?: number; nominal_in?: number; material?: (typeof PIPE_MATERIALS)[number]; spec?: (typeof PIPE_SPEC_IDS)[number] }): RunSize | string {
  if (a.nominal_in !== undefined) {
    if (!a.material) return "A pipe size needs its material as well as nominal_in.";
    return { shape: "pipe", nominalMm: inch(a.nominal_in), material: a.material, ...(a.spec ? { spec: a.spec } : {}) };
  }
  if (a.diameter_in !== undefined) return { shape: "round", diameter: inch(a.diameter_in) };
  if (a.width_in !== undefined && a.height_in !== undefined) return { shape: a.oval ? "oval" : "rect", width: inch(a.width_in), height: inch(a.height_in) };
  return "Give width_in and height_in (rectangular or oval duct), diameter_in (round duct), or nominal_in and material (pipe).";
}

