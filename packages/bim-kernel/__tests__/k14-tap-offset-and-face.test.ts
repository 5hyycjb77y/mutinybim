/**
 * @jest-environment node
 *
 * Round 14 lane K14 (M14's kernel lines): a tap on a run's top or bottom may
 * sit off the face's centre line (`HostedOn.t`, feature `routing:tap_offset`),
 * an elbow that turns up or down from a level run becomes a tap on that run's
 * top or bottom (`elbow_to_tee` `face`), and a tap on a face is named by its
 * family's add-on ("Conical tap, rise from the top"). An older model server
 * gets a refusal in words and nothing is stored; a centre-line tap stores
 * exactly round 13's bytes.
 *
 * Fails on round 13's code: `run_branch` took no `t`, `hostedPoints` had no
 * offset, `elbow_to_tee` refused every elbow that turns up or down, and a
 * top tap was called "Conical tap".
 */
import { DEFAULT_SETTINGS, ROUTING_TAP_FACES_FEATURE, ROUTING_TAP_OFFSET_FEATURE, executeCommand, hostedPoints, validateModel, withUpgradePolicy, type Command, type ModelState, type RunFitting, type RunSegment } from "../src";

const FT = 304.8;
const IN = 25.4;
const Z = 3657.6;
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const MAIN = { shape: "rect" as const, width: 24 * IN, height: 12 * IN };
const ROUND8 = { shape: "round" as const, diameter: 8 * IN };
const both = (f: string) => f === ROUTING_TAP_FACES_FEATURE || f === ROUTING_TAP_OFFSET_FEATURE;
const facesOnly = (f: string) => f === ROUTING_TAP_FACES_FEATURE;

