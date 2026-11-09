import { paramValue, resolveConnectors } from "../parts";
import type { BimElement, ElementId, PartInstance } from "../types";
import { partConnectionTypeLoad } from "../load-points/model";
import { runEndOf } from "../requirements/anchor";
import { endHasLoadPoint, isCouplerPart, isCouplingOutlet, loadPointLoads, loadPointNeighbours } from "../load-points/walk-loads";
import { loadPointLoad } from "../load-points/model";
import { captureTree, flowForestOf, forestWith, setFlowForest, withOwn, type FlowTree } from "./flow-trees";
import { hostedPoints, linksOf, samePoint } from "./geometry";
import type { RunFitting, RunPoint } from "./types";

type Elements = Record<string, BimElement>;

/** Parts that feed a system (units, panels) rather than load it. */
export function isSource(elements: Readonly<Elements>, part: PartInstance): boolean {
  const type = elements[part.typeId];
  if (!type || type.kind !== "part_type") return false;
  const c = type.definition.category;
  return c === "mechanical_equipment" || c === "electrical_equipment";
}

/** What one linked connector of a part adds to the system: its design flow, else the type's fixture units. */
export function loadOf(elements: Readonly<Elements>, part: PartInstance, connectorId: string): number {
  if (isSource(elements, part)) return 0;
  const type = elements[part.typeId];
  if (!type || type.kind !== "part_type") return 0;
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connectorId);
  if (c?.flow !== undefined) return c.flow;
  const fromType = partConnectionTypeLoad(elements, part, c?.systemKind ?? null);
  if (fromType !== null) return fromType;
  const fu = paramValue(type.definition, part.values, "fixture_units");
  return typeof fu === "number" ? fu : 0;
}

function samePt(a: RunPoint, b: RunPoint): boolean {
  return samePoint(a, b, 1e-6);
}

/** A branch fitting placed where its host says (null when unchanged or the host is gone). */
export function rederiveHosted(elements: Readonly<Elements>, f: RunFitting): RunFitting | null {
  if (!f.host) return null;
  const host = elements[f.host.segmentId];
  if (!host || host.kind !== "run_segment") return null;
  const at = hostedPoints(host, f.host.s, f.host.side, f.host.dir, f.host.face, f.host.t);
  const port = f.ports[0];
  // Inline accessories (valves, cleanouts) have no branch port: only their place on the pipe follows.
  if (!port) return samePt(f.position, at.onAxis) ? null : { ...f, position: at.onAxis };
  if (samePt(f.position, at.onAxis) && samePt(port.position, at.branch) && samePt(port.direction, at.outward)) return null;
  return { ...f, position: at.onAxis, ports: [{ ...port, position: at.branch, direction: at.outward }, ...f.ports.slice(1)] };
}

/**
 * An inline accessory part (meter, backflow preventer, regulator, interceptor):
 * its inlet and outlet on the same system are one path, so the pipe on either
 * side stays one system. Parts still never join two systems.
 */
function inlineThrough(elements: Readonly<Elements>, part: PartInstance, connectorId: string): string[] {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type" || type.definition.category !== "pipe_accessory") return [];
  // Which way flow goes through a connector doesn't depend on parameters: read the definition.
  const connectors = type.definition.connectors;
  const me = connectors.find((c) => c.id === connectorId);
  if (!me?.flowDirection || me.flowDirection === "bidirectional") return [];
  return connectors.filter((c) => c.id !== me.id && c.systemKind === me.systemKind && c.flowDirection !== undefined && c.flowDirection !== me.flowDirection).map((c) => c.id);
}

/** Graph node: a run element, or one connector of a part (parts never join two systems together). */
export type RunGraphNode = string;
type Node = RunGraphNode;
export const partNode = (partId: string, connector: string): Node => `${partId}#${connector}`;

