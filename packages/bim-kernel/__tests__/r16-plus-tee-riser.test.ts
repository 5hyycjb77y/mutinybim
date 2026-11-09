/**
 * @jest-environment node
 *
 * Round 16 (product owner: "the + on the drain elbow doesn't work"). A drain that
 * turns down (a level branch into a drop or stack) had no "+": `elbow_to_tee`
 * took level elbows only, or a face join. Now the vertical leg can run on
 * through the corner and the level leg joins it as a branch. Which fitting
 * that is comes from the system's defaults (a sanitary tee into a stack for
 * PVC sanitary), not from this command. It is plain geometry, so pressure
 * pipe risers take it too.
 */
import { DEFAULT_SETTINGS, planCommit, validateModel, type Command, type ModelState, type RunFitting, type RunSegment, type RunSize } from "../src";

const FT = 304.8;
const IN = 25.4;
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary 1" };
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "DCW 1" };
const PVC3: RunSize = { shape: "pipe", nominalMm: 3 * IN, material: "pvc" };
const CU1: RunSize = { shape: "pipe", nominalMm: 1 * IN, material: "copper" };

let k = 0;
function submit(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `rt-${++k}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-11-05T00:00:00.000Z");
}
function ok(model: ModelState, command: Command): ModelState {
  const d = submit(model, command);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}
const segs = (m: ModelState) => Object.values(m.elements).filter((e): e is RunSegment => e.kind === "run_segment");
const fits = (m: ModelState) => Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting");
const isPlumb = (s: RunSegment) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 1;

/** A level run east to (10 ft, 0), then straight down 4 ft: the elbow turns down. */
function turnsDown(size: RunSize, system: typeof SAN | typeof CW): ModelState {
  let m: ModelState = { modelId: "rt", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = ok(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return ok(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size, elevationMm: -1 * FT, system, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 0, elevationMm: -5 * FT }] });
}

function riserThrough(m: ModelState): { model: ModelState; riser: RunSegment } {
  const bend = fits(m).find((f) => f.fittingType === "elbow");
  const riser = segs(m).find(isPlumb);
  const through = bend?.ports.find((p) => p.link?.elementId === riser?.id);
  if (!bend || !through || !riser) throw new Error("fixture: no elbow turning down");
  return { model: ok(m, { type: "elbow_to_tee", fittingId: bend.id, through: through.id, idPrefix: "plus" }), riser };
}

describe("+ on an elbow that turns down: the drop runs on up through the corner", () => {
  it("a sanitary drain turning down becomes a sanitary tee on the stack, and the stack is open above it", () => {
    const m = turnsDown(PVC3, SAN);
    const { model, riser } = riserThrough(m);
    const tee = fits(model).find((f) => f.host?.segmentId === riser.id);
    expect(tee?.family).toBe("dwv.sanitary_tee");
    const stack = model.elements[riser.id];
    if (stack?.kind !== "run_segment") throw new Error("stack");
    const top = stack.start.z > stack.end.z ? "start" : "end";
    expect(Math.max(stack.start.z, stack.end.z)).toBeGreaterThan(-1 * FT);
    expect(stack.links[top]).toBeUndefined();
    expect(validateModel(model)).toEqual([]);
  });

  it("a copper water riser takes the same + (the geometry is not drain-only)", () => {
    const m = turnsDown(CU1, CW);
    const { model, riser } = riserThrough(m);
    expect(fits(model).find((f) => f.host?.segmentId === riser.id)?.fittingType).toBe("tee");
    expect(validateModel(model)).toEqual([]);
  });

  it("running the level leg on instead (the drop would leave the drain's bottom) is still refused with the reason", () => {
    const m = turnsDown(PVC3, SAN);
    const bend = fits(m).find((f) => f.fittingType === "elbow");
    const level = bend?.ports.find((p) => p.link?.elementId !== segs(m).find(isPlumb)?.id);
    if (!bend || !level) throw new Error("fixture");
    const d = submit(m, { type: "elbow_to_tee", fittingId: bend.id, through: level.id, idPrefix: "x" });
    expect(d.ok).toBe(false);
  });
});
