import { serviceNetworkTotals, withBaseFields, fieldProviderRegistry, type ModelState, type Registry, type ServiceNetworkTotals } from "@permitzip/bim-kernel";
import { withPackSet, type PackSet } from "@permitzip/bim-kernel/packs";
import { builtinCalcRegistry, type RunRequest, type RunResult } from "@permitzip/bim-calc";
import { DEFAULT_LINT_CONFIG, LintEngine, type Finding, type LintConfig, type LinkedModelIndex } from "@permitzip/bim-lint";

/**
 * A pack's own tests run its rows through the real engines, inside its set's
 * scope, exactly as a host serving a model bound to that set does: the lint
 * engine (every rule of the set, built-ins included), the calc registry, the
 * kernel's network walk and the field registry the Inspector reads.
 */

export interface PackLintOptions {
  /** Over the default lint settings. */
  readonly config?: Partial<LintConfig>;
  readonly linked?: readonly LinkedModelIndex[];
  /** Only findings on this level. */
  readonly level?: string;
  /** Only the scope around these elements, as after an edit of them. */
  readonly ids?: readonly string[];
}

/** Every finding the real lint engine reports on `model` with `set` in force. */
export function runPackLint(model: ModelState, set: PackSet, opts: PackLintOptions = {}): Finding[] {
  return withPackSet(set, () => {
    const engine = new LintEngine();
    engine.build(model, opts.linked ?? []);
    return engine.check({ config: { ...DEFAULT_LINT_CONFIG, ...opts.config }, ...(opts.level !== undefined ? { level: opts.level } : {}), ...(opts.ids !== undefined ? { ids: opts.ids } : {}) });
  });
}

const calcs = builtinCalcRegistry();

/** One calc run through the real registry (built-in calcs and code families plus the set's). */
export function runPackCalc(set: PackSet, request: RunRequest): RunResult {
  return withPackSet(set, () => calcs.run(request));
}

/** One service's network walked and totalled by the kernel through the set's adapter. */
export function runPackNetwork(model: ModelState, set: PackSet, serviceId: string): ServiceNetworkTotals {
  return withPackSet(set, () => serviceNetworkTotals(model, serviceId));
}

/** The field registry the Inspector, schedules and agent tools read, with the set's classes and parameters joined. */
export function packFieldRegistry(set: PackSet): Registry {
  return withPackSet(set, () => withBaseFields(fieldProviderRegistry()));
}

/**
 * Install gate (round 11 A11): a pack author runs their packaged data add-on
 * through the same gate a firm's library runs (signature, licence, tier,
 * namespace, conformance) before publishing it.
 */
export { checkOutsidePackage as runPackInstallGate, type InstallGateOptions, type InstallOutcome } from "./install/gate";
