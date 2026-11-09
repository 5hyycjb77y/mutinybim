/**
 * Round 13 lane A13b: rooms from walls on the full-BIM model (walls on a room
 * grid in every zone).
 *
 * - spaces.detect_from_walls.level.<tier>: Find rooms from walls on one level,
 *   cold (the boundary index built for that level), p50 / p95 ms.
 * - spaces.place_by_click.<tier>: one `place_space_in_walls` (the room traced
 *   around the click from the boundary index), p50 / p95 ms.
 * - spaces.boundary.one_wall_edit.<tier>: one `move_wall` commit with bounded
 *   rooms around the wall (the rooms it bounds re-traced in the same edit),
 *   p50 / p95 ms, and how many rooms the worst edit re-traced.
 * - spaces.split.one_line.<tier>: one `split_space` across a bounded room.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/a13b-spaces-walls.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock (lane Q13 runs them).
 */
import { asElementId, commandSchema, elementsOfKind, executeCommand, freezeElements, withUpgradePolicy, type BimElement, type ElementId, type ModelState } from "../../../packages/bim-kernel/src";
import { detectRoomsFromWalls } from "../../../packages/bim-kernel/src/spaces/detect";
import { executeSpaceDesignCommand, type SpaceDesignCommand } from "../../../packages/bim-kernel/src/spaces/space-commands";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3) };
}

const tier = process.argv[2] ?? "XS";
const samples = Number(process.argv[3] ?? "15");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/a13b-spaces-walls] usage: a13b-spaces-walls.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const everyone = <T>(fn: () => T): T => withUpgradePolicy(() => true, fn);

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `a13b-walls-${tier}` });
// Walls name their level by partition; make sure each named level is a level record (as the spaces suites do).
const elements: Record<string, BimElement> = { ...built.elements };
const levelNames = new Set(elementsOfKind(built.elements, "level").map((l) => l.name));
const wallLevels = [...new Set(elementsOfKind(built.elements, "wall").map((w) => w.partition?.level).filter((n): n is string => !!n))];
wallLevels.forEach((name, i) => {
  if (levelNames.has(name)) return;
  const id = asElementId(`lvl-${name}`);
  elements[id] = { id, kind: "level", version: 1, authoredRev: {}, name, elevationMm: i * 4000 };
});
let head: ModelState = { ...built, elements: freezeElements(elements) };
const level = elementsOfKind(head.elements, "level").find((l) => l.name === wallLevels[0]);
if (!level) {
  console.error(`[perf/a13b-spaces-walls] the ${tier} model has no level with walls; nothing to measure`);
  process.exit(1);
}

// Find rooms from walls, cold: a fresh record copy each sample, so the boundary index is rebuilt for the level.
const detect: number[] = [];
let proposals = detectRoomsFromWalls(head.elements, level.id);
for (let i = 0; i < Math.min(samples, 5); i++) {
  const copy = { ...head.elements };
  gc();
  const t = timeSync(() => detectRoomsFromWalls(copy, level.id));
  detect.push(t.ms);
  proposals = t.value;
}
if (proposals.length === 0) {
  console.error(`[perf/a13b-spaces-walls] no closed rooms found on ${level.name}; nothing to measure`);
  process.exit(1);
}

const run = (m: ModelState, c: SpaceDesignCommand) => everyone(() => executeSpaceDesignCommand(m, c));

// One click: the room traced around a seed (not kept, so every sample places into the same model).
const click: number[] = [];
for (let i = 0; i <= samples; i++) {
  const p = proposals[(i * 7919) % proposals.length];
  if (!p) continue;
  gc();
  const t = timeSync(() => run(head, { type: "place_space_in_walls", spaceId: `perf-click-${i}`, levelId: level.id, seed: p.seed }));
  if (!t.value.ok) {
    console.error("[perf/a13b-spaces-walls] place refused", t.value.error.message);
    process.exit(1);
  }
  if (i > 0) click.push(t.ms);
}

