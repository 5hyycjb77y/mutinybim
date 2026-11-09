/**
 * The gravity regime (KERNEL-FOUNDATION §3.5): a network that flows downhill
 * to a boundary, with fixed-elevation nodes and pumped segments. One walk for
 * every network that drains by gravity; the adapter that builds the network
 * supplies the slope rules, so nothing here knows a trade, a code or a pipe.
 *
 * - A node may be **fixed**: its invert (the low point of the flow) is known
 *   (a structure's measured invert, an outfall, a connection to a main). A
 *   fixed node may also carry its `topMm` (the surface above it), so the
 *   depth to the invert is reported.
 * - Every other node's invert is **derived**: the lowest invert that still
 *   falls at the minimum slope to the fixed node below it.
 * - Each edge flows `from` → `to` (downhill). A **pumped** edge lifts: it is
 *   not slope-checked, and the node it leaves from starts a new grade (its
 *   invert comes from what drains into it, or is fixed).
 *
 * The walk starts from the nodes an edit touched and visits only what their
 * inverts and slopes depend on, so one edit on a tower re-walks one run.
 */

export interface GravityNode {
  readonly id: string;
  /** A known invert. Absent: derived from the node below. */
  readonly invertMm?: number;
  /** The surface above the node (a cover, a grade). Reported as depth when the invert is known or derived. */
  readonly topMm?: number;
}

export interface GravityEdge {
  readonly id: string;
  /** Upstream node. */
  readonly from: string;
  /** Downstream node. */
  readonly to: string;
  /** Horizontal run. */
  readonly lengthMm: number;
  /** Lifted by a pump: no slope check, and `from` starts a new grade. */
  readonly pumped?: boolean;
}

export interface GravityNetwork {
  readonly nodes: readonly GravityNode[];
  readonly edges: readonly GravityEdge[];
}

/** What the adapter decides: the regime asks, the adapter answers from its code and sizes. */
export interface GravitySlopeRules {
  /** The least fall per unit run this edge may have (0.01 = 1 %). */
  minSlope(edge: GravityEdge): number;
  /** The most fall per unit run, or null for no limit. */
  maxSlope?(edge: GravityEdge): number | null;
  /** Fall taken across a node between the edge arriving and the edge leaving (a drop in a structure). Absent: 0. */
  dropAcrossMm?(node: GravityNode): number;
}

export type GravityEdgeStatus =
  /** Falls at least the minimum (and no more than the maximum). */
  | "ok"
  /** Falls less than the minimum: the fixed invert upstream is too low for the one below. */
  | "too_flat"
  | "too_steep"
  /** Lifted by a pump: reported, not slope-checked. */
  | "pumped"
  /** No fixed node below it: there is nothing to fall to. */
  | "no_boundary";

export interface GravityEdgeResult {
  readonly edgeId: string;
  readonly status: GravityEdgeStatus;
  readonly upstreamInvertMm: number | null;
  readonly downstreamInvertMm: number | null;
  /** Fall available between the two inverts (negative: it rises). */
  readonly fallMm: number | null;
  readonly slope: number | null;
  readonly minSlope: number | null;
  /** How much more fall the minimum needs (too flat only). */
  readonly shortfallMm: number | null;
  /** Plain-words finding for a status other than ok. */
  readonly message: string | null;
}

export interface GravityNodeResult {
  readonly nodeId: string;
  readonly invertMm: number | null;
  readonly fixed: boolean;
  readonly depthMm: number | null;
}

export interface GravityWalk {
  readonly edges: readonly GravityEdgeResult[];
  readonly nodes: readonly GravityNodeResult[];
  /** Problems with the network itself (a split, a loop, a missing node): the walk reports them rather than guessing. */
  readonly problems: readonly string[];
  /** Nodes whose invert the walk resolved: what the edit cost. */
  readonly visitedNodes: number;
}

/** Below this, a shortfall is rounding (micrometres). */
const EPS_MM = 1e-6;

interface Indexed {
  readonly node: ReadonlyMap<string, GravityNode>;
  readonly down: ReadonlyMap<string, GravityEdge>;
  readonly up: ReadonlyMap<string, readonly GravityEdge[]>;
  readonly problems: readonly string[];
}

const indexes = new WeakMap<GravityNetwork, Indexed>();

