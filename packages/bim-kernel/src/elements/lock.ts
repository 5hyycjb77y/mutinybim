import { refuse, registerEditHook } from "../command-core";
import type { BimElement, ElementId } from "../types";
import { coreElementName, decidingUndo, isCoreElement } from "./feature";
import { lockOf } from "./read";

/**
 * Per-element locks (KERNEL-FOUNDATION §3.9): existing conditions and issued
 * work refuse every change, in plain words with the reason they were locked
 * for. Every command's `finish` runs this over what it touched, so no command
 * needs to know about locks; only the lock commands themselves
 * (`withLockChange`) may change a locked element's lock. Undo stands aside: it
 * restores stored records exactly, a lock included.
 */

let changingLocks: ReadonlySet<string> | null = null;

/** Decide `fn` as a lock or unlock of `ids`: those may change while locked. */
export function withLockChange<T>(ids: Iterable<string>, fn: () => T): T {
  const previous = changingLocks;
  changingLocks = new Set(ids);
  try {
    return fn();
  } finally {
    changingLocks = previous;
  }
}

const STATE_WORDS: Readonly<Record<string, string>> = { existing: "existing conditions", issued: "issued work" };

/** Why `el` can't change, or null when it isn't locked. */
export function lockedRefusal(el: BimElement | undefined): string | null {
  const read = lockOf(el);
  if (!read || !isCoreElement(el)) return null;
  const state = STATE_WORDS[read.lock.state] ?? `"${read.lock.state}"`;
  const reason = read.lock.reason.trim();
  return `${coreElementName(el)} is locked as ${state}${reason ? ` (${reason})` : ""}, so it can't be changed. Unlock it first`;
}

function checkLocks(base: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const before = base[id];
    if (!before || working[id] === before) continue;
    if (changingLocks?.has(id)) continue;
    const why = lockedRefusal(before);
    if (why) refuse("locked", why, [id]);
  }
}

registerEditHook("element-locks", (base, working, touchedIds) => {
  checkLocks(base.elements, working, touchedIds);
});
