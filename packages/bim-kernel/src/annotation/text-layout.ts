import { NOTE_FONT_CODEPOINTS, NOTE_FONT_FACES } from "./font-metrics.generated";
import { DEFAULT_NOTE_SIZE_MM, LINE_BREAK, type NoteAlign, type NoteParagraph, type NoteRun } from "./rich-text";

/**
 * The one text layout engine for notes. The screen (SVG) and the PDF both draw
 * its output, so the line breaks and glyph positions you see are the ones that
 * print. Widths come from the shipped fonts' own advance tables
 * (`font-metrics.generated.ts`); no kerning and no ligatures, in either
 * writer, so a run's printed width is exactly the sum of its advances.
 *
 * The vertical model is CSS's: each run's line height is
 * `em × LINE_HEIGHT × lineSpacing`, split as half-leading above and below the
 * font's ascent and descent, and a line is as tall as its tallest run or the
 * paragraph's own size (the strut). The in-place editor styles its text with
 * the same numbers, so its caret sits on the laid-out glyphs.
 *
 * All lengths are paper mm, relative to the box's top-left corner, unrotated.
 */

export type NoteFace = keyof typeof NOTE_FONT_FACES;

/** Line height as a multiple of the font size (em), before the note's line spacing. */
export const NOTE_LINE_HEIGHT = 1.2;
/** List indent per level, as a multiple of the paragraph's font size. */
export const NOTE_LIST_INDENT_EM = 1.8;
/** Gap between a list marker and the text, as a multiple of the marker's font size. */
const MARKER_GAP_EM = 0.35;
const EPS = 1e-6;

const INDEX: ReadonlyMap<number, number> = new Map(NOTE_FONT_CODEPOINTS.map((cp, i) => [cp, i]));
const QUESTION = INDEX.get(0x3f) ?? 0;
const REGULAR = NOTE_FONT_FACES.regular;
/** Cap height as a fraction of the em, from the regular face; every face of a family sizes from it. */
const CAP_RATIO = REGULAR.capHeight / REGULAR.unitsPerEm;
const ASCENT_RATIO = REGULAR.ascent / REGULAR.unitsPerEm;
const DESCENT_RATIO = -REGULAR.descent / REGULAR.unitsPerEm;

/** The em (font size) in paper mm for a cap height in paper mm. */
export function emForCapHeight(capHeightMm: number): number {
  return capHeightMm / CAP_RATIO;
}

export function faceOf(run: Pick<NoteRun, "bold" | "italic">): NoteFace {
  return run.bold ? (run.italic ? "boldItalic" : "bold") : run.italic ? "italic" : "regular";
}

/** What a character prints as: itself, or "?" when the note font has no glyph for it. */
export function printable(ch: string): string {
  return INDEX.has(ch.codePointAt(0) ?? -1) ? ch : "?";
}

/** Advance of one character in paper mm. */
export function advance(face: NoteFace, ch: string, em: number): number {
  const m = NOTE_FONT_FACES[face];
  const i = INDEX.get(ch.codePointAt(0) ?? -1) ?? QUESTION;
  return ((m.widths[i] ?? 0) / m.unitsPerEm) * em;
}

export function textWidth(face: NoteFace, text: string, em: number): number {
  let w = 0;
  for (const ch of text) w += advance(face, ch, em);
  return w;
}

/** Contiguous text in one style at natural spacing; the writers draw each piece from `x` on `baseline`. */
export interface GlyphPiece {
  readonly text: string;
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
  readonly face: NoteFace;
  /** Font size, paper mm. */
  readonly em: number;
  /** "#rrggbb", or null for black. */
  readonly color: string | null;
  /** List number or bullet. */
  readonly marker?: true;
}

/** Underline: a filled bar from x0 to x1, its top at `y`. */
export interface UnderlineBar {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly thickness: number;
  readonly color: string | null;
}

export interface LaidOutLine {
  readonly paragraph: number;
  readonly top: number;
  readonly height: number;
  readonly baseline: number;
  /** Where the line's text starts and ends (trailing spaces excluded). */
  readonly left: number;
  readonly right: number;
  readonly pieces: readonly GlyphPiece[];
  readonly underlines: readonly UnderlineBar[];
}

export interface NoteLayout {
  readonly width: number;
  /** Box height: the fixed height, or the text's. */
  readonly height: number;
  readonly contentHeight: number;
  /** Lines that fit the box (a fixed-height box drops the rest and says so). */
  readonly lines: readonly LaidOutLine[];
  readonly overflow: boolean;
}

export interface LayoutOptions {
  readonly width: number;
  /** Fixed box height, or null to grow with the text. */
  readonly height: number | null;
  /** The note's text size (cap height, paper mm) for runs without one. */
  readonly size?: number;
  readonly lineSpacing?: number;
}

interface Glyph {
  readonly ch: string;
  readonly run: number;
  readonly w: number;
}

interface StyledRun {
  readonly face: NoteFace;
  readonly em: number;
  readonly color: string | null;
  readonly underline: boolean;
}

