import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { elementValueSource } from "../elements/types";
import type { BimElement } from "../types";

/**
 * Assembly rating kinds (contract 1.10.0, `kernel.rating_kind` v1).
 *
 * A wall, floor, ceiling or member can carry a rating of some kind (fire
 * resistance in hours, a smoke barrier, an acoustic class). Architecture sets
 * it on the element's type; every trade reads it the same way. A row names
 * the kind, its unit and how to read one element's value (usually from its
 * type's parameters). The kernel never names a rating kind itself.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface RatingKindRow {
  /** `<pack>.<name>`; a first-party row keeps its bare id. */
  readonly id: string;
  /** What a person calls it ("Fire resistance"). */
  readonly label: string;
  /** The words after a number of it ("hour"). Empty for a yes / no rating. */
  readonly unit: string;
  /** The values a person picks from, lowest first (0.5, 1, 2, 3). Absent: any number. */
  readonly levels?: readonly number[];
  /** The element type parameter keys the value is read from, in order (documentation and pickers). */
  readonly parameterKeys: readonly string[];
  /** One element's rating of this kind, or null when it has none (not rated). */
  read(el: BimElement, elements: Elements): number | null;
  /** How a value reads ("1-hour"). Absent: the number and the unit. */
  format?(value: number): string;
}

export const RATING_KIND_POINT = defineExtensionPoint<RatingKindRow>({
  id: "kernel.rating_kind",
  version: 1,
  label: "Assembly rating kinds",
  idOf: (row) => row.id,
});

/** Problems with rating kind rows (pack conformance), in words. */
export function ratingKindRowProblems(rows: readonly RatingKindRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`rating kind ${row.id} has no label`);
    if (typeof row.read !== "function") out.push(`rating kind ${row.id}: read must be a function`);
    if (row.format !== undefined && typeof row.format !== "function") out.push(`rating kind ${row.id}: format must be a function`);
    const levels = row.levels ?? [];
    if (levels.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= (levels[i - 1] ?? v)))) out.push(`rating kind ${row.id}: levels must be finite and rising`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, RatingKindRow> => new Map(set.items(RATING_KIND_POINT).map((r) => [r.id, r] as const));

export function ratingKindRow(id: string): RatingKindRow | null {
  return activePackSet().memo("kernel.rating_kind#table", tableOf).get(id) ?? null;
}

/** One element's rating of a kind in the set in force; null when the kind isn't registered or the element isn't rated. */
export function ratingOf(elements: Elements, el: BimElement, kindId: string): number | null {
  const row = ratingKindRow(kindId);
  if (!row) return null;
  const value = row.read(el, elements);
  return value !== null && Number.isFinite(value) ? value : null;
}

/** One element's rating of a kind against its type's: what is in force, what the type says, and the element's own keys that override it. */
export interface RatingSource {
  /** In force: the element's own value, else its type's (`ratingOf`). */
  readonly value: number | null;
  /** The type's rating alone; null with no type or an unrated one. */
  readonly typeValue: number | null;
  /** The row's parameter keys the element sets itself (clearing them puts the type's rating back). */
  readonly ownKeys: readonly string[];
  /** The element sets its own rating and it is not the type's. */
  readonly differsFromType: boolean;
}

/** Null when the kind isn't registered. */
export function ratingSourceOf(elements: Elements, el: BimElement, kindId: string): RatingSource | null {
  const row = ratingKindRow(kindId);
  if (!row) return null;
  const value = ratingOf(elements, el, kindId);
  const typeId = "typeId" in el && typeof el.typeId === "string" ? el.typeId : undefined;
  const type = typeId === undefined ? undefined : elements[typeId];
  const typeValue = type ? ratingOf(elements, type, kindId) : null;
  const ownKeys = row.parameterKeys.filter((k) => elementValueSource(elements, el, k).from === "instance");
  return { value, typeValue, ownKeys, differsFromType: ownKeys.length > 0 && value !== typeValue };
}

/** A rating as it reads ("1-hour"). */
export function formatRating(row: RatingKindRow, value: number): string {
  return row.format ? row.format(value) : `${value}${row.unit ? ` ${row.unit}` : ""}`;
}
