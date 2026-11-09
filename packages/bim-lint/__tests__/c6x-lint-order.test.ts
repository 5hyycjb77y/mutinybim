/**
 * c6x-lint-order: with the trade rules moved into their add-ons (round 6),
 * the rules run in the order, and with the ids, versions, rule packs,
 * severities, titles and reads, they had in batch 5c
 * (`git show 7bfda9c7c:packages/bim-lint/src/rules/index.ts` and its packs).
 * Before the ranks, the add-ons' rules ran after every built-in rule.
 */
import { activeLintRules, ALL_RULES, lintRuleRank } from "../src";
import { BATCH_5C, type Row } from "./c6x-batch-5c-rules";

/** Built-in rules added after batch 5c, in their own group (round 9 J9, rank 1250): they run after the typicals and change no 5c rule. */
const ADDED_AFTER_5C = ["connector-touching-not-joined", "connector-shape-size-mismatch", "connector-end-type-mismatch", "connector-service-mismatch", "drain-over-drainage-units", "sewer-walk"];

/** Add-on rules added in round 14: Mechanical's two route checks (run in its systems group, after its makeup air check) and Structural's footing check (Structural became first-party, so it runs in every model, last). */
const ADDED_ROUND_14 = ["duct-rated-crossing", "duct-ceiling-clearance", "struct.footing_unsupported"];

describe("c6x-lint-order", () => {
  it("runs every rule in the batch 5c order, each unchanged", () => {
    const now = activeLintRules()
      .filter((r) => !ADDED_AFTER_5C.includes(r.id) && !ADDED_ROUND_14.includes(r.id))
      .map((r): Row => [r.id, r.severity, r.pack, r.version, r.reads, r.title]);
    expect(now).toEqual(BATCH_5C);
  });

  it("runs the rules added after 5c together, after the typicals' group", () => {
    const ids = activeLintRules().map((r) => r.id);
    const at = ids.indexOf(ADDED_AFTER_5C[0] as string);
    expect(ids.slice(at, at + ADDED_AFTER_5C.length)).toEqual(ADDED_AFTER_5C);
    expect(ids.indexOf("typical-copy-intake-near-exhaust")).toBeLessThan(at);
  });

  it("keeps the built-in rules in that order on their own, with no add-on's rules among them", () => {
    const builtin = new Set(ALL_RULES.map((r) => r.id));
    expect(ALL_RULES.map((r) => r.id).filter((id) => !ADDED_AFTER_5C.includes(id))).toEqual(BATCH_5C.map(([id]) => id).filter((id) => builtin.has(id)));
    expect(ALL_RULES.map((r) => r.id)).not.toContain("not-fed");
    expect(ALL_RULES.map((r) => r.id)).not.toContain("sewer-floor-needs-pump");
    expect(ALL_RULES.map((r) => r.id)).not.toContain("zone-pressure-off-target");
  });

  it("runs round 14's add-on rules where their add-ons' groups run, moving no 5c rule", () => {
    const ids = activeLintRules().map((r) => r.id);
    const tempering = ids.indexOf("makeup-air-tempering-unknown");
    expect(ids.slice(tempering + 1, tempering + 3)).toEqual(["duct-rated-crossing", "duct-ceiling-clearance"]);
    expect(ids.at(-1)).toBe("struct.footing_unsupported");
  });

  it("ranks never decrease along the run", () => {
    const ranks = activeLintRules().map(lintRuleRank);
    expect(ranks.every((r, i) => i === 0 || r >= (ranks[i - 1] as number))).toBe(true);
  });
});
