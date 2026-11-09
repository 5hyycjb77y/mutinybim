import { designLimitsFor, type DesignLimit, type DesignLimitLayer, type DesignLimitSources } from "@permitzip/bim-kernel/policy";

/**
 * Electrical's starting design limits (round 12 E12; product decision, Nov 3 2026):
 * best-practice defaults per electrical system, each with where it came from
 * in our own words, contributed to `DESIGN_LIMIT_DEFAULT_POINT`. A firm edits
 * any of them in its library and a project edits the firm's (same id). No
 * code-book text: values only, with their source.
 *
 * Systems are in this add-on's words: `panelboard` (a panel's spaces and
 * bus), `service` (the service and its distribution), `feeder`,
 * `branch_circuit`, and `feeder_and_branch` (the two together, source to
 * outlet).
 */

const PRODUCT_DECISION = "PermitZIP practice (product decision, Nov 3 2026)";
const ELECTRICAL_REVIEW = "PermitZIP practice (electrical design review video, Oct 2026)";
const COMMON = "Common design practice; firm to confirm";

export const ELECTRICAL_DESIGN_LIMIT_DEFAULTS: readonly DesignLimit[] = [
  {
    id: "electrical.panel_spare_capacity",
    label: "Spare capacity on panels",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["panelboard"] },
    band: { min: 25 },
    severity: "warning",
    citation: { source: PRODUCT_DECISION, note: "Leave a quarter of each panel's capacity free for the tenant's changes and future loads." },
  },
  {
    id: "electrical.service_cushion",
    label: "Service and distribution cushion",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["service"] },
    band: { min: 30 },
    severity: "warning",
    citation: { source: ELECTRICAL_REVIEW, note: "Size the service and switchboard 30 to 40 % above the calculated demand; 30 % is the starting value." },
  },
  {
    id: "electrical.feeder_voltage_drop",
    label: "Feeder voltage drop",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["feeder"] },
    band: { max: 2 },
    severity: "warning",
    citation: { source: COMMON, note: "Most of the drop budget goes to the branch circuits, so feeders are held lower." },
  },
  {
    id: "electrical.branch_voltage_drop",
    label: "Branch circuit voltage drop",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["branch_circuit"] },
    band: { max: 3 },
    severity: "warning",
    citation: { source: COMMON, note: "Long home runs get upsized conductors before they reach this." },
  },
  {
    id: "electrical.total_voltage_drop",
    label: "Feeder plus branch voltage drop",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["feeder_and_branch"] },
    band: { max: 5 },
    severity: "warning",
    citation: { source: COMMON, note: "From the service to the farthest outlet, feeder and branch together." },
  },
  {
    id: "electrical.branch_loading",
    label: "Branch circuit loading (continuous loads)",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["branch_circuit"] },
    band: { max: 80 },
    severity: "warning",
    citation: { source: COMMON, note: "A breaker carrying a continuous load is held to 80 % of its rating unless it is rated for full load." },
  },
  {
    id: "electrical.phase_unbalance",
    label: "Panel phase unbalance",
    quantity: "ratio",
    unit: "%",
    appliesTo: { discipline: "electrical", systems: ["panelboard"] },
    band: { max: 15 },
    severity: "info",
    citation: { source: COMMON, note: "Spread single-pole loads so no phase is far from the others; it only warns once the worst phase is also 1,000 VA off, so a nearly empty panel stays quiet." },
  },
];

export const PANEL_SPARE_LIMIT_ID = "electrical.panel_spare_capacity";
export const SERVICE_CUSHION_LIMIT_ID = "electrical.service_cushion";

/** A capacity target in force: the fraction (0.25), where it came from in words, and which layer set it (this project, the firm, or the add-on's default). */
export interface CapacityTarget {
  readonly fraction: number;
  readonly source: string;
  readonly layer: DesignLimitLayer;
  /** The limit row in force (what a project's own change starts from). */
  readonly limit: DesignLimit;
}

function targetOf(id: string, system: string, sources: DesignLimitSources): CapacityTarget {
  const row = designLimitsFor({ quantity: "ratio", discipline: "electrical", system }, undefined, sources).find((r) => r.limit.id === id && r.limit.band.min !== undefined);
  const limit = row?.limit ?? ELECTRICAL_DESIGN_LIMIT_DEFAULTS.find((d) => d.id === id);
  if (!limit || limit.band.min === undefined) throw new Error(`Electrical's design limit ${id} has no minimum`);
  return { fraction: limit.band.min / 100, source: limit.citation.source, layer: row?.layer ?? "addon", limit };
}

/** The spare capacity a panel should keep, as a fraction (0.25), from the limit in force for this project (firm and project edits win). */
export function panelSpareTarget(sources: DesignLimitSources = {}): CapacityTarget {
  return targetOf(PANEL_SPARE_LIMIT_ID, "panelboard", sources);
}

/** The cushion a service is sized with above its demand, as a fraction (0.30), from the limit in force. */
export function serviceCushion(sources: DesignLimitSources = {}): CapacityTarget {
  return targetOf(SERVICE_CUSHION_LIMIT_ID, "service", sources);
}

/** A measured spare or cushion against its target, with the line a schedule prints. */
export interface CapacityReading {
  /** Whole percent; null when there is nothing to measure against (no rating, no demand). */
  readonly percent: number | null;
  readonly target: CapacityTarget;
  /** True only when measured and under the target (the line then says "Below target" in words). */
  readonly below: boolean;
  readonly text: string;
}

const pct = (fraction: number) => Math.round(fraction * 100);

function reading(label: string, fraction: number | null, target: CapacityTarget, unknown: string): CapacityReading {
  const t = pct(target.fraction);
  if (fraction === null || !Number.isFinite(fraction)) return { percent: null, target, below: false, text: `${label}: ${unknown} (target ${t} %)` };
  const percent = pct(fraction);
  const below = percent < t;
  return { percent, target, below, text: below ? `${label}: ${percent} % — Below target (${t} %)` : `${label}: ${percent} % (target ${t} %)` };
}

/** A panel's spare capacity: what is left of the rating that limits it, as a share of that rating ("Spare capacity: 31 % (target 25 %)"). */
export function spareCapacityReading(capacity: { readonly limitA: number | null; readonly headroomA: number | null }, sources: DesignLimitSources = {}): CapacityReading {
  const ok = capacity.limitA !== null && capacity.limitA > 0 && capacity.headroomA !== null;
  return reading("Spare capacity", ok ? (capacity.headroomA ?? 0) / (capacity.limitA ?? 1) : null, panelSpareTarget(sources), "no rating to measure against");
}

/** A service's cushion over its demand: the service rating over the demand it is sized for ("Cushion over demand: 42 % (target 30 %)"). */
export function serviceCushionReading(service: { readonly demandA: number; readonly serviceA: number | null }, sources: DesignLimitSources = {}): CapacityReading {
  const ok = service.serviceA !== null && service.demandA > 0;
  return reading("Cushion over demand", ok ? (service.serviceA ?? 0) / service.demandA - 1 : null, serviceCushion(sources), "no standard service to measure");
}
