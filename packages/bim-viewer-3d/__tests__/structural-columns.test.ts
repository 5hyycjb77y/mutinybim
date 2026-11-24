/**
 * @jest-environment node
 *
 * Verifies 3D viewer (`bim-viewer-3d`) vertical spans for fixed-height,
 * base-offset, and multi-story top-level-tied structural columns.
 */
import { DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_ELEVATIONS, elementSolids, type Solid } from "../src";

const FT = 304.8;

function run(model: ModelState, commands: readonly Command[]): ModelState {
  let cur = model;
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) throw new Error(`${command.type} failed: ${res.error.code} — ${res.error.message}`);
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

function zBoundsMmOfSolids(solids: readonly Solid[]): { minZ: number; maxZ: number } {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of solids) {
    if (s.shape === "mesh" && s.mesh) {
      for (let i = 1; i < s.mesh.positions.length; i += 3) {
        const zMm = (s.center[1] + s.mesh.positions[i]!) * 1000;
        minZ = Math.min(minZ, zMm);
        maxZ = Math.max(maxZ, zMm);
      }
    } else {
      minZ = Math.min(minZ, (s.center[1] - s.size[1] / 2) * 1000);
      maxZ = Math.max(maxZ, (s.center[1] + s.size[1] / 2) * 1000);
    }
  }
  return { minZ, maxZ };
}

describe("bim-viewer-3d structural column vertical spans", () => {
  beforeAll(() => {
    installFirstPartyAddOns();
  });

  const model = withUpgradePolicy(
    () => true,
    () =>
      run({ modelId: "viewer-cols", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS }, [
        { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
        { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
        { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: Math.round(24 * FT) },
        { type: "create_element", elementId: "col-short", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 0, y: 0 }, rotationDeg: 30 }, size: { widthMm: 254, depthMm: 254, heightMm: 2000 }, baseOffsetMm: 100, values: { "struct.section": "W10x33", mark: "CS1" } },
        { type: "create_element", elementId: "col-tall", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 4000, y: 0 } }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "ROOF", topOffsetMm: -200, values: { "struct.section": "W10x33", mark: "CT1" } },
      ]),
  );

  it("builds exact heights for short fixed-height and multi-story tied columns", () => {
    const shortSolids = elementSolids(model.elements["col-short"]!, DEFAULT_ELEVATIONS, model);
    expect(shortSolids.length).toBeGreaterThan(0);
    const shortZ = zBoundsMmOfSolids(shortSolids);
    expect(shortZ.minZ).toBeCloseTo(100, 0);
    expect(shortZ.maxZ).toBeCloseTo(2100, 0);

    const tallSolids = elementSolids(model.elements["col-tall"]!, DEFAULT_ELEVATIONS, model);
    expect(tallSolids.length).toBeGreaterThan(0);
    const tallZ = zBoundsMmOfSolids(tallSolids);
    expect(tallZ.minZ).toBeCloseTo(0, 0);
    expect(tallZ.maxZ).toBeCloseTo(Math.round(24 * FT) - 200, 0);
  });

  it("preserves explicit untied column height under a slab, uses positive CCW yaw on fallback columns, and pitches sloped beams", () => {
    const m2 = withUpgradePolicy(
      () => true,
      () =>
        run({ modelId: "viewer-col-edge", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS }, [
          { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
          { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 2000 },
          { type: "create_element", elementId: "slab-2", levelId: "L2", kind: "slab", size: { thicknessMm: 200 }, placement: { kind: "area", outline: [{ x: -1000, y: -1000 }, { x: 5000, y: -1000 }, { x: 5000, y: 5000 }, { x: -1000, y: 5000 }] } },
          { type: "create_element", elementId: "col-fixed-rot", levelId: "L1", kind: "column", placement: { kind: "point", position: { x: 1000, y: 1000 }, rotationDeg: 30 }, size: { widthMm: 300, depthMm: 200, heightMm: 2000 } },
          { type: "create_element", elementId: "bm-sloped", levelId: "L1", kind: "beam", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } } },
          { type: "set_element_placement", elementId: "bm-sloped", placement: { kind: "line", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, startOffsetMm: 0, endOffsetMm: 1000, lateral: "center", vertical: "top" } },
        ]),
    );
    const colSolids = elementSolids(m2.elements["col-fixed-rot"]!, DEFAULT_ELEVATIONS, m2);
    expect(colSolids).toHaveLength(1);
    expect(zBoundsMmOfSolids(colSolids).maxZ).toBeCloseTo(2000, 0);
    expect(colSolids[0]?.yaw).toBeCloseTo((30 * Math.PI) / 180, 5);

    const bmSolids = elementSolids(m2.elements["bm-sloped"]!, DEFAULT_ELEVATIONS, m2);
    expect(bmSolids).toHaveLength(1);
    expect(bmSolids[0]?.pitch).toBeCloseTo(Math.atan2(1000, 4000), 5);
  });
});
