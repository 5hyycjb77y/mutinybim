/**
 * @jest-environment node
 *
 * Origin marker math: axis lines reach the view edges, in perspective they run
 * to their vanishing point and never wrap behind the camera, the handles are
 * grabbed by screen distance, snapping, the orbit pivot choice and plan
 * rotation for true north.
 */
import * as THREE from "three";
import {
  AXIS_SCENE,
  buildArrows,
  chooseOrbitPivot,
  clipToRect,
  gizmoHandleAt,
  gizmoScreen,
  infiniteLineOnScreen,
  metresPerPixel,
  planUpVector,
  snapPlanPoint,
} from "../src/origin-gizmo";
import { kernelToScene } from "../src/coords";

const W = 800;
const H = 600;

function topDown(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, -1000, 1000);
  cam.position.set(0, 200, 0);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  return cam;
}

function perspective(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
  cam.position.set(20, 15, 20);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  return cam;
}

const onEdge = (p: { x: number; y: number }) => Math.abs(p.x) < 1e-6 || Math.abs(p.y) < 1e-6 || Math.abs(p.x - W) < 1e-6 || Math.abs(p.y - H) < 1e-6;

describe("clipToRect", () => {
  it("keeps the part inside and drops a segment that misses", () => {
    expect(clipToRect({ x: -100, y: 300 }, { x: 900, y: 300 }, W, H)).toEqual({ a: { x: 0, y: 300 }, b: { x: 800, y: 300 } });
    expect(clipToRect({ x: -100, y: -10 }, { x: 900, y: -10 }, W, H)).toBeNull();
  });
});

