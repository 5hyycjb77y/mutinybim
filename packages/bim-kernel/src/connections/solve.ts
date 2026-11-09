import { activeServiceRegistry, serviceById, serviceLabel, type ServiceRegistry } from "../services/registry";
import type { ModelState } from "../types";
import { networkForService, tradeAdapter } from "./model";

/**
 * The looped-network solve hook (FOUNDATION-COVERAGE §2.7 item 5). Trees
 * (one way back to the source) aggregate through `aggregate.ts`; a network
 * with loops (a gridded main, a ring, a mesh) has no "below", so its flows
 * come from iterating until every loop balances. The adapter that owns the
 * service describes the problem (nodes, edges, demands, and how much
 * potential an edge loses for a flow); the kernel runs one driver for every
 * trade, and says so loudly when it does not settle.
 */

export interface SolveOptions {
  /** Most passes before giving up. */
  readonly maxIterations: number;
  /** Converged when the largest correction in a pass is at most this (in the adapter's flow unit). */
  readonly tolerance: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = { maxIterations: 200, tolerance: 1e-6 };

export type NetworkSolveStatus = "converged" | "not_converged" | "diverged";

export interface IterationOutcome<S> {
  readonly status: NetworkSolveStatus;
  readonly state: S;
  readonly iterations: number;
  /** The last pass's residual (the largest correction). */
  readonly residual: number;
}

/**
 * Run `step` until its residual is within tolerance, at most `maxIterations`
 * times. A residual that is not a finite number is divergence, reported, never
 * iterated on.
 */
export function iterateToConvergence<S>(initial: S, step: (state: S, iteration: number) => { readonly next: S; readonly residual: number }, options: SolveOptions): IterationOutcome<S> {
  let state = initial;
  let residual = Number.POSITIVE_INFINITY;
  for (let i = 1; i <= options.maxIterations; i++) {
    const r = step(state, i);
    residual = r.residual;
    if (!Number.isFinite(residual)) return { status: "diverged", state, iterations: i, residual };
    state = r.next;
    if (residual <= options.tolerance) return { status: "converged", state, iterations: i, residual };
  }
  return { status: "not_converged", state, iterations: options.maxIterations, residual };
}

export interface LoopNode {
  readonly id: string;
  /** Drawn off at the node (+), or supplied into it (−), in the flow unit. Absent: 0. */
  readonly demand?: number;
}

export interface LoopEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** A starting guess for this edge's flow, when it closes a loop. Absent: 0. */
  readonly initialFlow?: number;
}

/** How much potential an edge loses (`from` → `to`) at a signed flow, and how fast that changes with flow (never negative). */
export interface EdgeDrop {
  readonly drop: number;
  readonly slope: number;
}

/**
 * What an adapter's `solve` returns: the network to balance. `method` is an
 * open string; this release runs `loop_balance` (successive loop corrections,
 * Hardy Cross) and refuses any other by name.
 */
export interface NetworkSolveProblem {
  readonly method?: "loop_balance" | (string & {});
  readonly nodes: readonly LoopNode[];
  readonly edges: readonly LoopEdge[];
  drop(edge: LoopEdge, flow: number): EdgeDrop;
  /** A node with a known potential (a source), so node potentials can be reported. Absent: flows only. */
  readonly reference?: { readonly nodeId: string; readonly potential: number };
  readonly options?: Partial<SolveOptions>;
}

/** What `TradeAdapter.solve` is called with (connections/adapter.ts). */
export type NetworkSolveContext = {
  readonly serviceId: string;
};

export type NetworkSolveResult =
  | {
      readonly status: NetworkSolveStatus;
      readonly iterations: number;
      readonly residual: number;
      readonly loops: number;
      /** Signed flow per edge (+ from → to). */
      readonly flows: Readonly<Record<string, number>>;
      /** Potential per node from the reference, or null without one. */
      readonly potentials: Readonly<Record<string, number>> | null;
      /** Plain words for anything but converged. */
      readonly message: string | null;
    }
  | { readonly status: "invalid" | "no_solver" | "unknown_service"; readonly message: string };

interface Tree {
  readonly parentEdge: ReadonlyMap<string, LoopEdge>;
  readonly parent: ReadonlyMap<string, string>;
  readonly depth: ReadonlyMap<string, number>;
  /** Parents before children. */
  readonly order: readonly string[];
  readonly chords: readonly LoopEdge[];
}

