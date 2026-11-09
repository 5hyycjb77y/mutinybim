/**
 * Wall tops bound to surfaces: what one floor edit costs when walls under it
 * run to its underside, and what every other edit pays for the check.
 * Measured on the full-BIM model with every wall bound to the structure above.
 *
 * - arch.wall.surface_follow.<tier>: one `set_element_thickness` commit on a
 *   floor; the walls under it are found through the line-join cells under its
 *   footprint (never the model) and re-sized in the same change, p50 / p95 ms.
 *   Budget 15 / 40 ms at 250k, 30 / 80 ms at 1M.
 * - arch.wall.surface_follow_idle.<tier> (context, not budgeted): a value edit
 *   on a door (no face, no bound wall touched): the hook's cost when it
 *   reaches nothing.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/wall-surface-follow.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { asElementId, commandSchema, editableLinePlacement, executeCommand, freezeElements, withUpgradePolicy, type BimElement, type ModelState } from "../../../packages/bim-kernel/src";
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
  console.error(`[perf/wall-surface-follow] usage: wall-surface-follow.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `wall-surface-${tier}` });
// The seed names its floors by partition only: give each a level record (4.2 m floor to floor) so its walls and floors stand somewhere.
const withLevels: Record<string, BimElement> = { ...built.elements };
const floorNames = [...new Set(Object.values(built.elements).flatMap((e) => (e.kind === "wall" || e.kind === "slab") && e.partition ? [e.partition.level] : []))].sort();
floorNames.forEach((name, i) => {
  withLevels[name] = { id: asElementId(name), version: 1, authoredRev: {}, kind: "level", name, elevationMm: i * 4200 } as BimElement;
});
// Every wall that can be placed runs to the structure above (written straight into the seed: setup, not timed).
// A fresh record: the kernel indexes a record once by identity, so one read is never written into afterwards.
const bound: Record<string, BimElement> = { ...withLevels };
let boundWalls = 0;
for (const el of Object.values(withLevels)) {
  if (el.kind !== "wall") continue;
  const p = editableLinePlacement(el, withLevels);
  if (!p) continue;
  bound[el.id] = { ...el, placement: { ...p, topSurface: { to: "structure" } } };
  boundWalls += 1;
}
let head: ModelState = { ...built, elements: freezeElements(bound) };
const slabs = Object.values(head.elements).flatMap((e) => (e.kind === "slab" ? [e] : []));
const doors = Object.values(head.elements).flatMap((e) => (e.kind === "opening" ? [e] : []));
if (slabs.length === 0 || doors.length === 0 || boundWalls === 0) {
  console.error(`[perf/wall-surface-follow] the ${tier} model has ${slabs.length} floors, ${doors.length} openings and ${boundWalls} walls; nothing to measure`);
  process.exit(1);
}

const commit = (command: unknown): { ms: number; changed: number } => {
  const parsed = commandSchema.parse(command);
  const { ms, value } = timeSync(() => withUpgradePolicy(() => true, () => executeCommand(head, parsed)));
  if (!value.ok) {
    console.error("[perf/wall-surface-follow] edit refused", value.error.message);
    process.exit(1);
  }
  head = value.model;
  return { ms, changed: value.changedIds.length };
};

// Cold: one edit builds the indexes on the seed revision (not timed); every edit after carries them.
commit({ type: "set_element_thickness", elementIds: [slabs[0]?.id ?? ""], thicknessMm: 210 });

const follow: number[] = [];
const idle: number[] = [];
let resizedMax = 0;
for (let i = 0; i <= samples; i++) {
  const slab = slabs[(i * 7919) % slabs.length];
  const door = doors[(i * 104729) % doors.length];
  if (!slab || !door) continue;
  gc();
  const f = commit({ type: "set_element_thickness", elementIds: [slab.id], thicknessMm: i % 2 === 0 ? 200 : 250 });
  gc();
  const d = commit({ type: "set_element_values", elementIds: [door.id], values: { "opening.sill_mm": i % 2 === 0 ? 0 : 10 } });
  if (i === 0) continue;
  follow.push(f.ms);
  idle.push(d.ms);
  resizedMax = Math.max(resizedMax, f.changed - 1);
}

console.log(
  JSON.stringify({
    [`arch.wall.surface_follow.${tier}`]: { ...stats(follow), boundWalls, floors: slabs.length, resizedMax },
    [`arch.wall.surface_follow_idle.${tier}`]: stats(idle),
  }),
);
