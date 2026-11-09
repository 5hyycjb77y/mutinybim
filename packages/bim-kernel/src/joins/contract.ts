import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ElementId, Vec2 } from "../types";
import { KERNEL_LINE_JOIN_ROWS } from "./rows";

/**
 * Line-element joins (contract 1.11.0, `kernel.line_join` v1).
 *
 * A line-placed kind (a wall; later a beam, curb, parapet or fence) says how
 * its ends meet others: which styles it allows, its priority (the higher
 * runs through, the lower is trimmed) and which layer cleans up. The join
 * result is derived, never stored. "Disallow join" is an instance value.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const JOIN_STYLES = ["butt", "miter"] as const;
export type JoinStyle = (typeof JOIN_STYLES)[number];

/** The instance value, per end, that stops an end joining. */
export const DISALLOW_JOIN_KEYS = { start: "join.disallow_start", end: "join.disallow_end" } as const;

export interface LineJoinRow {
  /** The stored kind (`wall`, `zz.curtain_wall`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  /** Styles it allows, the default first. */
  readonly styles: readonly JoinStyle[];
  /** The line's two ends and width for one record (model mm); null when not line-placed. */
  line(el: BimElement, elements: Elements): { readonly start: Vec2; readonly end: Vec2; readonly widthMm: number; readonly levelId: ElementId } | null;
  /** Higher runs through at a butt join. */
  priority(el: BimElement, elements: Elements): number;
  /** Which layer cleans up at a join (a layer function from the type's layers, "core"); absent: the whole width. */
  readonly cleanupLayer?: string;
  /** Kinds it joins with besides its own. Absent: its own kind only. */
  readonly joinsWith?: readonly string[];
  /**
   * The record with its line moved to `start` → `end` (the same line `line`
   * reads), every stored copy of the line agreeing. With it, an end joined to
   * a moved element follows it (`joins/carry.ts`); absent, its ends stay put.
   */
  withLine?(el: BimElement, line: { readonly start: Vec2; readonly end: Vec2 }, elements: Elements): BimElement;
}

export const LINE_JOIN_POINT = defineExtensionPoint<LineJoinRow>({
  id: "kernel.line_join",
  version: 1,
  label: "Line-element joins",
  idOf: (row) => row.kind,
  builtins: () => KERNEL_LINE_JOIN_ROWS,
});

/** How one end is cleaned up (derived). */
export interface EndCleanup {
  readonly elementId: ElementId;
  readonly end: "start" | "end";
  readonly style: JoinStyle | "tee" | "cross" | "free";
  /** The other elements met at that end. */
  readonly with: readonly ElementId[];
  /** The trimmed plan outline of this element near the end (model mm). */
  readonly outline: readonly Vec2[];
}

/** Problems with line join rows (pack conformance), in words. */
export function lineJoinRowProblems(rows: readonly LineJoinRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`line join ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`line join ${row.kind} has no label`);
    if (row.styles.length === 0) out.push(`line join ${row.kind} names no join style`);
    for (const s of row.styles) if (!(JOIN_STYLES as readonly string[]).includes(s)) out.push(`line join ${row.kind}: unknown style ${String(s)}`);
    for (const face of ["line", "priority"] as const) if (typeof row[face] !== "function") out.push(`line join ${row.kind}: ${face} must be a function`);
    if (row.withLine !== undefined && typeof row.withLine !== "function") out.push(`line join ${row.kind}: withLine must be a function`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, LineJoinRow> => new Map(set.items(LINE_JOIN_POINT).map((r) => [r.kind, r] as const));

export function lineJoinRow(kind: string): LineJoinRow | null {
  return activePackSet().memo("kernel.line_join#table", tableOf).get(kind) ?? null;
}
