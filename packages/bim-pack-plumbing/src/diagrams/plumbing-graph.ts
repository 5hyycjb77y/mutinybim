import { systemRules, elementsOfKind, drainSystemKinds } from "@permitzip/bim-kernel";
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
 * Vent systems stay cleanly rooted at their roof terminal (VTR) so `layoutDwvRiser`
 * merges sanitary drains (down) and vents (up) onto each shared physical fixture once.
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

/** Invert a tree around a target leaf node (so a vent tree rooted at VTR-1 becomes a tree rooted at a fixture climbing up to VTR-1 and the other vented branches). */
function rerootAt(root: DiagramNode, targetElementId: string): DiagramNode | null {
  const path: DiagramNode[] = [];
  const find = (n: DiagramNode): boolean => {
    path.push(n);
    if (n.role === "terminal" && n.elementId === targetElementId) return true;
    for (const c of n.children) if (find(c)) return true;
    path.pop();
    return false;
  };
  if (!find(root) || path.length < 2) return null;
  // Walk upward from the fixture leaf back to the original root (VTR / roof terminal).
  let prevChild: DiagramNode | null = null;
  for (let i = 0; i < path.length - 1; i++) {
    const parent = path[i]!;
    const nextInPath = path[i + 1]!;
    const siblings = parent.children.filter((c) => c !== nextInPath);
    const rebuilt: DiagramNode = {
      ...parent,
      role: i === 0 ? "terminal" : parent.role === "source" ? "branch" : parent.role,
      feed: nextInPath.feed,
      children: prevChild ? [...siblings, prevChild] : siblings,
    };
    prevChild = rebuilt;
  }
  return prevChild;
}

/** Collect every terminal fixture elementId in a diagram tree. */
function collectTerminalIds(node: DiagramNode, out: Set<string>): void {
  if (node.role === "terminal" && node.elementId) out.add(node.elementId);
  for (const c of node.children) collectTerminalIds(c, out);
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
  // A vent tree connected to one or more fixtures already on a drawn sanitary tree integrates right onto that sanitary riser.
  const drains = drainSystemKinds();
  for (const r of [...roots]) {
    if (r.service !== "vent") continue;
    const ventTerminals = new Set<string>();
    collectTerminalIds(r, ventTerminals);
    if (ventTerminals.size === 0) continue;
    for (let i = 0; i < roots.length; i++) {
      const host = roots[i] as DiagramNode;
      if (host === r || !host.service || !drains.has(host.service) || host.service === "storm" || host.service === "condensate") continue;
      const hostTerminals = new Set<string>();
      collectTerminalIds(host, hostTerminals);
      const shared = [...ventTerminals].find((id) => hostTerminals.has(id));
      if (!shared) continue;
      const rerooted = rerootAt(r, shared);
      if (!rerooted) continue;
      const grafted = graft(host, shared, [rerooted]);
      if (!grafted) continue;
      roots = roots.flatMap((x, j) => (j === i ? [grafted] : x === r ? [] : [x]));
      break;
    }
  }
  return { roots, warnings: [], reads: [...reads].sort(), pipes };
}
