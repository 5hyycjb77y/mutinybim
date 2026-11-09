import { z } from "zod";
import { NOTE_FONT_CODEPOINTS } from "./font-metrics.generated";

/**
 * Rich text notes: the structured content of a note on a sheet or in a detail
 * view. Stored in the model as JSON (never HTML), so it syncs, conflicts and
 * undoes like every other document element, and the one layout engine
 * (`./text-layout`) draws it identically on screen and in the PDF.
 *
 * A note is a box: its top-left corner is the drawing item's point (paper mm
 * on a sheet, model mm in a detail view), its width and optional fixed height
 * are paper mm, and it may be rotated about that corner. Inside are
 * paragraphs of runs. Text sizes are cap heights in paper mm, the drafting
 * convention (3/32" = 2.38 mm).
 */

/** Fonts a note may use. Each has regular, bold, italic and bold italic faces shipped with the sheets package. */
export const NOTE_FONT_FAMILIES = ["sans"] as const;
export type NoteFontFamily = (typeof NOTE_FONT_FAMILIES)[number];

export const NOTE_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type NoteAlign = (typeof NOTE_ALIGNMENTS)[number];

export const NOTE_LIST_KINDS = ["bullet", "numbered"] as const;
export type NoteListKind = (typeof NOTE_LIST_KINDS)[number];

/** Limits: a big general-notes block fits; anything past these is refused with the reason. */
export const NOTE_LIMITS = {
  maxParagraphs: 400,
  maxRunsPerParagraph: 200,
  maxRuns: 4000,
  maxChars: 20000,
  maxRunChars: 5000,
  minSizeMm: 0.8,
  maxSizeMm: 50,
  minWidthMm: 5,
  maxWidthMm: 1200,
  minHeightMm: 2,
  maxHeightMm: 1200,
  minLineSpacing: 0.8,
  maxLineSpacing: 3,
  maxListLevel: 4,
  maxListStart: 9999,
} as const;

/** Default cap height (3/32") and the sizes the format bar offers. */
export const DEFAULT_NOTE_SIZE_MM = 2.38;
export const NOTE_SIZE_CHOICES: ReadonlyArray<{ readonly mm: number; readonly label: string }> = [
  { mm: 1.59, label: '1/16"' },
  { mm: 2.38, label: '3/32"' },
  { mm: 3.18, label: '1/8"' },
  { mm: 4.76, label: '3/16"' },
  { mm: 6.35, label: '1/4"' },
  { mm: 9.53, label: '3/8"' },
];

export interface NoteRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  /** Cap height, paper mm. Absent: the note's size. */
  readonly size?: number;
  readonly font?: NoteFontFamily;
  /** "#rrggbb". Absent: black. */
  readonly color?: string;
}

export interface NoteList {
  readonly kind: NoteListKind;
  /** 0 = outermost. */
  readonly level: number;
  /** Numbered lists: restart the count here. */
  readonly start?: number;
}

export interface NoteParagraph {
  readonly runs: readonly NoteRun[];
  readonly align?: NoteAlign;
  readonly list?: NoteList;
}

/** Where the note's box sits and how it is sized. Lengths in paper mm; rotation in degrees, clockwise on paper. */
export interface NoteBox {
  readonly width: number;
  /** Fixed height; null grows with the text. */
  readonly height: number | null;
  readonly rotation: number;
}

export interface NoteLeader {
  /** Where the arrow points, in the owner's coordinates (paper mm on a sheet, model mm in a view). */
  readonly to: { readonly x: number; readonly y: number };
  /** A bend on the way, same coordinates (an elbowed leader). */
  readonly elbow?: { readonly x: number; readonly y: number };
  /** Arrowhead; absent: an open arrow. */
  readonly arrow?: "arrow" | "dot" | "tick" | "none";
}

export interface RichTextNote {
  /** paper: on a sheet; model: in a detail view (the box stays paper-sized, like any annotation). */
  readonly space: "paper" | "model";
  readonly box: NoteBox;
  readonly paragraphs: readonly NoteParagraph[];
  /** Multiple of the font's natural line height. */
  readonly lineSpacing: number;
  readonly leader?: NoteLeader;
  /** More leaders from the same note (one note pointing at several things). */
  readonly leaders?: readonly NoteLeader[];
}

const SUPPORTED: ReadonlySet<number> = new Set(NOTE_FONT_CODEPOINTS);
/** Hard line break inside a paragraph (Shift+Enter). */
export const LINE_BREAK = "\n";

