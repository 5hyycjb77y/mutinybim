/**
 * @jest-environment node
 *
 * Round 10 lane P10: a peer without `pipes:addon_products` (an older model
 * server or page) only ever gets pipe joints in the stored form. The
 * first-party catalogue never needs the new form: its joints keep the stored
 * `joint` name, so routing on an older server writes exactly what it wrote
 * before. A joint kept by end type id (an add-on's product) is refused in the
 * older-server words while a peer can't store it, and a record that already
 * holds one is lowered to its stored name for an older peer when it has one.
 *
 * Fails on round 9's code: the feature, the write refusal and
 * `lowerPipeJointForOlderPeer` don't exist.
 */
import {
  DEFAULT_SETTINGS,
  PIPES_ADDON_PRODUCTS_FEATURE,
  commandSchema,
  lowerPipeJointForOlderPeer,
  planCommit,
  withUpgradePolicy,
  type ElementId,
  type ModelState,
  type RunFitting,
  type UpgradePolicy,
} from "../src";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { FP_SET, IN, fpSize } from "./fixtures/p10-test-addon";

const MODEL_ID = "p10-mixed";
let seq = 0;

function plan(head: ModelState, command: unknown, policy: UpgradePolicy) {
  seq += 1;
  const parsed = commandSchema.parse(command);
  return withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `p10-mixed-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p10", name: "P10", kind: "human" }, command: parsed }, () => "2026-11-01T23:00:00.000Z"));
}

function level(): ModelState {
  const m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const d = plan(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }, () => true);
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const route = (size: unknown) => ({ type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "pipe", size, elevationMm: 3000, system: { id: "sys-1", kind: "domestic_cold_water", name: "Cold water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }] });
const allButPipes: UpgradePolicy = (f) => f !== PIPES_ADDON_PRODUCTS_FEATURE;

describe("p10-mixed-version", () => {
  beforeAll(() => bindModelPacks(MODEL_ID, FP_SET));
  afterAll(() => unbindModelPacks(MODEL_ID));

  it("the feature is the one the protocol advertises", () => {
    expect(PIPES_ADDON_PRODUCTS_FEATURE).toBe("pipes:addon_products");
  });

  it("first-party pipe routes on a server that reads nothing new and keeps the stored joint name only", () => {
    const d = plan(level(), route({ shape: "pipe", nominalMm: 2 * IN, material: "copper" }), () => false);
    if (!d.ok) throw new Error(d.error.message);
    const elbow = Object.values(d.model.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
    expect(elbow?.params).toEqual({ joint: "sweat", r_over_d: 1, takeout_mm: 0 });
  });

  it("an add-on joint kept by end type is refused, in words, while a peer can't store it; written once every peer can", () => {
    const refused = plan(level(), route(fpSize(2)), allButPipes);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe("A 90° elbow, short radius with a grooved coupling joint can't be saved yet: the model server this model is open on is an older version that doesn't store add-on pipe joints. Try again once the server is updated. Nothing changed");
    const ok = plan(level(), route(fpSize(2)), () => true);
    expect(ok.ok).toBe(true);
  });

  it("a stored end-type joint reaches an older peer under its stored name; one with no stored name, and every first-party record, unchanged", () => {
    const base = { id: "f" as ElementId, kind: "run_fitting" as const, version: 1, authoredRev: {}, fittingType: "elbow" as const, label: "Elbow", domain: "pipe" as const, systemId: "s" as ElementId, levelId: "l" as ElementId, position: { x: 0, y: 0, z: 0 }, ports: [] };
    const press: RunFitting = { ...base, family: "pipe.water.elbow_90", params: { end_type: "plumbing_gas.press", r_over_d: 1, takeout_mm: 0 } };
    expect(lowerPipeJointForOlderPeer(press).params).toEqual({ joint: "press", r_over_d: 1, takeout_mm: 0 });
    const grooved: RunFitting = { ...base, family: "pipe.water.elbow_90", params: { end_type: "testfp.grooved", joint: "sweat" } };
    expect(lowerPipeJointForOlderPeer(grooved)).toBe(grooved);
    const stored: RunFitting = { ...base, family: "pipe.water.elbow_90", params: { joint: "sweat" } };
    expect(lowerPipeJointForOlderPeer(stored)).toBe(stored);
  });
});
