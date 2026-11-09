import { readAuthorRef, sameAuthor, writeAuthorRef } from "../authorship/author";
import type { AuthorRef } from "../authorship/types";

/**
 * Finding dispositions (round 10 lane C10, FOUNDATION-REVIEW §4.3 / §6.2): a
 * person's recorded answer to something the model found, written in the one
 * shape round 11's finding ledger generalises (lint, clash, code check,
 * coordination issue) with no new record shape.
 *
 * C10 builds one case: the reliance finding "this approval was checked
 * against an older rule", which only the approval's own signer may override,
 * with a reason, as a record in the model's sign-off chain (record kind
 * `finding_disposition`), signed like any other entry.
 *
 * `sourceVersion` names exactly what the person overrode against (the code of
 * record and rule versions at that moment), so an override never carries
 * over to a later code change: a new change is a new finding.
 *
 * Round 11 (F11, D2) widens the actions and the scope; the rest of the
 * finding ledger lives beside this file (see `index.ts`).
 */

export const FINDING_DISPOSITION_KIND = "finding_disposition";
/** The only copy of a model today; round 11's lineages add others. */
export const MAIN_LINEAGE = "main";
/** Shortest reason accepted for an override (a person's words, read by reviewers). */
export const DISPOSITION_REASON_MIN = 10;
export const DISPOSITION_REASON_MAX = 2000;

/**
 * What a person decided about a finding (round 11, D2). `accepted_known`: a
 * known problem accepted (on a stamped set, what the signer signs);
 * `waived`: not a problem here; `deferred_to_stage`: left until a later
 * stage (`scope.untilStage`) or gate (`scope.untilGate`); `override`: a
 * person's value or judgement replaces the check's (C10's reliance case,
 * signer-only); `retracted`: an earlier decision taken back. Open: a
 * stored action this release doesn't know is kept as written.
 */
export type FindingDispositionAction = "accepted_known" | "waived" | "deferred_to_stage" | "override" | "retracted" | (string & {});

export const KNOWN_DISPOSITION_ACTIONS = ["accepted_known", "waived", "deferred_to_stage", "override", "retracted"] as const satisfies readonly FindingDispositionAction[];

/** Taking a decision back: the finding is open again on that copy. */
export const RETRACTED_ACTION = "retracted";

export interface FindingDispositionScope {
  readonly lineageId: string;
  /** The gate (issued set) it holds until; a later gate asks again. */
  readonly untilGate?: string;
  /** The project stage it holds until (`deferred_to_stage`). */
  readonly untilStage?: string;
}

export interface FindingDisposition {
  readonly findingId: string;
  readonly sourceVersion: string;
  readonly action: FindingDispositionAction;
  readonly reason: string;
  readonly by: AuthorRef;
  /** ISO 8601. */
  readonly at: string;
  readonly scope: FindingDispositionScope;
}

/** The reliance finding's id for one sign-off record: "checked against an older rule". */
export function relianceFindingId(signoffRecordId: string): string {
  return `reliance:${signoffRecordId}`;
}

export type DispositionRead = { readonly ok: true; readonly value: FindingDisposition } | { readonly ok: false; readonly reason: string };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * A stored disposition, from a chain payload (snake_case, as the host writes
 * it) or the kernel's own camelCase. Unknown actions are kept as written.
 */
export function readFindingDisposition(raw: unknown): DispositionRead {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "not a disposition" };
  const r = raw as Readonly<Record<string, unknown>>;
  const findingId = text(r.findingId ?? r.finding_id);
  const sourceVersion = text(r.sourceVersion ?? r.source_version);
  const action = text(r.action);
  const reason = text(r.reason);
  const at = text(r.at);
  if (!findingId || !sourceVersion || !action || !reason || !at) return { ok: false, reason: "a disposition names its finding, source version, action, reason and time" };
  const by = readAuthorRef(r.by ?? r.author);
  if (!by.ok) return { ok: false, reason: `who decided can't be read: ${by.reason}` };
  const scopeRaw = r.scope;
  const s: Readonly<Record<string, unknown>> = typeof scopeRaw === "object" && scopeRaw !== null && !Array.isArray(scopeRaw) ? (scopeRaw as Readonly<Record<string, unknown>>) : {};
  const lineage = text(s.lineageId ?? s.lineage_id);
  const untilGate = text(s.untilGate ?? s.until_gate);
  const untilStage = text(s.untilStage ?? s.until_stage);
  const scope: FindingDispositionScope = { lineageId: lineage ?? MAIN_LINEAGE, ...(untilGate ? { untilGate } : {}), ...(untilStage ? { untilStage } : {}) };
  return { ok: true, value: { findingId, sourceVersion, action, reason, by: by.value, at, scope } };
}

/** The payload a host appends (snake_case keys, the shape `readFindingDisposition` reads back). */
export function writeFindingDisposition(d: FindingDisposition): { readonly [key: string]: string | { readonly [key: string]: unknown } } {
  return {
    finding_id: d.findingId,
    source_version: d.sourceVersion,
    action: d.action,
    reason: d.reason,
    by: writeAuthorRef(d.by),
    at: d.at,
    scope: { lineage_id: d.scope.lineageId, ...(d.scope.untilGate ? { until_gate: d.scope.untilGate } : {}), ...(d.scope.untilStage ? { until_stage: d.scope.untilStage } : {}) },
  };
}

/**
 * Why `by` may not override the reliance finding on a record `signer` made,
 * or null when they may. Someone else taking responsibility is a new
 * approval, never an override.
 */
export function overrideRefusal(input: { readonly signer: AuthorRef; readonly by: AuthorRef; readonly reason: string; readonly signerName?: string }): string | null {
  if (input.by.kind !== "person") return "Only a person can override this, not an agent.";
  if (!sameAuthor(input.signer, input.by)) return `Only ${input.signerName ?? "the person who signed this"} can override it. To take it on yourself, re-check it and sign your own approval.`;
  const reason = input.reason.trim();
  if (reason.length < DISPOSITION_REASON_MIN) return "Say why in a sentence; reviewers will read it.";
  if (reason.length > DISPOSITION_REASON_MAX) return `Keep the reason under ${DISPOSITION_REASON_MAX} characters.`;
  return null;
}

/** Whether a disposition answers this finding at this source version on this copy of the model. */
export function dispositionAnswers(d: FindingDisposition, findingId: string, sourceVersion: string, lineageId: string = MAIN_LINEAGE): boolean {
  return d.action === "override" && d.findingId === findingId && d.sourceVersion === sourceVersion && d.scope.lineageId === lineageId;
}
