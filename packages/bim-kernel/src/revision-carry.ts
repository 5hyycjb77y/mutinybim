import type { BimElement } from "./types";

/**
 * Indexes kept per element record move onto the next revision here, wherever
 * a revision is made from the one before (the command core, a committed or an
 * applied changeset). Each index registers how it carries itself when its
 * module loads; an index nothing has loaded has nothing to carry. A leaf:
 * imports nothing at runtime, so any module may register and any revision
 * maker may call it without an import cycle.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Move what is known about `from` onto `to`, a record that differs from it only at `changedIds` (added, written or removed). */
export type RevisionCarry = (from: Elements, to: Elements, changedIds: readonly string[]) => void;

const carries = new Map<string, RevisionCarry>();

/** Register an index's carry under a stable name (re-registering replaces it, so a module reloaded in tests stays single). */
export function registerRevisionCarry(name: string, carry: RevisionCarry): void {
  carries.set(name, carry);
}

/** Run every registered carry for one new revision. A carry that throws is logged and skipped: its index then rebuilds on first read. */
export function carryRevision(from: Elements, to: Elements, changedIds: Iterable<string>): void {
  if (from === to || carries.size === 0) return;
  const ids = [...changedIds];
  for (const [name, carry] of carries) {
    try {
      carry(from, to, ids);
    } catch (err) {
      console.error(`[revision-carry] ${name} failed; its index rebuilds on first read`, err);
    }
  }
}
