/**
 * @jest-environment node
 *
 * Round 7 lane Q perf rows (docs/perf/mutinybim-budgets.json), measured
 * before the budget is set, never raised:
 *
 * - `qto.one_edit.250k` (5 / 10 ms): on a 250,000-element model whose
 *   takeoff is already built, one wall moves; the time to carry the hosted
 *   index and the takeoff to the next record and read its totals (what the
 *   command core's revision carry does after every edit).
 * - `cost.price_takeoff.250k` (50 / 100 ms): price that model's takeoff with
 *   a test price list in this process, the takeoff warm.
 * - `qto.schedule.tower` (measured first): the takeoff schedule's rows on a
 *   14-storey tower through the schedule engine.
 *
 * Also proves an edit never rebuilds the takeoff: the carried record's
 * totals equal a fresh build's.
 */
import { asElementId, carryHostedIndex, carryTakeoff, COST_SOURCE_POINT, DEFAULT_SETTINGS, fieldProviderRegistry, priceTakeoff, takeoffScheduleDefinition, takeoffTotals, type BimElement, type CostSourceDef, type ModelState, type Wall } from "../src";
import { buildRowSet } from "../src/schedules/engine";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { FT } from "./q7-fixtures";

const P = (s: number) => ({ level: `Level ${s + 1}`, zone: "Z1", discipline: "architecture" as const });
const TYPES = 20;

function building(storeys: number, wallsPerStorey: number, modelId: string): ModelState {
  const elements: Record<string, BimElement> = {};
  const put = (record: unknown) => {
    const el = record as BimElement;
    elements[el.id] = el;
  };
  for (let t = 0; t < TYPES; t++) put({ id: asElementId(`t-${t}`), kind: "element_type", version: 1, authoredRev: {}, name: `Wall type ${t}`, forKinds: ["wall"], classification: [{ system: "firm:cost_codes", code: `TEST-${String(100 + t * 10).padStart(4, "0")}` }] });
  for (let s = 0; s < storeys; s++) {
    put({ id: asElementId(`lvl-${s}`), kind: "level", version: 1, authoredRev: {}, name: `Level ${s + 1}`, elevationMm: s * 14 * FT });
    put({ id: asElementId(`st-${s}`), kind: "construction_stage", version: 1, authoredRev: {}, stage: { name: `Floor ${s + 1}`, order: s } });
    put({ id: asElementId(`slab-${s}`), kind: "slab", version: 1, authoredRev: {}, partition: P(s), outline: [{ x: 0, y: 0 }, { x: 200 * FT, y: 0 }, { x: 200 * FT, y: 100 * FT }, { x: 0, y: 100 * FT }], thickness: 200, constructionStageId: `st-${s}` });
    for (let w = 0; w < wallsPerStorey; w++) {
      const id = `w-${s}-${w}`;
      const x = (w % 200) * FT;
      put({ id: asElementId(id), kind: "wall", version: 1, authoredRev: {}, partition: P(s), start: { x, y: 0 }, end: { x, y: 10 * FT }, thickness: 150, height: 3000, wallType: "W", typeId: asElementId(`t-${w % TYPES}`), constructionStageId: `st-${s}` });
      if (w % 5 === 0) put({ id: asElementId(`d-${s}-${w}`), kind: "opening", version: 1, authoredRev: {}, partition: P(s), openingType: "door", mark: `D${w}`, hostId: asElementId(id), offset: 5 * FT, width: 3 * FT, height: 7 * FT, position: { x, y: 5 * FT } });
    }
  }
  return { modelId, revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

function stats(samples: number[]): { p50: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length / 2)] ?? 0, p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0 };
}

