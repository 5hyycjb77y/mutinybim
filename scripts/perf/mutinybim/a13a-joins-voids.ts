/**
 * Round 13 lane A13a: what one wall edit and one opening edit cost the join
 * solve and host voids. Measured on the full-BIM model.
 *
 * - arch.join.one_wall_edit.<tier>: after a `move_wall` commit (the join
 *   index is carried to the new revision inside the commit), re-joining the
 *   moved wall and every wall whose box covers either of its ends, p50 / p95 ms.
 * - arch.void.one_opening_edit.<tier>: after a value edit on one door, its
 *   wall's voids, body blocks and plan graphics, p50 / p95 ms.
 * - arch.join.commit.<tier> (context, not budgeted): the whole commit.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/a13a-joins-voids.ts [250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock (lane Q13 runs them).
 */
import { commandSchema, executeCommand, freezeElements, withUpgradePolicy, type ModelState } from "../../../packages/bim-kernel/src";
import { hostSolidBlocks, hostVoidsOf } from "../../../packages/bim-kernel/src/hosting/voids";
import { lineJoinPlanGraphics } from "../../../packages/bim-kernel/src/joins/plan";
import { joinLinesNear, lineJoinsOf } from "../../../packages/bim-kernel/src/joins/solve";
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
  console.error(`[perf/a13a-joins-voids] usage: a13a-joins-voids.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `a13a-joins-${tier}` });
let head: ModelState = { ...built, elements: freezeElements(built.elements) };
const walls = Object.values(head.elements).flatMap((e) => (e.kind === "wall" ? [e] : []));
const doors = Object.values(head.elements).flatMap((e) => (e.kind === "opening" ? [e] : []));
if (walls.length === 0 || doors.length === 0) {
  console.error(`[perf/a13a-joins-voids] the ${tier} model has ${walls.length} walls and ${doors.length} openings; nothing to measure`);
  process.exit(1);
}

const commit = (command: unknown): number => {
  const parsed = commandSchema.parse(command);
  const { ms, value } = timeSync(() => withUpgradePolicy(() => true, () => executeCommand(head, parsed)));
  if (!value.ok) {
    console.error("[perf/a13a-joins-voids] edit refused", value.error.message);
    process.exit(1);
  }
  head = value.model;
  return ms;
};

// Cold: build the indexes once on the seed revision (not timed); every edit after carries them.
lineJoinsOf(head.elements, walls[0]?.id ?? "");
hostVoidsOf(head.elements, doors[0]?.hostId ?? "");

const join: number[] = [];
const joinCommit: number[] = [];
const voids: number[] = [];
let rejoined = 0;
for (let i = 0; i <= samples; i++) {
  const wall = walls[(i * 7919) % walls.length];
  if (!wall) continue;
  gc();
  const c = commit({ type: "move_wall", wallId: wall.id, delta: { x: i % 2 === 0 ? 10 : -10, y: 0 } });
  const moved = head.elements[wall.id];
  if (moved?.kind !== "wall") continue;
  const j = timeSync(() => {
    const near = new Set<string>([moved.id]);
    const level = lineJoinsOf(head.elements, moved.id)?.levelId ?? "";
    for (const p of [moved.start, moved.end]) for (const id of joinLinesNear(head.elements, level, p)) near.add(id);
    for (const id of near) lineJoinsOf(head.elements, id);
    return near.size;
  });
  rejoined = Math.max(rejoined, j.value);

  const door = doors[(i * 104729) % doors.length];
  if (!door) continue;
  commit({ type: "set_element_values", elementIds: [door.id], values: { "opening.sill_mm": i % 2 === 0 ? 0 : 10 } });
  const host = head.elements[door.hostId];
  if (!host) continue;
  const v = timeSync(() => {
    hostVoidsOf(head.elements, host.id);
    hostSolidBlocks(head.elements, host, 3000);
    lineJoinPlanGraphics(host, { elements: head.elements, scale: 100, levelId: "", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null });
  });
  if (i === 0) continue;
  join.push(j.ms);
  joinCommit.push(c);
  voids.push(v.ms);
}

console.log(
  JSON.stringify({
    [`arch.join.one_wall_edit.${tier}`]: { ...stats(join), walls: walls.length, rejoinedMax: rejoined },
    [`arch.void.one_opening_edit.${tier}`]: { ...stats(voids), openings: doors.length },
    [`arch.join.commit.${tier}`]: stats(joinCommit),
  }),
);
