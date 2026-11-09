/**
 * @jest-environment node
 *
 * A receptacle that draws under a pixel in the live plan sat between the pick
 * rays (4 px apart) and could not be hovered, so it never showed its "+" grip
 * (electrical-ws-c, Nov 2026). The near miss finds it from its footprint, and
 * reads only the plan cells within reach: hover never scans the model.
 */
import { asElementId } from "@permitzip/bim-kernel";
import type { Solid } from "../src/native-geometry";
import { PlanFootprintGrid } from "../src/plan-near-miss";

function box(id: string, cx: number, cz: number, size: [number, number, number], yaw = 0): Solid {
  return { elementId: asElementId(id), version: 0, group: "equipment", shape: "box", center: [cx, 1, cz], size, yaw };
}

const RECEPTACLE: [number, number, number] = [0.07, 0.11, 0.04];
const keepAll = () => true;

function gridOf(solids: readonly Solid[]): PlanFootprintGrid {
  const byId = new Map<string, Solid[]>();
  for (const s of solids) byId.set(s.elementId, [...(byId.get(s.elementId) ?? []), s]);
  const grid = new PlanFootprintGrid();
  grid.sync(byId);
  return grid;
}

describe("PlanFootprintGrid near miss", () => {
  it("finds a sub-pixel receptacle within the tolerance of the pointer", () => {
    // About 0.17 m per pixel: the receptacle is under half a pixel; the pointer is half a pixel off.
    const { hit } = gridOf([box("rec", 10, 5, RECEPTACLE)]).nearMiss({ x: 10 + 0.085, z: 5 }, 0.17 * 8, keepAll);
    expect(hit?.elementId).toBe("rec");
  });

  it("ignores what is further than the tolerance", () => {
    expect(gridOf([box("rec", 10, 5, RECEPTACLE)]).nearMiss({ x: 11, z: 5 }, 0.5, keepAll).hit).toBeNull();
  });

  it("prefers the nearer footprint, then the smaller one (a device on its wall)", () => {
    const wall = box("wall", 10, 5, [6, 3, 0.2]);
    const grid = gridOf([wall, box("rec", 10, 5.12, RECEPTACLE), box("far", 12, 9, RECEPTACLE)]);
    expect(grid.nearMiss({ x: 10, z: 5.12 }, 0.3, keepAll).hit?.elementId).toBe("rec");
    expect(grid.nearMiss({ x: 12.5, z: 5.3 }, 0.3, keepAll).hit?.elementId).toBe("wall");
  });

  it("measures along a turned solid's own axes, and files it by its turned footprint", () => {
    const grid = gridOf([box("duct", 0, 0, [8, 0.3, 0.2], Math.PI / 2)]);
    expect(grid.nearMiss({ x: 0, z: 3.9 }, 0.05, keepAll).hit?.elementId).toBe("duct");
    expect(grid.nearMiss({ x: 3.9, z: 0 }, 0.05, keepAll).hit).toBeNull();
  });

  it("leaves out what the caller does not keep (clipped, hidden) and mesh bodies", () => {
    const rec = box("rec", 0, 0, RECEPTACLE);
    expect(gridOf([rec]).nearMiss({ x: 0, z: 0 }, 0.5, () => false).hit).toBeNull();
    expect(gridOf([{ ...rec, elementId: asElementId("door"), shape: "mesh" }]).nearMiss({ x: 0, z: 0 }, 0.5, keepAll).hit).toBeNull();
  });

  it("follows the model: a moved element is found where it went, a removed one is gone, an unchanged one is not re-filed", () => {
    const grid = new PlanFootprintGrid();
    const stay = [box("stay", 50, 50, RECEPTACLE)];
    grid.sync(new Map([["rec", [box("rec", 0, 0, RECEPTACLE)]], ["stay", stay]]));
    grid.sync(new Map([["rec", [box("rec", 20, 0, RECEPTACLE)]], ["stay", [box("stay", 50, 50, RECEPTACLE)]]]));
    expect(grid.nearMiss({ x: 0, z: 0 }, 0.3, keepAll).hit).toBeNull();
    expect(grid.nearMiss({ x: 20, z: 0 }, 0.3, keepAll).hit?.elementId).toBe("rec");
    expect(grid.nearMiss({ x: 50, z: 50 }, 0.3, keepAll).hit?.elementId).toBe("stay");
    grid.sync(new Map([["stay", stay]]));
    expect(grid.nearMiss({ x: 20, z: 0 }, 0.3, keepAll)).toEqual({ hit: null, examined: 0 });
  });

  it("at 250k solids a hover scores only the footprints in the cells within reach", () => {
    // 500 x 500 receptacles, 2 m apart: the 8 px reach at a far zoom (1.36 m) covers a few cells.
    const solids: Solid[] = [];
    for (let i = 0; i < 250_000; i++) solids.push(box(`s${i}`, (i % 500) * 2, Math.floor(i / 500) * 2, RECEPTACLE));
    const grid = gridOf(solids);
    const answer = grid.nearMiss({ x: 400.03, z: 300 }, 1.36, keepAll);
    expect(answer.hit?.elementId).toBe(`s${150 * 500 + 200}`);
    expect(answer.examined).toBeLessThanOrEqual(9);
  });
});
