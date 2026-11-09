/**
 * @jest-environment node
 *
 * Round 10 lane P10: a model routed with another firm's pipe add-on, opened
 * where that add-on isn't on. Nothing is dropped or rewritten: every piece
 * keeps its material id and every fitting its joint by end type, the pipe
 * still draws (at its built-in fallback's dimensions, as a pack material
 * always did), and the joint reads as an ordinary issue naming the add-on
 * that supplies it.
 *
 * Fails on round 9's code: a joint kept by end type had nowhere to live (the
 * fitting's parameters refused it) and nothing named the add-on.
 */
import { DEFAULT_SETTINGS, commandSchema, pipeDims, planCommit, validateModel, withUpgradePolicy, type BimElement, type ModelState } from "../src";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { pipeReadings } from "./fixtures/p10-pipe-readings";
import { FP_SET, fpSize } from "./fixtures/p10-test-addon";

const MODEL_ID = "p10-unknown";
let seq = 0;

function commit(head: ModelState, command: unknown): ModelState {
  seq += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `p10-unknown-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p10", name: "P10", kind: "human" }, command: commandSchema.parse(command) }, () => "2026-11-01T23:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

describe("p10-unknown-product-kept", () => {
  it("opens without the add-on: records as stored, the pipe drawn, the joint an issue that names the add-on", () => {
    bindModelPacks(MODEL_ID, FP_SET);
    let m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m = commit(m, { type: "route_run", idPrefix: "fp", levelId: "lvl-1", domain: "pipe", size: fpSize(2), elevationMm: 3000, system: { id: "sys-fp", kind: "domestic_cold_water", name: "Fire water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }] });
    unbindModelPacks(MODEL_ID);

    const stored: Readonly<Record<string, BimElement>> = JSON.parse(JSON.stringify(m.elements)) as Record<string, BimElement>;
    const reading = pipeReadings(m);
    expect(JSON.parse(JSON.stringify(m.elements))).toEqual(stored);
    const elbow = Object.values(m.elements).find((e) => e.kind === "run_fitting" && e.fittingType === "elbow");
    expect(elbow?.kind === "run_fitting" ? elbow.params : null).toMatchObject({ end_type: "testfp.grooved" });
    // The add-on's material falls back to CPVC's own table, as a pack material always did.
    expect(pipeDims(fpSize(2))).toEqual({ odMm: 53.975, idMm: 44.161, listed: true });
    expect(reading.issues.filter((i) => i.startsWith("profile_incompatible"))).toEqual([`profile_incompatible ${elbow?.id ?? "?"} This fitting's joint (testfp.grooved) comes from the testfp add-on, which isn't on for this model. It is kept as stored, but nothing checks it until that add-on is turned on`]);
    expect(validateModel(m).length).toBe(reading.issues.length);
  });
});
