import type { ModelState } from "../../types";
import { LINT_RULE_VERSION_DEFAULT, lintLedgerFindingId } from "../lint-acceptance";
import { findingRefId, findingSubjects, findingWords, localFindingId, type FindingRef, type FindingSeverity } from "../ref";
import type { FindingChange, FindingSourceRow } from "./point";

/**
 * Producers that run outside the kernel, plugged into one ledger as feeds.
 *
 * Lint (clash, clearance, systems, documents) runs in `bim-lint`, which
 * depends on the kernel, so the kernel reads its findings by shape
 * (`LintFindingLike` is a subset of `bim-lint`'s `Finding`). The ledger never
 * runs lint itself: after an edit the host hands it the before and after
 * findings in the edit's scope it already computed for the lint block
 * (`lintFindingChange`), so the ledger's cost on top of lint's own row is the
 * index update only.
 *
 * Merge waits come from the model server's landing plan (`PartVerdict`
 * shape), per branch.
 */

/** What the ledger reads of a lint finding (`bim-lint`'s `Finding`). */
export interface LintFindingLike {
  readonly id: string;
  readonly rule: string;
  readonly severity: "error" | "warning" | "info" | (string & {});
  readonly elementIds: readonly string[];
  readonly linked?: ReadonlyArray<{ readonly globalId: string }>;
  readonly message: string;
  readonly fix?: { readonly tool: string; readonly hint: string };
  /** The rule's version (absent: "1", every rule before round 11). */
  readonly ruleVersion?: string;
}

const LINT_SEVERITY: Readonly<Record<string, FindingSeverity>> = { error: "blocking", warning: "warning", info: "info" };

export function lintFindingRef(f: LintFindingLike, model: { readonly revision: number }, lineageId: string): FindingRef {
  return {
    id: lintLedgerFindingId(f.id),
    source: { kind: "lint_rule", id: f.rule, version: f.ruleVersion ?? LINT_RULE_VERSION_DEFAULT },
    severity: LINT_SEVERITY[f.severity] ?? f.severity,
    subjects: findingSubjects(f.linked && f.linked.length > 0 ? [...f.elementIds, ...f.linked.map((l) => `linked:${l.globalId}`)] : f.elementIds),
    lineageId,
    revision: model.revision,
    words: findingWords(f.message),
    ...(f.fix ? { fix: { commandHint: f.fix.tool } } : {}),
  };
}

function sameLint(a: LintFindingLike, b: LintFindingLike): boolean {
  return a.message === b.message && a.severity === b.severity && a.ruleVersion === b.ruleVersion && a.fix?.tool === b.fix?.tool;
}

/**
 * One edit's lint change from the scope's findings before and after: the
 * ones gone are retired, the new and changed ones are put. A finding the same
 * before and after is left as the ledger holds it (most of a scope).
 */
export function lintFindingChange(was: readonly LintFindingLike[], now: readonly LintFindingLike[], model: { readonly revision: number }, lineageId: string): FindingChange {
  const before = new Map<string, LintFindingLike>();
  for (const f of was) before.set(f.id, f);
  const retire: string[] = [];
  const put: FindingRef[] = [];
  const kept = new Set<string>();
  for (const f of now) {
    kept.add(f.id);
    const had = before.get(f.id);
    if (had && sameLint(had, f)) continue;
    put.push(lintFindingRef(f, model, lineageId));
  }
  for (const f of was) if (!kept.has(f.id)) retire.push(lintLedgerFindingId(f.id));
  return { retire, put };
}

/**
 * The lint feed for one ledger. `all`: the host's full check of the model
 * (`bim_lint_check`). After an edit the host passes `lintFindingChange` to
 * `FindingLedger.apply` (`given`), so `changed` is never called for lint; a
 * host that has no lint change for an edit leaves lint's findings as they
 * were.
 */
export function lintFindingSource(all: (model: ModelState) => readonly LintFindingLike[]): FindingSourceRow {
  return {
    id: "lint_rule",
    label: "Coordination",
    all: (ctx) => all(ctx.model).map((f) => lintFindingRef(f, ctx.model, ctx.lineageId)),
    changed: () => null,
  };
}

/** Why a merge part can't land yet (`PartWait`'s shape). */
export type PartWaitLike =
  | { readonly kind: "conflict"; readonly elementIds: readonly string[] }
  | { readonly kind: "approval"; readonly waitingFor: readonly string[] }
  | { readonly kind: "no_lead" }
  | { readonly kind: "depends_on"; readonly discipline: string; readonly elementId: string; readonly on: string }
  | { readonly kind: string & {} };

export interface PartVerdictLike {
  readonly part: { readonly discipline: string; readonly elementIds: readonly string[] };
  readonly lands: boolean;
  readonly waits: readonly PartWaitLike[];
  readonly words: string | null;
}

function waitSubjects(w: PartWaitLike, part: PartVerdictLike["part"]): string[] {
  if (w.kind === "conflict" && "elementIds" in w) return [...w.elementIds];
  if (w.kind === "depends_on" && "elementId" in w) return [w.elementId, w.on];
  return [...part.elementIds];
}

function waitLocalId(branchId: string, discipline: string, w: PartWaitLike): string {
  if (w.kind === "depends_on" && "elementId" in w) return localFindingId(`${branchId}:${discipline}:depends_on`, [w.elementId, w.on]);
  if (w.kind === "conflict" && "elementIds" in w) return localFindingId(`${branchId}:${discipline}:conflict`, w.elementIds);
  return `${branchId}:${discipline}:${w.kind}`;
}

/** A landing plan's waits as findings on the branch's copy (blocking: the part doesn't land). */
export function mergeWaitFindings(branchId: string, verdicts: readonly PartVerdictLike[], at: { readonly revision: number; readonly lineageId: string }): FindingRef[] {
  const out: FindingRef[] = [];
  for (const v of verdicts) {
    if (v.lands) continue;
    for (const w of v.waits) {
      out.push({
        id: findingRefId("merge", waitLocalId(branchId, v.part.discipline, w)),
        source: { kind: "merge", id: branchId, version: "1" },
        severity: "blocking",
        subjects: findingSubjects(waitSubjects(w, v.part)),
        lineageId: at.lineageId,
        revision: at.revision,
        words: findingWords(v.words ?? `The ${v.part.discipline} part of this branch is waiting`),
      });
    }
  }
  return out;
}

/** The merge-wait feed: the host's current landing plans, by branch. */
export function mergeWaitSource(plans: () => ReadonlyArray<{ readonly branchId: string; readonly verdicts: readonly PartVerdictLike[] }>): FindingSourceRow {
  return {
    id: "merge",
    label: "Merges waiting",
    all: (ctx) => plans().flatMap((p) => mergeWaitFindings(p.branchId, p.verdicts, { revision: ctx.model.revision, lineageId: ctx.lineageId })),
  };
}
