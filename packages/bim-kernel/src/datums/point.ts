import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { recordsOfKinds } from "../store";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import { KERNEL_DATUM_ROWS } from "./rows";

/**
 * Datums (contract 1.11.0, `kernel.datum` v1).
 *
 * A datum is something every placement and route tool snaps to: a level, a
 * grid axis, a reference plane, a site reference line. A row names a stored
 * kind and says, for one record, its label and the lines it gives on a level.
 * Tools ask `datumSnapLines` instead of special-casing grids.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** A line a tool snaps to on a level (model mm). */
export interface DatumSnapLine {
  readonly datumId: ElementId;
  readonly label: string;
  readonly start: Vec2;
  readonly end: Vec2;
  /** IFC grid axis family when the datum is a grid axis. */
  readonly axisFamily?: "U" | "V" | "W";
}

export interface DatumRow {
  /** The stored kind (`level`, `grid`, `reference_plane`, `zz.site_line`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  /** What a person calls one record ("Grid A", "Level 2"). */
  labelOf(el: BimElement, elements: Elements): string;
  /** Snap lines this record gives on a level; empty for a horizontal datum (a level) or when not on it. */
  snapLines(el: BimElement, elements: Elements, levelId: ElementId): readonly DatumSnapLine[];
  /** Elevation in mm when the datum is horizontal (a level). Absent: vertical. */
  elevationMm?(el: BimElement): number | null;
}

export const DATUM_POINT = defineExtensionPoint<DatumRow>({
  id: "kernel.datum",
  version: 1,
  label: "Datums",
  idOf: (row) => row.kind,
  builtins: () => KERNEL_DATUM_ROWS,
});

/** Problems with datum rows (pack conformance), in words. */
export function datumRowProblems(rows: readonly DatumRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`datum ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`datum ${row.kind} has no label`);
    for (const face of ["labelOf", "snapLines"] as const) if (typeof row[face] !== "function") out.push(`datum ${row.kind}: ${face} must be a function`);
    if (row.elevationMm !== undefined && typeof row.elevationMm !== "function") out.push(`datum ${row.kind}: elevationMm must be a function`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, DatumRow> => new Map(set.items(DATUM_POINT).map((r) => [r.kind, r] as const));

export function datumRow(kind: string): DatumRow | null {
  return activePackSet().memo("kernel.datum#table", tableOf).get(kind) ?? null;
}

/** Every datum snap line on a level, from every datum row in force, read through the per-kind index. */
export function datumSnapLines(model: ModelState, levelId: ElementId): DatumSnapLine[] {
  const table = activePackSet().memo("kernel.datum#table", tableOf);
  if (table.size === 0) return [];
  const out: DatumSnapLine[] = [];
  for (const el of recordsOfKinds(model.elements, [...table.keys()])) {
    const row = table.get(el.kind);
    if (row) out.push(...row.snapLines(el, model.elements, levelId));
  }
  return out;
}
