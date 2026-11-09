import { connectionTypeOf } from "../catalog/model";
import { connectionLoadKind } from "../catalog/connection-field-point";
import { partDisciplines } from "../connections/trades";
import { loadPointTotals, partConnectionTypeName } from "../load-points/model";
import { paramValue, resolveConnectors, type SystemKind } from "../parts";
import { loadIndexOf } from "../requirements/load-index";
import type { BimElement, Discipline, PartInstance } from "../types";
import type { ZonePurpose } from "./types";

/**
 * Which equipment fits a zone's purpose, read from the shared connection
 * model so every trade answers the same way: a thermal or ventilation zone is
 * served by parts with an air or heating/cooling side (a duct or hydronic
 * connector, a stated airflow, an airflow load, or an electrical load class of
 * HVAC, heating or cooling, which is how an equipment list files "RTU-1"); an
 * electrical zone by parts that take part in electrical; a drainage area by
 * plumbing. A fryer with 120 V and 80 MBH is electrical and gas, not HVAC.
 *
 * Cost: the part's own record, its type, its connection type and its loads
 * from the per-record load index; never a pass over the model.
 */

type Elements = Readonly<Record<string, BimElement>>;

const THERMAL_SYSTEMS: ReadonlySet<SystemKind> = new Set<SystemKind>(["supply_air", "return_air", "exhaust_air", "outside_air", "hydronic_supply", "hydronic_return", "refrigerant", "condensate"]);
const THERMAL_LOAD_CLASSES: ReadonlySet<string> = new Set(["hvac", "heating", "cooling"]);

function statedPositive(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) && value > 0 : typeof value === "string" && value.trim() !== "" && value.trim() !== "0";
}

/** True when the part has an air or heating/cooling side in the connection model. */
export function hasThermalSide(elements: Elements, part: PartInstance): boolean {
  const type = elements[part.typeId];
  const def = type?.kind === "part_type" ? type.definition : null;
  if (def) {
    for (const c of resolveConnectors(def, part.values)) if (c.domain === "duct" || THERMAL_SYSTEMS.has(c.systemKind)) return true;
    if (statedPositive(paramValue(def, part.values, "airflow_cfm"))) return true;
    const cls = paramValue(def, part.values, "load_class");
    if (typeof cls === "string" && THERMAL_LOAD_CLASSES.has(cls)) return true;
  }
  const designator = partConnectionTypeName(elements, part);
  const entry = designator === null ? null : connectionTypeOf(elements, designator);
  if (entry && (THERMAL_LOAD_CLASSES.has(connectionLoadKind(entry, false) ?? "") || (entry.quantities?.cfm ?? 0) > 0)) return true;
  for (const id of loadIndexOf(elements).ofPart(part.id)) {
    const lp = elements[id];
    if (lp?.kind === "load_point" && loadPointTotals(elements, lp).cfm > 0) return true;
  }
  return false;
}

const PURPOSE_DISCIPLINE: Readonly<Partial<Record<ZonePurpose, Discipline>>> = {
  electrical_load_region: "electrical",
  lighting_control: "electrical",
  drainage_catchment: "plumbing",
};

/**
 * Whether the part fits a zone of this purpose (listed first, under the
 * purpose's own heading). Purposes with no trade of their own (a fire area)
 * fit every piece of equipment.
 */
export function fitsZonePurpose(elements: Elements, part: PartInstance, purpose: ZonePurpose): boolean {
  if (purpose === "thermal" || purpose === "ventilation") return hasThermalSide(elements, part);
  const discipline = PURPOSE_DISCIPLINE[purpose];
  return discipline === undefined || partDisciplines(elements, part).includes(discipline);
}
