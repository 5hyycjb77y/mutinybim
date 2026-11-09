/**
 * @jest-environment node
 *
 * Round 12 lane P12 step 2: water pressure loss as a live sheet, on the drawn
 * 7492 model's cold water (50 psi street, 14.58 psi meter + tap + RPZ,
 * 25 psi at the critical fixture). The sheet's lines come from the add-on's
 * pressure solve, its answer equals the pressure the solve leaves at the
 * most remote fixture, and velocity and friction are checked against the
 * firm's limits (8 ft/s and 10 psi by default).
 *
 * Fails on round 11's code: no calc sheet point, no water pressure loss
 * template, no `water.*` fields.
 */
import { DEFAULT_SETTINGS, planCommit, resolveField, type Command, type ModelState } from "@permitzip/bim-kernel";
import { placeCalcSheet } from "@permitzip/bim-kernel/calc-sheets";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { WATER_PRESSURE_LOSS_TEMPLATE_ID } from "../src";

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `p12w-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "quinn", name: "Quinn", kind: "human" }, command }, () => "2026-11-03T12:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function sampleMarketModel(): ModelState {
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  m = commit(m, sampleMarketLoadPointCommand(build.points));
  return commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { supplyPressurePsi: 50, fixedLossesPsi: 14.58, minFixturePressurePsi: 25 } } });
}

const none = { table: () => null };

describe("p12-water-loss-sheet", () => {
  const m = sampleMarketModel();
  const placed = placeCalcSheet(m, WATER_PRESSURE_LOSS_TEMPLATE_ID, { subjectId: "sys-cw" as never }, { tables: none, limits: {} });
  if ("refused" in placed) throw new Error(placed.refused);
  const v = placed.evaluation.values;

  it("reads street pressure, fixed losses and the fixture's minimum from the system", () => {
    expect([v.supply, v.fixed, v.needed]).toEqual([50, 14.58, 25]);
    expect(placed.evaluation.missing).toEqual([]);
  });

  it("its answer is the pressure the solve leaves at the most remote fixture", () => {
    const residual = resolveField(m.elements, "sys-cw", "water.residual_psi").value;
    if (typeof residual !== "number" || v.available === null || v.available === undefined) throw new Error("no residual");
    expect(Math.abs(v.available - residual)).toBeLessThan(0.02);
    expect(v.passes).toBe(v.available >= 25 ? 1 : 0);
  });

  it("checks velocity and friction against the firm's cold water limits", () => {
    const byKey = Object.fromEntries(placed.evaluation.checks.map((c) => [c.key, c]));
    expect(byKey.velocity_check?.limitId).toBe("plumbing_gas.cold_water_velocity");
    expect(byKey.friction_check?.limitId).toBe("plumbing_gas.water_pressure_loss");
    expect(byKey.velocity_check?.pass).toBe((v.velocity ?? Infinity) <= 8);
    expect(byKey.friction_check?.pass).toBe((v.friction ?? Infinity) <= 10);
  });

  it("refuses a system that isn't water, in words", () => {
    expect(placeCalcSheet(m, WATER_PRESSURE_LOSS_TEMPLATE_ID, { subjectId: "sys-san" as never }, { tables: none, limits: {} })).toEqual({ refused: "Water pressure loss needs a domestic water system: pick the system or one of its pipes" });
  });
});
