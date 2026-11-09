/**
 * @jest-environment node
 *
 * Round 13 lane A13a: `reference_plane`, a trade-neutral kernel kind. A
 * named vertical plane drawn as a line on a level: a datum tools snap to on
 * that level, never built, never scheduled (its row's nature is
 * `document`), taking no type and no values.
 *
 * Fails on round 12's code: the kind didn't exist (not in
 * `KERNEL_ELEMENT_KINDS`, no kernel row, no datum row) and nothing could
 * draw one.
 */
import { anchorOf, asElementId, canonicalJson, datumRow, datumSnapLines, ELEMENT_KINDS } from "../src";
import { isReferencePlane, referencePlaneLabel } from "../src/datums/reference-plane";
import { KERNEL_ELEMENT_KINDS } from "../src/registry/element-kinds";
import { kindRowOf } from "../src/kinds/rows";
import { twoLevels } from "./a13a-fixtures";

describe("a13a reference plane kind", () => {
  it("is a kernel kind with a document row, so it is never built or scheduled", () => {
    expect(KERNEL_ELEMENT_KINDS).toContain("reference_plane");
    expect(ELEMENT_KINDS).toContain("reference_plane");
    expect(kindRowOf("reference_plane")).toMatchObject({ kind: "reference_plane", label: "Reference plane", nature: "document" });
    expect(datumRow("reference_plane")?.label).toBe("Reference plane");
  });

  it("is drawn on a level, snaps only there, is anchored at its middle, and undo removes it", () => {
    const m = twoLevels();
    const before = canonicalJson(m.head.elements);
    const cs = m.ok({ type: "create_element", elementId: "rp-1", kind: "reference_plane", levelId: "L1", label: "Face of slab edge", placement: { kind: "line", start: { x: 0, y: 500 }, end: { x: 8000, y: 500 } } });
    const plane = m.head.elements["rp-1"];
    if (!isReferencePlane(plane)) throw new Error("not a reference plane");
    expect(plane).toEqual({ id: "rp-1", version: plane.version, authoredRev: plane.authoredRev, kind: "reference_plane", levelId: "L1", start: { x: 0, y: 500 }, end: { x: 8000, y: 500 }, name: "Face of slab edge" });
    expect(referencePlaneLabel(plane)).toBe("Face of slab edge");
    expect(anchorOf(plane)).toEqual({ x: 4000, y: 500 });
    expect(datumSnapLines(m.head, asElementId("L1"))).toEqual([{ datumId: "rp-1", label: "Face of slab edge", start: { x: 0, y: 500 }, end: { x: 8000, y: 500 } }]);
    expect(datumSnapLines(m.head, asElementId("L2"))).toEqual([]);
    m.ok({ type: "undo", revision: cs.revision });
    expect(canonicalJson(m.head.elements)).toBe(before);
  });

  it("takes no type and no values, and an unnamed one is shown by its id", () => {
    const m = twoLevels();
    m.ok({ type: "create_element_type", typeId: "t-1", name: "Generic" });
    const line = { kind: "line", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } };
    expect(m.refused({ type: "create_element", elementId: "rp", kind: "reference_plane", levelId: "L1", typeId: "t-1", placement: line })).toBe("A reference plane takes no type; leave the type out");
    expect(m.refused({ type: "create_element", elementId: "rp", kind: "reference_plane", levelId: "L1", values: { "zz.x": 1 }, placement: line })).toBe("A reference plane takes no values; leave them out");
    m.ok({ type: "create_element", elementId: "rp-2", kind: "reference_plane", levelId: "L2", placement: line });
    const plane = m.head.elements["rp-2"];
    expect(isReferencePlane(plane) && referencePlaneLabel(plane)).toBe("Reference plane rp-2");
  });
});
