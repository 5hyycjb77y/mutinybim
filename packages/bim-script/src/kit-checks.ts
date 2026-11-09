import { LintEngine, readLintConfig, type Finding, type Ruleset } from "@permitzip/bim-lint";
import { measureIn, type Measure } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import { onWorking } from "./working";

/**
 * `checks`: the coordination check (clashes, clearances, documents) on the
 * model as the script has it so far, the same engine and rules the
 * Coordination panel and bim_lint_check run. Read only: a script decides
 * what to move and sends it with `ctx.edit`. Linked models are the host's,
 * so their clashes are not here.
 */

export interface ClashCheckSpec {
  /** "coordination" (default: hard and soft clashes, clearances), "default", "documents" or "issue". */
  readonly ruleset?: Ruleset;
  /** One level's findings only (its name). */
  readonly level?: string;
  /** Only findings near these elements. */
  readonly ids?: readonly string[];
  /** Overlap smaller than this is not a clash (default 1/2"). */
  readonly tolerance?: Measure;
  /** Rules to leave out. */
  readonly skipRules?: readonly string[];
}

const IN_PER_MM = 1 / 25.4;

function inches(m: Measure, what: string): number {
  if (m.kind !== "length") throw new Error(`${what} is a length; the value given is a ${m.kind}.`);
  return measureIn(m, "mm") * IN_PER_MM;
}

export const checks = {
  /** Every finding (worst first): the rule, the elements, where, and what to do, in words. */
  clashes(ctx: ScriptContext, spec: ClashCheckSpec = {}): readonly Finding[] {
    const config = readLintConfig({
      ruleset: spec.ruleset ?? "coordination",
      include_linked: false,
      ...(spec.tolerance ? { tolerance_in: inches(spec.tolerance, "Tolerance") } : {}),
      ...(spec.skipRules ? { disabled_rules: [...spec.skipRules] } : {}),
    });
    return onWorking(ctx, "checks.clashes", (model) => {
      const engine = new LintEngine();
      engine.build(model);
      return engine.check({ config, ...(spec.level ? { level: spec.level } : {}), ...(spec.ids && spec.ids.length > 0 ? { ids: spec.ids } : {}) });
    });
  },
};
