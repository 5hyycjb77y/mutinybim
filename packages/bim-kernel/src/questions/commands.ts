import { z } from "zod";
import { authorFromActor, authorWords, parseAgentSubject, PROVIDER_ID, writeAuthorRef } from "../authorship/author";
import { AuthorshipWriteError, type AuthorRef } from "../authorship/types";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { isQuestion, putQuestion, QUESTION_FIELD, questionFingerprint } from "./element";
import { listQuestionOutcomes, questionOutcomeDef } from "./outcomes";
import { nextQuestionNumber, questionByNumber } from "./question-index";
import { peerReads } from "../elements/feature";
import { relianceFor, VALIDITY_RELIANCE_FEATURE } from "../validity";
import { QUESTION_ANSWER_KIND, QUESTION_REPLY_KIND, questionAnswersWritable, questionCustodyWritable, questionThreadsWritable, readQuestionAnswerBody, type QuestionAnswerBody, type QuestionAnswerElement, type QuestionEvent, type QuestionOutcomeLink, type QuestionReplyBody, type QuestionReplyElement } from "./records";
import { mayAskAgain, nextThreadRecordId, ownerOf, samePerson } from "./thread";
import { questionForwardPersonWritable } from "./forward";
import { QUESTION_TYPES, type Question, type QuestionAnchor, type QuestionParty, type QuestionStatus } from "./types";

/**
 * Question and assumption edits: the one path the Questions list, the plan
 * pins and the agent tools all use. Every edit undoes as one step. Refusals
 * say in plain words what to do instead.
 */

const id = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const vec2 = z.object({ x: z.number().finite().min(-1e9).max(1e9), y: z.number().finite().min(-1e9).max(1e9) }).strict();

const anchorInput = z
  .object({
    elementIds: z.array(id).max(200).optional(),
    point: z.object({ levelId: id, position: vec2 }).strict().optional(),
  })
  .strict();

const answeredByInput = z
  .object({
    elementId: id,
    field: z.string().trim().regex(/^(values\.[A-Za-z0-9_ -]{1,80}|[A-Za-z][A-Za-z0-9_]{0,40})$/, "Name an instance value as values.<name>, or a plain field such as mark"),
  })
  .strict();

const externalRefInput = z.object({ provider: text(40).min(1), ref: text(400).min(1) }).strict();

/** When it was said, ISO 8601. The model server stamps its own time; this is for a host deciding outside one. */
const atInput = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, "Give the time as an ISO 8601 UTC time").optional();

/** The one person a question is asked of (round 9): their identity provider's id for them and their name. */
const askOfAuthorInput = z.object({ provider: z.string().trim().regex(PROVIDER_ID).max(64), subject: text(256).min(1), displayName: text(120).min(1).optional() }).strict();

const outcomeLinkInput = z.object({ kind: text(60).min(1), ref: text(200).min(1) }).strict();

const questionInput = z
  .object({
    /** Chosen by the sender so a retried request makes the same question, not a second one. */
    questionId: id,
    type: z.enum(QUESTION_TYPES).optional(),
    /** Absent: the next "Q-n". */
    number: text(20).min(1).optional(),
    text: text(1000).min(1),
    askOf: text(60).min(1),
    anchor: anchorInput,
    blocksIssue: z.boolean().optional(),
    closeBy: text(40).min(1).optional(),
    answeredBy: answeredByInput.optional(),
    externalRefs: z.array(externalRefInput).max(20).optional(),
    askOfAuthor: askOfAuthorInput.optional(),
    /** The closed question this one asks again (it links back: "Asked before: Q-12"). */
    askedBefore: id.optional(),
  })
  .strict();

/** What an answer relied on besides what the question is pinned to (its elements and requirements always count). */
const reliesOnInput = z.object({ elementIds: z.array(id).max(200).optional(), requirementRefs: z.array(text(200).min(1)).max(50).optional() }).strict();

