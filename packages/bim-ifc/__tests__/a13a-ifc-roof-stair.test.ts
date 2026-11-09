/**
 * @jest-environment node
 *
 * Round 13 lane A13a: roofs and stairs in IFC. A roof is an `IfcRoof`
 * aggregating its `IfcSlab` `ROOF` part; a stair is an `IfcStair`
 * (`STRAIGHT_RUN_STAIR`) aggregating an `IfcStairFlight` with its number of
 * risers and treads, riser height and tread length.
 *
 * Fails on round 12's code: there were no roof or stair kinds, classes or
 * relation rows.
 */
import { danglingReferences } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { exported, num, ofType, ref, refs, text } from "./a13a-ifc-support";

describe("a13a ifc roof and stair", () => {
  it("IfcRoof aggregates its ROOF slab; IfcStair aggregates its flight with risers and treads", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 10_000, y: 8000 }, { x: 0, y: 8000 }] } });
    m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6160, y: 0 } } });
    const { file } = exported(m.head);
    expect(danglingReferences(file)).toEqual([]);
    const roof = ofType(file, "IFCROOF")[0];
    const stair = ofType(file, "IFCSTAIR")[0];
    if (!roof || !stair) throw new Error("no roof or stair");
    expect(text(roof, 8)).toBe("FLAT_ROOF");
    expect(text(stair, 8)).toBe("STRAIGHT_RUN_STAIR");
    const roofSlab = ofType(file, "IFCSLAB").find((x) => text(x, 8) === "ROOF");
    const flight = ofType(file, "IFCSTAIRFLIGHT")[0];
    if (!roofSlab || !flight) throw new Error("no parts");
    const aggregates = ofType(file, "IFCRELAGGREGATES");
    expect(aggregates.some((a) => ref(a, 4) === roof.id && refs(a, 5).includes(roofSlab.id))).toBe(true);
    expect(aggregates.some((a) => ref(a, 4) === stair.id && refs(a, 5).includes(flight.id))).toBe(true);
    expect([num(flight, 8), num(flight, 9), text(flight, 12)]).toEqual([23, 22, "STRAIGHT"]);
    expect(num(flight, 10)).toBeCloseTo(4000 / 23, 3);
    expect(num(flight, 11)).toBeCloseTo(280, 3);
  });
});
