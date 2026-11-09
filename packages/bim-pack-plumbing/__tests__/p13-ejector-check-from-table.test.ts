/**
 * @jest-environment node
 *
 * Round 13 lane P13: the ejector check turns the drainage units it serves into
 * a flow through the firm's own DFU → gpm `lookup_table` (library item, with
 * its source), read through `lookupTable` on `@permitzip/bim-kernel/policy`:
 * the project's table over the firm's, the first row at or above the units.
 * The add-on ships no table.
 *
 * Fails on round 12's code: the check read only a calc-sheet table slot; a
 * `lookup_table` library item had no reader (`sewagePumpFlowCheckFromLookup`
 * and `DFU_TO_GPM_TABLE_SLOT` didn't exist).
 */
import type { LookupTable } from "@permitzip/bim-kernel/policy";
import { DFU_TO_GPM_TABLE_SLOT, sewagePumpFlowCheckFromLookup } from "../src";
import { asElementId } from "@permitzip/bim-kernel";
import { SewerSite } from "./p13-fixtures";

const EP_1 = asElementId("ep-1");

const table = (id: string, rows: number[][], source: string): LookupTable => ({
  id,
  slot: DFU_TO_GPM_TABLE_SLOT,
  name: "Firm ejector flow table",
  columns: [
    { key: "dfu", label: "Drainage units", unit: "DFU" },
    { key: "gpm", label: "Flow", unit: "gpm" },
  ],
  rows,
  citation: { source, section: "Table 3" },
});

function pumped(): SewerSite {
  const s = new SewerSite();
  s.pump("ep-1", "EP-1", { pump_rated_gpm: 45, pump_rated_head_ft: 22, pump_head_ft: 22 });
  s.drains("b1", "lvl-b", 6, 9, "ep-1");
  return s;
}

describe("p13-ejector-check-from-table", () => {
  it("54 DFU reads 38 gpm from the firm's table, with its source; EP-1's 45 gpm at 22 ft passes", () => {
    const s = pumped();
    const r = sewagePumpFlowCheckFromLookup(s.head.elements, EP_1, { firm: [table("firm-1", [[20, 25], [60, 38], [100, 50]], "Firm design guide")] });
    expect(r).toMatchObject({ kind: "checked", dfu: 54, inflowGpm: 38, from: { kind: "table", table: "Firm ejector flow table", source: "Firm design guide Table 3", rowDfu: 60 } });
    expect(r?.message).toBe("Inflow 38 gpm (54 drainage units, Firm ejector flow table, Firm design guide Table 3) against EP-1's 45 gpm at 22 ft: passes");
  });

  it("the project's table wins over the firm's; a pump too small for it says so", () => {
    const s = pumped();
    const r = sewagePumpFlowCheckFromLookup(s.head.elements, EP_1, { project: [table("proj-1", [[60, 52]], "Project basis of design")], firm: [table("firm-1", [[60, 38]], "Firm design guide")] });
    expect(r?.kind === "checked" ? [r.inflowGpm, r.verdict.kind] : null).toEqual([52, "undersized"]);
  });

  it("a table that stops below the units served says so instead of reading past its end", () => {
    const s = pumped();
    const r = sewagePumpFlowCheckFromLookup(s.head.elements, EP_1, { firm: [table("firm-1", [[20, 25]], "Firm design guide")] });
    expect(r).toMatchObject({ kind: "needs_table", message: "Can't check this pump yet: Firm ejector flow table stops below 54 drainage units" });
  });
});
