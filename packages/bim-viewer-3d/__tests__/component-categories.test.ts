/**
 * Component categories are an open list (a newer peer's `paving`, `curb` is
 * kept), so the 3D view must cope with one it has no height for.
 */
import { asElementId, type BimElement } from "@permitzip/bim-kernel";
import { elementSolids } from "../src/native-geometry";

function component(category: string): BimElement {
  return {
    version: 1,
    authoredRev: {},
    id: asElementId(`k-${category}`),
    kind: "component",
    category,
    typeName: category,
    position: { x: 1000, y: 2000 },
    size: { x: 600, y: 400 },
    rotationDeg: 0,
  };
}

describe("component solids by category", () => {
  it("draws a known category at its height", () => {
    const [box] = elementSolids(component("furniture"));
    expect(box).toMatchObject({ group: "furnishing", shape: "box" });
    expect(box?.size[1]).toBeCloseTo(0.76);
  });

  it("keeps a category this viewer doesn't know out of 3D instead of drawing a box of no height", () => {
    expect(elementSolids(component("paving"))).toEqual([]);
  });
});
