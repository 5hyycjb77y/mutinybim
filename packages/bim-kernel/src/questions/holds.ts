import { cropIsOn, viewCrop } from "../crop";
import { levelOf } from "../fields/providers/spatial";
import { sameFloor } from "../levels";
import { elementsOfKind } from "../store";
import { anchorOf } from "../model";
import { DEFAULT_PARTITION, type BimElement, type ElementId, type ModelState, type Sheet, type Vec2, type ViewElement } from "../types";
import { questionLabel } from "./commands";
import { answerValidity } from "./thread";
import { allQuestions, blockingOpenQuestions, questionsAtPointsOn, questionsOnElements, questionsWithStatus } from "./question-index";
import type { Question, QuestionStatus } from "./types";

/**
 * What questions mean for the rest of the model: which are open on the
 * elements in front of you, which hold a sheet's issue, which still need
 * asking, and where each one pins on a plan. Pure reads over the question
 * index; none of them scans the model.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Open questions on any of these elements. */
export function openQuestionsFor(model: Pick<ModelState, "elements">, elementIds: Iterable<ElementId>): Question[] {
  return questionsOnElements(model.elements, elementIds).filter((q) => q.status === "open");
}

// ---------------------------------------------------------------- issue holds

export interface IssueHold {
  readonly questionId: ElementId;
  readonly number: string;
  readonly sheetId: ElementId;
  /** One sentence for the issue refusal: "Not issued: question Q-3 'Is there a beam here?' is open and holds this issue". */
  readonly reason: string;
}

function inRect(p: Vec2, view: ViewElement): boolean {
  const r = viewCrop(view);
  return p.x >= Math.min(r.min.x, r.max.x) && p.x <= Math.max(r.min.x, r.max.x) && p.y >= Math.min(r.min.y, r.max.y) && p.y <= Math.max(r.min.y, r.max.y);
}

function isPlan(view: ViewElement): boolean {
  return (view.viewType === "floor_plan" || view.viewType === "ceiling_plan") && !view.props?.diagram;
}

/**
 * Level names a view draws (null: every level): its own level name plus every
 * model level on the same floor, as `viewLevelNames` has it, read from the
 * level kind index rather than the partition index (which a new revision
 * rebuilds over the whole model).
 */
function viewNames(model: ModelState, view: ViewElement): ReadonlySet<string> | null {
  const level = view.props?.level;
  if (!level) return null;
  const names = new Set<string>([level]);
  for (const l of elementsOfKind(model.elements, "level")) if (sameFloor(l, level, view.props?.levelElevationMm)) names.add(l.name);
  return names;
}

function onViewLevel(elements: Elements, names: ReadonlySet<string> | null, el: BimElement): boolean {
  if (!names) return true;
  const lvl = levelOf(elements, el);
  if (lvl) return names.has(lvl.name);
  return names.has((el.partition ?? DEFAULT_PARTITION).level);
}

/**
 * Does this view show what the question points at? The rule, in words:
 * - a schedule shows no model location, so never;
 * - a plan shows an anchored element when the element is on the plan's level
 *   (same-floor levels count) and, with the crop on, its anchor point is inside
 *   the crop; it shows a pinned point on its level inside the crop;
 * - a section, 3D view, detail or live diagram shows an anchored element on its
 *   level (any level when it has none); their crops are not plan coordinates,
 *   so the crop is not tested, and a bare point never shows there.
 * Anchored elements that no longer exist show nowhere (lint reports them).
 */
export function viewShowsQuestion(model: ModelState, view: ViewElement, q: Question): boolean {
  if (view.deleted || view.viewType === "schedule") return false;
  const names = viewNames(model, view);
  const plan = isPlan(view);
  const cropped = plan && cropIsOn(view);
  for (const eid of q.anchor.elementIds) {
    const el = model.elements[eid];
    if (!el || !onViewLevel(model.elements, names, el)) continue;
    if (!cropped) return true;
    const at = anchorOf(el);
    if (!at || inRect(at, view)) return true;
  }
  const point = q.anchor.point;
  if (point && plan) {
    const lvl = model.elements[point.levelId];
    const levelOk = !names || (lvl?.kind === "level" && names.has(lvl.name));
    if (levelOk && (!cropped || inRect(point.position, view))) return true;
  }
  return false;
}

