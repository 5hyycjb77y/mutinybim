/**
 * @jest-environment node
 *
 * Verifies IFC export (`bim-ifc`) for structural columns, beams, pad footings,
 * and offset walls + hosted windows.
 */
import { DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { exportIfc } from "../src";

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

describe("bim-ifc structural elements and offset-wall openings", () => {
  beforeAll(() => {
    installFirstPartyAddOns();
  });

  const model = withUpgradePolicy(
    () => true,
    () =>
      run({ modelId: "ifc-struct", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS }, [
        { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
        { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
        { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: Math.round(24 * FT) },
        { type: "create_element", elementId: "col-short", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 0, y: 0 }, rotationDeg: 30 }, size: { widthMm: 254, depthMm: 254, heightMm: 2000 }, baseOffsetMm: 100, values: { "struct.section": "W10x33", mark: "CS1" } },
        { type: "create_element", elementId: "col-tall", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 4000, y: 0 } }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "ROOF", topOffsetMm: -200, values: { "struct.section": "W10x33", mark: "CT1" } },
        { type: "create_element_type", typeId: "ftg-600", name: "Thick Footing", forKinds: ["component"], values: { "struct.footing_thickness_mm": 600 } },
        { type: "create_element", elementId: "bm-1", levelId: "L2", kind: "beam", classId: "struct.beam_steel", label: "W16x26", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } }, values: { "struct.section": "W16x26", mark: "B1" } },
        { type: "create_element", elementId: "ftg-1", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: "ftg-600", placement: { kind: "point", position: { x: 4000, y: 0 } }, size: { widthMm: 1500, depthMm: 1500 }, values: { mark: "F1" } },
        { type: "create_element", elementId: "w-raised", levelId: "L1", kind: "wall", baseOffsetMm: 1200, size: { thicknessMm: 200, heightMm: 2400 }, placement: { kind: "line", start: { x: 0, y: 4000 }, end: { x: 6000, y: 4000 } } },
        { type: "create_hosted", elementId: "win-raised", kind: "opening", openingType: "window", mark: "W-HI", hostId: "w-raised", s: 3000, side: 1, size: { widthMm: 1200, heightMm: 1200 }, values: { "architecture.window_partitioning": "DOUBLE_PANEL_HORIZONTAL" } },
        { type: "create_element", elementId: "w-door", levelId: "L1", kind: "wall", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 8000 }, end: { x: 6000, y: 8000 } } },
        { type: "create_hosted", elementId: "door-dbl", kind: "opening", openingType: "door", mark: "D-DBL", hostId: "w-door", s: 2000, side: -1, size: { widthMm: 1800, heightMm: 2100 }, values: { "architecture.door_operation": "DOUBLE_DOOR_SINGLE_SWING" } },
        { type: "create_hosted", elementId: "door-rhr", kind: "opening", openingType: "door", mark: "D-RHR", hostId: "w-door", s: 4500, side: -1, size: { widthMm: 900, heightMm: 2100 }, values: { "architecture.door_handing": "RHR" } },
      ]),
  );

  it("exports extruded 3D representations for columns, beams, pad footings, and raised-wall windows", () => {
    const res = exportIfc({ model, project: { id: "struct-test", name: "Structural Test" }, timeStamp: "2026-11-23T00:00:00" });
    expect(res.text).toContain("IFCCOLUMN");
    expect(res.text).toContain("IFCBEAM");
    expect(res.text).toContain("IFCFOOTING");
    expect(res.text).toContain("IFCEXTRUDEDAREASOLID");
    const lines = res.text.split("\n").filter((l) => l.includes("IFCCOLUMN(") || l.includes("IFCBEAM(") || l.includes("IFCFOOTING("));
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(line).toMatch(/#\d+,#\d+,/);
    }
    // Raised wall at Z = 1200 mm and hosted window at Z = 1200 + 900 = 2100 mm
    expect(res.text).toContain("IFCCARTESIANPOINT((0.,4000.,1200.))");
    expect(res.text).toContain("IFCCARTESIANPOINT((3000.,4000.,2100.))");
    // IFC4 OperationType & PartitioningType enums exported cleanly (including handing-resolved SINGLE_SWING_RIGHT) and type-inherited 600 mm footing depth.
    expect(res.text).toContain(".DOUBLE_DOOR_SINGLE_SWING.");
    expect(res.text).toContain(".SINGLE_SWING_RIGHT.");
    expect(res.text).toContain(".DOUBLE_PANEL_HORIZONTAL.");
    expect(res.text).toContain("600.");
  });
});
