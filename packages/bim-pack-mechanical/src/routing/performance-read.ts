import { z } from "zod";
import { DUCT_MATERIALS, ductInsulationSchema, runSizeSchema, type SystemDesign } from "@permitzip/bim-kernel";
import type { MechanicalPackRead } from "../agent-tools";
import { ductPerformance } from "./pressure";

/**
 * How a duct run performs at its airflow (velocity, friction rate), the
 * kernel's `run_performance` pack read (`schedules/records.ts` asks it for
 * the duct schedule's velocity and friction columns). A run that isn't
 * duct, or an input that isn't one, answers a refusal in words.
 */

const designSchema = z
  .object({
    altitudeM: z.number().finite().optional(),
    temperatureC: z.number().finite().optional(),
    material: z.enum(DUCT_MATERIALS).optional(),
    frictionMethod: z.enum(["colebrook", "altshul_tsal"]).optional(),
  })
  .passthrough();

const inputSchema = z.object({
  flow: z.number().finite(),
  size: runSizeSchema,
  insulation: ductInsulationSchema.optional(),
  design: designSchema.optional(),
});

export const RUN_PERFORMANCE_READ_ROW: MechanicalPackRead = {
  id: "run_performance",
  label: "Duct velocity and friction",
  run: (_model, input) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { refused: "That isn't a run, its airflow and its system's design" };
    const { flow, size, insulation, design } = parsed.data;
    const d: SystemDesign | undefined = design ? { altitudeM: design.altitudeM, temperatureC: design.temperatureC, material: design.material, frictionMethod: design.frictionMethod } : undefined;
    const perf = ductPerformance(flow, size, insulation, d);
    return perf ? { velocityFpm: perf.velocityFpm, frictionInPer100Ft: perf.frictionInPer100Ft } : { refused: "Only a duct run has a velocity and friction rate" };
  },
};
