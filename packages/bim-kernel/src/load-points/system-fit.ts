import type { CatalogTrade } from "../catalog/types";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { SystemKind } from "../parts";
import { CONNECTION_SIZE_KEYS, CONNECTION_SIZE_LABELS, QUANTITIES, bagSummary, quantityValueLabel, type ConnectionSizeKey, type QuantityBag, type QuantityKey } from "../quantities";
import { systemKindLabel } from "../routing/system-label";
import type { BimElement, ElementId, MepSystem } from "../types";
import { connectionTypeOfLoadPoint, loadPointLoad, loadPointQuantities, primaryQuantity } from "./model";
import { runEndOf, type LoadRecord } from "../requirements/anchor";

/**
 * Does a load point's connection type fit the system of the pipe it is on?
 * A type with no sign at all of a connection to that system (no size for it,
 * no quantity of its family: a floor drain on cold water) is refused when it
 * is placed. A type that may connect but adds nothing the system sizes on (a
 * flush-tank water closet on hot water, a sheet row with only total WSFU), own
 * values the system doesn't count, or a gas minimum inlet pressure above
 * what a gas outlet takes are warnings the agent and the person see.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** The connection-size column a system's pipe ends in (cw, hw, w, v, g). Null: no fixture-schedule column (air, power, hydronic). */
function sizeKeyOf(kind: SystemKind | null): ConnectionSizeKey | null {
  switch (kind) {
    case "domestic_cold_water":
      return "cw";
    case "domestic_hot_water":
    case "domestic_hot_water_return":
      return "hw";
    case "sanitary":
    case "grease_waste":
    case "indirect_waste":
      return "w";
    case "vent":
      return "v";
    case "natural_gas":
      return "g";
    default:
      return null;
  }
}

/** The connection a quantity implies: cold water fixture units mean a cold water connection. */
const IMPLIED: Partial<Record<QuantityKey, ConnectionSizeKey>> = { wsfu_cold: "cw", wsfu_hot: "hw", dfu: "w", mbh: "g" };

/** Which system family counts a quantity, for own values put on the wrong pipe. */
const FAMILY: Partial<Record<QuantityKey, "water" | "sanitary" | "gas" | "air">> = { wsfu_cold: "water", wsfu_hot: "water", wsfu_total: "water", gph_demand: "water", dfu: "sanitary", mbh: "gas", cfm: "air" };

function familyOf(kind: SystemKind | null): "water" | "sanitary" | "gas" | "air" | null {
  if (kind === "domestic_cold_water" || kind === "domestic_hot_water" || kind === "domestic_hot_water_return") return "water";
  if (kind === "sanitary" || kind === "grease_waste" || kind === "indirect_waste") return "sanitary";
  if (kind === "natural_gas") return "gas";
  if (kind === "supply_air" || kind === "return_air" || kind === "exhaust_air" || kind === "outside_air") return "air";
  return null;
}

/**
 * Quantities that show a type has some connection of a system's family. Water: any fixture units or hot water
 * demand, cold or hot (a sheet often carries only total WSFU); waste and vent: drainage units; gas: MBH.
 */
const EVIDENCE: Record<ConnectionSizeKey, readonly QuantityKey[]> = {
  cw: ["wsfu_cold", "wsfu_hot", "wsfu_total", "gph_demand"],
  hw: ["wsfu_cold", "wsfu_hot", "wsfu_total", "gph_demand"],
  w: ["dfu"],
  v: ["dfu"],
  g: ["mbh"],
};

/** Any sign the type connects to this system: its size, a vent's waste size, or a quantity of the system's family. */
function connectsTo(bag: QuantityBag, key: ConnectionSizeKey): boolean {
  if (bag.sizes?.[key] || (key === "v" && bag.sizes?.w)) return true;
  return EVIDENCE[key].some((q) => (bag[q] ?? 0) > 0);
}

/** Connections a bag has: its sizes, and what its quantities imply. */
function connectionsOf(bag: QuantityBag): ConnectionSizeKey[] {
  const out = new Set<ConnectionSizeKey>();
  for (const k of CONNECTION_SIZE_KEYS) if (bag.sizes?.[k]) out.add(k);
  for (const [q, c] of Object.entries(IMPLIED) as Array<[QuantityKey, ConnectionSizeKey]>) if ((bag[q] ?? 0) > 0) out.add(c);
  return CONNECTION_SIZE_KEYS.filter((k) => out.has(k));
}

const word = (k: ConnectionSizeKey) => CONNECTION_SIZE_LABELS[k].toLowerCase();

function hostSystem(elements: Elements, lp: LoadRecord): MepSystem | null {
  const at = runEndOf(lp);
  if (!at) return null;
  const host = elements[at.elementId];
  if (host?.kind !== "run_segment" && host?.kind !== "run_fitting") return null;
  const system = elements[host.systemId];
  return system?.kind === "mep_system" ? system : null;
}

/** "DCW-1 (domestic cold water)". */
function systemWords(system: MepSystem): string {
  return `${system.name} (${systemKindLabel(system).toLowerCase()})`;
}

/**
 * A trade's check on connection quantities as entered (v1): a value that is
 * almost certainly in the wrong unit (a gas minimum inlet pressure written in
 * psi that no gas outlet takes). Run on a connection type of `trade` when it
 * is saved, and on a load point placed on a pipe of `systemKinds`.
 */