/**
 * Live views placed on a sheet, from the sheet's own list (placing a viewport
 * adds its view there, removing it takes it out), so no document index is built.
 */
function viewsOnSheet(model: ModelState, sheet: Sheet): ViewElement[] {
  const out: ViewElement[] = [];
  for (const id of sheet.viewIds) {
    const v = model.elements[id];
    if (v?.kind === "view" && !v.deleted) out.push(v);
  }
  return out;
}

/** Open questions (holding or not) that touch something a view on this sheet shows. */
export function openQuestionsOnSheet(model: ModelState, sheetId: ElementId): Question[] {
  const open = questionsWithStatus(model.elements, "open");
  if (open.length === 0) return [];
  const sheet = model.elements[sheetId];
  if (sheet?.kind !== "sheet" || sheet.deleted) return [];
  const views = viewsOnSheet(model, sheet);
  return open.filter((q) => views.some((v) => viewShowsQuestion(model, v, q)));
}

export function holdReason(q: Question): string {
  return `Not issued: question ${questionLabel(q)} is open and holds this issue`;
}

/**
 * Open questions marked to hold the issue that touch something a view on this
 * sheet shows. Reads the (few) blocking open questions against the sheet's
 * views; no model scan.
 */
export function issueHoldsFor(model: ModelState, sheetId: ElementId): IssueHold[] {
  const blocking = blockingOpenQuestions(model.elements);
  if (blocking.length === 0) return [];
  const sheet = model.elements[sheetId];
  if (sheet?.kind !== "sheet" || sheet.deleted) return [];
  const views = viewsOnSheet(model, sheet);
  const out: IssueHold[] = [];
  for (const q of blocking) {
    if (views.some((v) => viewShowsQuestion(model, v, q))) out.push({ questionId: q.id, number: q.number, sheetId, reason: holdReason(q) });
  }
  return out;
}

/** Holds across several sheets, one line per question naming every sheet it holds. */
export function issueHoldsForSheets(model: ModelState, sheetIds: readonly ElementId[]): { readonly holds: readonly IssueHold[]; readonly message: string | null } {
  const holds = sheetIds.flatMap((s) => issueHoldsFor(model, s));
  if (holds.length === 0) return { holds, message: null };
  const bySheetNumber = (sid: ElementId) => {
    const sh = model.elements[sid];
    return sh?.kind === "sheet" ? sh.number : sid;
  };
  const first = holds[0];
  const sheets = [...new Set(holds.filter((h) => h.questionId === first?.questionId).map((h) => bySheetNumber(h.sheetId)))];
  const others = new Set(holds.map((h) => h.questionId)).size - 1;
  const message = first
    ? `${first.reason} (sheet ${sheets.join(", ")})${others > 0 ? `, and ${others} more open ${others === 1 ? "question holds" : "questions hold"} it` : ""}. Answer or withdraw it in Coordination › Questions, or untick "Holds the issue".`
    : null;
  return { holds, message };
}

// ---------------------------------------------------------------- what still needs asking

export type ModelAnswer = { readonly answered: true; readonly value: string; readonly from: string } | { readonly answered: false; readonly why: string };

