/**
 * validity.* — round 9 lane Q9 (temporal validity): answers that record what
 * they relied on, checked incrementally as the model changes.
 *
 *   node --import tsx scripts/perf/mutinybim/validity.ts [--tier=250k|1M] [--answers=1000] [--samples=7]
 *
 * Builds the full-building synthetic at the tier, asks and answers N
 * questions pinned to rooms (each answer relies on its room), commits the
 * head, then measures:
 *
 *   validity.index.cold        the first stale read on the head: files every answer (a kind read, not the model)
 *   validity.carry.relied      carrying the index over one edit to a relied-on room (re-checks its dependants only)
 *   validity.carry.unrelated   carrying the index over one edit nothing relies on (shares the index)
 *   validity.read.after_edit   the stale set and one answer's words on the new revision (index warm)
 *
 * `validity.carry.*` time the validity carry alone; counts prove one re-check, not N.
 */
import {
  answerValidity,
  commandSchema,
  draftElements,
  elementsOfKind,
  executeCommand,
  freezeElements,
  staleRecords,
  validityStats,
  withUpgradePolicy,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { carryRevision } from "../../../packages/bim-kernel/src/revision-carry";

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
let model = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `synthetic-${tier}-validity` });
model = { ...model, elements: freezeElements(model.elements) };
const rooms = elementsOfKind(model.elements, "room").map((r) => r.id);
if (rooms.length < 2) throw new Error("the synthetic model has fewer than two rooms");
const pinned = rooms.slice(0, Math.min(answers, rooms.length - 1));
for (let start = 0; start < pinned.length; start += 200) {
  const batch = pinned.slice(start, start + 200).map((roomId, k) => ({ questionId: `perf-vq-${start + k}`, text: `Is ${roomId} still an office?`, askOf: "Architect", anchor: { elementIds: [roomId] } }));
  model = step(model, { type: "add_question", questions: batch }, ASKER);
}
for (let k = 0; k < pinned.length; k++) model = step(model, { type: "answer_question", questionId: `perf-vq-${k}`, answer: "Yes." }, ANSWERER);
model = { ...model, elements: freezeElements(draftElements(model.elements)) };
const relied = pinned[0] ?? "";
const unrelated = rooms[rooms.length - 1] ?? "";
const buildS = Math.round((performance.now() - t0) / 100) / 10;

const cold: number[] = [];
const carryRelied: number[] = [];
const carryUnrelated: number[] = [];
const readAfter: number[] = [];
let counts = { elements: Object.keys(model.elements).length, answers: pinned.length, rechecksRelied: 0, rechecksUnrelated: 0, stale: 0 };

function renamed(head: ModelState, roomId: string, name: string): ModelState["elements"] {
  const draft = draftElements(head.elements);
  const room = draft[roomId];
  if (!room) throw new Error(`no room ${roomId}`);
  draft[roomId] = { ...room, version: room.version + 1, name } as typeof room;
  return freezeElements(draft);
}

for (let i = 0; i < samples; i++) {
  // A fresh head object each sample, so the cold read really builds.
  const head: ModelState = { ...model, elements: freezeElements(draftElements(model.elements)) };
  cold.push(time(() => void staleRecords(head.elements)));
  const a = renamed(head, unrelated, `Unrelated ${i}`);
  carryUnrelated.push(time(() => carryRevision(head.elements, a, [unrelated])));
  const unrelatedRechecks = validityStats(a).rechecks;
  const b = renamed({ ...head, elements: a }, relied, `Renamed ${i}`);
  carryRelied.push(time(() => carryRevision(a, b, [relied])));
  const reliedRechecks = validityStats(b).rechecks;
  let stale = 0;
  readAfter.push(time(() => {
    stale = staleRecords(b).size;
    void answerValidity(b, "perf-vq-0");
  }));
  counts = { ...counts, rechecksRelied: reliedRechecks, rechecksUnrelated: unrelatedRechecks, stale };
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "validity", tier, buildSeconds: buildS, metrics: { "validity.index.cold": row(cold), "validity.carry.relied": row(carryRelied), "validity.carry.unrelated": row(carryUnrelated), "validity.read.after_edit": row(readAfter) }, counts }, null, 2)}\n`);
const c = { totalElements: counts.elements, affectedElements: counts.rechecksRelied };
emit({
  suite: "batch",
  workload: { validity: `${counts.answers} answers relying on rooms, synthetic ${tier}`, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: `validity.index.cold.${tier}`, values: cold, counts: c, note: "First stale read on a head: files every answer from the kind index." },
    { metric: `validity.carry.relied.${tier}`, values: carryRelied, counts: c, note: "Index carried over an edit to one relied-on room (all registered carries)." },
    { metric: `validity.carry.unrelated.${tier}`, values: carryUnrelated, counts: c, note: "Index carried over an edit nothing relies on (shared)." },
    { metric: `validity.read.after_edit.${tier}`, values: readAfter, counts: c, note: "Stale set plus one answer's words after the edit." },
  ],
});
