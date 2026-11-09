import { convert, LEGACY_QUANTITY_KEYS, LEGACY_QUANTITY_UNIT_LABELS, QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { z } from "zod";

/**
 * The quantities a connection carries, for every trade: water supply and
 * drainage fixture units, fixed flows, water heater demand, gas input,
 * minimum inlet pressure, airflow and volt-amperes, plus connection sizes and
 * an engineer's own parameters.
 *
 * Each quantity says how it adds when loads below a pipe are totalled
 * (`sum`, or `max` for a requirement such as inlet pressure, or `none` for
 * information). Fixture units add; the flow they stand for does not (a
 * Hunter curve is not additive), so demand is a rule applied to a total
 * (`demand`) and the rule itself comes from a code pack (bim-calc), never a
 * table here.
 *
 * `wsfu_total` is the fixture's combined value from the code table, not
 * cold + hot: a lavatory is 1.5 cold, 1.5 hot, 2 total. Pipes carrying both
 * (the service, above the water heater) count the total.
 */

/** The bag keys, stored as they are forever. Kind, unit and how each adds live in `@permitzip/bim-units` (`QUANTITY_BINDINGS`). */
export const QUANTITY_KEYS = LEGACY_QUANTITY_KEYS;
export type QuantityKey = (typeof QUANTITY_KEYS)[number];

/** The parameter key a bag quantity has in the one parameter vocabulary: `load.wsfu_total` on a load point, a fixture type and a schedule column alike. */
export function quantityParameterKey(key: QuantityKey): `load.${QuantityKey}` {
  return `load.${key}`;
}

export type QuantityAdd = "sum" | "max" | "none";
/** Where a demand rule turns a total into a flow: water fixture units to gpm, drainage units to gpm. `null`: the quantity is already a flow. */
export type QuantityDemand = "water_supply" | "drainage" | null;

export interface QuantityDefinition {
  readonly key: QuantityKey;
  readonly label: string;
  /**
   * As printed after a number (`LEGACY_QUANTITY_UNIT_LABELS`).
   * @deprecated A label, not a unit: the unit code is `QUANTITY_BINDINGS[key].unit` (bim-units).
   */
  readonly unit: string;
  /** @deprecated Same as `QUANTITY_BINDINGS[key].aggregation` (bim-units), which it is read from. */
  readonly add: QuantityAdd;
  /** @deprecated Same as `QUANTITY_BINDINGS[key].demand`. */
  readonly demand: QuantityDemand;
}

/** The printed unit and the adding rule come from bim-units; only the words are the kernel's. */
function quantity(key: QuantityKey, label: string): QuantityDefinition {
  const b = QUANTITY_BINDINGS[key];
  return { key, label, unit: LEGACY_QUANTITY_UNIT_LABELS[key], add: b.aggregation, demand: b.demand };
}

/** Each bag quantity with its label, printed unit and adding rule. */
export const QUANTITIES: Readonly<Record<QuantityKey, QuantityDefinition>> = {
  wsfu_cold: quantity("wsfu_cold", "Cold water fixture units"),
  wsfu_hot: quantity("wsfu_hot", "Hot water fixture units"),
  wsfu_total: quantity("wsfu_total", "Total water fixture units"),
  dfu: quantity("dfu", "Drainage fixture units"),
  gpm_fixed: quantity("gpm_fixed", "Fixed flow"),
  gph_demand: quantity("gph_demand", "Hot water demand"),
  mbh: quantity("mbh", "Gas input"),
  min_inlet_pressure: quantity("min_inlet_pressure", "Minimum inlet pressure"),
  cfm: quantity("cfm", "Airflow"),
  va: quantity("va", "Electrical load"),
};

/** Connection sizes as written on a fixture schedule (CW 1/2", W 2"). Information only: they never add. */
export const CONNECTION_SIZE_KEYS = ["cw", "hw", "w", "v", "g"] as const;
export type ConnectionSizeKey = (typeof CONNECTION_SIZE_KEYS)[number];
export const CONNECTION_SIZE_LABELS: Readonly<Record<ConnectionSizeKey, string>> = { cw: "Cold water", hw: "Hot water", w: "Waste", v: "Vent", g: "Gas" };

const amount = z.number().finite().min(0).max(1_000_000);

export const customQuantitySchema = z.object({
  name: z.string().trim().min(1).max(40),
  unit: z.string().trim().max(16),
  value: z.number().finite().min(-1_000_000).max(1_000_000),
  /** Absent: information only. */
  add: z.enum(["sum", "max", "none"]).optional(),
});
export type CustomQuantity = z.infer<typeof customQuantitySchema>;

export const quantityBagSchema = z.object({
  wsfu_cold: amount.optional(),
  wsfu_hot: amount.optional(),
  wsfu_total: amount.optional(),
  dfu: amount.optional(),
  gpm_fixed: amount.optional(),
  gph_demand: amount.optional(),
  mbh: amount.optional(),
  min_inlet_pressure: amount.optional(),
  cfm: amount.optional(),
  va: amount.optional(),
  sizes: z
    .object({ cw: z.string().trim().max(12).optional(), hw: z.string().trim().max(12).optional(), w: z.string().trim().max(12).optional(), v: z.string().trim().max(12).optional(), g: z.string().trim().max(12).optional() })
    .optional(),
  custom: z.array(customQuantitySchema).max(20).optional(),
});
export type QuantityBag = z.infer<typeof quantityBagSchema>;

/** Only the numbers, every key present (0 when absent). */
export type QuantityTotals = Readonly<Record<QuantityKey, number>>;

export const ZERO_TOTALS: QuantityTotals = Object.freeze(Object.fromEntries(QUANTITY_KEYS.map((k) => [k, 0])) as Record<QuantityKey, number>);

export function totalsOf(bag: QuantityBag | undefined): QuantityTotals {
  if (!bag) return ZERO_TOTALS;
  const out = { ...ZERO_TOTALS } as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) out[k] = bag[k] ?? 0;
  return out;
}

