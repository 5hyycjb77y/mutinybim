/**
 * One extension point as the conformance suite and the listing read it. Apart
 * from `points.ts` (which lists every point this release reads, and so imports
 * every layer) because an add-on declares its own points at run time
 * (`declaredPoint`) and must not pull that list in with them.
 */
import type { ExtensionPoint, PackSet } from "@permitzip/bim-kernel/packs";

/** A point as the suite and the listing read it, with its item type closed over. */
export interface KnownPoint {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  /** Problems with one pack's items here, in plain words; the set has already been built. */
  check(set: PackSet, packId: string): string[];
  /** Built-in rows here per first-party pack id. */
  builtinCounts(): ReadonlyMap<string, number>;
}

export type Checker<T> = (items: readonly T[], set: PackSet, packId: string) => string[];

export function caught(what: string, fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (err) {
    return [`${what}: ${err instanceof Error ? err.message : String(err)}`];
  }
}

export function known<T>(point: ExtensionPoint<T>, check: Checker<T>, owner: ((item: T) => string | null) | null): KnownPoint {
  return {
    id: point.id,
    version: point.version,
    label: point.label,
    check(set, packId) {
      const mine = set.pack(packId)?.contributions.filter((c) => c.pointId === point.id) ?? [];
      if (mine.length === 0) return [];
      // `items` refuses a pack row that equals a built-in row.
      const refusal = caught(point.label, () => set.items(point));
      if (refusal.length > 0) return refusal;
      const ofPack = new Set(mine.flatMap((c) => c.items));
      return check(set.packItems(point).filter((item) => ofPack.has(item)), set, packId);
    },
    builtinCounts() {
      const out = new Map<string, number>();
      if (!owner) return out;
      for (const item of point.builtins?.() ?? []) {
        const id = owner(item);
        if (id) out.set(id, (out.get(id) ?? 0) + 1);
      }
      return out;
    },
  };
}

/**
 * An extension point an add-on declares for others to contribute to (a firm's
 * demand rules into Electrical's). The add-on exports these; conformance for
 * it, or for a pack built on it, passes them in `points`.
 */
export function declaredPoint<T>(point: ExtensionPoint<T>, check: (items: readonly T[]) => string[]): KnownPoint {
  return known(point, (items) => check(items), null);
}