function commit(m: ModelState, command: Command, policy: (f: string) => boolean = both): ModelState {
  const r = withUpgradePolicy(policy, () => executeCommand(m, command));
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function refused(m: ModelState, command: Command, policy: (f: string) => boolean = both): string {
  const r = withUpgradePolicy(policy, () => executeCommand(m, command));
  if (r.ok) throw new Error(`expected ${command.type} to be refused`);
  return r.error.message;
}

function main(): ModelState {
  let m: ModelState = { modelId: "k14-taps", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return commit(m, { type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: MAIN, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
}

/** A drop from above that ends over `(x, y)`, then the route from its end onto the main's top with `t`. */
function topTap(m: ModelState, x: number, y: number, t: number | undefined, policy: (f: string) => boolean = both): { readonly drop: ModelState; readonly command: Command } {
  const drop = commit(m, { type: "route_run", idPrefix: "D", levelId: "lvl-1", domain: "duct", size: ROUND8, elevationMm: Z + 4 * FT, system: SA, points: [{ x, y: 8 * FT }, { x, y, elevationMm: Z + 3 * FT }] }, policy);
  const command: Command = { type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "duct", size: ROUND8, elevationMm: Z + 6 * IN, system: SA, points: [{ x, y }], from: { kind: "run_end", elementId: "D-s2", port: "end" }, to: { kind: "run_branch", segmentId: "T-s1", face: "top", ...(t !== undefined ? { t } : {}) } };
  return { drop, command };
}

const tapOn = (m: ModelState): RunFitting | undefined => Object.values(m.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.host?.segmentId === "T-s1");

describe("k14 tap offset across a face", () => {
  it("a top tap 150 mm off the centre line stores t, sits there, and names its face", () => {
    const { drop, command } = topTap(main(), 10 * FT, 150, 150);
    const m = commit(drop, command);
    const tap = tapOn(m);
    expect(tap?.host).toEqual({ segmentId: "T-s1", s: 10 * FT, side: 1, face: "top", t: 150 });
    expect(tap?.position).toEqual({ x: 10 * FT, y: 150, z: Z });
    expect(tap?.label).toBe("Conical tap, rise from the top");
    const host = m.elements["T-s1"] as RunSegment;
    expect(hostedPoints(host, 10 * FT, 1, undefined, "top", 150).branch).toEqual(tap?.ports[0]?.position);
    expect(validateModel(m)).toEqual([]);
  });

  it("a centre-line tap stores round 13's bytes (no t), whether or not the server reads offsets", () => {
    for (const policy of [both, facesOnly]) {
      const { drop, command } = topTap(main(), 10 * FT, 0, undefined, policy);
      const tap = tapOn(commit(drop, command, policy));
      expect(tap?.host).toEqual({ segmentId: "T-s1", s: 10 * FT, side: 1, face: "top" });
    }
    const { drop, command } = topTap(main(), 10 * FT, 0, 0);
    expect(tapOn(commit(drop, command))?.host).toEqual({ segmentId: "T-s1", s: 10 * FT, side: 1, face: "top" });
  });

  it("an older server, an offset off the face and a point that isn't where the offset puts it are refused in words", () => {
    const old = topTap(main(), 10 * FT, 150, 150, facesOnly);
    expect(refused(old.drop, old.command, facesOnly)).toMatch(/can't sit off its centre line yet: the model server this model is open on is an older version/);
    const wide = topTap(main(), 10 * FT, 400, 400);
    expect(refused(wide.drop, wide.command)).toMatch(/keep it within the run's width/);
    const off = topTap(main(), 10 * FT, 150, 100);
    expect(refused(off.drop, off.command)).toMatch(/starts where its offset puts it/);
  });

  it("a side tap still reads t 0: the offset moves it up or down its side only when given", () => {
    const host = main().elements["T-s1"] as RunSegment;
    expect(hostedPoints(host, 1000, 1)).toEqual(hostedPoints(host, 1000, 1, undefined, undefined, 0));
    expect(hostedPoints(host, 1000, 1, undefined, undefined, 50).onAxis).toEqual({ x: 1000, y: 0, z: 3607.6 });
  });
});

describe("k14 elbow_to_tee onto a face", () => {
  function riserElbow(): { readonly m: ModelState; readonly elbow: RunFitting; readonly level: string } {
    let m: ModelState = { modelId: "k14-elbow", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m = commit(m, { type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0, elevationMm: Z + 4 * FT }] });
    const elbow = Object.values(m.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow");
    const level = elbow?.ports.find((p) => Math.abs(p.direction.z) < 1e-6)?.id;
    if (!elbow || !level) throw new Error("expected an elbow turning up");
    return { m, elbow, level };
  }

  it("an elbow turning up becomes a tap on the level run's top, named for its face", () => {
    const { m, elbow, level } = riserElbow();
    const after = commit(m, { type: "elbow_to_tee", fittingId: elbow.id, through: level, idPrefix: "tee", face: "top" });
    expect(after.elements[elbow.id]).toBeUndefined();
    const tap = Object.values(after.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.host !== undefined);
    expect(tap?.host).toEqual({ segmentId: "R-s1", s: 20 * FT, side: 1, face: "top" });
    expect(tap?.label).toBe("Straight tap, rise from the top");
    expect(validateModel(after)).toEqual([]);
  });

  it("the wrong face, an older server and no face at all are refused in words", () => {
    const { m, elbow, level } = riserElbow();
    expect(refused(m, { type: "elbow_to_tee", fittingId: elbow.id, through: level, idPrefix: "tee", face: "bottom" })).toMatch(/doesn't turn down from a level run, so its leg can't join that run's bottom/);
    expect(refused(m, { type: "elbow_to_tee", fittingId: elbow.id, through: level, idPrefix: "tee", face: "top" }, () => false)).toMatch(/A branch can't leave the top of a run yet: the model server this model is open on is an older version/);
    expect(refused(m, { type: "elbow_to_tee", fittingId: elbow.id, through: level, idPrefix: "tee" })).toMatch(/Only a level elbow turns into a tee/);
  });
});
