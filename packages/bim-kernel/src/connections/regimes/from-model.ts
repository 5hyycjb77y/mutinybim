import type { RunFitting, RunSegment } from "../../routing/types";
import type { BimElement, PartInstance } from "../../types";
import type { GravityEdge, GravityNetwork, GravityNode } from "./gravity";

/**
 * The gravity regime's input built from drawn runs (FOUNDATION-COVERAGE §2.5):
 * the run segments of a service, joined through the parts, fittings and other
 * segments their ends link to, so a pack calls `walkGravity` on its own runs
 * without rebuilding the graph. Generic: which systems, which parts have a
 * fixed invert and where the network ends are the caller's.
 *
 * - Nodes: a part (all its connectors are one structure), a fitting, or a
 *   segment end that links to nothing (`<segmentId>@start` / `@end`).
 * - Edges: each segment, by its plan length, oriented downhill: toward the
 *   outfalls when given, else from its higher end to its lower (start to end
 *   when level). A segment whose values carry `flow.pumped: true` is a pumped
 *   edge.
 * - A branch fitting hosted on a trunk (a tap, a wye) is a node on the trunk:
 *   an extra edge from it to the trunk's downstream end, over the rest of the
 *   trunk, under the trunk's id.
 */

/** The kernel-read key that marks a run segment as lifted by a pump (`values`, element-core; a boolean). */
export const PUMPED_SEGMENT_KEY = "flow.pumped";

type Elements = Readonly<Record<string, BimElement>>;

export interface GravityModelOptions {
  /** System kinds whose segments are in the network (a built-in drain, a pack's `civil.storm`). */
  readonly systemKinds: readonly string[];
  /** A part's known invert, model elevation in mm (a structure's measured invert value), or undefined to derive it. */
  readonly fixedInvertMm?: (part: PartInstance, elements: Elements) => number | undefined;
  /** A part's surface above it (rim), model elevation in mm. */
  readonly topMm?: (part: PartInstance, elements: Elements) => number | undefined;
  /** Element ids (parts or fittings) the network drains to. Absent: each segment runs from its higher end to its lower. */
  readonly outfalls?: readonly string[];
}

export interface GravityModelNetwork {
  readonly network: GravityNetwork;
  /** The segment an edge stands for (hosted-branch edges stand for their trunk). */
  readonly segmentOf: ReadonlyMap<string, string>;
  /** The node a part, a fitting or a segment end is. */
  nodeOf(elementId: string, port?: "start" | "end"): string | null;
}

function systemKindOf(elements: Elements, seg: RunSegment): string | null {
  const sys = elements[seg.systemId];
  return sys?.kind === "mep_system" ? sys.systemKind : null;
}

const plan = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(b.x - a.x, b.y - a.y);

/** The gravity network of the segments on `opts.systemKinds`, with node and edge maps back to the model. */
export function gravityNetworkOf(elements: Elements, opts: GravityModelOptions): GravityModelNetwork {
  const kinds = new Set(opts.systemKinds);
  const segments: RunSegment[] = [];
  const fittings: RunFitting[] = [];
  for (const el of Object.values(elements)) {
    if (el.kind === "run_segment") {
      const k = systemKindOf(elements, el);
      if (k !== null && kinds.has(k)) segments.push(el);
    } else if (el.kind === "run_fitting") fittings.push(el);
  }
  const segIds = new Set(segments.map((s) => s.id));

  // Union-find over node keys: a segment end linked to another segment's end is one node.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) ?? r;
    let c = k;
    while (c !== r) {
      const next = parent.get(c) ?? r;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const endKey = (seg: RunSegment, end: "start" | "end"): string => {
    const link = seg.links[end];
    if (!link) return `${seg.id}@${end}`;
    const target = elements[link.elementId];
    if (target?.kind === "part" || target?.kind === "run_fitting") return target.id;
    if (target?.kind === "run_segment" && segIds.has(target.id) && (link.port === "start" || link.port === "end")) {
      union(`${seg.id}@${end}`, `${target.id}@${link.port}`);
      return `${seg.id}@${end}`;
    }
    return `${seg.id}@${end}`;
  };
  const raw = segments.map((s) => ({ seg: s, a: endKey(s, "start"), b: endKey(s, "end") }));
  const node = (k: string) => find(k);

  const ends = raw.map((r) => ({ ...r, a: node(r.a), b: node(r.b) }));
  const outfalls = new Set((opts.outfalls ?? []).map((id) => node(id)));
  // Orientation toward the outfalls: breadth-first distance in segments from them.
  const dist = new Map<string, number>();
  if (outfalls.size > 0) {
    const adj = new Map<string, string[]>();
    for (const e of ends) {
      adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
      adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
    }
    const queue = [...outfalls];
    for (const o of queue) dist.set(o, 0);
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i];
      if (n === undefined) continue;
      for (const m of adj.get(n) ?? []) {
        if (dist.has(m)) continue;
        dist.set(m, (dist.get(n) ?? 0) + 1);
        queue.push(m);
      }
    }
  }

  const edges: GravityEdge[] = [];
  const segmentOf = new Map<string, string>();
  const downEnd = new Map<string, "start" | "end">();
  for (const e of ends) {
    const da = dist.get(e.a);
    const db = dist.get(e.b);
    const startHigher = e.seg.start.z >= e.seg.end.z;
    const towardEnd = da !== undefined && db !== undefined ? db <= da : startHigher;
    const pumped = e.seg.values?.[PUMPED_SEGMENT_KEY] === true;
    edges.push({ id: e.seg.id, from: towardEnd ? e.a : e.b, to: towardEnd ? e.b : e.a, lengthMm: plan(e.seg.start, e.seg.end), ...(pumped ? { pumped: true } : {}) });
    segmentOf.set(e.seg.id, e.seg.id);
    downEnd.set(e.seg.id, towardEnd ? "end" : "start");
  }
  const byId = new Map(ends.map((e) => [e.seg.id, e]));
  for (const f of fittings) {
    const host = f.host ? byId.get(f.host.segmentId) : undefined;
    if (!f.host || !host) continue;
    const length = plan(host.seg.start, host.seg.end);
    const toEnd = downEnd.get(host.seg.id) === "end";
    const rest = toEnd ? Math.max(0, length - f.host.s) : Math.max(0, f.host.s);
    const id = `${host.seg.id}~${f.id}`;
    edges.push({ id, from: node(f.id), to: toEnd ? host.b : host.a, lengthMm: rest });
    segmentOf.set(id, host.seg.id);
  }

  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  const nodes: GravityNode[] = [];
  for (const id of nodeIds) {
    const el = elements[id];
    if (el?.kind !== "part") {
      nodes.push({ id });
      continue;
    }
    const inv = opts.fixedInvertMm?.(el, elements);
    const top = opts.topMm?.(el, elements);
    nodes.push({ id, ...(inv !== undefined ? { invertMm: inv } : {}), ...(top !== undefined ? { topMm: top } : {}) });
  }
  return {
    network: { nodes, edges },
    segmentOf,
    nodeOf: (elementId, port) => {
      const key = port ? `${elementId}@${port}` : elementId;
      const n = node(key);
      return nodeIds.has(n) ? n : null;
    },
  };
}
