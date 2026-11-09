/**
 * @jest-environment jsdom
 *
 * The 3D crop box in the viewer: its scene clipping planes match the kernel
 * box (turned boxes included), picking skips what the box clips away, face
 * grips sit on the face centres, and dragging a grip measures along the face.
 */
import * as THREE from "three";
import { CROP_FACES, faceCenter, insideBox, type CropBox3d } from "@permitzip/bim-kernel";
import { MM } from "../src/coords";
import { cropBoxOutlinePositions, cropBoxScenePlanes, faceDragOffsetMm, firstKeptHit, gripsOnScreen, keptByPlanes } from "../src/crop-box";

const toScene = (q: { x: number; y: number; z: number }) => new THREE.Vector3(q.x * MM, q.z * MM, -q.y * MM);

const BOX: CropBox3d = { center: { x: 4000, y: -2000, z: 1500 }, halfSize: { x: 1200, y: 600, z: 1500 }, rotationDeg: 35 };

describe("clipping planes", () => {
  test("a scene point is kept exactly when the kernel says it is inside the box, turned or not", () => {
    for (const box of [BOX, { ...BOX, rotationDeg: 0 }, { ...BOX, rotationDeg: -120 }]) {
      const planes = cropBoxScenePlanes(box);
      expect(planes).toHaveLength(6);
      // A deterministic scatter around the box.
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
      for (let i = 0; i < 500; i++) {
        const q = { x: box.center.x + rand() * 2500, y: box.center.y + rand() * 2500, z: box.center.z + rand() * 2500 };
        expect(keptByPlanes(planes, toScene(q))).toBe(insideBox(box, q));
      }
    }
  });

  test("each plane passes through its face centre and faces inward", () => {
    const planes = cropBoxScenePlanes(BOX);
    CROP_FACES.forEach((face, i) => {
      const plane = planes[i];
      if (!plane) throw new Error("missing plane");
      const { point, normal } = faceCenter(BOX, face);
      expect(plane.distanceToPoint(toScene(point))).toBeCloseTo(0, 9);
      expect(plane.normal.dot(new THREE.Vector3(normal.x, normal.z, -normal.y))).toBeCloseTo(-1, 9);
    });
  });

  test("the outline is twelve edges on the box's corners", () => {
    const pos = cropBoxOutlinePositions(BOX);
    expect(pos.length).toBe(12 * 6);
    const planes = cropBoxScenePlanes(BOX);
    for (let i = 0; i < pos.length; i += 3) {
      const v = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
      // On the surface: kept within rounding, and on at least two planes (an edge).
      expect(planes.every((p) => p.distanceToPoint(v) > -1e-6)).toBe(true);
      expect(planes.filter((p) => Math.abs(p.distanceToPoint(v)) < 1e-6).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("picking ignores clipped-away geometry", () => {
  test("a wall in front, outside the box, does not block the duct inside it", () => {
    const scene = new THREE.Scene();
    const box: CropBox3d = { center: { x: 0, y: 0, z: 1500 }, halfSize: { x: 2000, y: 2000, z: 1500 }, rotationDeg: 20 };
    // Kernel: duct at the box centre; wall 6 m south of it, outside the box, between it and the camera.
    const duct = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.6));
    duct.position.copy(toScene({ x: 0, y: 0, z: 1500 }));
    duct.name = "duct";
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 0.2));
    wall.position.copy(toScene({ x: 0, y: -6000, z: 1500 }));
    wall.name = "wall";
    scene.add(duct, wall);
    scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(toScene({ x: 0, y: -20000, z: 1500 }), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObjects(scene.children, false);
    expect(hits[0]?.object.name).toBe("wall");
    expect(firstKeptHit(hits, cropBoxScenePlanes(box))?.object.name).toBe("duct");
    // Crop off: the wall wins again.
    expect(firstKeptHit(hits, [])?.object.name).toBe("wall");
  });
});

describe("face grips", () => {
  function camera(): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 5000);
    // South-west and above the box, looking at its centre.
    c.position.copy(toScene({ x: BOX.center.x - 15000, y: BOX.center.y - 15000, z: BOX.center.z + 12000 }));
    c.lookAt(toScene(BOX.center));
    c.updateMatrixWorld();
    return c;
  }

  test("one grip per face, at the face centre on screen; the faces toward the camera say so", () => {
    const cam = camera();
    const grips = gripsOnScreen(BOX, cam, 800, 600);
    expect(grips.map((g) => g.face).sort()).toEqual([...CROP_FACES].sort());
    for (const g of grips) {
      const ndc = toScene(faceCenter(BOX, g.face).point).project(cam);
      expect(g.x).toBeCloseTo(((ndc.x + 1) / 2) * 800, 6);
      expect(g.y).toBeCloseTo(((1 - ndc.y) / 2) * 600, 6);
    }
    expect(grips.find((g) => g.face === "z+")?.facing).toBe(true);
    expect(grips.find((g) => g.face === "z-")?.facing).toBe(false);
  });

  test("dragging a grip measures how far along its own (turned) normal the pointer went", () => {
    const { point, normal } = faceCenter(BOX, "x+");
    const target = { x: point.x + normal.x * 800, y: point.y + normal.y * 800, z: point.z };
    // A ray from above, straight down through a point 800 mm out from the face.
    const ray = new THREE.Ray(toScene({ ...target, z: target.z + 10000 }), new THREE.Vector3(0, -1, 0));
    expect(faceDragOffsetMm(BOX, "x+", ray)).toBeCloseTo(800, 3);
    // Looking straight along the top face's normal: no defined distance.
    expect(faceDragOffsetMm(BOX, "z+", ray)).toBeNull();
  });
});