function spanningTree(problem: NetworkSolveProblem, root: string): Tree | string {
  const adj = new Map<string, LoopEdge[]>();
  for (const n of problem.nodes) adj.set(n.id, []);
  for (const e of problem.edges) {
    const a = adj.get(e.from);
    const b = adj.get(e.to);
    if (!a || !b) return `edge ${e.id} joins ${e.from} and ${e.to}, but ${a ? e.to : e.from} isn't a node of the network`;
    if (e.from === e.to) return `edge ${e.id} starts and ends at ${e.from}`;
    a.push(e);
    b.push(e);
  }
  const parentEdge = new Map<string, LoopEdge>();
  const parent = new Map<string, string>();
  const depth = new Map<string, number>([[root, 0]]);
  const order: string[] = [root];
  const inTree = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    if (n === undefined) continue;
    for (const e of adj.get(n) ?? []) {
      const other = e.from === n ? e.to : e.from;
      if (depth.has(other)) continue;
      depth.set(other, (depth.get(n) ?? 0) + 1);
      parent.set(other, n);
      parentEdge.set(other, e);
      inTree.add(e.id);
      order.push(other);
    }
  }
  if (order.length !== problem.nodes.length) {
    const cut = problem.nodes.find((n) => !depth.has(n.id));
    return `${cut?.id ?? "a node"} isn't connected to ${root}; a network solve needs one connected network`;
  }
  return { parentEdge, parent, depth, order, chords: problem.edges.filter((e) => !inTree.has(e.id)) };
}

type Loop = readonly { readonly edge: LoopEdge; readonly sign: 1 | -1 }[];

/** The loop a chord closes: the chord from → to, then the tree back from `to` to `from`. Sign +1 where the loop runs an edge from → to. */
function loopOf(chord: LoopEdge, tree: Tree): Loop {
  const out: { edge: LoopEdge; sign: 1 | -1 }[] = [{ edge: chord, sign: 1 }];
  let a = chord.to;
  let b = chord.from;
  const tail: { edge: LoopEdge; sign: 1 | -1 }[] = [];
  // Walk both ends up to their common ancestor: a's side is traversed upward, b's downward.
  while (a !== b) {
    const da = tree.depth.get(a) ?? 0;
    const db = tree.depth.get(b) ?? 0;
    if (da >= db) {
      const e = tree.parentEdge.get(a);
      const p = tree.parent.get(a);
      if (!e || p === undefined) break;
      out.push({ edge: e, sign: e.from === a ? 1 : -1 });
      a = p;
    } else {
      const e = tree.parentEdge.get(b);
      const p = tree.parent.get(b);
      if (!e || p === undefined) break;
      tail.push({ edge: e, sign: e.to === b ? 1 : -1 });
      b = p;
    }
  }
  return [...out, ...tail.reverse()];
}

function resolvedOptions(problem: NetworkSolveProblem, given: Partial<SolveOptions> | undefined): SolveOptions | string {
  const o = { ...DEFAULT_SOLVE_OPTIONS, ...problem.options, ...given };
  if (!Number.isInteger(o.maxIterations) || o.maxIterations < 1) return `the iteration limit must be a whole number of at least 1, not ${o.maxIterations}`;
  if (!Number.isFinite(o.tolerance) || o.tolerance <= 0) return `the tolerance must be a positive number, not ${o.tolerance}`;
  return o;
}

/**
 * Balance a looped network. Flows start from a spanning tree that meets every
 * demand (closing edges at their guess), then each pass corrects every loop
 * by −Σ drop / Σ slope until the largest correction is within tolerance.
 */
