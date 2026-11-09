/**
 * @jest-environment node
 *
 * Round 13 lane M13: old taps read identically. A side tap drawn with every
 * peer reading `routing:tap_faces` stores byte for byte what an older peer's
 * model stores, reads as `side_left` / `side_right`, and the kernel's run face
 * row puts it exactly where `hostedPoints` always did. Mechanical's round-1
 * duct taps read through its face row to the same point `tapPosition` gives.
 *
 * Fails on round 12's code: there was no connector face row for a run (no
 * `connectorFacesOf`, `hostedFaceOf`, `pointOnFace`), so a tap's place could
 * not be read as a face at all.
 */
import { canonicalJson, connectorFacesOf, DEFAULT_SETTINGS, hostedFaceOf, hostedPoints, pointOnFace, ROUTING_TAP_FACES_FEATURE, type ModelState, type RunFitting, type RunSegment } from "../src";
import { DUCT_SEGMENT_FACE_ROW, tapPlanPosition } from "../../bim-pack-mechanical/src/connections/taps-faces";
import { tapPosition, type DuctSegment } from "../../bim-pack-mechanical/src/types";
import { Log, type Policy } from "./a13a-fixtures";

const FT = 304.8;
const IN = 25.4;
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

function drawn(policy: Policy): ModelState {
  const m = new Log({ modelId: "m13-old", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "route_run", idPrefix: "T", levelId: "L1", domain: "duct", size: { shape: "rect", width: 20 * IN, height: 12 * IN }, elevationMm: 12 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }] }, policy);
  m.ok({ type: "route_run", idPrefix: "L", levelId: "L1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, system: SA, from: { kind: "run_branch", segmentId: "T-s1" }, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 8 * FT }] }, policy);
  m.ok({ type: "route_run", idPrefix: "R", levelId: "L1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, system: SA, from: { kind: "run_branch", segmentId: "T-s1" }, points: [{ x: 20 * FT, y: 0 }, { x: 20 * FT, y: -8 * FT }] }, policy);
  return m.head;
}

describe("m13 old taps read identically", () => {
  it("side taps store the same bytes whether or not the peers read tap faces", () => {
    expect(canonicalJson(drawn(() => true).elements)).toBe(canonicalJson(drawn((f) => f !== ROUTING_TAP_FACES_FEATURE).elements));
  });

  it("each side tap reads as side_left / side_right and sits where the run's face row says", () => {
    const head = drawn(() => true);
    const host = head.elements["T-s1"] as RunSegment;
    const faces = connectorFacesOf(host, head.elements);
    expect(faces.map((f) => f.id)).toEqual(["top", "bottom", "side_left", "side_right", "end_start", "end_end"]);
    const taps = Object.values(head.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.host?.segmentId === host.id);
    expect(taps.map((t) => (t.host ? hostedFaceOf(t.host) : "")).sort()).toEqual(["side_left", "side_right"]);
    for (const tap of taps) {
      if (!tap.host) throw new Error("tap off its host");
      expect(tap.host.face).toBeUndefined();
      const face = faces.find((f) => f.id === hostedFaceOf(tap.host ?? { side: 1 }));
      const p = face ? pointOnFace(face, tap.host.s, 0) : null;
      const old = hostedPoints(host, tap.host.s, tap.host.side).branch;
      expect(p?.map((c) => Math.round(c * 1000) / 1000)).toEqual([old.x, old.y, old.z]);
      expect(tap.ports[0]?.position).toEqual(old);
    }
  });

  it("Mechanical's round-1 duct taps read through its face row to tapPosition's point", () => {
    const base = { version: 1, authoredRev: {} } as const;
    const ducts: DuctSegment[] = [
      { ...base, id: "d1", kind: "duct_segment", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, profile: { shape: "rect", width: 500, height: 300 } } as DuctSegment,
      { ...base, id: "d2", kind: "duct_segment", start: { x: 100, y: 200 }, end: { x: 2100, y: 2200 }, profile: { shape: "round", diameter: 350 } } as DuctSegment,
    ];
    for (const duct of ducts) {
      expect(DUCT_SEGMENT_FACE_ROW.faces(duct, {}).map((f) => f.id)).toEqual(["top", "bottom", "side_left", "side_right", "end_start", "end_end"]);
      for (const side of [1, -1] as const) {
        const want = tapPosition(duct, { s: 1200, side });
        const got = tapPlanPosition(duct, { s: 1200, side });
        expect(got?.x).toBeCloseTo(want.x, 6);
        expect(got?.y).toBeCloseTo(want.y, 6);
      }
    }
  });
});
