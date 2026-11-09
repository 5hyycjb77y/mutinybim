/**
 * Round 15 SC15: what one column change costs on the full-BIM model. An
 * equipment schedule over every element of the tier gets one `edit_schedule`
 * (rename a column, then sort by it) committed through `planCommit` (one
 * revision, one undo step: the command re-sizes the schedule's paper), then
 * its rows are rebuilt for the grid with the new definition.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/sc15-schedule-steps.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { commandSchema, fieldProviderRegistry, freezeElements, planCommit, type Command, type ModelState, type ScheduleDefinitionV2 } from "../../../packages/bim-kernel/src";
import { buildRowSet, scheduleV1ToV2 } from "../../../packages/bim-kernel/src/schedules/engine";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "20");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/sc15-schedule-steps] usage: sc15-schedule-steps.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `sc15-steps-${tier}` });
const actor = { id: "perf", name: "Perf", kind: "agent" as const };
let head: ModelState = { ...built, elements: freezeElements(built.elements) };
const VIEW = "sc15-equipment";
const schedule: ScheduleDefinitionV2 = { ...scheduleV1ToV2({ category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "family" }, { field: "type" }, { field: "level" }] }), name: "Equipment" };
const created = planCommit(head, [], { idempotencyKey: "sc15-setup", baseRevision: head.revision, actor, command: commandSchema.parse({ type: "create_view", viewId: VIEW, name: "Equipment", viewType: "schedule", props: { scheduleV2: schedule } }) });
if (!created.ok) {
  console.error(`[perf/sc15-schedule-steps] setup refused: ${created.error.message}`);
  process.exit(1);
}
head = created.model;

const edit = (sample: number): Command =>
  commandSchema.parse({ type: "edit_schedule", viewId: VIEW, steps: [{ op: "rename_column", columnId: "type", heading: `TYPE ${sample}` }, { op: "sort", sort: [{ path: sample % 2 === 0 ? "type" : "mark", direction: "asc" }] }] });

function sample(s: number): { readonly apply: number; readonly rows: number; readonly rowCount: number } {
  const applied = timeSync(() => planCommit(head, [], { idempotencyKey: `sc15-edit-${s}`, baseRevision: head.revision, actor, command: edit(s) }));
  if (!applied.value.ok) throw new Error(`edit_schedule refused: ${applied.value.error.message}`);
  const model = applied.value.model;
  const view = model.elements[VIEW];
  const def = view?.kind === "view" ? view.props?.scheduleV2 : undefined;
  if (!def) throw new Error("the schedule lost its definition");
  const rebuilt = timeSync(() => buildRowSet(model, def, { viewId: VIEW, revision: model.revision, registry: fieldProviderRegistry() }));
  return { apply: applied.ms, rows: rebuilt.ms, rowCount: rebuilt.value.rowCount };
}

sample(-1); // warm, not timed
gc();
const applies: number[] = [];
const rebuilds: number[] = [];
let rowCount = 0;
for (let s = 0; s < samples; s++) {
  const t = sample(s);
  applies.push(t.apply);
  rebuilds.push(t.rows);
  rowCount = t.rowCount;
}
const stat = (xs: readonly number[]) => ({ p50: round(percentile(xs, 0.5) ?? 0, 2), p95: round(percentile(xs, 0.95) ?? 0, 2), max: round(Math.max(...xs), 2) });
console.log(JSON.stringify({ [`schedule.edit_step.apply.${tier}`]: { ...stat(applies), elements: Object.keys(head.elements).length }, [`schedule.rows.after_column_edit.${tier}`]: { ...stat(rebuilds), rows: rowCount } }));
