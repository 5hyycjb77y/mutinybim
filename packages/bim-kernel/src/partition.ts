import { z } from "zod";
import type { Changeset } from "./changeset";
import { disciplineCovers, disciplineLabel, disciplineWriteProblem } from "./disciplines/registry";
import { isRegistryIdShape } from "./ids";
import { connectionEndSlots, elementEntries, elementOrder, recordSlots } from "./store";
import { DEFAULT_PARTITION, type BimElement, type Connection, type Discipline, type KnownDiscipline, type ModelState, type Partition } from "./types";

export const DISCIPLINES: readonly KnownDiscipline[] = [
  "architecture",
  "structure",
  "mechanical",
  "plumbing",
  "electrical",
  "fire_protection",
];

/**
 * Writers: a discipline id (registry shape). A command is parsed wherever it
 * arrives (an agent tool, the model server, a test), before any model's
 * add-ons are in force, so whether this model knows the id is not decided
 * here: the edit gate (`elements/discipline-gate.ts`) runs inside
 * `executeCommand` with the model's set and refuses an unregistered id in
 * plain words that name where it would come from, and an id the peers can't
 * store yet.
 */
export const disciplineSchema = z.string().superRefine((id, ctx) => {
  if (!isRegistryIdShape(id)) ctx.addIssue({ code: "custom", message: disciplineWriteProblem(id) ?? `"${id}" isn't a discipline id` });
});

/**
 * Readers: a discipline stored by a newer peer (`civil`, `general_contracting`,
 * `firm:x`) is kept as it is and treated as its own discipline, never refused
 * (foundation adjustments H1). `Partition.discipline` is still typed with the
 * six writer values; this guard is what readers check a stored value against.
 */
export function isStoredDiscipline(value: unknown): value is Discipline {
  return isRegistryIdShape(value);
}

export function isKnownDiscipline(value: string): value is KnownDiscipline {
  return (DISCIPLINES as readonly string[]).includes(value);
}

/** A stored discipline in words: the host's own label for the six, else the registry's label, else the id's own words (`firm:site_work` → "Site work"). */
export function disciplineWords(value: string, known?: Readonly<Record<KnownDiscipline, string>>): string {
  return known && isKnownDiscipline(value) ? known[value] : disciplineLabel(value);
}

/** The protocol feature for partitions stored with a class discipline beyond the six. */
export const PARTITION_DISCIPLINES_FEATURE = "partition:class_disciplines";

/** Class disciplines a partition may store beside the six (registry/types.ts `CLASS_DISCIPLINES`). */
const EXTRA_STORED: ReadonlySet<string> = new Set(["civil", "general_contracting", "documentation", "general"]);

function isExtraStored(d: string): d is Exclude<Discipline, KnownDiscipline> {
  return EXTRA_STORED.has(d);
}

/**
 * The discipline a writer stores for something whose class discipline is
 * `classDiscipline`: that discipline when it is one of the six, or when the
 * peers read class disciplines (`peerReadsExtra`), or any registered
 * discipline when the peers read the registry (`peerReadsRegistry`), else
 * `fallback` (a writer passes one of the six). The caller says what the
 * peers read.
 */
export function storedDiscipline(classDiscipline: string | undefined, fallback: Discipline, peerReadsExtra: boolean, peerReadsRegistry = false): Discipline {
  if (classDiscipline === undefined) return fallback;
  if (isKnownDiscipline(classDiscipline)) return classDiscipline;
  if (isExtraStored(classDiscipline)) return peerReadsExtra ? classDiscipline : fallback;
  // Any other registered discipline (an add-on's `fire_alarm`, a pack's `vt.elevators`): only to peers that read the registry.
  return peerReadsRegistry && disciplineWriteProblem(classDiscipline) === null ? classDiscipline : fallback;
}

/** An interest may name disciplines this version doesn't write (a newer page asking for civil). */
const interestDisciplineSchema = z.string().refine(isStoredDiscipline, "a discipline id (lower case, letters, digits, _ . :)");

/**
 * What one person has loaded: a set of areas (a level, optionally one zone on
 * it) and optionally only some disciplines. An absent interest means the
 * whole model, which is how the original duct-only clients behave.
 */
export const interestSchema = z.object({
  areas: z
    .array(z.object({ level: z.string().min(1).max(40), zone: z.string().min(1).max(40).optional() }))
    .min(1)
    .max(200),
  disciplines: z.array(interestDisciplineSchema).min(1).max(32).optional(),
});
export type Interest = z.infer<typeof interestSchema>;

/**
 * Levels and part types belong to the whole model: every area loads them, so a
 * part on any level can always find its level and its type.
 */
export const GLOBAL_LEVEL = "*";
export const GLOBAL_PARTITION: Partition = { level: GLOBAL_LEVEL, zone: "*", discipline: "architecture" };

