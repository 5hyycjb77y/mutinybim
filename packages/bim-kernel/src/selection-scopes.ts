import { networkOf } from "./network";
import { isSource, partNode, runNeighbours, type RunGraphNode } from "./routing/derive";
import { len3, sub3 } from "./routing/geometry";
import { sameSize } from "./routing/rules";
import { RUN_DOMAINS, type RunDomain } from "./routing/types";
import type { BimElement, ElementId, ModelState } from "./types";
import { headlineKindValue } from "./kinds";
import type { ViewCategory } from "./documents";
import { elementKindTable, type ConnectorEndsFace } from "./registry/element-kind-point";

/**
 * "Tab to select more": the widening scopes around one element of a connected
 * network, for duct and pipe runs (routed runs and the parts linked to them)
 * and the older equipment-rooted trees.
 *
 * - element: the element itself.
 * - stretch: the straight pieces of the same size joined end to end with it
 *   (the pieces a split leaves), up to the nearest fitting, part, size change
 *   or open end. Routed runs only.
 * - run: straight pieces and the in-line fittings between them (elbows,
 *   transitions, offsets, caps), up to the nearest takeoff, part or open end.
 * - branch: the nearest takeoff upstream (tap, tee, wye) and everything beyond
 *   it to the terminals. Upstream is away from the system's source (a unit or
 *   panel), else from the run's first element, as flow is derived.
 * - system: every element connected to it.
 *
 * Consecutive scopes that hold the same elements are collapsed, so Tab never
 * appears to do nothing. Reads only the network the element belongs to.
 */

export const SELECTION_SCOPE_KINDS = ["element", "stretch", "run", "branch", "system"] as const;
export type SelectionScopeKind = (typeof SELECTION_SCOPE_KINDS)[number];

export interface SelectionScope {
  readonly kind: SelectionScopeKind;
  /** The anchor first, then traversal order. */
  readonly ids: readonly ElementId[];
}

type Model = Pick<ModelState, "elements" | "connections">;
type Elements = Readonly<Record<string, BimElement>>;

interface Graph {
  readonly starts: readonly RunGraphNode[];
  neighbours(n: RunGraphNode): readonly RunGraphNode[];
  /** Straight pieces and in-line fittings: what a run continues through. */
  inline(n: RunGraphNode): boolean;
  /** Tap, tee or wye: where a branch begins. */
  takeoff(n: RunGraphNode): boolean;
  /** Where flow starts in this connected set. */
  root(nodes: readonly RunGraphNode[]): RunGraphNode | undefined;
  /** Whether `a` and `b` are straight pieces of one stretch: joined end to end, same size. Absent: no stretches. */
  sameStretch?(a: RunGraphNode, b: RunGraphNode): boolean;
}

const INLINE_FITTINGS = new Set(["elbow", "transition", "offset", "cap"]);
const TAKEOFF_FITTINGS = new Set(["tap", "tee", "wye"]);

const idOfNode = (n: RunGraphNode): ElementId => {
  const hash = n.indexOf("#");
  return (hash >= 0 ? n.slice(0, hash) : n) as ElementId;
};

function routedGraph(elements: Elements, el: BimElement): Graph | null {
  let starts: RunGraphNode[];
  if (el.kind === "run_segment" || el.kind === "run_fitting") starts = [el.id];
  else if (el.kind === "part") starts = Object.keys(el.links ?? {}).sort().map((c) => partNode(el.id, c));
  else return null;
  if (starts.length === 0) return null;
  return {
    starts,
    neighbours: (n) => runNeighbours(elements, n).filter((m) => m.includes("#") || elements[m] !== undefined),
    inline: (n) => {
      const x = elements[n];
      return x?.kind === "run_segment" || (x?.kind === "run_fitting" && INLINE_FITTINGS.has(x.fittingType));
    },
    takeoff: (n) => {
      const x = elements[n];
      return x?.kind === "run_fitting" && TAKEOFF_FITTINGS.has(x.fittingType);
    },
    root: (nodes) => {
      const sorted = [...nodes].sort();
      const source = sorted.find((n) => {
        if (!n.includes("#")) return false;
        const part = elements[idOfNode(n)];
        return part?.kind === "part" && isSource(elements, part);
      });
      return source ?? sorted.find((n) => !n.includes("#")) ?? sorted[0];
    },
    sameStretch: (a, b) => {
      const x = elements[a];
      const y = elements[b];
      if (x?.kind !== "run_segment" || y?.kind !== "run_segment" || !sameSize(x.size, y.size)) return false;
      return [x.links.start, x.links.end].some((l) => l?.elementId === y.id);
    },
  };
}

