import { authorWords, parseAgentSubject } from "../authorship/author";
import type { AuthorRef } from "../authorship/types";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import type { BimElement, ElementId } from "../types";
import { recordValidity, type Validity } from "../validity";
import { questionAt } from "./element";
import { questionAnswersIn, questionRepliesIn, type QuestionAnswerElement, type QuestionReplyElement } from "./records";
import type { Question, QuestionStatus } from "./types";

/**
 * A question's thread (round 9, `questions:threads`): the question, every
 * answer and every reply, oldest first, like a conversation. Anyone may reply
 * at any time; nobody is obliged to. A reply never closes or reopens a
 * question by itself (`REPLY_REOPENS`); only the asker reopens a declined or
 * not-in-scope one (`mayAskAgain`).
 *
 * Reads go through a per-snapshot index: one kind read of answers and
 * replies per model revision, then a map lookup per question.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** The product owner's choice (round 9, question 1): a reply on a declined or not-in-scope question keeps it as it is; only Ask again reopens it. */
export const REPLY_REOPENS = false;

/** Statuses only the asker may move back to open (round 9, question 2). */
export const ASKER_ONLY_REOPEN: ReadonlySet<QuestionStatus> = new Set<QuestionStatus>(["declined", "not_in_scope"]);

export type QuestionThreadEntry =
  | { readonly kind: "answer"; readonly id: ElementId; readonly at: string; readonly record: QuestionAnswerElement }
  | { readonly kind: "reply"; readonly id: ElementId; readonly at: string; readonly record: QuestionReplyElement };

export interface QuestionThread {
  readonly question: Question;
  /** Answers and replies, oldest first (then by id, so the order never depends on storage). */
  readonly entries: readonly QuestionThreadEntry[];
}

const threads = new WeakMap<Elements, Map<string, QuestionThreadEntry[]>>();

function threadIndex(elements: Elements): Map<string, QuestionThreadEntry[]> {
  const hit = threads.get(elements);
  if (hit) return hit;
  const byQuestion = new Map<string, QuestionThreadEntry[]>();
  const add = (questionId: string, entry: QuestionThreadEntry) => {
    const list = byQuestion.get(questionId);
    if (list) list.push(entry);
    else byQuestion.set(questionId, [entry]);
  };
  for (const a of questionAnswersIn(elements)) add(a.answer.questionId, { kind: "answer", id: a.id, at: a.answer.at, record: a });
  for (const r of questionRepliesIn(elements)) add(r.reply.questionId, { kind: "reply", id: r.id, at: r.reply.at, record: r });
  for (const list of byQuestion.values()) list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  threads.set(elements, byQuestion);
  return byQuestion;
}

/** The thread of one question, or null when `questionId` isn't a question. */
export function questionThread(elements: Elements, questionId: string): QuestionThread | null {
  const question = questionAt(elements, questionId);
  if (!question) return null;
  return { question, entries: threadIndex(elements).get(question.id) ?? [] };
}

/** How many answers and replies each question has, for a list (one index read). */
export function threadSize(elements: Elements, questionId: string): number {
  return threadIndex(elements).get(questionId)?.length ?? 0;
}

/** The next free id for a thread record of `questionId` (`<question>.reply.<n>`, `<question>.answer.<n>`): deterministic, so a re-run of the same command makes the same id. */
export function nextThreadRecordId(elements: Elements, questionId: string, what: "reply" | "answer"): ElementId {
  let n = (threadIndex(elements).get(questionId)?.length ?? 0) + 1;
  while (elements[`${questionId}.${what}.${n}`] !== undefined) n += 1;
  return `${questionId}.${what}.${n}` as ElementId;
}

// ---------------------------------------------------------------- who

/** The person an author stands for: the author when a person, the person an agent acted for. */
export function personOf(author: AuthorRef): AuthorRef | null {
  if (author.kind === "person") return author;
  if (author.onBehalfOf?.kind === "person") return author.onBehalfOf;
  const parsed = parseAgentSubject(author.subject);
  return parsed ? { provider: author.provider, subject: parsed.personSubject, kind: "person" } : null;
}

/**
 * Whether two authors stand for the same person. Subjects must match; the
 * providers must too, unless one of them is the placeholder a session with
 * no named identity provider writes (`unsigned`): the model server checks
 * every actor id against the connection, so the subject is the trust anchor.
 */
export function samePerson(a: AuthorRef, b: AuthorRef): boolean {
  const pa = personOf(a);
  const pb = personOf(b);
  if (!pa || !pb || pa.subject !== pb.subject) return false;
  return pa.provider === pb.provider || pa.provider === UNSIGNED_PROVIDER_ID || pb.provider === UNSIGNED_PROVIDER_ID;
}

/** Whether `author` asked `question` (the asker, or an agent acting for the asker). False when nobody recorded who asked. */
export function isAsker(question: Question, author: AuthorRef): boolean {
  return question.askedByAuthor !== undefined && samePerson(question.askedByAuthor, author);
}

/** Who carries the question now: the owner after a Take over, else whoever asked. */
export function ownerOf(question: Question): AuthorRef | undefined {
  return question.ownerAuthor ?? question.askedByAuthor;
}

/** Whether `author` carries `question` now (the owner, or an agent acting for the owner). */
export function isOwner(question: Question, author: AuthorRef): boolean {
  const owner = ownerOf(question);
  return owner !== undefined && samePerson(owner, author);
}

/** The owner's name, for words. */
export function ownerWords(question: Question): string | null {
  const owner = question.ownerAuthor;
  if (owner) return personOf(owner)?.displayName ?? authorWords(owner);
  return askerWords(question);
}

/** The asker's name, for words ("J. Rao"). */
export function askerWords(question: Question): string | null {
  if (question.askedByAuthor) {
    const person = personOf(question.askedByAuthor);
    return person?.displayName ?? authorWords(question.askedByAuthor);
  }
  return question.askedBy ?? null;
}

/**
 * Whether `author` may ask `question` again. Kept closed: nobody (ask a new
 * question; it links back). Declined and not in scope: only the owner (whoever
 * asked, or whoever took it over), or an agent for them; a question asked
 * before round 9 has no recorded asker and keeps the old rule. Answered and
 * withdrawn: anyone who may edit, as before.
 */
export function mayAskAgain(question: Question, author: AuthorRef | null): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (question.keptClosed) {
    const by = personOf(question.keptClosed.by)?.displayName ?? authorWords(question.keptClosed.by);
    return { ok: false, reason: `${by} closed this and kept it closed: '${question.keptClosed.reason}'. Ask a new question instead; it links back to this one` };
  }
  const owner = ownerOf(question);
  if (!ASKER_ONLY_REOPEN.has(question.status) || !owner) return { ok: true };
  if (author && samePerson(owner, author)) return { ok: true };
  const who = ownerWords(question) ?? "the person who asked";
  return { ok: false, reason: question.ownerAuthor ? `Only ${who}, who carries this question now, can ask again` : `Only ${who}, who asked, can ask again` };
}

/**
 * Whether a question's latest answer still holds (temporal validity): "May no
 * longer hold — Room 104 changed in Rev 52" once something it relied on
 * changed. Nothing reopens: the question stays answered and says so.
 */
export function answerValidity(elements: Elements, questionId: string): Validity {
  const answers = (threadIndex(elements).get(questionId) ?? []).filter((e) => e.kind === "answer");
  const latest = answers.at(-1);
  return latest ? recordValidity(elements, latest.id) : { state: "holds" };
}
