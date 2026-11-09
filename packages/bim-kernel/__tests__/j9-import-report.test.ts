/**
 * @jest-environment node
 *
 * Round 9 lane J9: the part-import report. Before a part type is saved it
 * lists every bad connector (no size, pointing nowhere or into the part, no
 * system, no end type where the add-ons declare end types for its domain,
 * an end type nobody declares or one made for another domain), each with the
 * connector named and a next step. Saving is still allowed (Product decision, Nov 1):
 * the Revit converter keeps a type whose export gives an opening no size,
 * with the report attached. Fails on round 8b's code: no report exists and
 * that type failed to convert at all.
 */
import { convertRevitType, partTypeImportReport, type PartTypeDefinition, type RevitTypeRecord } from "@permitzip/bim-kernel";
import { straightPiece } from "./fixtures/j9-pieces";

function withConnectors(def: PartTypeDefinition, patch: (c: PartTypeDefinition["connectors"][number]) => PartTypeDefinition["connectors"][number]): PartTypeDefinition {
  return { ...def, connectors: def.connectors.map(patch) };
}

describe("j9-import-report", () => {
  it("a clean type with end types reports nothing", () => {
    const report = partTypeImportReport(straightPiece("Clean", { endType: "mechanical.slip" }));
    expect(report).toEqual({ familyName: "J9 straight", typeName: "Clean", connectorCount: 2, problems: [] });
  });

  it("names each bad connector with a next step", () => {
    const def = withConnectors(straightPiece("Bad"), (c) =>
      c.id === "a" ? { ...c, systemKind: "other" } : { ...c, domain: "pipe", systemKind: "domestic_cold_water", endType: "mechanical.slip", direction: [0, 0, 0] },
    );
    const report = partTypeImportReport(def);
    const rows = report.problems.map((p) => [p.connectorLabel, p.check, p.message, p.nextStep]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["In", "no_service", "In carries no system", "Choose the system In carries"],
        ["In", "no_end_type", "In has no end type", "Choose In's end type (slip, flanged or formed flange (TDC / TDF))"],
        ["Out", "wrong_facing", "Out points nowhere (its direction is zero)", "Set Out's direction to point out of the part"],
        ["Out", "end_type_wrong_domain", "Out takes pipe, but a slip end is made for duct", "Choose an end type made for pipe"],
      ]),
    );
  });

  it("an end type no add-on declares is kept and reported", () => {
    const report = partTypeImportReport(straightPiece("Odd", { endType: "firm.mystery_end" }));
    expect(report.problems.map((p) => p.check)).toEqual(["unknown_end_type", "unknown_end_type"]);
  });

  it("a connector facing into the part is reported from its placement check", () => {
    const def = withConnectors(straightPiece("Inward", { endType: "mechanical.slip" }), (c) => (c.id === "b" ? { ...c, direction: [-1, 0, 0] } : c));
    expect(partTypeImportReport(def).problems.map((p) => [p.connectorLabel, p.check])).toEqual([["Out", "wrong_facing"]]);
  });

  it("the Revit converter keeps a type whose export gives an opening no size, with the report attached", () => {
    const record: RevitTypeRecord = { id: 1, category: "Mechanical Equipment", builtInCategory: "OST_MechanicalEquipment", family: "J9 Fan", typeName: "Small", parameters: [] };
    const result = convertRevitType(record, {
      point: [0, 0, 0],
      rotation: 0,
      bbox: { min: [-1, -1, 0], max: [1, 1, 1] },
      connectors: [
        { domain: "HVAC", shape: "Round", origin: [1, 0, 0.5], direction: [1, 0, 0], radius: null },
        { domain: "HVAC", shape: "Round", origin: [-1, 0, 0.5], direction: [-1, 0, 0], radius: 0.5 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.connectors.map((c) => c.shape)).toEqual(["none", "round"]);
    const checks = result.report.problems.map((p) => [p.connectorLabel, p.check]);
    expect(checks).toContainEqual(["Duct 1", "converted_without_size"]);
    expect(checks).toContainEqual(["Duct 2", "no_end_type"]);
    expect(result.report.problems.find((p) => p.check === "converted_without_size")?.message).toBe("Duct 1 is round in the export, but the export gives no size; it was kept with no size");
  });
});