/** Characters the note font cannot print, in order of first appearance (a line break is allowed). */
export function unsupportedCharacters(text: string): string[] {
  const bad: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === LINE_BREAK || SUPPORTED.has(cp)) continue;
    if (!bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must be #rrggbb");
const sizeMm = z.number().finite().min(NOTE_LIMITS.minSizeMm).max(NOTE_LIMITS.maxSizeMm);

export const noteRunSchema = z
  .object({
    text: z.string().max(NOTE_LIMITS.maxRunChars),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    size: sizeMm.optional(),
    font: z.enum(NOTE_FONT_FAMILIES).optional(),
    color: hexColor.optional(),
  })
  .strict();

export const noteListSchema = z
  .object({
    kind: z.enum(NOTE_LIST_KINDS),
    level: z.number().int().min(0).max(NOTE_LIMITS.maxListLevel),
    start: z.number().int().min(1).max(NOTE_LIMITS.maxListStart).optional(),
  })
  .strict();

export const noteParagraphSchema = z
  .object({
    runs: z.array(noteRunSchema).max(NOTE_LIMITS.maxRunsPerParagraph),
    align: z.enum(NOTE_ALIGNMENTS).optional(),
    list: noteListSchema.optional(),
  })
  .strict();

export const noteParagraphsSchema = z.array(noteParagraphSchema).min(1).max(NOTE_LIMITS.maxParagraphs);

export const noteBoxSchema = z
  .object({
    width: z.number().finite().min(NOTE_LIMITS.minWidthMm).max(NOTE_LIMITS.maxWidthMm),
    height: z.number().finite().min(NOTE_LIMITS.minHeightMm).max(NOTE_LIMITS.maxHeightMm).nullable(),
    rotation: z.number().finite().min(-360).max(360),
  })
  .strict();

const leaderPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
export const noteLeaderSchema = z.object({ to: leaderPoint, elbow: leaderPoint.optional(), arrow: z.enum(["arrow", "dot", "tick", "none"]).optional() }).strict();

export const lineSpacingSchema = z.number().finite().min(NOTE_LIMITS.minLineSpacing).max(NOTE_LIMITS.maxLineSpacing);

export const richTextNoteSchema = z
  .object({
    space: z.enum(["paper", "model"]),
    box: noteBoxSchema,
    paragraphs: noteParagraphsSchema,
    lineSpacing: lineSpacingSchema,
    leader: noteLeaderSchema.optional(),
    leaders: z.array(noteLeaderSchema).max(8).readonly().optional(),
  })
  .strict();

/** Every character of the note, paragraphs separated by line breaks. */
export function noteText(paragraphs: readonly NoteParagraph[]): string {
  return paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/** A short one-line label for lists, undo buttons and refusals. */
export function noteLabel(paragraphs: readonly NoteParagraph[], max = 40): string {
  const flat = noteText(paragraphs).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Canonical content: adjacent runs with the same style merged, empty runs
 * dropped (an empty paragraph keeps no runs), false flags and default values
 * removed. Two notes that print the same compare equal after this.
 */
export function normalizeParagraphs(paragraphs: readonly NoteParagraph[]): NoteParagraph[] {
  return paragraphs.map((p) => {
    const runs: NoteRun[] = [];
    for (const raw of p.runs) {
      if (raw.text.length === 0) continue;
      const run = cleanRun(raw);
      const last = runs[runs.length - 1];
      if (last && sameStyle(last, run)) runs[runs.length - 1] = { ...last, text: last.text + run.text };
      else runs.push(run);
    }
    const align = p.align && p.align !== "left" ? p.align : undefined;
    const list = p.list ? { kind: p.list.kind, level: p.list.level, ...(p.list.kind === "numbered" && p.list.start !== undefined ? { start: p.list.start } : {}) } : undefined;
    return { runs, ...(align ? { align } : {}), ...(list ? { list } : {}) };
  });
}

function cleanRun(run: NoteRun): NoteRun {
  return {
    text: run.text,
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.underline ? { underline: true } : {}),
    ...(run.size !== undefined ? { size: run.size } : {}),
    ...(run.font && run.font !== "sans" ? { font: run.font } : {}),
    ...(run.color && run.color.toLowerCase() !== "#000000" ? { color: run.color.toLowerCase() } : {}),
  };
}

export function sameStyle(a: NoteRun, b: NoteRun): boolean {
  return Boolean(a.bold) === Boolean(b.bold) && Boolean(a.italic) === Boolean(b.italic) && Boolean(a.underline) === Boolean(b.underline) && a.size === b.size && (a.font ?? "sans") === (b.font ?? "sans") && (a.color ?? "") === (b.color ?? "");
}

/** Why this content can't be a note, or null. Schema limits are checked by the command schema; these are the cross-field ones. */
export function noteContentProblem(paragraphs: readonly NoteParagraph[]): string | null {
  let runs = 0;
  let chars = 0;
  for (const p of paragraphs) {
    runs += p.runs.length;
    for (const r of p.runs) chars += r.text.length;
  }
  if (runs > NOTE_LIMITS.maxRuns) return `The note has ${runs} styled pieces of text; the most is ${NOTE_LIMITS.maxRuns}. Split it into two notes.`;
  if (chars > NOTE_LIMITS.maxChars) return `The note has ${chars} characters; the most is ${NOTE_LIMITS.maxChars}. Split it into two notes.`;
  if (noteText(paragraphs).trim().length === 0) return "A note needs some text.";
  const bad = unsupportedCharacters(noteText(paragraphs));
  if (bad.length > 0) return `The drawing font can't print ${bad.slice(0, 6).map((c) => `"${c}"`).join(", ")}${bad.length > 6 ? " and more" : ""}. Use plain letters, numbers and drafting symbols (°, ±, ½, Ø, –, •).`;
  return null;
}

/** One paragraph of plain text in the note's default style (agents and the legacy one-line notes). */
export function paragraphsFromPlain(text: string): NoteParagraph[] {
  return text.split(/\r?\n/).map((line) => ({ runs: line.length ? [{ text: line }] : [] }));
}

export type NoteParagraphInput = z.infer<typeof noteParagraphSchema>;

/** Paragraphs in the (mutable) shape the note commands take. */
export function paragraphsForCommand(paragraphs: readonly NoteParagraph[]): NoteParagraphInput[] {
  return paragraphs.map((p) => ({ runs: p.runs.map((r) => ({ ...r })), ...(p.align ? { align: p.align } : {}), ...(p.list ? { list: { ...p.list } } : {}) }));
}
