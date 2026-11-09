import type { AuthorRef } from "../authorship/types";
import { peerReads } from "../elements/feature";
import type { BimElement, ElementId } from "../types";
import { questionThread } from "./thread";
import type { QuestionParty } from "./types";

/**
 * Forwarding a question to one named person (round 10, lane Q10).
 *
 * Round 9 forwarded a question to a party in words; the person picked from a
 * project's people now rides along as an `AuthorRef`, so the host can tell
 * exactly that person (and keep the thread readable for whoever it moved
 * away from). Peers that store the person on a forward advertise
 * `questions:forward_person`; a forward to a person is refused in plain words
 * on a peer without it ("forward to the party by name instead"), and an
 * older peer's own edits keep the stored person untouched (tolerant readers).
 *
 * Trade-neutral and host-neutral: who may be picked (the project's people)
 * and who may read the thread afterwards are the host's rules.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Peers that read and store a named person as a forward's new addressee (round 10). */
export const QUESTION_FORWARD_PERSON_FEATURE = "questions:forward_person";

/** Whether the command being decided may store a named person on a forward: the peers read `questions:forward_person`. */
export function questionForwardPersonWritable(): boolean {
  return peerReads(QUESTION_FORWARD_PERSON_FEATURE);
}

/** One forward in a question's history: from whom, to whom, by whom and when, with the note. */
export interface QuestionForward {
  readonly questionId: ElementId;
  /** The reply record that holds the forward event. */
  readonly recordId: ElementId;
  /** Whom it was asked of before (words, and the person when it was one). */
  readonly from: QuestionParty | null;
  /** Whom it is asked of from then on. */
  readonly to: QuestionParty | null;
  /** Who forwarded it (an agent carries the person it acted for). */
  readonly by: AuthorRef;
  readonly at: string;
  readonly note: string;
}

/** Every forward of one question, oldest first (from its thread's events; no model scan). Empty when it isn't a question or was never forwarded. */
export function questionForwards(elements: Elements, questionId: string): QuestionForward[] {
  const thread = questionThread(elements, questionId);
  if (!thread) return [];
  const out: QuestionForward[] = [];
  for (const e of thread.entries) {
    if (e.kind !== "reply") continue;
    const r = e.record.reply;
    if (r.event?.kind !== "forwarded") continue;
    out.push({ questionId: thread.question.id, recordId: e.id, from: r.event.from ?? null, to: r.event.to ?? null, by: r.author, at: r.at, note: r.text });
  }
  return out;
}

/**
 * The people a question is or was asked of, by identity: the current
 * addressee first, then every former one (oldest first), each once. Parties
 * named only in words are left out (there is no one to identify). A host
 * uses this to decide who keeps reading the thread after it moves on.
 */
export function questionAddresseePeople(elements: Elements, questionId: string): AuthorRef[] {
  const q = questionThread(elements, questionId)?.question;
  if (!q) return [];
  const seen = new Set<string>();
  const out: AuthorRef[] = [];
  const add = (a: AuthorRef | undefined) => {
    if (!a) return;
    const key = `${a.provider}\u0000${a.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };
  add(q.askOfAuthor);
  for (const p of q.formerAddressees ?? []) add(p.author);
  return out;
}
