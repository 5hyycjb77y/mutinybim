import type { BimElement, ElementId } from "../types";
import { readReliance, validityOf, type Reliance } from "../validity";
import { questionAnswersIn } from "./records";

/**
 * Which answers one saved edit made stale (round 10, lane Q10).
 *
 * The page hook in a host tells the asker and owner when an answer stops
 * holding while someone has the model open. An agent's edit may land with
 * nobody looking; the host's apply path calls this with the model before and
 * after the edit and the ids the edit changed, and tells them once.
 *
 * Only the changed ids are looked at. An agent session often loads one area
 * of the model, so an element the answer relied on that simply isn't loaded
 * must never read as "removed": facts outside `changedIds` are not checked.
 * An answer counts only when it held (for those facts) before the edit and
 * may not hold after it, so an answer already stale is never told twice by
 * this read (the host's notice key is the second guard).
 *
 * Cost: one per-snapshot index of answers by the ids they rely on (a kind
 * read of answers, once per head), then a map lookup per changed id and a
 * check of the facts those answers share with the edit.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface AnswerMadeStale {
  readonly answerId: ElementId;
  readonly questionId: ElementId;
  /** "May no longer hold — Room 104 changed in Rev 52". */
  readonly words: string;
  /** The answer's whole reliance digest: the same key a page uses for the same answer. */
  readonly relianceDigest: string;
}

interface Filed {
  readonly questionId: ElementId;
  readonly reliance: Reliance;
}

const indexes = new WeakMap<Elements, { readonly byFact: ReadonlyMap<string, readonly ElementId[]>; readonly answers: ReadonlyMap<string, Filed> }>();

function answersByFact(elements: Elements) {
  const hit = indexes.get(elements);
  if (hit) return hit;
  const byFact = new Map<string, ElementId[]>();
  const answers = new Map<string, Filed>();
  for (const a of questionAnswersIn(elements)) {
    const reliance = readReliance(a.answer.reliance);
    if (!reliance) continue;
    answers.set(a.id, { questionId: a.answer.questionId, reliance });
    for (const f of reliance.facts) {
      const list = byFact.get(f.id);
      if (list) list.push(a.id);
      else byFact.set(f.id, [a.id]);
    }
  }
  const built = { byFact, answers };
  indexes.set(elements, built);
  return built;
}

/** Answers the edit from `before` to `after` made stale, ordered by answer id. Empty when the edit touched nothing an answer relied on. */
export function answersMadeStaleByEdit(before: Elements, after: Elements, changedIds: readonly string[]): AnswerMadeStale[] {
  if (changedIds.length === 0) return [];
  const { byFact, answers } = answersByFact(before);
  if (byFact.size === 0) return [];
  const changed = new Set(changedIds);
  const candidates = new Set<ElementId>();
  for (const id of changed) for (const answerId of byFact.get(id) ?? []) candidates.add(answerId);
  const out: AnswerMadeStale[] = [];
  for (const answerId of [...candidates].sort()) {
    // An answer the edit itself rewrote or removed is a new statement, not a stale one.
    if (changed.has(answerId)) continue;
    const filed = answers.get(answerId);
    if (!filed) continue;
    // Rules are the code-of-record check's business (a code change, not a model edit).
    const { rules: _rules, ...withoutRules } = filed.reliance;
    const touched: Reliance = { ...withoutRules, facts: filed.reliance.facts.filter((f) => changed.has(f.id)) };
    if (validityOf(before, touched).state !== "holds") continue;
    const now = validityOf(after, touched, before);
    if (now.state === "holds") continue;
    out.push({ answerId, questionId: filed.questionId, words: now.words, relianceDigest: filed.reliance.digest });
  }
  return out;
}
