import { registerEditHook } from "../command-core";
import type { BimElement, ElementId } from "../types";
import { decidingUndo, elementCoreWritable, isCoreElement } from "./feature";
import { builtinRegistry } from "../registry/builtin";
import { builtinClassOf } from "./recognise";

/**
 * A class the upgrade on edit filled from recognition (`classSource:
 * "recognised"`) follows the fields recognition reads: when an edit changes
 * them (an opening's type), the stored class is recognised again in the same
 * change, or dropped when nothing recognises the element any more. A class a
 * person set is never touched. Undo stands aside.
 */
function refresh(working: Record<string, BimElement>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo() || !elementCoreWritable()) return;
  for (const id of touchedIds) {
    const el = working[id];
    if (!isCoreElement(el) || el.classSource !== "recognised") continue;
    // A class from an add-on this process does not have (the add-on is off) is kept as stored.
    if (el.classId !== undefined && !builtinRegistry().getClass(el.classId)) continue;
    const now = builtinClassOf(el);
    if (now === el.classId) continue;
    if (now !== null) {
      working[id] = { ...el, classId: now };
      continue;
    }
    const { classId: _stale, classSource: _source, ...rest } = el;
    working[id] = rest;
  }
}

registerEditHook("element-class-refresh", (_base, working, touchedIds) => {
  refresh(working, touchedIds);
});
