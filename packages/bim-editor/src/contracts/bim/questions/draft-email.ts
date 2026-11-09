import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { NAMED_AUDIENCES, questionsToAsk, type Question } from "./kernel";

/**
 * The email to the client (or architect, structural engineer, contractor)
 * listing what we still need from them, composed from the model's open
 * questions and the assumptions they should confirm. Questions the model
 * already answers are left out and listed separately, so the person sending
 * it can see why.
 *
 * Plain text for a person or the in-app agent to paste. Nothing here sends
 * mail or creates a Front draft: agents never create Front drafts.
 */

export interface QuestionEmailInput {
  /** Who the questions are for: matches each question's "ask of" (any case). */
  readonly askOf: string;
  /** "7101 Sample Market". */
  readonly projectName: string;
  /** "Dana": the greeting. Absent: "Hi,". */
  readonly recipientName?: string;
  /** Signs the email. Absent: no signature line. */
  readonly senderName?: string;
}

export interface QuestionEmailDraft {
  readonly status: "draft";
  readonly subject: string;
  readonly body: string;
  /** Questions in the email, in order. */
  readonly asked: readonly string[];
  /** Left out because the model already answers them: "Q-1 (SD-1 mark is SD-1)". */
  readonly answeredByModel: readonly string[];
}

export interface QuestionEmailEmpty {
  readonly status: "nothing_to_ask";
  readonly message: string;
  readonly answeredByModel: readonly string[];
}

const AUDIENCE_WORDS: Readonly<Record<(typeof NAMED_AUDIENCES)[number], string>> = {
  client: "the client",
  architect: "the architect",
  structural: "the structural engineer",
  contractor: "the contractor",
  internal: "the team",
};

function audienceWords(askOf: string): string {
  const key = askOf.trim().toLowerCase();
  const named = NAMED_AUDIENCES.find((a) => a === key);
  return named ? AUDIENCE_WORDS[named] : askOf.trim();
}

/** What a person calls the element: its mark, number and name, or name; else its kind. */
function elementWords(el: BimElement): string {
  if ("mark" in el && typeof el.mark === "string" && el.mark.trim() !== "") return el.mark.trim();
  if (el.kind === "space") return [el.number, el.name].filter((s) => s.trim() !== "").join(" ") || "a space";
  if (el.kind === "room") return [el.number, el.name].filter((s) => s.trim() !== "").join(" ") || "a room";
  if ("name" in el && typeof el.name === "string" && el.name.trim() !== "") return el.name.trim();
  return `a ${el.kind.replace(/_/g, " ")}`;
}

function aboutWords(model: Pick<ModelState, "elements">, q: Question): string {
  const names = q.anchor.elementIds.flatMap((id) => {
    const el = model.elements[id];
    return el ? [elementWords(el)] : [];
  });
  const unique = [...new Set(names)];
  if (unique.length === 0) return q.anchor.point ? "at the marked spot on the plan" : "";
  const shown = unique.slice(0, 3).join(", ");
  return `about ${shown}${unique.length > 3 ? ` and ${unique.length - 3} more` : ""}`;
}

function line(model: Pick<ModelState, "elements">, q: Question, n: number): string {
  const about = aboutWords(model, q);
  const due = q.closeBy ? ` Needed by ${q.closeBy}.` : "";
  return `${n}. ${q.text.trim()}${about ? ` (${q.number}, ${about})` : ` (${q.number})`}${due}`;
}

export function draftQuestionsEmail(model: Pick<ModelState, "elements">, input: QuestionEmailInput): QuestionEmailDraft | QuestionEmailEmpty {
  const who = audienceWords(input.askOf);
  const { ask, answeredByModel } = questionsToAsk(model, { askOf: input.askOf });
  const skipped = answeredByModel.map((a) => `${a.question.number} (${a.from} is ${a.value})`);
  const open = ask.filter((a) => a.ask === "answer").map((a) => a.question);
  const assumed = ask.filter((a) => a.ask === "confirm_assumption").map((a) => a.question);
  if (open.length === 0 && assumed.length === 0) {
    return { status: "nothing_to_ask", message: `Nothing to ask ${who}: no open questions or assumptions to confirm${skipped.length > 0 ? ` (the model already answers ${skipped.length})` : ""}.`, answeredByModel: skipped };
  }

  const out: string[] = [input.recipientName?.trim() ? `Hi ${input.recipientName.trim()},` : "Hi,", ""];
  if (open.length > 0) {
    out.push(open.length === 1 ? `We have one open question on ${input.projectName}:` : `We have ${open.length} open questions on ${input.projectName}:`, "");
    open.forEach((q, i) => out.push(line(model, q, i + 1)));
    out.push("");
  }
  if (assumed.length > 0) {
    out.push(open.length > 0 ? "We are also going ahead on these assumptions. Please tell us if any is wrong:" : `We are going ahead on these assumptions on ${input.projectName}. Please tell us if any is wrong:`, "");
    assumed.forEach((q, i) => out.push(line(model, q, i + 1)));
    out.push("");
  }
  if (open.some((q) => q.blocksIssue === true)) out.push("The drawings showing these items can't be issued until we hear back.", "");
  out.push("Thanks,");
  if (input.senderName?.trim()) out.push(input.senderName.trim());

  const count = open.length + assumed.length;
  return {
    status: "draft",
    subject: `${input.projectName}: ${count === 1 ? "1 question" : `${count} questions`} for ${who}`,
    body: out.join("\n"),
    asked: [...open, ...assumed].map((q) => q.number),
    answeredByModel: skipped,
  };
}