export const questionCommandSchemas = [
  z.object({ type: z.literal("add_question"), questions: z.array(questionInput).min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("edit_question"),
      questionId: id,
      questionType: z.enum(QUESTION_TYPES).optional(),
      number: text(20).min(1).optional(),
      text: text(1000).min(1).optional(),
      askOf: text(60).min(1).optional(),
      anchor: anchorInput.optional(),
      blocksIssue: z.boolean().optional(),
      /** `null` clears it. */
      closeBy: text(40).min(1).nullable().optional(),
      answeredBy: answeredByInput.nullable().optional(),
      externalRefs: z.array(externalRefInput).max(20).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("answer_question"),
      questionId: id,
      /** What was said, or (with `status: "assumed"`) the assumption the design goes ahead on. */
      answer: text(2000).min(1),
      status: z.enum(["answered", "assumed"]).optional(),
      /** What the answer did: an answer outcome id ("clarification", "judgment_recorded", "design_revision", an add-on's). Absent: a clarification. */
      outcome: text(80).min(1).optional(),
      /** Model things the answer links (a determination, a revision range, a branch); never anything commercial. */
      links: z.array(outcomeLinkInput).max(20).optional(),
      reliesOn: reliesOnInput.optional(),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("reply_question"),
      questionId: id,
      /** Anyone may reply, at any time; a reply never answers, closes or reopens the question. */
      text: text(2000).min(1),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("decline_question"),
      questionId: id,
      /** Why, in the decliner's words (optional). */
      note: text(1000).optional(),
      /** True: "Not in scope" (it isn't theirs to answer) rather than "Declined". */
      not_in_scope: z.boolean().optional(),
      /** Close it and keep it closed, with why: Ask again is then refused; asking anew makes a new question that links back. */
      keep_closed: text(500).min(1).optional(),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("take_over_question"),
      questionId: id,
      /** Why, for the history (optional). */
      note: text(1000).optional(),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("forward_question"),
      questionId: id,
      /** The person or company it is now asked of, in words. */
      askOf: text(60).min(1),
      askOfAuthor: askOfAuthorInput.optional(),
      note: text(1000).optional(),
      at: atInput,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_question_status"),
      questionIds: z.array(id).min(1).max(200),
      /** withdrawn: no longer asked. open: ask again (clears the answer; a declined or not-in-scope question only by its asker). */
      status: z.enum(["open", "withdrawn"]),
      at: atInput,
    })
    .strict(),
  z.object({ type: z.literal("delete_questions"), questionIds: z.array(id).min(1).max(200) }).strict(),
] as const;

export const questionCommandSchema = z.discriminatedUnion("type", [...questionCommandSchemas]);
export type QuestionCommand = z.infer<typeof questionCommandSchema>;
type QuestionInput = z.infer<typeof questionInput>;
type AnchorInput = z.infer<typeof anchorInput>;

const QUESTION_COMMANDS: ReadonlySet<string> = new Set(questionCommandSchemas.map((s) => s.shape.type.value));

export function isQuestionCommand(command: { readonly type: string }): command is QuestionCommand {
  return QUESTION_COMMANDS.has(command.type);
}

/** Kinds a question cannot point at: sheets and views are where it shows, not what it is about. */
const UNANCHORABLE = new Set(["question", "view", "sheet", "viewport"]);

// ---------------------------------------------------------------- edit plumbing

/** Who is deciding the command and when (the model server's checked actor and its clock). */
export interface QuestionCommandContext {
  readonly actorId?: string;
  readonly actor?: { readonly id: string; readonly name: string; readonly kind: "human" | "agent" };
  /** The session's identity provider, when the host knows it. */
  readonly provider?: string;
  /** Now, ISO 8601, from the model server. */
  readonly at?: string;
}

interface Edit {
  readonly ctx: QuestionCommandContext;
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly removed: ElementId[];
  readonly summary: string[];
}

function begin(model: ModelState, ctx: QuestionCommandContext = {}): Edit {
  return { ctx, reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], removed: [], summary: [] };
}

function done(e: Edit): ExecuteResult {
  return finish(e.reader, e.working, e.touched, e.authored, () => [], { removedIds: e.removed, summary: e.summary });
}

function put(e: Edit, q: Question): void {
  putQuestion(e.working, q);
  e.touched.push(q.id);
  e.authored.push({ elementId: q.id, field: QUESTION_FIELD, value: questionFingerprint(q) });
}

