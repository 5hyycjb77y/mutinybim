import type { Sheet } from "../types";

/** Discipline designators in the order a set binds them (National CAD Standard order), unknown prefixes last. */
const DISCIPLINE_ORDER = ["G", "H", "V", "B", "C", "L", "S", "A", "I", "Q", "F", "FP", "P", "D", "M", "E", "T", "R", "X", "Z", "O"];

function designator(number: string): string {
  return /^[A-Za-z]+/.exec(number.trim())?.[0]?.toUpperCase() ?? "";
}

/** Sheets in binding order: by discipline designator, then sheet number (numerically). The printer and the Views & Sheets dialogs share it, so a person's sheet list is the page order. */
export function setOrder<T extends Pick<Sheet, "number">>(sheets: readonly T[]): T[] {
  const rank = (s: T) => {
    const i = DISCIPLINE_ORDER.indexOf(designator(s.number));
    return i < 0 ? DISCIPLINE_ORDER.length : i;
  };
  return [...sheets].sort((a, b) => rank(a) - rank(b) || a.number.localeCompare(b.number, "en", { numeric: true, sensitivity: "base" }));
}

