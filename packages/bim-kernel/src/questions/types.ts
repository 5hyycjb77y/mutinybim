import type { AuthorRef } from "../authorship/types";
import type { AuthoredRevisions, ElementId, Partition, Vec2 } from "../types";

/**
 * Questions and assumptions pinned to the model (KERNEL-REQUIREMENTS-MODEL
 * §3.7, ROADMAP F7). The pink and magenta notes on a drawing ("IS THERE A BEAM
 * HERE? PLEASE CONFIRM", "Tie into existing 4" sanitary, contractor to verify
 * invert") become objects that know what they point at, who they are for and
 * whether they are still open.
 *
 * Trade-neutral: a question points at element ids and/or a point on a level,
 * whatever those elements are. The kernel never knows about email, meetings or
 * markups: `externalRefs` are opaque pairs a host resolves (for example a
 * thread, a meeting session and time, a markup session).
 */

/** A question to someone; an assumption the design proceeds on; something to check on site. */
export type KnownQuestionType = "question" | "assumption" | "field_verify";

/**
 * Open (contract 1.5.0): a workflow adds its own types (a formal RFI is one
 * of them). Readers keep a type they don't know; this release's commands
 * write only the known three.
 */
export type QuestionType = KnownQuestionType | (string & {});

export const QUESTION_TYPES = ["question", "assumption", "field_verify"] as const satisfies readonly KnownQuestionType[];

/**
 * open: asked; nobody is obliged to answer, and an open question is never
 * late unless a workflow sets a date of its own (in `externalRefs`).
 * answered: someone said. assumed: the design goes ahead on the stated
 * assumption (an assumption starts here). withdrawn: no longer asked; kept so
 * the history reads. declined: the person asked chose not to answer.
 * not_in_scope: the person asked says it isn't theirs to answer.
 *
 * `declined` and `not_in_scope` were reserved in contract 1.5.0; round 9's
 * `decline_question` writes them (peers with `questions:threads`). Neither
 * obliges anyone to answer.
 */
export type QuestionStatus = "open" | "answered" | "assumed" | "withdrawn" | "declined" | "not_in_scope";

export const QUESTION_STATUSES = ["open", "answered", "assumed", "withdrawn", "declined", "not_in_scope"] as const satisfies readonly QuestionStatus[];

/** Statuses that close a question without an answer from the model or a person's text. */
export const CLOSED_WITHOUT_ANSWER_STATUSES = ["withdrawn", "declined", "not_in_scope"] as const satisfies readonly QuestionStatus[];

/** The usual parties a question is for; a firm may type its own (`askOf` is any short text). */
export const NAMED_AUDIENCES = ["client", "architect", "structural", "contractor", "internal"] as const;

/**
 * A person or party, in words: one of `NAMED_AUDIENCES`, a firm's own party
 * ("owner's rep", "landlord") or a person ("J. Rao"). Any party may ask any
 * party, at any phase.
 */
export type QuestionAudience = string;

/** Where a document reference points: a sheet, a view, or a detail on a sheet. Open: readers keep a kind they don't know. */
export type QuestionDocumentKind = "sheet" | "view" | "detail" | (string & {});

/**
 * A drawing the question is about ("see detail 4 on M-501"). Sheets and views
 * are where a question shows, never what it is pinned to (`elementIds`), so a
 * document is named here instead.
 */
export interface QuestionDocumentRef {
  readonly kind: QuestionDocumentKind;
  /** The sheet or view element id. */
  readonly id: ElementId;
  /** The detail's mark on that sheet or view ("4"), for `kind: "detail"`. */
  readonly detail?: string;
}

/** A person or a party a question is addressed to: words always, the person's identity when it is one person. */
export interface QuestionParty {
  readonly label: string;
  readonly author?: AuthorRef;
}

export interface QuestionAnchor {
  /** The elements it is about (any kind). May be empty when it is pinned to a point only. */
  readonly elementIds: readonly ElementId[];
  /** A point on a level, mm, for "is there a beam here?" over empty floor. */
  readonly point?: { readonly levelId: ElementId; readonly position: Vec2 };
  /**
   * Requirements it is about: requirement keys or `requirement_state` ids of
   * the requirements graph. Reserved (contract 1.5.0): readers keep them; no
   * command of this release writes them.
   */
  readonly requirementRefs?: readonly string[];
  /** Sheets, views and details it is about. Reserved like `requirementRefs`. */
  readonly documentRefs?: readonly QuestionDocumentRef[];
}

/**
 * The model value that would answer the question, when there is one: "what is
 * the gas pressure at the meter?" is answered once the meter's `values.pressure`
 * holds a value. The rule is deliberately small: the field is present and not
 * empty. Questions without it are never treated as answered by the model.
 */
export interface QuestionAnsweredBy {
  readonly elementId: ElementId;
  /** `values.<name>` on a part (an instance value), or a plain scalar field on the element (`mark`, `typeName`, `name`). */
  readonly field: string;
}

/**
 * Opaque to the kernel: the host decides what `provider` and `ref` mean. A
 * workflow's own fields (its number, routing, dates, contract terms) live in
 * the host behind one of these, never on the question.
 */
export interface QuestionExternalRef {
  readonly provider: string;
  readonly ref: string;
}

export interface Question {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
  readonly kind: "question";
  readonly type: QuestionType;
  /**
   * The model's short label, shown everywhere a person reads it: "Q-3". Unique
   * in the model; assigned in order when not typed. Not a workflow's number:
   * a formal RFI's number is the host's (`externalRefs`).
   */
  readonly number: string;
  readonly anchor: QuestionAnchor;
  readonly text: string;
  readonly askOf: QuestionAudience;
  /** Who asked, in words ("J. Rao"). Written from `askedByAuthor` since round 9; older questions may carry a party's name or nothing. */
  readonly askedBy?: QuestionAudience;
  /**
   * Who asked (round 9, `questions:threads`): the person, or an agent acting
   * for one. Only that person (or an agent for them) may ask again once the
   * question is declined or not in scope. Absent on questions asked before.
   */
  readonly askedByAuthor?: AuthorRef;
  /** The one person it is asked of, when it is a person rather than a party (round 9). `askOf` keeps the words. */
  readonly askOfAuthor?: AuthorRef;
  /**
   * Who carries the question now (round 9, `questions:custody`): set by Take
   * over. Absent: whoever asked. The owner, not the original author,
   * controls Ask again; the original author stays in the history.
   */
  readonly ownerAuthor?: AuthorRef;
  /** Whom it was asked of before it was forwarded, oldest first. They keep the thread and still hear about it. */
  readonly formerAddressees?: readonly QuestionParty[];
  /** Closed and kept closed by whoever closed it: Ask again is refused; asking anew makes a new question that links back. */
  readonly keptClosed?: { readonly by: AuthorRef; readonly reason: string; readonly at: string };
  /** The closed question this one asks again ("Asked before: Q-12, closed: not in scope"). */
  readonly askedBefore?: ElementId;
  readonly status: QuestionStatus;
  /** What was said (answered) or the assumption the design goes ahead on (assumed). */
  readonly answer?: string;
  /** Opt-in, set by a person or a workflow: an open one holds the issue of any sheet that shows what it points at. */
  readonly blocksIssue?: boolean;
  /** Opt-in, set by a person or a workflow: the phase it is wanted by ("DD"). Absent: nobody set one, and nothing treats it as late. */
  readonly closeBy?: string;
  readonly answeredBy?: QuestionAnsweredBy;
  readonly externalRefs?: readonly QuestionExternalRef[];
}
