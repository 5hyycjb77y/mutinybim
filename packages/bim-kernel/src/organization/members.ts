import { registerRevisionCarry } from "../revision-carry";
import { elementValues } from "../store";
import type { BimElement, ElementId } from "../types";
import { DEFAULT_PHASE_ID, isOrganized } from "./model";

/**
 * Who names which group and phase, per element record, for the group and
 * phase commands (delete a group, reorder or delete a phase), so they read
 * the few elements concerned instead of the model. Keys are the stored ids as
 * written (a removed group or phase is resolved by the caller, against the
 * organization). Built in one pass; carried to the next revision through the
 * revision carry by moving only the changed elements.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface OrganizationMembers {
  /** Organized elements by the group id they store. */
  readonly byGroup: ReadonlyMap<string, ReadonlySet<ElementId>>;
  /** Organized elements that store a demolished phase. */
  readonly demolished: ReadonlySet<ElementId>;
  /** Per phase id: organized elements created in it (no stored phase counts as the default), demolished in it, and both. */
  readonly created: ReadonlyMap<string, number>;
  readonly demolishedIn: ReadonlyMap<string, number>;
  readonly both: ReadonlyMap<string, number>;
}

interface Keys {
  readonly group: string | undefined;
  readonly created: string;
  readonly demolished: string | undefined;
}

function keysOf(el: BimElement | undefined): Keys | null {
  if (!el || !isOrganized(el)) return null;
  return { group: el.groupId, created: el.phaseCreated ?? DEFAULT_PHASE_ID, demolished: el.phaseDemolished };
}

const cache = new WeakMap<Elements, OrganizationMembers>();

function bump(map: Map<string, number>, key: string, by: number): void {
  const n = (map.get(key) ?? 0) + by;
  if (n === 0) map.delete(key);
  else map.set(key, n);
}

class Builder {
  readonly byGroup: Map<string, ReadonlySet<ElementId>>;
  private demolished: ReadonlySet<ElementId>;
  private demolishedOwned: Set<ElementId> | null = null;
  readonly created: Map<string, number>;
  readonly demolishedIn: Map<string, number>;
  readonly both: Map<string, number>;
  /** Groups this builder has copied: the revision before keeps its own sets. */
  private readonly owned = new Map<string, Set<ElementId>>();

  constructor(from: OrganizationMembers | null) {
    this.byGroup = new Map(from?.byGroup ?? []);
    this.demolished = from?.demolished ?? new Set();
    this.created = new Map(from?.created ?? []);
    this.demolishedIn = new Map(from?.demolishedIn ?? []);
    this.both = new Map(from?.both ?? []);
  }

  private group(id: string): Set<ElementId> {
    let set = this.owned.get(id);
    if (!set) {
      set = new Set(this.byGroup.get(id) ?? []);
      this.owned.set(id, set);
      this.byGroup.set(id, set);
    }
    return set;
  }

  apply(id: ElementId, k: Keys, by: 1 | -1): void {
    if (k.group !== undefined) {
      const set = this.group(k.group);
      if (by > 0) set.add(id);
      else {
        set.delete(id);
        if (set.size === 0) {
          this.byGroup.delete(k.group);
          this.owned.delete(k.group);
        }
      }
    }
    if (k.demolished !== undefined) {
      if (!this.demolishedOwned) {
        this.demolishedOwned = new Set(this.demolished);
        this.demolished = this.demolishedOwned;
      }
      if (by > 0) this.demolishedOwned.add(id);
      else this.demolishedOwned.delete(id);
      bump(this.demolishedIn, k.demolished, by);
      if (k.demolished === k.created) bump(this.both, k.created, by);
    }
    bump(this.created, k.created, by);
  }

  done(): OrganizationMembers {
    return { byGroup: this.byGroup, demolished: this.demolished, created: this.created, demolishedIn: this.demolishedIn, both: this.both };
  }
}

export function organizationMembersOf(elements: Elements): OrganizationMembers {
  const hit = cache.get(elements);
  if (hit) return hit;
  const b = new Builder(null);
  for (const el of elementValues(elements)) {
    const k = keysOf(el);
    if (k) b.apply(el.id, k, 1);
  }
  const built = b.done();
  cache.set(elements, built);
  return built;
}

registerRevisionCarry("organization.members", (from, to, changedIds) => {
  const index = cache.get(from);
  if (!index || cache.has(to)) return;
  const b = new Builder(index);
  for (const id of changedIds) {
    const before = from[id];
    const after = to[id];
    if (before === after) continue;
    const was = keysOf(before);
    const now = keysOf(after);
    if (was && before) b.apply(before.id, was, -1);
    if (now && after) b.apply(after.id, now, 1);
  }
  cache.set(to, b.done());
});
