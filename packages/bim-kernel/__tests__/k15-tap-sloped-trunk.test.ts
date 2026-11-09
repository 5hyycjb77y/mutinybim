/**
 * @jest-environment node
 *
 * K2 (round 15): an open branch end dragged onto a sloped drain taps its side
 * at the drain's height where it meets it. Round 14 refused every sloped
 * trunk ("runs up and down; drag the end onto a level run"), which is every
 * sanitary main.
 */
import { validateModel } from "../src";
import { FT, K15Model, PVC, SAN, zAtX } from "./k15-fixtures";

function site(): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: 400, system: SAN, points: [{ x: -10 * FT, y: 12 * FT }, { x: 10 * FT, y: 12 * FT }] });
  // A 2" branch heading north towards it, its open end 4 ft short.
  m.ok({ type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "pipe", size: PVC(2), elevationMm: 700, system: SAN, points: [{ x: 2 * FT, y: 4 * FT }, { x: 2 * FT, y: 8 * FT }] });
  return m;
}

describe("stretch_to_side onto a sloped drain", () => {
  it("the main slopes; the branch end joins its side with a takeoff at the main's height there, one edit", () => {
    const m = site();
    const main = m.seg("main-s1");
    expect(Math.abs(main.start.z - main.end.z)).toBeGreaterThan(1);
    const before = m.log.length;
    m.ok({ type: "stretch_to_side", from: { elementId: "br-s1", port: "end" }, onto: "main-s1", idPrefix: "tap" });
    expect(m.log.length).toBe(before + 1);
    const [takeoff] = m.takeoffsOn("main-s1");
    if (!takeoff) throw new Error("no takeoff on the main");
    expect(takeoff.position.z).toBeCloseTo(zAtX(m.seg("main-s1"), takeoff.position.x), 0);
    expect(m.seg("br-s1").links.end).toBeDefined();
    expect(validateModel(m.head)).toEqual([]);
  });

  it("an end facing down can't take the top of a sloped drain: refused, saying to connect it instead", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: 400, system: SAN, points: [{ x: -10 * FT, y: 12 * FT }, { x: 10 * FT, y: 12 * FT }] });
    m.ok({ type: "route_run", idPrefix: "dn", levelId: "lvl-1", domain: "pipe", size: PVC(2), elevationMm: 2000, system: SAN, points: [{ x: 0, y: 12 * FT, elevationMm: 1200 }] });
    expect(m.refused({ type: "stretch_to_side", from: { elementId: "dn-s1", port: "end" }, onto: "main-s1", idPrefix: "tap" })).toMatch(/slopes, so a branch joins its side/);
  });
});
