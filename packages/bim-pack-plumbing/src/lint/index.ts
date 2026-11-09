import { withLintRank, type RuleDef } from "@permitzip/bim-lint";
import { drainageRules } from "./drainage";
import { plumbingRules } from "./plumbing";

export { drainageRules } from "./drainage";
export { plumbingRules } from "./plumbing";

/** Drainage rules added after batch 5c (round 12): they run in the post-5c group, after the built-in connector checks (rank 1250), so no batch 5c rule moves. */
const AFTER_5C: ReadonlySet<string> = new Set(["drain-over-drainage-units", "sewer-walk"]);

/** Plumbing's lint rules at the places they ran when they were built in: the building sewer checks after the shared load rules, then the fixture and stack checks; rules added since run after the batch 5c ones. */
export const PLUMBING_LINT_RULES: readonly RuleDef[] = [
  ...withLintRank(drainageRules.filter((r) => !AFTER_5C.has(r.id)), 800),
  ...withLintRank(plumbingRules, 900),
  ...withLintRank(drainageRules.filter((r) => AFTER_5C.has(r.id)), 1250),
];
