/**
 * @jest-environment node
 *
 * Verifies clash detection (`bim-lint`) vertical spans and rotated prisms for
 * columns and offset walls.
 */
import { DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { elementShape } from "../src";

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

describe("bim-lint column vertical spans and offset wall shapes", () => {
  const model = withUpgradePolicy(
    () => true,
    () =>
      run({ modelId: "lint-cols", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS }, [
        { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
        { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: Math.round(12 * FT) },
        { type: "create_level", levelId: "ROOF", name: "Roof", elevationMm: Math.round(24 * FT) },
        { type: "create_element", elementId: "col-short", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 0, y: 0 }, rotationDeg: 30 }, size: { widthMm: 254, depthMm: 254, heightMm: 2000 }, baseOffsetMm: 100, values: { "struct.section": "W10x33", mark: "CS1" } },
        { type: "create_element", elementId: "col-tall", levelId: "L1", kind: "column", classId: "struct.column_steel", material: "steel", placement: { kind: "point", position: { x: 4000, y: 0 } }, size: { widthMm: 254, depthMm: 254 }, topLevelId: "ROOF", topOffsetMm: -200, values: { "struct.section": "W10x33", mark: "CT1" } },
        { type: "create_element", elementId: "w-raised", levelId: "L1", kind: "wall", baseOffsetMm: 1200, size: { thicknessMm: 200, heightMm: 2400 }, placement: { kind: "line", start: { x: 0, y: 3000 }, end: { x: 4000, y: 3000 } } },
        { type: "create_element", elementId: "bm-deep", levelId: "L2", kind: "beam", classId: "struct.beam_steel", label: "W24x55", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }, values: { "struct.section": "W24x55" } },
        { type: "set_element_placement", elementId: "bm-deep", placement: { kind: "line", levelId: "L2", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, startOffsetMm: 0, endOffsetMm: 600, lateral: "center", vertical: "top" } },
      ]),
  );

  it("computes exact rotated prism and vertical Z bounds for columns, offset walls, and deep/sloped steel beams", () => {
    const shortShape = elementShape(model.elements, model.elements["col-short"]!, () => 0);
    expect(shortShape).not.toBeNull();
    expect(shortShape?.box.min.z).toBeCloseTo(100, 0);
    expect(shortShape?.box.max.z).toBeCloseTo(2100, 0);
    expect(shortShape?.pieces().length).toBe(1);

    const tallShape = elementShape(model.elements, model.elements["col-tall"]!, () => 0);
    expect(tallShape).not.toBeNull();
    expect(tallShape?.box.min.z).toBeCloseTo(0, 0);
    expect(tallShape?.box.max.z).toBeCloseTo(Math.round(24 * FT) - 200, 0);

    const wallShape = elementShape(model.elements, model.elements["w-raised"]!, () => 0);
    expect(wallShape).not.toBeNull();
    expect(wallShape?.box.min.z).toBeCloseTo(1200, 0);
    expect(wallShape?.box.max.z).toBeCloseTo(3600, 0);

    // Sloped W24x55 beam (depth ~599.44 mm) rising 600 mm from L2: spans [L2 - 599.44, L2 + 600]
    const l2 = Math.round(12 * FT);
    const beamShape = elementShape(model.elements, model.elements["bm-deep"]!, () => l2);
    expect(beamShape).not.toBeNull();
    expect(beamShape!.box.min.z).toBeCloseTo(l2 - 599.44, 0);
    expect(beamShape!.box.max.z).toBeCloseTo(l2 + 600, 0);
  });
});
