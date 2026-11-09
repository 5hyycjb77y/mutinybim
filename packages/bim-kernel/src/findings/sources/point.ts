import { defineExtensionPoint } from "../../packs/contract";
import type { ModelState } from "../../types";
import type { FindingRef } from "../ref";

/**
 * Where findings come from (`kernel.finding_source` v1, round 11 D2). The
 * kernel's own producers (requirements, question holds, reliance,
 * divergences) are built-in rows; an add-on adds its own check as one row
 * with no kernel edit (`<pack>.<name>`); a host-only producer (lint runs in
 * `bim-lint`, merge waits come from the landing plan) is the same row given
 * to one ledger as a feed.
 */

export interface FindingReadContext {
  readonly model: ModelState;
  readonly lineageId: string;
}

export interface FindingChangeContext extends FindingReadContext {
  /** The model before the edit. */
  readonly previous: ModelState;
  /** Every id the edit changed or removed. */
  readonly changedIds: readonly string[];
  /** This source's findings in the ledger now, by id (before the change). */
  readonly current: ReadonlyMap<string, FindingRef>;
  /** This source's findings in the ledger now that list any of `ids` as a subject (from the ledger's subject index). */
  touching(ids: Iterable<string>): readonly FindingRef[];
}

/** What one edit did to a source's findings. `retire` drops ids (those also in `put` are replaced). */
export interface FindingChange {
  readonly retire: readonly string[];
  readonly put: readonly FindingRef[];
}

export interface FindingSourceRow {
  /** The row's id: a built-in source kind (`requirement`), or `<pack>.<name>`. */
  readonly id: string;
  /** What a person calls it ("Coordination", "Code checks"). */
  readonly label: string;
  /** Every finding of this source on the model (opening the list). */
  all(ctx: FindingReadContext): readonly FindingRef[];
  /**
   * After one edit: the change to this source's findings, or `null` when the
   * edit can't have moved any. Absent (or `"reread"`): the ledger reads `all`
   * again for this source, which is right for sources with few findings.
   */
  changed?(ctx: FindingChangeContext): FindingChange | null | "reread";
}

const builtins = new Map<string, FindingSourceRow>();
/** Stable between registrations: `PackSet.items` caches by the builtins list's identity. */
let builtinList: readonly FindingSourceRow[] = Object.freeze([]);

/** Register a built-in source row (re-registering the same id replaces it, so a module reloaded in tests stays single). */
export function registerBuiltinFindingSource(row: FindingSourceRow): void {
  builtins.set(row.id, row);
  builtinList = Object.freeze([...builtins.values()]);
}

export function builtinFindingSources(): readonly FindingSourceRow[] {
  return builtinList;
}

export const FINDING_SOURCE_POINT = defineExtensionPoint<FindingSourceRow>({
  id: "kernel.finding_source",
  version: 1,
  label: "Problem sources",
  idOf: (row) => row.id,
  builtins: builtinFindingSources,
});

/** Problems with source rows (pack conformance), in words. */
export function findingSourceRowProblems(rows: readonly FindingSourceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) out.push(`finding source ${r.id} is registered twice`);
    seen.add(r.id);
    if (r.label.trim().length === 0) out.push(`finding source ${r.id} has no label`);
    if (typeof r.all !== "function") out.push(`finding source ${r.id}: all must be a function`);
    if (r.changed !== undefined && typeof r.changed !== "function") out.push(`finding source ${r.id}: changed must be a function`);
  }
  return out;
}