type Token = { readonly kind: "word" | "space"; readonly glyphs: Glyph[]; readonly width: number } | { readonly kind: "break" };

function tokenize(text: { run: number; text: string }[], styles: readonly StyledRun[]): Token[] {
  const tokens: Token[] = [];
  let current: { kind: "word" | "space"; glyphs: Glyph[]; width: number } | null = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = null;
  };
  for (const part of text) {
    const style = styles[part.run];
    if (!style) continue;
    for (const raw of part.text) {
      if (raw === LINE_BREAK) {
        flush();
        tokens.push({ kind: "break" });
        continue;
      }
      const ch = raw === "\t" ? " " : printable(raw);
      const kind = ch === " " ? "space" : "word";
      if (!current || current.kind !== kind) {
        flush();
        current = { kind, glyphs: [], width: 0 };
      }
      const w = advance(style.face, ch, style.em);
      current.glyphs.push({ ch, run: part.run, w });
      current.width += w;
    }
  }
  flush();
  return tokens;
}

/** Numbered list markers by level: 1. a. i. then repeat. */
function numberLabel(level: number, n: number): string {
  switch (level % 3) {
    case 1: {
      let s = "";
      let k = n;
      while (k > 0) {
        k -= 1;
        s = String.fromCharCode(97 + (k % 26)) + s;
        k = Math.floor(k / 26);
      }
      return `${s}.`;
    }
    case 2:
      return `${roman(n)}.`;
    default:
      return `${n}.`;
  }
}

function roman(n: number): string {
  const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  let k = n;
  for (const [v, s] of table) while (k >= v) {
    out += s;
    k -= v;
  }
  return out;
}

const BULLETS = ["\u2022", "\u2013"] as const;

/** List markers for every paragraph (null when not a list item): counts continue across a list and restart after body text. */
export function listMarkers(paragraphs: readonly NoteParagraph[]): Array<string | null> {
  const counters: number[] = [];
  return paragraphs.map((p) => {
    const list = p.list;
    if (!list) {
      counters.length = 0;
      return null;
    }
    counters.length = Math.min(counters.length, list.level + 1);
    if (list.kind === "bullet") {
      counters[list.level] = 0;
      return BULLETS[list.level % BULLETS.length] ?? "\u2022";
    }
    const next = list.start ?? (counters[list.level] ?? 0) + 1;
    counters[list.level] = next;
    return numberLabel(list.level, next);
  });
}

/** Where a paragraph's text starts: list items indent one step per level, plus one for the marker. */
export function paragraphIndent(paragraph: NoteParagraph, noteSize: number): number {
  return paragraph.list ? (paragraph.list.level + 1) * NOTE_LIST_INDENT_EM * emForCapHeight(noteSize) : 0;
}

/** Above and below the baseline for one size, CSS half-leading. */
function extent(em: number, lineSpacing: number): { above: number; below: number } {
  const lh = em * NOTE_LINE_HEIGHT * lineSpacing;
  const half = (lh - em * (ASCENT_RATIO + DESCENT_RATIO)) / 2;
  return { above: em * ASCENT_RATIO + half, below: em * DESCENT_RATIO + half };
}

/**
 * Lay out a note's paragraphs in a box `width` wide. Greedy line breaking at
 * spaces (the spaces at a break hang past the edge, as in the editor); a word
 * wider than the line breaks between characters; Shift+Enter breaks a line.
 */
