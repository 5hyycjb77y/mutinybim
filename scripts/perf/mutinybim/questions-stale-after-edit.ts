/**
 * questions.stale_after_agent_edit — round 10 lane Q10: which answers one
 * saved edit made stale, read from the edit's changed ids only.
 *
 *   node --import tsx scripts/perf/mutinybim/questions-stale-after-edit.ts [--tier=250k|1M] [--answers=1000] [--samples=7]
 *
 * Builds the full-building synthetic at the tier, asks and answers N
 * questions pinned to rooms (each answer relies on its room), then times
 * `answersMadeStaleByEdit(before, after, changedIds)` for one edit to a
 * relied-on room:
 *
 *   questions.stale_after_agent_edit.cold   a fresh `before` (an agent session opens the model anew): builds the answers-by-id index, then checks
 *   questions.stale_after_agent_edit.warm   the same head again (index cached per snapshot)
 *
 * Budget (README "Performance rows"): ≤ 20 ms at 250k and 1M.
 */
import { answersMadeStaleByEdit, commandSchema, draftElements, elementsOfKind, executeCommand, freezeElements, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";

import { emit } from "./lib";

const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const tier = arg("tier", "250k") === "1M" ? "1M" : "250k";
const answers = Number(arg("answers", "1000"));
const samples = Number(arg("samples", "7"));
const ASKER = { id: "perf-asker", name: "Asker", kind: "human" as const };
const ANSWERER = { id: "perf-answerer", name: "Answerer", kind: "human" as const };

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 1000) / 1000;
}

function step(m: ModelState, command: unknown, actor: typeof ASKER): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor, at: "2026-11-02T10:00:00.000Z" }));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

const t0 = performance.now();
let model = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `synthetic-${tier}-q10-stale` });
model = { ...model, elements: freezeElements(model.elements) };
const rooms = elementsOfKind(model.elements, "room").map((r) => r.id);
if (rooms.length < 2) throw new Error("the synthetic model has fewer than two rooms");
const pinned = rooms.slice(0, Math.min(answers, rooms.length - 1));
for (let start = 0; start < pinned.length; start += 200) {
  const batch = pinned.slice(start, start + 200).map((roomId, k) => ({ questionId: `perf-sq-${start + k}`, text: `Is ${roomId} still an office?`, askOf: "Architect", anchor: { elementIds: [roomId] } }));
  model = step(model, { type: "add_question", questions: batch }, ASKER);
}
for (let k = 0; k < pinned.length; k++) model = step(model, { type: "answer_question", questionId: `perf-sq-${k}`, answer: "Yes." }, ANSWERER);
model = { ...model, elements: freezeElements(draftElements(model.elements)) };
const relied = pinned[0] ?? "";
const buildS = Math.round((performance.now() - t0) / 100) / 10;

function renamed(elements: ModelState["elements"], roomId: string, name: string): ModelState["elements"] {
  const draft = draftElements(elements);
  const room = draft[roomId];
  if (!room) throw new Error(`no room ${roomId}`);
  draft[roomId] = { ...room, version: room.version + 1, name } as typeof room;
  return freezeElements(draft);
}

const cold: number[] = [];
const warm: number[] = [];
let found = 0;
for (let i = 0; i < samples; i++) {
  const before = freezeElements(draftElements(model.elements));
  const after = renamed(before, relied, `Renamed ${i}`);
  cold.push(time(() => void (found = answersMadeStaleByEdit(before, after, [relied]).length)));
  warm.push(time(() => void answersMadeStaleByEdit(before, after, [relied])));
}
if (found !== 1) throw new Error(`expected exactly one stale answer, found ${found}`);

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
const counts = { elements: Object.keys(model.elements).length, answers: pinned.length, stale: found };
process.stderr.write(`${JSON.stringify({ suite: "questions-stale-after-edit", tier, buildSeconds: buildS, metrics: { "questions.stale_after_agent_edit.cold": row(cold), "questions.stale_after_agent_edit.warm": row(warm) }, counts }, null, 2)}\n`);
const c = { totalElements: counts.elements, affectedElements: 1 };
emit({
  suite: "batch",
  workload: { questions: `${counts.answers} answers relying on rooms, synthetic ${tier}; one edit to a relied-on room`, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: `questions.stale_after_agent_edit.cold.${tier}`, values: cold, counts: c, note: "A fresh head (agent session): answers-by-id index built, then the changed id checked." },
    { metric: `questions.stale_after_agent_edit.warm.${tier}`, values: warm, counts: c, note: "Same head again: index cached per snapshot." },
  ],
});
