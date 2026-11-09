import { defineCalc, type CalcOutput } from "@permitzip/bim-pack/runtime";
import { qty, to } from "@permitzip/bim-units";
import type { z } from "zod";
import { SIMPLE_BEAM_CALC_ID, SIMPLE_BEAM_CALC_VERSION, SimpleBeamInputError, simpleBeam, simpleBeamCalcInputSchema, type SimpleBeamResult } from "./simple-beam";

/** `struct.simple_beam` on the calc point: values in bim-units codes (lbf, lbf.ft, ft). */

type Output = CalcOutput<SimpleBeamResult | null>;
type Value = Output["values"][number];
type Citation = Value["cite"][number];

export const SIMPLE_BEAM_METHOD: Citation = {
  source: "method",
  code: "AISC Steel Construction Manual",
  edition: "16th",
  clause: "Table 3-23, cases 1 and 8",
  detail: "simple beam, uniform load plus concentrated loads at any point, superposed",
  text: "AISC Manual 16th Ed. Table 3-23, cases 1 and 8 (superposed)",
};

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** The calc on parsed inputs. An impossible beam is an issue, never a throw. */
export function runSimpleBeam(i: z.output<typeof simpleBeamCalcInputSchema>): Output {
  let result: SimpleBeamResult;
  try {
    result = simpleBeam({
      span: qty("length", i.span_ft, "ft"),
      uniform: qty("line_load", i.uniform_plf, "plf"),
      pointLoads: i.point_loads.map((p) => ({ load: qty("force", p.p_lbf, "lbf"), at: qty("length", p.a_ft, "ft"), ...(p.label ? { label: p.label } : {}) })),
      ...(i.allowable_moment_kip_ft !== undefined ? { allowableMoment: qty("moment", i.allowable_moment_kip_ft, "kip.ft") } : {}),
    });
  } catch (err) {
    if (!(err instanceof SimpleBeamInputError)) throw err;
    console.error("[struct.simple_beam] impossible beam", { message: err.message });
    return { values: [], steps: [], issues: [{ severity: "error", message: err.message, cite: [] }], detail: null };
  }
  const cite = [SIMPLE_BEAM_METHOD];
  const values: Value[] = [
    { key: "start_reaction", label: "Reaction at start", value: round(to(result.startReaction, "lbf"), 1), unit: "lbf", cite },
    { key: "end_reaction", label: "Reaction at end", value: round(to(result.endReaction, "lbf"), 1), unit: "lbf", cite },
    { key: "max_moment", label: "Largest moment", value: round(to(result.maxMoment, "lbf.ft"), 0), unit: "lbf.ft", cite },
    { key: "max_moment_at", label: "Largest moment at", value: round(to(result.maxMomentAt, "ft"), 2), unit: "ft", cite },
    { key: "utilisation", label: "Moment ÷ allowable", value: result.utilisation === null ? null : round(result.utilisation, 3), unit: "ratio", cite },
  ];
  const issues: Output["issues"][number][] = [{ severity: "info", message: "One service-level load case (dead + live + equipment, unfactored). Load combinations are not applied.", cite: [] }];
  if (result.utilisation !== null && result.utilisation > 1) issues.push({ severity: "error", message: `The largest moment is ${(result.utilisation * 100).toFixed(0)}% of the allowable`, cite });
  return {
    values,
    steps: [
      { label: "Reactions", detail: "R start = wL/2 + Σ P(L − a)/L; R end = wL/2 + Σ P·a/L", cite },
      { label: "Largest moment", detail: "Checked at both ends, at each point load and where the shear crosses zero", cite },
    ],
    issues,
    detail: result,
  };
}

export const SIMPLE_BEAM_CALC = defineCalc({
  id: SIMPLE_BEAM_CALC_ID,
  version: String(SIMPLE_BEAM_CALC_VERSION),
  domain: "struct",
  title: "Simple beam",
  summary: "End reactions, the largest bending moment and its utilisation for a simply supported beam under a uniform load and point loads (one service-level case).",
  codeFamily: null,
  needsModel: false,
  input: simpleBeamCalcInputSchema,
  example: { span_ft: 30, uniform_plf: 526, point_loads: [{ p_lbf: 2000, a_ft: 10, label: "RTU-1" }], allowable_moment_kip_ft: 100 },
  run: (input) => runSimpleBeam(input),
});
