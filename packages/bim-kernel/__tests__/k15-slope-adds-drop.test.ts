/**
 * @jest-environment node
 *
 * K3 (round 15): a sloped drain finishing on a connector at a fixed height adds
 * its own drop next to that connector when the fall leaves it short, instead of
 * refusing. Round 14 refused unless a vertical leg was already drawn right
 * beside the connector ("Sloped at 1/4" per ft, the drain would reach its other
 * end … below the connection there").
 */
import { pitchNodes } from "../src";
import { FT, IN, K15Model, LAV, PVC, SAN, zAtX } from "./k15-fixtures";

describe("pitchNodes: the drop it adds", () => {
  const base = { flowWithPoints: true, inPerFt: 0.25, fixed: "last", other: "rigid", tol: 0.5, minStraightMm: 100 } as const;

  it("upstream connector 175 mm above where the fall brings the drain: a drop 200 mm from it, the short piece keeps the fall", () => {
    const out = pitchNodes([{ x: 0, y: 0, z: 800 }, { x: 6000, y: 0, z: 500 }], base);
    if ("refusal" in out) throw new Error(out.refusal);
    expect(out.nodes).toEqual([
      { x: 0, y: 0, z: 800 },
      { x: 200, y: 0, z: 795.833 },
      { x: 200, y: 0, z: 620.833 },
      { x: 6000, y: 0, z: 500 },
    ]);
  });

  it("a connector below where the fall brings it would need water to run uphill: still refused", () => {
    const out = pitchNodes([{ x: 0, y: 0, z: 560 }, { x: 6000, y: 0, z: 500 }], base);
    expect("refusal" in out && out.refusal).toMatch(/the drain would reach its other end .* in above the connection/);
  });

  it("a miss shorter than the shortest straight piece can't be a drop: refused", () => {
    const out = pitchNodes([{ x: 0, y: 0, z: 680 }, { x: 6000, y: 0, z: 500 }], base);
    expect("refusal" in out).toBe(true);
  });

  it("a vertical leg further back on that side takes up the miss (round 14 only used one right beside the connector)", () => {
    const out = pitchNodes(
      [
        { x: 0, y: 0, z: 1000 },
        { x: 1000, y: 0, z: 1000 },
        { x: 1000, y: 0, z: 600 },
        { x: 4000, y: 0, z: 600 },
      ],
      base,
    );
    if ("refusal" in out) throw new Error(out.refusal);
    // From the fixed end: 3000 mm at 1/4" per ft rises 62.5 mm, then the drop; the first leg keeps its own fall (20.8 mm) and the drop stretches so the far end stays at 1000.
    expect(out.nodes.map((n) => n.z)).toEqual([1000, 979.167, 662.5, 600]);
  });
});

describe("routing a lavatory's waste to a sloped branch 12 ft away", () => {
  function site(mainStartZ: number): K15Model {
    const m = new K15Model();
    m.place("lav", LAV, 0, 0, 0, "LAV-1");
    // A 4" branch along x at y = 12 ft, falling from its first point.
    m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: mainStartZ, system: SAN, points: [{ x: -10 * FT, y: 12 * FT }, { x: 10 * FT, y: 12 * FT }] });
    return m;
  }
  const waste = (m: K15Model) => {
    const z = m.part("lav").values?.rim_height;
    return typeof z === "number" ? z - 250 : 34 * IN - 250;
  };

  it("the lavatory's waste sits above where the fall reaches it: a drop is added beside the lavatory and it connects", () => {
    // The branch is 300 mm below the waste where the arm meets it; 12 ft of arm at 1/4" per ft falls 76 mm, so the arm needs a 225 mm drop (more than its two quarter bends take).
    const m = site(345);
    const main = m.seg("main-s1");
    expect(waste(m) - zAtX(main, 0)).toBeCloseTo(300.35, 1);
    m.ok({ type: "route_run", idPrefix: "arm", levelId: "lvl-1", domain: "pipe", size: PVC(1.25), system: SAN, points: [{ x: 0, y: 12 * FT }], from: { kind: "part", partId: "lav", connectorId: "waste" }, to: { kind: "run_branch", segmentId: "main-s1" } });
    expect(m.part("lav").links?.waste?.elementId).toMatch(/^arm-s/);
    const drop = m.segs("arm-").find((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 0.01);
    if (!drop) throw new Error("no drop");
    // Between one and two shortest straight pieces from the waste, falling the way the water runs.
    expect(Math.abs(drop.start.y - 30)).toBeGreaterThanOrEqual(150);
    expect(Math.abs(drop.start.y - 30)).toBeLessThanOrEqual(300 + 1);
    expect(drop.end.z).toBeLessThan(drop.start.z);
    expect(m.takeoffsOn("main-s1")).toHaveLength(1);
  });

  it("the waste sits below where the fall reaches it: refused in words (water would run uphill)", () => {
    const m = site(650);
    expect(m.refused({ type: "route_run", idPrefix: "arm", levelId: "lvl-1", domain: "pipe", size: PVC(1.25), system: SAN, points: [{ x: 0, y: 12 * FT }], from: { kind: "part", partId: "lav", connectorId: "waste" }, to: { kind: "run_branch", segmentId: "main-s1" } })).toMatch(/the drain would reach its other end/);
  });
});
