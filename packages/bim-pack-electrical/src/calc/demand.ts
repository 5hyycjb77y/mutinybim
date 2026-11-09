import { z } from "zod";
import { continuousClassRule, necCite, type NecClause, type NecEdition, type DemandStep, type LightingOccupancy, type CalcIssue, type CalcOutput, type CalcStep, type CalcValue, type Citation, ampsFromVa, q, round } from "@permitzip/bim-calc";
import { nextStandardRating } from "./nec";

/**
 * NEC Article 220 demand at one node (a panel, a switchboard, a service):
 * connected load by class, the demand factor for each class, the calculated
 * load, and the load conductors and the device are sized for (continuous at
 * 125%).
 *
 * The input is the raw inventory of everything below the node, never the
 * children's demands: a quantity-based factor (220.56 kitchen equipment) is
 * applied to the count at this node, so the MDP and the panel that serves the
 * kitchen get different factors for the same equipment.
 */

export const LOAD_CLASSES = ["lighting", "receptacle", "kitchen", "motor", "hvac", "heating", "cooling", "other"] as const;
export type LoadClass = (typeof LOAD_CLASSES)[number];

const LOAD = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    class: z.enum(LOAD_CLASSES).describe("lighting (general lighting), receptacle (non-dwelling receptacles, 180 VA each per 220.14), kitchen (commercial kitchen equipment, 220.56), motor, hvac (motor-driven equipment at 100%, eligible as the largest motor), heating and cooling (noncoincident: the larger set counts, 220.60), other (100%)."),
    va: z.number().positive().max(10_000_000).describe("Apparent power of ONE unit, VA. For a motor give V x FLA (x √3 three-phase)."),
    quantity: z.number().int().min(1).max(10_000).default(1),
    continuous: z.boolean().optional().describe("Runs 3 hours or more. Default from the code pack: lighting, and heating (fixed electric space heating, 424.4(B)); false otherwise."),
  })
  .strict();

export const demandInput = z
  .object({
    node: z.string().trim().min(1).max(80).optional().describe('What this load is for, e.g. "MDP" or "panel L1" (for the trail).'),
    occupancy: z.enum(["dwelling", "hospital", "hotel", "warehouse", "other"]).default("other").describe("For the general lighting demand table."),
    voltage_v: z.number().positive().max(1000).describe("Line-to-line voltage for three-phase (480, 208), the circuit voltage for single-phase."),
    phases: z.union([z.literal(1), z.literal(3)]),
    loads: z.array(LOAD).min(1).max(20_000).describe("Every load below this node (the raw inventory, not child panels' demand)."),
  })
  .strict();

export type DemandInput = z.infer<typeof demandInput>;

export interface DemandRow {
  readonly key: string;
  readonly label: string;
  readonly units: number;
  readonly connectedVa: number;
  readonly demandVa: number;
  /** demand / connected for display. */
  readonly factor: number;
  readonly continuousVa: number;
  readonly basis: string;
  readonly cite: readonly Citation[];
}

export interface DemandDetail {
  readonly node: string | null;
  readonly rows: readonly DemandRow[];
  readonly connectedVa: number;
  readonly demandVa: number;
  readonly demandA: number;
  readonly sizingVa: number;
  readonly sizingA: number;
  readonly minimumOcpdA: number | null;
  readonly kitchenUnits: number;
  readonly omittedNoncoincident: "heating" | "cooling" | null;
}

/** Apply stepped factors (first 3000 VA at 100%, next … at 35%, …) to a total. */
export function stepped(total: number, steps: readonly DemandStep[]): number {
  let left = total;
  let from = 0;
  let out = 0;
  for (const s of steps) {
    const span = Math.min(left, s.upToVa - from);
    if (span <= 0) break;
    out += span * s.factor;
    left -= span;
    from = s.upToVa;
  }
  return out;
}

export function kitchenFactor(nec: NecEdition, units: number): number {
  return nec.tables.KITCHEN_DEMAND.find((r) => units >= r.minUnits)?.factor ?? 1;
}

