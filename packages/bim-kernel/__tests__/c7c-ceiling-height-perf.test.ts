/**
 * @jest-environment node
 *
 * Round 7 lane C perf row `ceiling.height_at.250k` (docs/perf/mutinybim-budgets.json):
 * 1,000 `ceilingHeightAt` asks on a 250,000-element model with 5,000 typed
 * ceilings (a 50-storey tower, 100 ceilings a floor on a 50 ft bay grid,
 * every fifth one sloped, every tenth with a cloud under it), after one
 * warm-up ask that builds the index. Budget 20 / 40 ms p50 / p95 per 1,000.
 *
 * Also proves the index is never a full scan per ask: the asks build it once.
 */
import { asElementId, ceilingHeightAt, ceilingIndexBuilds, DEFAULT_SETTINGS, type BimElement, type ModelState } from "../src";
import { FT, rect } from "./c7c-fixtures";

function tower(): ModelState {
  const elements: Record<string, BimElement> = {};
  const put = (el: unknown) => {
    const record = el as BimElement;
    elements[record.id] = record;
  };
  for (let s = 0; s < 50; s++) put({ id: asElementId(`lvl-${s}`), kind: "level", version: 1, authoredRev: {}, name: `Level ${s + 1}`, elevationMm: s * 14 * FT });
  let ceilings = 0;
  for (let s = 0; s < 50; s++) {
    for (let k = 0; k < 100; k++) {
      const x = (k % 10) * 50 * FT;
      const y = Math.floor(k / 10) * 50 * FT;
      const base = { kind: "ceiling", version: 1, authoredRev: {}, partition: { level: `Level ${s + 1}`, zone: "Z1", discipline: "architecture" }, classId: "arch.ceiling", levelId: asElementId(`lvl-${s}`) };
      const sloped = k % 5 === 0;
      put({ ...base, id: asElementId(`c-${s}-${k}`), outline: rect(x, y, x + 50 * FT, y + 50 * FT), form: sloped ? "sloped" : "flat", heightMm: 9 * FT, ...(sloped ? { reference: { x, y }, slope: { directionDeg: 45, pitch: 0.1 } } : {}) });
      ceilings += 1;
      if (k % 10 === 0) {
        put({ ...base, id: asElementId(`cl-${s}-${k}`), outline: rect(x + 10 * FT, y + 10 * FT, x + 30 * FT, y + 30 * FT), form: "cloud", heightMm: 8 * FT });
        ceilings += 1;
      }
    }
  }
  const fillerCount = 250_000 - 50 - ceilings;
  for (let i = 0; i < fillerCount; i++) {
    put({ id: asElementId(`w-${i}`), kind: "wall", version: 1, authoredRev: {}, partition: { level: `Level ${(i % 50) + 1}`, zone: "Z1", discipline: "architecture" }, start: { x: (i % 500) * FT, y: 0 }, end: { x: (i % 500) * FT, y: 10 * FT }, thickness: 150, height: 3000, wallType: "W" });
  }
  expect(ceilings).toBe(5_500);
  return { modelId: "c7c-tower", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

describe("c7c ceiling.height_at.250k", () => {
  it("1,000 asks across a 250,000-element tower with 5,500 typed ceilings", () => {
    const m = tower();
    const levels = Array.from({ length: 50 }, (_, s) => asElementId(`lvl-${s}`));
    const asks = Array.from({ length: 1_000 }, (_, i) => ({ levelId: levels[i % 50] ?? levels[0] ?? asElementId("lvl-0"), point: { x: ((i * 37) % 500) * FT + 1, y: ((i * 53) % 500) * FT + 1 } }));
    const t0 = performance.now();
    const first = asks[0];
    if (first) ceilingHeightAt(m.elements, first.levelId, first.point);
    const warm = performance.now() - t0;
    const built = ceilingIndexBuilds();
    const samples: number[] = [];
    let found = 0;
    for (let k = 0; k < 7; k++) {
      const t = performance.now();
      for (const a of asks) if (ceilingHeightAt(m.elements, a.levelId, a.point)) found += 1;
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    process.stderr.write(`[c7c ceiling.height_at.250k] index build (first ask) ${warm.toFixed(1)} ms; 1,000 asks: p50 ${(samples[3] ?? 0).toFixed(2)} ms, p95 ${(samples[6] ?? 0).toFixed(2)} ms\n`);
    expect(found).toBe(7_000);
    expect(ceilingIndexBuilds()).toBe(built);
    // The budget (20 / 40) is checked by the perf gate from the logged line; this guard only catches a full scan per ask (seconds), as r5z's does.
    expect(samples[3]).toBeLessThan(400);
  });
});
