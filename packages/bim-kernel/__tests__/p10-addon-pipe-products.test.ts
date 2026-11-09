/**
 * @jest-environment node
 *
 * Round 10 lane P10: another firm's add-on brings its own pipe catalogue
 * with zero kernel edits (`fixtures/p10-test-addon.ts`: a material, a
 * grooved end type and a product on `PIPE_PRODUCT_POINT`). Its pipe sizes,
 * draws at its own outside diameter, takes fittings made with its own joint
 * (kept by end type, since no family offers it by a stored name), draws that
 * joint's hub, and routes with no joint issue.
 *
 * Fails on round 9's code: there is no `PIPE_PRODUCT_POINT`, the kernel's
 * own table knew only its fifteen products, and a joint had to be one of the
 * kernel's ten names.
 */
import {
  DEFAULT_SETTINGS,
  PIPE_PRODUCT_POINT,
  commandSchema,
  connectorEndTypeTable,
  drawnWidth,
  fittingBody,
  fittingFamily,
  jointIssue,
  pipeDims,
  pipeJointEndType,
  pipeParams,
  pipeProductRowProblems,
  pipeSizeIssue,
  planCommit,
  resolveParams,
  specOfSize,
  validateModel,
  withUpgradePolicy,
  type ElementId,
  type ModelState,
  type RunFitting,
} from "../src";
import { bindModelPacks, unbindModelPacks, withPackSet } from "../src/packs";
import { FP_GROOVED, FP_PRODUCT, FP_SET, fpSize } from "./fixtures/p10-test-addon";

const MODEL_ID = "p10-addon";
let seq = 0;

function commit(head: ModelState, command: unknown): ModelState {
  seq += 1;
  const parsed = commandSchema.parse(command);
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `p10-addon-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p10", name: "P10", kind: "human" }, command: parsed }, () => "2026-11-01T23:00:00.000Z"));
  if (!d.ok) throw new Error(`${parsed.type}: ${d.error.message}`);
  return d.model;
}

function elbow(): NonNullable<ReturnType<typeof fittingFamily>> {
  const f = fittingFamily("pipe.water.elbow_90");
  if (!f) throw new Error("pipe.water.elbow_90");
  return f;
}

describe("p10-addon-pipe-products", () => {
  beforeAll(() => bindModelPacks(MODEL_ID, FP_SET));
  afterAll(() => unbindModelPacks(MODEL_ID));

  it("the add-on's rows pass conformance against the set's end types, and the kernel ships no product of its own", () => {
    expect(PIPE_PRODUCT_POINT.builtins).toBeUndefined();
    const ids = new Set(withPackSet(FP_SET, () => connectorEndTypeTable().ids));
    expect(pipeProductRowProblems([FP_PRODUCT], ids)).toEqual([]);
    expect(pipeProductRowProblems([{ ...FP_PRODUCT, endTypes: ["testfp.welded"], defaultEndType: "testfp.welded", hubs: {} }], ids)).toEqual(["CPVC fire pipe, SDR 13.5 names the joint testfp.welded, which no add-on here declares as an end type"]);
  });

  it("sizes: the add-on's product, its outside and inside diameters, its sizes", () => {
    withPackSet(FP_SET, () => {
      expect(specOfSize(fpSize(2))?.id).toBe("testfp.cpvc_fire_sdr13_5");
      expect(pipeDims(fpSize(2))).toEqual({ odMm: 60.3, idMm: 51.36, listed: true });
      expect(drawnWidth(fpSize(2))).toBe(60.3);
      expect(specOfSize(fpSize(2))?.hazenWilliamsC).toBe(150);
      expect(drawnWidth(fpSize(2))).toBe(60.3);
      expect(specOfSize(fpSize(2))?.hazenWilliamsC).toBe(150);
      expect(pipeSizeIssue(fpSize(2))).toBeNull();
      expect(pipeSizeIssue(fpSize(1.5))).toBe('CPVC fire pipe, SDR 13.5 isn\'t made in 1.5"; sizes are 1", 2", 3"');
    });
  });

  it("joins: a water elbow on it keeps the add-on's grooved joint by end type, and a sweat joint is named for what it is", () => {
    withPackSet(FP_SET, () => {
      const params = resolveParams(elbow(), pipeParams(elbow(), fpSize(2), undefined));
      expect(params.end_type).toBe(FP_GROOVED);
      expect(pipeJointEndType(params)).toBe(FP_GROOVED);
      expect(jointIssue(elbow(), params, fpSize(2))).toBeNull();
      expect(jointIssue(elbow(), { joint: "sweat" }, fpSize(2))).toBe("Sweat (soldered) joints aren't made for CPVC fire pipe, SDR 13.5; use grooved coupling");
      expect(connectorEndTypeTable().join(FP_GROOVED, "plumbing_gas.threaded")).toEqual({ kind: "via", fitting: "grooved-to-thread adapter" });
    });
  });

  it("draws: the elbow's hubs are the add-on's grooved hub", () => {
    withPackSet(FP_SET, () => {
      const size = fpSize(2);
      const f: RunFitting = {
        id: "e" as ElementId, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: "elbow", label: "90° elbow", domain: "pipe", systemId: "sys" as ElementId, levelId: "lvl" as ElementId, position: { x: 0, y: 0, z: 0 }, angleDeg: 90,
        ports: [{ id: "a", position: { x: 0, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, size }, { id: "b", position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, size }],
        family: elbow().id, params: resolveParams(elbow(), pipeParams(elbow(), size, undefined)),
      };
      const hub = fittingBody({}, f).tubes[1]?.rings[0];
      if (!hub) throw new Error("no hub ring");
      expect(Math.hypot(hub.a.x, hub.a.y, hub.a.z) * 2).toBeCloseTo(60.3 * 1.5, 6);
    });
  });

  it("routes: a run of the add-on's pipe gets elbows made with its joint, and the model has no joint issue", () => {
    let m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m = commit(m, { type: "route_run", idPrefix: "fp", levelId: "lvl-1", domain: "pipe", size: fpSize(2), elevationMm: 3000, system: { id: "sys-fp", kind: "domestic_cold_water", name: "Fire water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }] });
    const elbows = Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
    expect(elbows.length).toBe(1);
    expect(elbows[0]?.params).toMatchObject({ end_type: FP_GROOVED });
    const issues = withPackSet(FP_SET, () => validateModel(m));
    expect(issues.filter((i) => i.code === "profile_incompatible")).toEqual([]);
    expect(Object.values(m.elements).filter((e) => e.kind === "run_segment").every((e) => e.kind === "run_segment" && e.size.shape === "pipe" && e.size.materialId === "testfp.cpvc_fire")).toBe(true);
  });
});