/** Identical units, kept grouped: a service with thousands of loads is not expanded one by one. */
interface Unit {
  readonly va: number;
  readonly continuous: boolean;
  readonly label: string;
  readonly quantity: number;
}

export interface DemandOptions {
  /** The clause that sizes this node's conductors at noncontinuous + 125% of continuous: a feeder (default) or the service. */
  readonly sizingClause?: Extract<NecClause, "feeder_continuous" | "service_continuous">;
}

export function demandLoad(nec: NecEdition, input: DemandInput, options: DemandOptions = {}): CalcOutput<DemandDetail> {
  const issues: CalcIssue[] = [];
  const steps: CalcStep[] = [];
  const units = new Map<LoadClass, Unit[]>();
  for (const [i, l] of input.loads.entries()) {
    const list = units.get(l.class) ?? [];
    if (l.quantity > 0) list.push({ va: l.va, continuous: l.continuous ?? continuousClassRule(nec, l.class) !== null, label: l.label ?? `${l.class} ${i + 1}`, quantity: l.quantity });
    units.set(l.class, list);
  }
  const sum = (list: readonly Unit[]) => list.reduce((a, u) => a + u.va * u.quantity, 0);
  const sumCont = (list: readonly Unit[]) => list.reduce((a, u) => a + (u.continuous ? u.va * u.quantity : 0), 0);
  const count = (list: readonly Unit[]) => list.reduce((a, u) => a + u.quantity, 0);
  const rows: DemandRow[] = [];
  const row = (key: string, label: string, list: readonly Unit[], demandVa: number, basis: string, cite: readonly Citation[]) => {
    const connectedVa = sum(list);
    const continuousShare = connectedVa > 0 ? sumCont(list) / connectedVa : 0;
    rows.push({ key, label, units: count(list), connectedVa, demandVa, factor: connectedVa > 0 ? demandVa / connectedVa : 0, continuousVa: demandVa * continuousShare, basis, cite });
  };

  // General lighting.
  const lighting = units.get("lighting") ?? [];
  if (lighting.length > 0) {
    const occupancy: LightingOccupancy = input.occupancy;
    const total = sum(lighting);
    const demand = stepped(total, nec.tables.LIGHTING_DEMAND[occupancy]);
    row("lighting", "General lighting", lighting, demand, occupancy === "other" ? "100% (all other occupancies)" : `${occupancy} demand steps`, [necCite(nec, "lighting_demand", occupancy === "other" ? "all others, 100%" : occupancy)]);
    if (occupancy === "hospital" || occupancy === "hotel") issues.push({ severity: "info", message: `The ${occupancy} lighting factors don't apply to areas where all the lighting is likely to be on at once (operating rooms, ballrooms, dining rooms); enter those as "other".`, cite: [necCite(nec, "lighting_demand")] });
  }

  // Receptacles.
  const receptacles = units.get("receptacle") ?? [];
  if (receptacles.length > 0) {
    const total = sum(receptacles);
    if (input.occupancy === "dwelling") {
      row("receptacle", "Receptacles", receptacles, total, "100%: the non-dwelling receptacle table doesn't apply in a dwelling", [necCite(nec, "receptacle_demand", "not applied: dwelling occupancy")]);
      issues.push({ severity: "warning", message: "In a dwelling, general-use receptacles are part of the general lighting load (3 VA per sq ft), not a separate receptacle load; they were counted at 100%.", cite: [necCite(nec, "lighting_demand")] });
    } else {
      row("receptacle", "Receptacles", receptacles, stepped(total, nec.tables.RECEPTACLE_DEMAND), "first 10 kVA at 100%, the rest at 50%", [necCite(nec, "receptacle_demand", "first 10 kVA at 100%, remainder at 50%")]);
    }
  }

  // Kitchen equipment, by count at this node.
  const kitchen = units.get("kitchen") ?? [];
  if (kitchen.length > 0) {
    const total = sum(kitchen);
    const kitchenUnits = count(kitchen);
    const f = kitchenFactor(nec, kitchenUnits);
    const largestTwo = [...kitchen]
      .sort((a, b) => b.va - a.va)
      .flatMap((u) => [u.va, ...(u.quantity > 1 ? [u.va] : [])])
      .slice(0, 2)
      .reduce((a, va) => a + va, 0);
    const demand = Math.min(total, Math.max(total * f, largestTwo));
    const floorGoverns = largestTwo > total * f + 1e-9;
    row("kitchen", "Kitchen equipment (220.56)", kitchen, demand, `${kitchenUnits} unit${kitchenUnits === 1 ? "" : "s"} at ${Math.round(f * 100)}%${floorGoverns ? `; held at the two largest (${round(largestTwo, 0)} VA)` : ""}`, [necCite(nec, "kitchen_demand", `${kitchenUnits} units: ${Math.round(f * 100)}%${floorGoverns ? ", not less than the two largest loads" : ""}`)]);
    steps.push({ label: "Kitchen equipment count", detail: `${kitchenUnits} kitchen units below ${input.node ?? "this node"} → ${Math.round(f * 100)}%${floorGoverns ? `, but not less than the two largest (${round(largestTwo, 0)} VA)` : ""}`, cite: [necCite(nec, "kitchen_demand")] });
  }

  // Heating vs cooling: only the larger set counts.
  const heating = units.get("heating") ?? [];
  const cooling = units.get("cooling") ?? [];
  let omitted: "heating" | "cooling" | null = null;
  if (heating.length > 0 && cooling.length > 0) {
    omitted = sum(heating) >= sum(cooling) ? "cooling" : "heating";
    const kept = omitted === "cooling" ? heating : cooling;
    const dropped = omitted === "cooling" ? cooling : heating;
    steps.push({ label: "Noncoincident loads", detail: `${omitted === "cooling" ? "Heating" : "Cooling"} (${round(sum(kept), 0)} VA) is larger than ${omitted} (${round(sum(dropped), 0)} VA); ${omitted} is left out`, cite: [necCite(nec, "noncoincident")] });
  }
  const atFull = necCite(nec, "calculated_load", "sum of the loads after demand factors; no factor for this class");
  const spaceHeating = necCite(nec, "space_heating_load", "fixed electric space heating at 100% of the connected load");
  if (heating.length > 0 && omitted !== "heating") row("heating", "Heating", heating, sum(heating), "100%", omitted ? [necCite(nec, "noncoincident", "larger of heating and cooling"), spaceHeating] : [spaceHeating]);
  if (cooling.length > 0 && omitted !== "cooling") row("cooling", "Cooling", cooling, sum(cooling), "100%", omitted ? [necCite(nec, "noncoincident", "larger of heating and cooling")] : [atFull]);

  // Motors and motor-driven equipment at 100%, plus 25% of the largest.
  const motors = units.get("motor") ?? [];
  const hvac = units.get("hvac") ?? [];
  if (motors.length > 0) row("motor", "Motors", motors, sum(motors), "100%", [necCite(nec, "motor_load")]);
  if (hvac.length > 0) row("hvac", "HVAC equipment", hvac, sum(hvac), "100%", [necCite(nec, "motor_load")]);
  const motorCandidates = [...motors, ...hvac, ...(omitted === "cooling" ? [] : cooling)];
  if (motorCandidates.length > 0) {
    const largest = motorCandidates.reduce((a, u) => (u.va > a.va ? u : a));
    const extra = largest.va * nec.tables.LARGEST_MOTOR_EXTRA;
    rows.push({ key: "largest_motor", label: "Largest motor (+25%)", units: 1, connectedVa: 0, demandVa: extra, factor: 0, continuousVa: 0, basis: `25% of ${largest.label} (${round(largest.va, 0)} VA)`, cite: [necCite(nec, "largest_motor", `25% of the largest motor, ${largest.label}`)] });
  }

  const other = units.get("other") ?? [];
  if (other.length > 0) row("other", "Other", other, sum(other), "100%", [atFull]);

  const connectedVa = rows.reduce((a, r) => a + r.connectedVa, 0) + (omitted ? sum(omitted === "cooling" ? cooling : heating) : 0);
  const demandVa = rows.reduce((a, r) => a + r.demandVa, 0);
  const continuousVa = rows.reduce((a, r) => a + r.continuousVa, 0);
  const sizingVa = demandVa + continuousVa * (nec.tables.CONTINUOUS_FACTOR - 1);
  const volts = q(input.voltage_v, "V");
  const demandA = ampsFromVa(q(demandVa, "VA"), volts, input.phases);
  const sizingA = ampsFromVa(q(sizingVa, "VA"), volts, input.phases);
  const minimumOcpdA = nextStandardRating(nec, sizingA);
  const pct = Math.round(nec.tables.CONTINUOUS_FACTOR * 100);
  const contCite = necCite(nec, options.sizingClause ?? "feeder_continuous", `noncontinuous load plus ${pct}% of the continuous load`);
  // Why each class is continuous, where the code says so and the load didn't say otherwise.
  const classCites: Citation[] = [];
  for (const r of rows) {
    const rule = r.continuousVa > 0 ? continuousClassRule(nec, r.key) : null;
    const clause = rule?.clause ?? null;
    if (rule && clause && !classCites.some((c) => c.clause === nec.clauses[clause])) classCites.push(necCite(nec, clause, rule.basis));
  }

  for (const r of rows) steps.push({ label: r.label, detail: `${round(r.connectedVa, 0)} VA connected → ${round(r.demandVa, 0)} VA (${r.basis})`, cite: r.cite });
  steps.push({ label: "Sizing load", detail: `${round(demandVa - continuousVa, 0)} VA noncontinuous + ${pct}% of ${round(continuousVa, 0)} VA continuous = ${round(sizingVa, 0)} VA = ${round(sizingA, 1)} A at ${input.voltage_v} V ${input.phases}-phase`, cite: [contCite, ...classCites] });

  const rowCites = [necCite(nec, "calculated_load"), ...rows.flatMap((r) => r.cite)];
  const values: CalcValue[] = [
    { key: "connected_va", label: "Connected load", value: round(connectedVa, 0), unit: "VA", cite: [necCite(nec, "calculated_load")] },
    { key: "demand_va", label: "Calculated (demand) load", value: round(demandVa, 0), unit: "VA", cite: rowCites },
    { key: "demand_a", label: "Calculated load current", value: round(demandA, 1), unit: "A", cite: rowCites },
    { key: "sizing_va", label: "Load for conductors and the device (continuous at 125%)", value: round(sizingVa, 0), unit: "VA", cite: [contCite, ...classCites] },
    { key: "sizing_a", label: "Current for conductors and the device", value: round(sizingA, 1), unit: "A", cite: [contCite, ...classCites] },
    { key: "minimum_ocpd_a", label: "Smallest standard device", value: minimumOcpdA, unit: "A", cite: [necCite(nec, "feeder_ocpd"), necCite(nec, "standard_ratings")] },
    ...rows.map((r): CalcValue => ({ key: `demand_${r.key}_va`, label: `${r.label} demand`, value: round(r.demandVa, 0), unit: "VA", cite: r.cite })),
  ];
  if (minimumOcpdA === null) issues.push({ severity: "error", message: `${round(sizingA, 0)} A is above the largest standard rating (6000 A).`, cite: [necCite(nec, "standard_ratings")] });

  return {
    values,
    steps,
    issues,
    detail: { node: input.node ?? null, rows, connectedVa, demandVa, demandA, sizingVa, sizingA, minimumOcpdA, kitchenUnits: count(kitchen), omittedNoncoincident: omitted },
  };
}
