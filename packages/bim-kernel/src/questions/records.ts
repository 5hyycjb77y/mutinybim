import { readAuthorRef } from "../authorship/author";
import type { AuthorRef } from "../authorship/types";
import type { ReadResult } from "../graph/records";
import { peerReads } from "../elements/feature";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, ModelElementBase } from "../types";
import { isCommercialWord, type QuestionOutcomeLinkKind } from "./outcomes";
import { readReliance, registerRelianceSource, type Reliance } from "../validity";
import type { Question, QuestionExternalRef, QuestionParty, QuestionStatus } from "./types";

/**
 * Question, answer and reply records as this release reads them.
 *
 * Readers are tolerant: a field, type, status, outcome or link kind this
 * release doesn't know is kept (the stored record is returned as it was,
 * never rewritten here), and a record that isn't one at all is refused with
 * the reason. Writers are strict and write only to peers that read the
 * shape: `question_answer` records when the peers advertise
 * `questions:answers`, `question_reply` records, authors and the declined
 * and not-in-scope statuses when they advertise `questions:threads`. An
 * older peer keeps every record it doesn't write untouched (round 8's
 * `x10-question-submittal-roundtrip`).
 */

/** Peers that read and store `question_answer` records and the reserved question fields (reserved in 1.5.0, advertised from round 9). */
export const QUESTION_ANSWERS_FEATURE = "questions:answers";

/**
 * Peers that read and store question threads (round 9): `question_reply`
 * records, `AuthorRef` on questions, answers and replies, the declined and
 * not-in-scope statuses, and asker-only Ask again.
 */
export const QUESTION_THREADS_FEATURE = "questions:threads";

/**
 * Peers that read and store question custody (round 9): the owner (Take
 * over), former addressees (Forward), kept-closed questions and the link a
 * new question keeps to the closed one it asks again, and their events.
 */
export const QUESTION_CUSTODY_FEATURE = "questions:custody";

/** The record kind, as the store's kind index keys it. Outside the element union: the store indexes any kind string. */
export const QUESTION_ANSWER_KIND = "question_answer";

/** A reply in a question's thread: any party, any time, never an answer (round 9). */
export const QUESTION_REPLY_KIND = "question_reply";

/** What an answer links to: a model thing, never anything commercial. */
export interface QuestionOutcomeLink {
  readonly kind: QuestionOutcomeLinkKind;
  /** A determination id, a revision range ("12..14"), a branch id, or a workflow's own model-side ref. */
  readonly ref: string;
}

export interface QuestionAnswerBody {
  readonly questionId: ElementId;
  /** What was said. */
  readonly text: string;
  /** Who answered, in words. Kept on every answer so a peer without threads still reads it. */
  readonly by: string;
  /** Who answered (round 9): the person, or an agent acting for one. Absent on older answers; `by` still reads. */
  readonly author?: AuthorRef;
  /** What the answer relied on at the revision it was given (round 9, `validity:reliance`): it "may no longer hold" once that changes. */
  readonly reliance?: Reliance;
  /** When, ISO 8601. */
  readonly at: string;
  /** A `QUESTION_OUTCOME_POINT` id. Readers keep an id this release doesn't know. */
  readonly outcome: string;
  readonly links?: readonly QuestionOutcomeLink[];
  readonly externalRefs?: readonly QuestionExternalRef[];
}

/** One answer to one question. A question may collect several (a clarification, then a decision). */
export interface QuestionAnswerElement extends ModelElementBase {
  readonly kind: typeof QUESTION_ANSWER_KIND;
  readonly answer: QuestionAnswerBody;
  readonly schemaVersion?: number;
}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function bad<T>(reason: string): ReadResult<T> {
  return { ok: false, reason };
}

function refsOk(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((r) => isRecord(r) && isText(r.provider) && isText(r.ref)));
}

/**
 * A stored question, checked; unknown fields, types and statuses kept. The
 * shape check is the one every reader of a question needs: an id, text, an
 * audience, a status and an anchor with an element list.
 */
