/**
 * @jest-environment node
 */
import { ifcFilePointToScene, ifcPlacementToScene, transformPoint, type Mat4Rows } from "../src/coords";

describe("unplaced-device markers", () => {
  it("puts a point from the model's own file at IFC (x, y, z) → scene (x, z, −y) when the reference has no placement", () => {
    expect(ifcFilePointToScene(null, [3, 6, 0.45])).toEqual([3, 0.45, -6]);
  });

  it("applies the reference's placement the same way the Fragments object gets it, so the symbol lands on the linked geometry", () => {
    // 7301's architect link: turned 180° about Z, lifted 1 m.
    const placement: Mat4Rows = [
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, 1, 1],
      [0, 0, 0, 1],
    ];
    const p: [number, number, number] = [10, 2, 0.5];
    const marker = ifcFilePointToScene(placement, p);
    expect(marker).toEqual([-10, 1.5, 2]);
    // Same answer as moving the raw scene point with the object matrix the viewer uses for the model.
    const viaObject = transformPoint(ifcPlacementToScene(placement), [p[0], p[2], -p[1]]);
    expect(viaObject.map((v) => v + 0)).toEqual(marker.map((v) => v + 0));
  });
});
