/**
 * @jest-environment node
 *
 * Round 13 lane P13 (product decision, round 12 answer): with no flow table set the
 * ejector check says "Can't check this pump yet: add a flow table" and never
 * guesses a flow from drainage units. A table filed under another slot, or at
 * another stage, isn't used.
 *
 * Fails on round 12's code: `sewagePumpFlowCheckFromLookup` didn't exist, so a
 * firm's `lookup_table` couldn't reach the check at all.
 */
import type { LookupTable } from "@permitzip/bim-kernel/policy";
import { DFU_TO_GPM_TABLE_SLOT, PUMP_NEEDS_TABLE, sewagePumpFlowCheckFromLookup } from "../src";
import { asElementId } from "@permitzip/bim-kernel";
import { SewerSite } from "./p13-fixtures";

const EP_1 = asElementId("ep-1");

const other: LookupTable = { id: "t-1", slot: "mechanical.heat_factors", name: "Heat factors", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: [[60, 38]], citation: { source: "Firm" } };
const atCd: LookupTable = { id: "t-2", slot: DFU_TO_GPM_TABLE_SLOT, name: "CD flow table", columns: [{ key: "dfu", label: "DFU" }, { key: "gpm", label: "gpm" }], rows: [[60, 38]], citation: { source: "Firm" }, stages: ["cd"] };

describe("p13-no-table-no-guess", () => {
  it("no table, another slot's table, or one for another stage: can't check, add a flow table", () => {
    const s = new SewerSite();
    s.pump("ep-1", "EP-1", { pump_rated_gpm: 45, pump_rated_head_ft: 22, pump_head_ft: 22 });
    s.drains("b1", "lvl-b", 6, 9, "ep-1");
    for (const sources of [{}, { firm: [other] }, { firm: [atCd] }]) {
      const r = sewagePumpFlowCheckFromLookup(s.head.elements, EP_1, sources, "sd");
      expect(r).toEqual({ kind: "needs_table", pumpId: "ep-1", dfu: 54, message: PUMP_NEEDS_TABLE });
    }
    expect(PUMP_NEEDS_TABLE).toBe("Can't check this pump yet: add a flow table");
  });

  it("a typed inflow is used as typed, with no table", () => {
    const s = new SewerSite();
    s.pump("ep-1", "EP-1", { pump_rated_gpm: 45, pump_rated_head_ft: 22, pump_head_ft: 22, pump_inflow_gpm: 30 });
    s.drains("b1", "lvl-b", 6, 9, "ep-1");
    const r = sewagePumpFlowCheckFromLookup(s.head.elements, EP_1, {});
    expect(r?.kind === "checked" ? [r.inflowGpm, r.from.kind, r.verdict.kind] : null).toEqual([30, "typed", "ok"]);
  });
});