export function partitionOf(el: BimElement): Partition {
  return el.partition ?? DEFAULT_PARTITION;
}

/** Stable string form, `level|zone|discipline`. Backends use it as a channel / row key. */
export function partitionKey(p: Partition): string {
  return `${p.level}|${p.zone}|${p.discipline}`;
}

export function parsePartitionKey(key: string): Partition | null {
  const [level, zone, discipline] = key.split("|");
  if (!level || !zone || !isStoredDiscipline(discipline)) return null;
  return { level, zone, discipline };
}

export function inInterest(p: Partition, interest: Interest | undefined): boolean {
  if (!interest || p.level === GLOBAL_LEVEL) return true;
  if (interest.disciplines && !interest.disciplines.includes(p.discipline) && !interest.disciplines.some((d) => disciplineCovers(d, p.discipline))) return false;
  return interest.areas.some((a) => a.level === p.level && (a.zone === undefined || a.zone === p.zone));
}

/** Elements a changeset removed, as they were before (their partition says who held them). */
function removedRecords(cs: Pick<Changeset, "removedIds" | "before">): BimElement[] {
  const out: BimElement[] = [];
  for (const id of cs.removedIds ?? []) {
    const prior = cs.before?.[id];
    if (prior) out.push(prior);
  }
  return out;
}

/** Partition keys of every element a changeset touched or removed, sorted. */
export function changesetPartitions(cs: Pick<Changeset, "elements" | "removedIds" | "before">): string[] {
  return [...new Set([...cs.elements, ...removedRecords(cs)].map((el) => partitionKey(partitionOf(el))))].sort();
}

/** Does a changeset touch anything inside the interest? */
export function changesetInInterest(cs: Pick<Changeset, "elements" | "removedIds" | "before">, interest: Interest | undefined): boolean {
  if (!interest) return true;
  return cs.elements.some((el) => inInterest(partitionOf(el), interest)) || removedRecords(cs).some((el) => inInterest(partitionOf(el), interest));
}

/** The changeset with only the elements inside the interest (what that person receives). */
export function sliceChangeset(cs: Changeset, interest: Interest | undefined): Changeset {
  if (!interest) return cs;
  const keep = (el: BimElement) => inInterest(partitionOf(el), interest);
  const sliced: Changeset = { ...cs, elements: cs.elements.filter(keep) };
  if (!cs.before) return sliced;
  const before: Record<string, BimElement | null> = {};
  for (const [id, prior] of Object.entries(cs.before)) {
    const now = cs.elements.find((el) => el.id === id);
    if ((prior && keep(prior)) || (now && keep(now))) before[id] = prior;
  }
  const removedIds = (cs.removedIds ?? []).filter((id) => {
    const prior = cs.before?.[id];
    return prior ? keep(prior) : false;
  });
  return { ...sliced, before, ...(cs.removedIds ? { removedIds } : {}) };
}

/**
 * The part of a model inside an interest: its elements, plus every connection
 * whose two ends are both inside. Generated models keep each system inside one
 * partition, so a slice is itself a valid, fully connected model.
 */
export function sliceModel(model: ModelState, interest: Interest | undefined): ModelState {
  if (!interest) return model;
  const index = partitionIndexOf(model);
  const groups = [...index.groups.values()].filter((g) => inInterest(g.partition, interest));
  const elements: Record<string, BimElement> = {};
  for (const id of memberIds(groups)) {
    const el = model.elements[id];
    if (el) elements[id] = el;
  }
  const candidates = new Set<number>();
  for (const g of groups) for (const i of index.connectionsByPartition.get(g.key) ?? []) candidates.add(i);
  const connections: Connection[] = [];
  for (const i of [...candidates].sort((a, b) => a - b)) {
    const c = model.connections[i];
    if (c && elements[c.a.elementId] && elements[c.b.elementId]) connections.push(c);
  }
  return { ...model, elements, connections };
}

/**
 * Which element ids and connections live in each partition, in model order.
 * Values are read from the record at slice time. Members are two flat arrays
 * (no object per element): `pos` orders them across groups (the element's
 * slot, or its position in key order for a draft), `ids` names them.
 */
interface PartitionGroup {
  readonly key: string;
  readonly partition: Partition;
  readonly pos: Int32Array;
  readonly ids: readonly string[];
}

interface PartitionIndex {
  readonly connections: readonly Connection[];
  readonly groups: Map<string, PartitionGroup>;
  /** Connection positions with at least one end in the partition. */
  readonly connectionsByPartition: Map<string, number[]>;
}

const partitionIndexes = new WeakMap<object, PartitionIndex>();

