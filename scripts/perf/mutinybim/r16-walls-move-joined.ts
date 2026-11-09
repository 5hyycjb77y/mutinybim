/**
 * Round 16 lane r16-walls: what moving one joined wall costs now that its
 * joined ends follow (kernel `joins/carry.ts`). Measured on the full-BIM model.
 *
 * - arch.wall.move_joined.<tier>: one `move_elements` commit of a wall whose
 *   corners and tees follow it, p50 / p95 ms. Budget 15 / 40 ms at 250k,
 *   30 / 80 ms at 1M (the hot path is the moved wall's join cells, never the level).
 * - arch.wall.move_carry.<tier>: the carry alone (that commit less the same
 *   move with Disjoin), p50 / p95 ms. Budget 3 / 6 ms at both tiers.
 *
 * Measured 2026-11-05 (laptop): 250k move 1.16 / 1.71, carry 0.74 / 1.30;
 * 1M move 1.92 / 2.25, carry 1.46 / 1.82 (rows in docs/perf/mutinybim-budgets.json).
 * - arch.wall.move_disjoin.<tier> (context, not budgeted): the same move with Disjoin.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/r16-walls-move-joined.ts [XS|250k|1M] [samples]
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
  console.error(`[perf/r16-walls-move-joined] usage: r16-walls-move-joined.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `r16-walls-${tier}` });
const start: ModelState = { ...built, elements: freezeElements(built.elements) };
const walls = Object.values(start.elements).flatMap((e) => (e.kind === "wall" ? [e] : []));
// Warm the join index on the seed revision (not timed); every edit after carries it.
const joined = walls.filter((w) => (lineMeetingsOf(start.elements, w.id)?.atEnds.length ?? 0) > 0);
if (joined.length === 0) {
  console.error(`[perf/r16-walls-move-joined] the ${tier} model has ${walls.length} walls and none joined; nothing to measure`);
  process.exit(1);
}

const commit = (head: ModelState, command: unknown): { ms: number; model: ModelState; written: number } => {
  const parsed = commandSchema.parse(command);
  const { ms, value } = timeSync(() => withUpgradePolicy(() => true, () => executeCommand(head, parsed)));
  if (!value.ok) {
    console.error("[perf/r16-walls-move-joined] edit refused", value.error.message);
    process.exit(1);
  }
  return { ms, model: value.model, written: value.changedIds.length };
};

const moveJoined: number[] = [];
const moveDisjoin: number[] = [];
const carry: number[] = [];
let followedMax = 0;
for (let i = 0; i <= samples; i++) {
  const wall = joined[(i * 7919) % joined.length];
  if (!wall) continue;
  const delta = { x: i % 2 === 0 ? 50 : -50, y: i % 3 === 0 ? 25 : 0 };
  gc();
  const free = commit(start, { type: "move_elements", ids: [wall.id], delta, disjoin: true });
  gc();
  const follow = commit(start, { type: "move_elements", ids: [wall.id], delta });
  followedMax = Math.max(followedMax, follow.written - free.written);
  if (i === 0) continue;
  moveJoined.push(follow.ms);
  moveDisjoin.push(free.ms);
  carry.push(Math.max(0, follow.ms - free.ms));
}

console.log(
  JSON.stringify({
    [`arch.wall.move_joined.${tier}`]: { ...stats(moveJoined), walls: walls.length, joinedWalls: joined.length, followedMax },
    [`arch.wall.move_carry.${tier}`]: stats(carry),
    [`arch.wall.move_disjoin.${tier}`]: stats(moveDisjoin),
  }),
);
