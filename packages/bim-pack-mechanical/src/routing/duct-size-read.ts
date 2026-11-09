import { z } from "zod";
import { SYSTEM_KINDS, inheritedDuctDesign, type ModelState } from "@permitzip/bim-kernel";
import { sizingCriteriaFor, suggestDuctSize } from "./duct-sizing";
import type { MechanicalPackRead } from "../agent-tools";

/**
 * `mechanical.duct_size` (pack read): the duct size the system's criteria
 * call for, from a routed segment (its system, insulation, airflow and
 * depth) or from airflow given here. The same search bim_suggest_duct_size
 * runs; sizes come back in mm. Nothing changes: a script resizes with
 * `ctx.edit` when it likes the answer.
 */

const INPUT = z.object({
  element_id: z.string().min(1).max(200).optional().describe("A routed duct segment."),
  cfm: z.number().positive().max(200_000).optional().describe("Air to carry; absent: what the segment carries."),
  shape: z.enum(["rect", "round"]).optional(),
  system_id: z.string().min(1).max(200).optional(),
  system_kind: z.enum(SYSTEM_KINDS).optional(),
  height_mm: z.number().positive().max(6000).optional().describe("Rectangular: the depth to hold (what the ceiling allows)."),
  friction_in_per_100ft: z.number().min(0.01).max(1).optional(),
  max_velocity_fpm: z.number().min(100).max(6000).optional(),
  max_aspect_ratio: z.number().min(1).max(10).optional(),
});

function ductSizeRead(model: ModelState, input: unknown) {
  const parsed = INPUT.safeParse(input ?? {});
  if (!parsed.success) return { refused: `Those inputs don't fit: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}` };
  const a = parsed.data;
  const el = a.element_id ? model.elements[a.element_id] : undefined;
  if (a.element_id && el?.kind !== "run_segment") return { refused: `${a.element_id} isn't a routed duct segment in what the script reads.` };
  const seg = el?.kind === "run_segment" ? el : null;
  if (seg && seg.domain !== "duct") return { refused: `${a.element_id} is ${seg.domain}; this sizes duct.` };
  const systemEl = model.elements[a.system_id ?? seg?.systemId ?? ""];
  const system = systemEl?.kind === "mep_system" ? systemEl : null;
  const kind = system?.systemKind ?? a.system_kind ?? "supply_air";
  const design = system?.design ?? (a.system_kind ? inheritedDuctDesign(model, { systemKind: a.system_kind }) : undefined);
  const insulation = seg ? seg.insulation : design?.insulation;
  const cfm = a.cfm ?? (seg && seg.flow > 0 ? seg.flow : undefined);
  if (cfm === undefined) return { refused: seg ? `${seg.id} carries no air yet; give cfm.` : "Give cfm, or element_id of a segment that carries air." };
  const base = sizingCriteriaFor(kind, design);
  const criteria = { frictionInPer100Ft: a.friction_in_per_100ft ?? base.frictionInPer100Ft, maxVelocityFpm: a.max_velocity_fpm ?? base.maxVelocityFpm, maxAspectRatio: a.max_aspect_ratio ?? base.maxAspectRatio };
  const shape = a.shape ?? (seg?.size.shape === "round" ? "round" : "rect");
  const holdHeightMm = a.height_mm ?? (seg?.size.shape === "rect" && shape === "rect" ? seg.size.height : undefined);
  const s = suggestDuctSize({ cfm, shape, criteria, ...(insulation ? { insulation } : {}), ...(design ? { design } : {}), ...(holdHeightMm !== undefined ? { holdHeightMm } : {}) });
  if (!s.ok) return { refused: s.reason };
  const pick = s.atHeight ?? s.best;
  return { cfm, shape, criteria, suggested: pick, leastSheetMetal: s.best, ...(seg ? { current: seg.size } : {}) };
}

export const DUCT_SIZE_READ_ROW: MechanicalPackRead = { id: "mechanical.duct_size", label: "The duct size a system's criteria call for", run: ductSizeRead };