/** Every member of `groups`, in model order. */
function memberIds(groups: readonly PartitionGroup[]): readonly string[] {
  if (groups.length === 1) return groups[0]?.ids ?? [];
  const all: Array<{ pos: number; id: string }> = [];
  for (const g of groups) for (let i = 0; i < g.ids.length; i++) all.push({ pos: g.pos[i] ?? 0, id: g.ids[i] ?? "" });
  return all.sort((a, b) => a.pos - b.pos).map((m) => m.id);
}

/** Groups by level -> zone -> discipline, so finding an element's group builds no key string. */
class GroupLookup {
  private readonly byLevel = new Map<string, Map<string, Map<string, number>>>();
  private readonly byKey = new Map<string, number>();
  readonly keys: string[] = [];
  readonly partitions: Partition[] = [];
  readonly counts: number[] = [];

  indexOf(partition: Partition): number {
    let byZone = this.byLevel.get(partition.level);
    if (!byZone) {
      byZone = new Map();
      this.byLevel.set(partition.level, byZone);
    }
    let byDiscipline = byZone.get(partition.zone);
    if (!byDiscipline) {
      byDiscipline = new Map();
      byZone.set(partition.zone, byDiscipline);
    }
    let g = byDiscipline.get(partition.discipline);
    if (g === undefined) {
      const key = partitionKey(partition);
      // Two partitions with the same key string share one group, as before.
      g = this.byKey.get(key);
      if (g === undefined) {
        g = this.keys.length;
        this.byKey.set(key, g);
        this.keys.push(key);
        this.partitions.push(partition);
        this.counts.push(0);
      }
      byDiscipline.set(partition.discipline, g);
    }
    this.counts[g] = (this.counts[g] ?? 0) + 1;
    return g;
  }
}

/**
 * Built in one read of the elements, without a pair, an object or a map entry
 * per element: on a committed or plain record it walks the store's slots (the
 * store is indexed once here and reused by the first commit), records each
 * slot's group in a typed array and resolves connection ends through the
 * store's slot table.
 */
function partitionIndexOf(model: Pick<ModelState, "elements" | "connections">): PartitionIndex {
  const cached = partitionIndexes.get(model.elements);
  if (cached && cached.connections === model.connections) return cached;
  const lookup = new GroupLookup();
  const slots = recordSlots(model.elements);
  let groupOf: Int32Array;
  let posOf: (i: number) => number;
  let idOf: (i: number) => string;
  /** The group of connection `i`'s `a` / `b` end (-1: not in the record). */
  let groupOfA: (c: Connection, i: number) => number;
  let groupOfB: (c: Connection, i: number) => number;
  if (slots) {
    const n = slots.size;
    groupOf = new Int32Array(n).fill(-1);
    for (let s = 0; s < n; s++) {
      const el = slots.at(s);
      if (el !== undefined) groupOf[s] = lookup.indexOf(partitionOf(el));
    }
    const keys = slots.table.keys;
    const ends = connectionEndSlots(model.connections, slots);
    const groupAt = (s: number): number => (s < 0 ? -1 : (groupOf[s] ?? -1));
    posOf = (s) => s;
    idOf = (s) => keys[s] ?? "";
    groupOfA = (_c, i) => groupAt(ends.a[i] ?? -1);
    groupOfB = (_c, i) => groupAt(ends.b[i] ?? -1);
  } else {
    const entries = elementEntries(model.elements);
    groupOf = new Int32Array(entries.length);
    const byId = new Map<string, number>();
    entries.forEach(([id, el], i) => {
      const g = lookup.indexOf(partitionOf(el));
      groupOf[i] = g;
      byId.set(id, g);
    });
    posOf = (i) => i;
    idOf = (i) => entries[i]?.[0] ?? "";
    groupOfA = (c) => byId.get(c.a.elementId) ?? -1;
    groupOfB = (c) => byId.get(c.b.elementId) ?? -1;
  }
  const pos = lookup.counts.map((c) => new Int32Array(c));
  const ids = lookup.counts.map((c) => new Array<string>(c));
  const fill = new Int32Array(lookup.counts.length);
  for (let i = 0; i < groupOf.length; i++) {
    const g = groupOf[i] ?? -1;
    if (g < 0) continue;
    const at = fill[g] ?? 0;
    const p = pos[g];
    const list = ids[g];
    if (p) p[at] = posOf(i);
    if (list) list[at] = idOf(i);
    fill[g] = at + 1;
  }
  const groups: PartitionIndex["groups"] = new Map();
  lookup.keys.forEach((key, g) => {
    groups.set(key, { key, partition: lookup.partitions[g] ?? DEFAULT_PARTITION, pos: pos[g] ?? new Int32Array(0), ids: ids[g] ?? [] });
  });
  const connectionsByPartition = new Map<string, number[]>();
  const addConnection = (g: number, i: number): void => {
    const key = lookup.keys[g];
    if (key === undefined) return;
    const list = connectionsByPartition.get(key);
    if (list) list.push(i);
    else connectionsByPartition.set(key, [i]);
  };
  model.connections.forEach((c, i) => {
    const ga = groupOfA(c, i);
    const gb = groupOfB(c, i);
    if (ga >= 0) addConnection(ga, i);
    if (gb >= 0 && gb !== ga) addConnection(gb, i);
  });
  const built: PartitionIndex = { connections: model.connections, groups, connectionsByPartition };
  partitionIndexes.set(model.elements, built);
  return built;
}

