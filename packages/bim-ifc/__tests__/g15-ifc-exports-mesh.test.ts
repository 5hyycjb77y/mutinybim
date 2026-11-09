/**
 * @jest-environment node
 *
 * G15: IFC export writes a modeled part's real solid (a closed
 * IfcTriangulatedFaceSet of the same mesh the screen draws), not its feature
 * box. Fails on round 14: every part body was an IfcExtrudedAreaSolid box.
 */
import { MeshCache } from "@permitzip/bim-geometry";
import { DEFAULT_SETTINGS, executeCommand, exampleRooftopUnit, partMesh, setPartMeshProvider, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import { exported, ofType, ref, refs, text } from "./a13a-ifc-support";

function model(): ModelState {
  let m: ModelState = { modelId: "g15-ifc", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (command: Command) => {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  };
  run({ type: "create_level", levelId: "roof", name: "Roof", elevationMm: 7000 });
  run({ type: "place_part", partId: "rtu-1", typeId: "g15-rtu", partType: exampleRooftopUnit(), levelId: "roof", position: { x: 5000, y: 3000 }, mark: "RTU-1" });
  return m;
}

describe("g15-ifc-exports-mesh", () => {
  afterEach(() => setPartMeshProvider(null));

  it("a modeled part's body is its triangulated solid, every triangle of the mesh", async () => {
    setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
    const m = model();
    const { file } = exported(m);
    const faceSets = ofType(file, "IFCTRIANGULATEDFACESET");
    expect(faceSets).toHaveLength(1);
    const set = faceSets[0];
    if (!set) throw new Error("no face set");
    const type = m.elements["g15-rtu"];
    if (type?.kind !== "part_type") throw new Error("no type");
    expect(refs(set, 3)).toEqual([]);
    const tris = set.args[3];
    expect(tris?.kind === "list" ? tris.items.length : 0).toBe(partMesh(type.definition).triangleCount);
    const closed = set.args[1];
    expect(closed).toMatchObject({ kind: "enum", value: "T" });
    const points = file.entities.get(ref(set, 0));
    expect(points?.type).toBe("IFCCARTESIANPOINTLIST3D");
    const rep = ofType(file, "IFCSHAPEREPRESENTATION").find((r) => refs(r, 3).includes(set.id));
    expect(text(rep, 2)).toBe("Tessellation");
  });

  it("without the geometry engine it writes the box, and says so", async () => {
    await nodeManifoldEngine();
    const { file, text: step } = exported(model());
    expect(ofType(file, "IFCTRIANGULATEDFACESET")).toHaveLength(0);
    expect(ofType(file, "IFCEXTRUDEDAREASOLID").length).toBeGreaterThan(0);
    expect(step.length).toBeGreaterThan(0);
  });
});
