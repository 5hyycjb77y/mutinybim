// No Node modules here (no fs, crypto or PDF code): browser code imports this through
// `@permitzip/bim-sheets/reissue-check`.
import { dispositionAnswers, relianceFindingId, type ContextStanding, type FindingDisposition, type Sheet } from "@permitzip/bim-kernel";

// ---------------------------------------------------------------------------
// C10 — issue-time check: a sheet carrying an approval that was checked
// against an older rule is issued again only after that approval's signer
// re-checks and signs, or records an override with a reason. Old approvals
// with no checking context recorded never block. Issued sets never change.
// ---------------------------------------------------------------------------

/** One approval a sheet carries, as the host reads it from the sign-off log. */
export interface SheetApproval {
  readonly sheetId: string;
  readonly recordId: string;
  readonly signer: string;
  readonly signerName: string;
  /** `contextStanding(readCheckingContext(payload), current)`. */
  readonly standing: ContextStanding;
  /** Overrides on the log (`readFindingDisposition` of `finding_disposition` records). */
  readonly dispositions?: readonly FindingDisposition[];
  /** The signer can still act (on the project, licence on record). False: someone else signs a new approval. */
  readonly signerCanAct?: boolean;
}

export interface BlockedApproval {
  readonly sheetId: string;
  readonly sheetNumber: string;
  readonly recordId: string;
  readonly signer: string;
  readonly signerName: string;
  /** "Checked against an older rule", with the rules named. */
  readonly words: string;
  /** What can clear it: the signer re-checks and signs, or overrides with a reason; or (signer gone) someone signs a new approval. */
  readonly choices: readonly ("recheck" | "override" | "new_approval")[];
  /** The finding an override answers, and the version it must name. */
  readonly findingId: string;
  readonly sourceVersion: string;
}

export interface ReissueCheck {
  readonly ok: boolean;
  readonly blocked: readonly BlockedApproval[];
  /** "Issue blocked: 2 approvals were checked against an older rule". */
  readonly words: string | null;
  /** Sheet approvals that read "Checking context not recorded" (they don't block). */
  readonly notRecorded: number;
}

/**
 * Whether a set may be issued again, sheet by sheet. Each affected signer's
 * approval blocks on its own (several signers: each must act). O(approvals).
 */
export function reissueCheck(sheets: ReadonlyArray<Pick<Sheet, "id" | "number">>, approvals: readonly SheetApproval[]): ReissueCheck {
  const numbers = new Map<string, string>(sheets.map((s) => [String(s.id), s.number]));
  const blocked: BlockedApproval[] = [];
  let notRecorded = 0;
  for (const a of approvals) {
    const number = numbers.get(a.sheetId);
    if (number === undefined) continue;
    if (a.standing.state === "not_recorded") {
      notRecorded += 1;
      continue;
    }
    if (a.standing.state !== "older") continue;
    const findingId = relianceFindingId(a.recordId);
    const { sourceVersion } = a.standing;
    if ((a.dispositions ?? []).some((d) => dispositionAnswers(d, findingId, sourceVersion) && d.by.subject === a.signer)) continue;
    const rules = a.standing.items.map((i) => i.words);
    blocked.push({
      sheetId: a.sheetId,
      sheetNumber: number,
      recordId: a.recordId,
      signer: a.signer,
      signerName: a.signerName,
      words: `${a.standing.words}: ${rules.slice(0, 2).join("; ")}${rules.length > 2 ? `; and ${rules.length - 2} more` : ""}`,
      choices: a.signerCanAct === false ? ["new_approval"] : ["recheck", "override"],
      findingId,
      sourceVersion,
    });
  }
  const n = new Set(blocked.map((b) => b.recordId)).size;
  return { ok: n === 0, blocked, words: n === 0 ? null : `Issue blocked: ${n} approval${n === 1 ? " was" : "s were"} checked against an older rule`, notRecorded };
}
