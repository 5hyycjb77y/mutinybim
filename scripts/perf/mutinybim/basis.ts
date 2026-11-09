/**
 * Round 11 lane G11 perf row `basis.read_map.schedule.250k`: a schedule
 * column over every row of the 250k synthetic. "Before" is the column a
 * schedule can show today about where a value came from (`provenance.source`,
 * or "not recorded"); "after" is the one confidence column read through
 * `readBasis` (stored basis first, then the old ladders read-mapped, else
 * "not recorded"). Both walk the same rows in the same order, so the
 * difference is the read-map's own cost. No stored byte changes.
 */
import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { readBasis } from "../../../packages/bim-kernel/src/basis/read";

export interface ColumnRun {
  readonly rows: number;
  readonly ms: number;
  /** How many rows read something other than "not recorded". */
  readonly recorded: number;
}

function provenanceSource(el: BimElement): string | null {
  if (!("provenance" in el)) return null;
  const p: unknown = el.provenance;
  if (typeof p !== "object" || p === null || !("source" in p)) return null;
  return typeof p.source === "string" ? p.source : null;
}

/** Today's column: `provenance.source` per row, "not recorded" when absent. */
export function plainSourceColumn(model: ModelState): ColumnRun {
  const t = performance.now();
  let rows = 0;
  let recorded = 0;
  const out: string[] = [];
  for (const id in model.elements) {
    const el = model.elements[id];
    if (!el) continue;
    rows += 1;
    const s = provenanceSource(el);
    if (s !== null) recorded += 1;
    out.push(s ?? "not recorded");
  }
  return { rows, ms: performance.now() - t, recorded: out.length === rows ? recorded : -1 };
}

/** The confidence column: `readBasis` per row (inference off, as shipped). */
export function basisColumn(model: ModelState): ColumnRun {
  const t = performance.now();
  let rows = 0;
  let recorded = 0;
  const out: string[] = [];
  for (const id in model.elements) {
    const el = model.elements[id];
    if (!el) continue;
    rows += 1;
    const r = readBasis(el);
    if (r.known) recorded += 1;
    out.push(r.known ? r.basis.maturity : r.words);
  }
  return { rows, ms: performance.now() - t, recorded: out.length === rows ? recorded : -1 };
}
