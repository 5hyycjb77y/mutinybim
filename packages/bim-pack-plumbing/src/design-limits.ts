import type { DesignLimit } from "@permitzip/bim-kernel/policy";

/**
 * Plumbing and gas's starting design limits (round 12 P12; product decision, Nov 3
 * 2026): best-practice defaults per piping system, each with where it came
 * from in our own words, contributed to `DESIGN_LIMIT_DEFAULT_POINT`. A firm
 * edits any of them in its library and a project edits the firm's (same id).
 * No code-book or vendor table text: values only, with their source.
 *
 * Gas pressure classes are system type ids in this add-on's words
 * (`natural_gas.low_pressure`, `natural_gas.medium_pressure`): the gas sheet
 * passes the zone's class when it checks a zone's drop.
 */

const PLUMBING_REVIEW = "PermitZIP practice (plumbing review video, Oct 2026)";
const PRODUCT_DECISION = "PermitZIP practice (product decision, Nov 3 2026)";
const COMMON = "Common design practice; firm to confirm";

export const PLUMBING_DESIGN_LIMIT_DEFAULTS: readonly DesignLimit[] = [
  {
    id: "plumbing_gas.cold_water_velocity",
    label: "Domestic cold water velocity",
    quantity: "velocity",
    unit: "ft/s",
    appliesTo: { systems: ["domestic_cold_water"] },
    band: { max: 8 },
    severity: "warning",
    citation: { source: PLUMBING_REVIEW, note: "Keeps noise and erosion down in the cold water mains and branches." },
  },
  {
    id: "plumbing_gas.hot_water_velocity",
    label: "Domestic hot water velocity",
    quantity: "velocity",
    unit: "ft/s",
    appliesTo: { systems: ["domestic_hot_water"] },
    band: { max: 5 },
    severity: "warning",
    citation: { source: COMMON, note: "Hot water erodes copper faster than cold, so the limit is lower." },
  },
  {
    id: "plumbing_gas.recirculating_water_velocity",
    label: "Hot water return (recirculating) velocity",
    quantity: "velocity",
    unit: "ft/s",
    appliesTo: { systems: ["domestic_hot_water_return"] },
    band: { max: 3 },
    severity: "warning",
    citation: { source: COMMON, note: "Return piping runs all day; a low velocity protects it." },
  },
  {
    id: "plumbing_gas.water_pressure_loss",
    label: "Water pressure loss to the most remote fixture",
    quantity: "pressure",
    unit: "psi",
    appliesTo: { systems: ["domestic_cold_water", "domestic_hot_water"] },
    band: { max: 10 },
    severity: "warning",
    citation: { source: PLUMBING_REVIEW, note: "Friction loss along the path, after the meter and backflow preventer." },
  },
  {
    id: "plumbing_gas.water_main_margin",
    label: "Water main capacity margin",
    quantity: "ratio",
    unit: "%",
    appliesTo: { systems: ["domestic_cold_water", "domestic_hot_water"] },
    band: { min: 20 },
    severity: "warning",
    citation: { source: PRODUCT_DECISION, note: "Room for the fixtures added after design." },
  },
  {
    id: "plumbing_gas.gas_main_margin",
    label: "Gas main capacity margin",
    quantity: "ratio",
    unit: "%",
    appliesTo: { systems: ["natural_gas"] },
    band: { min: 20 },
    severity: "warning",
    citation: { source: PRODUCT_DECISION, note: "A size that just passes the table fails the firm's margin." },
  },
  {
    id: "plumbing_gas.gas_low_pressure_drop",
    label: "Low pressure gas: allowable pressure drop",
    quantity: "pressure",
    unit: "in_wc",
    appliesTo: { systems: ["natural_gas.low_pressure"] },
    band: { max: 0.5 },
    severity: "error",
    citation: { source: COMMON, note: "For gas delivered at about 7 to 14 in. w.c.; check the utility's delivery pressure." },
  },
  {
    id: "plumbing_gas.gas_medium_pressure_drop",
    label: "Medium pressure (2 psi) gas: allowable pressure drop",
    quantity: "pressure",
    unit: "psi",
    appliesTo: { systems: ["natural_gas.medium_pressure"] },
    band: { max: 1 },
    severity: "error",
    citation: { source: COMMON, note: "For 2 psi systems with regulators at the appliances." },
  },
  {
    id: "plumbing_gas.drain_fill",
    label: "Drain depth of flow (fill)",
    quantity: "ratio",
    unit: "%",
    appliesTo: { systems: ["sanitary", "grease_waste", "indirect_waste", "storm"] },
    band: { max: 50 },
    severity: "warning",
    citation: { source: COMMON, note: "Drains are sized to run at most half full, so air moves above the water." },
  },
];
