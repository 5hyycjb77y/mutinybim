/**
 * @jest-environment node
 *
 * K1 (round 15): an open end that faces straight down (a fixture's waste
 * stub, a riser's foot) or up connects to a sideways end: the route leaves it
 * straight out to the other end's height, then runs level. Round 14 refused
 * any vertical end ("Connect ends that face sideways").
 */
import { validateModel } from "../src";
import { COPPER, CW, FT, K15Model, PVC, SAN } from "./k15-fixtures";

describe("auto_connect_runs with an end facing down", () => {
  it("cold water: a riser's foot at 2000 mm and a level run's end at 1000 mm 10 ft away are joined, both linked", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "pipe", size: COPPER(1), elevationMm: 3000, system: CW, points: [{ x: 0, y: 0, elevationMm: 2000 }] });
    m.ok({ type: "route_run", idPrefix: "S", levelId: "lvl-1", domain: "pipe", size: COPPER(1), elevationMm: 1000, system: CW, points: [{ x: 10 * FT, y: 5 * FT }, { x: 20 * FT, y: 5 * FT }] });
    const foot = m.seg("R-s1");
    expect(foot.end.z).toBeLessThan(foot.start.z);
    m.ok({ type: "auto_connect_runs", a: { elementId: "R-s1", port: "end" }, b: { elementId: "S-s1", port: "start" }, idPrefix: "J" });
    expect(m.seg("R-s1").links.end?.elementId).toMatch(/^J-/);
    expect(m.seg("S-s1").links.start?.elementId).toMatch(/^J-/);
    // It leaves the foot straight down to the run's height.
    const down = m.segs("J-").find((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 0.01);
    expect(down && Math.min(down.start.z, down.end.z)).toBeCloseTo(1000, 0);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("sanitary: a fixture's waste stub facing down joins a drain's open end below it", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "W", levelId: "lvl-1", domain: "pipe", size: PVC(2), elevationMm: 0, system: SAN, points: [{ x: 0, y: 0, elevationMm: -300 }] });
    m.ok({ type: "route_run", idPrefix: "D", levelId: "lvl-1", domain: "pipe", size: PVC(2), elevationMm: -2 * FT, system: SAN, points: [{ x: 8 * FT, y: 0 }, { x: 20 * FT, y: 0 }] });
    m.ok({ type: "auto_connect_runs", a: { elementId: "W-s1", port: "end" }, b: { elementId: "D-s1", port: "start" }, idPrefix: "J" });
    expect(m.seg("W-s1").links.end).toBeDefined();
    expect(m.seg("D-s1").links.start).toBeDefined();
  });

  it("two ends both facing down are refused in words", () => {
    const m = new K15Model();
    m.ok({ type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "pipe", size: COPPER(1), elevationMm: 3000, system: CW, points: [{ x: 0, y: 0, elevationMm: 2000 }] });
    m.ok({ type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "pipe", size: COPPER(1), elevationMm: 3000, system: CW, points: [{ x: 10 * FT, y: 0, elevationMm: 2000 }] });
    expect(m.refused({ type: "auto_connect_runs", a: { elementId: "A-s1", port: "end" }, b: { elementId: "B-s1", port: "end" }, idPrefix: "J" })).toMatch(/Both ends face up or down/);
  });
});