/** An add-on kind's connector ends (its tree row), or undefined for a kernel kind or a kind no add-on in force registers. */
const treeEnds = (kind: string | undefined): ConnectorEndsFace | undefined => (kind === undefined ? undefined : elementKindTable().row(kind)?.connectorEnds);

/** Straight through: one end toward the source and one onward, not hanging on a host (a straight piece or an in-line fitting). */
const passesThrough = (ends: ConnectorEndsFace): boolean => ends.hostedBy === undefined && ends.root !== true && ends.ends.filter((d) => d.role === "upstream").length === 1 && ends.ends.some((d) => d.role === "downstream");

/** The trees an add-on's kinds form (`connectorEnds` rows, the network index): where a branch hangs on its host, and the source a tree starts at. */
function addOnTreeGraph(model: Model, el: BimElement): Graph | null {
  if (treeEnds(el.kind) === undefined) return null;
  const index = networkOf(model);
  const elements = model.elements;
  return {
    starts: [el.id],
    neighbours: (n) => {
      const up = index.parent(n);
      const out = up !== undefined && elements[up] ? [up] : [];
      for (const c of index.children(n)) if (elements[c]) out.push(c);
      return out;
    },
    inline: (n) => {
      const ends = treeEnds(elements[n]?.kind);
      return ends !== undefined && passesThrough(ends);
    },
    takeoff: (n) => treeEnds(elements[n]?.kind)?.hostedBy !== undefined,
    root: (nodes) => {
      const set = new Set(nodes);
      const top = nodes.filter((n) => {
        const up = index.parent(n);
        return up === undefined || !set.has(up);
      });
      return top.find((n) => treeEnds(elements[n]?.kind)?.root === true) ?? top.sort()[0] ?? nodes[0];
    },
  };
}

function component(g: Graph, starts: readonly RunGraphNode[]): RunGraphNode[] {
  const seen = new Set<RunGraphNode>(starts);
  const stack = [...starts];
  const out: RunGraphNode[] = [];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    out.push(n);
    for (const m of g.neighbours(n)) {
      if (seen.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return out;
}

/** Breadth-first tree from the root, neighbours in sorted order (the same tree flow derivation uses). */
function treeFrom(g: Graph, root: RunGraphNode): { parent: Map<RunGraphNode, RunGraphNode | null>; children: Map<RunGraphNode, RunGraphNode[]> } {
  const parent = new Map<RunGraphNode, RunGraphNode | null>([[root, null]]);
  const children = new Map<RunGraphNode, RunGraphNode[]>();
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    const kids: RunGraphNode[] = [];
    for (const m of [...g.neighbours(n)].sort()) {
      if (parent.has(m)) continue;
      parent.set(m, n);
      kids.push(m);
      queue.push(m);
    }
    children.set(n, kids);
  }
  return { parent, children };
}

function runFrom(g: Graph, start: RunGraphNode): RunGraphNode[] {
  if (!g.inline(start)) return [start];
  const seen = new Set<RunGraphNode>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    for (const m of g.neighbours(n)) {
      if (seen.has(m) || !g.inline(m)) continue;
      seen.add(m);
      queue.push(m);
    }
  }
  return queue;
}

function stretchFrom(g: Graph, start: RunGraphNode): RunGraphNode[] {
  const same = g.sameStretch;
  if (!same) return [start];
  const seen = new Set<RunGraphNode>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    for (const m of g.neighbours(n)) {
      if (seen.has(m) || !same(n, m)) continue;
      seen.add(m);
      queue.push(m);
    }
  }
  return queue;
}

