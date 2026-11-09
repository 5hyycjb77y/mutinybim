import { elementsOfKind } from "../store";
import type { BimElement, ElementId } from "../types";
import { devicePartOf, loadAnchorOf, type LoadRecord } from "./anchor";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Where loads are, without computing it from their ids (KERNEL-REQUIREMENTS-MODEL
 * §6.1). Today's `lp:<host>:<port>` ids stay valid, but a load can move to
 * another anchor and keep its id, and new loads get generated ids, so the run
 * graph asks this index "which load is on this end?" instead of building an id.
 *
 * One index per element record, carried from the previous revision with the
 * edit's changed ids (`shareLoadIndex`, like `shareNetwork` and
 * `sharePartitionIndex`): an edit costs its own loads, never a pass over the
 * model. A record nobody carried is indexed once from `elementsOfKind`.
 *
 * The one-load-per-open-end rule is the command's (load-points/commands.ts);
 * the index trusts it and keeps the first in key order if a merge ever breaks it.
 */

/** A persistent string map: a chain of small layers over a full root, flattened once the chain is long. */
class Layered<V> {
  private constructor(
    private readonly own: ReadonlyMap<string, V | null>,
    private readonly parent: Layered<V> | null,
    private readonly depth: number,
  ) {}

  static of<V>(entries: ReadonlyMap<string, V>): Layered<V> {
    return new Layered<V>(entries, null, 0);
  }

  get(key: string): V | undefined {
    for (let layer: Layered<V> | null = this; layer; layer = layer.parent) {
      const v = layer.own.get(key);
      if (v !== undefined) return v === null ? undefined : v;
      if (layer.own.has(key)) return undefined;
    }
    return undefined;
  }

  /** A new map with `delta` applied (null removes). Flattens past 32 layers, so a read is at most 32 lookups and the flatten is amortised over 32 edits. */
  with(delta: ReadonlyMap<string, V | null>): Layered<V> {
    if (delta.size === 0) return this;
    if (this.depth < 32) return new Layered<V>(delta, this, this.depth + 1);
    const flat = new Map<string, V>();
    this.collect(flat);
    for (const [k, v] of delta) {
      if (v === null) flat.delete(k);
      else flat.set(k, v);
    }
    return Layered.of(flat);
  }

  private collect(into: Map<string, V>): void {
    if (this.parent) this.parent.collect(into);
    for (const [k, v] of this.own) {
      if (v === null) into.delete(k);
      else into.set(k, v);
    }
  }
}

const NO_IDS: readonly ElementId[] = Object.freeze([]);

export interface LoadIndex {
  /** The load on a run end (`runEndKey`). */
  atRunEnd(hostId: string, port: string): ElementId | undefined;
  /** Loads a part stands for (attached) or carries (anchored to its connector). */
  ofPart(partId: string): readonly ElementId[];
  /** Estimates spread over a space or zone. */
  inSpace(spaceId: string): readonly ElementId[];
  inZone(zoneId: string): readonly ElementId[];
  /** Loads that name this source before (or regardless of) any drawing: WH-1, the meter, panel P1. */
  servedBy(sourceId: string): readonly ElementId[];
}

interface Maps {
  readonly runEnd: Layered<ElementId>;
  readonly part: Layered<readonly ElementId[]>;
  readonly space: Layered<readonly ElementId[]>;
  readonly zone: Layered<readonly ElementId[]>;
  readonly source: Layered<readonly ElementId[]>;
}

export function runEndKey(hostId: string, port: string): string {
  return `${hostId}\u0001${port}`;
}

/** The index keys a load sits under. */
interface Keys {
  readonly runEnd: string | null;
  readonly part: string | null;
  readonly space: string | null;
  readonly zone: string | null;
  readonly source: string | null;
}

function keysOf(lp: LoadRecord): Keys {
  const a = loadAnchorOf(lp);
  return {
    runEnd: a.kind === "run_end" ? runEndKey(a.hostId, a.port) : null,
    part: devicePartOf(lp),
    space: a.kind === "space" ? a.id : null,
    zone: a.kind === "zone" ? a.id : null,
    source: lp.servedBy ?? null,
  };
}

class Index implements LoadIndex {
  constructor(readonly maps: Maps) {}
  atRunEnd(hostId: string, port: string): ElementId | undefined {
    return this.maps.runEnd.get(runEndKey(hostId, port));
  }
  ofPart(partId: string): readonly ElementId[] {
    return this.maps.part.get(partId) ?? NO_IDS;
  }
  inSpace(spaceId: string): readonly ElementId[] {
    return this.maps.space.get(spaceId) ?? NO_IDS;
  }
  inZone(zoneId: string): readonly ElementId[] {
    return this.maps.zone.get(zoneId) ?? NO_IDS;
  }
  servedBy(sourceId: string): readonly ElementId[] {
    return this.maps.source.get(sourceId) ?? NO_IDS;
  }
}

