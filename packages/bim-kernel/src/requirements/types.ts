import type { CatalogTrade } from "../catalog/types";
import type { QuantityKey, QuantityTotals } from "../quantities";
import type { ElementId, Vec2 } from "../types";
import type { BUILTIN_LOAD_SERVICE_IDS } from "../services/builtin";

/**
 * One load concept for every trade, with a lifecycle (KERNEL-REQUIREMENTS-MODEL
 * §3.3–3.4, ROADMAP F2; product decision, Oct 27: "distributed estimate on a space →
 * concentrated load point → real device").
 *
 * A load is stored as the existing `load_point` element (load-points/types.ts),
 * widened. Nothing is renamed and no record is migrated: every `lp:<host>:<port>`
 * id stays valid forever and reads as a load anchored to a run end. New loads
 * get generated ids.
 *
 * Its stage is derived, never typed:
 *
 *   estimate      anchored to a space or zone (or nothing), basis lump or density:
 *                 "kitchen ≈ 50 kW", "lighting 1.1 W/sf over Dining"
 *   concentrated  a place where load is concentrated: an open pipe end, a tap, a
 *                 point on a level, or a part's connector with nothing modelled there
 *   device        a modelled fixture, device or piece of equipment stands for it
 *                 (attachedPartId, or anchored to a part's connector)
 *
 * Quantities are the shared `QuantityBag` (va, wsfu, dfu, gph, mbh, cfm, …), the
 * same bag the aggregation, schedules and sizing already add, so power, gas,
 * water, drainage and airflow take one path.
 */

/**
 * What a load needs: the load service view of the service registry
 * (services/registry.ts), same strings and order as always. Absent: read from
 * the host network or the keys it sets (today's load points).
 */
export type LoadService = (typeof BUILTIN_LOAD_SERVICE_IDS)[number];

export type LoadAnchor =
  /** A table row: "35 fixtures" typed before anything exists. */
  | { readonly kind: "none" }
  /** Distributed over a space or zone (spaces/types.ts). */
  | { readonly kind: "space"; readonly id: ElementId }
  | { readonly kind: "zone"; readonly id: ElementId }
  /** Today's load point: an open run end or a fitting's port. */
  | { readonly kind: "run_end"; readonly hostId: ElementId; readonly port: string }
  /** A point on a level with no pipe yet. */
  | { readonly kind: "point"; readonly levelId: ElementId; readonly position: Vec2 }
  /** A part's connector (the fryer's gas inlet), planned or placed. */
  | { readonly kind: "part"; readonly partId: ElementId; readonly connector?: string };

export type LoadAnchorKind = LoadAnchor["kind"];

/**
 * How the value is known. `density` multiplies a rate by the space's area or
 * occupants (spaces own area; it is never typed). `count` is n × the connection
 * type's values (12 water closets).
 */
export type LoadBasis = "lump" | "density" | "count" | "calc";

/** One rate on a density load: 1.1 VA per square foot, 0.06 CFM per square foot + 5 CFM per person. */
export interface DensityRate {
  readonly key: QuantityKey;
  /** Per square metre of the space's area, or per occupant. Canonical units; bim-units formats per-ft² for display. */
  readonly per: "area" | "occupant";
  readonly value: number;
}

export interface LoadSource {
  readonly kind: "code" | "calc" | "engineer" | "client" | "vendor_doc";
  /** A clause ("IMC 403.3.1.1"), a calc id, or a cut-sheet page. */
  readonly ref: string;
}

/** The fields a load point gains (load-points/types.ts extends this). All optional: absent reads as today's load point. */
export interface LoadLifecycleFields {
  /** Where it is. Absent: `{ kind: "run_end", ...host }` for records that have `host` (every record before Oct 2026). */
  readonly anchor?: LoadAnchor;
  readonly service?: LoadService;
  /** Absent: lump (the bag is the value). */
  readonly basis?: LoadBasis;
  /** `basis: "density"` only. */
  readonly rates?: readonly DensityRate[];
  /** `basis: "count"` only. Absent: 1. */
  readonly count?: number;
  /** The logical source before anything is drawn: panel P1, WH-1, the gas meter, RTU-2. */
  readonly servedBy?: ElementId;
  readonly source?: LoadSource;
  /** "1" DCW capped for future tenant": counts in sizing, flagged as future. */
  readonly future?: boolean;
}

export type LoadStage = "estimate" | "concentrated" | "device";

/**
 * Fulfilment status, derived from anchor, servedBy and the drawn network.
 * `mismatch` is a finding (drawn source differs from servedBy, or delivered < required).
 */
export type LoadStatus = "open" | "assigned" | "placed" | "connected" | "attached" | "mismatch";

/**
 * How an estimate counts once real loads exist inside its space or zone
 * (Product decision, Oct 27, decision 4: keep the estimate until the real devices exceed it).
 *   max              per quantity, the larger of allocated and actual (default)
 *   actual_only      the real loads only, once any exist
 *   allocation_only  the estimate only (SD studies)
 */
export type AllocationPolicy = "max" | "actual_only" | "allocation_only";
export const DEFAULT_ALLOCATION_POLICY: AllocationPolicy = "max";

/**
 * Allocated vs actual for one estimate (or one space / zone / source total).
 * Shown everywhere a total is shown: "estimate 2 kW, devices so far 0.8 kW".
 */
export interface AllocatedActual {
  readonly allocated: QuantityTotals;
  readonly actual: QuantityTotals;
  /** What totals above this node count, per the policy. */
  readonly counted: QuantityTotals;
  /** Per quantity that is non-zero on either side: which side `counted` took. */
  readonly governing: Readonly<Partial<Record<QuantityKey, "allocated" | "actual">>>;
  /** The real loads that make up `actual`. */
  readonly actualIds: readonly ElementId[];
}

/** Counts by status in a scope (project, level, space, zone, source): "35 loads, 12 piped, 3 attached". */
export interface LoadProgress {
  readonly total: number;
  readonly byStatus: Readonly<Record<LoadStatus, number>>;
  readonly byStage: Readonly<Record<LoadStage, number>>;
}

export type LoadProgressScope =
  | { readonly kind: "project" }
  | { readonly kind: "level" | "space" | "zone" | "source"; readonly id: ElementId }
  /** One trade's loads: water and drainage fixtures under plumbing, gas rows under gas. A load filling two trades counts in each. */
  | { readonly kind: "trade"; readonly trade: CatalogTrade };