function scalar(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

/**
 * Does the model already answer this question? Only when the question names
 * the value that answers it (`answeredBy`) and that element now holds a
 * non-empty value there. Anything else is "can't tell", never "answered".
 */
export function modelAnswerFor(model: Pick<ModelState, "elements">, q: Question): ModelAnswer {
  const by = q.answeredBy;
  if (!by) return { answered: false, why: "The question doesn't name a model value that would answer it" };
  const el = model.elements[by.elementId];
  if (!el) return { answered: false, why: `${by.elementId} is no longer in the model` };
  let raw: unknown;
  if (by.field.startsWith("values.")) raw = el.kind === "part" ? el.values[by.field.slice("values.".length)] : undefined;
  else if (Object.prototype.hasOwnProperty.call(el, by.field)) raw = Reflect.get(el, by.field);
  const value = scalar(raw);
  const label = "mark" in el && typeof el.mark === "string" && el.mark !== "" ? el.mark : by.elementId;
  if (value === null) return { answered: false, why: `${label} has no ${by.field.replace(/^values\./, "")} yet` };
  return { answered: true, value, from: `${label} ${by.field.replace(/^values\./, "")}` };
}

export interface QuestionToAsk {
  readonly question: Question;
  /** open: ask it. assumed: ask them to confirm the assumption. */
  readonly ask: "answer" | "confirm_assumption";
}

export interface QuestionsToAsk {
  readonly ask: readonly QuestionToAsk[];
  /** Open or assumed ones the model already answers; not asked. */
  readonly answeredByModel: ReadonlyArray<{ readonly question: Question; readonly value: string; readonly from: string }>;
}

/**
 * The questions still worth asking `askOf` (case-insensitive): open ones, and
 * assumptions to confirm, minus the ones the model already answers (see
 * `modelAnswerFor`). Answered and withdrawn ones are never asked.
 */
export function questionsToAsk(model: Pick<ModelState, "elements">, options: { readonly askOf: string; readonly includeAssumptions?: boolean }): QuestionsToAsk {
  const who = options.askOf.trim().toLowerCase();
  const ask: QuestionToAsk[] = [];
  const answeredByModel: Array<{ question: Question; value: string; from: string }> = [];
  for (const q of allQuestions(model.elements)) {
    if (q.askOf.trim().toLowerCase() !== who) continue;
    if (q.status !== "open" && !(q.status === "assumed" && options.includeAssumptions !== false)) continue;
    const m = modelAnswerFor(model, q);
    if (m.answered) answeredByModel.push({ question: q, value: m.value, from: m.from });
    else ask.push({ question: q, ask: q.status === "open" ? "answer" : "confirm_assumption" });
  }
  return { ask, answeredByModel };
}

// ---------------------------------------------------------------- plan pins

export interface QuestionPin {
  readonly questionId: ElementId;
  readonly number: string;
  readonly status: Question["status"];
  readonly blocksIssue: boolean;
  /** Answered, but something the answer relied on changed since: the pin shows a warning tick. */
  readonly mayNoLongerHold?: boolean;
  /** Model mm on the level. */
  readonly position: Vec2;
}

/**
 * Where each question pins on a level's plan: its point when it has one on
 * this level, else the anchor point of its first anchored element on this
 * level. Withdrawn ones don't pin. Reads the questions (from the index; a
 * model holds tens, not thousands) and their anchored elements by id, never
 * the model.
 */
/**
 * Statuses that pin on plans (the product owner's choice, round 9 question 3): open,
 * assumed and answered (drawn with a tick, so the history stays where it
 * happened). Declined, not in scope and withdrawn hide; every question stays
 * in the Questions list. A status this release doesn't know hides too.
 */
export const PINNED_STATUSES: ReadonlySet<QuestionStatus> = new Set<QuestionStatus>(["open", "assumed", "answered"]);

export function questionPinsOn(model: Pick<ModelState, "elements">, levelId: ElementId): QuestionPin[] {
  const out = new Map<ElementId, QuestionPin>();
  const pin = (q: Question, position: Vec2) => {
    if (!PINNED_STATUSES.has(q.status) || out.has(q.id)) return;
    const stale = q.status === "answered" && answerValidity(model.elements, q.id).state === "may_not_hold";
    out.set(q.id, { questionId: q.id, number: q.number, status: q.status, blocksIssue: q.blocksIssue === true, ...(stale ? { mayNoLongerHold: true } : {}), position });
  };
  for (const q of questionsAtPointsOn(model.elements, levelId)) if (q.anchor.point) pin(q, q.anchor.point.position);
  const level = model.elements[levelId];
  const names: ReadonlySet<string> | null = level?.kind === "level" ? new Set([level.name]) : null;
  for (const q of questionsWithStatus(model.elements, ...PINNED_STATUSES)) {
    if (out.has(q.id)) continue;
    for (const eid of q.anchor.elementIds) {
      const el = model.elements[eid];
      if (!el || !names || !onViewLevel(model.elements, names, el)) continue;
      const at = anchorOf(el);
      if (at) {
        pin(q, at);
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.number.localeCompare(b.number, "en", { numeric: true }));
}
