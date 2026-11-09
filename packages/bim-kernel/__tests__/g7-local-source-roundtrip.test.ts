/**
 * @jest-environment node
 *
 * Round 7 lane G: the bundled `local` requirements source. A firm's own rule
 * is stored with the model as a `rule` record (one undo step), evaluates
 * like any source's rule under provider `local`, is the built-in row of
 * `kernel.requirements_source`, and round-trips through a library item
 * (export → JSON → import) unchanged, keeping a field this release doesn't
 * know. A copied-looking summary is refused in words.
 *
 * Fails on the code before round 7: no local source, no rule records.
 */
import { builtinRequirementsSources, executeCommand, exportRuleToLibraryItem, importRuleFromLibraryItem, LOCAL_SOURCE_ID, localRules, requirementsAt, requirementsSources, sameRule, type RuleRecord } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { floor, run, writes, ZT_PACK } from "./g7-fixtures";

const ID = "g7-local";

beforeAll(() => bindModelPacks(ID, PackSet.create([ZT_PACK])));

const FIRM_RULE = {
  ruleId: "firm.storage-door",
  title: "Storage door width",
  summary: "Our storage rooms get a door at least the test width.",
  discipline: "architecture",
  citation: { instrument: "Firm practice", edition: "2026", section: "F-1" },
  applies: { spaceUses: ["storage"] },
  reads: [],
  parameters: { width: { value: 36, unit: "in" } },
  produces: [{ key: "arch.door_width", anchor: "space", value: "{param.width}", unit: "in", compare: "at_least" }],
  verification: { status: "draft" },
  futureField: { kept: true },
};

describe("g7 local source round trip", () => {
  it("local is a built-in row of the requirements source point", () => {
    expect(builtinRequirementsSources().map((r) => r.descriptor.id)).toContain(LOCAL_SOURCE_ID);
    expect(requirementsSources(floor(ID)).map((s) => [s.id, s.origin])).toContainEqual([LOCAL_SOURCE_ID, "local"]);
  });

  it("a rule added to the model evaluates under provider local, and edit and delete work", () => {
    const m0 = floor(ID);
    expect(requirementsAt(m0, { kind: "space", id: "S104" }).some((r) => r.key === "arch.door_width")).toBe(false);
    const m1 = run(m0, { type: "add_local_rule", rule: FIRM_RULE });
    expect(m1.elements["rule:firm.storage-door"]).toMatchObject({ kind: "rule", rule: { provider: LOCAL_SOURCE_ID, futureField: { kept: true } } });
    const door = requirementsAt(m1, { kind: "space", id: "S104" }).find((r) => r.key === "arch.door_width");
    expect(door).toMatchObject({ provider: LOCAL_SOURCE_ID, value: 36, unit: "in", title: "Storage door width" });
    expect(requirementsAt(m1, { kind: "space", id: "S101" }).some((r) => r.key === "arch.door_width")).toBe(false);

    const m2 = run(m1, { type: "edit_local_rule", ruleId: "firm.storage-door", rule: { ...FIRM_RULE, parameters: { width: { value: 42, unit: "in" } } } });
    expect(requirementsAt(m2, { kind: "space", id: "S104" }).find((r) => r.key === "arch.door_width")?.value).toBe(42);

    const m3 = run(m2, { type: "delete_local_rules", ruleIds: ["firm.storage-door"] });
    expect(localRules(m3.elements)).toEqual([]);
    expect(requirementsAt(m3, { kind: "space", id: "S104" }).some((r) => r.key === "arch.door_width")).toBe(false);
  });

  it("exports to a library item and imports back unchanged, through JSON", () => {
    const m1 = run(floor(ID), { type: "add_local_rule", rule: FIRM_RULE });
    const [stored] = localRules(m1.elements);
    if (!stored) throw new Error("no local rule stored");
    const item = exportRuleToLibraryItem(stored, { revision: 3 });
    expect(item).toMatchObject({ type: "requirement_rule", body: { id: "rule.firm.storage-door", revision: 3, key: "firm.storage-door", name: "Storage door width" } });

    const back = importRuleFromLibraryItem(JSON.parse(JSON.stringify(item)));
    if (!back.ok) throw new Error(back.reason);
    expect(back.value.findings).toEqual([]);
    expect(sameRule(back.value.rule, stored)).toBe(true);
    expect((back.value.rule as RuleRecord & { futureField?: unknown }).futureField).toEqual({ kept: true });

    // A rule from another provider becomes local when imported.
    const theirs = importRuleFromLibraryItem({ ...item, body: { ...item.body, rule: { ...item.body.rule, provider: "someone.else" } } });
    expect(theirs.ok && theirs.value.rule.provider).toBe(LOCAL_SOURCE_ID);
  });

  it("refuses what isn't a rule item, and a copied-looking or over-long summary, in words", () => {
    expect(importRuleFromLibraryItem({ type: "space_use", body: {} })).toEqual({ ok: false, reason: "this library item is a space_use, not a code-study rule" });
    expect(importRuleFromLibraryItem({ type: "requirement_rule", body: { id: "x" } })).toEqual({ ok: false, reason: "this rule item has no rule in it" });
    const long = writes(() => executeCommand(floor(ID), { type: "add_local_rule", rule: { ...FIRM_RULE, summary: "x ".repeat(400) } }));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.message).toMatch(/keep it to \d+ in your own words/);
  });
});
