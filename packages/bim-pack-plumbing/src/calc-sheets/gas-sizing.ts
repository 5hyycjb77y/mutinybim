import { pipeSegmentOf, type ModelState } from "@permitzip/bim-kernel";
import type { CalcSheetBuildRequest, CalcSheetEvaluation, CalcSheetSpec, CalcSheetTemplateRow } from "@permitzip/bim-kernel/calc-sheets";

/**
 * Gas pipe sizing as a live sheet (round 12 P12, ROADMAP P2). The longest
 * length method: the sizing length is the longest developed run of the
 * pipe's pressure zone, the load is the flow the pipe carries in CFH, and
 * the firm's or project's sizing table (a library table item; the add-on
 * ships no table text) is read across the length row to the first size
 * whose capacity covers the load. That cell is marked; shortening the run
 * moves it. The margin over the load is checked against the firm's main
 * margin (`plumbing_gas.gas_main_margin`), so "1 in passes capacity but fails
 * the firm's margin" reads on the sheet. The meter note is written from the
 * same numbers (`gasMeterNote`).
 */

export const GAS_SIZING_TEMPLATE_ID = "gas_sizing";
/** The library table slot the sheet reads unless a request names another (`options.table`). */
export const GAS_SIZING_TABLE_SLOT = "gas_sizing_table";

function tableSlot(request: CalcSheetBuildRequest): string {
  const t = request.options?.table;
  return typeof t === "string" && t.trim() !== "" ? t : GAS_SIZING_TABLE_SLOT;
}

export function gasSizingSpec(model: Pick<ModelState, "elements">, request: CalcSheetBuildRequest): CalcSheetSpec | { readonly refused: string } {
  const id = request.subjectId;
  if (!id) return { refused: "Pick the gas pipe this sheet sizes" };
  const seg = pipeSegmentOf(model.elements, id);
  const system = seg ? model.elements[seg.systemId] : undefined;
  if (!seg || system?.kind !== "mep_system" || system.systemKind !== "natural_gas") return { refused: "Gas sizing needs a gas pipe: pick a piece of a gas system" };
  const field = (path: string) => ({ from: "field" as const, subjectId: seg.id, path });
  return {
    template: GAS_SIZING_TEMPLATE_ID,
    title: `Gas pipe sizing, ${system.name}`,
    inputs: [
      { key: "length", label: "Sizing length (longest run in this pressure zone)", unit: "ft", bind: field("gas.zone_longest") },
      { key: "load", label: "Gas flow this pipe carries", unit: "cfh", bind: field("gas.carries_cfh") },
      { key: "heating_value", label: "Heating value", unit: "Btu/ft3", bind: field("gas.heating_value") },
      { key: "inlet", label: "Pressure at the start of the zone", unit: "in_wc", bind: field("gas.zone") },
    ],
    lookups: [
      {
        key: "capacity",
        label: "Capacity of the size the table picks",
        table: { slot: tableSlot(request) },
        row: { input: "length", match: "next_up" },
        column: { input: "load", match: "next_up", by: "value" },
        unit: "cfh",
      },
    ],
    steps: [
      { key: "size", label: "Pipe size", formula: "{capacity_column}", unit: "in" },
      { key: "margin", label: "Capacity over the load", formula: "({capacity} - {load}) / {load} * 100", unit: "%" },
      { key: "load_mbh", label: "Gas input this pipe carries", formula: "{load} * {heating_value} / 1000", unit: "MBH" },
    ],
    checks: [{ key: "margin_check", label: "Main margin", value: "margin", limit: { quantity: "ratio", system: "natural_gas" } }],
    citations: [{ section: "Longest length method", note: "Every piece sized on the longest developed length in its pressure zone, from the table the firm keeps in its library." }],
    result: { key: "size", label: "Pipe size (in)" },
  };
}

/** The meter note, from the sheet's own numbers: "Gas meter: 1,950 CFH (1,950 MBH) at 7 in. w.c." Null until the sheet has worked out. */
export function gasMeterNote(evaluation: Pick<CalcSheetEvaluation, "values">): string | null {
  const { load, load_mbh: mbh, inlet } = evaluation.values;
  if (load === null || load === undefined || mbh === null || mbh === undefined || inlet === null || inlet === undefined) return null;
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  return `Gas meter: ${n(load)} CFH (${n(mbh)} MBH) at ${Math.round(inlet * 100) / 100} in. w.c.`;
}

export const GAS_SIZING_TEMPLATE: CalcSheetTemplateRow = {
  id: GAS_SIZING_TEMPLATE_ID,
  label: "Gas sizing",
  discipline: "plumbing",
  subjectKinds: ["run_segment"],
  build: (model, request) => gasSizingSpec(model, request),
};
