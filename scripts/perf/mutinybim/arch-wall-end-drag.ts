/**
 * Architecture follow-ups: what dragging one end of a joined wall costs
 * (`move_line_end`, kernel `joins/end-commands.ts` + `carryJoinedEndsOfReshape`).
 * Measured on the full-BIM model, like `r16-walls-move-joined.ts`.
 *
 * - arch.wall.end_drag.<tier>: one `move_line_end` commit of a joined wall's end
 *   whose corner follows, p50 / p95 ms. Proposed budget: the move_joined row's
 *   (15 / 40 ms at 250k, 30 / 80 ms at 1M): the hot path is that end's join cells.
 * - arch.wall.end_carry.<tier>: the carry alone (that commit less the same drag
 *   with Disjoin). Proposed budget: move_carry's (3 / 6 ms).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/arch-wall-end-drag.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { commandSchema, executeCommand, freezeElements, withUpgradePolicy, type ModelState } from "../../../packages/bim-kernel/src";
import { lineMeetingsOf } from "../../../packages/bim-kernel/src/joins/solve";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3) };
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "30");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/arch-wall-end-drag] usage: arch-wall-end-drag.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `arch-end-drag-${tier}` });
const start: ModelState = { ...built, elements: freezeElements(built.elements) };
const walls = Object.values(start.elements).flatMap((e) => (e.kind === "wall" ? [e] : []));
// Walls with a corner at their end (warms the join index on the seed revision; not timed).
const cornered = walls.filter((w) => (lineMeetingsOf(start.elements, w.id)?.atEnds ?? []).some((m) => m.end === "end" && m.otherEnd !== null));
if (cornered.length === 0) {
  console.error(`[perf/arch-wall-end-drag] the ${tier} model has ${walls.length} walls and none with a corner at its end; nothing to measure`);
  process.exit(1);
}

const commit = (head: ModelState, command: unknown): { ms: number; written: number } | null => {
  const parsed = commandSchema.parse(command);
  const { ms, value } = timeSync(() => withUpgradePolicy(() => true, () => executeCommand(head, parsed)));
  // A drag that would push a door off its wall is refused in words; that sample is skipped.
  return value.ok ? { ms, written: value.changedIds.length } : null;
};

// Records the follow changed beyond the Disjoin drag: the walls that followed and what re-derives from them.
const drag: number[] = [];
const disjoin: number[] = [];
const carry: number[] = [];
let extraChangedMax = 0;
let refused = 0;
for (let i = 0; i <= samples; i++) {
  const wall = cornered[(i * 7919) % cornered.length];
  if (!wall) continue;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 1;
  // 150 mm further along the wall, so hosted doors keep fitting.
  const to = { x: Math.round(wall.end.x + (dx / len) * 150), y: Math.round(wall.end.y + (dy / len) * 150) };
  gc();
  const free = commit(start, { type: "move_line_end", elementId: wall.id, end: "end", to, disjoin: true });
  gc();
  const follow = commit(start, { type: "move_line_end", elementId: wall.id, end: "end", to });
  if (!free || !follow) {
    refused += 1;
    continue;
  }
  extraChangedMax = Math.max(extraChangedMax, follow.written - free.written);
  if (i === 0) continue;
  drag.push(follow.ms);
  disjoin.push(free.ms);
  carry.push(Math.max(0, follow.ms - free.ms));
}

console.log(
  JSON.stringify({
    [`arch.wall.end_drag.${tier}`]: { ...stats(drag), walls: walls.length, corneredWalls: cornered.length, extraChangedMax, refused },
    [`arch.wall.end_carry.${tier}`]: stats(carry),
    [`arch.wall.end_disjoin.${tier}`]: stats(disjoin),
  }),
);
