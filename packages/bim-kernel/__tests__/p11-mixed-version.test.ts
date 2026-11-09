/**
 * @jest-environment node
 *
 * Round 13 lane P13 (P12 open item 2): writers are strict. A pipe size that
 * newly names an add-on product's spec is written only when every peer
 * advertises `pipes:open_specs`; until then it is refused in the
 * older-server words and nothing changes. The built-in spec names write on
 * any peer, exactly as before.
 *
 * Fails on round 12's code: the add-on spec didn't parse (closed enum), and
 * neither `pipeSpecWriteRefusal` nor the gate existed.
 */
import { DEFAULT_SETTINGS, PIPES_OPEN_SPECS_FEATURE, commandSchema, pipeSpecStorable, pipeSpecWriteRefusal, planCommit, withUpgradePolicy, type ModelState, type RunSegment, type UpgradePolicy } from "../src";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { FP_SET, IN, fpSize } from "./fixtures/p10-test-addon";

const MODEL_ID = "p11-mixed";
let seq = 0;

function plan(head: ModelState, command: unknown, policy: UpgradePolicy) {
  seq += 1;
  const parsed = commandSchema.parse(command);
  return withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `p11-mixed-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p11", name: "P11", kind: "human" }, command: parsed }, () => "2026-11-04T08:00:00.000Z"));
}

function level(): ModelState {
  const m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const d = plan(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }, () => true);
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const route = (size: unknown) => ({ type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "pipe", size, elevationMm: 3000, system: { id: "sys-1", kind: "domestic_cold_water", name: "Cold water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }] });
const allButOpenSpecs: UpgradePolicy = (f) => f !== PIPES_OPEN_SPECS_FEATURE;
const segmentsOf = (m: ModelState) => Object.values(m.elements).filter((e): e is RunSegment => e.kind === "run_segment");

describe("p11-mixed-version", () => {
  beforeAll(() => bindModelPacks(MODEL_ID, FP_SET));
  afterAll(() => unbindModelPacks(MODEL_ID));

  it("the feature is the one wave 0 declared", () => {
    expect(PIPES_OPEN_SPECS_FEATURE).toBe("pipes:open_specs");
  });

  it("an add-on spec is refused, in words, while a peer can't store it; written once every peer can", () => {
    const refused = plan(level(), route({ ...fpSize(2), spec: "sdr13_5" }), allButOpenSpecs);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe("SDR 13.5 pipe can't be saved yet: the model server this model is open on is an older version that only stores the built-in pipe specs. Try again once the server is updated. Nothing changed");
    const ok = plan(level(), route({ ...fpSize(2), spec: "sdr13_5" }), () => true);
    if (!ok.ok) throw new Error(ok.error.message);
    expect(segmentsOf(ok.model).map((s) => (s.size.shape === "pipe" ? s.size.spec : null))).toEqual(["sdr13_5", "sdr13_5"]);
  });

  it("a built-in spec writes on a peer that reads nothing new", () => {
    const d = plan(level(), route({ shape: "pipe", nominalMm: 2 * IN, material: "copper", spec: "type_l" }), () => false);
    if (!d.ok) throw new Error(d.error.message);
    expect(segmentsOf(d.model).every((s) => s.size.shape === "pipe" && s.size.spec === "type_l")).toBe(true);
  });

  it("the storable check and the refusal agree outside a command", () => {
    expect(withUpgradePolicy(() => false, () => [pipeSpecStorable("type_l"), pipeSpecStorable("sdr13_5")])).toEqual([true, false]);
    expect(withUpgradePolicy(() => true, () => pipeSpecStorable("sdr13_5"))).toBe(true);
    expect(withUpgradePolicy(() => false, () => pipeSpecWriteRefusal("sdr13_5", "sdr13_5"))).toBeNull();
  });
});
