/**
 * @jest-environment node
 *
 * Round 13 lane A13a: openings in IFC. Each door and window writes an
 * `IfcOpeningElement` that voids its wall (`IfcRelVoidsElement`) and that
 * the door or window fills (`IfcRelFillsElement`); a plain opening voids
 * only. Wall types become `IfcWallType` with their properties in
 * `Pset_WallCommon`. Read back, the walls and doors come in again, each door
 * in its wall.
 *
 * Fails on round 12's code: no opening elements or voids / fills were
 * written (and no command drew the walls).
 */
import { danglingReferences, importIfc } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { hostModel } from "./i9-fixtures";
import { exported, ofType, ref, text } from "./a13a-ifc-support";

const ROOM = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

function building() {
  const m = twoLevels();
  m.ok({ type: "create_element_type", typeId: "ext", name: "Exterior CMU", forKinds: ["wall"], values: { "architecture.is_external": true, "architecture.wall_function": "STANDARD" } });
  m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", typeId: "ext", size: { thicknessMm: 200, heightMm: 3000 }, points: ROOM, closed: true });
  m.ok({ type: "create_hosted", elementId: "d1", kind: "opening", openingType: "door", mark: "101", hostId: "w-1", s: 1500, side: 1, size: { widthMm: 900, heightMm: 2100 } });
  m.ok({ type: "create_hosted", elementId: "win1", kind: "opening", openingType: "window", mark: "W1", hostId: "w-2", s: 2000, side: 1, size: { widthMm: 1200, heightMm: 1200 } });
  m.ok({ type: "create_hosted", elementId: "o1", kind: "opening", openingType: "cased_opening", hostId: "w-3", s: 3000, side: 1, size: { widthMm: 1000, heightMm: 2100 } });
  return m.head;
}

describe("a13a ifc voids and fills", () => {
  it("writes an opening per void, voids from the host, fills by the door or window only", () => {
    const { file } = exported(building());
    expect(danglingReferences(file)).toEqual([]);
    expect(ofType(file, "IFCWALL")).toHaveLength(4);
    expect(ofType(file, "IFCOPENINGELEMENT")).toHaveLength(3);
    const voids = ofType(file, "IFCRELVOIDSELEMENT");
    const fills = ofType(file, "IFCRELFILLSELEMENT");
    expect(voids).toHaveLength(3);
    expect(fills).toHaveLength(2);
    const door = ofType(file, "IFCDOOR")[0];
    const window = ofType(file, "IFCWINDOW")[0];
    expect(door && window).toBeTruthy();
    const filled = fills.map((f) => ref(f, 5)).sort();
    expect(filled).toEqual([door?.id ?? 0, window?.id ?? 0].sort());
    for (const f of fills) expect(voids.map((v) => ref(v, 5))).toContain(ref(f, 4));
    const walls = new Set(ofType(file, "IFCWALL").map((w) => w.id));
    for (const v of voids) expect(walls.has(ref(v, 4))).toBe(true);
  });

  it("wall types are IfcWallType with Pset_WallCommon, assigned to their walls", () => {
    const { file } = exported(building());
    const types = ofType(file, "IFCWALLTYPE").filter((t) => text(t, 2) === "Exterior CMU");
    expect(types).toHaveLength(1);
    const pset = ofType(file, "IFCPROPERTYSET").find((p) => text(p, 2) === "Pset_WallCommon");
    expect(pset).toBeDefined();
    const props = ofType(file, "IFCPROPERTYSINGLEVALUE").filter((p) => text(p, 0) === "IsExternal");
    expect(props.length).toBeGreaterThan(0);
  });

  it("read back, the walls and the door and window come in, each in its wall", () => {
    const { text: ifc } = exported(building());
    const plan = importIfc(ifc, { model: hostModel(), referenceId: "ref", sourceKey: "v1", sourceId: "v1", label: "Round trip", disciplines: ["architecture"] });
    const walls = plan.records.filter((r) => r.kind === "wall");
    const openings = plan.records.flatMap((r) => (r.kind === "opening" ? [r] : []));
    expect(walls).toHaveLength(4);
    expect(openings.map((o) => o.openingType).sort()).toEqual(["door", "window"]);
    const wallIds = new Set(walls.map((w) => w.id));
    for (const o of openings) expect(wallIds.has(o.hostId)).toBe(true);
  });
});
