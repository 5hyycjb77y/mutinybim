import { partDisciplines } from "../connections/trades";
import { PART_CATEGORY_LABELS, disciplineOfCategory, type PartCategory } from "../parts";
import { elementsOfKind } from "../store";
import type { BimElement, Discipline, ElementId, PartInstance } from "../types";
import type { PlannedSkipReport } from "./types";

/**
 * The derived "planned parts" index (ROADMAP F1): every part that exists but
 * is not drawn yet. Built once per element record from the per-kind index
 * (parts only, never the whole model), then carried forward edit by edit from
 * the ids a commit changed (`advancePlannedIndex`).
 */

type Elements = Readonly<Record<string, BimElement>>;

interface PlannedIndex {
  /** Planned part ids in the order they were first seen. */
  readonly ids: readonly ElementId[];
  readonly set: ReadonlySet<string>;
}

const indexes = new WeakMap<object, PlannedIndex>();

function isPlannedPart(el: BimElement | undefined): el is PartInstance {
  return el?.kind === "part" && el.planned !== undefined;
}

function build(elements: Elements): PlannedIndex {
  const ids: ElementId[] = [];
  for (const part of elementsOfKind(elements, "part")) if (part.planned !== undefined) ids.push(part.id);
  return { ids, set: new Set(ids) };
}

function indexOf(elements: Elements): PlannedIndex {
  let index = indexes.get(elements);
  if (!index) {
    index = build(elements);
    indexes.set(elements, index);
  }
  return index;
}

/**
 * Carry the index from one revision to the next using only the ids the commit
 * changed or removed. Without an index for `previous` the next read builds one
 * from the per-kind index instead.
 */
export function advancePlannedIndex(previous: Elements, next: Elements, changedIds: readonly string[], removedIds: readonly string[] = []): void {
  if (indexes.has(next)) return;
  const before = indexes.get(previous);
  if (!before) return;
  const set = new Set(before.set);
  const ids = [...before.ids];
  let dirty = false;
  for (const id of [...changedIds, ...removedIds]) {
    const planned = isPlannedPart(next[id]);
    if (planned && !set.has(id)) {
      set.add(id);
      ids.push(id as ElementId);
      dirty = true;
    } else if (!planned && set.has(id)) {
      set.delete(id);
      dirty = true;
    }
  }
  indexes.set(next, dirty ? { ids: ids.filter((id) => set.has(id)), set } : before);
}

/** Every planned part, in the order the index first saw them. */
export function plannedParts(elements: Elements): PartInstance[] {
  const out: PartInstance[] = [];
  for (const id of indexOf(elements).ids) {
    const el = elements[id];
    if (isPlannedPart(el)) out.push(el);
  }
  return out;
}

export function plannedPartCount(elements: Elements): number {
  return indexOf(elements).ids.length;
}

/** True for a part that exists but is not drawn yet. Every geometry consumer skips these. */
export function isPlannedElement(el: BimElement | undefined): boolean {
  return isPlannedPart(el);
}

/** A geometry consumer's account of the planned parts it did not draw or check. */
export function plannedSkipReport(consumer: string, elements: Elements): PlannedSkipReport {
  return { consumer, plannedIds: indexOf(elements).ids };
}

/** "1 planned element not checked for clashes" / "3 planned elements not drawn". */
export function plannedSkipText(count: number, what: string): string {
  return `${count} planned element${count === 1 ? "" : "s"} not ${what}`;
}

/** One row of the "Not placed yet" list. */
export interface PlannedPartRow {
  readonly id: ElementId;
  /** What people call it: its mark, else its type's name. */
  readonly name: string;
  readonly typeName: string;
  readonly category: PartCategory | null;
  readonly categoryLabel: string;
  readonly discipline: Discipline;
  /** The level it will probably go on, by name, when the plan said. */
  readonly levelHint: string | null;
  readonly levelHintId: ElementId | null;
  readonly note: string | null;
}

export interface PlannedPartGroup {
  readonly discipline: Discipline;
  readonly categoryLabel: string;
  readonly rows: readonly PlannedPartRow[];
}

const DISCIPLINE_ORDER: readonly Discipline[] = ["electrical", "mechanical", "plumbing", "fire_protection", "architecture", "structure"];

function rowOf(elements: Elements, part: PartInstance): PlannedPartRow {
  const type = elements[part.typeId];
  const def = type?.kind === "part_type" ? type.definition : null;
  const typeName = def ? def.typeName : part.typeId;
  const hintId = part.planned?.levelHint ?? null;
  const hint = hintId ? elements[hintId] : undefined;
  return {
    id: part.id,
    name: part.mark.trim() || typeName,
    typeName,
    category: def?.category ?? null,
    categoryLabel: def ? PART_CATEGORY_LABELS[def.category] : "Parts",
    discipline: part.partition?.discipline ?? (def ? disciplineOfCategory(def.category) : "architecture"),
    levelHint: hint?.kind === "level" ? hint.name : null,
    levelHintId: hint?.kind === "level" ? hint.id : null,
    note: part.planned?.note ?? null,
  };
}

/**
 * The "Not placed yet" list: planned parts grouped by trade, then by class, each sorted by name.
 * Filtered to `disciplines`, a part is listed when any trade it takes part in is wanted
 * (`partDisciplines`: a kitchen fryer filed as Mechanical equipment with a 120 V load lists
 * on Electrical too), grouped under the first wanted one.
 */
export function plannedPartGroups(elements: Elements, disciplines?: readonly Discipline[]): PlannedPartGroup[] {
  const want = disciplines ? new Set(disciplines) : null;
  const groups = new Map<string, { discipline: Discipline; categoryLabel: string; rows: PlannedPartRow[] }>();
  for (const part of plannedParts(elements)) {
    const row = rowOf(elements, part);
    const discipline = want === null || want.has(row.discipline) ? row.discipline : partDisciplines(elements, part).find((d) => want.has(d));
    if (discipline === undefined) continue;
    const key = `${discipline}\u0000${row.categoryLabel}`;
    const g = groups.get(key) ?? { discipline, categoryLabel: row.categoryLabel, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }
  const rank = (d: Discipline) => DISCIPLINE_ORDER.indexOf(d);
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id)) }))
    .sort((a, b) => rank(a.discipline) - rank(b.discipline) || a.categoryLabel.localeCompare(b.categoryLabel));
}