/**
 * Carry `from`'s partition index to `to` when `to` differs only in the listed
 * elements, each of which either stayed in its partition or is new (appended
 * in element order, as every command adds). New elements copy only the groups
 * they join. Anything else is re-indexed on the next slice.
 */
export function sharePartitionIndex(
  from: Readonly<Record<string, BimElement>>,
  to: Readonly<Record<string, BimElement>>,
  changedIds: Iterable<string>,
): boolean {
  const index = partitionIndexes.get(from);
  if (!index || from === to) return false;
  const added: Array<[string, BimElement]> = [];
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    // Removed: the shared group lists keep the id; a slice skips ids the record does not hold.
    if (a && !b) continue;
    if (!b) return false;
    if (!a) added.push([id, b]);
    else if (partitionKey(partitionOf(a)) !== partitionKey(partitionOf(b))) return false;
  }
  if (added.length === 0) {
    partitionIndexes.set(to, index);
    return true;
  }
  const order = elementOrder(to);
  const groups = new Map(index.groups);
  for (const [id, el] of added) {
    const at = order.get(id);
    if (at === undefined) return false;
    const partition = partitionOf(el);
    const key = partitionKey(partition);
    const group = groups.get(key);
    const n = group?.ids.length ?? 0;
    const last = group?.pos[n - 1];
    if (last !== undefined && last >= at) return false;
    const pos = new Int32Array(n + 1);
    if (group) pos.set(group.pos);
    pos[n] = at;
    groups.set(key, { key, partition, pos, ids: [...(group?.ids ?? []), id] });
  }
  partitionIndexes.set(to, { connections: index.connections, groups, connectionsByPartition: index.connectionsByPartition });
  return true;
}

/** Elements in every partition `match` accepts, in element order. Uses the shared partition index. */
export function partitionMembers(model: Pick<ModelState, "elements" | "connections">, match: (p: Partition) => boolean): BimElement[] {
  const index = partitionIndexOf(model);
  const out: Array<{ pos: number; el: BimElement }> = [];
  for (const g of index.groups.values()) {
    if (!match(g.partition)) continue;
    for (let i = 0; i < g.ids.length; i++) {
      const el = model.elements[g.ids[i] ?? ""];
      if (el) out.push({ pos: g.pos[i] ?? 0, el });
    }
  }
  return out.sort((x, y) => x.pos - y.pos).map((x) => x.el);
}

/** Each element in every partition `match` accepts, group by group (no model-order sort): for reads whose order doesn't matter. */
export function forEachPartitionMember(model: Pick<ModelState, "elements" | "connections">, match: (p: Partition) => boolean, fn: (el: BimElement) => void): void {
  const index = partitionIndexOf(model);
  for (const g of index.groups.values()) {
    if (!match(g.partition)) continue;
    for (const id of g.ids) {
      const el = model.elements[id];
      if (el) fn(el);
    }
  }
}

/** Does any element sit in a partition on this level name? Reads the partition index's groups, not the elements. */
export function hasPartitionLevel(model: Pick<ModelState, "elements" | "connections">, level: string): boolean {
  for (const g of partitionIndexOf(model).groups.values()) if (g.partition.level === level && g.ids.length > 0) return true;
  return false;
}

/** Partitions in `next` that `prev` did not already cover, as an interest (null when nothing is new). */
export function addedInterest(prev: Interest | undefined, next: Interest): Interest | null {
  if (!prev) return null;
  const sameDisciplines = canonicalList(prev.disciplines) === canonicalList(next.disciplines);
  const areas = next.areas.filter(
    (a) => !(sameDisciplines && prev.areas.some((p) => p.level === a.level && (p.zone === undefined || p.zone === a.zone))),
  );
  if (areas.length === 0) return null;
  return { areas, ...(next.disciplines ? { disciplines: next.disciplines } : {}) };
}

function canonicalList(list: readonly string[] | undefined): string {
  return list ? [...list].sort().join(",") : "*";
}

/** Build the area index now (for example while a server starts) instead of on the first join. */
export function warmPartitionIndex(model: Pick<ModelState, "elements" | "connections">): void {
  partitionIndexOf(model);
}
