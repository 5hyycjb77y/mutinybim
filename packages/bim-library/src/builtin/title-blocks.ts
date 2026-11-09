import { titleBlockDefinitionSchema, type TitleBlockDefinition, type TitleBlockLogo, type TitleBlockSlot } from "@permitzip/bim-kernel";
import type { TitleBlockItem } from "../items/sheet-items";

/**
 * MutinyBIM's own title blocks, shipped with the open-source library so a
 * fresh install prints a complete, branded permit-set strip on day one. No
 * firm's content: the firm line prints the project's Firm parameter, the
 * consultants and engineer of record come from the project's parameters, and
 * the footer names only MutinyBIM. A firm swaps in its own (a host library
 * row) from Settings › MutinyBIM library › Title blocks.
 *
 * Liberation Sans (SIL OFL), which MutinyBIM already serves for sheet notes.
 * The mark is the MutinyBIM icon redrawn as vector: a lime block with dark
 * bands and its shadow face, turned 24°. Every value prints in ink, so a
 * black-only plot reads in full.
 */

const FONT_BASE = "/mutinybim/fonts/";
const INK = "#1C1E1B";
const LABEL = "#5B6157";
const LIME = "#D4E83A";
/** The accent rule: the lime, darkened so it reads on white paper. */
const ACCENT = "#9DB01C";
const TINT = "#F4F7E1";
const IN = 25.4;

const FONTS: TitleBlockDefinition["fonts"] = {
  display: { family: "Liberation Sans", weight: 700, file: `${FONT_BASE}LiberationSans-Bold.ttf`, capHeight: 0.716 },
  displayBold: { family: "Liberation Sans", weight: 700, file: `${FONT_BASE}LiberationSans-Bold.ttf`, capHeight: 0.716 },
  body: { family: "Liberation Sans", weight: 400, file: `${FONT_BASE}LiberationSans-Regular.ttf`, capHeight: 0.716 },
};

/** The logo box, mm: the mark in its left square, the word mark beside it. */
const LOGO_W = 66;
const LOGO_H = 12;

/** A point of the 64-unit icon, turned 24° about its middle, as a 0–1 point of the logo box. */
function iconPoint(x: number, y: number): { x: number; y: number } {
  const a = (24 * Math.PI) / 180;
  const dx = x - 32;
  const dy = y - 32;
  const rx = 32 + dx * Math.cos(a) - dy * Math.sin(a);
  const ry = 32 + dx * Math.sin(a) + dy * Math.cos(a);
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
  return { x: clamp(((rx / 64) * LOGO_H) / LOGO_W), y: clamp(ry / 64) };
}

const rectShape = (x0: number, y0: number, x1: number, y1: number, color: string) => ({ color, points: [iconPoint(x0, y0), iconPoint(x1, y0), iconPoint(x1, y1), iconPoint(x0, y1)] });

const LOGO: TitleBlockLogo = {
  widthMm: LOGO_W,
  heightMm: LOGO_H,
  shapes: [
    // The block's shadow face, then the block (a dark outline under the lime face), then its bands.
    { color: INK, points: [iconPoint(46, 15), iconPoint(55, 21), iconPoint(55, 54), iconPoint(46, 49)] },
    rectShape(7.5, 13.5, 47.5, 50.5, INK),
    rectShape(10.5, 16.5, 44.5, 47.5, LIME),
    rectShape(19, 15, 23, 49, INK),
    rectShape(34, 15, 38, 49, INK),
    rectShape(9, 25, 46, 26.1, INK),
    rectShape(9, 32, 46, 33.1, INK),
    rectShape(9, 39, 46, 40.1, INK),
  ],
  words: [
    { text: "MUTINY", x: 0.21, y: 0.78, cap: 0.55, anchor: "start", font: "displayBold", color: INK },
    { text: "BIM", x: 0.76, y: 0.78, cap: 0.55, anchor: "start", font: "body", color: LABEL },
  ],
};

const CONSULTANT_ROLES = [
  { key: "owner", label: "Owner" },
  { key: "architect", label: "Architect" },
  { key: "structural", label: "Structural" },
  { key: "civil", label: "Civil" },
];

const FOOTER = "Drawn with MutinyBIM. Do not scale drawings; dimensions govern.";

function slots(size: "e1" | "d"): TitleBlockSlot[] {
  const e1 = size === "e1";
  return [
    { kind: "firm", heightMm: e1 ? 30 : 28, logo: LOGO, lines: [] },
    { kind: "project", heightMm: e1 ? 40 : 38 },
    { kind: "consultants", heightMm: e1 ? 34 : 32, roles: CONSULTANT_ROLES },
    { kind: "key_plan", heightMm: 2 * IN + 14, boxMm: { x: 3 * IN, y: 2 * IN }, northArrow: true },
    { kind: "seal", heightMm: 3 * IN + 28, squareMm: 3 * IN },
    { kind: "revisions" },
    { kind: "sheet_data", heightMm: e1 ? 26 : 24 },
    { kind: "qr", heightMm: e1 ? 28 : 26 },
    { kind: "sheet_id", heightMm: e1 ? 50 : 44, titleCapMm: 4, numberCapMm: e1 ? 13 : 11 },
    { kind: "footer", heightMm: 10, text: FOOTER },
  ];
}

function definition(size: "e1" | "d"): TitleBlockDefinition {
  const e1 = size === "e1";
  return titleBlockDefinitionSchema.parse({
    schema: 1,
    paperName: e1 ? "ARCH E1" : "ARCH D",
    paperMm: e1 ? { x: 42 * IN, y: 30 * IN } : { x: 36 * IN, y: 24 * IN },
    marginsMm: { top: 0.5 * IN, right: 0.5 * IN, bottom: 0.5 * IN, left: 1.5 * IN },
    stripWidthMm: e1 ? 4 * IN : 3.5 * IN,
    colors: { ink: INK, label: LABEL, accent: ACCENT, tint: TINT },
    fonts: FONTS,
    lines: { borderMm: 0.7, dividerMm: 0.35, ruleMm: 0.18, accentRuleMm: 0.7 },
    slots: slots(size),
  });
}

export const MUTINYBIM_TITLE_BLOCK_D_ID = "mutinybim:title_block:arch_d";
export const MUTINYBIM_TITLE_BLOCK_E1_ID = "mutinybim:title_block:arch_e1";

/** MutinyBIM's two title blocks as built-in library items. */
export function mutinybimTitleBlockItems(): TitleBlockItem[] {
  return [
    { id: MUTINYBIM_TITLE_BLOCK_D_ID, revision: 1, key: "mutinybim:arch_d", name: "MutinyBIM 24×36", paperSizes: ["ARCH D"], definition: definition("d") },
    { id: MUTINYBIM_TITLE_BLOCK_E1_ID, revision: 1, key: "mutinybim:arch_e1", name: "MutinyBIM 30×42", paperSizes: ["ARCH E1"], definition: definition("e1") },
  ];
}