// Keep every proposed room as a bounded space, so wall edits have rooms to re-trace.
proposals.forEach((p, i) => {
  const r = run(head, { type: "place_space_in_walls", spaceId: `perf-room-${i}`, levelId: level.id, seed: p.seed, number: String(100 + i) });
  if (r.ok) head = r.model;
});
const roomIds: ElementId[] = proposals.map((_, i) => asElementId(`perf-room-${i}`)).filter((id) => head.elements[id]?.kind === "space");

const commit = (command: unknown) => {
  const parsed = commandSchema.parse(command);
  const t = timeSync(() => everyone(() => executeCommand(head, parsed)));
  if (!t.value.ok) {
    console.error("[perf/a13b-spaces-walls] edit refused", t.value.error.message);
    process.exit(1);
  }
  head = t.value.model;
  return { ms: t.ms, changed: t.value.changedIds };
};

// One wall edit: a wall that bounds a kept room moves 10 mm and back.
const bounding = [...new Set(roomIds.flatMap((id) => { const s = head.elements[id]; return s?.kind === "space" && s.bounds.kind === "bounded" ? s.bounds.boundary.map((b) => b.elementId) : []; }))].filter((id) => head.elements[id]?.kind === "wall");
const wallEdit: number[] = [];
let retracedMax = 0;
for (let i = 0; i <= samples; i++) {
  const wallId = bounding[(i * 104729) % bounding.length];
  if (!wallId) continue;
  const wall = head.elements[wallId];
  if (wall?.kind !== "wall") continue;
  const dx = wall.start.y === wall.end.y ? 0 : i % 2 === 0 ? 10 : -10;
  const dy = wall.start.y === wall.end.y ? (i % 2 === 0 ? 10 : -10) : 0;
  gc();
  const r = commit({ type: "move_wall", wallId, delta: { x: dx, y: dy } });
  retracedMax = Math.max(retracedMax, r.changed.filter((id) => head.elements[id]?.kind === "space").length);
  if (i > 0) wallEdit.push(r.ms);
}

// One split: a line across a kept room, through its middle (not kept).
const split: number[] = [];
for (let i = 0; i <= samples; i++) {
  const id = roomIds[(i * 31) % roomIds.length];
  const s = id ? head.elements[id] : undefined;
  // A room the 10 mm wall moves above left open can't be split (it says so); measure on closed ones.
  if (s?.kind !== "space" || s.bounds.kind !== "bounded" || s.bounds.open) continue;
  const xs = s.bounds.outline.map((p) => p.x);
  const ys = s.bounds.outline.map((p) => p.y);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  gc();
  const t = timeSync(() => run(head, { type: "split_space", spaceId: s.id, line: { start: { x: midX, y: Math.min(...ys) - 500 }, end: { x: midX, y: Math.max(...ys) + 500 } }, separatorId: `perf-line-${i}`, typedLoadsTo: `${s.number}A` }));
  if (!t.value.ok) {
    console.error("[perf/a13b-spaces-walls] split refused", t.value.error.message);
    process.exit(1);
  }
  if (i > 0) split.push(t.ms);
}

console.log(
  JSON.stringify({
    [`spaces.detect_from_walls.level.${tier}`]: { ...stats(detect), rooms: proposals.length, walls: elementsOfKind(head.elements, "wall").length },
    [`spaces.place_by_click.${tier}`]: stats(click),
    [`spaces.boundary.one_wall_edit.${tier}`]: { ...stats(wallEdit), roomsKept: roomIds.length, retracedMax, leftOpen: roomIds.filter((id) => { const x = head.elements[id]; return x?.kind === "space" && x.bounds.kind === "bounded" && x.bounds.open !== undefined; }).length },
    [`spaces.split.one_line.${tier}`]: { ...stats(split), samples: split.length },
  }),
);
