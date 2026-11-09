import type { BimElement, ElementId } from "@permitzip/bim-kernel";
import type { CalcTable, CalcTableSource } from "@permitzip/bim-kernel/calc-sheets";
import { lookupTable, type LookupTable } from "@permitzip/bim-kernel/policy";
import { pumpAgainstInflow, sewagePumpCheck, type PumpVerdict } from "./gravity";
import { sewagePumpOf } from "./read";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The ejector / grinder pump check against what drains to it (round 12 P12;
 * product decision, Nov 3: decision 7 confirmed as the built default). A typed inflow
 * (gpm) is used as typed. Otherwise drainage units become a flow only
 * through a flow table the firm keeps in its library, with its source shown
 * (`SEWAGE_PUMP_FLOW_TABLE_SLOT`: rows are drainage units, the first column
 * gpm). With no table it says "Can't check this pump yet: add a flow table"
 * and never guesses. The open-source add-on ships no flow table.
 */

export const SEWAGE_PUMP_FLOW_TABLE_SLOT = "sewage_pump_flow_table";
export const PUMP_NEEDS_TABLE = "Can't check this pump yet: add a flow table";

export type PumpFlowCheck =
  | { readonly kind: "needs_table"; readonly pumpId: ElementId; readonly dfu: number; readonly message: string }
  | {
      readonly kind: "checked";
      readonly pumpId: ElementId;
      readonly dfu: number;
      readonly inflowGpm: number;
      /** Where the inflow came from: typed on the pump, or the flow table (its label and source). */
      readonly from: { readonly kind: "typed" } | { readonly kind: "table"; readonly table: string; readonly source: string; readonly rowDfu: number };
      readonly verdict: PumpVerdict;
      readonly message: string;
    };

function tableFlow(table: CalcTable, dfu: number): { readonly gpm: number; readonly rowDfu: number } | null {
  let best = -1;
  table.rows.forEach((r, i) => {
    if (r >= dfu - 1e-9 && (best < 0 || r < (table.rows[best] as number))) best = i;
  });
  const gpm = best < 0 ? null : (table.values[best]?.[0] ?? null);
  return gpm === null || best < 0 ? null : { gpm, rowDfu: table.rows[best] as number };
}

const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

/** The firm library slot the ejector check asks for (`lookup_table`): first column drainage units, second gpm. */
export const DFU_TO_GPM_TABLE_SLOT = "plumbing.dfu_to_gpm";

/** A `lookup_table` (`@permitzip/bim-kernel/policy`) as the check reads it; null when it has no usable rows. */
function flowTableOfLookup(table: LookupTable): CalcTable | null {
  const col = (key: string, at: number) => {
    const i = table.columns.findIndex((c) => c.key === key);
    return i >= 0 ? i : at;
  };
  const dfuCol = col("dfu", 0);
  const gpmCol = col("gpm", 1);
  const rows: number[] = [];
  const values: number[][] = [];
  for (const row of table.rows) {
    const d = row[dfuCol];
    const g = row[gpmCol];
    if (typeof d === "number" && typeof g === "number") {
      rows.push(d);
      values.push([g]);
    }
  }
  if (rows.length === 0) return null;
  const section = table.citation.section ? `${table.citation.source} ${table.citation.section}` : table.citation.source;
  return {
    id: table.id,
    label: table.name,
    rowHeading: { label: "Drainage units", unit: "DFU" },
    columnHeading: { label: "Flow", unit: "gpm" },
    rows,
    columns: ["gpm"],
    values,
    citation: { section, ...(table.citation.edition ? { edition: table.citation.edition } : {}) },
  };
}

/**
 * The ejector check against the firm's (or project's) DFU → gpm `lookup_table`
 * (`lookupTable(DFU_TO_GPM_TABLE_SLOT, stage, sources)`). With none set:
 * "Can't check this pump yet: add a flow table", never a guess.
 */
export function sewagePumpFlowCheckFromLookup(elements: Elements, pumpId: ElementId, sources: { readonly project?: readonly LookupTable[]; readonly firm?: readonly LookupTable[] }, stage?: string): PumpFlowCheck | null {
  const found = lookupTable(DFU_TO_GPM_TABLE_SLOT, stage, sources);
  const table = found ? flowTableOfLookup(found) : null;
  const source: CalcTableSource = { table: (slot) => (slot === SEWAGE_PUMP_FLOW_TABLE_SLOT ? table : null) };
  return sewagePumpFlowCheck(elements, pumpId, source);
}

/** The pump against its inflow (typed, or from the firm's cited flow table). Null when the id isn't a sewage pump. */
export function sewagePumpFlowCheck(elements: Elements, pumpId: ElementId, tables: CalcTableSource): PumpFlowCheck | null {
  const pump = sewagePumpOf(elements, pumpId);
  const base = sewagePumpCheck(elements, pumpId);
  if (!pump || !base) return null;
  const dfu = Math.round(base.dfu * 100) / 100;
  let inflow: number;
  let from: Extract<PumpFlowCheck, { kind: "checked" }>["from"];
  if (pump.inflowGpm !== null) {
    inflow = pump.inflowGpm;
    from = { kind: "typed" };
  } else {
    const table = tables.table(SEWAGE_PUMP_FLOW_TABLE_SLOT);
    if (!table) return { kind: "needs_table", pumpId, dfu, message: PUMP_NEEDS_TABLE };
    const source = table.citation ? `${table.citation.section}${table.citation.edition ? ` (${table.citation.edition})` : ""}` : null;
    if (!source) return { kind: "needs_table", pumpId, dfu, message: `Can't check this pump yet: ${table.label} needs its source` };
    const hit = tableFlow(table, dfu);
    if (!hit) return { kind: "needs_table", pumpId, dfu, message: `Can't check this pump yet: ${table.label} stops below ${n(dfu)} drainage units` };
    inflow = hit.gpm;
    from = { kind: "table", table: table.label, source, rowDfu: hit.rowDfu };
  }
  const verdict = pumpAgainstInflow({ inflowGpm: inflow, headFt: pump.headFt, ratedGpm: pump.ratedGpm, ratedHeadFt: pump.ratedHeadFt });
  const why = from.kind === "typed" ? "typed" : `${n(dfu)} drainage units, ${from.table}, ${from.source}`;
  const message =
    verdict.kind === "ok"
      ? `Inflow ${n(inflow)} gpm (${why}) against ${pump.label}'s ${n(pump.ratedGpm ?? 0)} gpm at ${n(pump.ratedHeadFt ?? 0)} ft: passes`
      : verdict.kind === "undersized"
        ? `Inflow ${n(inflow)} gpm (${why}) against ${pump.label}'s ${n(pump.ratedGpm ?? 0)} gpm at ${n(pump.ratedHeadFt ?? 0)} ft: too small`
        : verdict.kind === "head_unknown"
          ? `Inflow ${n(inflow)} gpm (${why}). Enter the total head ${pump.label} lifts against, in feet`
          : verdict.kind === "rating_unknown"
            ? `Inflow ${n(inflow)} gpm (${why}). Enter ${pump.label}'s rated ${verdict.missing.join(" and ")} from its curve or cut sheet`
            : PUMP_NEEDS_TABLE;
  return { kind: "checked", pumpId, dfu, inflowGpm: inflow, from, verdict, message };
}
