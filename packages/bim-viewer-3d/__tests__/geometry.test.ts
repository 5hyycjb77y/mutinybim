/**
 * @jest-environment node
 */
import { asElementId, executeCommand, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel, createPlacedDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import {
  ifcPlacementToScene,
  isMat4Rows,
  kernelToScene,
  sceneToKernel,
  toColumnMajor,
  transformPoint,
  type Mat4Rows,
} from "../src/coords";
import { changedElements, DEFAULT_ELEVATIONS, elementSolids, modelSolids } from "../src/native-geometry";
import { robustCore } from "../src/framing";

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("coordinates", () => {
  it("maps kernel plan mm to scene metres (Y up, Z = -north) and back", () => {
    const p = kernelToScene(119_500, -26_000, 3200);
    expect(p).toEqual([119.5, 3.2, 26]);
    expect(sceneToKernel({ x: p[0], z: p[2] })).toEqual({ x: 119_500, y: -26_000 });
  });

  it("expresses the 7301 architect link placement (180 degrees about IFC Z) in scene axes", () => {
    const ifc: Mat4Rows = [
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, 1, 5.2366e-5],
      [0, 0, 0, 1],
    ];
    const scene = ifcPlacementToScene(ifc);
    // A link point at IFC (10, 20, 3) lands at host IFC (-10, -20, 3) -> scene (-10, 3, 20).
    const linkScene = kernelToScene(10_000, 20_000, 3000);
    const placed = transformPoint(scene, linkScene);
    close(placed[0], -10);
    close(placed[1], 3 + 5.2366e-5);
    close(placed[2], 20);
  });

  it("produces the column-major layout three.js expects", () => {
    const rows: Mat4Rows = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ];
    expect(toColumnMajor(rows)).toEqual([1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]);
    expect(isMat4Rows(rows)).toBe(true);
    expect(isMat4Rows([[1, 2]])).toBe(false);
  });
});

describe("authored solids", () => {
  const model = createDemoModel();

  it("draws every demo element: ducts as boxes along their run, terminals with a neck to the duct", () => {
    const solids = modelSolids(model);
    const kinds = new Set(Object.values(model.elements).map((e) => e.kind));
    for (const kind of kinds) {
      const el = Object.values(model.elements).find((e) => e.kind === kind)!;
      expect(elementSolids(el).length).toBeGreaterThan(0);
    }
    const trunk = model.elements["seg-trunk"];
    if (!trunk || trunk.kind !== "duct_segment" || trunk.profile.shape !== "rect") throw new Error("demo trunk missing");
    const [box] = elementSolids(trunk);
    const len = Math.hypot(trunk.end.x - trunk.start.x, trunk.end.y - trunk.start.y) / 1000;
    expect(box!.shape).toBe("box");
    close(box!.size[0], len);
    close(box!.size[1], trunk.profile.height / 1000);
    close(box!.size[2], trunk.profile.width / 1000);
    close(box!.center[1], DEFAULT_ELEVATIONS.ductCenterAboveFloorMm / 1000);
    const terminal = Object.values(model.elements).find((e) => e.kind === "terminal")!;
    const parts = elementSolids(terminal);
    expect(parts.map((p) => p.group)).toEqual(["terminal", "duct"]);
    expect(parts[1]!.vertical).toBe(true);
    expect(solids.length).toBeGreaterThanOrEqual(Object.keys(model.elements).length);
  });

  it("follows the placed model's origin so authored ducts land inside the linked building", () => {
    const placed = createPlacedDemoModel("site", { x: 119_500, y: -26_000 });
    const a = modelSolids(model).find((s) => s.elementId === "seg-trunk")!;
    const b = modelSolids(placed).find((s) => s.elementId === "seg-trunk")!;
    close(b.center[0] - a.center[0], 119.5);
    close(b.center[2] - a.center[2], 26);
  });

  it("rebuilds only the elements an edit changed (identity by id + version)", () => {
    const res = executeCommand(model, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 });
    if (!res.ok) throw new Error(res.error.message);
    const after: ModelState = res.model;
    const { changed, removed } = changedElements(model, after);
    expect(removed).toEqual([]);
    expect(changed).toContain(asElementId("sd-1"));
    expect(changed.length).toBeLessThan(Object.keys(after.elements).length);
  });
});

describe("framing", () => {
  const box = (x: number, z: number) => ({ min: { x, y: 0, z }, max: { x: x + 1, y: 3, z: z + 1 } });

  it("ignores a stray far from the building when fitting", () => {
    const building = Array.from({ length: 200 }, (_, i) => box((i % 20) * 2, Math.floor(i / 20) * 2));
    const stray = box(5_000, -3_000);
    const kept = robustCore([...building, stray]);
    expect(kept).toHaveLength(200);
    expect(kept).not.toContain(stray);
  });

  it("keeps everything when there are too few items to judge", () => {
    const few = [box(0, 0), box(9_000, 9_000)];
    expect(robustCore(few)).toHaveLength(2);
  });
});

describe("full-BIM coverage", () => {
  it("draws walls, slabs, structure, ductwork and furnishings for a whole building", () => {
    const model = createFullBimModel(FULL_BIM_TIERS.XS);
    const groups = new Set(modelSolids(model).map((s) => s.group));
    for (const g of ["wall", "slab", "structure", "duct", "terminal", "furnishing"] as const) expect(groups).toContain(g);
  });
});
