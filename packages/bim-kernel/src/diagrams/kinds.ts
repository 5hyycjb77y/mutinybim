import { peerReads } from "../elements/feature";
import { diagramLayoutRow } from "../layout/diagram-layout-point";
import { activePackSet } from "../packs/scope";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { packNotLoadedMessage } from "../packs/set";
import { DIAGRAM_KIND_LABELS, DIAGRAM_OPEN_KINDS_FEATURE, isRound5DiagramKind, type StoredDiagramKind } from "./definition";
import { DIAGRAM_GRAPH_POINT } from "./graph";

/**
 * Stored diagram kinds are open (contract 1.12.0): besides the four every peer
 * reads, a view stores the kind of any diagram layout row in the set in force.
 * Readers are tolerant: a view whose kind no loaded add-on draws keeps its
 * bytes and is drawn empty, naming the add-on (`layoutRowFor`). Writers are
 * strict: a view is given a kind only when a row in force draws it and every
 * peer reads open kinds.
 */

/** What a diagram kind is called: its layout row's label in force, the built-in label, or the stored kind itself. */
export function diagramKindLabel(kind: StoredDiagramKind): string {
  return diagramLayoutRow(kind)?.label ?? DIAGRAM_KIND_LABELS[kind] ?? kind;
}

/** Every live diagram kind available in the active pack set (graph + label). */
export function diagramKinds(): readonly { readonly kind: StoredDiagramKind; readonly label: string }[] {
  const set = activePackSet();
  const seen = new Set<string>();
  const out: Array<{ readonly kind: StoredDiagramKind; readonly label: string }> = [];
  for (const g of set.items(DIAGRAM_GRAPH_POINT)) {
    if (seen.has(g.kind)) continue;
    seen.add(g.kind);
    out.push({ kind: g.kind, label: diagramKindLabel(g.kind) });
  }
  return out;
}

/**
 * Why a view can't be given this diagram kind here, in words, or null.
 * `reads` answers whether every peer reads a protocol feature (default: the
 * peers of the command being decided; a screen passes its server's features).
 */
export function diagramKindStoreRefusal(kind: StoredDiagramKind, reads: (feature: string) => boolean = peerReads): string | null {
  if (isRound5DiagramKind(kind)) return null;
  const row = diagramLayoutRow(kind);
  if (!row) {
    const owner = firstPartyStoredOwner("diagram", kind);
    return owner
      ? `${packNotLoadedMessage(owner)}, so its diagrams can't be made in this model.`
      : `No add-on in this model draws ${kind} diagrams, so a view of one can't be made. Turn on the add-on that adds them, then try again.`;
  }
  if (!reads(DIAGRAM_OPEN_KINDS_FEATURE)) return `${row.label} views can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.`;
  return null;
}
