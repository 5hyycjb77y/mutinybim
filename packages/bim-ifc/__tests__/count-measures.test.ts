/**
 * @jest-environment node
 *
 * A count is written as the integer IFC 4.3 says it is. IfcCountMeasure was a
 * number in IFC 4 and is an INTEGER in IFC 4.3; exportIfc wrote
 * `IFCCOUNTMEASURE(30.)`, which a strict reader rejects (IfcOpenShell 0.9.0
 * flags it on the electrical-room example). A count that isn't a whole number
 * can't be an IfcCountMeasure, so it keeps its value as a plain real.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc } from "../src";
import { PropertyBag, writeSets } from "../src/properties";
import { StepGraph, stepValue } from "../src/step";
import { UnitSet } from "../src/units";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";

/** The STEP text of every entity a bag writes, one per line. */
function written(fill: (bag: PropertyBag) => void): string[] {
  const g = new StepGraph();
  const bag = new PropertyBag();
  fill(bag);
  writeSets(g, new UnitSet(), bag, (name) => name);
  return g.all().map((e) => `${e.type}(${e.attrs.map(stepValue).join(",")})`);
}

describe("counts in IFC 4.3", () => {
  it("writes a whole count as an integer, in a property and in a quantity", () => {
    const lines = written((bag) => {
      bag.set("Pset_Test", { kind: "number", name: "Circuits", value: 30, unit: "ea" });
      bag.set("Pset_Test", { kind: "number", name: "None", value: 0, unit: "ea" });
      bag.quantity("Qto_Test", { kind: "number", name: "Count", value: 4, unit: "ea" });
    });
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('Circuits',$,IFCCOUNTMEASURE(30),$)");
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('None',$,IFCCOUNTMEASURE(0),$)");
    expect(lines).toContain("IFCQUANTITYCOUNT('Count',$,$,4,$)");
  });

  it("keeps a count that isn't whole as a plain number, never rounded", () => {
    const lines = written((bag) => {
      bag.set("Pset_Test", { kind: "number", name: "Occupants", value: 12.5, unit: "ea" });
      bag.quantity("Qto_Test", { kind: "number", name: "Count", value: 2.5, unit: "ea" });
    });
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('Occupants',$,IFCREAL(12.5),$)");
    expect(lines).toContain("IFCQUANTITYNUMBER('Count',$,$,2.5,$)");
    expect(lines.some((l) => l.includes("IFCCOUNTMEASURE") || l.startsWith("IFCQUANTITYCOUNT"))).toBe(false);
  });

  it.each([1e21, 1e22, 1.5e300])("writes a count of %p, too large to be exact, as a STEP real", (value) => {
    const lines = written((bag) => {
      bag.set("Pset_Test", { kind: "number", name: "Occupants", value, unit: "ea" });
      bag.quantity("Qto_Test", { kind: "number", name: "Count", value, unit: "ea" });
    });
    // Never JavaScript's own exponent form (1e+21), which is neither a STEP integer nor a STEP real.
    for (const line of lines) expect(line).not.toMatch(/\de\+?\d/);
    expect(lines.some((l) => l.includes("IFCCOUNTMEASURE") || l.startsWith("IFCQUANTITYCOUNT"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("IFCPROPERTYSINGLEVALUE('Occupants',$,IFCREAL(") || l.startsWith("IFCQUANTITYNUMBER('Count',"))).toHaveLength(2);
  });

  it("writes a negative count as a number, since a quantity count can't be below zero", () => {
    const lines = written((bag) => {
      bag.set("Pset_Test", { kind: "number", name: "Change", value: -2, unit: "ea" });
      bag.quantity("Qto_Test", { kind: "number", name: "Count", value: -2, unit: "ea" });
    });
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('Change',$,IFCCOUNTMEASURE(-2),$)");
    expect(lines).toContain("IFCQUANTITYNUMBER('Count',$,$,-2.,$)");
  });

  it("leaves every other measure a real, with its decimal point", () => {
    const lines = written((bag) => {
      bag.set("Pset_Test", { kind: "number", name: "Rating", value: 20, unit: "A" });
      bag.set("Pset_Test", { kind: "number", name: "Plain", value: 3 });
      bag.quantity("Qto_Test", { kind: "number", name: "Length", value: 1200, unit: "mm" });
    });
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('Rating',$,IFCELECTRICCURRENTMEASURE(20.),$)");
    expect(lines).toContain("IFCPROPERTYSINGLEVALUE('Plain',$,IFCREAL(3.),$)");
    expect(lines).toContain("IFCQUANTITYLENGTH('Length',$,$,1200.,$)");
  });

  it("electrical-room: the panel's circuit count is an integer in the file", async () => {
    const features = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
    const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    const out = await runScript(electricalRoom, { slice: sliceModel(m.head, electricalRoom.manifest.reads, [], features), values: {}, scriptHash: "sha256:count-measures" });
    if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
    for (const batch of out.batches) m.ok(batch);
    const model: ModelState = m.head;
    const { text } = exportIfc({ model, project: { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" }, timeStamp: "2026-11-12T00:00:00" });
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Circuits',$,IFCCOUNTMEASURE(30),$)");
    // No count anywhere in the file is written with a decimal point.
    expect(text.match(/IFCCOUNTMEASURE\([^)]*\.[^)]*\)/g) ?? []).toEqual([]);
  });
});
