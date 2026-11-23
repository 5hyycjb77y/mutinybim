import { LintEngine, readLintConfig, type Finding, type Ruleset, type Severity } from "@permitzip/bim-lint";
import { elementValues, type ModelState } from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import { onWorkingWithTouched } from "./working";

/**
 * `checks`: the coordination check (clashes, clearances, documents) on the
 * model as the script has it so far, the same engine and rules the
 * Coordination panel and bim_lint_check run. Read only: a script decides
 * what to move and sends it with `ctx.edit`. Linked models are the host's,
 * so their clashes are not here.
 */

export const CLASH_TYPES = ["hard", "self", "soft", "clearance", "dedicated_space", "ceiling", "placement", "connectors"] as const;
export type ClashType = (typeof CLASH_TYPES)[number];

export const CLASH_DETAIL_LEVELS = ["summary", "compact", "full"] as const;
export type ClashDetailLevel = (typeof CLASH_DETAIL_LEVELS)[number];

export const CLASH_SCOPES = ["touched", "level", "all"] as const;
export type ClashScope = (typeof CLASH_SCOPES)[number];

const RULES_FOR_TYPE: Readonly<Record<ClashType, readonly string[]>> = {
  hard: ["clash-hard"],
  self: ["clash-self"],
  soft: ["clash-soft"],
  clearance: ["clearance-intrusion"],
  dedicated_space: ["dedicated-space-intrusion"],
  ceiling: ["duct-ceiling-clearance"],
  placement: ["outside-building", "floating-equipment", "buried-equipment", "no-host"],
  connectors: ["connector-touching-not-joined", "connector-shape-size-mismatch", "connector-end-type-mismatch", "connector-service-mismatch"],
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

export interface ClashCheckSpec {
  /** "coordination" (default: hard and soft clashes, clearances), "default", "documents" or "issue". */
  readonly ruleset?: Ruleset;
  /** Filter findings to specific clash categories ("hard", "self", "soft", "clearance", "dedicated_space", "ceiling", "placement", "connectors"). */
  readonly types?: readonly ClashType[];
  /** Minimum severity to include ("error", "warning", or "info"). */
  readonly minSeverity?: Severity;
  /** "touched" (only elements this script created or edited), "level", or "all" (default for checks.clashes). */
  readonly scope?: ClashScope;
  /** One level's findings only (its name). */
  readonly level?: string;
  /** Only findings near these elements. */
  readonly ids?: readonly string[];
  /** Overlap smaller than this is not a hard clash (default 1/2"). */
  readonly tolerance?: Measure;
  /** Minimum clearance between MEP services (default 1"). */
  readonly softClearance?: Measure;
  /** Minimum clearance to architecture/structure (default 2"). */
  readonly structureClearance?: Measure;
  /** Maximum findings to return (default 20, max 100). */
  readonly maxFindings?: number;
  /** Rules to leave out. */
  readonly skipRules?: readonly string[];
}

export interface ClashReportSpec extends ClashCheckSpec {
  /** Response verbosity: "summary" (counts only), "compact" (rule/severity/elements/level/message), or "full" (adds coordinates & fix hints). Default "compact". */
  readonly detail?: ClashDetailLevel;
}

export interface RawClashReportOptions {
  readonly scope?: ClashScope;
  readonly ruleset?: Ruleset;
  readonly types?: readonly ClashType[];
  readonly minSeverity?: Severity;
  readonly detail?: ClashDetailLevel;
  readonly level?: string;
  readonly ids?: readonly string[];
  readonly toleranceIn?: number;
  readonly softClearanceIn?: number;
  readonly structureClearanceIn?: number;
  readonly maxFindings?: number;
  readonly skipRules?: readonly string[];
}

export interface CompactClashFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly elements: readonly string[];
  readonly level: string;
  readonly message: string;
}

export interface ClashReport {
  readonly scope: ClashScope;
  readonly detail: ClashDetailLevel;
  readonly total: number;
  readonly shown: number;
  readonly by_severity: { readonly error: number; readonly warning: number; readonly info: number };
  readonly by_rule: Readonly<Record<string, number>>;
  readonly findings?: readonly (CompactClashFinding | Finding)[];
}

const IN_PER_MM = 1 / 25.4;

function inches(m: Measure, what: string): number {
  if (m.kind !== "length") throw new Error(`${what} is a length; the value given is a ${m.kind}.`);
  return measureIn(m, "mm") * IN_PER_MM;
}

function allowedRules(types: readonly ClashType[] | undefined): ReadonlySet<string> | null {
  if (!types || types.length === 0) return null;
  const out = new Set<string>();
  for (const t of types) {
    const list = RULES_FOR_TYPE[t];
    if (list) for (const r of list) out.add(r);
  }
  return out;
}

