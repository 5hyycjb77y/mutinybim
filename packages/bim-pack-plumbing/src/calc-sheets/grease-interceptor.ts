import type { ElementId, ModelState } from "@permitzip/bim-kernel";
import type { CalcSheetBuildRequest, CalcSheetSpec, CalcSheetTemplateRow } from "@permitzip/bim-kernel/calc-sheets";

/**
 * Grease interceptor sizing as a live sheet (round 12 P12): the sink's bowls
 * (length × width × depth × count, from the sink's parameters) give a
 * volume; three quarters of it drains in one or two minutes; the
 * interceptor's rated flow (from its product values) must cover the
 * two-minute rate. 28 × 20 × 14 in × 3 → 23,520 in³ → 76.36 / 38.18 gpm,
 * which a 50 gpm interceptor passes at 2 minutes.
 *
 * Subject: the sink. `options.interceptorId`: the interceptor it drains to
 * (without one, the rated flow line says what to pick).
 */

export const GREASE_INTERCEPTOR_TEMPLATE_ID = "grease_interceptor";

/** Parameters the sheet reads, by name (`param.<name>`). */
export const GREASE_SHEET_PARAMS = { bowlLength: "bowl_length_in", bowlWidth: "bowl_width_in", bowlDepth: "bowl_depth_in", bowlCount: "bowl_count", ratedGpm: "rated_gpm" } as const;

/** Share of a bowl's volume that drains (a full bowl isn't filled to the rim). */
export const GREASE_FILL_SHARE = 0.75;

export function greaseInterceptorSpec(model: Pick<ModelState, "elements">, request: CalcSheetBuildRequest): CalcSheetSpec | { readonly refused: string } {
  const sinkId = request.subjectId;
  if (!sinkId) return { refused: "Pick the sink this sheet sizes the interceptor for" };
  if (model.elements[sinkId]?.kind !== "part") return { refused: "Grease interceptor sizing needs a sink: pick the sink that drains to it" };
  const interceptor = request.options?.interceptorId;
  const interceptorId = typeof interceptor === "string" && interceptor !== "" ? (interceptor as ElementId) : undefined;
  const sink = (name: string) => ({ from: "field" as const, subjectId: sinkId, path: `param.${name}` });
  const P = GREASE_SHEET_PARAMS;
  return {
    template: GREASE_INTERCEPTOR_TEMPLATE_ID,
    title: "Grease interceptor sizing",
    inputs: [
      { key: "length", label: "Bowl length", unit: "in", bind: sink(P.bowlLength) },
      { key: "width", label: "Bowl width", unit: "in", bind: sink(P.bowlWidth) },
      { key: "depth", label: "Bowl depth", unit: "in", bind: sink(P.bowlDepth) },
      { key: "count", label: "Bowls", unit: "ea", bind: sink(P.bowlCount) },
      { key: "fill", label: "Share of the bowl that drains", unit: "1", bind: { from: "typed", value: GREASE_FILL_SHARE } },
      { key: "rated", label: "Interceptor rated flow", unit: "gpm", bind: { from: "field", ...(interceptorId ? { subjectId: interceptorId } : {}), path: `param.${P.ratedGpm}` } },
    ],
    lookups: [],
    steps: [
      { key: "volume", label: "Bowl volume", formula: "{length} * {width} * {depth} * {count}", unit: "in3" },
      { key: "gallons", label: "Water that drains", formula: "{volume} / 231 * {fill}", unit: "gal" },
      { key: "gpm_1", label: "Flow at a 1-minute drain", formula: "{gallons} / 1", unit: "gpm" },
      { key: "gpm_2", label: "Flow at a 2-minute drain", formula: "{gallons} / 2", unit: "gpm" },
      { key: "passes", label: "Interceptor covers the 2-minute flow (1 yes, 0 no)", formula: "{rated} >= {gpm_2}", unit: "1" },
    ],
    checks: [],
    citations: [{ section: "Fixture drain-down method", note: "231 cubic inches to the gallon; three quarters of the bowl drains. Common design practice; firm to confirm." }],
    result: { key: "passes", label: "Interceptor size passes (1 yes, 0 no)" },
  };
}

export const GREASE_INTERCEPTOR_TEMPLATE: CalcSheetTemplateRow = {
  id: GREASE_INTERCEPTOR_TEMPLATE_ID,
  label: "Grease interceptor",
  discipline: "plumbing",
  subjectKinds: ["part"],
  build: (model, request) => greaseInterceptorSpec(model, request),
};
