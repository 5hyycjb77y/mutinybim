/**
 * @jest-environment node
 *
 * Round 14 lane K14 (step 5 close-out): the built-in classes Mechanical
 * equipment and Air terminals no longer name Mechanical's record kinds. The
 * kind rows say which built-in class their records are (`classId`), and the
 * registry joins them to that class's recognition, ahead of its part
 * categories, so with Mechanical installed the rule is round 13's, byte for
 * byte, and every record lists the same classes.
 *
 * Fails on round 13: the kernel's rows named `equipment` / `terminal`
 * themselves, so a registry built from no kind rows still recognised them,
 * and Mechanical's rows carried no `classId`.
 */
import { builtinRegistry, builtinRegistryBuilder, canonicalJson, elementKindRowProblems, firstPartyKindClassRows } from "../src";

const ROUND13 = {
  "mep.mechanical_equipment": { elementKinds: ["equipment"], partCategories: ["mechanical_equipment"] },
  "mep.air_terminal": { elementKinds: ["terminal"], partCategories: ["air_terminal"] },
} as const;

describe("k14 kind rows name their built-in class", () => {
  it("with Mechanical installed, both classes recognise exactly what round 13's rows did", () => {
    const registry = builtinRegistry();
    for (const [id, rule] of Object.entries(ROUND13)) expect(canonicalJson(registry.getClass(id)?.recognize)).toBe(canonicalJson(rule));
    expect(firstPartyKindClassRows().map((r) => [r.kind, r.classId])).toEqual(expect.arrayContaining([["equipment", "mep.mechanical_equipment"], ["terminal", "mep.air_terminal"]]));
  });

  it("the kernel's own rows recognise only part categories; the kinds come from the rows", () => {
    const bare = builtinRegistryBuilder({}, []).build();
    expect(bare.getClass("mep.mechanical_equipment")?.recognize).toEqual({ partCategories: ["mechanical_equipment"] });
    expect(bare.getClass("mep.air_terminal")?.recognize).toEqual({ partCategories: ["air_terminal"] });
    const listed = bare.listClasses().map((c) => c.id);
    expect(builtinRegistry().listClasses().map((c) => c.id)).toEqual(listed);
  });

  it("an empty class face is refused in words", () => {
    expect(elementKindRowProblems([{ kind: "zz.vent", label: "Vent", classId: " " }], new Set())).toContain("element kind zz.vent: classId is empty");
  });
});
