/**
 * @jest-environment node
 *
 * Round 7 lane Q: the kernel's own measure rules for its building classes,
 * and `qto.*` values reaching a schedule through the existing field
 * machinery.
 *
 * - A slab's area is net of its holes; its volume is area × thickness.
 * - A space's area comes from its outline; its volume needs a stated height.
 * - A beam's weight is its length × its type's weight per length; a
 *   column's is its type's unit weight; both count one each.
 * - A type edit (its weight) re-measures its instances on the next read.
 * - The `qto.area_net` field reads the same number a schedule column shows.
 *
 * Fails on the old code: no measure rules, no `qto.*` field provider.
 */
import { asElementId, fieldProviderRegistry, measuredValue, measureRuleFor, type BimElement, type ScheduleDefinitionV2 } from "../src";
import { buildRowSet } from "../src/schedules/engine";
import { FT, modelOf, openingRecord, rect, typeRecord, wallRecord } from "./q7-fixtures";

const SQ_FT = FT * FT;
const M2 = 1e6;
const P = { level: "Level 1", zone: "Z1", discipline: "architecture" } as const;

function record(fields: Record<string, unknown>): BimElement {
  const r: unknown = { version: 1, authoredRev: {}, partition: P, ...fields };
  return r as BimElement;
}

describe("q7 kernel measure rules", () => {
  it("a slab's area is net of its holes, and its volume is area × thickness", () => {
    const outline = rect(0, 0, 30 * FT, 20 * FT);
    const hole = rect(5 * FT, 5 * FT, 10 * FT, 10 * FT).reverse();
    const slab = record({ id: asElementId("s1"), kind: "slab", outline, thickness: 200, placement: { kind: "area", levelId: asElementId("lvl-1"), outline, holes: [hole], offsetMm: 0, vertical: "top" } });
    const m = modelOf([slab]);
    const area = ((30 * 20 - 5 * 5) * SQ_FT) / M2;
    expect(measureRuleFor(m.elements, slab)?.id).toBe("kernel.slab");
    expect(measuredValue(m.elements, "s1", "qto.area")).toBeCloseTo(area, 6);
    expect(measuredValue(m.elements, "s1", "qto.volume")).toBeCloseTo(area * 0.2, 6);
  });

  it("a space's area comes from its outline; volume only where its height is stated", () => {
    const tall = record({ id: asElementId("sp1"), kind: "space", number: "101", name: "Office", bounds: { kind: "outline", outline: rect(0, 0, 12 * FT, 10 * FT) }, ceilingHeightMm: 9 * FT });
    const unknown = record({ id: asElementId("sp2"), kind: "space", number: "102", name: "Storage", bounds: { kind: "outline", outline: rect(0, 0, 8 * FT, 10 * FT) } });
    const m = modelOf([tall, unknown]);
    const a1 = (12 * 10 * SQ_FT) / M2;
    expect(measuredValue(m.elements, "sp1", "qto.area")).toBeCloseTo(a1, 6);
    expect(measuredValue(m.elements, "sp1", "qto.volume")).toBeCloseTo((a1 * 9 * FT) / 1000, 6);
    expect(measuredValue(m.elements, "sp2", "qto.area")).toBeCloseTo((8 * 10 * SQ_FT) / M2, 6);
    expect(measuredValue(m.elements, "sp2", "qto.volume")).toBeNull();
  });

  it("weight comes from the type: beams by length, columns per piece; a type edit re-measures", () => {
    const beamType = typeRecord("t-beam", "W12x26", { forKinds: ["beam"], values: { "qto.mass_per_length": 38.7 } });
    const colType = typeRecord("t-col", "HSS6x6", { forKinds: ["column"], values: { "qto.unit_mass": 140 } });
    const beam = record({ id: asElementId("b1"), kind: "beam", sectionName: "W12x26", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, typeId: asElementId("t-beam") });
    const col = record({ id: asElementId("c1"), kind: "column", material: "steel", position: { x: 0, y: 0 }, size: { x: 152, y: 152 }, typeId: asElementId("t-col") });
    const m = modelOf([beamType, colType, beam, col]);
    const len = (20 * FT) / 1000;
    expect(measuredValue(m.elements, "b1", "qto.length")).toBeCloseTo(len, 6);
    expect(measuredValue(m.elements, "b1", "qto.mass")).toBeCloseTo(len * 38.7, 6);
    expect(measuredValue(m.elements, "c1", "qto.count")).toBe(1);
    expect(measuredValue(m.elements, "c1", "qto.mass")).toBe(140);
    // The type gets heavier; the beam record is the same object, its weight follows.
    const heavier: Record<string, BimElement> = { ...m.elements, "t-beam": typeRecord("t-beam", "W12x26", { forKinds: ["beam"], values: { "qto.mass_per_length": 50 } }) };
    expect(heavier.b1).toBe(m.elements.b1);
    expect(measuredValue(heavier, "b1", "qto.mass")).toBeCloseTo(len * 50, 6);
  });

  it("qto.* values reach a schedule through the field machinery", () => {
    const m = modelOf([wallRecord("w1", { x: 0, y: 0 }, { x: 20 * FT, y: 0 }), openingRecord("d1", "w1", "door", 3 * FT, 7 * FT)]);
    const def: ScheduleDefinitionV2 = {
      name: "Walls",
      source: { kind: "classes", classes: ["arch.wall"], includeSubclasses: true },
      columns: [{ id: "qto.area_net", kind: "field", path: "qto.area_net", heading: "NET AREA" }, { id: "qto.measured_from", kind: "field", path: "qto.measured_from", heading: "MEASURED FROM" }],
      filters: [],
      sort: [],
      groups: [],
      grandTotals: false,
      itemize: true,
      presentation: { kind: "list" },
      display: { textSizeMm: 2.5, emptyText: "NONE" },
    };
    const rows = buildRowSet(m, def, { viewId: "q7-walls", revision: 0, registry: fieldProviderRegistry() });
    expect(rows.rowCount).toBe(1);
    const net = (20 * 10 - 3 * 7) * (SQ_FT / M2);
    expect(measuredValue(m.elements, "w1", "qto.area_net")).toBeCloseTo(net, 6);
    expect(rows.elementIds).toEqual(["w1"]);
    expect(rows.columns[0]).toMatchObject({ valueType: "quantity", quantityKind: "area", unit: "m2", source: { label: "Net face area" } });
    expect(rows.columns[1]).toMatchObject({ valueType: "text", source: { label: "Measured from" } });
  });
});
