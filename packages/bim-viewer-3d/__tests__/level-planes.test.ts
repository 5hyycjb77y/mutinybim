/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import { LEVEL_PLANE_MARGIN_MM, LevelPlanes, levelPlaneLayout } from "../src/level-planes";

const FT = 304.8;
const EXTENT = { min: { x: 0, y: 0 }, max: { x: 30_000, y: 20_000 } };

describe("level planes in 3D", () => {
  it("draws each level as an outline at its height around the building, plan north toward scene −z", () => {
    const [roof] = levelPlaneLayout([{ id: "r", name: "ROOF", elevationMm: 26.5 * FT }], EXTENT);
    const m = LEVEL_PLANE_MARGIN_MM / 1000;
    expect(roof!.corners.every(([, y]) => Math.abs(y - (26.5 * FT) / 1000) < 1e-9)).toBe(true);
    expect(roof!.corners).toEqual([
      [-m, (26.5 * FT) / 1000, m],
      [30 + m, (26.5 * FT) / 1000, m],
      [30 + m, (26.5 * FT) / 1000, -(20 + m)],
      [-m, (26.5 * FT) / 1000, -(20 + m)],
    ]);
    expect(roof!.text).toBe(`ROOF  26'-6"`);
  });

  it("labels a level below project zero with its sign", () => {
    expect(levelPlaneLayout([{ id: "b", name: "Basement", elevationMm: -10 * FT }], EXTENT)[0]!.text).toBe(`Basement  -10'-0"`);
  });

  it("builds one outline and one label per level, hides with the toggle, and frees them on dispose", () => {
    // jsdom has no 2D canvas; the label only needs one to measure and fill.
    const ctx = { font: "", fillStyle: "", globalAlpha: 1, textBaseline: "", measureText: () => ({ width: 100 }), fillRect: () => undefined, fillText: () => undefined };
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    const scene = new THREE.Scene();
    const planes = new LevelPlanes({ line: "#334455", highlight: "#ff7a1a", background: "#ffffff" });
    scene.add(planes.object);
    planes.set(
      [
        { id: "l1", name: "Level 1", elevationMm: 0 },
        { id: "l2", name: "Level 2", elevationMm: 12 * FT },
      ],
      EXTENT,
    );
    expect(planes.object.children).toHaveLength(2);
    expect(planes.object.children.map((g) => g.userData.levelId)).toEqual(["l1", "l2"]);
    const kinds = planes.object.children.map((g) => g.children.map((c) => c.type));
    expect(kinds).toEqual([
      ["LineLoop", "Sprite"],
      ["LineLoop", "Sprite"],
    ]);
    planes.setHighlighted("l2");
    const line = planes.object.children[1]!.children[0] as THREE.LineLoop;
    expect((line.material as THREE.LineDashedMaterial).color.getHexString()).toBe("ff7a1a");
    planes.setVisible(false);
    expect(planes.object.visible).toBe(false);
    planes.dispose();
    expect(planes.object.children).toHaveLength(0);
    expect(scene.children).not.toContain(planes.object);
  });
});