export function solveLoopNetwork(problem: NetworkSolveProblem, options?: Partial<SolveOptions>, label = "The"): NetworkSolveResult {
  const method = problem.method ?? "loop_balance";
  if (method !== "loop_balance") return { status: "invalid", message: `${label} network asks for the "${method}" solve, which this version can't run; it runs loop_balance` };
  const opts = resolvedOptions(problem, options);
  if (typeof opts === "string") return { status: "invalid", message: `${label} network's solve settings are wrong: ${opts}` };
  if (problem.nodes.length === 0) return { status: "invalid", message: `${label} network has no nodes to solve` };
  const demand = new Map<string, number>();
  let net = 0;
  let scale = 0;
  for (const n of problem.nodes) {
    const d = n.demand ?? 0;
    if (!Number.isFinite(d)) return { status: "invalid", message: `${n.id}'s demand isn't a number` };
    if (demand.has(n.id)) return { status: "invalid", message: `two nodes are both ${n.id}` };
    demand.set(n.id, d);
    net += d;
    scale = Math.max(scale, Math.abs(d));
  }
  if (Math.abs(net) > Math.max(opts.tolerance, scale * 1e-9)) return { status: "invalid", message: `${label} network draws ${net > 0 ? "more" : "less"} than it is supplied (out of balance by ${net}); every demand needs a source` };
  const root = problem.reference?.nodeId ?? problem.nodes.find((n) => (n.demand ?? 0) < 0)?.id ?? problem.nodes[0]?.id ?? "";
  const tree = spanningTree(problem, root);
  if (typeof tree === "string") return { status: "invalid", message: `${label} network can't be solved: ${tree}` };

  const flows = new Map<string, number>();
  const residualAt = new Map<string, number>(demand);
  for (const c of tree.chords) {
    const q = c.initialFlow ?? 0;
    flows.set(c.id, q);
    residualAt.set(c.from, (residualAt.get(c.from) ?? 0) + q);
    residualAt.set(c.to, (residualAt.get(c.to) ?? 0) - q);
  }
  // Each tree edge carries what its subtree still needs, children first.
  const subtotal = new Map<string, number>();
  for (let i = tree.order.length - 1; i >= 0; i--) {
    const n = tree.order[i];
    if (n === undefined) continue;
    const need = (residualAt.get(n) ?? 0) + (subtotal.get(n) ?? 0);
    const e = tree.parentEdge.get(n);
    const p = tree.parent.get(n);
    if (!e || p === undefined) continue;
    flows.set(e.id, e.to === n ? need : -need);
    subtotal.set(p, (subtotal.get(p) ?? 0) + need);
  }

  const loops = tree.chords.map((c) => loopOf(c, tree));
  const broke: { at: string | null } = { at: null };
  const outcome = iterateToConvergence(
    flows,
    (state) => {
      const next = new Map(state);
      let largest = 0;
      for (const loop of loops) {
        let sum = 0;
        let slope = 0;
        for (const { edge, sign } of loop) {
          const d = problem.drop(edge, next.get(edge.id) ?? 0);
          sum += sign * d.drop;
          slope += Math.abs(d.slope);
        }
        if (!(slope > 0)) {
          broke.at = loop[0]?.edge.id ?? null;
          return { next, residual: Number.NaN };
        }
        const dq = -sum / slope;
        for (const { edge, sign } of loop) next.set(edge.id, (next.get(edge.id) ?? 0) + sign * dq);
        largest = Math.max(largest, Math.abs(dq));
      }
      return { next, residual: largest };
    },
    opts,
  );

  const final = outcome.state;
  let potentials: Record<string, number> | null = null;
  if (problem.reference) {
    potentials = { [root]: problem.reference.potential };
    for (const n of tree.order) {
      const e = tree.parentEdge.get(n);
      const p = tree.parent.get(n);
      if (!e || p === undefined) continue;
      const pp = potentials[p] ?? 0;
      const d = problem.drop(e, final.get(e.id) ?? 0).drop;
      potentials[n] = e.to === n ? pp - d : pp + d;
    }
  }
  const message =
    outcome.status === "converged"
      ? null
      : outcome.status === "diverged"
        ? `${label} network's solve broke down${broke.at ? ` at the loop closed by ${broke.at}, which loses nothing for any flow` : ""}; check its edges' resistance`
        : `${label} network didn't settle within ${outcome.iterations} passes (the largest loop correction is still ${outcome.residual.toPrecision(3)}, against ${opts.tolerance}); its flows are not a result`;
  return { status: outcome.status, iterations: outcome.iterations, residual: outcome.residual, loops: loops.length, flows: Object.fromEntries(final), potentials, message };
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null;
}

/** Whether an adapter's `solve` answer is a problem this hook can run. */
export function isNetworkSolveProblem(value: unknown): value is NetworkSolveProblem {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) && typeof value.drop === "function";
}

/**
 * Solve a service's looped network in `model`: ask the adapter that walks the
 * service for its problem, then balance it. A service with no adapter, or an
 * adapter with no `solve`, says so; trees keep going through `aggregate.ts`.
 */
export function solveNetwork(model: ModelState, serviceId: string, opts: { readonly registry?: ServiceRegistry; readonly options?: Partial<SolveOptions> } = {}): NetworkSolveResult {
  const registry = opts.registry ?? activeServiceRegistry();
  const row = serviceById(serviceId, registry);
  if (!row) return { status: "unknown_service", message: `"${serviceId}" isn't a service this model knows` };
  const label = serviceLabel(serviceId, registry);
  const links = row.adapter ? tradeAdapter(row.adapter) : null;
  // The link rules' solve first (the built-in path), else a pack network's own.
  const solver = links?.solve ? links : row.adapter ? (networkForService(serviceId)?.aggregation ?? null) : null;
  if (!solver?.solve) return { status: "no_solver", message: `${label} has no looped-network solve; it is totalled as a tree` };
  const ctx: NetworkSolveContext = { serviceId };
  const problem = solver.solve(model, ctx);
  if (problem === null || problem === undefined) return { status: "no_solver", message: `${label}'s adapter found no network to solve in this model` };
  if (!isNetworkSolveProblem(problem)) {
    console.error("[connections/solve] adapter returned an unreadable problem", { serviceId, adapter: row.adapter });
    return { status: "invalid", message: `${label}'s adapter answered with something the solve can't read (it needs nodes, edges and a drop rule)` };
  }
  return solveLoopNetwork(problem, opts.options, label);
}