function current(e: Edit, qid: string): Question {
  const key = asElementId(qid);
  const el: { readonly kind: string } | undefined = e.working[key] ?? e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no question ${qid}`, [key]);
  if (!isQuestion(el)) refuse("wrong_kind", `${qid} is a ${el.kind.replace(/_/g, " ")}, not a question`, [key]);
  return el;
}

type ThreadRecord = QuestionReplyElement | QuestionAnswerElement;

function putRecord(e: Edit, rec: ThreadRecord, field: "reply" | "answer", body: QuestionReplyBody | QuestionAnswerBody): void {
  // The store indexes any kind string; thread records sit outside the element union like questions.
  (e.working as Record<string, BimElement | ThreadRecord>)[rec.id] = rec;
  e.touched.push(rec.id);
  e.authored.push({ elementId: rec.id, field, value: canonicalJson(body) });
}

/** The provider a session's actor is written under: the actor's own (round 9 lane S adds it), the host's, else the placeholder. */
function providerOf(ctx: QuestionCommandContext): string {
  const own: unknown = ctx.actor ? (ctx.actor as { readonly provider?: unknown }).provider : undefined;
  if (typeof own === "string" && PROVIDER_ID.test(own)) return own;
  if (ctx.provider && PROVIDER_ID.test(ctx.provider)) return ctx.provider;
  return UNSIGNED_PROVIDER_ID;
}

/** Who is deciding, as an author, or null outside a session (a host deciding with no actor). */
function actorAuthor(ctx: QuestionCommandContext): AuthorRef | null {
  const provider = providerOf(ctx);
  if (ctx.actor) return authorFromActor(ctx.actor, provider);
  if (!ctx.actorId) return null;
  const parsed = parseAgentSubject(ctx.actorId);
  return parsed ? { provider, subject: ctx.actorId, kind: "agent", onBehalfOf: { provider, subject: parsed.personSubject, kind: "person" } } : { provider, subject: ctx.actorId, kind: "person" };
}

/** The deciding actor, written strictly; refused in words when there is none or it can't be written. */
function requireAuthor(e: Edit, what: string): AuthorRef {
  const author = actorAuthor(e.ctx);
  if (!author) refuse("invalid_value", `Sign in to ${what}: the model needs to know who is speaking`);
  try {
    return writeAuthorRef(author);
  } catch (err) {
    if (err instanceof AuthorshipWriteError) refuse("invalid_value", `Can't record who is speaking: ${err.message}`);
    throw err;
  }
}

/** The model server's clock; a host deciding outside one (a prediction, a preview) uses the time sent or its own. */
function requireTime(e: Edit, sent: string | undefined): string {
  return e.ctx.at ?? sent ?? new Date().toISOString();
}

/** Threads go only to peers that store them (mixed-version: tolerant readers, strict writers). */
function requireThreadPeers(what: string): void {
  if (!questionThreadsWritable()) refuse("invalid_value", `${what} can't be saved yet: the model server this model is open on is an older version that doesn't store question threads. Try again once the server is updated`);
}

/** Owners, forwards and kept-closed questions go only to peers that store them. */
function requireCustodyPeers(what: string): void {
  if (!questionCustodyWritable()) refuse("invalid_value", `${what} can't be saved yet: the model server this model is open on is an older version that doesn't store who carries a question. Try again once the server is updated`);
}

/** A kept-closed question takes no answer and no Ask again: a new question asks it anew. */
function refuseKeptClosed(q: Question): void {
  if (!q.keptClosed) return;
  const may = mayAskAgain(q, null);
  if (!may.ok) refuse("invalid_value", `${questionLabel(q)}: ${may.reason}`, [q.id]);
}

function partyOf(label: string, author: AuthorRef | undefined): QuestionParty {
  return { label, ...(author ? { author } : {}) };
}

function writeReply(e: Edit, q: Question, text: string, author: AuthorRef, at: string, to?: QuestionStatus, event?: QuestionEvent): void {
  const body: QuestionReplyBody = { questionId: q.id, text, author, at, ...(to ? { statusChange: { to } } : {}), ...(event ? { event } : {}) };
  const rec: QuestionReplyElement = { id: nextThreadRecordId(e.reader.model.elements, q.id, "reply"), kind: QUESTION_REPLY_KIND, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, reply: body };
  putRecord(e, rec, "reply", body);
}

