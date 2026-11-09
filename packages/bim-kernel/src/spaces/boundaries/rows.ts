import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import type { PackSet } from "../../packs/set";
import { lineLevelId } from "../../joins/rows";
import { lineJoinsOf } from "../../joins/solve";
import type { BimElement, ElementId, Vec2 } from "../../types";

/**
 * Bounding elements (contract 1.11.0, `kernel.bounding_element` v1).
 *
 * Any kind can bound spaces: a wall by its two finish faces, a column by its
 * outline, a separation line by itself, an outside add-on's partition by
 * whatever it says. Whether one element bounds rooms is a parameter, not a
 * kind case: the instance override, else its type's `typeParameterKey`
 * value, else the row's default. The kernel names no building kind here.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** One straight piece of a bounding element's edge on a level (model mm). */
export interface BoundarySegment {
  readonly elementId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface BoundingElementRow {
  /** The kind it bounds for (`wall`, `space_separator`, `zz.partition`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  /** Bounds rooms unless its type or the instance says otherwise. */
  readonly boundsByDefault: boolean;
  /** The element type parameter that turns bounding on or off (`room_bounding`). Absent: only the default and the instance. */
  readonly typeParameterKey?: string;
  /** Its edge pieces on a level; empty when it isn't on that level. */
  segments(el: BimElement, elements: Elements, levelId: ElementId): readonly BoundarySegment[];
  /** The type parameter's value for one element, when the row reads types itself. Absent: the kernel reads `values[typeParameterKey]` off the element's type. */
  readTypeValue?(el: BimElement, elements: Elements): boolean | null;
}

/** The kernel's own row: a separation line always bounds, by itself, on its own level, and is never built. */
const SEPARATOR_ROW: BoundingElementRow = {
  kind: "space_separator",
  label: "Separation line",
  boundsByDefault: true,
  segments: (el, _elements, levelId) => (el.kind === "space_separator" && el.levelId === levelId ? [{ elementId: el.id, start: el.start, end: el.end }] : []),
  readTypeValue: () => true,
};
/** A wall's two finish faces on its level, trimmed where it meets other walls (`kernel.line_join`); its own line when nothing joins it. */
function wallFaces(el: BimElement, elements: Elements, levelId: ElementId): BoundarySegment[] {
  if (el.kind !== "wall") return [];
  const j = lineJoinsOf(elements, el.id);
  if (j) {
    if (j.levelId !== levelId) return [];
    const [sl, el2, er, sr] = j.outline;
    if (!sl || !el2 || !er || !sr) return [];
    return [
      { elementId: el.id, start: sl, end: el2 },
      { elementId: el.id, start: sr, end: er },
    ];
  }
  if (lineLevelId(el, elements) !== levelId) return [];
  const len = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y);
  if (len === 0) return [];
  const nx = (-(el.end.y - el.start.y) / len) * (el.thickness / 2);
  const ny = ((el.end.x - el.start.x) / len) * (el.thickness / 2);
  return [
    { elementId: el.id, start: { x: el.start.x + nx, y: el.start.y + ny }, end: { x: el.end.x + nx, y: el.end.y + ny } },
    { elementId: el.id, start: { x: el.start.x - nx, y: el.start.y - ny }, end: { x: el.end.x - nx, y: el.end.y - ny } },
  ];
}

/** The kernel's wall row: walls bound rooms with every add-on off; a type's or the wall's own `room_bounding` turns it off. */
const WALL_ROW: BoundingElementRow = {
  kind: "wall",
  label: "Wall",
  boundsByDefault: true,
  typeParameterKey: "room_bounding",
  segments: wallFaces,
};

const BUILTIN_ROWS: readonly BoundingElementRow[] = Object.freeze([WALL_ROW, SEPARATOR_ROW]);

export const BOUNDING_ELEMENT_POINT = defineExtensionPoint<BoundingElementRow>({
  id: "kernel.bounding_element",
  version: 1,
  label: "Bounding elements",
  idOf: (row) => row.kind,
  builtins: () => BUILTIN_ROWS,
});

/** The instance value that overrides a type's room-bounding choice. */
export const ROOM_BOUNDING_INSTANCE_KEY = "room_bounding";

/** Problems with bounding element rows (pack conformance), in words. */
export function boundingElementRowProblems(rows: readonly BoundingElementRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`bounding element ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`bounding element ${row.kind} has no label`);
    if (typeof row.segments !== "function") out.push(`bounding element ${row.kind}: segments must be a function`);
    if (row.readTypeValue !== undefined && typeof row.readTypeValue !== "function") out.push(`bounding element ${row.kind}: readTypeValue must be a function`);
    if (row.typeParameterKey !== undefined && row.typeParameterKey.trim().length === 0) out.push(`bounding element ${row.kind}: typeParameterKey is empty`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, BoundingElementRow> => new Map(set.items(BOUNDING_ELEMENT_POINT).map((r) => [r.kind, r] as const));

export function boundingElementRow(kind: string): BoundingElementRow | null {
  return activePackSet().memo("kernel.bounding_element#table", tableOf).get(kind) ?? null;
}

function valueOf(record: BimElement | undefined, key: string): unknown {
  if (record === undefined || !("values" in record)) return undefined;
  const values = record.values;
  return typeof values === "object" && values !== null && key in values ? (values as Readonly<Record<string, unknown>>)[key] : undefined;
}

function typeOf(el: BimElement, elements: Elements): BimElement | undefined {
  const typeId = "typeId" in el && typeof el.typeId === "string" ? el.typeId : undefined;
  return typeId === undefined ? undefined : elements[typeId];
}

/** Whether one element bounds rooms in the set in force: instance override, then its type, then the row's default. False with no row. */
export function boundsRooms(el: BimElement, elements: Elements): boolean {
  const row = boundingElementRow(el.kind);
  if (!row) return false;
  const instance = valueOf(el, ROOM_BOUNDING_INSTANCE_KEY);
  if (typeof instance === "boolean") return instance;
  const fromRow = row.readTypeValue?.(el, elements);
  if (typeof fromRow === "boolean") return fromRow;
  if (row.typeParameterKey !== undefined) {
    const fromType = valueOf(typeOf(el, elements), row.typeParameterKey);
    if (typeof fromType === "boolean") return fromType;
  }
  return row.boundsByDefault;
}
