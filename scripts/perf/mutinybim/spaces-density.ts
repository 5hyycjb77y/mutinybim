/**
 * spaces.density.2k — 2,000 spaces on the synthetic tower (ROADMAP F3 "Done
 * when": 2,000 spaces stay inside a new budget).
 *
 *   node --import tsx scripts/perf/mutinybim/spaces-density.ts [--samples=7]
 *
 * Builds tower-14 with enough rooms for 2,000 spaces, makes a space from
 * every room in one command per level, gives each the restaurant dining use
 * (IMC rates pinned), then measures:
 *
 *   spaces.make_from_rooms.2k   the commands that make the 2,000 spaces (ms, total)
 *   spaces.density.2k.cold      every space's density load, first read (index built, 2,000 evaluations)
 *   spaces.density.2k.edit      every space's density load after one space is redrawn (1 re-evaluation, 1,999 cached)
 *   spaces.locate.10k           10,000 "which space is this point in" reads
 *   spaces.detect_rooms.200     room outlines proposed from a 200-room floor's linework
 *
 * Prints one JSON object (median and p95 per metric, plus counts that prove
 * the edit re-measured one space and re-evaluated one density).
 */
import { asElementId, elementsOfKind, type BimElement, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { BUILTIN_SPACE_USES, SPACE_USE_LIBRARY_ID, SPACE_USE_RATE_TARGETS } from "@permitzip/bim-library";
import { pinnedUseForCommand, pinSpaceUse } from "@permitzip/bim-calc";
import { executeSpaceDesignCommand } from "../../../packages/bim-kernel/src/spaces/space-commands";
import { densityEvaluationCount, densityLoad } from "../../../packages/bim-kernel/src/spaces/space-density";
import { advanceSpaceIndex, spaceAt, spaceIndexStats } from "../../../packages/bim-kernel/src/spaces/space-index";
import { detectRoomOutlines, type LineworkSegment } from "../../../packages/bim-kernel/src/spaces/detect";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const dining = BUILTIN_SPACE_USES.find((u) => u.id === "restaurant_dining");
if (!dining) throw new Error("restaurant_dining space use missing from the built-in library");
const pinned = pinSpaceUse(SPACE_USE_LIBRARY_ID, dining, SPACE_USE_RATE_TARGETS);
if (typeof pinned === "string") throw new Error(pinned);
const pinnedUse = pinnedUseForCommand(pinned);

function buildTower(): { model: ModelState; makeMs: number; spaces: ElementId[] } {
  let model = createFullBimModel({ floors: 14, zonesPerFloor: 2, rooms: { cols: 8, rows: 9 }, modelId: "synthetic-tower-14-spaces" });
  // The synthetic tower partitions by level name; spaces sit on level elements, so add one per storey.
  const names = [...new Set(elementsOfKind(model.elements, "room").map((r) => r.partition?.level).filter((n): n is string => !!n))];
  const elements: Record<string, BimElement> = { ...model.elements };
  names.forEach((name, i) => {
    const id = asElementId(`lvl-${name}`);
    elements[id] = { id, kind: "level", version: 1, authoredRev: {}, name, elevationMm: i * 4000 };
  });
  model = { ...model, elements };
  const levels = elementsOfKind(model.elements, "level");
  let makeMs = 0;
  for (const level of levels) {
    const t = performance.now();
    const r = executeSpaceDesignCommand(model, { type: "make_spaces_from_rooms", levelId: level.id, use: pinnedUse });
    makeMs += performance.now() - t;
    if (!r.ok) {
      if (/no rooms|already has/i.test(r.error.message)) continue;
      throw new Error(`make_spaces_from_rooms on ${level.name}: ${r.error.message}`);
    }
    model = r.model;
  }
  const spaces = elementsOfKind(model.elements, "space").map((s) => s.id);
  return { model, makeMs, spaces };
}

/** 20 x 10 rooms of 4 m, both wall faces drawn, a 900 mm door through every inner east-west wall. */
function twoHundredRoomLinework(): LineworkSegment[] {
  const t = 150;
  const seg = (ax: number, ay: number, bx: number, by: number): LineworkSegment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
  const wall = (x0: number, x1: number, y: number, gaps: ReadonlyArray<readonly [number, number]>): LineworkSegment[] => {
    const out: LineworkSegment[] = [];
    const cuts = [x0, ...gaps.flatMap(([a, b]) => [a, b]), x1];
    for (let i = 0; i + 1 < cuts.length; i += 2) {
      const a = cuts[i] as number;
      const b = cuts[i + 1] as number;
      out.push(seg(a, y - t / 2, b, y - t / 2), seg(a, y + t / 2, b, y + t / 2));
      if (i > 0) out.push(seg(a, y - t / 2, a, y + t / 2));
      if (i + 2 < cuts.length) out.push(seg(b, y - t / 2, b, y + t / 2));
    }
    return out;
  };
  const cols = 20;
  const rows = 10;
  const s = 4_000;
  const lines: LineworkSegment[] = [];
  for (let j = 0; j <= rows; j++) lines.push(...wall(0, cols * s, j * s, j > 0 && j < rows ? Array.from({ length: cols }, (_, i) => [i * s + 1_000, i * s + 1_900] as const) : []));
  for (let i = 0; i <= cols; i++) lines.push(...wall(0, rows * s, i * s, []).map((l) => ({ a: { x: l.a.y, y: l.a.x }, b: { x: l.b.y, y: l.b.x } })));
  return lines;
}

const make: number[] = [];
const cold: number[] = [];
const edit: number[] = [];
const locate: number[] = [];
const detect: number[] = [];
const floorLines = twoHundredRoomLinework();
let detectedRooms = 0;
let counts = { spaces: 0, elements: 0, remeasuredOnEdit: 0, reevaluatedOnEdit: 0 };

for (let i = 0; i < samples; i++) {
  const { model, makeMs, spaces } = buildTower();
  make.push(makeMs);
  cold.push(time(() => { for (const id of spaces) densityLoad(model.elements, id); }));

  const target = spaces[Math.floor(spaces.length / 2)] as ElementId;
  const s = model.elements[target];
  if (s?.kind !== "space") throw new Error("space missing");
  const level = s.levelId as ElementId;
  const r = executeSpaceDesignCommand(model, { type: "edit_space", spaceId: target, outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }] });
  if (!r.ok) throw new Error(r.error.message);
  const measuredBefore = spaceIndexStats(model.elements).measured;
  advanceSpaceIndex(model.elements, r.model.elements, r.changedIds, r.removedIds);
  const evalBefore = densityEvaluationCount();
  edit.push(time(() => { for (const id of spaces) densityLoad(r.model.elements, id); }));
  counts = { spaces: spaces.length, elements: Object.keys(r.model.elements).length, remeasuredOnEdit: spaceIndexStats(r.model.elements).measured - measuredBefore, reevaluatedOnEdit: densityEvaluationCount() - evalBefore };

  const pts = Array.from({ length: 10_000 }, (_, k) => ({ x: (k * 7919) % 60_000, y: (k * 104_729) % 30_000 }));
  locate.push(time(() => { for (const p of pts) spaceAt(r.model.elements, level, p); }));

  detect.push(time(() => {
    const found = detectRoomOutlines(floorLines);
    if (!found.ok) throw new Error(found.reason);
    detectedRooms = found.rooms.length;
  }));
}
if (detectedRooms !== 200) throw new Error(`room detection found ${detectedRooms} of 200 rooms`);

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(
  `${JSON.stringify(
    {
      suite: "spaces",
      metrics: {
        "spaces.make_from_rooms.2k": row(make),
        "spaces.density.2k.cold": row(cold),
        "spaces.density.2k.edit": row(edit),
        "spaces.locate.10k": row(locate),
        "spaces.detect_rooms.200": row(detect),
      },
      counts,
    },
    null,
    2,
  )}\n`,
);
const spaceCounts = { totalElements: counts.elements, affectedElements: counts.remeasuredOnEdit };
emit({
  suite: "batch",
  workload: { spaces: "2k on the synthetic tower", samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: "spaces.make_from_rooms.2k", values: make, counts: spaceCounts, note: "Make spaces from rooms for every room on the tower." },
    { metric: "spaces.density.2k.cold", values: cold, counts: spaceCounts, note: "Density (area) load of every space, nothing cached." },
    { metric: "spaces.density.2k.edit", values: edit, counts: spaceCounts, note: "One space redrawn: index advanced from its id, then every space's density read." },
    { metric: "spaces.locate.10k", values: locate, counts: spaceCounts, note: "10,000 'which space is this point in' lookups." },
    { metric: "spaces.detect_rooms.200", values: detect, note: "Room outlines proposed from the linework of a 200-room floor (80 x 40 m), default grid cap." },
  ],
});
