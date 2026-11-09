/**
 * @jest-environment node
 *
 * The "+" on a bend, for every kind of run (review video, Nov 6, 16:51: "it
 * works, except for I didn't get a T"; 50:55: "add the elbow right there at
 * that place if it'll fit").
 *
 * Before: `elbow_to_tee` needed straight pieces on both sides of the elbow,
 * so a 32"x14" elbow whose other leg met a transition got no tee; a riser
 * could run on through the corner only on pipe; and a route continued from an
 * open end had to leave it straight out, so the "+" always forced a straight
 * piece before the first elbow.
 */
import { DEFAULT_SETTINGS, builtinPartType, planCommit, validateModel, type Command, type ModelState, type RunFitting, type RunSegment, type RunSize } from "../src";

const FT = 304.8;
const IN = 25.4;
const Z = 10 * FT;
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "DCW 1" };
const TRUNK: RunSize = { shape: "rect", width: 32 * IN, height: 14 * IN };
const NARROW: RunSize = { shape: "rect", width: 24 * IN, height: 14 * IN };
const ROUND10: RunSize = { shape: "round", diameter: 10 * IN };
const PEX1: RunSize = { shape: "pipe", nominalMm: 1 * IN, material: "pex" };

let k = 0;
function submit(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `b3-${++k}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-11-06T00:00:00.000Z");
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
function empty(): ModelState {
  const m: ModelState = { modelId: "b3", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return ok(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

describe('"+" on a bend whose other leg meets a fitting, not a straight piece', () => {
  /** The review's frame: a 32"x14" elbow whose south leg goes straight into a transition. */
  function elbowIntoTransition(): { m: ModelState; elbow: RunFitting; through: string } {
    let m = ok(empty(), { type: "route_run", idPrefix: "L", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -15 * FT }] });
    m = ok(m, { type: "delete_elements", ids: ["L-s2"], policy: "disconnect" });
    const bend = fits(m).find((f) => f.fittingType === "elbow");
    const open = bend?.ports.find((p) => !p.link);
    if (!bend || !open) throw new Error("fixture: elbow");
    m = ok(m, { type: "route_run", idPrefix: "N", levelId: "lvl-1", domain: "duct", size: NARROW, system: SA, from: { kind: "run_end", elementId: bend.id, port: open.id }, points: [{ x: 20 * FT, y: -15 * FT }] });
    const elbow = fits(m).find((f) => f.id === bend.id);
    const through = elbow?.ports.find((p) => p.link?.elementId === "L-s1");
    if (!elbow || !through) throw new Error("fixture: elbow after");
    expect(elbow.ports.some((p) => m.elements[p.link?.elementId ?? ""]?.kind === "run_fitting")).toBe(true);
    return { m, elbow, through: through.id };
  }

  it("becomes a tee: the trunk runs on through the corner, the transition's leg joins it as a branch, nothing is left open on that side", () => {
    const { m, elbow, through } = elbowIntoTransition();
    const after = ok(m, { type: "elbow_to_tee", fittingId: elbow.id, through, idPrefix: "plus" });
    expect(after.elements[elbow.id]).toBeUndefined();
    const trunk = after.elements["L-s1"];
    if (trunk?.kind !== "run_segment") throw new Error("trunk");
    expect(Math.max(trunk.start.x, trunk.end.x)).toBeGreaterThan(20 * FT);
    expect(fits(after).some((f) => f.host?.segmentId === "L-s1")).toBe(true);
    const transition = fits(after).find((f) => f.fittingType === "transition" && f.ports.some((p) => p.link?.elementId === "N-s1"));
    expect(transition?.ports.every((p) => p.link)).toBe(true);
    expect(validateModel(after)).toEqual([]);
  });
});

describe('"+" on a bend that turns up, for every run kind', () => {
  it("a supply riser's elbow: the riser runs on down through the corner and the level leg taps it (was refused for anything but pipe)", () => {
    const m = ok(empty(), { type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "duct", size: ROUND10, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 0, elevationMm: Z + 8 * FT }] });
    const elbow = fits(m).find((f) => f.fittingType === "elbow");
    const riser = segs(m).find((s) => Math.abs(s.start.x - s.end.x) < 1 && Math.abs(s.start.y - s.end.y) < 1);
    const through = elbow?.ports.find((p) => p.link?.elementId === riser?.id);
    if (!elbow || !riser || !through) throw new Error("fixture");
    const after = ok(m, { type: "elbow_to_tee", fittingId: elbow.id, through: through.id, idPrefix: "plus" });
    const ran = after.elements[riser.id];
    if (ran?.kind !== "run_segment") throw new Error("riser");
    expect(Math.min(ran.start.z, ran.end.z)).toBeLessThan(Z - 1);
    expect(fits(after).some((f) => f.host?.segmentId === riser.id)).toBe(true);
    expect(validateModel(after)).toEqual([]);
  });
});

describe('"+" at an open end places an elbow right there', () => {
  const run = () => ok(empty(), { type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  const turnNorth = (extra: Partial<Extract<Command, { type: "route_run" }>> = {}): Command => ({
    type: "route_run",
    idPrefix: "B",
    levelId: "lvl-1",
    domain: "duct",
    size: TRUNK,
    system: SA,
    from: { kind: "run_end", elementId: "A-s1", port: "end" },
    points: [{ x: 20 * FT, y: 15 * FT }],
    ...extra,
  });

  it("without it the first leg still has to leave the end straight out (the old rule stays the default)", () => {
    expect(refused(run(), turnNorth())).toMatch(/straight out/);
  });

  it("with it the elbow sits on the end: no straight piece before it, one elbow joining the two", () => {
    const after = ok(run(), turnNorth({ turnAtStart: true }));
    const a = after.elements["A-s1"];
    if (a?.kind !== "run_segment") throw new Error("A");
    expect(a.end).toEqual({ x: 20 * FT, y: 0, z: Z });
    const elbow = fits(after).find((f) => f.fittingType === "elbow");
    expect(elbow?.position).toEqual({ x: 20 * FT, y: 0, z: Z });
    expect(a.links.end?.elementId).toBe(elbow?.id);
    expect(segs(after).filter((s) => s.id.startsWith("B"))).toHaveLength(1);
    expect(validateModel(after)).toEqual([]);
  });

  it("works the same on pipe", () => {
    let m = ok(empty(), { type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "pipe", size: PEX1, elevationMm: -2 * FT, system: CW, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m = ok(m, { type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "pipe", size: PEX1, system: CW, from: { kind: "run_end", elementId: "A-s1", port: "end" }, points: [{ x: 10 * FT, y: -6 * FT }], turnAtStart: true });
    expect(fits(m).filter((f) => f.fittingType === "elbow")).toHaveLength(1);
    expect(validateModel(m)).toEqual([]);
  });

  it("when the end's straight piece is too short for the elbow, it says so instead of making one", () => {
    const short = ok(empty(), { type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 1.2 * FT, y: 0 }] });
    expect(refused(short, turnNorth({ turnAtStart: true, points: [{ x: 1.2 * FT, y: 15 * FT }] }))).toMatch(/No room for an elbow right at the end/);
  });
});

describe("Route finishes with flex into a device (review video 39:41: \"the very last part of that run will be flex\")", () => {
  const DIFFUSER = builtinPartType("builtin:supply-diffuser-24@1");
  function room(): ModelState {
    if (!DIFFUSER) throw new Error("starter diffuser missing");
    let m = ok(empty(), { type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 11 * FT, system: SA, points: [{ x: 10 * FT, y: -10 * FT }, { x: 10 * FT, y: 10 * FT }] });
    m = ok(m, { type: "place_part", partId: "sd-1", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 9 * FT });
    return m;
  }
  const route = { idPrefix: "B", levelId: "lvl-1", domain: "duct" as const, size: { shape: "round" as const, diameter: 8 * IN }, system: SA, from: { kind: "run_branch" as const, segmentId: "T-s1" }, points: [{ x: 10 * FT, y: 0 }, { x: 17 * FT, y: 0 }] };

  it("one edit: the rigid branch to the last point, then flex into the neck, linked both ends", () => {
    const after = ok(room(), { type: "route_into_flex", route, to: { partId: "sd-1", connectorId: "neck" } });
    const flex = after.elements["B-flex"];
    if (flex?.kind !== "run_segment") throw new Error("no flex");
    expect(flex.flex?.path.length).toBeGreaterThan(2);
    expect(flex.links.end).toEqual({ elementId: "sd-1", port: "neck" });
    const rigid = segs(after).find((s) => s.id.startsWith("B-s") && s.links.end?.elementId === "B-flex");
    expect(rigid).toBeDefined();
    expect(validateModel(after)).toEqual([]);
  });

  it("a device too far for flex is refused in words, and nothing is built", () => {
    const far = { ...route, points: [{ x: 10 * FT, y: 0 }, { x: 11 * FT, y: 0 }] };
    const m = room();
    const moved = ok(m, { type: "move_elements", ids: ["sd-1"], delta: { x: 40 * FT, y: 0 } });
    expect(refused(moved, { type: "route_into_flex", route: far, to: { partId: "sd-1", connectorId: "neck" } })).toMatch(/flex/i);
  });
});
