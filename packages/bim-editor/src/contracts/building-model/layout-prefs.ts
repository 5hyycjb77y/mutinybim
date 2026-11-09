import type { BimJson } from "../bim/json";

/**
 * How a person left one Building Model screen area (the rail, Properties):
 * which sections are collapsed and the panel width. Stored per person in
 * `public.bim_ui_layout_prefs`, never in browser storage.
 */
export interface LayoutSurfacePrefs {
  readonly surface: string;
  /** Section id → true when collapsed. A section with no entry uses its default. */
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly widthPx: number | null;
}

/** Mirrors the table's check on `surface`. */
export const LAYOUT_SURFACE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
/** Mirrors the table's check on `width_px`. */
export const LAYOUT_WIDTH_MIN_PX = 160;
export const LAYOUT_WIDTH_MAX_PX = 960;

/** The stored columns this reads; `lib/bim/editor-shape-checks.ts` holds them to the table's generated row. */
export type LayoutPrefRow = { readonly surface: string; readonly collapsed: BimJson; readonly width_px: number | null };

function collapsedMap(value: BimJson): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, flag] of Object.entries(value)) if (typeof flag === "boolean") out[key] = flag;
  return out;
}

export function parseLayoutPrefRows(rows: readonly LayoutPrefRow[]): LayoutSurfacePrefs[] {
  return rows.map((row) => ({ surface: row.surface, collapsed: collapsedMap(row.collapsed), widthPx: row.width_px }));
}

export function clampLayoutWidth(px: number): number {
  return Math.round(Math.min(LAYOUT_WIDTH_MAX_PX, Math.max(LAYOUT_WIDTH_MIN_PX, px)));
}