/** `over` wins key by key; sizes and custom parameters merge by name. */
export function mergeBags(base: QuantityBag | undefined, over: QuantityBag | undefined): QuantityBag {
  if (!over) return base ?? {};
  if (!base) return over;
  const out: Record<string, unknown> = { ...base };
  for (const k of QUANTITY_KEYS) if (over[k] !== undefined) out[k] = over[k];
  if (over.sizes) out.sizes = { ...base.sizes, ...over.sizes };
  if (over.custom) {
    const byName = new Map((base.custom ?? []).map((c) => [c.name.toLowerCase(), c]));
    for (const c of over.custom) byName.set(c.name.toLowerCase(), c);
    out.custom = [...byName.values()];
  }
  return out as QuantityBag;
}

/** Adds two totals the way each quantity adds. */
export function addTotals(a: QuantityTotals, b: QuantityTotals): QuantityTotals {
  const out = {} as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) out[k] = QUANTITIES[k].add === "max" ? Math.max(a[k], b[k]) : a[k] + b[k];
  return out;
}

/** a − b for the summed quantities (used to move a lump onto new points). Requirements and information are copied from `a`. */
export function subtractTotals(a: QuantityTotals, b: QuantityTotals): QuantityTotals {
  const out = {} as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) out[k] = QUANTITIES[k].add === "sum" ? round6(a[k] - b[k]) : a[k];
  return out;
}

export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The summed quantities a bag sets, as a bag (drops sizes, custom and zeroes). */
export function bagFromTotals(t: QuantityTotals): QuantityBag {
  const out: Record<string, number> = {};
  for (const k of QUANTITY_KEYS) if (t[k] !== 0) out[k] = round6(t[k]);
  return out as QuantityBag;
}

/** "3 DFU", "43.25 WSFU", "1,024.41 MBH". */
export function formatQuantity(key: QuantityKey, value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${QUANTITIES[key].unit}`;
}

/** "min inlet 7 in. w.c. (0.253 psi)" below 1 psi (gas), "min inlet 25 psi" above (water); "199 MBH" for the rest. */
export function quantityValueLabel(key: QuantityKey, value: number): string {
  const r = (v: number, d: number) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: d });
  if (key === "min_inlet_pressure") {
    return value < 1 ? `min inlet ${r(convert(value, QUANTITY_BINDINGS.min_inlet_pressure.unit, "in_wc"), 2)} in. w.c. (${r(value, 3)} psi)` : `min inlet ${r(value, 2)} psi`;
  }
  return `${r(value, 2)} ${QUANTITIES[key].unit}`;
}

/** "WSFU 1.5 cold / 1.5 hot / 2 total, 1 DFU". Only what's set. */
export function bagSummary(bag: QuantityBag): string {
  const t = totalsOf(bag);
  const parts: string[] = [];
  if (t.wsfu_cold || t.wsfu_hot || t.wsfu_total) parts.push(`WSFU ${t.wsfu_cold} cold / ${t.wsfu_hot} hot / ${t.wsfu_total} total`);
  for (const k of ["dfu", "gpm_fixed", "gph_demand", "mbh", "min_inlet_pressure", "cfm", "va"] as const) if (t[k]) parts.push(k === "min_inlet_pressure" ? quantityValueLabel(k, t[k]) : formatQuantity(k, t[k]));
  for (const c of bag.custom ?? []) parts.push(`${c.name} ${c.value}${c.unit ? ` ${c.unit}` : ""}`);
  return parts.length > 0 ? parts.join(", ") : "no load";
}

export function isQuantityKey(value: string): value is QuantityKey {
  return (QUANTITY_KEYS as readonly string[]).includes(value);
}
