/**
 * @jest-environment node
 *
 * Copper water turns 22½° where a real fitting exists: wrought copper 22½°
 * elbows (sweat or press) are made 1/2" to 4". Other water pipe, and copper
 * outside those sizes, still turns 45° and 90°; copper still has no 60° turn.
 *
 * Fails on the old code: no water family turned 22½°, so a 22½° copper turn
 * was refused.
 */
import { DEFAULT_SETTINGS, pipeTurnAngles, planCommit, runSlopeAngles, type Command, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK } from "../src";

const FT = 304.8;
const IN = 25.4;
let n = 0;

function plan(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `s4b-water-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-11-07T00:00:00.000Z");
}

function empty(): ModelState {
  const m: ModelState = { modelId: "s4b-water", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const d = plan(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const copper = (inches: number) => ({ shape: "pipe", nominalMm: inches * IN, material: "copper" }) as const;
const PEX1 = { shape: "pipe", nominalMm: 1 * IN, material: "pex" } as const;
const CW = { id: "sys-cw", kind: "domestic_cold_water", name: "Cold Water" } as const;

function turn(deg: number) {
  const r = (deg * Math.PI) / 180;
  return [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT + Math.cos(r) * 10 * FT, y: Math.sin(r) * 10 * FT }];
}

describe("s4b: copper water 22½° elbows from family data", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("copper 1/2\" to 4\" turns 22½°; 6\" copper and PEX don't", () => {
    expect(pipeTurnAngles("domestic_cold_water", copper(0.5))).toEqual([22.5, 45, 90]);
    expect(pipeTurnAngles("domestic_cold_water", copper(4))).toEqual([22.5, 45, 90]);
    expect(pipeTurnAngles("domestic_cold_water", copper(6))).toEqual([45, 90]);
    expect(pipeTurnAngles("domestic_cold_water", PEX1)).toEqual([45, 90]);
    expect(runSlopeAngles("pipe", "domestic_cold_water", copper(1))).toEqual([22.5, 45]);
  });

  it("a 22½° turn on 1\" copper is drawn with the 22½° elbow", () => {
    const d = plan(empty(), { type: "route_run", idPrefix: "w", levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: 9 * FT, system: CW, points: turn(22.5) });
    if (!d.ok) throw new Error(d.error.message);
    const elbows = Object.values(d.model.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
    expect(elbows.map((e) => [e.angleDeg, e.family])).toEqual([[22.5, "pipe.water.elbow_22"]]);
  });

  it("copper still can't rise on a 60° slope, and the refusal names the slopes it can", () => {
    const points = [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 11 * FT }, { x: 20 * FT, y: 0 }];
    const d = plan(empty(), { type: "route_run", idPrefix: "w", levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: 9 * FT, system: CW, riseStyle: "60", points });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toMatch(/can't rise or drop on a 60° slope; it slopes at 22½° or 45°/);
  });
});
