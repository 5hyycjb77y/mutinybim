import { connectorRules } from "./connector-integrity";
import { coordinationRules } from "./packs/coordination";
import { documentRules } from "./packs/documents";
import { placementRules } from "./packs/placement";
import { requirementRules } from "./packs/requirements";
import { questionRules } from "./packs/questions";
import { clearanceRules } from "./packs/spatial";
import { systemRules } from "./packs/systems";
import { typicalRules } from "./packs/typicals";
import { activePackSet, defineExtensionPoint } from "@permitzip/bim-kernel/packs";
import type { RuleDef } from "./registry";

/**
 * Where each built-in rule group runs (`RuleDef.rank`, lower first). The gaps
 * are where first-party add-ons' groups run (600, 800, 900, 1000, 1300), so
 * their rules keep the place they had when they were built in.
 */
const BUILTIN_GROUPS: readonly (readonly [readonly RuleDef[], number])[] = [
  [coordinationRules, 100],
  [placementRules, 200],
  [clearanceRules, 300],
  [systemRules, 400],
  [documentRules, 500],
  [requirementRules, 700],
  [questionRules, 1100],
  [typicalRules, 1200],
  [connectorRules, 1250],
];

/** Every built-in rule, v1, in the order they run. */
export const ALL_RULES: readonly RuleDef[] = BUILTIN_GROUPS.flatMap(([rules]) => rules);

const BUILTIN_RANK: ReadonlyMap<string, number> = new Map(BUILTIN_GROUPS.flatMap(([rules, rank]) => rules.map((r) => [r.id, rank] as const)));

/** `rules` placed at `rank` (an add-on's group that runs among the built-in ones). */
export function withLintRank(rules: readonly RuleDef[], rank: number): readonly RuleDef[] {
  return rules.map((rule) => ({ ...rule, rank }));
}

/** A rule's place in the run: its own `rank`, its built-in group's, else after every ranked rule. */
export function lintRuleRank(rule: Pick<RuleDef, "id" | "rank">): number {
  return rule.rank ?? BUILTIN_RANK.get(rule.id) ?? Number.POSITIVE_INFINITY;
}

/**
 * Lint rules (v1). A pack's rule ids are `<pack>.<rule>` and its `pack` is
 * the pack's namespace; built-in ids are bare and stay as findings store them.
 */
export const LINT_RULE_POINT = defineExtensionPoint<RuleDef>({
  id: "lint.rule",
  version: 1,
  label: "Lint rules",
  idOf: (rule) => rule.id,
  builtins: () => ALL_RULES,
});

/** The rules the runner reads: built-ins and the pack set in force's, by rank; equal ranks keep set order (built-ins first). */
export function activeLintRules(): readonly RuleDef[] {
  const set = activePackSet();
  if (set.packItems(LINT_RULE_POINT).length === 0) return ALL_RULES;
  return set.memo("lint.rule.list", () => {
    const items = set.items(LINT_RULE_POINT);
    return Object.freeze(items.map((rule, at) => ({ rule, at, rank: lintRuleRank(rule) })).sort((a, b) => a.rank - b.rank || a.at - b.at).map((r) => r.rule));
  });
}
