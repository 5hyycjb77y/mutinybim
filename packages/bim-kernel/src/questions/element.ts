import { canonicalJson } from "../canonical";
import { elementsOfKind } from "../store";
import type { BimElement } from "../types";
import type { Question } from "./types";

/**
 * The one seam between questions and the element store. Everything else in
 * this folder reads and writes questions through these three names, so the
 * module compiles and runs the same before and after "question" joins the
 * kernel's element union (`types.ts`, `registry/element-kinds.ts`; see
 * the internal design note). At runtime the store indexes any
 * kind string, so nothing here changes behaviour when the union widens.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** The element kind, as the store's kind index keys it. */
export const QUESTION_KIND = "question";

/** `elementsOfKind` takes a member of the element union; "question" is one once registered, a plain kind key until then. */
const QUESTION_KIND_KEY = QUESTION_KIND as string as BimElement["kind"];

export function isQuestion(el: { readonly kind: string } | undefined): el is Question {
  return el !== undefined && el.kind === QUESTION_KIND;
}

/** Every question in the model, from the store's kind index (the matches, not a pass over the model). */
export function questionsIn(elements: Elements): Question[] {
  const out: Question[] = [];
  for (const el of elementsOfKind(elements, QUESTION_KIND_KEY)) if (isQuestion(el)) out.push(el);
  return out;
}

/** The question stored under `id`, if that id is one. */
export function questionAt(elements: Elements, id: string): Question | undefined {
  const el: { readonly kind: string } | undefined = elements[id];
  return isQuestion(el) ? el : undefined;
}

/** Write a question into a command's working copy (a record of elements accepts its own kind's values). */
export function putQuestion(working: Record<string, BimElement | Question>, q: Question): void {
  working[q.id] = q;
}

/**
 * What undo and conflict checks compare on a question (authored field
 * "question"): everything a person set, without the bookkeeping.
 */
export const QUESTION_FIELD = "question";

export function questionFingerprint(q: Question): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = q;
  return canonicalJson(rest);
}