export function layoutNote(paragraphs: readonly NoteParagraph[], opts: LayoutOptions): NoteLayout {
  const noteSize = opts.size ?? DEFAULT_NOTE_SIZE_MM;
  const spacing = opts.lineSpacing ?? 1;
  const width = opts.width;
  const markers = listMarkers(paragraphs);
  const lines: LaidOutLine[] = [];
  let y = 0;

  paragraphs.forEach((paragraph, pi) => {
    const styles: StyledRun[] = paragraph.runs.map((r) => ({ face: faceOf(r), em: emForCapHeight(r.size ?? noteSize), color: r.color ?? null, underline: Boolean(r.underline) }));
    const strutEm = emForCapHeight(noteSize);
    const indent = paragraphIndent(paragraph, noteSize);
    const avail = Math.max(width - indent, 0);
    const align: NoteAlign = paragraph.align ?? "left";
    const tokens = tokenize(
      paragraph.runs.map((r, run) => ({ run, text: r.text })),
      styles,
    );

    // Lines as glyph lists, with whether each ended at a hard break (not justified).
    const built: Array<{ glyphs: Glyph[]; hard: boolean }> = [];
    let line: Glyph[] = [];
    let lineWidth = 0;
    let pending: Glyph[] = [];
    let pendingWidth = 0;
    const commit = (hard: boolean) => {
      built.push({ glyphs: [...line, ...pending], hard });
      line = [];
      lineWidth = 0;
      pending = [];
      pendingWidth = 0;
    };
    for (const token of tokens) {
      if (token.kind === "break") {
        commit(true);
        continue;
      }
      if (token.kind === "space") {
        pending.push(...token.glyphs);
        pendingWidth += token.width;
        continue;
      }
      if (line.length > 0 && lineWidth + pendingWidth + token.width > avail + EPS) {
        commit(false);
      }
      line.push(...pending);
      lineWidth += pendingWidth;
      pending = [];
      pendingWidth = 0;
      if (lineWidth + token.width <= avail + EPS) {
        line.push(...token.glyphs);
        lineWidth += token.width;
        continue;
      }
      // Longer than the line: break between characters, at least one per line.
      for (const g of token.glyphs) {
        if (line.length > 0 && lineWidth + g.w > avail + EPS) commit(false);
        line.push(g);
        lineWidth += g.w;
      }
    }
    commit(true);

    built.forEach((entry, li) => {
      const glyphs = entry.glyphs;
      let end = glyphs.length;
      while (end > 0 && glyphs[end - 1]?.ch === " ") end--;
      let natural = 0;
      for (let i = 0; i < end; i++) natural += glyphs[i]?.w ?? 0;
      const spaces = glyphs.slice(0, end).filter((g) => g.ch === " ").length;
      const lastOfParagraph = li === built.length - 1 || entry.hard;
      const slack = Math.max(avail - natural, 0);
      const offset = align === "center" ? slack / 2 : align === "right" ? slack : 0;
      const stretch = align === "justify" && !lastOfParagraph && spaces > 0 && natural <= avail ? slack / spaces : 0;

      let above = extent(strutEm, spacing).above;
      let below = extent(strutEm, spacing).below;
      for (let i = 0; i < glyphs.length; i++) {
        const s = styles[glyphs[i]?.run ?? 0];
        if (!s) continue;
        const e = extent(s.em, spacing);
        above = Math.max(above, e.above);
        below = Math.max(below, e.below);
      }
      const top = y;
      const baseline = top + above;
      const height = above + below;
      y += height;

      const pieces: GlyphPiece[] = [];
      const underlines: UnderlineBar[] = [];
      let x = indent + offset;
      const left = x;
      let piece: { text: string; x: number; width: number; run: number } | null = null;
      const pushPiece = () => {
        const s = piece ? styles[piece.run] : undefined;
        if (piece && s && piece.text.length > 0) pieces.push({ text: piece.text, x: piece.x, baseline, width: piece.width, face: s.face, em: s.em, color: s.color });
        piece = null;
      };
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        if (!g) continue;
        // A justified space ends the piece: the writers place each piece, so stretched gaps stay exact.
        if (!piece || piece.run !== g.run) {
          pushPiece();
          piece = { text: "", x, width: 0, run: g.run };
        }
        piece.text += g.ch;
        piece.width += g.w;
        x += g.w;
        if (g.ch === " " && i < end) {
          if (stretch > 0) {
            pushPiece();
            x += stretch;
          }
        }
      }
      pushPiece();
      const right = left + natural + stretch * spaces;

      // Underlines span each underlined run's printed glyphs (trailing spaces at the edge excluded).
      let cursor = indent + offset;
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        if (!g) continue;
        const s = styles[g.run];
        const w = g.w + (g.ch === " " && i < end ? stretch : 0);
        if (s?.underline && i < end) {
          const m = NOTE_FONT_FACES[s.face];
          const thickness = (m.underlineThickness / m.unitsPerEm) * s.em;
          const yTop = baseline - (m.underlinePosition / m.unitsPerEm) * s.em - thickness / 2;
          const last = underlines[underlines.length - 1];
          if (last && Math.abs(last.x1 - cursor) < EPS && Math.abs(last.y - yTop) < EPS && last.color === s.color && Math.abs(last.thickness - thickness) < EPS) {
            underlines[underlines.length - 1] = { ...last, x1: cursor + w };
          } else {
            underlines.push({ x0: cursor, x1: cursor + w, y: yTop, thickness, color: s.color });
          }
        }
        cursor += w;
      }

      const marker = li === 0 ? markers[pi] : null;
      if (marker) {
        const first = paragraph.runs[0];
        const em = emForCapHeight(first?.size ?? noteSize);
        const mw = textWidth("regular", marker, em);
        pieces.unshift({ text: marker, x: indent - em * MARKER_GAP_EM - mw, baseline, width: mw, face: "regular", em, color: first?.color ?? null, marker: true });
      }
      lines.push({ paragraph: pi, top, height, baseline, left, right, pieces, underlines });
    });
  });

  const contentHeight = y;
  const height = opts.height ?? contentHeight;
  const fitting = opts.height === null ? lines : lines.filter((l) => l.top + l.height <= height + 1e-3);
  return { width, height, contentHeight, lines: fitting, overflow: fitting.length < lines.length };
}

/** Each character's x in a piece (the screen positions every glyph, so the browser never re-spaces a run). */
export function pieceCharX(piece: GlyphPiece): number[] {
  const xs: number[] = [];
  let x = piece.x;
  for (const ch of piece.text) {
    xs.push(x);
    x += advance(piece.face, ch, piece.em);
  }
  return xs;
}
