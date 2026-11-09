import { systemRules, elementsOfKind } from "@permitzip/bim-kernel";
import type { MepSystem, BimElement, ElementId, DiagramHints, DiagramGraph, DiagramNode, DiagramPipe } from "@permitzip/bim-kernel";
import { plumbingTrees } from "./plumbing-topology";

/**
 * The plumbing riser graph, read from routed piping: one tree per plumbing
 * system (domestic cold, hot, sanitary, vent, gas…), rooted where the pipe
 * report counts from, with the system's real branch structure: the main, each
 * branch off it as its own line, devices (cleanouts, valves, meters) where
 * they sit, and every fixture at the end of its pipe (plumbing-topology.ts).
 * A system fed from a fixture of another system drawn here (hot water from the
 * water heater on the cold line) continues from that fixture, as one riser.
 * Same engine as the electrical one-line and riser: only the graph is plumbing's.
 */

type Elements = Readonly<Record<string, BimElement>>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Plumbing systems in the model, by name, filtered to the kinds asked for. */
export function plumbingSystems(elements: Elements, kinds?: readonly string[]): MepSystem[] {
  const want = kinds && kinds.length > 0 ? new Set(kinds) : null;
  const out: MepSystem[] = [];
  for (const el of elementsOfKind(elements, "mep_system")) {
    if (el.domain !== "pipe") continue;
    if (systemRules(el.systemKind).discipline !== "plumbing") continue;
    if (want && !want.has(el.systemKind)) continue;
    out.push(el);
  }
  return out.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
}

/** `tree` with the terminal standing for `elementId` given `children` (the first one found, depth first); null when there is none. */
function graft(tree: DiagramNode, elementId: string, children: readonly DiagramNode[]): DiagramNode | null {
  if (tree.role === "terminal" && tree.elementId === elementId && tree.children.length === 0) return { ...tree, children };
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i] as DiagramNode;
    const next = graft(c, elementId, children);
    if (next) return { ...tree, children: [...tree.children.slice(0, i), next, ...tree.children.slice(i + 1)] };
  }
  return null;
}

export function plumbingDiagramGraph(elements: Elements, hints: DiagramHints = {}): DiagramGraph {
  const reads = new Set<ElementId>();
  const hidden = new Set(hints.hidden ?? []);
  const pipes: DiagramPipe[] = [];
  let roots: DiagramNode[] = [];
  for (const system of plumbingSystems(elements, hints.systemKinds)) {
    reads.add(system.id);
    if (hidden.has(system.id)) continue;
    for (const tree of plumbingTrees(elements, system, hidden)) {
      for (const id of tree.reads) reads.add(id);
      pipes.push(...tree.pipes);
      roots.push(tree.root);
    }
  }
  // A system whose source is a fixture of another drawn system continues from it (one pass, so two systems never feed each other).
  for (const r of [...roots]) {
    if (r.role !== "source" || r.elementId === null || elements[r.elementId]?.kind !== "part") continue;
    for (let i = 0; i < roots.length; i++) {
      const host = roots[i] as DiagramNode;
      if (host === r || host.service === r.service) continue;
      const grafted = graft(host, r.elementId, r.children);
      if (!grafted) continue;
      roots = roots.flatMap((x, j) => (j === i ? [grafted] : x === r ? [] : [x]));
      break;
    }
  }
  return { roots, warnings: [], reads: [...reads].sort(), pipes };
}
