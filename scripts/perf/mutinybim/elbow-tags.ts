/**
 * Tag elbow leaders (U9): "spread tags" on a busy plan. Devices in rows on a
 * 1/4" plan (about 8 paper mm apart, a receptacle every 8 ft), every one
 * tagged, with a note or dimension box every few devices as an obstacle. The
 * tags start piled on their devices and are placed clear of each other.
 *
 * - tags.spread.<n>: `placeTagsClear` over n tags (both crowd orders when the
 *   first leaves any tag needing a hand), p50 / p95 ms.
 * - unclear: how many tags found no clear spot (reported, not a pass/fail).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/elbow-tags.ts
 */
import { placeTagsClear, type PaperBox, type ElbowTagRequest } from "../../../packages/bim-kernel/src/annotation/elbow-leader";
import { gc, percentile, round, timeSync } from "./lib";

const SAMPLES = 9;

function plan(n: number): { requests: ElbowTagRequest[]; obstacles: PaperBox[] } {
  const perRow = 40;
  const requests: ElbowTagRequest[] = [];
  const obstacles: PaperBox[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % perRow) * 8 + (Math.floor(i / perRow) % 2) * 4;
    const y = Math.floor(i / perRow) * 30;
    requests.push({ id: `tag-${i}`, target: { x, y }, size: { w: 7 + (i % 3), h: 3.4 } });
    if (i % 7 === 3) obstacles.push({ min: { x: x + 2, y: y + 9 }, max: { x: x + 14, y: y + 13 } });
  }
  return { requests, obstacles };
}

function measure(n: number): { p50: number; p95: number; unclear: number } {
  const { requests, obstacles } = plan(n);
  const ms: number[] = [];
  let unclear = 0;
  for (let i = 0; i < SAMPLES; i++) {
    gc();
    const t = timeSync(() => placeTagsClear(requests, obstacles));
    ms.push(t.ms);
    unclear = t.value.filter((p) => !p.clear).length;
  }
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3), unclear };
}

console.log(JSON.stringify({ "tags.spread.200": measure(200), "tags.spread.1000": measure(1000), "tags.spread.2000": measure(2000) }));
