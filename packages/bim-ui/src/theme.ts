/**
 * MutinyBIM theme contract. Hosts map their own design tokens onto this shape;
 * every MutinyBIM surface (shell, vendored UI, 3D viewer, sheet editor overlay)
 * reads colors from here, never from host constants.
 *
 * Printed sheets and issued PDFs never read the theme: paper stays black on white.
 */

/** A `#rrggbb` color. The 3D viewer needs parseable hex, so viewer slots are hex only. */
export type HexColor = `#${string}`;

export interface MutinyColors {
  /** App background behind panels. */
  readonly surface: string;
  /** The drawing / model area behind the canvas. */
  readonly canvas: string;
  /** Raised panels, ribbons, popovers. */
  readonly panel: string;
  /** Primary text. */
  readonly text: string;
  /** Secondary text. */
  readonly muted: string;
  /** Muted fills (hover rows, chips). */
  readonly subtle: string;
  /** Input fields, menus and popovers. */
  readonly field: string;
  readonly border: string;
  /** Primary action fill. Never text on a light surface: it is a fill with `accentForeground` on it. */
  readonly accent: string;
  /** Text on `accent`. */
  readonly accentForeground: string;
  /** A pressed tool or chosen item's background. Pair it with a `selection` edge: the tint alone is too faint to show state. */
  readonly accentSubtle: string;
  /** On-screen selection strokes and labels in 2D editors, and the active-tab bar (must read on white paper). */
  readonly selection: string;
  readonly warning: string;
  readonly danger: string;
  /** Text on `danger`. */
  readonly dangerForeground: string;
  readonly focusRing: string;
}

export interface MutinyViewerColors {
  readonly background: HexColor;
  readonly planBackground: HexColor;
  /** Fill of a selected object. */
  readonly selection: HexColor;
  /** Edges of a selected object, the crop box and the orbit point: `selection` can be too light to read on `background`. */
  readonly selectionOutline: HexColor;
  /** Hover pre-highlight before a click selects. */
  readonly hover: HexColor;
  readonly provisional: HexColor;
  readonly edges: HexColor;
  readonly grid: HexColor;
  readonly axisX: HexColor;
  readonly axisY: HexColor;
  readonly axisZ: HexColor;
}

export interface MutinyTypography {
  readonly fontHeading: string;
  readonly fontBody: string;
  readonly fontMono: string;
  readonly headingWeight: number;
}

export interface MutinyBrand {
  readonly productName: string;
  /** Full illustrated logo (splash). Omit to show the built-in wordmark only. */
  readonly logoUrl?: string;
  /** Square icon mark. Omit to use the built-in vector crate. */
  readonly iconUrl?: string;
}

export interface MutinyTheme {
  readonly id: string;
  readonly colors: MutinyColors;
  readonly viewer: MutinyViewerColors;
  readonly typography: MutinyTypography;
  readonly radius: string;
  readonly brand: MutinyBrand;
}

export interface MutinyThemeOverrides {
  readonly id?: string;
  readonly colors?: Partial<MutinyColors>;
  readonly viewer?: Partial<MutinyViewerColors>;
  readonly typography?: Partial<MutinyTypography>;
  readonly radius?: string;
  readonly brand?: Partial<MutinyBrand>;
}

/**
 * Brand palette: logo charcoal, electric lime, and the neutral whites and grays
 * of the light app. Cream and ink belong to the logo artwork and the dark theme.
 */
export const MUTINY_PALETTE = {
  cream: "#FBF6EA",
  ink: "#1C1E1B",
  charcoal: "#182126",
  slate: "#626C73",
  lime: "#D7E620",
  /** Lime darkened to read as a line or label on white (5.9:1). */
  olive: "#5C6B00",
  paleLime: "#F2F6D4",
  softWhite: "#FBFBFB",
  lightGray: "#F2F3F4",
  paleGray: "#DDE1E4",
  white: "#FFFFFF",
} as const satisfies Record<string, HexColor>;

export const mutinyDefaultTheme: MutinyTheme = {
  id: "mutiny-default",
  colors: {
    surface: MUTINY_PALETTE.softWhite,
    canvas: MUTINY_PALETTE.lightGray,
    panel: MUTINY_PALETTE.lightGray,
    text: MUTINY_PALETTE.charcoal,
    muted: MUTINY_PALETTE.slate,
    subtle: "#E9ECEE",
    field: MUTINY_PALETTE.white,
    border: MUTINY_PALETTE.paleGray,
    accent: MUTINY_PALETTE.lime,
    accentForeground: MUTINY_PALETTE.charcoal,
    accentSubtle: MUTINY_PALETTE.paleLime,
    selection: MUTINY_PALETTE.olive,
    warning: "#B7790E",
    danger: "#B8402C",
    dangerForeground: MUTINY_PALETTE.white,
    focusRing: MUTINY_PALETTE.charcoal,
  },
  viewer: {
    background: MUTINY_PALETTE.lightGray,
    planBackground: MUTINY_PALETTE.white,
    selection: MUTINY_PALETTE.lime,
    selectionOutline: MUTINY_PALETTE.olive,
    hover: "#2F5FBF",
    provisional: "#E3A33A",
    edges: MUTINY_PALETTE.charcoal,
    grid: MUTINY_PALETTE.paleGray,
    axisX: "#C8402F",
    axisY: "#3E8A3A",
    axisZ: "#2F5FBF",
  },
  typography: {
    fontHeading: "'Roboto Slab', 'Zilla Slab', Rockwell, 'Courier New', Georgia, serif",
    fontBody: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontMono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    headingWeight: 800,
  },
  radius: "0.375rem",
  brand: { productName: "MutinyBIM" },
};

export function mergeTheme(base: MutinyTheme, overrides: MutinyThemeOverrides | undefined): MutinyTheme {
  if (!overrides) return base;
  return {
    id: overrides.id ?? base.id,
    colors: { ...base.colors, ...overrides.colors },
    viewer: { ...base.viewer, ...overrides.viewer },
    typography: { ...base.typography, ...overrides.typography },
    radius: overrides.radius ?? base.radius,
    brand: { ...base.brand, ...overrides.brand },
  };
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The CSS custom properties a MutinyBIM root carries. All names start with `--mutiny-`. */
export function themeToCssVars(theme: MutinyTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) vars[`--mutiny-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(theme.viewer)) vars[`--mutiny-viewer-${kebab(key)}`] = value;
  vars["--mutiny-font-heading"] = theme.typography.fontHeading;
  vars["--mutiny-font-body"] = theme.typography.fontBody;
  vars["--mutiny-font-mono"] = theme.typography.fontMono;
  vars["--mutiny-heading-weight"] = String(theme.typography.headingWeight);
  vars["--mutiny-radius"] = theme.radius;
  return vars;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): value is HexColor {
  return HEX.test(value);
}

/** Problems with a theme a host built, in plain words. Empty when the theme is usable. */
export function themeProblems(theme: MutinyTheme): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(theme.viewer)) {
    if (!isHexColor(value)) problems.push(`Viewer color "${key}" must be a #rrggbb color, got "${value}".`);
  }
  for (const [key, value] of Object.entries(theme.colors)) {
    if (value.trim() === "") problems.push(`Color "${key}" is empty.`);
  }
  if (theme.brand.productName.trim() === "") problems.push("Brand product name is empty.");
  return problems;
}
