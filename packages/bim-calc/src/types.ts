import type { ModelState } from "@permitzip/bim-kernel";
import type { UnitCode } from "@permitzip/bim-units";
import type { z } from "zod";
import type { Unit } from "./units";

/**
 * The calculation plugin contract, shared by every trade.
 *
 * Inputs are plain quantities with the unit in the field name (`length_ft`,
 * `continuous_load_a`), validated by the plugin's schema, so a caller (the
 * connection/aggregation core, a schedule, an agent tool, a test) needs
 * nothing from the model to run a calc. Plugins that read a model say so
 * (`needsModel`) and get it in the context.
 *
 * Outputs are values with units, the steps taken in plain language, issues,
 * and citations: every value names the code clause or table (or, for
 * mechanical and plumbing, the published method or coefficient source) it
 * rests on. Runs are deterministic: the same inputs, plugin version, pack
 * edition and criteria version give the same bytes (`runKey` fingerprints
 * them).
 */

/** The trades this release's calcs belong to. A pack's calcs name their own domain (its namespace, `struct`): an open string. */
export const KNOWN_CALC_DOMAINS = ["electrical", "mechanical", "plumbing"] as const;
export type KnownCalcDomain = (typeof KNOWN_CALC_DOMAINS)[number];
export type CalcDomain = KnownCalcDomain | (string & {});

export interface Citation {
  /** "code": an adopted code clause or table. "design_criteria": a firm/project target, not a code requirement. "method": a published equation or coefficient source. */
  readonly source: "code" | "design_criteria" | "method";
  /** "NEC", "PermitZIP design criteria", "ASHRAE Fundamentals", … */
  readonly code: string;
  readonly edition: string | null;
  /** "310.16", "Table 250.122", "Chapter 9, Table 9" */
  readonly clause: string;
  /** "75°C column", "first 10 kVA at 100%" */
  readonly detail?: string;
  /** One line a person can read: "NEC 2023 310.16, 75°C column". */
  readonly text: string;
}

export interface CalcValue {
  readonly key: string;
  readonly label: string;
  readonly value: number | string | boolean | null;
  /** A calc unit (`A`, `mbh`), or any @permitzip/bim-units code (`lbf`, `cfs`, `kip*ft`); a pack's calc uses the latter. Checked when the calc runs. */
  readonly unit: CalcUnit | null;
  readonly cite: readonly Citation[];
}

/** What a calc value's unit may be: this package's short names, or a bim-units code. */
export type CalcUnit = Unit | UnitCode;

export interface CalcStep {
  readonly label: string;
  readonly detail: string;
  readonly cite: readonly Citation[];
}

export interface CalcIssue {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly cite: readonly Citation[];
}

export interface CalcOutput<D> {
  readonly values: readonly CalcValue[];
  readonly steps: readonly CalcStep[];
  readonly issues: readonly CalcIssue[];
  /** The full structured result (tables of sizes, the kernel's report for ported calcs). */
  readonly detail: D;
}

/** One edition of a code pack (NEC 2020, NEC 2023): its clause numbering and its tables. */
export interface CodeEdition<Clause extends string = string, Tables = unknown> {
  readonly family: string;
  readonly code: string;
  readonly edition: string;
  /** Data version of the transcription; bumps when a value or source note changes. */
  readonly packVersion: string;
  readonly clauses: Readonly<Record<Clause, string>>;
  readonly tables: Tables;
}

/** Firm or project design targets that are not code requirements (voltage-drop targets, default power factor). */
export interface DesignCriteria {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly electrical: {
    readonly branchVoltageDropPct: number;
    readonly feederVoltageDropPct: number;
    readonly combinedVoltageDropPct: number;
    readonly powerFactor: number;
    readonly ambientC: number;
  };
}

export interface CalcContext {
  readonly code: CodeEdition | null;
  readonly criteria: DesignCriteria;
  readonly model: ModelState | null;
}

export interface CalcPlugin<S extends z.ZodType, D> {
  readonly id: string;
  /** Bumps whenever the plugin's method or outputs change. */
  readonly version: string;
  readonly domain: CalcDomain;
  readonly title: string;
  /** What it calculates and from what, for a list or an agent. */
  readonly summary: string;
  /** The code pack family it needs ("nec"), or null for method-based calcs. */
  readonly codeFamily: string | null;
  readonly needsModel: boolean;
  readonly input: S;
  /** A worked input an agent can copy (the raw form, before defaults). */
  readonly example: z.input<S>;
  run(input: z.output<S>, ctx: CalcContext): CalcOutput<D>;
}

export interface CalcRun {
  readonly calc: { readonly id: string; readonly version: string; readonly title: string; readonly domain: CalcDomain };
  readonly code: { readonly family: string; readonly edition: string; readonly packVersion: string } | null;
  readonly criteria: { readonly id: string; readonly version: string };
  readonly inputs: unknown;
  readonly values: readonly CalcValue[];
  readonly steps: readonly CalcStep[];
  readonly issues: readonly CalcIssue[];
  /** Every citation the run used, once each, in first-use order. */
  readonly citations: readonly Citation[];
  readonly detail: unknown;
  /** Fingerprint of inputs + plugin version + pack edition/version + criteria version. */
  readonly runKey: string;
}
