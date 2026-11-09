/**
 * @jest-environment node
 *
 * i9-report and i9-unconverted-stay-linked: the report says, in a person's
 * words, what converted and what stays as the linked model and why, per
 * class; nothing that didn't convert becomes a record; the words name the
 * model and its disciplines and never assume who sent it.
 *
 * Fails on round 8b's code: there was no import and no report.
 */
import { importIfc } from "../src";
import { architectureAndStructure, hostModel, mechanicalAndSprinkler } from "./i9-fixtures";

const opts = (label: string, disciplines: readonly string[]) => ({ model: hostModel(), referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label, disciplines });

describe("i9-report", () => {
  it("one sentence of what converted and what stays linked", () => {
    const plan = importIfc(architectureAndStructure().text, opts("Main St shell", ["architecture", "structure"]));
    // Round 14: the Architecture add-on's import rules bring the roof and the stair in (a14-ifc-import-roof-stair).
    expect(plan.report.summary).toBe("Converted 2 walls, 1 door, 1 floor deck, 1 roof, 1 room, 1 stair, 1 steel beam and 1 steel column. Left 1 curtain wall as the linked model.");
    expect(plan.report).toMatchObject({ converted: 9, stayLinked: 1, levelsAdded: ["Level 2"], source: { label: "Main St shell", disciplines: ["architecture", "structure"] } });
    expect(plan.report.notes).toEqual(["Stair: the file doesn't say which end is its foot; check its UP arrow", "D-101: its swing and leaf style weren't brought in"]);
  });

  it("a mechanical + sprinkler model's sentence names its own things", () => {
    const plan = importIfc(mechanicalAndSprinkler().text, opts("Acme MEP", ["mechanical", "fire_sprinkler"]));
    expect(plan.report.summary).toBe("Converted 2 ducts and 1 air terminal. Left 2 fire suppression terminals and 1 pipe as the linked model.");
  });

  it("never says who sent the model, whatever its disciplines", () => {
    for (const plan of [importIfc(architectureAndStructure().text, opts("Shell", ["architecture"])), importIfc(mechanicalAndSprinkler().text, opts("MEP", ["mechanical"]))]) {
      const words = JSON.stringify(plan.report).toLowerCase();
      expect(words).not.toMatch(/architect\b|the architect|engineer's|designer's/);
    }
  });
});

describe("i9-unconverted-stay-linked", () => {
  it("a curtain wall with no shape stays linked with its reason and becomes no record; the roof and stair come in", () => {
    const plan = importIfc(architectureAndStructure().text, opts("Shell", ["architecture"]));
    const lines = Object.fromEntries(plan.report.classes.filter((c) => c.linked.length > 0).map((c) => [c.label, c.linked]));
    expect(lines).toEqual({
      "Curtain walls": [{ reason: "it has no shape of its own (its parts may come in on their own)", count: 1 }],
    });
    // Round 14: roofs and stairs convert through the Architecture add-on's import rules (round 13 left both linked).
    for (const classId of ["arch.roof", "arch.stair"]) expect(plan.report.classes.find((c) => c.classId === classId)).toMatchObject({ converted: 1, linked: [] });
    const imported = plan.records.filter((r) => typeof Reflect.get(r, "provenance") === "object");
    expect(imported).toHaveLength(9);
  });

  it("a wall that isn't one straight upright piece stays linked with the shape named, and its door with it", () => {
    // A wall clipped by another shape (under a sloped roof) and a door in it.
    const text = architectureAndStructure()
      .text.replace(/#(\d+)=IFCSHAPEREPRESENTATION\(#(\d+),'Body','SweptSolid',\(#(\d+)\)\);/, (_all, rep: string, ctx: string, item: string) => `#${rep}=IFCSHAPEREPRESENTATION(#${ctx},'Body','Clipping',(#9999));\n#9999=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#${item},#${item});`);
    const plan = importIfc(text, opts("Shell", ["architecture"]));
    const walls = plan.report.classes.find((c) => c.classId === "arch.wall");
    expect(walls).toMatchObject({ converted: 1, linked: [{ reason: "its shape is cut by another shape", count: 1 }] });
    expect(plan.report.classes.find((c) => c.classId === "arch.door")).toMatchObject({ converted: 0, linked: [{ reason: "the wall it is in stays on the linked model", count: 1 }] });
  });
});