export function readQuestionRecord(raw: unknown): ReadResult<Question> {
  if (!isRecord(raw) || raw.kind !== "question") return bad("a question record must be an object of kind question");
  if (!isText(raw.id)) return bad("a question needs an id");
  if (!isText(raw.text)) return bad("a question needs its text");
  if (!isText(raw.askOf)) return bad("a question needs who it is asked of");
  if (!isText(raw.status)) return bad("a question needs a status");
  if (!isText(raw.type)) return bad("a question needs a type");
  const anchor = raw.anchor;
  if (!isRecord(anchor) || !Array.isArray(anchor.elementIds)) return bad("a question needs an anchor with its element list");
  if (anchor.requirementRefs !== undefined && !(Array.isArray(anchor.requirementRefs) && anchor.requirementRefs.every(isText))) return bad("a question's requirement references must be a list of names");
  if (anchor.documentRefs !== undefined && !(Array.isArray(anchor.documentRefs) && anchor.documentRefs.every((d) => isRecord(d) && isText(d.kind) && isText(d.id)))) return bad("a question's drawing references each need a kind and an id");
  if (raw.askedBy !== undefined && !isText(raw.askedBy)) return bad("who asked a question must be text");
  if (!refsOk(raw.externalRefs)) return bad("a question's outside references each need a provider and a ref");
  // Checked above; the stored record is returned as it was.
  return { ok: true, value: raw as unknown as Question };
}

/**
 * A stored answer body, checked; unknown fields, outcomes and link kinds kept.
 * A link to anything commercial is refused: an answer never links a change
 * order or a price.
 */
export function readQuestionAnswerBody(raw: unknown): ReadResult<QuestionAnswerBody> {
  if (!isRecord(raw)) return bad("an answer must be an object");
  if (!isText(raw.questionId)) return bad("an answer needs the question it answers");
  if (typeof raw.text !== "string") return bad("an answer needs its text");
  if (!isText(raw.by) || !isText(raw.at)) return bad("an answer needs who answered and when");
  if (!isText(raw.outcome)) return bad("an answer needs an outcome");
  if (isCommercialWord(raw.outcome)) return bad("an answer's outcome can't be commercial; an answer never links a change order or a price");
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) return bad("an answer's links must be a list");
    for (const l of raw.links) {
      if (!isRecord(l) || !isText(l.kind) || !isText(l.ref)) return bad("each of an answer's links needs a kind and a ref");
      if (isCommercialWord(l.kind)) return bad(`an answer can't link "${l.kind}"; an answer never links a change order or a price`);
    }
  }
  if (!refsOk(raw.externalRefs)) return bad("an answer's outside references each need a provider and a ref");
  if (raw.author !== undefined && !readAuthorRef(raw.author).ok) return bad("who answered must name an author");
  return { ok: true, value: raw as unknown as QuestionAnswerBody };
}

/** Stored records are immutable: a record checked once stays checked while the model keeps the same object. */
const checked = new WeakMap<object, boolean>();

function checkedOnce(el: object, check: () => boolean): boolean {
  const hit = checked.get(el);
  if (hit !== undefined) return hit;
  const ok = check();
  checked.set(el, ok);
  return ok;
}

export function isQuestionAnswerRecord(el: { readonly kind: string } | undefined): el is QuestionAnswerElement {
  return el !== undefined && el.kind === QUESTION_ANSWER_KIND && checkedOnce(el, () => readQuestionAnswerBody((el as unknown as Raw).answer).ok);
}

/** The kind key for the store's index: a plain kind string until the element union carries it. */
const ANSWER_KIND_KEY = QUESTION_ANSWER_KIND as string as BimElement["kind"];

/** Every answer stored in the model, from the store's kind index (the matches, not a pass over the model). */
export function questionAnswersIn(elements: Readonly<Record<string, BimElement>>): QuestionAnswerElement[] {
  const out: QuestionAnswerElement[] = [];
  for (const el of elementsOfKind(elements, ANSWER_KIND_KEY)) {
    const candidate: { readonly kind: string } = el;
    if (isQuestionAnswerRecord(candidate)) out.push(candidate);
  }
  return out;
}

/** The answers to one question, oldest first. */
export function answersTo(elements: Readonly<Record<string, BimElement>>, questionId: string): QuestionAnswerElement[] {
  return questionAnswersIn(elements)
    .filter((a) => a.answer.questionId === questionId)
    .sort((a, b) => a.answer.at.localeCompare(b.answer.at));
}

/** Whether the command being decided may store an answer record: the peers read `questions:answers` (never inside undo, never outside a host's policy). */
export function questionAnswersWritable(): boolean {
  return peerReads(QUESTION_ANSWERS_FEATURE);
}

