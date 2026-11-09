import type { PDFFont } from "pdf-lib";

/**
 * Text for the PDF's standard fonts (Helvetica, WinAnsi encoding). WinAnsi has
 * ¼ ½ ¾ but not the eighths and thirds sizes print with (`1⅜"`), nor Δ, ≤, →
 * and the like; drawing one throws and fails the whole print. Each such
 * character prints as plain text instead (`1-3/8"`, `DELTA`, `<=`), anything
 * with no stand-in as `?`. The screen keeps the real characters; only the
 * PDF's standard-font text changes, and the caller is told what changed.
 */

const FRACTIONS: Readonly<Record<string, string>> = {
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
  "⅐": "1/7",
  "⅑": "1/9",
  "⅒": "1/10",
  "↉": "0/3",
  "¼": "1/4",
  "½": "1/2",
  "¾": "3/4",
};

const STAND_INS: Readonly<Record<string, string>> = {
  "Δ": "DELTA",
  "∆": "DELTA",
  "Ω": "OHM",
  "−": "-",
  "‐": "-",
  "‑": "-",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≈": "~",
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "′": "'",
  "″": '"',
  "∅": "Ø",
  "⌀": "Ø",
  "√": "SQRT",
  "∞": "INF",
  "\u2009": " ",
  "\u202f": " ",
  "\u200b": "",
};

/** Characters the font has no glyph for, replaced; `supported` is the font's code points. */
export function winAnsiText(text: string, supported: ReadonlySet<number>): string {
  let out = "";
  let prev = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (supported.has(code)) out += ch;
    else {
      const fraction = FRACTIONS[ch];
      if (fraction !== undefined) out += (/\d/.test(prev) ? "-" : "") + fraction;
      else {
        const sub = STAND_INS[ch] ?? (code < 0x20 ? " " : "?");
        // A stand-in is itself plain ASCII except Ø (Latin-1); a font without it gets "?".
        out += [...sub].every((c) => supported.has(c.codePointAt(0) ?? 0)) ? sub : "?";
      }
    }
    prev = ch;
  }
  return out;
}

/** One sheet's standard-font text, made printable, with every string it changed (first 50, each once). */
export class WinAnsiWriter {
  private readonly sets = new Map<PDFFont, ReadonlySet<number>>();
  private readonly seen = new Set<string>();
  readonly substituted: Array<{ readonly text: string; readonly printed: string }> = [];

  text(font: PDFFont, text: string): string {
    let supported = this.sets.get(font);
    if (!supported) {
      supported = new Set(font.getCharacterSet());
      this.sets.set(font, supported);
    }
    const printed = winAnsiText(text, supported);
    if (printed !== text && !this.seen.has(text)) {
      this.seen.add(text);
      if (this.substituted.length < 50) this.substituted.push({ text, printed });
    }
    return printed;
  }
}
