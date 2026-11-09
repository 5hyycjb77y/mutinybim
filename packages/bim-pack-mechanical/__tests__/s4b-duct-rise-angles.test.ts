/**
 * @jest-environment node
 *
 * Duct rises on the slopes its elbow families are made for. Radius and gored
 * duct elbows are made to any angle, so a duct rises straight, or on a 60°,
 * 45° or 22½° slope; the kernel reads that from the families, not a list.
 *
 * Fails on the old code: the kernel let a duct rise only straight or at 45°.
 */
import { DEFAULT_SETTINGS, planCommit, runSlopeAngles, type Command, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK } from "../src";

const FT = 304.8;
const IN = 25.4;
let n = 0;

function plan(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `s4b-duct-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-11-07T00:00:00.000Z");
}

function empty(): ModelState {
  const m: ModelState = { modelId: "s4b-duct", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const d = plan(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const ROUND12 = { shape: "round", diameter: 12 * IN } as const;
const SA = { id: "sys-sa", kind: "supply_air", name: "Supply Air" } as const;

function rise(style: "60" | "22.5" | "45") {
  return plan(empty(), {
    type: "route_run",
    idPrefix: "d",
    levelId: "lvl-1",
    domain: "duct",
    size: ROUND12,
    elevationMm: 9 * FT,
    system: SA,
    riseStyle: style,
    points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 11 * FT }, { x: 30 * FT, y: 0 }],
  });
}

describe("s4b: duct rises at 60° and 22½° from its elbow families", () => {
  beforeAll(() => installFirstPartyPacks([MECHANICAL_PACK]));

  it("duct elbows made to any angle allow 22½°, 45° and 60° slopes", () => {
    expect(runSlopeAngles("duct", "supply_air", ROUND12)).toEqual([22.5, 45, 60]);
  });

  it.each([["45", 45], ["60", 60], ["22.5", 22.5]] as const)("a round supply duct rises on a %s° slope with two elbows of that angle", (style, deg) => {
    const d = rise(style);
    if (!d.ok) throw new Error(d.error.message);
    const elbows = Object.values(d.model.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
    expect(elbows.map((e) => e.angleDeg)).toEqual([deg, deg]);
  });
});
