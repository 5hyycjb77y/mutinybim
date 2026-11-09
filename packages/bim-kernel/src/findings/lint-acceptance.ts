import { readAuthorRef } from "../authorship/author";
import { UNSIGNED_PROVIDER_ID } from "../authorship/unsigned";
import { MAIN_LINEAGE, type DispositionRead } from "./disposition";
import { findingRefId } from "./ref";

/**
 * Old clash and lint acceptances move into the model (product owner answer 4, D2).
 * A host's acceptance row (per model, not per
 * revision or copy) becomes one `accepted_known` disposition on Main, with
 * the person's own reason and time. Pure: the host's job reads the rows,
 * calls this for each and writes the records (PL11).
 */

/** A lint rule's version when the rule names none (every rule before round 11). */
export const LINT_RULE_VERSION_DEFAULT = "1";

/** The ledger id of a lint finding: `lint_rule:<lint's own finding id>`. */
export function lintLedgerFindingId(lintFindingId: string): string {
  return findingRefId("lint_rule", lintFindingId);
}

export interface LintAcceptanceDispositionOptions {
  /** The identity provider that knows `accepted_by` (the host's, "host"). Absent: "unsigned". */
  readonly provider?: string;
  /** The person's name, when the host has it. */
  readonly displayName?: string;
  /** The copy the acceptance applies to. Absent: Main (rows were per model, and every model had only Main). */
  readonly lineageId?: string;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * One acceptance row (snake_case as stored, or the store's camelCase) as a
 * disposition. Refused in words when the row was retracted or lacks a part
 * a disposition needs; the caller logs and skips those.
 */
export function dispositionFromLintAcceptance(row: unknown, options: LintAcceptanceDispositionOptions = {}): DispositionRead {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return { ok: false, reason: "not an acceptance row" };
  const r = row as Readonly<Record<string, unknown>>;
  if (text(r.revoked_at ?? r.revokedAt ?? r.retracted_at ?? r.retractedAt)) return { ok: false, reason: "this acceptance was retracted; the finding is open" };
  const findingId = text(r.finding_id ?? r.findingId);
  const reason = text(r.reason);
  const by = text(r.accepted_by ?? r.acceptedBy);
  const at = text(r.accepted_at ?? r.acceptedAt);
  if (!findingId || !reason || !by || !at) return { ok: false, reason: "an acceptance names its finding, reason, who accepted it and when" };
  if (Number.isNaN(Date.parse(at))) return { ok: false, reason: `the acceptance time "${at}" isn't a date` };
  const author = readAuthorRef({ provider: options.provider ?? UNSIGNED_PROVIDER_ID, subject: by, kind: "person", ...(options.displayName ? { displayName: options.displayName } : {}) });
  if (!author.ok) return { ok: false, reason: `who accepted it can't be read: ${author.reason}` };
  return {
    ok: true,
    value: {
      findingId: lintLedgerFindingId(findingId),
      sourceVersion: LINT_RULE_VERSION_DEFAULT,
      action: "accepted_known",
      reason,
      by: author.value,
      at: new Date(at).toISOString(),
      scope: { lineageId: options.lineageId ?? MAIN_LINEAGE },
    },
  };
}
