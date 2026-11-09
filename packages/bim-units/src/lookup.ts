import { UNIT_CODES } from "./codes";
import { unitAllowed } from "./quantity";
import type { Kind, UnitCode } from "./types";
import { UNITS } from "./units";

/**
 * Every spelling a person may type for a unit: its code, printed symbol and
 * aliases. Exact matches win; a case-insensitive match is used only when it
 * names one unit ("CFM", "Cfm" → cfm, but "mw" stays unknown because it could
 * be MW or mW).
 */
const EXACT = new Map<string, UnitCode[]>();
const FOLDED = new Map<string, UnitCode[]>();

function put(map: Map<string, UnitCode[]>, key: string, code: UnitCode): void {
  if (key === "") return;
  const list = map.get(key);
  if (!list) map.set(key, [code]);
  else if (!list.includes(code)) list.push(code);
}

for (const code of UNIT_CODES) {
  const u = UNITS[code];
  for (const spelling of [code, u.symbol, ...u.aliases]) {
    put(EXACT, spelling, code);
    put(FOLDED, spelling.toLowerCase(), code);
  }
}

/** Units a spelling could mean, best first. Empty when unknown. */
export function unitCandidates(text: string): readonly UnitCode[] {
  const key = text.trim();
  const exact = EXACT.get(key);
  if (exact) return exact;
  const folded = FOLDED.get(key.toLowerCase());
  if (folded && new Set(folded).size === 1) return folded;
  return [];
}

/** The unit a spelling means for a kind ("°F" is a temperature for `temperature` and a difference for `temperature_delta`). */
export function findUnit(text: string, kind?: Kind): UnitCode | null {
  const candidates = unitCandidates(text);
  if (kind === undefined) return candidates[0] ?? null;
  for (const c of candidates) if (unitAllowed(kind, c)) return c;
  const folded = FOLDED.get(text.trim().toLowerCase()) ?? [];
  const allowed = folded.filter((c) => unitAllowed(kind, c));
  return allowed.length === 1 ? (allowed[0] ?? null) : null;
}
