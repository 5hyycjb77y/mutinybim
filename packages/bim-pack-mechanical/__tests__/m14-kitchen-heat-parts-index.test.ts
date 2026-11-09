/**
 * @jest-environment node
 *
 * Round 14 lane M14 step 2: kitchen heat reads the parts a space holds, not
 * every part in the model. The model's parts-by-space read (`modelSpaceParts`,
 * requirements/locator.ts) follows each edit: a fryer moved from the kitchen to
 * the office moves with it, a space drawn later claims what stands in it. The
 * heat-gain need says "Kitchen heat 16,600 Btu/h (firm table)" (or project), or
 * where to add the table; the equipment list's Heat gain cell reads the same
 * table for a pasted row and for a placed part.
 *
 * Fails on round 13: `SpaceLocator.partsIn`, `modelSpaceParts`,
 * `facets/heat-gain-row.ts` and `kitchenHeatOfPart` did not exist, and
 * `kitchenAppliancesIn` asked `spaceOf` for every part in the model; and the
 * appliance and damper parameter names had a dot, so `place_part` refused
 * every such type (no real model could carry one).
 */
import { fixedSpaceLocator, modelSpaceParts, withModelSpaceParts, modelSpaceLocator, asElementId, type PartTypeDefinition } from "@permitzip/bim-kernel";
import type { LookupTable } from "@permitzip/bim-kernel/policy";
import { Log, twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { KITCHEN_APPLIANCE_PARAM, KITCHEN_HEAT_TABLE_SLOT, KITCHEN_HOODED_PARAM, kitchenAppliancesIn } from "../src/heat-gain/kitchen";
import { KITCHEN_HEAT_ADD_TABLE, draftHeatGainCell, partHeatGainCell, spaceHeatGainNeed } from "../src/facets/heat-gain-row";
import { damperType } from "./m14-fixtures";

const FRYER: PartTypeDefinition = {
  familyName: "Kitchen appliance",
  typeName: "Fryer 40 lb",
  category: "mechanical_equipment",
  typeParams: [
    { name: KITCHEN_APPLIANCE_PARAM, label: "Kitchen appliance", kind: "text" },
    { name: KITCHEN_HOODED_PARAM, label: "Under a hood", kind: "boolean" },
  ],
  typeValues: { [KITCHEN_APPLIANCE_PARAM]: "Fryer", [KITCHEN_HOODED_PARAM]: true },
  instanceParams: [],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 800, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 800] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

const FIRM: LookupTable = {
  id: "firm-kitchen-heat",
  slot: KITCHEN_HEAT_TABLE_SLOT,
  name: "Kitchen heat 2026",
  columns: [
    { key: "appliance", label: "Appliance" },
    { key: "hooded", label: "Hooded" },
    { key: "sensible_btuh", label: "Sensible", unit: "Btu/h" },
    { key: "latent_btuh", label: "Latent", unit: "Btu/h" },
  ],
  rows: [
    ["Fryer", "yes", 14500, 2100],
    ["Fryer", "no", 22000, 9000],
  ],
  citation: { source: "Firm kitchen heat data", edition: "2026" },
};

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const K104 = asElementId("k104");
const OFFICE = asElementId("o105");

function kitchen(): Log {
  const m = twoLevels("m14-kitchen");
  m.ok({ type: "create_space", spaces: [{ spaceId: K104, number: "104", name: "Kitchen", levelId: "L1", outline: rect(0, 0, 6000, 5000) }, { spaceId: OFFICE, number: "105", name: "Office", levelId: "L1", outline: rect(7000, 0, 12000, 5000) }] });
  m.ok({ type: "place_part", partId: "fr-1", typeId: "t-fryer", partType: FRYER, levelId: "L1", position: { x: 2000, y: 2000 }, mark: "FR-1" });
  return m;
}

describe("m14 kitchen heat reads the parts a space holds", () => {
  it("the model's parts by space follow a move and a newly drawn space", () => {
    const m = kitchen();
    expect(modelSpaceParts(m.head.elements, K104)).toEqual(["fr-1"]);
    expect(modelSpaceParts(m.head.elements, OFFICE)).toEqual([]);
    m.ok({ type: "move_elements", ids: ["fr-1"], delta: { x: 7000, y: 0 } });
    expect(modelSpaceParts(m.head.elements, K104)).toEqual([]);
    expect(modelSpaceParts(m.head.elements, OFFICE)).toEqual(["fr-1"]);
    m.ok({ type: "create_space", spaces: [{ spaceId: "pantry", number: "106", name: "Pantry", levelId: "L1", outline: rect(8000, 1000, 10000, 3000) }] });
    expect(modelSpaceParts(m.head.elements, asElementId("pantry"))).toEqual(["fr-1"]);
    expect(modelSpaceParts(m.head.elements, OFFICE)).toEqual([]);
  });

  it("reads the locator's parts in the space and never asks every part where it is", () => {
    const m = kitchen();
    const base = withModelSpaceParts(m.head.elements, modelSpaceLocator(m.head.elements));
    const spaceOf = jest.fn(base.spaceOf);
    const appliances = kitchenAppliancesIn(m.head.elements, K104, { ...base, spaceOf });
    expect(appliances.map((a) => a.mark)).toEqual(["FR-1"]);
    expect(spaceOf).not.toHaveBeenCalled();
    const fixed = fixedSpaceLocator({ spaceOf: { "fr-1": K104 } });
    expect(fixed.partsIn?.(K104)).toEqual(["fr-1"]);
  });

  it("the space's heat-gain need: the table's heat in one line, or where to add the table", () => {
    const m = kitchen();
    const heat = spaceHeatGainNeed(m.head.elements, K104, { firm: [FIRM] });
    expect(heat?.serviceLabel).toBe("Heat gain");
    expect(heat?.line).toBe("Kitchen heat 16,600 Btu/h (firm table)");
    expect(heat?.detail).toBe("Kitchen equipment: 14,500 Btu/h sensible, 2,100 latent (firm table 'Kitchen heat 2026', row Fryer, hooded); Firm kitchen heat data, 2026");
    expect(heat?.partIds).toEqual(["fr-1"]);
    const project: LookupTable = { ...FIRM, id: "proj", name: "Project kitchen heat", rows: [["Fryer", "yes", 10000, 1000]] };
    expect(spaceHeatGainNeed(m.head.elements, K104, { firm: [FIRM], project: [project] })?.line).toBe("Kitchen heat 11,000 Btu/h (project table)");
    const none = spaceHeatGainNeed(m.head.elements, K104, {});
    expect(none?.state).toBe("needs_table");
    expect(none?.line).toBe(KITCHEN_HEAT_ADD_TABLE);
    expect(KITCHEN_HEAT_ADD_TABLE).toBe("Add a kitchen heat table in the firm library › Lookup tables");
    expect(none?.total).toBeUndefined();
    expect(spaceHeatGainNeed(m.head.elements, OFFICE, { firm: [FIRM] })).toBeNull();
  });

  it("an appliance and a damper type can be placed through place_part; a record with round 13's dotted names still reads", () => {
    const m = kitchen();
    expect(m.submit({ type: "place_part", partId: "fd-1", typeId: "t-fd", partType: damperType("fire"), levelId: "L1", position: { x: 500, y: 500 } }).ok).toBe(true);
    const fr = m.head.elements["t-fryer"];
    if (fr?.kind !== "part_type") throw new Error("no fryer type");
    const legacy = { ...fr, definition: { ...fr.definition, typeParams: [{ name: "mechanical.kitchen_appliance", label: "Kitchen appliance", kind: "text" as const }, { name: "mechanical.hooded", label: "Under a hood", kind: "boolean" as const }], typeValues: { "mechanical.kitchen_appliance": "Fryer", "mechanical.hooded": true } } };
    const elements = { ...m.head.elements, "t-fryer": legacy };
    expect(kitchenAppliancesIn(elements, K104, fixedSpaceLocator({ spaceOf: { "fr-1": K104 } }))).toEqual([{ partId: "fr-1", mark: "FR-1", appliance: "Fryer", hooded: true }]);
  });

  it("the equipment list's Heat gain cell, for a placed part and for a pasted row", () => {
    const m = kitchen();
    expect(partHeatGainCell(m.head.elements, asElementId("fr-1"), { firm: [FIRM] })).toEqual({ text: "16,600 Btu/h (14,500 sensible, 2,100 latent)", title: "Firm table 'Kitchen heat 2026', row Fryer, hooded" });
    expect(partHeatGainCell(m.head.elements, asElementId("fr-1"), {})).toEqual({ text: "Needs a kitchen heat table", title: KITCHEN_HEAT_ADD_TABLE });
    expect(draftHeatGainCell("Fryer, gas, hooded", { firm: [FIRM] })?.text).toBe("16,600 Btu/h");
    expect(draftHeatGainCell("Fryer, gas, not hooded", { firm: [FIRM] })?.text).toBe("31,000 Btu/h");
    expect(draftHeatGainCell("Fryer, gas", { firm: [FIRM] })?.text).toBe("Say hooded or not hooded");
    expect(draftHeatGainCell("Dishwasher, door type", { firm: [FIRM] })).toBeNull();
    expect(draftHeatGainCell("Fryer, gas, hooded", {})).toBeNull();
  });
});