describe("infinite axis lines", () => {
  it("in plan, X runs edge to edge horizontally and Y vertically through the origin", () => {
    const cam = topDown();
    const x = infiniteLineOnScreen(cam, new THREE.Vector3(), AXIS_SCENE.x, W, H);
    const y = infiniteLineOnScreen(cam, new THREE.Vector3(), AXIS_SCENE.y, W, H);
    expect(x && onEdge(x.a) && onEdge(x.b)).toBe(true);
    expect(x?.a.y).toBeCloseTo(H / 2);
    expect(x?.b.y).toBeCloseTo(H / 2);
    expect(y?.a.x).toBeCloseTo(W / 2);
    expect(Math.abs((y?.a.y ?? 0) - (y?.b.y ?? 0))).toBeCloseTo(H);
    // Looking straight down, Z points at the camera: no line, just the origin.
    expect(infiniteLineOnScreen(cam, new THREE.Vector3(), AXIS_SCENE.z, W, H)).toBeNull();
  });

  it("in perspective, every axis reaches at least one view edge and no end is behind the camera", () => {
    const cam = perspective();
    for (const axis of ["x", "y", "z"] as const) {
      const seg = infiniteLineOnScreen(cam, new THREE.Vector3(), AXIS_SCENE[axis], W, H);
      expect(seg).not.toBeNull();
      if (!seg) continue;
      expect(onEdge(seg.a) || onEdge(seg.b)).toBe(true);
      for (const p of [seg.a, seg.b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(W + 1e-6);
      }
    }
  });

  it("an axis seen end-on draws no line: looking straight down in perspective, Z is only the marker", () => {
    const cam = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
    cam.position.set(6, 40, 0.001);
    cam.lookAt(6, 0, 0);
    cam.updateProjectionMatrix();
    const screen = gizmoScreen(cam, new THREE.Vector3(), W, H);
    expect(screen.lines.z).toBeNull();
    expect(screen.lines.x).not.toBeNull();
    expect(screen.lines.y).not.toBeNull();
  });

  it("an origin far off screen still draws its axes when they cross the view", () => {
    const cam = topDown();
    // 50 m east of the view centre: X still crosses the view, Y does not.
    const origin = new THREE.Vector3(50, 0, 0);
    expect(infiniteLineOnScreen(cam, origin, AXIS_SCENE.x, W, H)).not.toBeNull();
    expect(infiniteLineOnScreen(cam, origin, AXIS_SCENE.y, W, H)).toBeNull();
  });
});

describe("handles", () => {
  it("grabs the point at the origin, an arrow along it, nothing elsewhere", () => {
    const cam = topDown();
    const screen = gizmoScreen(cam, new THREE.Vector3(), W, H);
    expect(screen.origin?.x).toBeCloseTo(W / 2);
    expect(gizmoHandleAt(screen, { x: W / 2 + 3, y: H / 2 - 2 })).toBe("point");
    expect(gizmoHandleAt(screen, { x: W / 2 + 40, y: H / 2 + 1 })).toBe("x");
    expect(gizmoHandleAt(screen, { x: W / 2, y: H / 2 - 40 })).toBe("y");
    expect(gizmoHandleAt(screen, { x: W / 2 + 200, y: H / 2 + 200 })).toBeNull();
  });

  it("arrows keep their screen size: metres per pixel follows the zoom", () => {
    const cam = topDown();
    const a = metresPerPixel(cam, new THREE.Vector3(), H);
    cam.zoom = 2;
    cam.updateProjectionMatrix();
    expect(metresPerPixel(cam, new THREE.Vector3(), H)).toBeCloseTo(a / 2);
  });
});

describe("orbit pivot", () => {
  const origin = new THREE.Vector3(...kernelToScene(3048, 6096, 0));
  const model = new THREE.Box3(new THREE.Vector3(10, 0, -40), new THREE.Vector3(30, 12, -20));
  const nothing = new THREE.Box3();

  it("orbits and zooms about the selection when there is one, wherever the model is", () => {
    expect(chooseOrbitPivot(new THREE.Vector3(1, 2, 3), model, origin).toArray()).toEqual([1, 2, 3]);
  });

  it("with nothing selected, about the middle of the model (the box Home frames)", () => {
    expect(chooseOrbitPivot(null, model, origin).toArray()).toEqual([20, 6, -30]);
  });

  it("falls back to the project origin only while nothing is loaded or drawn", () => {
    expect(chooseOrbitPivot(null, nothing, origin).toArray()).toEqual(origin.toArray());
    // A copy: moving the result never moves the stored origin.
    chooseOrbitPivot(null, nothing, origin).set(9, 9, 9);
    expect(origin.x).toBeCloseTo(3.048);
  });
});

describe("snapping", () => {
  const toScreen = (x: number, y: number) => ({ x: x / 10, y: -y / 10 });
  it("snaps to a nearby point on screen, otherwise rounds to the inch", () => {
    const candidates = [{ x: 1000, y: -1000, label: "AHU-1" }];
    expect(snapPlanPoint({ x: 1040, y: -1030 }, candidates, toScreen, { x: 104, y: 103 })).toEqual({ x: 1000, y: -1000, snappedTo: "AHU-1" });
    const free = snapPlanPoint({ x: 5013, y: 2 }, candidates, toScreen, { x: 501, y: 0 });
    expect(free.snappedTo).toBeNull();
    expect(free.x).toBeCloseTo(197 * 25.4, 6);
    expect(free.y).toBeCloseTo(0, 6);
  });
});

describe("plan rotation for true north", () => {
  it("puts the chosen direction at the top of a top-down view", () => {
    for (const deg of [0, 30, -45, 180]) {
      const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, -1000, 1000);
      cam.position.set(0, 200, 0);
      cam.up.copy(planUpVector(deg));
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const a = (deg * Math.PI) / 180;
      // True north in plan is (sin a, cos a); in scene (sin a, 0, −cos a). It must project straight up.
      const tip = new THREE.Vector3(Math.sin(a) * 5, 0, -Math.cos(a) * 5).project(cam);
      expect(tip.x).toBeCloseTo(0, 6);
      expect(tip.y).toBeGreaterThan(0);
    }
  });
});

describe("arrows", () => {
  it("are one mesh (one draw call) with a colour per axis", () => {
    const group = buildArrows();
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes).toHaveLength(1);
    const geometry = meshes[0]?.geometry;
    expect(geometry?.getAttribute("color")).toBeDefined();
    expect((geometry?.index?.count ?? 0) / 3).toBeLessThan(1500);
  });
});
