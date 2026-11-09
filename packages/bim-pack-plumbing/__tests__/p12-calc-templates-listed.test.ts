/**
 * @jest-environment node
 *
 * Round 12 lane P12 step 2: Insert › Calculation lists the Plumbing and gas
 * sheets (S12's dialog lists `calcSheetTemplates()`): Gas sizing, Water
 * pressure loss and Grease interceptor, under Plumbing, each saying what it
 * must be placed for. Their rows pass conformance.
 *
 * Fails on round 11's code: there was no calculation sheet point.
 */
import { calcSheetRowProblems, calcSheetTemplates } from "@permitzip/bim-kernel/calc-sheets";
import { PLUMBING_CALC_SHEET_TEMPLATES } from "../src";

describe("p12-calc-templates-listed", () => {
  it("lists the three plumbing sheets in order, under Plumbing", () => {
    const mine = calcSheetTemplates().filter((t) => t.discipline === "plumbing");
    expect(mine.map((t) => [t.id, t.label, t.subjectKinds])).toEqual([
      ["gas_sizing", "Gas sizing", ["run_segment"]],
      ["water_pressure_loss", "Water pressure loss", ["mep_system", "run_segment"]],
      ["grease_interceptor", "Grease interceptor", ["part"]],
    ]);
    expect(calcSheetRowProblems(PLUMBING_CALC_SHEET_TEMPLATES)).toEqual([]);
  });
});
