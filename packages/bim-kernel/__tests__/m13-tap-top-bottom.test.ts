/**
 * @jest-environment node
 *
 * Round 13 lane M13: taps on any face. A riser dragged down onto a main taps
 * its top; one dragged up into it taps its bottom. The branch connector sits
 * on the face (half the main's height off its centreline) and points out
 * along the face's normal. A side tap still stores exactly `{ segmentId, s,
 * side }`; a top / bottom tap stores `face` and is only written when every
 * peer reads `routing:tap_faces` — an older peer gets a refusal in words and
 * nothing is stored.
 *
 * Fails on round 12's code: `stretch_to_side` refused an end facing up or
 * down ("The end runs alongside …"), the branch anchor refused a branch that
 * doesn't leave at the trunk's height, and `HostedOn` had no face.
 */
import { connectorFacesOf, hostedFaceOf, hostedPoints, pointOnFace, ROUTING_TAP_FACES_FEATURE, validateModel, type RunFitting, type RunSegment } from "../src";
import { DEFAULT_SETTINGS, type ModelState } from "../src";
import { Log } from "./a13a-fixtures";

const FT = 304.8;
const IN = 25.4;
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const ROUND8 = { shape: "round" as const, diameter: 8 * IN };
const Z = 12 * FT;
const older = (f: string) => f !== ROUTING_TAP_FACES_FEATURE;

function main(): Log {
  const m = new Log({ modelId: "m13-taps", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "route_run", idPrefix: "T", levelId: "L1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
  return m;
}

/** A run that comes in level at `fromZ` and turns straight down (or up) at x, ending open `gapZ` from the main's centreline. */
function riser(m: Log, prefix: string, x: number, fromZ: number, endZ: number): RunSegment {
  m.ok({ type: "route_run", idPrefix: prefix, levelId: "L1", domain: "duct", size: ROUND8, elevationMm: fromZ, system: SA, points: [{ x, y: 8 * FT }, { x, y: 0, elevationMm: endZ }] });
  const open = Object.values(m.head.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith(`${prefix}-`) && Math.abs(e.end.z - endZ) < 1 && Math.abs(e.start.z - e.end.z) > 1);
  if (!open) throw new Error(`no vertical piece for ${prefix}`);
  return open;
}

function tapsOn(m: Log, hostId: string): RunFitting[] {
  return Object.values(m.head.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.host?.segmentId === hostId);
}

function trunk(m: Log): RunSegment {
  const t = m.head.elements["T-s1"];
  if (t?.kind !== "run_segment") throw new Error("no trunk");
  return t;
}

describe("m13 taps on the top and bottom of a main", () => {
  it("a riser dropped onto the main taps its top; one rising into it taps its bottom", () => {
    const m = main();
    const down = riser(m, "D", 10 * FT, 16 * FT, Z + 3 * FT);
    m.ok({ type: "stretch_to_side", from: { elementId: down.id, port: "end" }, onto: "T-s1", idPrefix: "S" });
    const up = riser(m, "U", 20 * FT, 6 * FT, Z - 3 * FT);
    m.ok({ type: "stretch_to_side", from: { elementId: up.id, port: "end" }, onto: "T-s1", idPrefix: "B" });

    const taps = tapsOn(m, "T-s1");
    expect(taps.map((t) => t.host?.face).sort()).toEqual(["bottom", "top"]);
    const host = trunk(m);
    const faces = connectorFacesOf(host, m.head.elements);
    for (const tap of taps) {
      if (!tap.host) throw new Error("tap off its host");
      const port = tap.ports[0];
      const sign = tap.host.face === "top" ? 1 : -1;
      expect(port?.direction).toEqual({ x: 0, y: 0, z: sign });
      expect(port?.position.z).toBeCloseTo(Z + sign * 5 * IN, 3);
      expect(port?.position.x).toBeCloseTo(tap.host.face === "top" ? 10 * FT : 20 * FT, 3);
      // The stored place and the face row agree on where the branch sits.
      const face = faces.find((f) => f.id === hostedFaceOf(tap.host ?? { side: 1 }));
      const onFace = face ? pointOnFace(face, tap.host.s, 0) : null;
      expect(onFace?.map((c) => Math.round(c * 1000) / 1000)).toEqual([port?.position.x, port?.position.y, port?.position.z]);
      expect(hostedPoints(host, tap.host.s, tap.host.side, undefined, tap.host.face).branch).toEqual(port?.position);
    }
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a side tap stores only { segmentId, s, side }; a top tap for a peer that doesn't read tap faces is refused in words", () => {
    const m = main();
    m.ok({ type: "route_run", idPrefix: "R", levelId: "L1", domain: "duct", size: ROUND8, system: SA, from: { kind: "run_branch", segmentId: "T-s1" }, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 8 * FT }] }, older);
    const side = tapsOn(m, "T-s1")[0];
    expect(side?.host && Object.keys(side.host).sort()).toEqual(["s", "segmentId", "side"]);
    expect(side?.host && hostedFaceOf(side.host)).toBe("side_left");

    const down = riser(m, "D", 20 * FT, 16 * FT, Z + 3 * FT);
    const before = m.head.revision;
    expect(m.refused({ type: "stretch_to_side", from: { elementId: down.id, port: "end" }, onto: "T-s1", idPrefix: "S" }, older)).toMatch(
      /can't leave the top of .* yet: the model server this model is open on is an older version that only takes branches from a run's sides/,
    );
    expect(m.head.revision).toBe(before);
    expect(tapsOn(m, "T-s1")).toHaveLength(1);
  });

  it("an end facing down beside the main, or pointing away from it, is refused with the reason", () => {
    const m = main();
    m.ok({ type: "route_run", idPrefix: "X", levelId: "L1", domain: "duct", size: ROUND8, elevationMm: 16 * FT, system: SA, points: [{ x: 10 * FT, y: 8 * FT }, { x: 10 * FT, y: 2 * FT, elevationMm: Z + 3 * FT }] });
    const off = Object.values(m.head.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("X-") && Math.abs(e.start.z - e.end.z) > 1);
    if (!off) throw new Error("no riser");
    expect(m.refused({ type: "stretch_to_side", from: { elementId: off.id, port: "end" }, onto: "T-s1", idPrefix: "S" })).toMatch(/isn't over the .* centreline; move it over the run, then drag it onto the top/);
    // Above the main but facing up (a riser leaving upward): it points away from the main.
    m.ok({ type: "route_run", idPrefix: "W", levelId: "L1", domain: "duct", size: ROUND8, elevationMm: Z + 2 * FT, system: SA, points: [{ x: 25 * FT, y: 8 * FT }, { x: 25 * FT, y: 0, elevationMm: 18 * FT }] });
    const away = Object.values(m.head.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("W-") && Math.abs(e.start.z - e.end.z) > 1);
    if (!away) throw new Error("no riser");
    expect(m.refused({ type: "stretch_to_side", from: { elementId: away.id, port: "end" }, onto: "T-s1", idPrefix: "S" })).toMatch(/faces up but the .* is below it/);
  });
});
