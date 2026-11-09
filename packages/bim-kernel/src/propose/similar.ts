import { typicalOf } from "../organization/typicals";
import { registerRevisionCarry } from "../revision-carry";
import { outlineAreaMm2, spaceAreaM2 } from "../spaces/space-geometry";
import { elementsOfKind } from "../store";
import type { BimElement } from "../types";

/**
 * "Spaces like this one" (round 7 lane R): the rooms and spaces with the same
 * use as the one given (a space's use, else a room's name without its
 * number) and a floor area within `AREA_TOLERANCE`, on any level. A typical's
 * copies stand for one: only the first member of each typical group is
 * listed. The index is carried from one revision to the next (only the
 * changed rooms and spaces are re-read), so neither a hover nor an edit scans
 * the model.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** How far a similar room's area may differ, as a fraction (0.25 = within 25%). */
export const AREA_TOLERANCE = 0.25;

interface Entry {
  readonly id: string;
  readonly key: string;
  readonly areaM2: number | null;
  readonly typicalGroup: string | null;
}

interface SimilarIndex {
  readonly byId: Map<string, Entry>;
  readonly byKey: Map<string, Entry[]>;
}

const indexes = new WeakMap<Elements, SimilarIndex>();

/** A room name's words without numbers and punctuation ("Office 101" and "OFFICE-102" are both "office"). */
export function nameWordsOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function entryOf(elements: Elements, el: BimElement): Entry | null {
  if (el.kind === "space") {
    const use = el.use?.useId;
    const key = use ? `use:${use}` : el.name ? `name:${nameWordsOf(el.name)}` : null;
    if (!key || key === "name:") return null;
    return { id: el.id, key, areaM2: spaceAreaM2(elements, el), typicalGroup: typicalOf(elements, el)?.groupId ?? null };
  }
  if (el.kind === "room") {
    const words = nameWordsOf(el.name);
    if (!words) return null;
    const area = el.areaSqM > 0 ? el.areaSqM : outlineAreaMm2(el.outline) / 1e6;
    return { id: el.id, key: `name:${words}`, areaM2: area > 0 ? area : null, typicalGroup: typicalOf(elements, el)?.groupId ?? null };
  }
  return null;
}

function indexOf(elements: Elements): SimilarIndex {
  const cached = indexes.get(elements);
  if (cached) return cached;
  const byId = new Map<string, Entry>();
  const byKey = new Map<string, Entry[]>();
  for (const el of [...elementsOfKind(elements, "space"), ...elementsOfKind(elements, "room")]) {
    const e = entryOf(elements, el);
    if (!e) continue;
    byId.set(e.id, e);
    const list = byKey.get(e.key);
    if (list) list.push(e);
    else byKey.set(e.key, [e]);
  }
  const index = { byId, byKey };
  indexes.set(elements, index);
  return index;
}

function remove(index: SimilarIndex, id: string): void {
  const e = index.byId.get(id);
  if (!e) return;
  index.byId.delete(id);
  const list = index.byKey.get(e.key);
  if (!list) return;
  const next = list.filter((x) => x.id !== id);
  if (next.length > 0) index.byKey.set(e.key, next);
  else index.byKey.delete(e.key);
}

function add(index: SimilarIndex, e: Entry): void {
  index.byId.set(e.id, e);
  index.byKey.set(e.key, [...(index.byKey.get(e.key) ?? []), e]);
}

/**
 * Carry the index onto the next revision: re-read only the changed rooms and
 * spaces. A changed group record can regroup typical members, so it drops the
 * index (rebuilt on the next ask).
 */
registerRevisionCarry("propose.similar", (from, to, changedIds) => {
  const prior = indexes.get(from);
  if (!prior) return;
  if (changedIds.some((id) => from[id]?.kind === "organization" || to[id]?.kind === "organization")) return;
  // A space drawn from rooms takes its area from them: a changed room then rebuilds.
  const roomChanged = changedIds.some((id) => from[id]?.kind === "room" || to[id]?.kind === "room");
  if (roomChanged && elementsOfKind(to, "space").some((sp) => sp.bounds.kind !== "outline")) return;
  const next: SimilarIndex = { byId: new Map(prior.byId), byKey: new Map(prior.byKey) };
  for (const id of changedIds) {
    remove(next, id);
    const el = to[id];
    const e = el ? entryOf(to, el) : null;
    if (e) add(next, e);
  }
  indexes.set(to, next);
});

/** The rooms or spaces like `roomId` (it excluded), typicals counted once, in id order. Empty when it has no use to compare. */
export function similarRooms(elements: Elements, roomId: string): readonly string[] {
  const index = indexOf(elements);
  const me = index.byId.get(roomId);
  if (!me) return [];
  const seenTypicals = new Set<string>(me.typicalGroup ? [me.typicalGroup] : []);
  const out: string[] = [];
  for (const other of index.byKey.get(me.key) ?? []) {
    if (other.id === me.id) continue;
    if (me.areaM2 !== null && other.areaM2 !== null && Math.abs(other.areaM2 - me.areaM2) > AREA_TOLERANCE * me.areaM2) continue;
    if (other.typicalGroup) {
      if (seenTypicals.has(other.typicalGroup)) continue;
      seenTypicals.add(other.typicalGroup);
    }
    out.push(other.id);
  }
  return out.sort();
}
