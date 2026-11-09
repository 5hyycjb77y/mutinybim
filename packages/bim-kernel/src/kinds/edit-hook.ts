import { registerEditHook } from "../command-core";
import { decidingUndo, peerReads } from "../elements/feature";
import { KernelError } from "../model";
import { elementKindTable, isNewForOlderPeers, kindShapeAccepts, upgradeFeatureOf } from "../registry/element-kind-point";
import { olderServerKindRefusal } from "./index";

// A record of a kind no older peer stores never reaches one: the edit is refused in the older-server words (`olderServerKindRefusal`)
// until every peer advertises the row's upgrade feature (`kinds:addon_owned`, or `kinds:addon_shapes` for a kind with a shape or ends).
// Strict writers: a record of a kind whose row declares a shape is written only in that shape (stored records are read as they are).
registerEditHook("element-kinds", (base, working, touchedIds) => {
  if (decidingUndo()) return;
  const table = elementKindTable();
  if (table.kinds.length === 0) return;
  for (const id of touchedIds) {
    const el = working[id];
    if (!el) continue;
    const row = table.row(el.kind);
    if (row === undefined) continue;
    if (row.shape !== undefined && base.elements[id] !== el && !kindShapeAccepts(row, el)) {
      const names = row.shape.fields.filter((f) => f.optional !== true).map((f) => f.name);
      throw new KernelError("invalid_value", `This ${row.label.toLowerCase()} is missing part of its shape (it needs ${names.join(", ")}). Nothing changed`, [el.id]);
    }
    if (!base.elements[id] && isNewForOlderPeers(row) && !peerReads(upgradeFeatureOf(row))) throw new KernelError("invalid_value", olderServerKindRefusal(row), [el.id]);
  }
});
