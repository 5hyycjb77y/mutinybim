/**
 * @jest-environment node
 *
 * The "+" on a pipe bend (review video V1, 1:37: "I should have a plus sign… press
 * plus and add… this Y"). Before, `elbow_to_tee` refused any elbow whose
 * openings weren't dead level, so a drain at 1/8" per ft never got one. Now a
 * pitched bend becomes the fitting the drainage direction rules allow, the
 * slope is kept on both legs, and pressure pipe gets a tee.
 */
import { DEFAULT_SETTINGS, ROUTING_TAP_FACES_FEATURE, planCommit, slopeInPerFt, validateModel, withUpgradePolicy, type Command, type ModelState, type RunFitting, type RunSegment, type RunSize } from "../src";

const FT = 304.8;
const IN = 25.4;
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary 1" };
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "DCW 1" };
const PVC4: RunSize = { shape: "pipe", nominalMm: 4 * IN, material: "pvc" };
const PEX1: RunSize = { shape: "pipe", nominalMm: 1 * IN, material: "pex" };

let k = 0;
function submit(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `pt-${++k}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
}
function ok(model: ModelState, command: Command): ModelState {
  const d = submit(model, command);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}
function refused(model: ModelState, command: Command): string {
  const d = submit(model, command);
  if (d.ok) throw new Error(`${command.type} was expected to be refused`);
  return d.error.message;
}
const segs = (m: ModelState) => Object.values(m.elements).filter((e): e is RunSegment => e.kind === "run_segment");
const fits = (m: ModelState) => Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting");

function routed(size: RunSize, system: typeof SAN | typeof CW, points: Array<{ x: number; y: number }>): ModelState {
  let m: ModelState = { modelId: "pt", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = ok(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return ok(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size, elevationMm: -2 * FT, system, points });
}

/** Flow runs p-s1 → p-s2. Running the downstream leg on through the corner makes the upstream leg a branch draining into it. */
function plus(m: ModelState): { model: ModelState; trunkId: string; branchId: string } {
  const bend = fits(m).find((f) => f.fittingType === "elbow");
  const through = bend?.ports.find((p) => p.link?.elementId === "p-s2");
  if (!bend || !through) throw new Error("fixture");
  return { model: ok(m, { type: "elbow_to_tee", fittingId: bend.id, through: through.id, idPrefix: "plus" }), trunkId: "p-s2", branchId: "p-s1" };
}

describe("+ on a pitched drain bend", () => {
  it("a 1/4 bend between two horizontal drains becomes a combination wye & 1/8 bend; both legs keep 1/8\" per ft", () => {
    const m = routed(PVC4, SAN, [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -15 * FT }]);
    expect(fits(m).find((f) => f.fittingType === "elbow")?.ports.some((p) => Math.abs(p.direction.z) > 1e-3)).toBe(true);
    const { model, trunkId, branchId } = plus(m);
    const branchFitting = fits(model).find((f) => f.host?.segmentId === trunkId);
    expect(branchFitting?.family).toBe("dwv.combo_wye_eighth");
    for (const s of segs(model)) expect(slopeInPerFt(s)).toBeGreaterThanOrEqual(0.125 - 1e-3);
    const branch = model.elements[branchId];
    expect(branch?.kind === "run_segment" && (branch.links.start || branch.links.end)).toBeTruthy();
    expect(validateModel(model)).toEqual([]);
  });

  // A 45° wye needs route_run to join a run's side at 45° (routing/commands.ts, after mech-air merges).
  it.todo("a 1/8 bend becomes a wye: the branch already meets the run at 45°");

  it("the trunk runs on upstream at the same fall, and ends open there for the next branch or a cleanout", () => {
    const m = routed(PVC4, SAN, [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -15 * FT }]);
    const { model, trunkId } = plus(m);
    const trunk = model.elements[trunkId];
    if (trunk?.kind !== "run_segment") throw new Error("trunk");
    expect(Math.max(trunk.start.y, trunk.end.y)).toBeGreaterThan(0);
    expect(trunk.links.start).toBeUndefined();
    expect(slopeInPerFt(trunk)).toBeCloseTo(0.125, 3);
  });

  it("running the upstream leg on instead would drain the trunk backwards up the branch: refused in plain words", () => {
    const m = routed(PVC4, SAN, [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -15 * FT }]);
    const bend = fits(m).find((f) => f.fittingType === "elbow");
    const wrong = bend?.ports.find((p) => p.link?.elementId === "p-s1");
    if (!bend || !wrong) throw new Error("fixture");
    expect(refused(m, { type: "elbow_to_tee", fittingId: bend.id, through: wrong.id, idPrefix: "x" })).toMatch(/can't join as a branch there/);
  });
});

describe("+ on a pressure pipe elbow", () => {
  it("a 1\" PEX cold water elbow becomes a tee", () => {
    const m = routed(PEX1, CW, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 8 * FT }]);
    const { model, trunkId } = plus(m);
    expect(fits(model).find((f) => f.host?.segmentId === trunkId)?.fittingType).toBe("tee");
    expect(validateModel(model)).toEqual([]);
  });
});

describe("+ at the base of a stack", () => {
  /** A 4" stack coming down from 8 ft turns into a building drain at -2 ft that falls away east. */
  function stackBase(): ModelState {
    let m: ModelState = { modelId: "pt", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = ok(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    return ok(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size: PVC4, elevationMm: 8 * FT, system: SAN, points: [{ x: 0, y: 0, elevationMm: -2 * FT }, { x: 20 * FT, y: 0 }] });
  }

  it("the building drain runs on back through the corner, open to route on, and the stack drops into its top", () => {
    const m = stackBase();
    const bend = fits(m).find((f) => f.fittingType === "elbow");
    const drainSide = bend?.ports.find((p) => Math.abs(p.direction.z) < 0.1);
    const drain = drainSide?.link ? m.elements[drainSide.link.elementId] : undefined;
    if (!bend || !drainSide || drain?.kind !== "run_segment") throw new Error("fixture");
    const model = withUpgradePolicy((f) => f === ROUTING_TAP_FACES_FEATURE, () => ok(m, { type: "elbow_to_tee", fittingId: bend.id, through: drainSide.id, idPrefix: "plus", face: "top" }));
    const trunk = model.elements[drain.id];
    if (trunk?.kind !== "run_segment") throw new Error("trunk");
    // The drain now reaches west past the stack and ends open there, still falling east.
    expect(Math.min(trunk.start.x, trunk.end.x)).toBeLessThan(0);
    expect(trunk.links.start === undefined || trunk.links.end === undefined).toBe(true);
    expect(slopeInPerFt(trunk)).toBeGreaterThanOrEqual(0.125 - 1e-3);
    const joint = fits(model).find((f) => f.host?.segmentId === trunk.id);
    expect(joint?.host?.face).toBe("top");
    expect(validateModel(model)).toEqual([]);
  });
});
