import type { BimElement } from "../types";

/**
 * How the graph names things in its sentences: a space as "Office 101" (its
 * name, then its number), anything with a mark by its mark, else its id.
 * Kind words come from the kind id itself, so a kind this release doesn't
 * know still reads.
 */

function words(kind: string): string {
  return kind.replace(/_/g, " ");
}

function field(el: BimElement, name: string): string | null {
  if (!(name in el)) return null;
  const v: unknown = (el as unknown as Readonly<Record<string, unknown>>)[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** "Office 101", "Zone East", "Door D-3", "SP-14", "W-12". */
export function nameOf(el: BimElement | undefined, fallbackId = "?"): string {
  if (!el) return fallbackId;
  switch (el.kind) {
    case "space":
    case "room":
      return [field(el, "name"), field(el, "number")].filter((s): s is string => s !== null).join(" ") || el.id;
    case "zone":
      return `Zone ${field(el, "name") ?? el.id}`;
    case "level":
      return field(el, "name") ?? el.id;
    case "opening": {
      const mark = field(el, "mark");
      const type = field(el, "openingType");
      const noun = type ? type.charAt(0).toUpperCase() + type.slice(1) : "Opening";
      return mark ? `${noun} ${mark}` : `${noun} ${el.id}`;
    }
    case "determination":
      return `the ${words(el.determination.key)} determination`;
    default:
      return field(el, "mark") ?? field(el, "label") ?? el.id;
  }
}

/** The element's kind in words, lower case ("wall", "ceiling", "run segment"). */
export function kindWords(el: BimElement): string {
  return words(el.kind);
}

/** "A", "A and B", "A, B and C", "A, B, C and 4 more". */
export function listWords(items: readonly string[], max = 3): string {
  const unique = [...new Set(items)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length <= max) return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

/** "Oct 30" from an ISO date; the text as given when it isn't one. */
export function shortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A value with its unit, for sentences ("150 L/s", "B", "yes"). */
export function valueWords(value: number | string | boolean | null | undefined, unit?: string): string {
  if (value === null || value === undefined) return "no value";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    const n = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
    return unit && unit !== "1" ? `${n} ${unit}` : n;
  }
  return value;
}
