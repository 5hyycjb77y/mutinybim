import {
  DEFAULT_ALLOCATION_POLICY,
  NO_SPACES,
  allocateServedBy,
  allocationPolicyOf,
  loadIndexOf,
  loadPointQuantities,
  servesOf,
  type AllocatedActual,
  type AllocationPolicy,
  type BimElement,
  type ElementId,
  type ModelState,
  type PartInstance,
  type QuantityTotals,
  type SpaceLocator,
} from "@permitzip/bim-kernel";
import { activePackSet, defineExtensionPoint } from "@permitzip/bim-kernel/packs";
import { round, SQRT3 } from "../units";

/** What a source supplies, when it is a power source: its name and the system it puts out. */
export interface SourceSupply {
  readonly name: string;
  /** Line-to-line voltage of the system the source supplies. */
  readonly voltageV: number;
  readonly phases: 1 | 3;
}

/** How a part reads as a supplying source (v1): the first row that answers wins, in set order. */
export interface SourceSupplyRow {
  readonly id: string;
  read(elements: Readonly<Record<string, BimElement>>, part: PartInstance): SourceSupply | null;
}

/** Source supplies (v1): a trade says what one of its sources puts out (a panel's voltage and phases), for the load totals by source. */
export const SOURCE_SUPPLY_POINT = defineExtensionPoint<SourceSupplyRow>({
  id: "calc.source_supply",
  version: 1,
  label: "Source supplies",
  idOf: (row) => row.id,
});

function supplyOf(elements: Readonly<Record<string, BimElement>>, part: PartInstance): SourceSupply | null {
  for (const row of activePackSet().items(SOURCE_SUPPLY_POINT)) {
    const supply = row.read(elements, part);
    if (supply) return supply;
  }
  return null;
}

/**
 * Load totals by source, before anything is drawn (ROADMAP F2, E1, P1): what
 * the service, a panel, a water heater, the gas meter or the grease
 * interceptor sees from the loads that name it. Estimates and the real
 * devices inside them count once (the kernel's allocated-vs-actual); a
 * typical unit's loads once per instance at a source outside the unit. These are
 * connected loads; demand factors are the panel and service calcs' job.
 */

export interface SourceLoad {
  readonly sourceId: ElementId;
  readonly name: string;
  /** What the source counts (connected), per quantity. */
  readonly counted: QuantityTotals;
  /** Each estimate group under this source: "estimate 2 kW, devices so far 0.8 kW" (in the group's own terms), and how many times it counts here (a typical unit's instances). */
  readonly estimates: readonly { readonly estimateIds: readonly ElementId[]; readonly figures: AllocatedActual; readonly instances: number }[];
  /** Electrical sources: the current the connected load draws at the source's voltage; null when it has none. */
  readonly amps: number | null;
  readonly voltageV: number | null;
  readonly phases: 1 | 3 | null;
  readonly policy: AllocationPolicy;
}

export function sourceLoad(model: ModelState, sourceId: string, opts: { readonly locator?: SpaceLocator; readonly firmPolicy?: AllocationPolicy } = {}): SourceLoad {
  const elements = model.elements;
  const policy = allocationPolicyOf(elements, opts.firmPolicy ?? DEFAULT_ALLOCATION_POLICY);
  const a = allocateServedBy(elements, sourceId, opts.locator ?? NO_SPACES, policy);
  const part = elements[sourceId];
  const dist = part?.kind === "part" ? supplyOf(elements, part) : null;
  const volts = dist ? dist.voltageV : null;
  const phases = dist ? dist.phases : null;
  const amps = volts && phases ? round(a.counted.va / (phases === 3 ? volts * SQRT3 : volts), 0) : null;
  return {
    sourceId: sourceId as ElementId,
    name: dist?.name ?? (part?.kind === "part" ? part.mark || part.id : sourceId),
    counted: a.counted,
    estimates: a.groups.map((g) => ({ estimateIds: g.estimateIds, figures: g.figures, instances: g.factor })),
    amps,
    voltageV: volts,
    phases,
    policy,
  };
}

/** One fixture as the grease interceptor calc takes it (plumbing.grease_interceptor `fixtures`). */
export interface GreaseFixture {
  readonly label: string;
  readonly quantity: number;
  readonly volume_gal?: number;
  readonly length_in?: number;
  readonly width_in?: number;
  readonly depth_in?: number;
  readonly compartments: number;
}

/**
 * The fixtures a grease interceptor serves, for its sizing calc: every load
 * that names it as source (a row typed before any pipe) plus every load the
 * drawn sanitary network brings to it. Bowl sizes come from the load's own
 * parameters ("compartment length/width/depth" in inches, "compartments", or
 * "compartment volume" in gallons). A load with no bowl size is listed in
 * `missing`, never guessed.
 */
export function greaseInterceptorFixtures(model: ModelState, interceptorId: string): { readonly fixtures: readonly GreaseFixture[]; readonly missing: readonly string[] } {
  const elements = model.elements;
  const gi = elements[interceptorId];
  const ids = new Set<string>(loadIndexOf(elements).servedBy(interceptorId));
  if (gi) for (const id of servesOf(elements, gi)) ids.add(id);
  const fixtures: GreaseFixture[] = [];
  const missing: string[] = [];
  for (const id of [...ids].sort()) {
    const lp = elements[id];
    if (lp?.kind !== "load_point") continue;
    const bag = loadPointQuantities(elements, lp);
    const param = (name: string): number | undefined => {
      const c = (bag.custom ?? []).find((x) => x.name.trim().toLowerCase().replace(/[\s_-]+/g, " ") === name);
      return c ? c.value : undefined;
    };
    const label = lp.mark || lp.connectionType || lp.id;
    const volume = param("compartment volume");
    const [l, w, d] = [param("compartment length"), param("compartment width"), param("compartment depth")];
    const compartments = Math.max(1, Math.round(param("compartments") ?? 1));
    const quantity = lp.basis === "count" ? (lp.count ?? 1) : 1;
    if (volume !== undefined) fixtures.push({ label, quantity, volume_gal: volume, compartments });
    else if (l !== undefined && w !== undefined && d !== undefined) fixtures.push({ label, quantity, length_in: l, width_in: w, depth_in: d, compartments });
    else missing.push(label);
  }
  return { fixtures, missing };
}
