/** The first number in a cell ("1,320 W" → 1320); null when there is none. */
export function numberIn(text: string): number | null {
  const m = /-?\d[\d,]*(\.\d+)?|-?\.\d+/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
