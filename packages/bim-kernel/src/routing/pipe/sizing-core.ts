import type { BimElement } from "../../types";
import { runNeighbours, type RunGraphNode } from "../derive";
import type { RunSegment } from "../types";

/**
 * The pipe walk both the hydraulics reports and the gas zones build on: one
 * system's nodes, its tree from a root, and where a neighbour meets a
 * segment. A leaf of both.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface PipeWalk {
  readonly nodes: readonly RunGraphNode[];
  readonly root: RunGraphNode;
  readonly parent: ReadonlyMap<RunGraphNode, RunGraphNode | null>;
  readonly children: ReadonlyMap<RunGraphNode, readonly RunGraphNode[]>;
  readonly order: readonly RunGraphNode[];
}

export const pipeNodeId = (n: RunGraphNode): string => (n.includes("#") ? n.slice(0, n.indexOf("#")) : n);

export function pipeComponent(elements: Elements, start: RunGraphNode): RunGraphNode[] {
  const seen = new Set<RunGraphNode>([start]);
  const stack = [start];
  const out: RunGraphNode[] = [];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    out.push(n);
    for (const m of runNeighbours(elements, n)) {
      if (seen.has(m) || (!m.includes("#") && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return out.sort();
}

export function pipeWalkTree(elements: Elements, nodes: readonly RunGraphNode[], root: RunGraphNode): PipeWalk {
  const parent = new Map<RunGraphNode, RunGraphNode | null>([[root, null]]);
  const children = new Map<RunGraphNode, RunGraphNode[]>();
  const order: RunGraphNode[] = [];
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    order.push(n);
    const kids: RunGraphNode[] = [];
    for (const m of runNeighbours(elements, n).sort()) {
      if (parent.has(m) || (!m.includes("#") && !elements[m])) continue;
      parent.set(m, n);
      kids.push(m);
      queue.push(m);
    }
    children.set(n, kids);
  }
  return { nodes, root, parent, children, order };
}

/** Where along a segment a neighbour meets it (mm from its start). */
export function pipePositionOn(elements: Elements, seg: RunSegment, n: RunGraphNode | null, total: number): number {
  if (n === null) return 0;
  const id = pipeNodeId(n);
  if (seg.links.start?.elementId === id) return 0;
  if (seg.links.end?.elementId === id) return total;
  const hosted = elements[id];
  if (hosted?.kind === "run_fitting" && hosted.host?.segmentId === seg.id) return hosted.host.s;
  return 0;
}
