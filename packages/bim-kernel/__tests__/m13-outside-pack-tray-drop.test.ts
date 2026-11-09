/**
 * @jest-environment node
 *
 * Round 13 lane M13 (Bedrock proof): an outside add-on's cable tray kind gets
 * a drop on its bottom face through `kernel.connector_face`, with zero kernel
 * edits. The add-on lists the tray's faces from its own stored geometry; the
 * kernel resolves `{ hostId, face: "bottom", s, t }` to a point. Without the
 * add-on the same placement has no face to sit on (null, never a guess), and
 * the kernel's own run row keeps answering for runs inside the add-on's set.
 *
 * Fails on round 12's code: there was no connector face point, no placement
 * shape and no `placementPoint` reader.
 */
import { CONNECTOR_FACE_POINT, connectorFacesOf, DEFAULT_SETTINGS, placementPoint, type BimElement, type ConnectorFaceDef, type ConnectorFaceRow, type ModelState, type RunSegment, type TapPlacement, type Vec3 } from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { Log } from "./a13a-fixtures";

interface Tray {
  readonly id: string;
  readonly kind: "zztray.tray";
  readonly values: { readonly x0: number; readonly x1: number; readonly y: number; readonly z: number; readonly widthMm: number; readonly depthMm: number };
}

/** The add-on's own record, read from the open element shape (the kernel knows no tray). */
function trayOf(el: BimElement): Tray | null {
  const stored: { readonly kind: string } = el;
  return stored.kind === "zztray.tray" ? (el as unknown as Tray) : null;
}

const TRAY_FACES: ConnectorFaceRow = {
  kind: "zztray.tray",
  label: "Cable tray",
  faces: (el): readonly ConnectorFaceDef[] => {
    const t = trayOf(el);
    if (!t) return [];
    const { x0, x1, y, z, widthMm, depthMm } = t.values;
    const mid: Vec3 = [(x0 + x1) / 2, y, z];
    const along: Vec3 = [1, 0, 0];
    return [
      { id: "bottom", label: "Bottom", center: [mid[0], mid[1], z - depthMm / 2], normal: [0, 0, -1], alongDir: along, alongMm: x1 - x0, acrossMm: widthMm },
      { id: "side_left", label: "Left side", center: [mid[0], y + widthMm / 2, z], normal: [0, 1, 0], alongDir: along, alongMm: x1 - x0, acrossMm: depthMm },
    ];
  },
};

const TRAY_PACK = definePack({ id: "zztray", name: "Test tray", version: "1.0.0", kernel: "^1.0.0" }, [contribute(CONNECTOR_FACE_POINT, [TRAY_FACES])]);

const tray = { id: "tray-1", kind: "zztray.tray", version: 1, authoredRev: {}, values: { x0: 0, x1: 6000, y: 1000, z: 3000, widthMm: 300, depthMm: 100 } } as unknown as BimElement;
const drop: TapPlacement = { hostId: "tray-1" as TapPlacement["hostId"], face: "bottom", s: 2500, t: 50 };

describe("m13 outside pack: a tray drop on its bottom face", () => {
  it("the add-on's row places the drop on the tray's bottom, through the point", () => {
    withPackSet(PackSet.create([TRAY_PACK]), () => {
      expect(connectorFacesOf(tray, {}).map((f) => f.id)).toEqual(["bottom", "side_left"]);
      // Bottom normal is down, along is +x, so across (normal × along) is -y: t 50 is 50 mm towards -y.
      expect(placementPoint(drop, { "tray-1": tray })).toEqual([2500, 950, 2950]);
      expect(placementPoint({ ...drop, face: "top" }, { "tray-1": tray })).toBeNull();
      expect(placementPoint({ ...drop, s: 7000 }, { "tray-1": tray })).toBeNull();
    });
  });

  it("without the add-on the placement has no face; the kernel's run row still answers inside the add-on's set", () => {
    expect(placementPoint(drop, { "tray-1": tray })).toBeNull();
    const m = new Log({ modelId: "m13-tray", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "T", levelId: "L1", domain: "duct", size: { shape: "round", diameter: 300 }, elevationMm: 3000, system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }] });
    const run = m.head.elements["T-s1"] as RunSegment;
    withPackSet(PackSet.create([TRAY_PACK]), () => {
      expect(placementPoint({ hostId: run.id, face: "bottom", s: 1000, t: 0 }, m.head.elements)).toEqual([1000, 0, 2850]);
    });
  });
});
