import type { BimElement, ElementId } from "../types";
import { isQuestion, questionsIn } from "./element";
import type { Question, QuestionStatus } from "./types";

/**
 * Where questions are: by the element they point at, by status, by the level
 * their point is on, and the open ones that hold an issue. "Is anything open
 * on these elements?" reads a few set entries, never every question and never
 * the model.
 *
 * Incremental, like the space index: one index follows a model as it changes.
 * Asking about a new revision compares the questions (a kind-index read: the
 * matches, not the model) with what the index holds by identity and re-files
 * only the ones that changed. `advanceQuestionIndex` takes a command's changed
 * and removed ids directly: O(changed), no kind read at all.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface QuestionIndexStats {
  /** Questions filed since the index was made (all once, then only what changed). */
  readonly filed: number;
  readonly syncs: number;
}

class QuestionIndexState {
  bound: Elements;
  readonly questions = new Map<ElementId, Question>();
  readonly byElement = new Map<ElementId, Set<ElementId>>();
  readonly byStatus = new Map<QuestionStatus, Set<ElementId>>();
  readonly byPointLevel = new Map<ElementId, Set<ElementId>>();
  readonly blockingOpen = new Set<ElementId>();
  readonly compareQuestionNumbers = new Map<string, ElementId>();
  filed = 0;
  syncs = 0;

  constructor(elements: Elements) {
    this.bound = elements;
  }
}

const byElements = new WeakMap<Elements, QuestionIndexState>();
/** The index most recently synced, which the next revision is diffed from. */
let latest: QuestionIndexState | null = null;

function addTo<K>(map: Map<K, Set<ElementId>>, key: K, id: ElementId): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function unfile(state: QuestionIndexState, q: Question): void {
  for (const e of q.anchor.elementIds) state.byElement.get(e)?.delete(q.id);
  state.byStatus.get(q.status)?.delete(q.id);
  if (q.anchor.point) state.byPointLevel.get(q.anchor.point.levelId)?.delete(q.id);
  state.blockingOpen.delete(q.id);
  if (state.compareQuestionNumbers.get(numberKey(q.number)) === q.id) state.compareQuestionNumbers.delete(numberKey(q.number));
}

function file(state: QuestionIndexState, q: Question): void {
  const prior = state.questions.get(q.id);
  if (prior) unfile(state, prior);
  state.filed += 1;
  state.questions.set(q.id, q);
  for (const e of q.anchor.elementIds) addTo(state.byElement, e, q.id);
  addTo(state.byStatus, q.status, q.id);
  if (q.anchor.point) addTo(state.byPointLevel, q.anchor.point.levelId, q.id);
  if (q.status === "open" && q.blocksIssue === true) state.blockingOpen.add(q.id);
  state.compareQuestionNumbers.set(numberKey(q.number), q.id);
}

function forget(state: QuestionIndexState, id: ElementId): void {
  const prior = state.questions.get(id);
  if (!prior) return;
  unfile(state, prior);
  state.questions.delete(id);
}

function rebind(state: QuestionIndexState, elements: Elements): void {
  if (state.bound !== elements) byElements.delete(state.bound);
  state.bound = elements;
  byElements.set(elements, state);
  latest = state;
}

function sync(state: QuestionIndexState, elements: Elements): void {
  state.syncs += 1;
  const seen = new Set<ElementId>();
  for (const q of questionsIn(elements)) {
    seen.add(q.id);
    if (state.questions.get(q.id) !== q) file(state, q);
  }
  for (const id of [...state.questions.keys()]) if (!seen.has(id)) forget(state, id);
  rebind(state, elements);
}

function indexFor(elements: Elements): QuestionIndexState {
  const hit = byElements.get(elements);
  if (hit && hit.bound === elements) return hit;
  const state = latest ?? new QuestionIndexState(elements);
  sync(state, elements);
  return state;
}

/** Move an index along by the ids a command changed or removed (an `ExecuteOk`'s `changedIds` / `removedIds`). */
export function advanceQuestionIndex(previous: Elements, next: Elements, changedIds: readonly ElementId[], removedIds: readonly ElementId[]): void {
  const state = byElements.get(previous);
  if (!state || state.bound !== previous) {
    indexFor(next);
    return;
  }
  state.syncs += 1;
  for (const id of [...changedIds, ...removedIds]) {
    const el: { readonly kind: string } | undefined = next[id];
    if (isQuestion(el)) file(state, el);
    else forget(state, id);
  }
  rebind(state, next);
}

function pick(state: QuestionIndexState, ids: Iterable<ElementId> | undefined): Question[] {
  const out: Question[] = [];
  if (!ids) return out;
  for (const id of ids) {
    const q = state.questions.get(id);
    if (q) out.push(q);
  }
  return out.sort(compareQuestionNumbers);
}

/** Q-2 before Q-10; then by id so the order never depends on insertion. */
export function compareQuestionNumbers(a: Question, b: Question): number {
  return a.number.localeCompare(b.number, "en", { numeric: true }) || a.id.localeCompare(b.id);
}

function numberKey(n: string): string {
  return n.trim().toLowerCase();
}

// ---------------------------------------------------------------- reads

export function allQuestions(elements: Elements): Question[] {
  const state = indexFor(elements);
  return pick(state, state.questions.keys());
}

/** Questions that point at any of these elements, any status. */
export function questionsOnElements(elements: Elements, elementIds: Iterable<ElementId>): Question[] {
  const state = indexFor(elements);
  const ids = new Set<ElementId>();
  for (const e of elementIds) for (const q of state.byElement.get(e) ?? []) ids.add(q);
  return pick(state, ids);
}

export function questionsWithStatus(elements: Elements, ...statuses: readonly QuestionStatus[]): Question[] {
  const state = indexFor(elements);
  const ids = new Set<ElementId>();
  for (const s of statuses) for (const q of state.byStatus.get(s) ?? []) ids.add(q);
  return pick(state, ids);
}

/** Questions pinned to a point on this level (element-anchored ones follow their elements). */
export function questionsAtPointsOn(elements: Elements, levelId: ElementId): Question[] {
  const state = indexFor(elements);
  return pick(state, state.byPointLevel.get(levelId));
}

/** Open questions marked to hold the issue. */
export function blockingOpenQuestions(elements: Elements): Question[] {
  const state = indexFor(elements);
  return pick(state, state.blockingOpen);
}

/** The question with this number ("q-3" finds "Q-3"). */
export function questionByNumber(elements: Elements, number: string): Question | undefined {
  const state = indexFor(elements);
  const id = state.compareQuestionNumbers.get(numberKey(number));
  return id ? state.questions.get(id) : undefined;
}

/** The next free "Q-n": one past the highest numbered "Q-<n>" in the model. */
export function nextQuestionNumber(elements: Elements): string {
  const state = indexFor(elements);
  let max = 0;
  for (const key of state.compareQuestionNumbers.keys()) {
    const m = /^q-(\d+)$/.exec(key);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `Q-${max + 1}`;
}

export function questionIndexStats(elements: Elements): QuestionIndexStats {
  const state = indexFor(elements);
  return { filed: state.filed, syncs: state.syncs };
}
