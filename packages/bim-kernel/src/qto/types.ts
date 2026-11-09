import { defineExtensionPoint } from "../packs/contract";
import type { BimElement, ModelElementBase } from "../types";

/**
 * Quantities, classification, construction stages and the cost slots
 * (contract 1.4.0, lane Q). Cost flows developer → contractor → subs and
 * everyone between, and every party's numbers are commercially private, so
 * the shared model holds **quantities, never money**. A party's prices live
 * with that party and are multiplied by the model's quantities in the
 * reader's process only (`COST_SOURCE_POINT`).
 */

/** Peers read and store `classification` on types and instances. */
export const QTO_CLASSIFICATION_FEATURE = "qto:classification";
/** Peers read and store `construction_stage` records and the stage on elements. */
export const CONSTRUCTION_STAGES_FEATURE = "construction:stages";

// ── Measure rules ──────────────────────────────────────────────────────────

export const KNOWN_MEASURE_KINDS = ["length", "area", "volume", "count", "mass"] as const;
export type MeasureKind = (typeof KNOWN_MEASURE_KINDS)[number] | (string & {});

export interface MeasureDef {
  /** `qto.<name>` derived parameter key ("qto.length", "qto.area_net"). */
  readonly key: string;
  readonly kind: MeasureKind;
  /** bim-units code the value is in ("m", "m2", "m3", "ea", "kg"). */
  readonly unit: string;
  /** What it is measured from, in plain words ("centreline length", "face area net of openings"). */
  readonly from: string;
  /** Column heading words ("Length", "Net face area"). Absent: from the key. */
  readonly label?: string;
  /** The measure a change list leads with for this class (a wall's length, a door's count). Absent: not primary. */
  readonly primary?: boolean;
}

/**
 * How a class measures itself (v1): length of runs and walls, areas, volume,
 * count, mass from type parameters. A rule reads only the element and the
 * elements it names in `reads` (incremental: a measure re-runs when one of
 * those changes).
 */
export interface MeasureRuleDef {
  readonly id: string;
  readonly label: string;
  /** Element kinds it measures. */
  readonly kinds?: readonly string[];
  /** Class ids it measures (an explicit class wins over a kind). */
  readonly classes?: readonly string[];
  readonly measures: readonly MeasureDef[];
  /** Values by measure key; a measure it can't take is left out. */
  measure(element: BimElement, elements: Readonly<Record<string, BimElement>>): Readonly<Record<string, number>>;
  /** Other elements a measure of `element` read (hosted openings for a wall's net area). */
  reads?(element: BimElement, elements: Readonly<Record<string, BimElement>>): readonly string[];
  /** Narrows `kinds` / `classes` further (a rule for one service's links). Absent: every element they name. */
  appliesTo?(element: BimElement, elements: Readonly<Record<string, BimElement>>): boolean;
  /** A size or material its quantities also group by (`2" copper`, `#4 CU`). Absent: no such group. */
  sizeGroup?(element: BimElement, elements: Readonly<Record<string, BimElement>>): string | null;
}

export const MEASURE_RULE_POINT = defineExtensionPoint<MeasureRuleDef>({
  id: "kernel.measure_rule",
  version: 1,
  label: "Measure rules",
  idOf: (rule) => rule.id,
});

// ── Classification ─────────────────────────────────────────────────────────

/**
 * A code system (v1): a firm's own cost codes first, standard lists only
 * where the firm holds the right to use them (product owner decision 5). The kernel
 * bundles no licensed tables; codes arrive as the provider's data.
 */
export interface ClassificationSystemDef {
  /** `firm:cost_codes`, a pack's `acme.cost_codes`. */
  readonly id: string;
  readonly label: string;
  readonly version: string;
  /** Who may use it and under what licence, in plain words. */
  readonly licenceNote: string;
  /** The provider's codes, when it ships them. Absent: any code is accepted and named as given. */
  readonly codes?: readonly { readonly code: string; readonly label: string }[];
}

export const CLASSIFICATION_POINT = defineExtensionPoint<ClassificationSystemDef>({
  id: "kernel.classification",
  version: 1,
  label: "Classification systems",
  idOf: (system) => system.id,
});

/** One code on a type or an instance. An instance's code for a system wins over its type's. */
export interface ClassificationAssignment {
  readonly system: string;
  readonly code: string;
}