/** Runs `@permitzip/bim-lint` on `model` with configurable clash types, severity, scope, tolerances and cap. */
export function evaluateClashes(model: ModelState, options: RawClashReportOptions = {}, touchedIds: readonly string[] = []): readonly Finding[] {
  const scope: ClashScope = options.scope ?? "all";
  const ids =
    options.ids && options.ids.length > 0
      ? options.ids
      : scope === "touched"
        ? touchedIds
        : undefined;
  if (scope === "touched" && (!ids || ids.length === 0)) return [];

  const config = readLintConfig({
    ruleset: options.ruleset ?? "coordination",
    include_linked: false,
    ...(options.toleranceIn !== undefined ? { tolerance_in: options.toleranceIn } : {}),
    ...(options.softClearanceIn !== undefined ? { soft_clearance_in: options.softClearanceIn } : {}),
    ...(options.structureClearanceIn !== undefined ? { structure_clearance_in: options.structureClearanceIn } : {}),
    ...(options.skipRules ? { disabled_rules: [...options.skipRules] } : {}),
  });
  const engine = new LintEngine();
  engine.build(model);
  const raw = engine.check({
    config,
    ...(options.level ? { level: options.level } : {}),
    ...(ids && ids.length > 0 ? { ids } : {}),
  });

  const rules = allowedRules(options.types);
  const minRank = options.minSeverity ? SEVERITY_RANK[options.minSeverity] : 2;
  const idSet = ids && ids.length > 0 ? new Set(ids) : null;
  let wantedLevel: string | null = null;
  if (options.level) {
    const q = options.level.trim().toLowerCase();
    const matched = elementValues(model.elements).find(
      (el) => el.kind === "level" && (el.id.toLowerCase() === q || el.name.toLowerCase() === q),
    );
    wantedLevel = matched?.kind === "level" ? matched.name.toLowerCase() : q;
  }
  return raw.filter((f) => {
    if (rules && !rules.has(f.rule)) return false;
    if (SEVERITY_RANK[f.severity] > minRank) return false;
    if (wantedLevel !== null && (f.at.level ?? "").toLowerCase() !== wantedLevel) return false;
    if (scope === "touched" && idSet && !f.elementIds.some((id) => idSet.has(id))) return false;
    return true;
  });
}

/** Formats clash findings into a summary, compact, or full report for scripts and `bim_run_script`. */
export function evaluateClashReport(model: ModelState, options: RawClashReportOptions = {}, touchedIds: readonly string[] = []): ClashReport {
  const scope: ClashScope = options.scope ?? "all";
  const detail: ClashDetailLevel = options.detail ?? "compact";
  const maxFindings = Math.max(1, Math.min(100, Math.round(options.maxFindings ?? 20)));
  const all = evaluateClashes(model, options, touchedIds);
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byRule: Record<string, number> = {};
  for (const f of all) {
    bySeverity[f.severity] += 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  if (detail === "summary") {
    return { scope, detail, total: all.length, shown: 0, by_severity: bySeverity, by_rule: byRule };
  }
  const sliced = all.slice(0, maxFindings);
  const findings =
    detail === "full"
      ? sliced
      : sliced.map(
          (f): CompactClashFinding => ({
            rule: f.rule,
            severity: f.severity,
            elements: f.elementIds,
            level: f.at.level,
            message: f.message,
          }),
        );
  return { scope, detail, total: all.length, shown: findings.length, by_severity: bySeverity, by_rule: byRule, findings };
}

function toRawOptions(spec: ClashCheckSpec & { readonly detail?: ClashDetailLevel }): RawClashReportOptions {
  return {
    ...(spec.scope ? { scope: spec.scope } : {}),
    ...(spec.ruleset ? { ruleset: spec.ruleset } : {}),
    ...(spec.types ? { types: spec.types } : {}),
    ...(spec.minSeverity ? { minSeverity: spec.minSeverity } : {}),
    ...(spec.detail ? { detail: spec.detail } : {}),
    ...(spec.level ? { level: spec.level } : {}),
    ...(spec.ids ? { ids: spec.ids } : {}),
    ...(spec.tolerance ? { toleranceIn: inches(spec.tolerance, "Tolerance") } : {}),
    ...(spec.softClearance ? { softClearanceIn: inches(spec.softClearance, "Soft clearance") } : {}),
    ...(spec.structureClearance ? { structureClearanceIn: inches(spec.structureClearance, "Structure clearance") } : {}),
    ...(spec.maxFindings !== undefined ? { maxFindings: spec.maxFindings } : {}),
    ...(spec.skipRules ? { skipRules: spec.skipRules } : {}),
  };
}

export const checks = {
  /** Every matching finding (worst first): rule, elements, location and fix hint. Supports filtering by `types`, `minSeverity`, `scope`, tolerances, and `maxFindings`. */
  clashes(ctx: ScriptContext, spec: ClashCheckSpec = {}): readonly Finding[] {
    const raw = toRawOptions(spec);
    return onWorkingWithTouched(ctx, "checks.clashes", (model, touchedIds) => {
      const all = evaluateClashes(model, raw, touchedIds);
      return spec.maxFindings !== undefined ? all.slice(0, Math.max(1, Math.min(100, Math.round(spec.maxFindings)))) : all;
    });
  },
  /** Configurable clash & clearance report (`detail: "summary" | "compact" | "full"`) with counts by severity and rule. */
  clashReport(ctx: ScriptContext, spec: ClashReportSpec = {}): ClashReport {
    const raw = toRawOptions(spec);
    return onWorkingWithTouched(ctx, "checks.clashReport", (model, touchedIds) => evaluateClashReport(model, raw, touchedIds));
  },
};
