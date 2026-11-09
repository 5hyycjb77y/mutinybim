/**
 * Grid labels advance by themselves: A, B, C… (skipping letters a firm
 * doesn't use, I and O by default, then AA, AB…) and 1, 2, 3…. Pure helpers;
 * the firm's skip list is a setting the caller passes.
 */

export type GridLabelSeries = "letters" | "numbers";

export interface GridLabelOptions {
  /** Letters never used as labels. Default I and O (they read as 1 and 0). */
  readonly skipLetters?: readonly string[];
}

export const DEFAULT_SKIPPED_GRID_LETTERS: readonly string[] = ["I", "O"];

function alphabet(options: GridLabelOptions): readonly string[] {
  const skip = new Set((options.skipLetters ?? DEFAULT_SKIPPED_GRID_LETTERS).map((l) => l.toUpperCase()));
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    if (!skip.has(l)) out.push(l);
  }
  return out;
}

/** A letter label's place in the series (A = 1, the letter after the last = AA…), or null when it uses a skipped letter or isn't letters. */
function letterIndex(label: string, letters: readonly string[]): number | null {
  if (!/^[A-Z]+$/.test(label)) return null;
  let n = 0;
  for (const ch of label) {
    const i = letters.indexOf(ch);
    if (i < 0) return null;
    n = n * letters.length + (i + 1);
  }
  return n;
}

function letterLabel(index: number, letters: readonly string[]): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % letters.length;
    out = (letters[r] ?? "") + out;
    n = Math.floor((n - 1) / letters.length);
  }
  return out;
}

/**
 * The label after `label`: its trailing number plus one ("3" → "4", "C-9" →
 * "C-10"), or the next letter label ("H" → "J", "Z" → "AA"). Null when it
 * can't be advanced (a skipped letter, mixed case, no trailing number or
 * letters); the tool then asks for the next label.
 */
export function advanceGridLabel(label: string, options: GridLabelOptions = {}): string | null {
  const trimmed = label.trim();
  const num = /^(.*?)(\d+)$/.exec(trimmed);
  if (num) {
    const [, prefix = "", digits = ""] = num;
    const next = String(Number(digits) + 1);
    return `${prefix}${digits.startsWith("0") ? next.padStart(digits.length, "0") : next}`;
  }
  const letters = alphabet(options);
  const i = letterIndex(trimmed, letters);
  return i === null ? null : letterLabel(i + 1, letters);
}

/** The label a new grid line in `series` gets: the one after the highest label of that series in use, else the series' first. */
export function nextGridLabel(used: readonly string[], series: GridLabelSeries, options: GridLabelOptions = {}): string {
  if (series === "numbers") {
    let max = 0;
    for (const l of used) if (/^\d+$/.test(l.trim())) max = Math.max(max, Number(l.trim()));
    return String(max + 1);
  }
  const letters = alphabet(options);
  let max = 0;
  for (const l of used) max = Math.max(max, letterIndex(l.trim(), letters) ?? 0);
  return letterLabel(max + 1, letters);
}
