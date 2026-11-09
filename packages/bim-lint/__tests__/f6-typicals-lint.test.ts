/**
 * @jest-environment node
 *
 * Typicals in the lint (ROADMAP F6, STATUS decision 15).
 *
 * Per copy: unit 001 has a rooftop unit with an outdoor-air hood and, 9 m away,
 * an exhaust fan whose outlet has a hood. Unit 001 alone is fine. Repeated
 * 9 m apart, copy 002's intake lands under 1 m from unit 001's exhaust, and
 * copy 003's beside copy 002's: two findings, each naming the copy by its
 * virtual id. 30 m apart, nothing. On code before F6 there is no per-copy
 * rule (copies are not elements), so the "fires" case finds nothing and fails.
 *
 * Over the contract: eleven typical types with the default cap of 10 warns
 * "This project has 11 typicals; the contract covers 10"; ten does not, and
 * raising the model's cap to 12 clears it. Before F6 neither the rule nor the
 * setting existed.
 */
import { builtinPartType, parseVirtualCopyId } from "@permitzip/bim-kernel";
import { config, engineFor, Model } from "./fixtures";

const RTU = builtinPartType("builtin:rtu-5-ton@2");
const FAN = builtinPartType("builtin:inline-fan-10@1");

function unit(spacingMm: number): Model {
  if (!RTU || !FAN) throw new Error("starter library is missing the RTU or the fan");
  const m = new Model();
  m.ok({ type: "place_part", partId: "rtu-1", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-roof", position: { x: 0, y: 0 }, mark: "RTU-1" });
  m.ok({ type: "place_part", partId: "ef-1", typeId: FAN.id, partType: FAN.definition, levelId: "lvl-roof", position: { x: 9000, y: 0 }, mark: "EF-1", intakes: { outlet: "hood" } });
  m.ok({ type: "create_group", groupId: "g-unit", name: "Unit 001" });
  m.ok({ type: "assign_elements_to_group", ids: ["rtu-1", "ef-1"], groupId: "g-unit" });
  m.ok({ type: "set_group_typical", groupId: "g-unit", mark: "001", array: { count: 3, columns: 3, spacingMm: { x: spacingMm, y: 0 } } });
  return m;
}

function findings(m: Model, rule: string) {
  return engineFor(m.head)
    .check({ config: config({ ruleset: "issue", max_findings: 8 }) })
    .filter((f) => f.rule === rule);
}

describe("per-copy checks", () => {
  it("a copy's intake that lands beside the next unit's exhaust is reported once per copy, by virtual id", () => {
    const fired = findings(unit(9000), "typical-copy-intake-near-exhaust");
    expect(fired).toHaveLength(2);
    const ids = fired.flatMap((f) => f.elementIds).sort();
    expect(ids).toEqual(["ef-1", "g-unit#002/ef-1", "g-unit#002/rtu-1", "g-unit#003/rtu-1"].sort());
    expect(parseVirtualCopyId("g-unit#002/rtu-1")).toEqual({ groupId: "g-unit", mark: "002", elementId: "rtu-1" });
    expect(fired[0]?.message).toMatch(/copy 00[23]'s RTU-1, the outdoor-air intake is .* from .* exhaust outlet on EF-1; the code wants 10 ft/);
  });

  it("copies spaced far enough apart stay quiet, and unit 001 alone is fine", () => {
    expect(findings(unit(30_000), "typical-copy-intake-near-exhaust")).toEqual([]);
  });

  it("an edit to a part in the typical re-checks its copies (the edit scope reaches the group)", () => {
    const m = unit(30_000);
    const e = engineFor(m.head);
    const changed = m.ok({ type: "set_group_typical", groupId: "g-unit", array: { count: 3, columns: 3, spacingMm: { x: 9000, y: 0 } } });
    e.advance(m.head, changed);
    const scoped = e.run({ all: false, box: null, documents: [], changed }, { config: config({ ruleset: "issue" }) });
    expect(scoped.filter((f) => f.rule === "typical-copy-intake-near-exhaust")).toHaveLength(2);
  });
});

describe("the contract's cap on typical types", () => {
  function typicals(n: number): Model {
    const m = new Model();
    for (let i = 1; i <= n; i++) {
      m.ok({ type: "create_group", groupId: `g-${i}`, name: `Type ${i}` });
      m.ok({ type: "set_group_typical", groupId: `g-${i}`, mark: "001", array: { count: 2, columns: 2, spacingMm: { x: 10_000, y: 0 } } });
    }
    return m;
  }

  it("eleven typicals against the default ten warns in plain words; ten does not", () => {
    const over = findings(typicals(11), "typicals-over-contract");
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toMatch(/^This project has 11 typicals; the contract covers 10\. Agree the extra one with the client/);
    expect(over[0]?.elementIds).toHaveLength(11);
    expect(findings(typicals(10), "typicals-over-contract")).toEqual([]);
  });

  it("the cap is a model setting: covering 12 clears the warning", () => {
    const m = typicals(11);
    m.ok({ type: "set_typical_cap", cap: 12 });
    expect(findings(m, "typicals-over-contract")).toEqual([]);
    // Setting the active group keeps the cap (the settings record is rewritten whole).
    m.ok({ type: "set_active_group", groupId: "g-1" });
    expect(findings(m, "typicals-over-contract")).toEqual([]);
  });
});
