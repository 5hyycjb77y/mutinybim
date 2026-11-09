/**
 * 7329 Corner Cafe, SD3 "Plumbing loads" schedule, read
 * row by row off the issued sheet in a walkthrough (Plumbing Demo 1,
 * frame f_0022 at 3:30): 18 fixture types, 35 fixtures. Per fixture: cold,
 * hot and total water supply fixture units, drainage fixture units, and the
 * hot water demand per fixture for the "WHS restaurant" heater sizing column
 * (the sheet prints the row total; per fixture is that over the quantity).
 *
 * Grand totals printed on the sheet: cold 25.75, hot 13.5, total WSFU 30.25,
 * DFU 79, 140 gal/h.
 *
 * Gas (frame f_0013, gas equipment specifications, total 859 CFH on the gas
 * meter note f_0097): the rows are OV-1 (Blodgett double-stack convection
 * oven), GWH (Rinnai CXP199iN, 199,000 Btu/h, printed) and RTU-1..3 (Carrier
 * rooftop units). The frame is too small to read the oven's and RTUs' inputs,
 * so OV-1 120 MBH and 180 MBH per RTU are assumed: with GWH's printed 199 MBH
 * they make the printed 859 CFH at 1,000 Btu/cf (the kernel's natural gas
 * default).
 */

export interface CafeRow {
  readonly tag: string;
  readonly description: string;
  readonly qty: number;
  readonly cold: number;
  readonly hot: number;
  readonly total: number;
  readonly dfu: number;
  readonly gph: number;
}

export const CAFE_ROWS: readonly CafeRow[] = [
  { tag: "FD", description: "Floor drain", qty: 4, cold: 0, hot: 0, total: 0, dfu: 5, gph: 0 },
  { tag: "FS2", description: "Floor sink", qty: 2, cold: 0, hot: 0, total: 0, dfu: 3, gph: 0 },
  { tag: "FS3", description: "Floor sink", qty: 3, cold: 0, hot: 0, total: 0, dfu: 5, gph: 0 },
  { tag: "HD", description: "Hub drain", qty: 4, cold: 0, hot: 0, total: 0, dfu: 3, gph: 0 },
  { tag: "LV", description: "Lavatory, ADA", qty: 2, cold: 1.5, hot: 1.5, total: 2, dfu: 1, gph: 0 },
  { tag: "NG18S", description: "Dump sink", qty: 2, cold: 1.5, hot: 1.5, total: 2, dfu: 0, gph: 10 },
  { tag: "P41", description: "Hand sink", qty: 2, cold: 1.5, hot: 1.5, total: 2, dfu: 3, gph: 5 },
  { tag: "P60A", description: "Dipper well", qty: 2, cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { tag: "P98A", description: "Espresso machine", qty: 2, cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { tag: "P124A", description: "Coffee brewer", qty: 2, cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { tag: "P200A", description: "Iced coffee brewer", qty: 2, cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { tag: "P257", description: "8-tap cold beverage dispenser", qty: 1, cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { tag: "P395", description: "Hand sink", qty: 1, cold: 1.5, hot: 1.5, total: 2, dfu: 3, gph: 5 },
  { tag: "P409E", description: "Ice bin", qty: 1, cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { tag: "P413", description: "Ice maker", qty: 1, cold: 0.25, hot: 0, total: 0.25, dfu: 2, gph: 0 },
  { tag: "P434A", description: "Three compartment sink", qty: 1, cold: 3, hot: 3, total: 4, dfu: 3, gph: 90 },
  { tag: "P539-B", description: "Hydrovection oven", qty: 1, cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 15 },
  { tag: "WC", description: "Water closet, ADA", qty: 2, cold: 5, hot: 0, total: 5, dfu: 5, gph: 0 },
];

export const CAFE_TOTALS = { fixtures: 35, cold: 25.75, hot: 13.5, total: 30.25, dfu: 79, gph: 140, gasCfh: 859 } as const;

export const CAFE_GAS = [
  { tag: "OV-1", description: "Double stack convection oven (assumed input)", mbh: 120 },
  { tag: "GWH", description: "Condensing tankless water heater, Rinnai CXP199iN", mbh: 199 },
  { tag: "RTU-1", description: "Rooftop unit (assumed input)", mbh: 180 },
  { tag: "RTU-2", description: "Rooftop unit (assumed input)", mbh: 180 },
  { tag: "RTU-3", description: "Rooftop unit (assumed input)", mbh: 180 },
] as const;

/** One load per fixture, no anchor, as typed into the load table before anything is drawn: "P41-1", "P41-2". */
export function cafeFixtureLoads(): Array<{ id: string; mark: string; values: { wsfu_cold?: number; wsfu_hot?: number; wsfu_total?: number; dfu?: number; gph_demand?: number }; note: string }> {
  const out: Array<{ id: string; mark: string; values: { wsfu_cold?: number; wsfu_hot?: number; wsfu_total?: number; dfu?: number; gph_demand?: number }; note: string }> = [];
  for (const r of CAFE_ROWS) {
    for (let i = 1; i <= r.qty; i++) {
      const values: { wsfu_cold?: number; wsfu_hot?: number; wsfu_total?: number; dfu?: number; gph_demand?: number } = {};
      if (r.cold) values.wsfu_cold = r.cold;
      if (r.hot) values.wsfu_hot = r.hot;
      if (r.total) values.wsfu_total = r.total;
      if (r.dfu) values.dfu = r.dfu;
      if (r.gph) values.gph_demand = r.gph;
      out.push({ id: `load-${r.tag}-${i}`, mark: `${r.tag}-${i}`, values, note: r.description });
    }
  }
  return out;
}
