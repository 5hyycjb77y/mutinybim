import { readRuleRecord } from "./records";
import type { RequirementsSnapshot, RequirementsSourceRow } from "./source";
import { RULE_SUMMARY_MAX_LENGTH, RULE_TITLE_MAX_LENGTH, type RuleRecord } from "./types";

/**
 * Conformance for requirements sources (REQUIREMENTS-GRAPH §5): a rule holds
 * a citation, numbers and logic in the author's own words, never a code's
 * text. Two checks a source, an add-on's conformance suite or a command runs:
 *
 * - length: `title` ≤ RULE_TITLE_MAX_LENGTH, `summary` ≤ RULE_SUMMARY_MAX_LENGTH;
 * - a verbatim-text heuristic: long passages that read like a code book
 *   (many sentences in a row, dense section numbers, a run of "shall" and
 *   "shall not"). A heuristic, not a legal test: it flags for a person.
 */

export interface RuleFinding {
  readonly ruleId: string;
  readonly field: "title" | "summary" | "rule";
  readonly code: "too_long" | "looks_copied" | "unreadable";
  /** Plain words, with what to do. */
  readonly message: string;
}

const SECTION_NUMBER = /\b\d{1,4}(?:\.\d{1,4}){1,5}\b/g;
const MANDATORY = /\bshall(?:\s+not)?\b/gi;
const SENTENCE_END = /[.;:](?=\s+[A-Z(]|\s*$)/g;

export interface VerbatimSignals {
  readonly sentences: number;
  readonly sectionNumbers: number;
  readonly mandatoryWords: number;
  readonly words: number;
}

export function verbatimSignals(text: string): VerbatimSignals {
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return {
    sentences: (text.match(SENTENCE_END) ?? []).length,
    sectionNumbers: (text.match(SECTION_NUMBER) ?? []).length,
    mandatoryWords: (text.match(MANDATORY) ?? []).length,
    words,
  };
}

/**
 * Whether a passage looks copied from a code book: at least 40 words and
 * one of: five or more sentences in a row; a section number every 25 words;
 * "shall" (or "shall not") three or more times, or once per 30 words.
 */
export function looksVerbatim(text: string): { readonly flagged: boolean; readonly why: string | null } {
  const s = verbatimSignals(text);
  if (s.words < 40) return { flagged: false, why: null };
  if (s.sentences >= 5) return { flagged: true, why: `${s.sentences} sentences in a row` };
  if (s.sectionNumbers * 25 >= s.words && s.sectionNumbers >= 2) return { flagged: true, why: `${s.sectionNumbers} section numbers in ${s.words} words` };
  if (s.mandatoryWords >= 3 || (s.mandatoryWords > 0 && s.mandatoryWords * 30 >= s.words)) return { flagged: true, why: `"shall" ${s.mandatoryWords} times` };
  return { flagged: false, why: null };
}

/** Findings for one rule's words. */
export function checkRuleWords(rule: Pick<RuleRecord, "ruleId" | "title" | "summary">): RuleFinding[] {
  const out: RuleFinding[] = [];
  if (rule.title.length > RULE_TITLE_MAX_LENGTH) out.push({ ruleId: rule.ruleId, field: "title", code: "too_long", message: `Rule ${rule.ruleId}'s title is ${rule.title.length} characters; keep it to ${RULE_TITLE_MAX_LENGTH} in your own words` });
  if (rule.summary.length > RULE_SUMMARY_MAX_LENGTH) out.push({ ruleId: rule.ruleId, field: "summary", code: "too_long", message: `Rule ${rule.ruleId}'s summary is ${rule.summary.length} characters; keep it to ${RULE_SUMMARY_MAX_LENGTH} in your own words. Cite the section instead of quoting it` });
  const v = looksVerbatim(rule.summary);
  if (v.flagged) out.push({ ruleId: rule.ruleId, field: "summary", code: "looks_copied", message: `Rule ${rule.ruleId}'s summary reads like copied code text (${v.why}). Say what it requires in your own words and cite the section` });
  return out;
}

/** Findings for every rule a source supplies: unreadable rules, long words and copied-looking summaries. */
export function checkRules(rules: readonly unknown[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const raw of rules) {
    const r = readRuleRecord(raw);
    if (!r.ok) {
      const id = typeof raw === "object" && raw !== null && "ruleId" in raw && typeof raw.ruleId === "string" ? raw.ruleId : "?";
      out.push({ ruleId: id, field: "rule", code: "unreadable", message: r.reason });
      continue;
    }
    out.push(...checkRuleWords(r.value));
  }
  return out;
}

/** Conformance for a host snapshot. */
export function checkRequirementsSnapshot(snapshot: RequirementsSnapshot): RuleFinding[] {
  return checkRules(snapshot.rules);
}

/** Conformance for an add-on's source row, read against a model. */
export function checkRequirementsSourceRow(row: RequirementsSourceRow, model: Parameters<RequirementsSourceRow["rules"]>[0]): RuleFinding[] {
  return checkRules(row.rules(model));
}
