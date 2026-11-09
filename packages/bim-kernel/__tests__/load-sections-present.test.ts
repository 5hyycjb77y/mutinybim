/**
 * The requirements engine asks every load of the model which trades it serves.
 * It used to build each load's display text (formatted numbers) to find out,
 * and requirements.engine.cold went from ~150 ms to ~620 ms p95 at 250k.
 * loadSectionsPresent must answer exactly what loadSections would, without text.
 */
import { loadSections, loadSectionsPresent } from "../src/requirements/facets";
import { ZERO_TOTALS, type QuantityTotals } from "../src/quantities";

const cases: Array<[string, Partial<QuantityTotals>]> = [
  ["nothing", {}],
  ["electrical only", { va: 1800 }],
  ["plumbing fixture", { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 2 }],
  ["gas appliance with inlet pressure", { mbh: 80, min_inlet_pressure: 7 }],
  ["water heater pressure without gas", { min_inlet_pressure: 25, gpm_fixed: 1 }],
  ["inlet pressure only", { min_inlet_pressure: 25 }],
  ["air handler", { cfm: 400, va: 2400 }],
  ["every section", { va: 1, mbh: 1, wsfu_total: 1, dfu: 1, cfm: 1 }],
];

describe("loadSectionsPresent", () => {
  it.each(cases)("matches loadSections for %s", (_name, partial) => {
    const totals: QuantityTotals = { ...ZERO_TOTALS, ...partial };
    expect(loadSectionsPresent(totals)).toEqual(loadSections(totals).map((s) => s.section));
  });
});

it("counts a load with only an inlet pressure as water", () => {
  expect(loadSectionsPresent({ ...ZERO_TOTALS, min_inlet_pressure: 25 })).toEqual(["water"]);
});