const SOURCE: CostSourceDef = {
  id: "zz.gc_estimate",
  party: { kind: "gc", id: "gc-test", label: "Test GC" },
  basis: "estimate",
  currency: "USD",
  effectiveDate: "2026-10-01",
  visibility: { kind: "party_only" },
  rates: () =>
    Array.from({ length: TYPES }, (_, t) => ({
      classification: { system: "firm:cost_codes", code: `TEST-${String(100 + t * 10).padStart(4, "0")}` },
      unitRate: { minor: 4_000 + t * 10, currency: "USD" },
      measure: "qto.area_net",
      per: "ft2",
      provenance: { ownedBy: { party: "gc-test" }, source: "test", date: "2026-10-01" },
    })),
};
const COST_SET = PackSet.create([definePack({ id: "zz", name: "Test price list", version: "1.0.0", kernel: "^1.0.0" }, [contribute(COST_SOURCE_POINT, [SOURCE])])]);

describe("q7 quantities perf", () => {
  const m = building(50, 4_170, "q7-250k");
  const count = Object.keys(m.elements).length;

  it("qto.one_edit.250k: one wall moves, the takeoff carries", () => {
    expect(count).toBeGreaterThanOrEqual(250_000);
    const t0 = performance.now();
    takeoffTotals(m.elements);
    const cold = performance.now() - t0;
    const samples: number[] = [];
    let from = m.elements;
    for (let k = 0; k < 11; k++) {
      const id = `w-${k}-${k * 5}`;
      const w = from[id] as Wall;
      const to: Record<string, BimElement> = { ...from, [id]: { ...w, start: { x: w.start.x, y: w.start.y }, end: { x: w.end.x, y: w.end.y + 1000 }, version: w.version + 1 } };
      const t = performance.now();
      carryHostedIndex(from, to, [id]);
      carryTakeoff(from, to, [id]);
      takeoffTotals(to);
      samples.push(performance.now() - t);
      from = to;
    }
    const { p50, p95 } = stats(samples.slice(1));
    process.stderr.write(`[q7 qto.one_edit.250k] ${count} elements; cold takeoff ${cold.toFixed(0)} ms; one edit p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
    // The carried totals are exactly a fresh build's.
    const carried = takeoffTotals(from).map((t) => `${t.key}=${t.value.toFixed(4)}:${t.elementCount}`).sort();
    const fresh = takeoffTotals({ ...from }).map((t) => `${t.key}=${t.value.toFixed(4)}:${t.elementCount}`).sort();
    expect(carried).toEqual(fresh);
    // A guard against a rebuild per edit (hundreds of ms); the budget is the perf gate's.
    expect(p50).toBeLessThan(cold / 5);
  });

  it("cost.price_takeoff.250k: price the takeoff in process", () => {
    const t0 = performance.now();
    withPackSet(COST_SET, () => priceTakeoff(m, "zz.gc_estimate", "gc-test"));
    const cold = performance.now() - t0;
    const samples: number[] = [];
    let total = 0;
    for (let k = 0; k < 9; k++) {
      const t = performance.now();
      total = withPackSet(COST_SET, () => priceTakeoff(m, "zz.gc_estimate", "gc-test")).total.minor;
      samples.push(performance.now() - t);
    }
    const { p50, p95 } = stats(samples);
    process.stderr.write(`[q7 cost.price_takeoff.250k] ${count} elements; first call (builds the code takeoff) ${cold.toFixed(0)} ms; warm p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
    expect(total).toBeGreaterThan(0);
  });

  it("qto.schedule.tower: takeoff schedule rows on a 14-storey tower", () => {
    const tower = building(14, 200, "q7-tower");
    const registry = fieldProviderRegistry();
    const def = takeoffScheduleDefinition();
    const samples: number[] = [];
    let rows = 0;
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      rows = buildRowSet(tower, def, { viewId: "q7-tower", revision: k, registry }).rowCount;
      samples.push(performance.now() - t);
    }
    const { p50, p95 } = stats(samples);
    process.stderr.write(`[q7 qto.schedule.tower] ${Object.keys(tower.elements).length} elements, ${rows} rows; p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`);
    expect(rows).toBeGreaterThan(14 * 200);
  });
});