export function questionLabel(q: Pick<Question, "number" | "text">): string {
  const t = q.text.trim();
  return `${q.number} '${t.length > 60 ? `${t.slice(0, 57)}...` : t}'`;
}

function anchorFrom(e: Edit, input: AnchorInput): QuestionAnchor {
  const elementIds: ElementId[] = [];
  for (const raw of new Set(input.elementIds ?? [])) {
    const key = asElementId(raw);
    const el: { readonly kind: string } | undefined = e.working[key] ?? e.reader.find(key);
    if (!el) refuse("element_not_found", `There is no element ${raw} to pin the question to. Pick it on the plan again`, [key]);
    if (UNANCHORABLE.has(el.kind)) refuse("invalid_value", `A question can't be pinned to a ${el.kind}. Pin it to the thing it is about, or to a point on a plan`, [key]);
    elementIds.push(key);
  }
  let point: QuestionAnchor["point"];
  if (input.point) {
    const lvl = e.reader.find(asElementId(input.point.levelId));
    if (lvl?.kind !== "level") refuse("element_not_found", `There is no level ${input.point.levelId} for the question's point`, [asElementId(input.point.levelId)]);
    point = { levelId: lvl.id, position: input.point.position };
  }
  if (elementIds.length === 0 && !point) refuse("invalid_value", "Pin the question to something: pick the elements it is about or a point on a plan");
  return { elementIds, ...(point ? { point } : {}) };
}

/**
 * What a stored anchor carries beyond the elements and point this release
 * writes (`requirementRefs`, `documentRefs`, a newer peer's fields): an anchor
 * edit restates elements and point and keeps the rest as it was.
 */
function reservedAnchorFields(anchor: QuestionAnchor): Omit<QuestionAnchor, "elementIds" | "point"> {
  const { elementIds: _elementIds, point: _point, ...rest } = anchor;
  return rest;
}