export interface ConnectionQuantityCheckDef {
  readonly id: string;
  readonly trade: CatalogTrade;
  readonly systemKinds: readonly SystemKind[];
  warning(name: string, bag: QuantityBag): string | null;
}

export const CONNECTION_QUANTITY_CHECK_POINT = defineExtensionPoint<ConnectionQuantityCheckDef>({ id: "kernel.connection_quantity_check", version: 1, label: "Connection quantity checks", idOf: (c) => c.id });

function connectionQuantityChecks(): readonly ConnectionQuantityCheckDef[] {
  return activePackSet().items(CONNECTION_QUANTITY_CHECK_POINT);
}

/** Warnings for a connection type's quantities as saved, from the checks of the set in force for its trade. */
export function connectionTypeQuantityWarnings(entry: { readonly trade?: CatalogTrade; readonly designator: string; readonly quantities?: QuantityBag }): string[] {
  const out: string[] = [];
  for (const check of connectionQuantityChecks()) {
    if (check.trade !== entry.trade) continue;
    const w = check.warning(entry.designator, entry.quantities ?? {});
    if (w) out.push(w);
  }
  return out;
}

export interface LoadPointFit {
  /** Why this point can't go on its pipe: its type has no connection of the pipe's system. */
  readonly refusal: string | null;
  readonly warnings: readonly string[];
}

export function loadPointSystemFit(elements: Elements, lp: LoadRecord): LoadPointFit {
  const system = hostSystem(elements, lp);
  if (!system) return { refusal: null, warnings: [] };
  const kind = system.systemKind;
  const ct = connectionTypeOfLoadPoint(elements, lp);
  const bag = loadPointQuantities(elements, lp);
  const name = lp.mark || lp.connectionType || lp.id;
  const typeWords = ct ? `${ct.designator}${ct.description ? ` (${ct.description})` : ""}` : null;
  const primary = primaryQuantity(kind);
  const key = sizeKeyOf(kind);
  const has = connectionsOf(bag);
  // A type that names none of its connections (all zero, no sizes) can't be judged: it is placed, with the "adds nothing" warning below.
  if (typeWords && key && has.length > 0 && !connectsTo(bag, key)) {
    return { refusal: `${name} on ${runEndOf(lp)?.elementId ?? "its pipe"} (${system.name}, ${systemKindLabel(system).toLowerCase()}): ${typeWords} has no ${word(key)} connection (it has ${has.map(word).join(", ")})`, warnings: [] };
  }
  const warnings: string[] = [];
  const family = familyOf(kind);
  const adds = primary ? quantityValueLabel(primary, loadPointLoad(elements, lp)) : null;
  for (const [q, f] of Object.entries(FAMILY) as Array<[QuantityKey, string]>) {
    const own = lp.values[q];
    if (own === undefined || own === 0 || f === family) continue;
    warnings.push(`Its own ${q} (${quantityValueLabel(q, own)}) doesn't count on ${systemWords(system)}${adds ? `; this point adds ${adds} there` : ""}. If it is the fixture's ${f === "water" ? "cold water" : f === "sanitary" ? "waste" : f}, put it on the ${f === "water" ? "cold water" : f === "sanitary" ? "sanitary" : f} pipe`);
  }
  if (typeWords && primary && (bag[primary] ?? 0) <= 0) warnings.push(`${typeWords} connects to ${systemWords(system)} but adds no ${QUANTITIES[primary].label.toLowerCase()} there`);
  for (const check of connectionQuantityChecks()) {
    if (!check.systemKinds.includes(kind)) continue;
    const w = check.warning(name, bag);
    if (w) warnings.push(w);
  }
  return { refusal: null, warnings };
}

export interface LoadPointPlacementRow {
  readonly id: ElementId;
  /** The pipe it is on; null for a load not on a run end yet (an estimate, a row, a device load). */
  readonly pipe_id: string | null;
  readonly mark: string | null;
  readonly type: string | null;
  readonly system: string | null;
  /** What it adds to the pipe it is on, in the system's quantity; null where the system sizes on nothing (vent). */
  readonly adds: string | null;
  readonly loads: string;
  readonly warnings: readonly string[];
}

/** One row per load point: pipe, mark, type, system, what it adds there, its loads and any warning. */
export function loadPointPlacementRows(elements: Elements, ids: readonly string[]): LoadPointPlacementRow[] {
  const rows: LoadPointPlacementRow[] = [];
  for (const id of ids) {
    const lp = elements[id];
    if (lp?.kind !== "load_point") continue;
    const system = hostSystem(elements, lp);
    const primary = primaryQuantity(system?.systemKind ?? null);
    rows.push({
      id: lp.id,
      pipe_id: runEndOf(lp)?.elementId ?? null,
      mark: lp.mark || null,
      type: lp.connectionType || null,
      system: system ? systemWords(system) : null,
      adds: primary ? quantityValueLabel(primary, loadPointLoad(elements, lp)) : null,
      loads: bagSummary(loadPointQuantities(elements, lp)),
      warnings: loadPointSystemFit(elements, lp).warnings,
    });
  }
  return rows;
}