/** The network's adjacency, once per network value. */
function indexOf(net: GravityNetwork): Indexed {
  const cached = indexes.get(net);
  if (cached) return cached;
  const node = new Map<string, GravityNode>();
  const down = new Map<string, GravityEdge>();
  const up = new Map<string, GravityEdge[]>();
  const problems: string[] = [];
  for (const n of net.nodes) node.set(n.id, n);
  for (const e of net.edges) {
    if (!node.has(e.from) || !node.has(e.to)) {
      problems.push(`Segment ${e.id} runs between ${e.from} and ${e.to}, but ${node.has(e.from) ? e.to : e.from} isn't in the network`);
      continue;
    }
    const other = down.get(e.from);
    if (other) {
      problems.push(`${e.from} drains two ways (${other.id} and ${e.id}); a gravity network needs one way down from each node`);
      continue;
    }
    down.set(e.from, e);
    const list = up.get(e.to);
    if (list) list.push(e);
    else up.set(e.to, [e]);
  }
  const built: Indexed = { node, down, up, problems };
  indexes.set(net, built);
  return built;
}

/**
 * Walk the network's grade. With `touched`, only what those nodes' results
 * depend on and affect is resolved and reported: the run below each touched
 * node to its boundary, and everything that drains into it up to the next
 * fixed or pumped node. Without it, every node.
 */