function requireValueSource(e: Edit, raw: z.infer<typeof answeredByInput>): Question["answeredBy"] {
  const key = asElementId(raw.elementId);
  const el = e.working[key] ?? e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no element ${raw.elementId} whose value would answer the question`, [key]);
  if (raw.field.startsWith("values.") && el.kind !== "part") refuse("invalid_value", `${raw.elementId} is a ${el.kind.replace(/_/g, " ")}; only placed or planned parts carry instance values. Name a plain field such as mark instead`, [key]);
  return { elementId: key, field: raw.field };
}

function refuseNumberTaken(e: Edit, number: string, self: ElementId, made: ReadonlyMap<string, ElementId>): void {
  const key = number.trim().toLowerCase();
  const inBatch = made.get(key);
  if (inBatch && inBatch !== self) refuse("already_exists", `Two questions in this request are both ${number}. Number them apart`, [self, inBatch]);
  const other = questionByNumber(e.reader.model.elements, number);
  if (other && other.id !== self && e.working[other.id] !== undefined) refuse("already_exists", `${number} already exists (${questionLabel(other)}). Give this one another number`, [self, other.id]);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An edit's optional field: `null` clears it, absent keeps what was there. */
function keep<T>(sent: T | null | undefined, prior: T | undefined): T | undefined {
  return sent === null ? undefined : sent === undefined ? prior : sent;
}

// ---------------------------------------------------------------- commands

function newQuestion(e: Edit, input: QuestionInput, number: string): Question {
  const qid = asElementId(input.questionId);
  if (e.working[qid] ?? e.reader.find(qid)) refuse("already_exists", `${input.questionId} already exists; choose a new id for the question`, [qid]);
  const type = input.type ?? "question";
  return {
    id: qid,
    kind: "question",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    type,
    number,
    anchor: anchorFrom(e, input.anchor),
    text: input.text,
    askOf: input.askOf,
    status: type === "assumption" ? "assumed" : "open",
    ...(input.blocksIssue !== undefined ? { blocksIssue: input.blocksIssue } : {}),
    ...(input.closeBy ? { closeBy: input.closeBy } : {}),
    ...(input.answeredBy ? { answeredBy: requireValueSource(e, input.answeredBy) } : {}),
    ...(input.externalRefs && input.externalRefs.length > 0 ? { externalRefs: input.externalRefs } : {}),
    ...askers(e, input),
  };
}

/** Who asked and the person asked, written only to peers that store threads (an older peer gets the round 8 shape). */
function askers(e: Edit, input: QuestionInput): Pick<Question, "askedBy" | "askedByAuthor" | "askOfAuthor" | "askedBefore"> {
  if (!questionThreadsWritable()) {
    if (input.askedBefore) refuse("invalid_value", "Asking a closed question anew can't be saved yet: the model server this model is open on is an older version. Ask it as a new question without the link, or try again once the server is updated");
    if (input.askOfAuthor) refuse("invalid_value", "Asking one named person can't be saved yet: the model server this model is open on is an older version that doesn't store question threads. Ask the party by name instead, or try again once the server is updated");
    return {};
  }
  const author = actorAuthor(e.ctx);
  const asked = author ? requireAuthor(e, "ask a question") : null;
  const askOf = input.askOfAuthor ? { provider: input.askOfAuthor.provider, subject: input.askOfAuthor.subject, kind: "person" as const, ...(input.askOfAuthor.displayName ? { displayName: input.askOfAuthor.displayName } : {}) } : null;
  let before: ElementId | null = null;
  if (input.askedBefore) {
    requireCustodyPeers("Asking a closed question anew");
    const prior = current(e, input.askedBefore);
    before = prior.id;
  }
  return {
    ...(asked ? { askedByAuthor: asked, askedBy: authorWords(asked) } : {}),
    ...(askOf ? { askOfAuthor: askOf } : {}),
    ...(before ? { askedBefore: before } : {}),
  };
}

function addQuestions(model: ModelState, command: Extract<QuestionCommand, { type: "add_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const made = new Map<string, ElementId>();
  let auto = Number(/^Q-(\d+)$/.exec(nextQuestionNumber(model.elements))?.[1] ?? "1");
  const out: Question[] = [];
  for (const input of command.questions) {
    let number = input.number;
    if (!number) {
      while (made.has(`q-${auto}`) || questionByNumber(model.elements, `Q-${auto}`)) auto += 1;
      number = `Q-${auto}`;
      auto += 1;
    }
    const q = newQuestion(e, input, number);
    refuseNumberTaken(e, number, q.id, made);
    made.set(number.trim().toLowerCase(), q.id);
    put(e, q);
    out.push(q);
  }
  const first = out[0];
  const noun = (q: Question) => (q.type === "assumption" ? "assumption" : q.type === "field_verify" ? "field check" : "question");
  e.summary.push(out.length === 1 && first ? `Added ${noun(first)} ${questionLabel(first)} for ${first.askOf}` : `Added ${plural(out.length, "question")}`);
  return done(e);
}

function editQuestion(model: ModelState, command: Extract<QuestionCommand, { type: "edit_question" }>): ExecuteResult {
  const e = begin(model);
  const q = current(e, command.questionId);
  const { closeBy: priorCloseBy, answeredBy: priorAnsweredBy, externalRefs: priorRefs, blocksIssue: priorBlocks, ...base } = q;
  const closeBy = keep(command.closeBy, priorCloseBy);
  const answeredBy = command.answeredBy === null ? undefined : command.answeredBy ? requireValueSource(e, command.answeredBy) : priorAnsweredBy;
  const externalRefs = command.externalRefs ?? priorRefs;
  const blocksIssue = command.blocksIssue ?? priorBlocks;
  const next: Question = {
    ...base,
    ...(command.questionType ? { type: command.questionType } : {}),
    ...(command.number ? { number: command.number } : {}),
    ...(command.text ? { text: command.text } : {}),
    ...(command.askOf ? { askOf: command.askOf } : {}),
    ...(command.anchor ? { anchor: { ...reservedAnchorFields(q.anchor), ...anchorFrom(e, command.anchor) } } : {}),
    ...(blocksIssue !== undefined ? { blocksIssue } : {}),
    ...(closeBy ? { closeBy } : {}),
    ...(answeredBy ? { answeredBy } : {}),
    ...(externalRefs && externalRefs.length > 0 ? { externalRefs } : {}),
  };
  if (questionFingerprint(next) === questionFingerprint(q)) refuse("invalid_value", `Nothing to change: ${questionLabel(q)} already reads that way`, [q.id]);
  if (command.number) refuseNumberTaken(e, command.number, q.id, new Map());
  put(e, next);
  e.summary.push(`Changed ${questionLabel(next)}`);
  return done(e);
}

function outcomeNames(): string {
  return listQuestionOutcomes()
    .map((o) => `${o.label} (${o.id})`)
    .join(", ");
}

function answerQuestion(model: ModelState, command: Extract<QuestionCommand, { type: "answer_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const q = current(e, command.questionId);
  if (q.status === "withdrawn") refuse("invalid_value", `${questionLabel(q)} was withdrawn. Ask it again first if it still needs an answer`, [q.id]);
  refuseKeptClosed(q);
  if (command.status === "assumed") {
    if (command.outcome || command.links) refuse("invalid_value", "An assumption is the design going ahead without an answer; it carries no outcome. Send the answer without status assumed, or the assumption without an outcome", [q.id]);
    if (q.status === "assumed" && q.answer === command.answer) refuse("invalid_value", `Nothing to change: ${questionLabel(q)} already goes ahead on that assumption`, [q.id]);
    put(e, { ...q, status: "assumed", answer: command.answer });
    e.summary.push(`Going ahead on an assumption for ${questionLabel(q)}`);
    return done(e);
  }
  if (!questionAnswersWritable()) {
    if (command.outcome || command.links) refuse("invalid_value", "An answer with an outcome can't be saved yet: the model server this model is open on is an older version that doesn't store answers. Answer in words, or try again once the server is updated", [q.id]);
    if (q.status === "answered" && q.answer === command.answer) refuse("invalid_value", `Nothing to change: ${questionLabel(q)} already has that answer`, [q.id]);
    put(e, { ...q, status: "answered", answer: command.answer });
    e.summary.push(`Answered ${questionLabel(q)}`);
    return done(e);
  }
  const outcomeId = command.outcome ?? "clarification";
  const def = questionOutcomeDef(outcomeId);
  if (!def) refuse("invalid_value", `"${outcomeId}" isn't an answer choice in this model. Choose one of: ${outcomeNames()}`, [q.id]);
  const links: QuestionOutcomeLink[] = command.links ?? [];
  const allowed = new Set(def.links ?? []);
  for (const l of links) if (!allowed.has(l.kind)) refuse("invalid_value", allowed.size === 0 ? `${def.label} links nothing; send it without links` : `${def.label} links ${[...allowed].join(" or ")}, not "${l.kind}"`, [q.id]);
  const at = requireTime(e, command.at);
  const author = questionThreadsWritable() ? requireAuthor(e, "answer") : null;
  const body: QuestionAnswerBody = {
    questionId: q.id,
    text: command.answer,
    by: author ? authorWords(author) : (e.ctx.actor?.name ?? e.ctx.actorId ?? "Someone"),
    at,
    outcome: def.id,
    ...(links.length > 0 ? { links } : {}),
    ...(author ? { author } : {}),
    ...(peerReads(VALIDITY_RELIANCE_FEATURE)
      ? {
          reliance: relianceFor(e.reader.model, {
            elementIds: [...q.anchor.elementIds, ...(command.reliesOn?.elementIds ?? [])],
            requirementRefs: [...(q.anchor.requirementRefs ?? []), ...(command.reliesOn?.requirementRefs ?? [])],
          }),
        }
      : {}),
  };
  const checked = readQuestionAnswerBody(body);
  if (!checked.ok) refuse("invalid_value", `Can't record that answer: ${checked.reason}`, [q.id]);
  const rec: QuestionAnswerElement = { id: nextThreadRecordId(e.reader.model.elements, q.id, "answer"), kind: QUESTION_ANSWER_KIND, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, answer: body };
  putRecord(e, rec, "answer", body);
  const status: QuestionStatus = def.questionStatus === "not_in_scope" && !questionThreadsWritable() ? "answered" : def.questionStatus;
  put(e, { ...q, status, answer: command.answer });
  e.summary.push(status === "not_in_scope" ? `Marked ${questionLabel(q)} not in scope` : `Answered ${questionLabel(q)} (${def.label.toLowerCase()})`);
  return done(e);
}

