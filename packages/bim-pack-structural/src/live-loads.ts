import { activePackSet, SPACE_USE_POINT, SPACE_USE_RATE_VALUE_POINT, type SpaceUseRateTarget, type SpaceUseRateValue, type SpaceUseRow } from "@permitzip/bim-pack/runtime";
import { qty, to, unitAllowed, type Quantity, type UnitFor } from "@permitzip/bim-units";

/**
 * Uniform live load by use, the pack's space-use rate (KERNEL-FOUNDATION
 * §3.15, "psf by use"). Values are ASCE 7-22 Table 4.3-1 minimum uniformly
 * distributed live loads, unreduced: the live-load reduction of §4.7 (floors)
 * and §4.8 (roofs) is not applied, which is conservative.
 *
 * The pack registers the rate key (`struct.live_load`, psf over area), puts
 * its value on the built-in uses (office, corridor, retail, storage) and
 * adds its own roof use, which no built-in row covers. Loads read the rates
 * of the pack set in force (`liveLoadRate`), never this table directly.
 */

export const LIVE_LOAD_RATE_KEY = "struct.live_load";

export interface LiveLoadRate {
  readonly useId: string;
  readonly useLabel: string;
  readonly value: Quantity<"area_load">;
  readonly row: string;
  readonly note?: string;
}

const ASCE7 = { code: "ASCE 7", edition: "2022", clause: "Table 4.3-1", verified: false } as const;

const rate = (useId: string, useLabel: string, psf: number, row: string, note?: string): LiveLoadRate => Object.freeze({ useId, useLabel, value: qty("area_load", psf, "psf"), row, ...(note ? { note } : {}) });

/** The pack's roof use: ordinary flat, pitched and curved roofs. */
export const ROOF_ORDINARY_USE = "struct.roof_ordinary";

export const LIVE_LOAD_RATES: readonly LiveLoadRate[] = Object.freeze([
  rate(ROOF_ORDINARY_USE, "Roof (ordinary flat, pitched or curved)", 20, "Roofs, ordinary flat, pitched, and curved"),
  rate("office_space", "Office", 50, "Office buildings, offices"),
  rate("corridor", "Corridor", 100, "Office buildings, corridors, first floor", "Above the first floor ASCE 7 allows 80 psf; the first-floor value is used everywhere."),
  rate("retail_sales", "Retail sales", 100, "Stores, retail, first floor", "Upper floors are 75 psf; the first-floor value is used everywhere."),
  rate("storage", "Storage (light)", 125, "Storage warehouses, light"),
]);

/** The rate key on the space-use-rate point: a uniform load per floor or roof area, totalled in pounds-force. */
export const LIVE_LOAD_RATE_TARGET: SpaceUseRateTarget = { key: LIVE_LOAD_RATE_KEY, quantity: LIVE_LOAD_RATE_KEY, per: "area", kind: "area_load", label: "Uniform live load", unit: "lbf" };

const own = (r: LiveLoadRate) => r.useId.startsWith("struct.");

/** The pack's own uses as space-use rows carrying their live load. */
export const STRUCT_SPACE_USES: readonly SpaceUseRow[] = LIVE_LOAD_RATES.filter(own).map((r) => ({
  id: r.useId,
  revision: 1,
  name: r.useLabel,
  category: "Structure",
  rates: [{ key: LIVE_LOAD_RATE_KEY, value: to(r.value, "psf"), unit: "psf", cite: ASCE7 }],
}));

/** The live load on the built-in uses, as rate values those rows gain inside the pack's scope. */
export const STRUCT_RATE_VALUES: readonly SpaceUseRateValue[] = LIVE_LOAD_RATES.filter((r) => !own(r)).map((r) => ({ useId: r.useId, key: LIVE_LOAD_RATE_KEY, value: to(r.value, "psf"), unit: "psf", cite: ASCE7 }));

const isAreaLoadUnit = (unit: string): unit is UnitFor<"area_load"> => unitAllowed("area_load", unit);

interface RateEntry {
  readonly value: number;
  readonly unit: string;
  readonly cite: { readonly code: string; readonly edition: string | null; readonly clause: string };
}

/**
 * The live load for a use in the pack set in force: a use row's
 * `struct.live_load` rate (the pack's roof use), or a rate value on a
 * built-in use. Null when the set gives the use none, or gives it in a unit
 * that isn't an area load.
 */
export function liveLoadRate(useId: string): { readonly value: Quantity<"area_load">; readonly cite: string } | null {
  const set = activePackSet();
  const table = set.memo("struct.live_load.by_use", () => {
    const m = new Map<string, RateEntry>();
    for (const row of set.items(SPACE_USE_POINT)) {
      const r = row.rates.find((x) => x.key === LIVE_LOAD_RATE_KEY);
      if (r) m.set(row.id, r);
    }
    for (const v of set.items(SPACE_USE_RATE_VALUE_POINT)) if (v.key === LIVE_LOAD_RATE_KEY) m.set(v.useId, v);
    return m;
  });
  const entry = table.get(useId);
  if (!entry) return null;
  const unit = entry.unit;
  if (!isAreaLoadUnit(unit)) {
    console.error("[struct] live-load rate in a unit that isn't an area load", { useId, unit });
    return null;
  }
  return { value: qty("area_load", entry.value, unit), cite: [entry.cite.code, entry.cite.edition, entry.cite.clause].filter(Boolean).join(" ") };
}