export function runNeighbours(elements: Readonly<Elements>, node: Node): Node[] {
  const hash = node.indexOf("#");
  if (hash >= 0) {
    const part = elements[node.slice(0, hash)];
    if (part?.kind !== "part") return [];
    const connector = node.slice(hash + 1);
    const link = part.links?.[connector];
    // Joined end to end (join_parts): the other part's connector, or the load point it serves.
    const far = link ? elements[link.elementId] : undefined;
    const out: Node[] = link ? [far?.kind === "part" ? partNode(far.id, link.port) : link.elementId] : [];
    for (const other of inlineThrough(elements, part, connector)) out.push(partNode(part.id, other));
    return out;
  }
  const el = elements[node];
  if (!el) return [];
  if (el.kind === "load_point") {
    const at = runEndOf(el);
    if (at) return elements[at.elementId] ? [at.elementId] : [];
    // Served end to end by a part's connector (join_parts): its requirement is carried through that connector.
    const by = el.joinedTo;
    return by && elements[by.elementId]?.kind === "part" ? [partNode(by.elementId, by.port)] : [];
  }
  const out: Node[] = [];
  for (const [, link] of linksOf(el)) {
    const other = elements[link.elementId];
    out.push(other?.kind === "part" ? partNode(other.id, link.port) : link.elementId);
  }
  if (el.kind === "run_segment") out.push(...el.branches);
  if (el.kind === "run_fitting" && el.host) out.push(el.host.segmentId);
  if (el.kind === "run_segment" || el.kind === "run_fitting") out.push(...loadPointNeighbours(elements, el.id));
  return out;
}

/**
 * Re-derive routed runs around `seeds` (run elements or parts) in place:
 * branch fittings follow their hosts, then each touched system's segments
 * carry the sum of the loads beyond them, counted away from the system's
 * source (a unit or panel), else from a run end (cap or loose end), else
 * from the run's first element. Returns the
 * ids it changed, sorted by id so every path reports the same order.
 */
export function deriveRuns(elements: Elements, seeds: Iterable<ElementId>): ElementId[] {
  return walkRuns(elements, [...seeds], null);
}

/** Which path `deriveRunsAfter` took, for tests that assert the full walk runs only when it must. */
export const runDeriveStats = { local: 0, full: 0 };

/**
 * `deriveRuns` after a command, given what it touched. When the command only
 * changed load-point values (same pipe end, same attached fixture) on systems
 * whose walk the base model kept, only the edited points' paths to the root are
 * refolded (flow-trees.ts), with the same numbers a full walk writes. Anything
 * else (a new or moved point, a pipe edit, a connection type, a water heater
 * joining two systems, no kept walk) walks the touched systems in full, as
 * before, and keeps those walks for the next edit.
 */
export function deriveRunsAfter(base: Readonly<Elements>, elements: Elements, touched: readonly ElementId[], seeds: Iterable<ElementId>): ElementId[] {
  const seedList = [...seeds];
  const forest = flowForestOf(base);
  const local = forest ? localLoadEdits(forest, base, elements, touched) : null;
  if (local) {
    runDeriveStats.local += 1;
    const changed = new Set<ElementId>(rederiveHostedAround(elements, seedList));
    const next: FlowTree[] = [];
    for (const [tree, ownChanges] of local) {
      const { tree: after, moved } = withOwn(tree, ownChanges);
      next.push(after);
      for (const n of moved) {
        const el = elements[n];
        if (el?.kind !== "run_segment") continue;
        const flow = Math.round((after.total.get(n) ?? 0) * 1000) / 1000;
        if (el.flow !== flow) {
          elements[n] = { ...el, flow };
          changed.add(el.id);
        }
      }
    }
    const replaced = new Set<FlowTree>(local.keys());
    setFlowForest(elements, forestWith(forest, (t) => !replaced.has(t), next));
    return [...changed].sort();
  }
  runDeriveStats.full += 1;
  const captured: FlowTree[] = [];
  const changed = walkRuns(elements, seedList, captured);
  // Kept walks stay valid only when this command changed nothing but load points outside them.
  const onlyLoads = touched.every((id) => elements[id]?.kind === "load_point" || (elements[id] === undefined && base[id]?.kind === "load_point"));
  const walkedNodes = new Set<string>(captured.flatMap((t) => t.order));
  const keep = (t: FlowTree): boolean => onlyLoads && !t.order.some((n) => walkedNodes.has(n)) && !touched.some((id) => t.index.has(id));
  setFlowForest(elements, forestWith(forest, keep, captured));
  return changed;
}