function replyQuestion(model: ModelState, command: Extract<QuestionCommand, { type: "reply_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const q = current(e, command.questionId);
  requireThreadPeers("A reply");
  const author = requireAuthor(e, "reply");
  writeReply(e, q, command.text, author, requireTime(e, command.at));
  e.summary.push(`Replied on ${questionLabel(q)}`);
  return done(e);
}

function declineQuestion(model: ModelState, command: Extract<QuestionCommand, { type: "decline_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const q = current(e, command.questionId);
  requireThreadPeers(command.not_in_scope ? "Not in scope" : "Declining");
  const to: QuestionStatus = command.not_in_scope ? "not_in_scope" : "declined";
  if (q.status === "withdrawn") refuse("invalid_value", `${questionLabel(q)} was withdrawn; there is nothing to decline`, [q.id]);
  if (q.status === to) refuse("invalid_value", `Nothing to change: ${questionLabel(q)} is already ${to === "declined" ? "declined" : "not in scope"}`, [q.id]);
  if (q.keptClosed) refuse("invalid_value", `${questionLabel(q)} is already closed and kept closed`, [q.id]);
  const author = requireAuthor(e, "decline");
  const at = requireTime(e, command.at);
  const keep = command.keep_closed?.trim();
  if (keep) requireCustodyPeers("Keeping it closed");
  writeReply(e, q, command.note?.trim() ?? "", author, at, to, keep ? { kind: "kept_closed", reason: keep } : undefined);
  const { answer: _answer, ...rest } = q;
  put(e, { ...rest, status: to, ...(keep ? { keptClosed: { by: author, reason: keep, at } } : {}) });
  const said = to === "declined" ? `Declined ${questionLabel(q)}` : `Marked ${questionLabel(q)} not in scope`;
  e.summary.push(keep ? `${said} and kept it closed` : said);
  return done(e);
}

function takeOver(model: ModelState, command: Extract<QuestionCommand, { type: "take_over_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const q = current(e, command.questionId);
  requireThreadPeers("Taking over a question");
  requireCustodyPeers("Taking over a question");
  const author = requireAuthor(e, "take over a question");
  const before = ownerOf(q);
  if (before && samePerson(before, author)) refuse("invalid_value", `You already carry ${questionLabel(q)}`, [q.id]);
  const words = (a: AuthorRef) => a.onBehalfOf?.displayName ?? a.displayName ?? authorWords(a);
  const owner = author.kind === "agent" && author.onBehalfOf ? author.onBehalfOf : author;
  writeReply(e, q, command.note?.trim() ?? "", author, requireTime(e, command.at), undefined, { kind: "took_over", ...(before ? { from: partyOf(words(before), before) } : {}), to: partyOf(words(owner), owner) });
  put(e, { ...q, ownerAuthor: owner });
  e.summary.push(`Took over ${questionLabel(q)}`);
  return done(e);
}

function forwardQuestion(model: ModelState, command: Extract<QuestionCommand, { type: "forward_question" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const q = current(e, command.questionId);
  requireThreadPeers("Forwarding a question");
  requireCustodyPeers("Forwarding a question");
  refuseKeptClosed(q);
  if (q.status === "withdrawn") refuse("invalid_value", `${questionLabel(q)} was withdrawn; there is no one to forward it to`, [q.id]);
  if (command.askOfAuthor && !questionForwardPersonWritable())
    refuse("invalid_value", `Forwarding ${questionLabel(q)} to one named person can't be saved yet: the model server this model is open on is an older version that doesn't store who a question was forwarded to. Forward it to ${command.askOf} by name instead, or try again once the server is updated`, [q.id]);
  const to: QuestionParty = command.askOfAuthor
    ? partyOf(command.askOf, { provider: command.askOfAuthor.provider, subject: command.askOfAuthor.subject, kind: "person", ...(command.askOfAuthor.displayName ? { displayName: command.askOfAuthor.displayName } : {}) })
    : partyOf(command.askOf, undefined);
  const same = q.askOf.trim().toLowerCase() === to.label.trim().toLowerCase() && (!to.author || (q.askOfAuthor !== undefined && samePerson(q.askOfAuthor, to.author)));
  if (same) refuse("invalid_value", `${questionLabel(q)} is already asked of ${q.askOf}`, [q.id]);
  const author = requireAuthor(e, "forward a question");
  const from = partyOf(q.askOf, q.askOfAuthor);
  writeReply(e, q, command.note?.trim() ?? "", author, requireTime(e, command.at), undefined, { kind: "forwarded", from, to });
  const { askOfAuthor: _prior, ...rest } = q;
  put(e, { ...rest, askOf: to.label, ...(to.author ? { askOfAuthor: to.author } : {}), formerAddressees: [...(q.formerAddressees ?? []), from] });
  e.summary.push(`Forwarded ${questionLabel(q)} to ${to.label}`);
  return done(e);
}

function setStatus(model: ModelState, command: Extract<QuestionCommand, { type: "set_question_status" }>, ctx: QuestionCommandContext): ExecuteResult {
  const e = begin(model, ctx);
  const threads = questionThreadsWritable();
  const author = threads && actorAuthor(e.ctx) ? requireAuthor(e, "change a question") : actorAuthor(e.ctx);
  const changed: Question[] = [];
  for (const qid of new Set(command.questionIds)) {
    const q = current(e, qid);
    if (q.status === command.status) {
      if (command.questionIds.length === 1) refuse("invalid_value", `Nothing to change: ${questionLabel(q)} is already ${command.status === "open" ? "open" : "withdrawn"}`, [q.id]);
      continue;
    }
    if (command.status === "open") {
      const may = mayAskAgain(q, author);
      if (!may.ok) refuse("invalid_value", `${questionLabel(q)}: ${may.reason}.${q.keptClosed ? "" : " You can reply to it instead"}`, [q.id]);
    }
    const { answer: _answer, ...rest } = q;
    const next: Question = command.status === "open" ? { ...rest, status: "open" } : { ...q, status: "withdrawn" };
    put(e, next);
    if (threads && author) writeReply(e, q, "", author, requireTime(e, command.at), command.status);
    changed.push(next);
  }
  if (changed.length === 0) refuse("invalid_value", `Nothing to change: ${command.questionIds.length === 1 ? "that question is" : "those questions are"} already ${command.status}`);
  const first = changed[0];
  const verb = command.status === "open" ? "Asked again" : "Withdrew";
  e.summary.push(changed.length === 1 && first ? `${verb} ${questionLabel(first)}` : `${verb} ${plural(changed.length, "question")}`);
  return done(e);
}

function deleteQuestions(model: ModelState, command: Extract<QuestionCommand, { type: "delete_questions" }>): ExecuteResult {
  const e = begin(model);
  const labels: string[] = [];
  for (const qid of new Set(command.questionIds)) {
    const q = current(e, qid);
    labels.push(questionLabel(q));
    delete e.working[q.id];
    e.removed.push(q.id);
  }
  e.summary.push(labels.length === 1 ? `Deleted ${labels[0]}` : `Deleted ${plural(labels.length, "question")}`);
  return done(e);
}

export function executeQuestionCommand(model: ModelState, command: QuestionCommand, ctx: QuestionCommandContext = {}): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "add_question":
        return addQuestions(model, command, ctx);
      case "edit_question":
        return editQuestion(model, command);
      case "answer_question":
        return answerQuestion(model, command, ctx);
      case "reply_question":
        return replyQuestion(model, command, ctx);
      case "decline_question":
        return declineQuestion(model, command, ctx);
      case "take_over_question":
        return takeOver(model, command, ctx);
      case "forward_question":
        return forwardQuestion(model, command, ctx);
      case "set_question_status":
        return setStatus(model, command, ctx);
      case "delete_questions":
        return deleteQuestions(model, command);
    }
  });
}