const cache = new WeakMap<object, Index>();
export const loadIndexStats = { builds: 0, carries: 0 };

function pushTo(map: Map<string, ElementId[]>, key: string | null, id: ElementId): void {
  if (key === null) return;
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

function build(elements: Elements): Index {
  loadIndexStats.builds += 1;
  const runEnd = new Map<string, ElementId>();
  const part = new Map<string, ElementId[]>();
  const space = new Map<string, ElementId[]>();
  const zone = new Map<string, ElementId[]>();
  const source = new Map<string, ElementId[]>();
  for (const lp of elementsOfKind(elements, "load_point")) {
    const k = keysOf(lp);
    if (k.runEnd !== null && !runEnd.has(k.runEnd)) runEnd.set(k.runEnd, lp.id);
    pushTo(part, k.part, lp.id);
    pushTo(space, k.space, lp.id);
    pushTo(zone, k.zone, lp.id);
    pushTo(source, k.source, lp.id);
  }
  return new Index({ runEnd: Layered.of(runEnd), part: Layered.of(part), space: Layered.of(space), zone: Layered.of(zone), source: Layered.of(source) });
}

/**
 * The index for an element record. Do not call it on a draft a command is
 * still writing load points into (it would be cached stale): commands check
 * the open-end rule against the base index plus their own writes.
 */
export function loadIndexOf(elements: Elements): LoadIndex {
  const cached = cache.get(elements);
  if (cached) return cached;
  const built = build(elements);
  cache.set(elements, built);
  return built;
}

class ListDelta {
  readonly changes = new Map<string, ElementId[] | null>();
  constructor(private readonly base: Layered<readonly ElementId[]>) {}
  private current(key: string): ElementId[] {
    const c = this.changes.get(key);
    if (c !== undefined) return c ?? [];
    return [...(this.base.get(key) ?? NO_IDS)];
  }
  remove(key: string | null, id: ElementId): void {
    if (key === null) return;
    const next = this.current(key).filter((x) => x !== id);
    this.changes.set(key, next.length === 0 ? null : next);
  }
  add(key: string | null, id: ElementId): void {
    if (key === null) return;
    const next = this.current(key);
    if (!next.includes(id)) next.push(id);
    this.changes.set(key, next);
  }
}

/**
 * Carry `from`'s index to `to`, which differs only in `changedIds` (removed
 * ids included). Cost: the changed loads. Returns false when `from` has no
 * index yet (then `to` is indexed on first use).
 */
export function shareLoadIndex(from: Elements, to: Elements, changedIds: Iterable<string>): boolean {
  const index = cache.get(from);
  if (!index || from === to) return false;
  if (cache.has(to)) return true;
  const runEnd = new Map<string, ElementId | null>();
  const part = new ListDelta(index.maps.part);
  const space = new ListDelta(index.maps.space);
  const zone = new ListDelta(index.maps.zone);
  const source = new ListDelta(index.maps.source);
  let touched = false;
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    const before = a?.kind === "load_point" ? keysOf(a) : null;
    const after = b?.kind === "load_point" ? keysOf(b) : null;
    if (!before && !after) continue;
    touched = true;
    const eid = (b ?? a)?.id as ElementId;
    if (before) {
      if (before.runEnd !== null && (runEnd.get(before.runEnd) ?? index.maps.runEnd.get(before.runEnd)) === eid) runEnd.set(before.runEnd, null);
      part.remove(before.part, eid);
      space.remove(before.space, eid);
      zone.remove(before.zone, eid);
      source.remove(before.source, eid);
    }
    if (after) {
      if (after.runEnd !== null) {
        const held = runEnd.has(after.runEnd) ? runEnd.get(after.runEnd) : index.maps.runEnd.get(after.runEnd);
        if (held === undefined || held === null || held === eid) runEnd.set(after.runEnd, eid);
      }
      part.add(after.part, eid);
      space.add(after.space, eid);
      zone.add(after.zone, eid);
      source.add(after.source, eid);
    }
  }
  loadIndexStats.carries += 1;
  if (!touched) {
    cache.set(to, index);
    return true;
  }
  cache.set(
    to,
    new Index({
      runEnd: index.maps.runEnd.with(runEnd),
      part: index.maps.part.with(part.changes),
      space: index.maps.space.with(space.changes),
      zone: index.maps.zone.with(zone.changes),
      source: index.maps.source.with(source.changes),
    }),
  );
  return true;
}
