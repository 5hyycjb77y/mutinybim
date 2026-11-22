/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import { LEVEL_PLANE_MARGIN_MM, LevelPlanes, levelPlaneLayout } from "../src/level-planes";
import { ModelViewer3D } from "../src/viewer";

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

  it("rescales the labels when the lens angle changes, so they span the same fraction of the view at any fov", () => {
    // jsdom has no 2D canvas; the label only needs one to measure and fill.
    const ctx = { font: "", fillStyle: "", globalAlpha: 1, textBaseline: "", measureText: () => ({ width: 100 }), fillRect: () => undefined, fillText: () => undefined };
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    const planes = new LevelPlanes({ line: "#334455", highlight: "#ff7a1a", background: "#ffffff" });
    planes.set([{ id: "l1", name: "Level 1", elevationMm: 0 }], EXTENT);
    const label = planes.object.children[0]!.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite;
    const at45 = label.scale.y;
    const expectedNdcHeight = at45 / Math.tan(THREE.MathUtils.degToRad(45) / 2);
    // A sprite without size attenuation spans scale/tan(fov/2) of the view, so the scale must grow with tan(fov/2) to keep its screen size.
    planes.setFovDeg(90);
    expect(label.scale.y).toBeCloseTo(at45 * (Math.tan(Math.PI / 4) / Math.tan(THREE.MathUtils.degToRad(45) / 2)), 9);
    planes.setFovDeg(21);
    expect(label.scale.y).toBeCloseTo(at45 * (Math.tan(THREE.MathUtils.degToRad(21) / 2) / Math.tan(THREE.MathUtils.degToRad(45) / 2)), 9);
    // The label keeps its canvas shape: width tracks height (canvas 120x40 after the 20px padding).
    expect(label.scale.x / label.scale.y).toBeCloseTo(3, 9);
    // A rebuild keeps the applied angle (a highlighted level redraws its label).
    planes.setHighlighted("l1");
    const redrawn = planes.object.children[0]!.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite;
    expect(redrawn.scale.y).toBeCloseTo(label.scale.y, 9);

    // Orthographic mode scales from the active orthographic framing (independent of the stored perspective FOV), matching the same NDC height.
    planes.setFovDeg(110);
    planes.setCamera({ projection: "orthographic", orthoHeightMm: 20_000 });
    expect((redrawn.scale.y * 2) / 20).toBeCloseTo(expectedNdcHeight, 9);
    expect(redrawn.scale.x / redrawn.scale.y).toBeCloseTo(3, 9);
    // Zooming in orthographic halves orthoHeightMm and halves world sprite height, preserving NDC height.
    const at20m = redrawn.scale.y;
    planes.setCamera({ projection: "orthographic", orthoHeightMm: 10_000 });
    expect(redrawn.scale.y).toBeCloseTo(at20m / 2, 9);
    // Rebuilding while orthographic keeps the orthographic scale (does not snap back to perspective).
    planes.setHighlighted(null);
    const orthoRedrawn = planes.object.children[0]!.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite;
    expect(orthoRedrawn.scale.y).toBeCloseTo(at20m / 2, 9);
  });
});

describe("ModelViewer3D lens angle and settled notifications", () => {
  function viewerStub(fov = 45) {
    const perspective = new THREE.PerspectiveCamera(fov, 1.5, 0.1, 5000);
    const orthoView = new THREE.OrthographicCamera(-50, 50, 50, -50, -5000, 5000);
    orthoView.zoom = 2;
    const cameraListeners = new Set<() => void>();
    const cameraSettledListeners = new Set<() => void>();
    const callOrder: string[] = [];
    const stub = Object.create(ModelViewer3D.prototype) as ModelViewer3D;
    Object.assign(stub, {
      mode: "3d",
      projection: "perspective",
      perspective,
      orthoView,
      cameraListeners,
      cameraSettledListeners,
      fovDirty: false,
      orbitPointPinned: false,
      fragments: { update: jest.fn(async () => undefined) },
      controls: {
        setLookAt: jest.fn(async () => undefined),
        zoomTo: jest.fn(async () => undefined),
        setFocalOffset: jest.fn(() => { callOrder.push("setFocalOffset"); }),
        update: jest.fn(() => { callOrder.push("update"); }),
        setOrbitPoint: jest.fn(() => { callOrder.push("setOrbitPoint"); }),
      },
    });
    return { stub, perspective, orthoView, callOrder };
  }

  it("emits settled once after a drag gesture and immediately on direct setFovDeg calls", () => {
    const { stub } = viewerStub(45);
    const changed = jest.fn();
    const settled = jest.fn();
    stub.onCameraChange(changed);
    stub.onCameraSettled(settled);

    // Dragging notifies live camera listeners without spamming settled camera-memory saves.
    stub.setFovDeg(55, { settle: false });
    stub.setFovDeg(62, { settle: false });
    expect(stub.getFovDeg()).toBe(62);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(0);

    // Releasing the slider commits and emits settled once; a second commit at the same angle is a no-op.
    stub.setFovDeg(62, { settle: true });
    stub.setFovDeg(62, { settle: true });
    expect(settled).toHaveBeenCalledTimes(1);

    // Direct call (default settle: true) notifies both change and settled, clamping to 5..120.
    stub.setFovDeg(180);
    expect(stub.getFovDeg()).toBe(120);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it("reports orthographic visible height in mm and notifies camera listeners on lens-only setCamera3d changes", async () => {
    const { stub, callOrder } = viewerStub(45);
    expect(stub.getOrthoHeightMm()).toBeCloseTo(50_000, 6);
    const changed = jest.fn(() => { callOrder.push("changed"); });
    const settled = jest.fn(() => { callOrder.push("settled"); });
    stub.onCameraChange(changed);
    stub.onCameraSettled(settled);

    await stub.setCamera3d({ eye: { x: 10_000, y: 10_000, z: 10_000 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovDeg: 70, orthoHeightMm: 50_000 });
    expect(stub.getFovDeg()).toBe(70);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["setFocalOffset", "update", "changed", "settled"]);
  });
});
