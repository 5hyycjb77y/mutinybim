/**
 * @jest-environment node
 *
 * Round 13 lane M13 (M12 step 2): kitchen equipment heat onto the space it
 * stands in. A hooded fryer in Kitchen 104 adds the firm table's sensible and
 * latent heat to the space, with the table's name and row in the words. With
 * no table the space gets "Can't add kitchen heat yet: add a kitchen heat
 * table in Library › Lookup tables" and no number. A project table wins over
 * the firm's; an appliance the table has no row for says which row to add.
 * The numbers here are the test's own; the add-on ships no table.
 *
 * Fails on round 12's code: there was no kitchen heat path (no
 * `heat-gain/kitchen.ts`, no lookup table library item).
 */
import { asElementId, fixedSpaceLocator, type BimElement, type PartTypeDefinition } from "@permitzip/bim-kernel";
import type { LookupTable } from "@permitzip/bim-kernel/policy";
import { to } from "@permitzip/bim-units";
import { KITCHEN_APPLIANCE_PARAM, KITCHEN_HEAT_NEEDS_TABLE, KITCHEN_HEAT_TABLE_SLOT, KITCHEN_HOODED_PARAM, kitchenHeatOfSpace } from "../src/heat-gain/kitchen";

const base = { version: 1, authoredRev: {} } as const;

const applianceType = (id: string, typeName: string, appliance: string): BimElement => {
  const definition: PartTypeDefinition = {
    familyName: "Kitchen appliance",
    typeName,
    category: "mechanical_equipment",
    typeParams: [{ name: KITCHEN_APPLIANCE_PARAM, label: "Kitchen appliance", kind: "text" }],
    typeValues: { [KITCHEN_APPLIANCE_PARAM]: appliance },
    instanceParams: [{ name: KITCHEN_HOODED_PARAM, label: "Under a hood", kind: "boolean" }],
    tagFields: [],
    geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 800, 900] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [600, 800] }],
    connectors: [],
    source: { kind: "builtin", libraryVersion: "test" },
  };
  return { ...base, id, kind: "part_type", definition } as unknown as BimElement;
};

const part = (id: string, typeId: string, mark: string, hooded: boolean): BimElement =>
  ({ ...base, id, kind: "part", typeId, levelId: "L1", position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark, values: { [KITCHEN_HOODED_PARAM]: hooded } }) as unknown as BimElement;

const elements: Record<string, BimElement> = {
  "t-fryer": applianceType("t-fryer", "Fryer 40 lb", "Fryer"),
  "t-range": applianceType("t-range", "Range 6 burner", "Range"),
  "fr-1": part("fr-1", "t-fryer", "FR-1", true),
  "rg-1": part("rg-1", "t-range", "RG-1", true),
};
const K104 = asElementId("kitchen-104");
const inKitchen = fixedSpaceLocator({ spaceOf: { "fr-1": K104 } });
const both = fixedSpaceLocator({ spaceOf: { "fr-1": K104, "rg-1": K104 } });

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

describe("m12 kitchen heat on the space", () => {
  it("a hooded fryer adds the firm table's sensible and latent heat, naming the table and row", () => {
    const heat = kitchenHeatOfSpace(elements, K104, inKitchen, { firm: [FIRM] });
    if (heat.kind !== "heat") throw new Error(`expected heat, got ${heat.kind}`);
    expect(to(heat.sensible, "Btu/h")).toBeCloseTo(14500, 6);
    expect(to(heat.latent, "Btu/h")).toBeCloseTo(2100, 6);
    expect(heat.message).toBe("Kitchen equipment: 14,500 Btu/h sensible, 2,100 latent (firm table 'Kitchen heat 2026', row Fryer, hooded)");
    expect(heat.table.citation).toBe("Firm kitchen heat data, 2026");
    expect(heat.missing).toEqual([]);
  });

  it("with no table the finding says what to add and gives no number", () => {
    const heat = kitchenHeatOfSpace(elements, K104, inKitchen, {});
    expect(heat).toEqual({ kind: "needs_table", spaceId: K104, appliances: [{ partId: "fr-1", mark: "FR-1", appliance: "Fryer", hooded: true }], message: KITCHEN_HEAT_NEEDS_TABLE });
    expect(KITCHEN_HEAT_NEEDS_TABLE).toBe("Can't add kitchen heat yet: add a kitchen heat table in Library › Lookup tables");
  });

  it("a project table wins over the firm's; an appliance with no row says which row to add", () => {
    const project: LookupTable = { ...FIRM, id: "proj", name: "Project kitchen heat", rows: [["Fryer", "yes", 10000, 1000]] };
    const heat = kitchenHeatOfSpace(elements, K104, both, { firm: [FIRM], project: [project] });
    if (heat.kind !== "heat") throw new Error(`expected heat, got ${heat.kind}`);
    expect(to(heat.sensible, "Btu/h")).toBeCloseTo(10000, 6);
    expect(heat.missing).toEqual([{ partId: "rg-1", message: "RG-1 (Range, hooded) has no row in 'Project kitchen heat': add a Range row to the table" }]);
  });

  it("a space with no kitchen appliances gets nothing", () => {
    expect(kitchenHeatOfSpace(elements, asElementId("office-101"), inKitchen, { firm: [FIRM] }).kind).toBe("none");
  });
});