/**
 * The trees a load-point-only edit changes, with each tree's new own loads;
 * null when the edit can't be applied locally.
 */
function localLoadEdits(forest: NonNullable<ReturnType<typeof flowForestOf>>, base: Readonly<Elements>, elements: Readonly<Elements>, touched: readonly ElementId[]): Map<FlowTree, Map<string, number>> | null {
  if (touched.length === 0) return null;
  const out = new Map<FlowTree, Map<string, number>>();
  for (const id of touched) {
    const before = base[id];
    const now = elements[id];
    if (before?.kind !== "load_point" || now?.kind !== "load_point") return null;
    if (before.attachedPartId !== now.attachedPartId) return null;
    const a = runEndOf(before);
    const b = runEndOf(now);
    if ((a === null) !== (b === null)) return null;
    if (a && b && (a.elementId !== b.elementId || a.port !== b.port)) return null;
    // On no pipe: it never counted toward a flow.
    if (!b) continue;
    const tree = forest.treeOf.get(id);
    if (!tree || tree.coupled || !tree.index.has(b.elementId)) return null;
    let changes = out.get(tree);
    if (!changes) out.set(tree, (changes = new Map()));
    changes.set(id, loadPointLoad(elements, now));
  }
  return out;
}

/** Branch fittings that follow a seed pipe (or are seeds) placed where their hosts say. */
function rederiveHostedAround(elements: Elements, seedList: readonly ElementId[]): ElementId[] {
  const changed: ElementId[] = [];
  const hostedCandidates = new Set<ElementId>();
  for (const id of seedList) {
    const el = elements[id];
    if (el?.kind === "run_fitting" && el.host) hostedCandidates.add(el.id);
    if (el?.kind === "run_segment") for (const b of el.branches) hostedCandidates.add(b);
  }
  for (const id of [...hostedCandidates].sort()) {
    const el = elements[id];
    if (el?.kind !== "run_fitting") continue;
    const next = rederiveHosted(elements, el);
    if (next) {
      elements[id] = next;
      changed.push(el.id);
    }
  }
  return changed;
}

function walkRuns(elements: Elements, seedList: readonly ElementId[], capture: FlowTree[] | null): ElementId[] {
  const changed = new Set<ElementId>(rederiveHostedAround(elements, seedList));

  const visited = new Set<Node>();
  const pending: Node[] = [];
  for (const id of seedList) {
    const el = elements[id];
    if (!el) continue;
    if (el.kind === "run_segment" || el.kind === "run_fitting" || el.kind === "load_point") pending.push(el.id);
    else if (el.kind === "part") for (const c of Object.keys(el.links ?? {})) pending.push(partNode(el.id, c));
  }
  while (pending.length > 0) {
    const start = pending.shift();
    if (start === undefined || visited.has(start)) continue;
    const before = visited.size;
    for (const id2 of flowComponent(elements, start, visited, capture)) changed.add(id2);
    // A coupler (a water heater) joins its two systems: the pipe feeding it carries what the other side serves.
    if (visited.size > before) for (const n of [...visited].slice(before)) {
      const hash = n.indexOf("#");
      if (hash < 0) continue;
      const part = elements[n.slice(0, hash)];
      if (part?.kind !== "part" || !isCouplerPart(elements, part)) continue;
      for (const c of Object.keys(part.links ?? {})) if (!visited.has(partNode(part.id, c))) pending.push(partNode(part.id, c));
    }
  }
  return [...changed].sort();
}

/** A cap, a segment with a loose end, or a fitting with an unconnected port. An open end with a load point is a fixture, not a loose end. */
function isRunEnd(elements: Readonly<Elements>, node: Node): boolean {
  if (node.includes("#")) return false;
  const el = elements[node];
  if (el?.kind === "run_segment") return (!el.links.start && !endHasLoadPoint(elements, el.id, "start")) || (!el.links.end && !endHasLoadPoint(elements, el.id, "end"));
  if (el?.kind === "run_fitting") return el.fittingType === "cap" || el.ports.some((p) => !p.link && !endHasLoadPoint(elements, el.id, p.id));
  return false;
}