// ── Construction stages (record kind `construction_stage`) ─────────────────

/** A stage of construction: work areas, classes and planned dates. Never changes a design value. */
export interface ConstructionStageBody {
  readonly name: string;
  /** Sort order. */
  readonly order: number;
  /** Zones that are its work areas. */
  readonly zoneIds?: readonly string[];
  /** Classes built in it. */
  readonly classIds?: readonly string[];
  /** ISO 8601 dates. */
  readonly plannedStart?: string;
  readonly plannedFinish?: string;
}

export interface ConstructionStageElement extends ModelElementBase {
  readonly kind: "construction_stage";
  readonly stage: ConstructionStageBody;
  readonly schemaVersion?: number;
}

// ── Cost slots (reserved; no prices are built in round 7) ──────────────────

export const KNOWN_COST_PARTIES = ["developer", "gc", "sub", "design_firm", "supplier", "lender"] as const;
export type CostPartyKind = (typeof KNOWN_COST_PARTIES)[number] | (string & {});

export interface CostParty {
  readonly kind: CostPartyKind;
  /** The company, as its host names it. */
  readonly id: string;
  readonly label: string;
}

export const KNOWN_COST_BASES = ["estimate", "budget", "contract", "change_order", "actual"] as const;
export type CostBasis = (typeof KNOWN_COST_BASES)[number] | (string & {});

/** Money in the reader's process only: an amount in minor units (cents) and an ISO 4217 currency code. Never stored in the model. */
export interface Money {
  readonly minor: number;
  readonly currency: string;
}

export type CostVisibility = { readonly kind: "party_only" } | { readonly kind: "shared_with"; readonly parties: readonly string[] };

/** Who owns a number (every cost line and every derived total). */
export interface CostProvenance {
  readonly ownedBy: { readonly party: string; readonly person?: string };
  readonly source: string;
  /** ISO 8601. */
  readonly date: string;
}

export interface CostRate {
  readonly classification: ClassificationAssignment;
  readonly stageId?: string;
  readonly typeId?: string;
  /** Price per one unit of `measure`. */
  readonly unitRate: Money;
  /** The `qto.*` measure it prices. */
  readonly measure: string;
  /** bim-units code of one unit of the measure. */
  readonly per: string;
  readonly provenance: CostProvenance;
}

/**
 * A party's price source (v1). The kernel multiplies its own quantities by a
 * bound rate snapshot in the reader's process; money never enters model
 * state, changesets or the model server.
 */
export interface CostSourceDef {
  readonly id: string;
  readonly party: CostParty;
  readonly basis: CostBasis;
  readonly currency: string;
  readonly effectiveDate: string;
  readonly visibility: CostVisibility;
  rates(): readonly CostRate[];
}

export const COST_SOURCE_POINT = defineExtensionPoint<CostSourceDef>({
  id: "kernel.cost_source",
  version: 1,
  label: "Cost sources",
  idOf: (source) => source.id,
});

/** A change order points at a scenario or a revision range; its quantity delta is computed, never typed. Reserved shape. */
export interface ChangeOrderLink {
  readonly id: string;
  readonly party: string;
  readonly scenarioId?: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly status: "draft" | "submitted" | "approved" | "rejected" | (string & {});
}

/**
 * Names reserved for later cost-source records (round 8+): pro forma and
 * feasibility inputs, budgets, draws and pay applications. Nothing reads or
 * writes them in round 7.
 */
/**
 * Round 11 D3a, reserved: a money amount two parties agreed (a change order's price, a pay
 * application's period). It lives in the parties' shared cost record, never in the model, and no
 * model command accepts it; it cites the model facts it rests on so anyone can re-derive the
 * quantities. Read shape only.
 */
export interface AgreedAmountRef {
  readonly parties: readonly [string, string];
  readonly subject: { readonly kind: "change_order" | "pay_application" | (string & {}); readonly id: string };
  readonly amount: Money;
  readonly cites: { readonly deltaDigest?: string; readonly gateDigest?: string; readonly priceBookVersion?: string };
  readonly agreedAt: string;
}

export const RESERVED_COST_RECORD_NAMES = ["pro_forma_input", "budget", "draw", "pay_application", "schedule_of_values"] as const;
