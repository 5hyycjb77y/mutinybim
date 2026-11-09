/**
 * @jest-environment node
 *
 * Plumbing follow-ups (Nov 7): a pipe turns, slopes and heads at the angles
 * its elbow families are made for. PVC DWV has 1/16 (22½°), 1/8 (45°),
 * 1/6 (60°) and 1/4 (90°) bends; copper water elbows are 45° and 90°.
 *
 * Fails on the old code: the kernel hard-coded pipe to 45° / 90° turns and
 * 45° plan headings, so a 60° or 22½° turn on DWV was refused, there was no
 * 1/6 bend, and a rise could only be straight or at 45°.
 */
import { DEFAULT_SETTINGS, pipeTurnAngles, planCommit, type Command, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK } from "../src";
import { BUILTIN_PIPE_TYPES, type PipeTypeEntry } from "../src/routing/pipe/pipe-types";
import { pipeTypeBendAngles } from "../src/routing/pipe/system-pipe-type";

const FT = 304.8;
const IN = 25.4;
let n = 0;

function plan(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `turn-angles-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-11-07T00:00:00.000Z");
}

function commit(model: ModelState, command: Command): ModelState {
  const d = plan(model, command);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function refusal(model: ModelState, command: Command): string {
  const d = plan(model, command);
  if (d.ok) throw new Error(`${command.type} was expected to be refused`);
  return d.error.message;
}

function empty(): ModelState {
  const m: ModelState = { modelId: "turn-angles", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

const PVC3 = { shape: "pipe", nominalMm: 3 * IN, material: "pvc" } as const;
const PVC2 = { shape: "pipe", nominalMm: 2 * IN, material: "pvc" } as const;
const CU1 = { shape: "pipe", nominalMm: 1 * IN, material: "copper" } as const;
const SAN = { id: "sys-san", kind: "sanitary", name: "Sanitary" } as const;
const VENT = { id: "sys-vent", kind: "vent", name: "Vent" } as const;
const CW = { id: "sys-cw", kind: "domestic_cold_water", name: "Cold Water" } as const;

/** Three points: east 10 ft, then 10 ft at `deg` from east. */
function turnPoints(deg: number) {
  const r = (deg * Math.PI) / 180;
  return [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT + Math.cos(r) * 10 * FT, y: Math.sin(r) * 10 * FT }];
}

const elbows = (m: ModelState): RunFitting[] => Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");

describe("pipe turn angles come from the fitting families", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("PVC drainage turns 22½°, 45°, 60° and 90°; copper water 45° and 90°", () => {
    expect(pipeTurnAngles("sanitary", PVC3)).toEqual([22.5, 45, 60, 90]);
    expect(pipeTurnAngles("domestic_cold_water", CU1)).toEqual([22.5, 45, 90]);
    const pvc = BUILTIN_PIPE_TYPES.find((t) => t.name === "SAN-PVC") as PipeTypeEntry;
    expect(pipeTypeBendAngles(pvc, "sanitary")).toEqual([22.5, 45, 60, 90]);
  });

  it("a 60° turn on a PVC drain is drawn with a 1/6 bend", () => {
    const m = commit(empty(), { type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: PVC3, elevationMm: -2 * FT, system: SAN, points: turnPoints(60) });
    const e = elbows(m);
    expect(e).toHaveLength(1);
    expect(e[0]?.angleDeg).toBe(60);
    expect(e[0]?.family).toBe("dwv.sixth_bend");
  });

  it("a 22½° turn on a PVC drain is drawn with a 1/16 bend", () => {
    const m = commit(empty(), { type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: PVC3, elevationMm: -2 * FT, system: SAN, points: turnPoints(22.5) });
    const e = elbows(m);
    expect(e[0]?.angleDeg).toBe(22.5);
    expect(e[0]?.family).toBe("dwv.sixteenth_bend");
  });

  it("45° and 90° turns on PVC drain keep their usual bends", () => {
    const m = commit(empty(), { type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: PVC3, elevationMm: -2 * FT, system: SAN, points: turnPoints(45) });
    expect(elbows(m)[0]?.family).toBe("dwv.eighth_bend");
  });

  it("a 60° turn on copper water is still refused, in plain words", () => {
    const why = refusal(empty(), { type: "route_run", idPrefix: "w", levelId: "lvl-1", domain: "pipe", size: CU1, elevationMm: 9 * FT, system: CW, points: turnPoints(60) });
    expect(why).toMatch(/60°/);
    expect(why).toMatch(/45°/);
  });

  it("a PVC vent rises on a 60° slope with two 1/6 bends; copper water can't", () => {
    const points = [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 11 * FT }, { x: 20 * FT, y: 0 }];
    const m = commit(empty(), { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "pipe", size: PVC2, elevationMm: 9 * FT, system: VENT, riseStyle: "60", points });
    const e = elbows(m);
    expect(e.map((f) => f.angleDeg)).toEqual([60, 60]);
    expect(e.every((f) => f.family === "dwv.sixth_bend")).toBe(true);
    const why = refusal(empty(), { type: "route_run", idPrefix: "w", levelId: "lvl-1", domain: "pipe", size: CU1, elevationMm: 9 * FT, system: CW, riseStyle: "60", points });
    expect(why).toMatch(/can't rise or drop on a 60° slope/);
  });
});
