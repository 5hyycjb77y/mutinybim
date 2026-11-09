import { registerRevisionCarry } from "../revision-carry";
import { elementValues } from "../store";
import type { BimElement } from "../types";

/**
 * What each element hosts (a wall's doors and windows, a segment's taps):
 * every record that names a `hostId`. Built once per element record by one
 * pass, then carried to the next revision by moving only the changed
 * elements, so a measure that reads a host's openings never scans the model
 * on an edit.
 *
 * Layered: a carried index is the revision before plus the hosts the edit
 * changed. Lookups walk at most `MAX_DEPTH` layers; past that the layers
 * fold into one map.
 */

type Elements = Readonly<Record<string, BimElement>>;

const MAX_DEPTH = 32;
const NONE: readonly string[] = Object.freeze([]);

interface Layer {
  readonly parent: Layer | null;
  readonly own: ReadonlyMap<string, readonly string[]>;
  readonly depth: number;
}

const cache = new WeakMap<Elements, Layer>();

/** The host an element names, or null. */
export function hostIdOf(el: BimElement | undefined): string | null {
  if (!el || !("hostId" in el)) return null;
  const host: unknown = el.hostId;
  return typeof host === "string" && host !== "" ? host : null;
}

function lookup(layer: Layer, hostId: string): readonly string[] {
  for (let l: Layer | null = layer; l; l = l.parent) {
    const hit = l.own.get(hostId);
    if (hit) return hit;
  }
  return NONE;
}

function build(elements: Elements): Layer {
  const own = new Map<string, string[]>();
  for (const el of elementValues(elements)) {
    const host = hostIdOf(el);
    if (host === null) continue;
    const list = own.get(host);
    if (list) list.push(el.id);
    else own.set(host, [el.id]);
  }
  return { parent: null, own, depth: 0 };
}

function fold(layer: Layer): Layer {
  const chain: Layer[] = [];
  for (let l: Layer | null = layer; l; l = l.parent) chain.push(l);
  const own = new Map<string, readonly string[]>();
  for (let i = chain.length - 1; i >= 0; i--) for (const [k, v] of chain[i]?.own ?? []) own.set(k, v);
  return { parent: null, own, depth: 0 };
}

/** The layer for `to`, a record that differs from `from` only at `changedIds`. */
function derive(base: Layer, from: Elements, to: Elements, changedIds: Iterable<string>): Layer {
  const own = new Map<string, string[]>();
  const listFor = (host: string): string[] => {
    let list = own.get(host);
    if (!list) {
      list = [...lookup(base, host)];
      own.set(host, list);
    }
    return list;
  };
  for (const id of changedIds) {
    const was = hostIdOf(from[id]);
    const now = hostIdOf(to[id]);
    if (was === now) continue;
    if (was !== null) {
      const list = listFor(was);
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    if (now !== null) {
      const list = listFor(now);
      if (!list.includes(id)) list.push(id);
    }
  }
  if (own.size === 0) return base;
  const next: Layer = { parent: base, own, depth: base.depth + 1 };
  return next.depth > MAX_DEPTH ? fold(next) : next;
}

/** The ids of the elements hosted on `hostId` in this record, in no particular order. */
export function hostedIds(elements: Elements, hostId: string): readonly string[] {
  let layer = cache.get(elements);
  if (!layer) {
    layer = build(elements);
    cache.set(elements, layer);
  }
  return lookup(layer, hostId);
}

/**
 * Make `to`'s index from `from`'s when `to` was made outside the command
 * core (a scenario overlay, a preview): `to` differs from `from` only at
 * `changedIds`. No-op when `to` already has one; builds `from`'s first if
 * needed (one pass, then cached).
 */
export function carryHostedIndex(from: Elements, to: Elements, changedIds: Iterable<string>): void {
  if (from === to || cache.has(to)) return;
  let base = cache.get(from);
  if (!base) {
    base = build(from);
    cache.set(from, base);
  }
  cache.set(to, derive(base, from, to, changedIds));
}

registerRevisionCarry("qto.hosted", (from, to, changedIds) => {
  const base = cache.get(from);
  if (!base || cache.has(to)) return;
  cache.set(to, derive(base, from, to, changedIds));
});