/** A unit, panel or coupler outlet (a water heater's hot side): where a system is fed from. */
export function isSourceNode(elements: Readonly<Elements>, node: Node): boolean {
  const hash = node.indexOf("#");
  if (hash < 0) return false;
  const part = elements[node.slice(0, hash)];
  return part?.kind === "part" && (isSource(elements, part) || isCouplingOutlet(elements, part, node.slice(hash + 1)));
}

/** One connected system: walk it, pick the root, sum loads below each node, write segment flows. */
function flowComponent(elements: Elements, start: Node, visited: Set<Node>, capture: FlowTree[] | null): ElementId[] {
  const nodes: Node[] = [];
  const stack: Node[] = [start];
  visited.add(start);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    nodes.push(n);
    for (const m of runNeighbours(elements, n)) {
      if (visited.has(m) || (!m.includes("#") && !elements[m])) continue;
      visited.add(m);
      stack.push(m);
    }
  }
  nodes.sort();
  const sourceNode = nodes.find((n) => isSourceNode(elements, n));
  // No unit or panel yet: count from a run end, where one would connect, so a sourceless run already carries the
  // loads it will carry once fed, and an edit elsewhere cannot move the root by adding ids that sort first.
  const root = sourceNode ?? nodes.find((n) => isRunEnd(elements, n)) ?? nodes.find((n) => !n.includes("#")) ?? nodes[0];
  if (root === undefined) return [];

  // Iterative post-order over the BFS tree from the root.
  const parent = new Map<Node, Node | null>([[root, null]]);
  const order: Node[] = [];
  const queue: Node[] = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    order.push(n);
    for (const m of runNeighbours(elements, n).sort()) {
      if (parent.has(m) || (!m.includes("#") && !elements[m])) continue;
      parent.set(m, n);
      queue.push(m);
    }
  }
  const rootEl = elements[root.includes("#") ? root.slice(0, root.indexOf("#")) : root];
  const systemEl = rootEl?.kind === "run_segment" || rootEl?.kind === "run_fitting" ? elements[rootEl.systemId] : undefined;
  const points = loadPointLoads(elements, { order, parent }, systemEl?.kind === "mep_system" ? systemEl.systemKind : systemKindNear(elements, order), (n) => runNeighbours(elements, n));
  const sum = new Map<Node, number>();
  const ownOf = capture ? new Map<Node, number>() : null;
  let coupled = points.alsoRead.length > 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n === undefined) continue;
    const hash = n.indexOf("#");
    let own = points.own.get(n) ?? 0;
    if (hash >= 0) {
      const part = elements[n.slice(0, hash)];
      if (part?.kind === "part" && !points.attachedParts.has(part.id)) own += loadOf(elements, part, n.slice(hash + 1));
      if (capture && part?.kind === "part" && isCouplerPart(elements, part)) coupled = true;
    }
    if (ownOf) ownOf.set(n, own);
    const total = (sum.get(n) ?? 0) + own;
    sum.set(n, total);
    const up = parent.get(n);
    if (up !== null && up !== undefined) sum.set(up, (sum.get(up) ?? 0) + total);
  }
  if (capture && ownOf) capture.push(captureTree(order, parent, ownOf, sum, coupled));
  const changed: ElementId[] = [];
  for (const n of order) {
    const el = elements[n];
    if (el?.kind !== "run_segment") continue;
    const flow = Math.round((sum.get(n) ?? 0) * 1000) / 1000;
    if (el.flow !== flow) {
      elements[n] = { ...el, flow };
      changed.push(el.id);
    }
  }
  return changed;
}

/** The system of the first run element in a walk (the root may be a part connector). */
function systemKindNear(elements: Readonly<Elements>, order: readonly Node[]): string | null {
  for (const n of order) {
    const el = elements[n];
    if (el?.kind === "run_segment" || el?.kind === "run_fitting") {
      const system = elements[el.systemId];
      return system?.kind === "mep_system" ? system.systemKind : null;
    }
  }
  return null;
}
