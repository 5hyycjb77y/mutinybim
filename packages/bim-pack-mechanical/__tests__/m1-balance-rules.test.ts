/**
 * @jest-environment node
 *
 * Pressurization checks (ROADMAP M1). Before this change there was no
 * balance rules file and the kernel had no pressurization read, so every
 * "fires" case fails on the old code (nothing to import, and no rule in
 * ALL_RULES produced these ids).
 */
import type { ModelState } from "@permitzip/bim-kernel";
import { activeLintRules, DEFAULT_LINT_CONFIG, LintEngine, type Finding } from "@permitzip/bim-lint";
import { balanceRules } from "../src/lint/balance";
import { sampleGrill, restaurantTargets, withTargets } from "../../bim-kernel/__tests__/m1-fixtures";

/** Every case lints with the restaurant targets in force (a pack's row since round 6). */
function findings(model: ModelState): Finding[] {
  return withTargets(restaurantTargets, () => {
    const e = new LintEngine(balanceRules);
    e.build(model, []);
    return e.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "default" } });
  });
}

const byRule = (model: ModelState) => {
  const out = new Map<string, string[]>();
  for (const f of findings(model)) out.set(f.rule, [...(out.get(f.rule) ?? []), f.message]);
  return out;
};

describe("balance lint pack", () => {
  it("is registered in the default rules", () => {
    expect(activeLintRules().map((r) => r.id)).toEqual(expect.arrayContaining(["zone-pressure-off-target", "building-pressure-off-target", "pressurization-airflow-missing", "makeup-air-tempering-unknown"]));
  });

  it("7303 as designed (kitchen −220, building +100) says nothing", () => {
    expect(findings(sampleGrill().head)).toEqual([]);
  });

  it("a kitchen pushed positive is flagged against the dining room, with the items named in the fix", () => {
    const b = sampleGrill();
    b.ok({ type: "set_parameters", id: "mua1", scope: "instance", values: { makeup_air_cfm: 3220 } });
    const f = findings(b.head).find((x) => x.rule === "zone-pressure-off-target");
    expect(f?.message).toBe("Zone 2 Kitchen is +600 cfm positive; kitchens are kept negative to the dining room");
    expect(f?.elementIds).toEqual(["kef1", "mua1", "rtu2", "z-kitchen"]);
    expect(f?.fix?.hint).toBe("change KEF-1, MUA-1, RTU-2 so the zone is negative");
  });

  it("without MUA-1 the building is negative by 2,300 cfm, and the finding names every contributor", () => {
    const fired = byRule(sampleGrill({ withMua: false }).head);
    expect(fired.get("building-pressure-off-target")).toEqual(["Building is negative by 2,300 cfm (target positive): KEF-1 −3,000; RTU-1 +320; RTU-2 +380"]);
  });

  it("an exhaust fan with no airflow says so, and no off-target finding guesses a number", () => {
    const fired = byRule(sampleGrill({ kefCfm: null }).head);
    expect(fired.get("pressurization-airflow-missing")).toEqual(["KEF-1 has no exhaust airflow (exhaust_cfm). Type it in Properties. Until then the building's pressurization can't be added up."]);
    expect(fired.has("building-pressure-off-target")).toBe(false);
    expect(fired.has("zone-pressure-off-target")).toBe(false);
  });
});
