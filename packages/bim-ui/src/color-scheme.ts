import { MUTINY_PALETTE, mutinyDefaultTheme, type MutinyTheme } from "./theme";

/**
 * MutinyBIM colour scheme. `system` follows the operating system
 * (`prefers-color-scheme`); `light` and `dark` are explicit picks.
 *
 * Printed sheets and issued PDFs never read the scheme: paper stays black on white.
 */
export type MutinyColorScheme = "light" | "dark" | "system";

/** What is actually drawn once `system` is resolved. */
export type MutinyResolvedScheme = "light" | "dark";

export const MUTINY_COLOR_SCHEMES: readonly MutinyColorScheme[] = ["light", "dark", "system"];

export function isMutinyColorScheme(value: unknown): value is MutinyColorScheme {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveColorScheme(scheme: MutinyColorScheme, systemPrefersDark: boolean): MutinyResolvedScheme {
  if (scheme === "system") return systemPrefersDark ? "dark" : "light";
  return scheme;
}

/**
 * Where a host keeps the person's colour scheme, and how MutinyBIM hears about
 * changes made elsewhere (another window, the host's own settings page).
 *
 * - `get` may be async (a network read). Until it answers, the provider shows
 *   `initialColorScheme`.
 * - `set` may be async. The provider applies the pick at once; if `set` rejects,
 *   it goes back to the previous scheme and says so next to the toggle.
 * - `subscribe` is optional. Return an unsubscribe function.
 *
 * The adapter object must be stable for the provider's lifetime (module level,
 * or memoised), because the provider subscribes once per adapter.
 */
export interface ColorSchemeAdapter {
  get(): MutinyColorScheme | Promise<MutinyColorScheme>;
  set(scheme: MutinyColorScheme): void | Promise<void>;
  subscribe?(onChange: (scheme: MutinyColorScheme) => void): () => void;
}

/**
 * The open-source default: remembers the pick for this page only and starts
 * from `system`. MutinyBIM does not write browser storage itself; a host that
 * wants the choice to survive a reload passes an adapter that stores it.
 */
export function createMemoryColorSchemeAdapter(initial: MutinyColorScheme = "system"): ColorSchemeAdapter {
  let current = initial;
  const listeners = new Set<(scheme: MutinyColorScheme) => void>();
  return {
    get: () => current,
    set: (scheme) => {
      current = scheme;
      for (const listener of listeners) listener(scheme);
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** False outside a browser (server render, tests without matchMedia). */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function subscribeSystemColorScheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * The Mutiny brand in the dark: ink surfaces, cream text, the same lime accent.
 * The light theme is neutral white and gray (`mutinyDefaultTheme`); cream
 * stays here and in the logo artwork.
 * Every text pair is WCAG AA (4.5:1) or better, and focus rings, warnings and
 * on-screen strokes are at least 3:1 (`themeContrastProblems` checks this).
 * `selection` must also read on white paper, because sheets stay white in the dark.
 */
export const mutinyDarkTheme: MutinyTheme = {
  ...mutinyDefaultTheme,
  id: "mutiny-dark",
  colors: {
    surface: "#161815",
    canvas: MUTINY_PALETTE.ink,
    panel: "#22251F",
    text: MUTINY_PALETTE.cream,
    muted: "#B5B1A4",
    subtle: "#2E3129",
    field: "#22251F",
    border: "#40443A",
    accent: MUTINY_PALETTE.lime,
    accentForeground: MUTINY_PALETTE.ink,
    accentSubtle: "#353B1B",
    selection: "#7F9300",
    warning: "#E3A33A",
    danger: "#E8705A",
    dangerForeground: MUTINY_PALETTE.ink,
    focusRing: MUTINY_PALETTE.lime,
  },
  viewer: {
    background: MUTINY_PALETTE.ink,
    planBackground: "#22251F",
    selection: MUTINY_PALETTE.lime,
    selectionOutline: MUTINY_PALETTE.lime,
    hover: "#7AA5F5",
    provisional: "#E3A33A",
    edges: "#E8E2D2",
    grid: "#40443A",
    axisX: "#E8705A",
    axisY: "#7BC46F",
    axisZ: "#7AA5F5",
  },
};

/** The Mutiny base theme for a resolved scheme, before any host adapter or overrides. */
export function baseThemeFor(scheme: MutinyResolvedScheme): MutinyTheme {
  return scheme === "dark" ? mutinyDarkTheme : mutinyDefaultTheme;
}

const HEX6 = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number | null {
  const m = HEX6.exec(hex.trim());
  if (!m || !m[1]) return null;
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const r = channel(parseInt(full.slice(0, 2), 16));
  const g = channel(parseInt(full.slice(2, 4), 16));
  const b = channel(parseInt(full.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio of two hex colors (1–21). Null when either isn't hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on a background needs 4.5:1; focus rings, strokes and icons need 3:1 (WCAG 2.1 AA, 1.4.3 / 1.4.11). */
const TEXT = 4.5;
const GRAPHIC = 3;

type ColorSlot = keyof MutinyTheme["colors"];
type ViewerSlot = keyof MutinyTheme["viewer"];

const COLOR_PAIRS: readonly (readonly [ColorSlot, ColorSlot, number])[] = [
  ["text", "surface", TEXT],
  ["text", "panel", TEXT],
  ["text", "canvas", TEXT],
  ["text", "subtle", TEXT],
  ["muted", "surface", TEXT],
  ["muted", "panel", TEXT],
  ["muted", "subtle", TEXT],
  ["muted", "canvas", TEXT],
  ["text", "field", TEXT],
  ["muted", "field", TEXT],
  ["text", "accentSubtle", TEXT],
  ["accentForeground", "accent", TEXT],
  ["dangerForeground", "danger", TEXT],
  ["danger", "panel", TEXT],
  ["focusRing", "surface", GRAPHIC],
  ["focusRing", "panel", GRAPHIC],
  ["focusRing", "field", GRAPHIC],
  ["warning", "panel", GRAPHIC],
  ["selection", "canvas", GRAPHIC],
  ["selection", "surface", GRAPHIC],
  ["selection", "panel", GRAPHIC],
  ["selection", "accentSubtle", GRAPHIC],
];

const VIEWER_PAIRS: readonly (readonly [ViewerSlot, ViewerSlot, number])[] = [
  ["edges", "background", GRAPHIC],
  ["edges", "planBackground", GRAPHIC],
  ["hover", "background", GRAPHIC],
  ["selectionOutline", "background", GRAPHIC],
  ["selectionOutline", "planBackground", GRAPHIC],
];

/** Sheets stay white in every scheme, so on-screen selection strokes must read on paper too. */
const PAPER = "#FFFFFF";

/**
 * Text and control pairs in a theme that miss WCAG AA, in plain words. Empty
 * when the theme passes. Colors that aren't hex are skipped (they can't be
 * measured here).
 */
export function themeContrastProblems(theme: MutinyTheme): string[] {
  const problems: string[] = [];
  const check = (label: string, fg: string, bg: string, min: number) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio < min) problems.push(`${label}: ${ratio.toFixed(2)}:1, needs ${min}:1 (${fg} on ${bg}).`);
  };
  for (const [fg, bg, min] of COLOR_PAIRS) check(`${fg} on ${bg}`, theme.colors[fg], theme.colors[bg], min);
  for (const [fg, bg, min] of VIEWER_PAIRS) check(`viewer ${fg} on ${bg}`, theme.viewer[fg], theme.viewer[bg], min);
  check("selection on white paper", theme.colors.selection, PAPER, GRAPHIC);
  return problems;
}
