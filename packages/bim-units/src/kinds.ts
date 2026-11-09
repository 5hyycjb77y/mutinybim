import { dim, DIMENSIONLESS } from "./dimension";
import type { AggregationRule, DemandRuleId, Dimension, Discipline, Kind, KindDefinition } from "./types";

const ALL: readonly AggregationRule[] = ["sum", "max", "min", "none"];
const EXTREMES: readonly AggregationRule[] = ["max", "min", "none"];

/** Totals add: lengths, areas, flows, loads, fixture units, money. */
const additive = (demand?: DemandRuleId) => ({ default: "sum" as const, allowed: ALL, ...(demand ? { demand } : {}) });
/** Totals are meaningless but a column may still show the largest or smallest: pressures, velocities, temperatures, ratios. */
const intensive = { default: "none" as const, allowed: EXTREMES };
/** Usually not totalled, but a sum is legitimate when asked for (series resistance, combined loads). */
const optional = { default: "none" as const, allowed: ALL };

const ALL_TRADES: readonly Discipline[] = ["architecture", "structural", "civil", "mechanical", "electrical", "plumbing", "fire_protection", "general"];

function kind(id: Kind, label: string, dimension: Dimension, aggregation: KindDefinition["aggregation"], disciplines: readonly Discipline[]): KindDefinition {
  return Object.freeze({ id, label, dimension, aggregation: Object.freeze(aggregation), disciplines: Object.freeze([...disciplines]) });
}

