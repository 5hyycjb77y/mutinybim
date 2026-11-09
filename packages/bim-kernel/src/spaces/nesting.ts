import { elementsOfKind } from "../store";
import type { BimElement, ElementId } from "../types";
import type { Space, Zone } from "./types";

/**
 * Nested spaces and zones (contract 1.11.0, feature `spaces:nested`).
 *
 * One general parent / child relation, stored as `parentId` on the child:
 * a sub-room inside an open office, the rooms of a suite or an apartment, a
 * zone inside a larger zone. The parent keeps its own identity, name and
 * area; every child is a first-class record with its own use, occupants and
 * loads. A parent is the same kind as its child, and a chain never loops.
 */

type Elements = Readonly<Record<string, BimElement>>;
export type NestedRecord = Space | Zone;

export const SPACES_NESTED_FEATURE = "spaces:nested";

/** How a schedule shows nested records: parents with children indented, children only, or parents only. */
export const NESTING_DISPLAYS = ["nested", "children_only", "parents_only"] as const;
export type NestingDisplay = (typeof NESTING_DISPLAYS)[number];

function isNested(el: BimElement | undefined): el is NestedRecord {
  return el !== undefined && (el.kind === "space" || el.kind === "zone");
}

/** The record this one sits inside, or null when it is top-level or its parent is missing / of another kind. */
export function parentOf(elements: Elements, child: NestedRecord): NestedRecord | null {
  if (child.parentId === undefined) return null;
  const parent = elements[child.parentId];
  return isNested(parent) && parent.kind === child.kind ? parent : null;
}

/** The records directly inside `parentId`, in id order (stable for schedules and tests). */
export function childrenOf(elements: Elements, parentId: ElementId): NestedRecord[] {
  const parent = elements[parentId];
  if (!isNested(parent)) return [];
  const same: readonly NestedRecord[] = parent.kind === "space" ? elementsOfKind(elements, "space") : elementsOfKind(elements, "zone");
  return same.filter((el) => el.parentId === parentId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The chain from this record up to its top-level ancestor (excluding itself). Stops at a loop. */
export function ancestorsOf(elements: Elements, child: NestedRecord): NestedRecord[] {
  const out: NestedRecord[] = [];
  const seen = new Set<string>([child.id]);
  for (let p = parentOf(elements, child); p !== null; p = parentOf(elements, p)) {
    if (seen.has(p.id)) break;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Why `childId` can't sit inside `parentId`, in words, or null when it can. Writers check this before storing. */
export function nestingRefusal(elements: Elements, childId: ElementId, parentId: ElementId): string | null {
  const child = elements[childId];
  const parent = elements[parentId];
  if (!isNested(child)) return `${childId} isn't a space or zone`;
  if (!isNested(parent)) return `${parentId} isn't a space or zone`;
  if (child.kind !== parent.kind) return `A ${child.kind} can only sit inside another ${child.kind}`;
  if (childId === parentId) return "A space can't sit inside itself";
  if (ancestorsOf(elements, parent).some((a) => a.id === childId)) return `${parentId} already sits inside ${childId}`;
  return null;
}

/** One schedule row: the record and how deep it sits (0 = top level). */
export interface NestedRow {
  readonly record: NestedRecord;
  readonly depth: number;
}

/**
 * Schedule rows for these records under a display choice. `nested`: each
 * top-level record followed by its descendants, indented by depth;
 * `children_only`: records with no children (what load calculations add
 * up, so a parent's area is never counted twice); `parents_only`: top-level
 * records.
 */
export function nestedRows(elements: Elements, records: readonly NestedRecord[], display: NestingDisplay): NestedRow[] {
  const ids = new Set(records.map((r) => r.id));
  const kids = new Map<string, NestedRecord[]>();
  for (const r of records) {
    const p = parentOf(elements, r);
    if (p && ids.has(p.id)) kids.set(p.id, [...(kids.get(p.id) ?? []), r]);
  }
  const roots = records.filter((r) => {
    const p = parentOf(elements, r);
    return p === null || !ids.has(p.id);
  });
  if (display === "parents_only") return roots.map((record) => ({ record, depth: 0 }));
  if (display === "children_only") return records.filter((r) => !kids.has(r.id)).map((record) => ({ record, depth: 0 }));
  const out: NestedRow[] = [];
  const seen = new Set<string>();
  const walk = (r: NestedRecord, depth: number): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ record: r, depth });
    for (const c of kids.get(r.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}