export function walkGravity(net: GravityNetwork, rules: GravitySlopeRules, touched?: Iterable<string>): GravityWalk {
  const ix = indexOf(net);
  const problems = [...ix.problems];
  const invert = new Map<string, number | null>();
  const resolving = new Set<string>();

  const above = new Map<string, number | null>();

  /**
   * The invert a pump's inlet takes when it isn't fixed: the lowest that what
   * drains into it can reach at the minimum slope (the wet well sits below
   * its lowest inflow). Null when nothing fixed drains into it.
   */
  const fromAbove = (start: string): number | null => {
    const known = above.get(start);
    if (known !== undefined) return known;
    // Post-order over what drains in, iteratively.
    const stack: { id: string; expanded: boolean }[] = [{ id: start, expanded: false }];
    const onPath = new Set<string>();
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const n = ix.node.get(top.id);
      if (above.has(top.id)) {
        stack.pop();
        continue;
      }
      if (n?.invertMm !== undefined) {
        above.set(top.id, n.invertMm);
        stack.pop();
        continue;
      }
      const incoming = (ix.up.get(top.id) ?? []).filter((e) => !e.pumped);
      if (!top.expanded) {
        top.expanded = true;
        onPath.add(top.id);
        for (const e of incoming) {
          if (onPath.has(e.from)) {
            problems.push(`The network loops back on itself at ${e.from}; a gravity network can't drain in a circle`);
            continue;
          }
          if (!above.has(e.from)) stack.push({ id: e.from, expanded: false });
        }
        continue;
      }
      stack.pop();
      onPath.delete(top.id);
      let best: number | null = null;
      for (const e of incoming) {
        const a = above.get(e.from) ?? null;
        if (a === null || !n) continue;
        const v = a - (rules.dropAcrossMm?.(n) ?? 0) - rules.minSlope(e) * e.lengthMm;
        if (best === null || v < best) best = v;
      }
      above.set(top.id, best);
    }
    return above.get(start) ?? null;
  };

  /** A node's invert: fixed, or the lowest that falls at the minimum slope to the node below. Iterative so a long run can't overflow the stack. */
  const invertOf = (start: string): number | null => {
    const known = invert.get(start);
    if (known !== undefined) return known;
    const chain: { id: string; edge: GravityEdge }[] = [];
    let at = start;
    let base: number | null = null;
    for (;;) {
      const seen = invert.get(at);
      if (seen !== undefined) {
        base = seen;
        break;
      }
      const n = ix.node.get(at);
      if (n?.invertMm !== undefined) {
        base = n.invertMm;
        invert.set(at, base);
        break;
      }
      const e = ix.down.get(at);
      if (n && e?.pumped) {
        // A pump's inlet starts a new grade from what drains into it.
        base = fromAbove(at);
        invert.set(at, base);
        break;
      }
      if (!n || !e) {
        // An open end: nothing fixed to fall to.
        base = null;
        invert.set(at, null);
        break;
      }
      if (resolving.has(at)) {
        problems.push(`The network loops back on itself at ${at}; a gravity network can't drain in a circle`);
        base = null;
        invert.set(at, null);
        break;
      }
      resolving.add(at);
      chain.push({ id: at, edge: e });
      at = e.to;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const link = chain[i];
      if (!link) continue;
      resolving.delete(link.id);
      const below = ix.node.get(link.edge.to);
      if (base === null || !below) {
        invert.set(link.id, null);
        base = null;
        continue;
      }
      base = base + (rules.dropAcrossMm?.(below) ?? 0) + rules.minSlope(link.edge) * link.edge.lengthMm;
      invert.set(link.id, base);
    }
    return invert.get(start) ?? null;
  };

  // What to report: each touched node's run down to its boundary, and what drains into it up to fixed or pumped nodes.
  const reportEdges = new Set<GravityEdge>();
  const reportNodes = new Set<string>();
  const upSeeds: string[] = [];
  const seeds = touched ? [...touched] : [...ix.node.keys()];
  for (const id of seeds) {
    if (!ix.node.has(id)) {
      problems.push(`${id} was edited but isn't in the network`);
      continue;
    }
    upSeeds.push(id);
    let at: string | undefined = id;
    const guard = new Set<string>();
    while (at !== undefined && !guard.has(at)) {
      guard.add(at);
      reportNodes.add(at);
      const e = ix.down.get(at);
      if (!e) break;
      reportEdges.add(e);
      reportNodes.add(e.to);
      // An unfixed pump inlet takes its invert from everything draining into it: those branches move too.
      if (e.pumped) {
        if (ix.node.get(at)?.invertMm === undefined && at !== id) upSeeds.push(at);
        break;
      }
      if (ix.node.get(e.to)?.invertMm !== undefined) break;
      at = e.to;
    }
  }
  const seenUp = new Set<string>();
  const stack = [...upSeeds];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined || seenUp.has(n)) continue;
    seenUp.add(n);
    reportNodes.add(n);
    for (const e of ix.up.get(n) ?? []) {
      reportEdges.add(e);
      reportNodes.add(e.from);
      // A fixed node above keeps its own grade; one pumped into this node starts its own.
      if (ix.node.get(e.from)?.invertMm === undefined && !e.pumped) stack.push(e.from);
    }
  }

  const edges: GravityEdgeResult[] = [];
  for (const e of net.edges) {
    if (!reportEdges.has(e)) continue;
    const fromNode = ix.node.get(e.from);
    const toNode = ix.node.get(e.to);
    if (!fromNode || !toNode) continue;
    const down = invertOf(e.to);
    const upInv = invertOf(e.from);
    const minSlope = e.pumped ? null : rules.minSlope(e);
    const drop = rules.dropAcrossMm?.(toNode) ?? 0;
    const fall = upInv !== null && down !== null ? upInv - down - drop : null;
    const slope = fall !== null && e.lengthMm > 0 ? fall / e.lengthMm : null;
    if (e.pumped) {
      const message = upInv === null ? `Pumped segment ${e.id} has no invert at its inlet ${e.from}; fix the inlet's invert or one that drains into it` : null;
      edges.push({ edgeId: e.id, status: "pumped", upstreamInvertMm: upInv, downstreamInvertMm: down, fallMm: fall, slope, minSlope: null, shortfallMm: null, message });
      continue;
    }
    if (down === null || upInv === null) {
      edges.push({ edgeId: e.id, status: "no_boundary", upstreamInvertMm: upInv, downstreamInvertMm: down, fallMm: null, slope: null, minSlope, shortfallMm: null, message: `Segment ${e.id} has no fixed elevation below it to fall to; fix the invert at its outlet` });
      continue;
    }
    const need = (minSlope ?? 0) * e.lengthMm;
    const max = rules.maxSlope?.(e) ?? null;
    if (fall !== null && fall + EPS_MM < need) {
      const short = need - fall;
      edges.push({
        edgeId: e.id,
        status: "too_flat",
        upstreamInvertMm: upInv,
        downstreamInvertMm: down,
        fallMm: fall,
        slope,
        minSlope,
        shortfallMm: short,
        message: `Segment ${e.id} falls ${Math.round(fall)} mm over ${Math.round(e.lengthMm)} mm; it needs ${Math.round(need)} mm (${Math.round(short)} mm more). Lower ${e.to} or raise ${e.from}`,
      });
      continue;
    }
    if (max !== null && slope !== null && slope > max + 1e-12) {
      edges.push({ edgeId: e.id, status: "too_steep", upstreamInvertMm: upInv, downstreamInvertMm: down, fallMm: fall, slope, minSlope, shortfallMm: null, message: `Segment ${e.id} falls more steeply than its rules allow; add a drop at ${e.to}` });
      continue;
    }
    edges.push({ edgeId: e.id, status: "ok", upstreamInvertMm: upInv, downstreamInvertMm: down, fallMm: fall, slope, minSlope, shortfallMm: null, message: null });
  }

  const nodes: GravityNodeResult[] = [];
  for (const n of net.nodes) {
    if (!reportNodes.has(n.id)) continue;
    const inv = invertOf(n.id);
    nodes.push({ nodeId: n.id, invertMm: inv, fixed: n.invertMm !== undefined, depthMm: inv !== null && n.topMm !== undefined ? n.topMm - inv : null });
  }
  return { edges, nodes, problems: [...new Set(problems)], visitedNodes: invert.size + above.size };
}
