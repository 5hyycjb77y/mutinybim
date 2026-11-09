import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { RequirementAnchorKind } from "./types";

/**
 * Which records an anchor kind is read from (round 11, D3,
 * `graph.anchor_kind` v1). `space`, `zone`, `element` and `model` are the
 * graph's own and need no row. A row names the stored record kinds whose
 * records are anchors of its kind: the kernel's `site` record is the `site`
 * anchor and its `gate` records the `gate` anchor; an add-on that owns a
 * land record registers it as the `parcel` anchor. `lineage` anchors are
 * lineage ids, not records: only a rule's `appliesAt.anchors` names them.
 *
 * Not namespaced: an anchor kind is a shared word. Two add-ons naming one
 * anchor kind add their record kinds to it.
 */
export interface GraphAnchorKindRow {
  readonly anchor: RequirementAnchorKind;
  /** What a person reads ("Parcel"). */
  readonly label: string;
  /** Stored record kinds whose records are anchors of this kind. Empty: anchored by id only. */
  readonly recordKinds: readonly string[];
}

export const BUILTIN_ANCHOR_KIND_ROWS: readonly GraphAnchorKindRow[] = Object.freeze([
  { anchor: "site", label: "Site", recordKinds: ["site"] },
  { anchor: "gate", label: "Gate", recordKinds: ["gate"] },
  { anchor: "lineage", label: "Copy", recordKinds: [] },
]);

export const GRAPH_ANCHOR_POINT = defineExtensionPoint<GraphAnchorKindRow>({
  id: "graph.anchor_kind",
  version: 1,
  label: "Requirement anchors",
  idOf: (row) => row.anchor,
  namespaced: false,
  builtins: () => BUILTIN_ANCHOR_KIND_ROWS,
});

/** The graph's own anchor kinds: read from the model without a row. */
export const GRAPH_OWN_ANCHOR_KINDS: ReadonlySet<string> = new Set(["space", "zone", "element", "model"]);

export interface AnchorKindTable {
  /** Record kinds read as anchors of `anchor` (empty when none). */
  recordKinds(anchor: string): readonly string[];
  /** The anchor kind a stored record kind is, when a row names it. */
  anchorOfRecordKind(kind: string): string | undefined;
}

const TABLE_KEY = "graph.anchor_kind#table";

export function anchorKindTable(set: PackSet = activePackSet()): AnchorKindTable {
  return set.memo(TABLE_KEY, () => {
    const byAnchor = new Map<string, string[]>();
    const byKind = new Map<string, string>();
    for (const row of set.items(GRAPH_ANCHOR_POINT)) {
      if (GRAPH_OWN_ANCHOR_KINDS.has(row.anchor)) {
        console.error(`[bim-kernel/graph] an add-on registers the anchor kind "${row.anchor}", which is the graph's own; the row is ignored`);
        continue;
      }
      const list = byAnchor.get(row.anchor) ?? [];
      for (const k of row.recordKinds) {
        const prior = byKind.get(k);
        if (prior !== undefined && prior !== row.anchor) {
          console.error(`[bim-kernel/graph] the record kind "${k}" is named as both a ${prior} and a ${row.anchor} anchor; the first is used`);
          continue;
        }
        byKind.set(k, row.anchor);
        if (!list.includes(k)) list.push(k);
      }
      byAnchor.set(row.anchor, list);
    }
    return { recordKinds: (anchor) => byAnchor.get(anchor) ?? [], anchorOfRecordKind: (kind) => byKind.get(kind) };
  });
}
