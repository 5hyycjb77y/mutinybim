/**
 * Outside add-ons (round 11 A11, D5).
 *
 * - authority.boot.with_outside_packs.<tier>: the pack-dependent part of
 *   opening a model, in process: the model's setup read, its pins resolved
 *   against the host's add-ons, the set bound, then the reads a served model
 *   makes first (class and field registries, one full validation). Measured
 *   with no outside add-on (`base`, round 10's path) and with one approved data
 *   add-on pinned through the install path (`outside`); the row is the ratio.
 * - library.install.verify.one_package: one signed package with a 50-class data
 *   add-on through the whole install gate (hashes, signature, licence,
 *   conformance), p50 / p95 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/outside-packs.ts [250k|1M] [base|all|verify]
 *
 * `verify` measures only the install gate (no model is built); a11-perf runs it.
 *
 * 1M only through the shared stack's heavy lock.
 */
import { freezeElements, modelSetupOf, resolveModelSetup, validateModel, activeClassRegistry, fieldProviderRegistry, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withPackSet, type Pack, type PackSet } from "../../../packages/bim-kernel/src/packs";
import { installFirstPartyAddOns } from "../../../packages/bim-first-party/src";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const SAMPLES = 5;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 2), p95: round(percentile(ms, 0.95) ?? 0, 2) };
}

const tierArg = process.argv[2] ?? "250k";
const arms = process.argv[3] ?? "all";
if (!isTier(tierArg)) {
  console.error(`[perf/outside-packs] ${tierArg} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  process.exit(1);
}
const tier: Tier = tierArg;
installFirstPartyAddOns();

function buildHead(t: Tier): ModelState {
  const built = createFullBimModel({ ...FULL_BIM_TIERS[t], modelId: `outside-packs-${t}` });
  return { ...built, elements: freezeElements(built.elements) };
}

/** The open path a served model takes, with `host` the add-ons this host may open it with. */
function open(model: ModelState, host: readonly Pack[]): { set: PackSet; issues: number } {
  const { set } = resolveModelSetup(modelSetupOf(model), host);
  const issues = withPackSet(set, () => {
    activeClassRegistry();
    fieldProviderRegistry();
    return validateModel(model).length;
  });
  return { set, issues };
}

function sample(model: ModelState, host: readonly Pack[]): number[] {
  const out: number[] = [];
  open(model, host);
  for (let i = 0; i < SAMPLES; i++) {
    gc();
    out.push(timeSync(() => open(model, host)).ms);
  }
  return out;
}

async function main(): Promise<void> {
  if (arms === "verify") {
    const { verifyArm } = await import("./outside-packs-arm");
    const v = await verifyArm();
    console.log(JSON.stringify({ "library.install.verify.one_package": { ...stats(v.verifyMs), classes: v.classes } }));
    return;
  }
  const head = buildHead(tier);
  const base = sample(head, []);
  const result: Record<string, unknown> = { [`authority.boot.base.${tier}`]: { ...stats(base), elements: Object.keys(head.elements).length } };
  if (arms === "all") {
    const { outsideArm } = await import("./outside-packs-arm");
    const arm = await outsideArm(head);
    const withOutside = sample(arm.model, arm.host);
    const ratio = (percentile(withOutside, 0.5) ?? 0) / Math.max(1e-9, percentile(base, 0.5) ?? 1);
    const ratio95 = (percentile(withOutside, 0.95) ?? 0) / Math.max(1e-9, percentile(base, 0.95) ?? 1);
    result[`authority.boot.with_outside_packs.${tier}`] = { ...stats(withOutside), ratio_p50: round(ratio, 3), ratio_p95: round(ratio95, 3), pinned: arm.pinned };
    result["library.install.verify.one_package"] = { ...stats(arm.verifyMs), classes: arm.classes };
  }
  console.log(JSON.stringify(result));
}

main().catch((err: unknown) => {
  console.error("[perf/outside-packs] failed", err);
  process.exit(1);
});
