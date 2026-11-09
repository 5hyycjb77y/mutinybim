/**
 * questions.* — 500 questions pinned across the synthetic 14-storey tower
 * (ROADMAP F7): the question index must answer "what is open on these
 * elements?" and "what holds this sheet?" without reading the model.
 *
 *   node --import tsx scripts/perf/mutinybim/questions-index.ts [--samples=7]
 *
 * Builds tower-14, one floor plan per storey on its own sheet, pins 500
 * questions (50 marked to hold the issue) to elements spread over the tower,
 * then measures:
 *
 *   questions.add.500            the add_question commands (ms, total)
 *   questions.open_for.10k       10,000 openQuestionsFor reads of one element each (index warm)
 *   questions.answer.edit        answer one question, advance the index by its id, read it back
 *   questions.issue_holds.sheets issueHoldsFor on every sheet (14)
 *   questions.register           every question, on a new revision after one edit (round 9 row)
 *   question.thread.read         one question's thread with 200 replies, on a new revision (round 9 row)
 *
 * Counts prove the edit re-filed one question, not 500.
 */
import { allQuestions, commandSchema, elementValues, executeCommand, questionThread, withUpgradePolicy, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { executeQuestionCommand } from "../../../packages/bim-kernel/src/questions/commands";
import { issueHoldsFor, openQuestionsFor } from "../../../packages/bim-kernel/src/questions/holds";
import { advanceQuestionIndex, questionIndexStats } from "../../../packages/bim-kernel/src/questions/question-index";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const QUESTIONS = 500;
const BLOCKING_EVERY = 10;

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const ANCHORABLE = new Set(["duct_segment", "terminal", "equipment", "part", "run_segment", "wall", "room", "column", "beam"]);

function build(): { model: ModelState; anchors: ElementId[]; sheets: ElementId[]; addMs: number } {
  let model = createFullBimModel({ floors: 14, zonesPerFloor: 2, rooms: { cols: 8, rows: 9 }, modelId: "synthetic-tower-14-questions" });
  const levels = [...new Set(elementValues(model.elements).map((e) => e.partition?.level).filter((n): n is string => !!n && n !== "global"))].slice(0, 14);
  const commands = levels.flatMap((name, i) => [
    { type: "create_sheet", sheetId: `qs-${i}`, number: `M-${101 + i}`, name: `${name} plan` },
    { type: "create_view", viewId: `qv-${i}`, name: `${name} plan`, viewType: "floor_plan", props: { level: name } },
    { type: "place_viewport", viewportId: `qvp-${i}`, sheetId: `qs-${i}`, viewId: `qv-${i}`, center: { x: 400, y: 300 } },
  ]);
  const docs = executeCommand(model, commandSchema.parse({ type: "batch_documents", label: "Plans", commands }));
  if (!docs.ok) throw new Error(docs.error.message);
  model = docs.model;
  const candidates = elementValues(model.elements).filter((e) => ANCHORABLE.has(e.kind));
  const step = Math.max(1, Math.floor(candidates.length / QUESTIONS));
  const anchors = Array.from({ length: QUESTIONS }, (_, k) => candidates[(k * step) % candidates.length]?.id).filter((id): id is ElementId => id !== undefined);
  let addMs = 0;
  for (let start = 0; start < anchors.length; start += 200) {
    const batch = anchors.slice(start, start + 200).map((id, k) => ({
      questionId: `perf-q-${start + k}`,
      text: `Is there a conflict at ${id}?`,
      askOf: (start + k) % 3 === 0 ? "client" : "architect",
      anchor: { elementIds: [id] },
      ...((start + k) % BLOCKING_EVERY === 0 ? { blocksIssue: true } : {}),
    }));
    const t = performance.now();
    const r = executeQuestionCommand(model, { type: "add_question", questions: batch });
    addMs += performance.now() - t;
    if (!r.ok) throw new Error(r.error.message);
    advanceQuestionIndex(model.elements, r.model.elements, r.changedIds, r.removedIds);
    model = r.model;
  }
  return { model, anchors, sheets: levels.map((_, i) => `qs-${i}` as ElementId), addMs };
}

const add: number[] = [];
const openFor: number[] = [];
const answer: number[] = [];
const holds: number[] = [];
const register: number[] = [];
const thread: number[] = [];
const REPLIES = 200;
let counts = { elements: 0, questions: 0, sheets: 0, refiledOnAnswer: 0, holdsFound: 0, threadEntries: 0 };

/** 200 replies on one question, alternating two people (round 9 threads; peers that store them). */
function withReplies(model: ModelState): ModelState {
  let m = model;
  for (let k = 0; k < REPLIES; k++) {
    const actor = k % 2 === 0 ? { id: "perf-asker", name: "Asker", kind: "human" as const } : { id: "perf-asked", name: "Asked", kind: "human" as const };
    const at = new Date(Date.UTC(2026, 10, 2, 9, 0, k)).toISOString();
    const r = withUpgradePolicy(() => true, () => executeQuestionCommand(m, { type: "reply_question", questionId: "perf-q-2", text: `Reply ${k}` }, { actorId: actor.id, actor, at }));
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  }
  return m;
}

for (let i = 0; i < samples; i++) {
  const { model, anchors, sheets, addMs } = build();
  add.push(addMs);
  openFor.push(time(() => { for (let k = 0; k < 10_000; k++) openQuestionsFor(model, [anchors[(k * 7919) % anchors.length] as ElementId]); }));

  const before = questionIndexStats(model.elements).filed;
  let next = model;
  answer.push(
    time(() => {
      const r = executeQuestionCommand(model, { type: "answer_question", questionId: "perf-q-1", answer: "No conflict" });
      if (!r.ok) throw new Error(r.error.message);
      advanceQuestionIndex(model.elements, r.model.elements, r.changedIds, r.removedIds);
      next = r.model;
      openQuestionsFor(next, [anchors[1] as ElementId]);
    }),
  );
  let found = 0;
  holds.push(time(() => { for (const s of sheets) found += issueHoldsFor(next, s).length; }));
  register.push(time(() => void allQuestions(next.elements)));
  const replied = withReplies(next);
  const edited = executeQuestionCommand(replied, { type: "edit_question", questionId: "perf-q-3", text: "Edited" });
  if (!edited.ok) throw new Error(edited.error.message);
  let entries = 0;
  thread.push(time(() => void (entries = questionThread(edited.model.elements, "perf-q-2")?.entries.length ?? 0)));
  counts = { elements: Object.keys(next.elements).length, questions: anchors.length, sheets: sheets.length, refiledOnAnswer: questionIndexStats(next.elements).filed - before, holdsFound: found, threadEntries: entries };
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "questions", metrics: { "questions.add.500": row(add), "questions.open_for.10k": row(openFor), "questions.answer.edit": row(answer), "questions.issue_holds.sheets": row(holds), "questions.register": row(register), "question.thread.read": row(thread) }, counts }, null, 2)}\n`);
const c = { totalElements: counts.elements, affectedElements: counts.refiledOnAnswer };
emit({
  suite: "batch",
  workload: { questions: "500 on the synthetic tower, 50 holding the issue, 14 plan sheets", samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: "questions.add.500", values: add, counts: c, note: "Three add_question commands pinning 500 questions." },
    { metric: "questions.open_for.10k", values: openFor, counts: c, note: "10,000 'what is open on this element' reads." },
    { metric: "questions.answer.edit", values: answer, counts: c, note: "Answer one question, advance the index by its id, read it back." },
    { metric: "questions.issue_holds.sheets", values: holds, counts: c, note: "What holds each of the 14 plan sheets." },
    { metric: "questions.register", values: register, counts: c, note: "Every question on a new revision after one answer (the index advanced by id)." },
    { metric: "question.thread.read", values: thread, counts: c, note: "One question's thread with 200 replies, first read on a new revision." },
  ],
});
