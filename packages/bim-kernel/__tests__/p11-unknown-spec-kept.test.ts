/**
 * @jest-environment node
 *
 * Round 13 lane P13 (P12 open item 2): a pipe size may name any add-on
 * product's spec by id. Readers keep a spec no add-on here makes, byte for
 * byte, and say it in its own words; an edit that doesn't change it never
 * refuses it, even on a peer that reads nothing new.
 *
 * Fails on round 12's code: `spec` was the closed `PIPE_SPEC_IDS` enum, so
 * a stored `sdr13_5` or `zz.class_52` size didn't parse at all.
 */
import { DEFAULT_SETTINGS, commandSchema, pipeSpecLabel, planCommit, runSizeSchema, withUpgradePolicy, type ModelState, type RunSegment, type UpgradePolicy } from "../src";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { FP_SET, IN, fpSize } from "./fixtures/p10-test-addon";

const MODEL_ID = "p11-unknown-spec";
let seq = 0;

function plan(head: ModelState, command: unknown, policy: UpgradePolicy) {
  seq += 1;
  const parsed = commandSchema.parse(command);
  return withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `p11-spec-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p11", name: "P11", kind: "human" }, command: parsed }, () => "2026-11-04T08:00:00.000Z"));
}

function level(): ModelState {
  const m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const d = plan(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }, () => true);
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const route = (size: unknown) => ({ type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "pipe", size, elevationMm: 3000, system: { id: "sys-1", kind: "domestic_cold_water", name: "Cold water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }] });

describe("p11-unknown-spec-kept", () => {
  beforeAll(() => bindModelPacks(MODEL_ID, FP_SET));
  afterAll(() => unbindModelPacks(MODEL_ID));

  it("a pipe size naming an add-on's spec, or one nobody here makes, parses and keeps its spec", () => {
    for (const spec of ["sdr13_5", "zz.class_52", "type_l"]) {
      const size = { shape: "pipe", nominalMm: 2 * IN, material: "cpvc", spec };
      expect(runSizeSchema.parse(size)).toEqual(size);
    }
    expect(() => runSizeSchema.parse({ shape: "pipe", nominalMm: 2 * IN, material: "cpvc", spec: "Not An Id" })).toThrow();
  });

  it("a spec nobody here makes reads in its own words", () => {
    expect(pipeSpecLabel("zz_class_52")).toBe("zz class 52");
  });

  it("moving a run that already stores an add-on spec keeps it on a peer that reads nothing new", () => {
    const routed = plan(level(), route({ ...fpSize(2), spec: "sdr13_5" }), () => true);
    if (!routed.ok) throw new Error(routed.error.message);
    const seg = Object.values(routed.model.elements).find((e): e is RunSegment => e.kind === "run_segment");
    if (!seg) throw new Error("no segment routed");
    const moved = plan(routed.model, { type: "move_elements", ids: [seg.id], delta: { x: 0, y: 300 } }, () => false);
    if (!moved.ok) throw new Error(moved.error.message);
    const after = moved.model.elements[seg.id];
    expect(after?.kind === "run_segment" ? after.size : null).toEqual(seg.size);
  });
});