const LIST: readonly KindDefinition[] = [
  kind("dimensionless", "Number", DIMENSIONLESS, optional, ALL_TRADES),
  kind("ratio", "Ratio", DIMENSIONLESS, intensive, ALL_TRADES),
  kind("slope", "Slope", DIMENSIONLESS, intensive, ["civil", "plumbing", "architecture"]),
  kind("count", "Count", dim({ C: 1 }), additive(), ALL_TRADES),
  kind("occupants", "Occupant load", dim({ C: 1 }), additive(), ["architecture", "plumbing", "fire_protection"]),
  kind("length", "Length", dim({ L: 1 }), additive(), ALL_TRADES),
  kind("area", "Area", dim({ L: 2 }), additive(), ALL_TRADES),
  kind("volume", "Volume", dim({ L: 3 }), additive(), ["civil", "plumbing", "general", "structural"]),
  kind("mass", "Weight", dim({ M: 1 }), additive(), ALL_TRADES),
  kind("time", "Duration", dim({ T: 1 }), additive(), ["general"]),
  kind("angle", "Angle", dim({ A: 1 }), intensive, ALL_TRADES),
  kind("force", "Force", dim({ M: 1, L: 1, T: -2 }), additive(), ["structural"]),
  kind("moment", "Moment", dim({ M: 1, L: 2, T: -2 }), optional, ["structural"]),
  kind("stress", "Stress", dim({ M: 1, L: -1, T: -2 }), intensive, ["structural"]),
  kind("pressure", "Pressure", dim({ M: 1, L: -1, T: -2 }), intensive, ["mechanical", "plumbing", "fire_protection", "civil"]),
  kind("area_load", "Area load", dim({ M: 1, L: -1, T: -2 }), optional, ["structural"]),
  kind("line_load", "Line load", dim({ M: 1, T: -2 }), optional, ["structural"]),
  kind("density", "Density", dim({ M: 1, L: -3 }), intensive, ["structural", "civil", "mechanical"]),
  kind("velocity", "Velocity", dim({ L: 1, T: -1 }), intensive, ["mechanical", "plumbing", "civil", "fire_protection"]),
  kind("flow_air", "Airflow", dim({ L: 3, T: -1 }), additive(), ["mechanical"]),
  kind("flow_liquid", "Liquid flow", dim({ L: 3, T: -1 }), additive(), ["plumbing", "mechanical", "fire_protection", "civil"]),
  kind("flow_gas_volume", "Gas flow", dim({ L: 3, T: -1 }), additive(), ["plumbing", "mechanical"]),
  kind("mass_flow", "Mass flow", dim({ M: 1, T: -1 }), additive(), ["mechanical"]),
  kind("power_real", "Real power", dim({ M: 1, L: 2, T: -3 }), additive(), ["electrical", "mechanical"]),
  kind("power_mechanical", "Motor power", dim({ M: 1, L: 2, T: -3 }), additive(), ["mechanical", "electrical", "plumbing", "fire_protection"]),
  kind("power_apparent", "Apparent power", dim({ M: 1, L: 2, T: -3 }), additive(), ["electrical"]),
  kind("power_reactive", "Reactive power", dim({ M: 1, L: 2, T: -3 }), additive(), ["electrical"]),
  kind("thermal_power", "Heating or cooling capacity", dim({ M: 1, L: 2, T: -3 }), additive(), ["mechanical", "plumbing"]),
  kind("flow_gas_energy", "Gas input", dim({ M: 1, L: 2, T: -3 }), additive(), ["plumbing", "mechanical"]),
  kind("energy", "Energy", dim({ M: 1, L: 2, T: -2 }), additive(), ["mechanical", "electrical", "plumbing"]),
  kind("current", "Current", dim({ I: 1 }), additive(), ["electrical"]),
  kind("voltage", "Voltage", dim({ M: 1, L: 2, T: -3, I: -1 }), intensive, ["electrical"]),
  kind("resistance", "Resistance", dim({ M: 1, L: 2, T: -3, I: -2 }), optional, ["electrical"]),
  kind("resistance_per_length", "Resistance per length", dim({ M: 1, L: 1, T: -3, I: -2 }), intensive, ["electrical"]),
  kind("frequency", "Frequency", dim({ T: -1 }), intensive, ["electrical"]),
  kind("temperature", "Temperature", dim({ Th: 1 }), intensive, ["mechanical", "plumbing", "fire_protection"]),
  kind("temperature_delta", "Temperature difference", dim({ Th: 1 }), optional, ["mechanical", "plumbing"]),
  kind("luminous_flux", "Light output", dim({ J: 1 }), additive(), ["electrical"]),
  kind("illuminance", "Illuminance", dim({ J: 1, L: -2 }), intensive, ["electrical", "architecture"]),
  kind("luminous_intensity", "Luminous intensity", dim({ J: 1 }), intensive, ["electrical"]),
  kind("density_sprinkler", "Sprinkler density", dim({ L: 1, T: -1 }), intensive, ["fire_protection"]),
  kind("k_factor", "K-factor", dim({ L: 3.5, M: -0.5 }), intensive, ["fire_protection"]),
  kind("fixture_units_supply", "Water supply fixture units", DIMENSIONLESS, additive("water_supply"), ["plumbing"]),
  kind("fixture_units_drainage", "Drainage fixture units", DIMENSIONLESS, additive("drainage"), ["plumbing"]),
  kind("pressure_gradient", "Friction rate", dim({ M: 1, L: -2, T: -2 }), intensive, ["mechanical", "plumbing", "fire_protection"]),
  kind("rainfall_intensity", "Rainfall intensity", dim({ L: 1, T: -1 }), intensive, ["plumbing", "civil"]),
  kind("area_per_occupant", "Occupant load factor", dim({ L: 2, C: -1 }), intensive, ["architecture", "fire_protection"]),
  kind("money", "Cost", dim({ $: 1 }), additive(), ["general"]),
  /** Lighting and receptacle densities (NEC 220.12 VA/ft², ASHRAE 90.1 W/ft²). Real and apparent power share the dimension; the unit says which. */
  kind("power_per_area", "Power density", dim({ M: 1, T: -3 }), intensive, ["electrical", "mechanical", "architecture"]),
  /** Ventilation per floor area (ASHRAE 62.1 Ra, IMC Table 403.3.1.1 area rate). */
  kind("airflow_per_area", "Airflow per area", dim({ L: 1, T: -1 }), intensive, ["mechanical"]),
  /** Ventilation per person (ASHRAE 62.1 Rp, IMC Table 403.3.1.1 people rate). */
  kind("airflow_per_person", "Airflow per person", dim({ L: 3, T: -1, C: -1 }), intensive, ["mechanical"]),
  /** Elastic section modulus S = I / c (AISC Manual Part 1 tables list Sx, Sy in in³). Same dimension as volume; never added to one. */
  kind("section_modulus", "Section modulus", dim({ L: 3 }), intensive, ["structural"]),
  /** Second moment of area I (AISC Manual Part 1 lists Ix, Iy in in⁴). */
  kind("second_moment_of_area", "Moment of inertia", dim({ L: 4 }), intensive, ["structural"]),
];

export const KINDS: Readonly<Record<Kind, KindDefinition>> = Object.freeze(Object.fromEntries(LIST.map((k) => [k.id, k])) as Record<Kind, KindDefinition>);
