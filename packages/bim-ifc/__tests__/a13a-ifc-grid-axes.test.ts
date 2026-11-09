/**
 * @jest-environment node
 *
 * Round 13 lane A13a: grids in IFC as one `IfcGrid` with its lines as
 * `IfcGridAxis` in the U family (lines running up the plan) and the V
 * family (across), each with its tag, contained in the lowest storey.
 *
 * Fails on round 12's code: grid lines were skipped by the exporter.
 */
import { danglingReferences } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { exported, ofType, refs, text } from "./a13a-ifc-support";

describe("a13a ifc grid axes", () => {
  it("one IfcGrid, U axes 1 and 2, V axes A and B, with tags", () => {
    const m = twoLevels();
    for (const [i, x] of [0, 6000].entries()) m.ok({ type: "create_element", elementId: `u${i}`, kind: "grid", levelId: "L1", placement: { kind: "line", start: { x, y: -1000 }, end: { x, y: 9000 } } });
    for (const [i, y] of [0, 8000].entries()) m.ok({ type: "create_element", elementId: `v${i}`, kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: -1000, y }, end: { x: 7000, y } } });
    const { file } = exported(m.head);
    expect(danglingReferences(file)).toEqual([]);
    const grids = ofType(file, "IFCGRID");
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    if (!grid) throw new Error("no grid");
    const tag = (id: number) => text(file.entities.get(id), 0);
    expect(refs(grid, 7).map(tag)).toEqual(["1", "2"]);
    expect(refs(grid, 8).map(tag)).toEqual(["A", "B"]);
    expect(ofType(file, "IFCGRIDAXIS")).toHaveLength(4);
    const contained = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").filter((r) => refs(r, 4).includes(grid.id));
    expect(contained).toHaveLength(1);
  });
});