/** Whether the command being decided may store replies, authors and the declined statuses: the peers read `questions:threads`. */
export function questionThreadsWritable(): boolean {
  return peerReads(QUESTION_THREADS_FEATURE);
}

/** Whether the command being decided may store owners, forwards and kept-closed questions: the peers read `questions:custody`. */
export function questionCustodyWritable(): boolean {
  return peerReads(QUESTION_CUSTODY_FEATURE);
}

// ---------------------------------------------------------------- replies

/** A status change a reply records: who declined, marked not in scope, asked again or withdrew, with their note as the reply's text. */
export interface QuestionStatusChange {
  readonly to: QuestionStatus;
}

/**
 * Something that happened to a question besides its status, recorded in the
 * thread: Take over, Forward, Kept closed. Open: a workflow may record its
 * own kinds; readers show a kind they don't know in its own words.
 */
export interface QuestionEvent {
  readonly kind: "took_over" | "forwarded" | "kept_closed" | (string & {});
  /** Take over: the owner before. Forward: the addressee before. */
  readonly from?: QuestionParty;
  /** Forward: the new addressee. Take over: the new owner. */
  readonly to?: QuestionParty;
  /** Kept closed: why. */
  readonly reason?: string;
}

export interface QuestionReplyBody {
  readonly questionId: ElementId;
  /** What was said; may be empty only on a status change with no note. */
  readonly text: string;
  readonly author: AuthorRef;
  /** When, ISO 8601. */
  readonly at: string;
  /** Present when the reply records a status change (Decline, Not in scope, Ask again, Withdraw). */
  readonly statusChange?: QuestionStatusChange;
  /** Present when the reply records Take over, Forward or Kept closed. */
  readonly event?: QuestionEvent;
  readonly externalRefs?: readonly QuestionExternalRef[];
}

export interface QuestionReplyElement extends ModelElementBase {
  readonly kind: typeof QUESTION_REPLY_KIND;
  readonly reply: QuestionReplyBody;
  readonly schemaVersion?: number;
}

/** A stored reply body, checked; unknown fields and statuses kept. */
export function readQuestionReplyBody(raw: unknown): ReadResult<QuestionReplyBody> {
  if (!isRecord(raw)) return bad("a reply must be an object");
  if (!isText(raw.questionId)) return bad("a reply needs the question it belongs to");
  if (typeof raw.text !== "string") return bad("a reply needs its text");
  if (!isText(raw.at)) return bad("a reply needs when it was said");
  if (!readAuthorRef(raw.author).ok) return bad("a reply needs who said it");
  const change = raw.statusChange;
  if (change !== undefined && (!isRecord(change) || !isText(change.to))) return bad("a reply's status change needs the status it moved to");
  const event = raw.event;
  if (event !== undefined && (!isRecord(event) || !isText(event.kind))) return bad("a reply's event needs its kind");
  if (change === undefined && event === undefined && !isText(raw.text)) return bad("a reply needs its text");
  if (!refsOk(raw.externalRefs)) return bad("a reply's outside references each need a provider and a ref");
  return { ok: true, value: raw as unknown as QuestionReplyBody };
}

export function isQuestionReplyRecord(el: { readonly kind: string } | undefined): el is QuestionReplyElement {
  return el !== undefined && el.kind === QUESTION_REPLY_KIND && checkedOnce(el, () => readQuestionReplyBody((el as unknown as Raw).reply).ok);
}

const REPLY_KIND_KEY = QUESTION_REPLY_KIND as string as BimElement["kind"];

/** Every reply stored in the model, from the store's kind index. */
export function questionRepliesIn(elements: Readonly<Record<string, BimElement>>): QuestionReplyElement[] {
  const out: QuestionReplyElement[] = [];
  for (const el of elementsOfKind(elements, REPLY_KIND_KEY)) {
    const candidate: { readonly kind: string } = el;
    if (isQuestionReplyRecord(candidate)) out.push(candidate);
  }
  return out;
}

// Answers rely on what the model said when they were given (validity/).
registerRelianceSource({
  name: QUESTION_ANSWER_KIND,
  kinds: [QUESTION_ANSWER_KIND],
  relianceOf: (el) => {
    const candidate: { readonly kind: string } = el;
    return isQuestionAnswerRecord(candidate) ? readReliance(candidate.answer.reliance) : null;
  },
});