function subtree(children: ReadonlyMap<RunGraphNode, readonly RunGraphNode[]>, top: RunGraphNode): RunGraphNode[] {
  const out = [top];
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n === undefined) break;
    out.push(...(children.get(n) ?? []));
  }
  return out;
}

function toIds(anchor: ElementId, nodes: Iterable<RunGraphNode>): ElementId[] {
  const seen = new Set<ElementId>([anchor]);
  const out: ElementId[] = [anchor];
  for (const n of nodes) {
    const id = idOfNode(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sameMembers(a: readonly ElementId[], b: readonly ElementId[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

interface ScopeSet {
  /** What Tab steps through: repeats collapsed. */
  readonly scopes: SelectionScope[];
  /** Every scope by its own name, before collapsing (an open run's "run" is also its "system"). */
  readonly byKind: ReadonlyMap<SelectionScopeKind, readonly ElementId[]>;
}

/** Uncached `selectionScopes` (what one hover costs the first time; the perf suite times this). */
export function computeSelectionScopes(model: Model, id: ElementId): SelectionScope[] {
  return computeScopeSet(model, id).scopes;
}

function computeScopeSet(model: Model, id: ElementId): ScopeSet {
  const el = model.elements[id];
  if (!el) return { scopes: [], byKind: new Map() };
  const element: SelectionScope = { kind: "element", ids: [id] };
  const byKind = new Map<SelectionScopeKind, readonly ElementId[]>([["element", element.ids]]);
  const g = routedGraph(model.elements, el) ?? addOnTreeGraph(model, el);
  if (!g) return { scopes: [element], byKind };

  const all = component(g, g.starts);
  const root = g.root(all);
  const run: RunGraphNode[] = [];
  const branch: RunGraphNode[] = [];
  if (root !== undefined) {
    const tree = treeFrom(g, root);
    for (const start of g.starts) {
      // A part's run is the run its connector meets.
      const runStarts = start.includes("#") ? g.neighbours(start) : [start];
      for (const s of runStarts) run.push(...runFrom(g, s));
      let x: RunGraphNode | null | undefined = start;
      let top: RunGraphNode | null = null;
      for (let guard = 0; x !== null && x !== undefined && guard <= all.length; guard++) {
        if (g.takeoff(x)) {
          top = x;
          break;
        }
        x = tree.parent.get(x);
      }
      branch.push(...(top === null ? all : subtree(tree.children, top)));
    }
  }

  const scopes: SelectionScope[] = [element];
  const push = (kind: SelectionScopeKind, nodes: readonly RunGraphNode[]): void => {
    const ids = toIds(id, nodes);
    byKind.set(kind, ids);
    const last = scopes[scopes.length - 1];
    if (last && sameMembers(last.ids, ids)) {
      // The same elements under the wider name: a trunk's "branch" is its whole system.
      if (last.kind !== "element") scopes[scopes.length - 1] = { kind, ids: last.ids };
      return;
    }
    scopes.push({ kind, ids });
  };
  push("stretch", g.starts.flatMap((s) => (s.includes("#") ? [] : stretchFrom(g, s))));
  push("run", run);
  push("branch", branch);
  push("system", all);
  return { scopes, byKind };
}

const cache = new WeakMap<object, Map<string, ScopeSet>>();

function scopeSet(model: Model, id: string): ScopeSet {
  let perModel = cache.get(model.elements);
  if (!perModel) {
    perModel = new Map();
    cache.set(model.elements, perModel);
  }
  const hit = perModel.get(id);
  if (hit) return hit;
  const set = computeScopeSet(model, id as ElementId);
  perModel.set(id, set);
  return set;
}

/** Element, stretch, run, branch and system around `id`, smallest first, without repeats. Cached per element record. */
export function selectionScopes(model: Model, id: string): readonly SelectionScope[] {
  return scopeSet(model, id).scopes;
}

/** The stretch, run, branch or system around `id` by that name, even where Tab collapses it into a neighbour. Just the element when it has none. */
export function scopeOf(model: Model, id: string, kind: SelectionScopeKind): readonly ElementId[] {
  const set = scopeSet(model, id);
  return set.byKind.get(kind) ?? set.byKind.get("element") ?? [];
}

export const stretchOf = (model: Model, id: string): readonly ElementId[] => scopeOf(model, id, "stretch");
export const connectedRunOf = (model: Model, id: string): readonly ElementId[] => scopeOf(model, id, "run");
export const branchOf = (model: Model, id: string): readonly ElementId[] => scopeOf(model, id, "branch");
export const networkSystemOf = (model: Model, id: string): readonly ElementId[] => scopeOf(model, id, "system");

// ------------------------------------------------------------------ summary

export interface ScopeSummary {
  readonly count: number;
  readonly segments: number;
  readonly fittings: number;
  readonly parts: number;
  readonly other: number;
  /** Straight run length, mm. */
  readonly lengthMm: number;
  /** Duct, pipe or both; null when no run is selected. */
  readonly domain: RunDomain | "mixed" | null;
  /** What enters the scope: the largest flow any of its runs carries (CFM for air, the system's own unit for water). Null when none flows. */
  readonly flowEntering: number | null;
  /** Systems the scope touches, by id (routed runs). */
  readonly systemIds: readonly ElementId[];
}

/** A segment's view category is its run domain when the two share a name. */
const domainOfCategory = (category: ViewCategory | undefined): RunDomain | undefined => (RUN_DOMAINS as readonly string[]).find((d): d is RunDomain => d === category);

/**
 * How an add-on kind's record counts in a scope summary, from its row: a
 * tree piece with two plan points that passes straight through is a segment
 * (its plan length, the domain its view category names); one with more
 * than one end is a fitting; any other tree member (a source, an end
 * device) is a part. Null: not in a tree.
 */
function addOnScopeShape(el: BimElement): { readonly form: "segment"; readonly lengthMm: number; readonly domain: RunDomain | undefined } | { readonly form: "fitting" | "part" } | null {
  const row = elementKindTable().row(el.kind);
  const ends = row?.connectorEnds;
  if (!row || !ends) return null;
  const points = row.shape?.points?.(el) ?? [];
  const [a, b] = points;
  if (passesThrough(ends) && points.length === 2 && a && b) {
    return { form: "segment", lengthMm: Math.hypot(b.x - a.x, b.y - a.y), domain: domainOfCategory(row.viewCategory) };
  }
  return ends.ends.length > 1 ? { form: "fitting" } : { form: "part" };
}

export function scopeSummary(model: Pick<ModelState, "elements">, ids: readonly string[]): ScopeSummary {
  let segments = 0;
  let fittings = 0;
  let parts = 0;
  let other = 0;
  let lengthMm = 0;
  let flow: number | null = null;
  const domains = new Set<RunDomain>();
  const systems = new Set<ElementId>();
  const take = (f: number) => {
    if (f > 0 && (flow === null || f > flow)) flow = f;
  };
  for (const id of ids) {
    const el = model.elements[id];
    if (!el) continue;
    switch (el.kind) {
      case "run_segment":
        segments += 1;
        lengthMm += len3(sub3(el.end, el.start));
        domains.add(el.domain);
        systems.add(el.systemId);
        take(el.flow);
        break;
      case "run_fitting":
        fittings += 1;
        domains.add(el.domain);
        systems.add(el.systemId);
        break;
      case "part":
        parts += 1;
        break;
      default: {
        const shape = addOnScopeShape(el);
        if (shape === null) other += 1;
        else if (shape.form === "segment") {
          segments += 1;
          lengthMm += shape.lengthMm;
          if (shape.domain) domains.add(shape.domain);
          take(headlineKindValue(el)?.value ?? 0);
        } else if (shape.form === "fitting") fittings += 1;
        else parts += 1;
      }
    }
  }
  const domainList = [...domains];
  return {
    count: segments + fittings + parts + other,
    segments,
    fittings,
    parts,
    other,
    lengthMm: Math.round(lengthMm),
    domain: domainList.length === 0 ? null : domainList.length === 1 ? (domainList[0] ?? null) : "mixed",
    flowEntering: flow,
    systemIds: [...systems].sort(),
  };
}
