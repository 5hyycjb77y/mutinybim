import { feetText, runHeightMm, slopeText, loadOf, runNeighbours, type RunGraphNode, segmentLength3, elementsOfKind, slopeInPerFt, pipeDims, nominalSizeText, systemRules, partLabelOf, drainSystemKinds } from "@permitzip/bim-kernel";
import { gasNetwork, pressureLabel } from "../routing/pipe/gas-zones";
import { GAS_FUEL_LABEL } from "../routing/pipe/gas-fuel";
import { pipeSystemReportOf, type PipeSystemReport } from "../routing/pipe/hydraulics";
import type { MepSystem, RunFitting, RunPoint, RunSegment, BimElement, ElementId, DiagramEdge, DiagramNode, DiagramPipe, DiagramPipeRole } from "@permitzip/bim-kernel";

/**
 * A plumbing system's real topology, read from the routed model: the line
 * from the system's root (the water service or heater, the gas source, the
 * sanitary outfall, the vent's roof terminal) with every branch, device and
 * fixture on it in the order the pipe reaches them, each branch a line of its
 * own. Each drawn piece of pipe between two of those carries its size, length,
 * slope, invert and what it carries.
 *
 * The root and the loads are the pipe report's (`pipeSystemReportOf`), so the
 * riser prints the same numbers as the Properties panel and `bim_pipe_report`.
 * The walk is the report's breadth-first tree over `runNeighbours` (neighbours
 * in id order), so the same model always gives the same tree.
 */

type Elements = Readonly<Record<string, BimElement>>;
type Node = RunGraphNode;

const FT = 304.8;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const idOf = (n: Node): string => (n.includes("#") ? n.slice(0, n.indexOf("#")) : n);
export interface PipingTree {
  readonly root: DiagramNode;
  readonly pipes: readonly DiagramPipe[];
  readonly reads: readonly ElementId[];
}

interface Piece {
  readonly ids: ElementId[];
  readonly segments: RunSegment[];
  /** Where the first segment was entered (the end nearest the root): its downstream end on a drain. */
  entry: RunPoint | null;
  /** Length along the pipe from the station before it (a segment with branches on it is several pieces). */
  lengthMm: number;
}

const newPiece = (): Piece => ({ ids: [], segments: [], entry: null, lengthMm: 0 });

interface Walk {
  readonly root: Node;
  readonly children: ReadonlyMap<Node, readonly Node[]>;
  readonly parent: ReadonlyMap<Node, Node | null>;
  readonly weight: ReadonlyMap<Node, number>;
}

function component(elements: Elements, start: Node): Node[] {
  const seen = new Set<Node>([start]);
  const stack = [start];
  const out: Node[] = [];
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

function walkFrom(elements: Elements, root: Node): Walk {
  const parent = new Map<Node, Node | null>([[root, null]]);
  const children = new Map<Node, Node[]>();
  const order: Node[] = [];
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === undefined) break;
    order.push(n);
    const kids: Node[] = [];
    for (const m of runNeighbours(elements, n).sort()) {
      if (parent.has(m) || (!m.includes("#") && !elements[m])) continue;
      parent.set(m, n);
      kids.push(m);
      queue.push(m);
    }
    children.set(n, kids);
  }
  // How many ends (fixtures, open ends, caps) lie beyond each node: the heavier way on is the line, the others branch off it.
  const weight = new Map<Node, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i] as Node;
    const kids = children.get(n) ?? [];
    const w = kids.reduce((s, k) => s + (weight.get(k) ?? 0), 0);
    weight.set(n, kids.length === 0 ? 1 : w);
  }
  return { root, children, parent, weight };
}

/** Where along a segment a neighbour meets it (mm from its start). */
function positionOn(elements: Elements, seg: RunSegment, n: Node | null, length: number): number {
  if (n === null) return 0;
  const id = idOf(n);
  if (seg.links.start?.elementId === id) return 0;
  if (seg.links.end?.elementId === id) return length;
  const hosted = elements[id];
  if (hosted?.kind === "run_fitting" && hosted.host?.segmentId === seg.id) return hosted.host.s;
  return 0;
}

function abs3(elements: Elements, levelId: string, p: RunPoint): { x: number; y: number; z: number } {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(runHeightMm(elements, levelId, p.z) * 10) / 10 };
}

function partName(elements: Elements, partId: string): string {
  const part = elements[partId];
  return part?.kind === "part" ? partLabelOf(elements, part) : partId;
}

/** The root the report counted from, as a walk node; for a system the report doesn't calculate (vent), its roof terminal. */
function rootNode(elements: Elements, system: MepSystem, report: PipeSystemReport, nodes: readonly Node[]): Node | null {
  const rootId = report.rootId;
  if (rootId) {
    const el = elements[rootId];
    if (el?.kind === "part") return nodes.find((n) => n.startsWith(`${rootId}#`)) ?? null;
    if (nodes.includes(rootId)) return rootId;
  }
  // Vent and other uncalculated piping: the highest open end (the vent through the roof), else the system's entry run.
  let best: { n: Node; z: number } | null = null;
  for (const n of nodes) {
    const el = elements[n];
    if (el?.kind !== "run_segment") continue;
    for (const end of ["start", "end"] as const) {
      if (el.links[end]) continue;
      const z = runHeightMm(elements, el.levelId, el[end].z);
      if (!best || z > best.z + 0.5) best = { n, z };
    }
  }
  if (best) return best.n;
  return system.entryId && nodes.includes(system.entryId) ? system.entryId : (nodes.find((n) => !n.includes("#")) ?? null);
}

/** The end a root segment is entered from: its open end (the highest for a vent through the roof, else the lowest: the outfall, the service). */
function rootEntry(elements: Elements, seg: RunSegment, top: boolean): "start" | "end" {
  const open = (["start", "end"] as const).filter((e) => !seg.links[e]);
  if (open.length === 1) return open[0] as "start" | "end";
  const zs = runHeightMm(elements, seg.levelId, seg.start.z);
  const ze = runHeightMm(elements, seg.levelId, seg.end.z);
  if (Math.abs(zs - ze) < 0.5) return "start";
  return top === zs > ze ? "start" : "end";
}

/**
 * Every connected piece of a system, each its own tree: a system drawn floor by
 * floor before its riser joins them is several pieces. The system's entry run
 * first, then the others by their lowest id.
 */
export function plumbingTrees(elements: Elements, system: MepSystem, hidden: ReadonlySet<string> = new Set()): PipingTree[] {
  const members: ElementId[] = [];
  for (const el of elementsOfKind(elements, "run_segment", "run_fitting")) if (el.systemId === system.id) members.push(el.id);
  members.sort(cmp);
  const anchors = system.entryId && members.includes(system.entryId) ? [system.entryId, ...members] : members;
  const covered = new Set<string>();
  const ids = new Set<string>();
  const out: PipingTree[] = [];
  for (const anchor of anchors) {
    if (covered.has(anchor)) continue;
    const tree = plumbingTree(elements, system, hidden, anchor, covered, ids);
    if (tree) out.push(tree);
    covered.add(anchor);
  }
  return out;
}

function plumbingTree(elements: Elements, system: MepSystem, hidden: ReadonlySet<string>, anchor: ElementId, covered: Set<string>, seenIds: Set<string>): PipingTree | null {
  const report = pipeSystemReportOf(elements, system.id, {}, anchor);
  if (!report) return null;
  const nodes = component(elements, anchor);
  for (const n of nodes) covered.add(n);
  const root = rootNode(elements, system, report, nodes);
  if (!root) return null;
  const walk = walkFrom(elements, root);
  const reads = new Set<ElementId>([system.id]);
  for (const n of nodes) {
    const el = elements[idOf(n)];
    if (!el) continue;
    reads.add(el.id);
    if (el.kind === "part") reads.add(el.typeId);
    if (el.kind === "run_segment" || el.kind === "run_fitting" || el.kind === "part") reads.add(el.levelId);
  }

  const kind = system.systemKind;
  const drain = drainSystemKinds().has(kind) || report.kind === "drainage";
  const unit = systemRules(kind).flowUnit;
  const loads = new Map<string, number>();
  if (report.kind === "drainage" || report.kind === "water") for (const s of report.segments) loads.set(s.elementId, s.fixtureUnits);
  if (report.kind === "gas") for (const s of report.segments) loads.set(s.elementId, s.mbh);
  const calculated = report.kind !== "not_calculated";
  // Gas: each regulator prints its outlet pressure and the input it serves; the source its inlet pressure and the total.
  const gas = kind === "natural_gas" ? gasNetwork({ elements }, system.id) : null;
  const mbhText = (mbh: number) => `${(Math.round(mbh * 100) / 100).toLocaleString("en-US")} MBH`;
  /** A device's name and lines; a gas regulator is named by its role and mark, with its outlet pressure and the input it serves. */
  const deviceLabel = (id: string, name: string, bold: boolean): { name: string; lines: DiagramNode["lines"] } => {
    const g = gas?.regulators.find((r) => r.elementId === id);
    if (!g) return { name, lines: [{ text: name.toUpperCase(), ...(bold ? { bold } : {}) }] };
    return { name: g.label, lines: [{ text: g.label.toUpperCase(), bold: true }, { text: `${pressureLabel(g.outletInWc).toUpperCase()}, ${mbhText(g.loadMbh)}` }] };
  };

  const edgeOf = (piece: Piece): DiagramEdge => {
    const first = piece.segments[0];
    const ids = [...new Set(piece.ids)];
    if (!first) return { linkId: (ids[0] ?? null) as ElementId | null, device: "none", elementIds: ids };
    let load = 0;
    const lengthMm = piece.lengthMm;
    let rise = 0;
    let run = 0;
    for (const s of piece.segments) {
      load = Math.max(load, loads.get(s.id) ?? (calculated ? 0 : s.flow));
      rise += Math.abs(s.end.z - s.start.z);
      run += Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
    }
    const sloped = drain ? piece.segments.find((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 1 && slopeInPerFt(s) > 0.001) : undefined;
    const entry = piece.entry;
    const invert = drain && entry && first.size.shape === "pipe" ? feetText((runHeightMm(elements, first.levelId, entry.z) - pipeDims(first.size).idMm / 2) / FT) : undefined;
    const round = Math.round(load * 100) / 100;
    return {
      linkId: first.id,
      device: "none",
      label: nominalSizeText(first.size),
      elementIds: ids,
      lengthFt: Math.max(1, Math.round(lengthMm / FT)),
      ...(round > 0 && unit ? { load: `${round.toLocaleString("en-US")} ${unit}` } : {}),
      ...(sloped ? { slope: slopeText(slopeInPerFt(sloped)) } : {}),
      ...(invert ? { invert: `INV ${invert}` } : {}),
      ...(rise > run ? { vertical: true } : {}),
    };
  };

  const node = (id: string, elementId: string, role: DiagramPipeRole, name: string, lines: DiagramNode["lines"], levelId: string | null, at: DiagramNode["at"], feed: DiagramEdge | undefined, children: DiagramNode[]): DiagramNode => ({
    id,
    elementId: elementId as ElementId,
    kind: "equipment",
    labelKind: "equipment",
    name,
    lines,
    levelId,
    service: kind,
    role,
    ...(at ? { at } : {}),
    ...(feed ? { feed } : {}),
    children,
  });

  const heaviest = (kids: readonly Node[]): Node | null => {
    let best: Node | null = null;
    for (const k of kids) if (best === null || (walk.weight.get(k) ?? 0) > (walk.weight.get(best) ?? 0)) best = k;
    return best;
  };

  const uniqueId = (id: string): string => {
    let out = id;
    for (let i = 2; seenIds.has(out); i++) out = `${id}~${i}`;
    seenIds.add(out);
    return out;
  };

  const terminalOfPart = (n: Node, piece: Piece): DiagramNode => {
    const partId = idOf(n);
    const part = elements[partId];
    const name = partName(elements, partId);
    const feed = edgeOf(piece);
    // The fixture's own load (its connector), not the pipe's: the pipe reaching it may carry the fixtures beyond it too.
    const own = part?.kind === "part" && calculated ? Math.round(loadOf(elements, part, n.slice(n.indexOf("#") + 1)) * 100) / 100 : 0;
    const appliance = gas?.appliances.find((a) => a.elementId === partId);
    const lines = [{ text: name.toUpperCase(), bold: true }, ...(appliance ? [{ text: mbhText(appliance.mbh) }] : own > 0 && unit ? [{ text: `${own.toLocaleString("en-US")} ${unit}` }] : [])];
    const at = part?.kind === "part" ? { x: part.position.x, y: part.position.y, z: runHeightMm(elements, part.levelId, part.offsetMm ?? 0) } : undefined;
    return node(uniqueId(partId), partId, "terminal", name, lines, part?.kind === "part" ? part.levelId : null, at, feed, []);
  };

  /** One line: from `start` (entered from `from`) to the end the heavier way leads, with the branches and devices on the way. */
  const line = (start: Node, from: Node | null, startEnd: "start" | "end" | null): DiagramNode[] => {
    const stations: DiagramNode[] = [];
    let piece = newPiece();
    let cur: Node | null = start;
    let prev: Node | null = from;
    let firstEnd = startEnd;
    const close = (): Piece => {
      const p = piece;
      piece = newPiece();
      return p;
    };
    while (cur !== null) {
      const el: BimElement | undefined = elements[idOf(cur)];
      const kids = walk.children.get(cur) ?? [];
      if (!el) break;
      if (el.kind === "part") {
        if (kids.length === 0) {
          if (!hidden.has(el.id)) stations.push(terminalOfPart(cur, close()));
          return stations;
        }
        // An inline part (meter, backflow preventer, pump): a device on the line.
        const label = deviceLabel(el.id, partName(elements, el.id), true);
        if (!hidden.has(el.id)) stations.push(node(uniqueId(el.id), el.id, "device", label.name, label.lines, el.levelId, { x: el.position.x, y: el.position.y, z: runHeightMm(elements, el.levelId, el.offsetMm ?? 0) }, edgeOf(close()), []));
        const next = heaviest(kids);
        for (const k of kids) if (k !== next) stations.push(...branchAt(k, cur));
        prev = cur;
        cur = next;
        continue;
      }
      if (el.kind === "run_segment") {
        const seg = el;
        const length = segmentLength3(seg);
        const e = firstEnd ? (firstEnd === "start" ? 0 : length) : positionOn(elements, seg, prev, length);
        firstEnd = null;
        piece.ids.push(seg.id);
        piece.segments.push(seg);
        if (!piece.entry) piece.entry = e <= 0.5 ? seg.start : e >= length - 0.5 ? seg.end : null;
        const farPos = e <= 0.5 ? length : e >= length - 0.5 ? 0 : null;
        const farEnd = farPos === 0 ? "start" : "end";
        const placed = kids.map((k) => ({ k, pos: positionOn(elements, seg, k, length) })).sort((a, b) => Math.abs(a.pos - e) - Math.abs(b.pos - e) || cmp(a.k, b.k));
        const far = farPos === null ? null : (placed.find((p) => Math.abs(p.pos - farPos) < 0.5 && (seg.links.start?.elementId === idOf(p.k) || seg.links.end?.elementId === idOf(p.k)))?.k ?? null);
        // Straight through to the far end when there is one; an open far end finishes the line there.
        const openFar = farPos !== null && !seg.links[farEnd];
        const next = far ?? (openFar ? null : heaviest(kids));
        let lastPos = e;
        const advance = (pos: number) => {
          piece.lengthMm += Math.abs(pos - lastPos);
          lastPos = pos;
        };
        for (const { k, pos } of placed) {
          if (k === next) continue;
          const f = elements[idOf(k)];
          advance(pos);
          if (f?.kind === "run_fitting" && f.fittingType === "accessory") {
            if (hidden.has(f.id)) continue;
            const label = deviceLabel(f.id, f.label, false);
            stations.push(node(uniqueId(f.id), f.id, "device", label.name, label.lines, f.levelId, abs3(elements, f.levelId, f.position), edgeOf(close()), []));
            piece.ids.push(seg.id);
            piece.segments.push(seg);
            continue;
          }
          const before = close();
          stations.push(...branchAt(k, cur, before));
          piece.ids.push(seg.id);
          piece.segments.push(seg);
        }
        if (farPos !== null) advance(farPos);
        if (next === null) {
          // The far end: open (a fixture's or the service's end), else the line stops where the walk met itself.
          const end = farEnd;
          if (openFar) {
            const id = `${seg.id}:${end}`;
            if (!hidden.has(id)) stations.push(node(uniqueId(id), seg.id, "terminal", "OPEN END", [{ text: "OPEN END" }], seg.levelId, abs3(elements, seg.levelId, seg[end]), edgeOf(close()), []));
          }
          return stations;
        }
        prev = cur;
        cur = next;
        continue;
      }
      if (el.kind === "run_fitting") {
        const f: RunFitting = el;
        piece.ids.push(f.id);
        if (f.fittingType === "cap" || kids.length === 0) {
          if (!hidden.has(f.id)) stations.push(node(uniqueId(f.id), f.id, "terminal", f.fittingType === "cap" ? "CAP" : "OPEN END", [{ text: f.fittingType === "cap" ? "CAP" : "OPEN END" }], f.levelId, abs3(elements, f.levelId, f.position), edgeOf(close()), []));
          return stations;
        }
        if (f.fittingType === "transition" && cur !== root) {
          stations.push(node(uniqueId(f.id), f.id, "device", f.label, [], f.levelId, abs3(elements, f.levelId, f.position), edgeOf(close()), []));
          piece.ids.push(f.id);
        }
        const next = heaviest(kids);
        for (const k of kids) if (k !== next) stations.push(...branchAt(k, cur, close()));
        prev = cur;
        cur = next;
        continue;
      }
      break;
    }
    return stations;
  };

  /** A branch leaving the line at `at` (a tee, a wye, or the other way at a fitting): its own line under one branch node. */
  const branchAt = (k: Node, at: Node, before: Piece = newPiece()): DiagramNode[] => {
    const el = elements[idOf(k)];
    if (!el || hidden.has(el.id)) return [];
    const where = el.kind === "run_fitting" ? abs3(elements, el.levelId, el.position) : el.kind === "run_segment" ? abs3(elements, el.levelId, el.start) : undefined;
    const levelId = el.kind === "run_fitting" || el.kind === "run_segment" || el.kind === "part" ? el.levelId : null;
    const name = el.kind === "run_fitting" ? el.label : el.kind === "part" ? partName(elements, el.id) : "BRANCH";
    if (el.kind === "part") return line(k, at, null);
    return [node(uniqueId(el.id), el.id, "branch", name, [], levelId, where, edgeOf(before), line(k, at, null))];
  };

  // The root: the source part, or the open end of the root pipe.
  const rootEl = elements[idOf(root)];
  if (!rootEl) return null;
  const gasSource = gas?.zones.find((z) => z.id === "zone-source");
  const gasTotalLine: DiagramNode["lines"] = gas && gasSource ? [{ text: `${GAS_FUEL_LABEL[gas.gas].toUpperCase()}, ${pressureLabel(gasSource.inletInWc).toUpperCase()}, ${mbhText(gas.totalMbh)} TOTAL` }] : [];
  let head: DiagramNode;
  if (rootEl.kind === "part") {
    const name = partName(elements, rootEl.id);
    const kids = walk.children.get(root) ?? [];
    const main = kids[0] ? line(kids[0], root, null) : [];
    for (const k of kids.slice(1)) main.push(...branchAt(k, root));
    head = node(uniqueId(rootEl.id), rootEl.id, "source", name, [{ text: name.toUpperCase(), bold: true }, { text: system.name.toUpperCase() }, ...gasTotalLine], rootEl.levelId, { x: rootEl.position.x, y: rootEl.position.y, z: runHeightMm(elements, rootEl.levelId, rootEl.offsetMm ?? 0) }, undefined, main);
  } else {
    const entryEnd = rootEl.kind === "run_segment" ? rootEntry(elements, rootEl, kind === "vent") : null;
    const main = line(root, null, entryEnd);
    // Counted from an open end: where the pipe leaves the building (or enters it). Otherwise the report had nowhere to start; say so.
    const open = rootEl.kind === "run_segment" && entryEnd !== null && !rootEl.links[entryEnd];
    const word = !open ? (drain ? "NO OUTFALL CONNECTED" : "NO SOURCE CONNECTED") : drain ? (kind === "storm" ? "TO STORM" : "TO SEWER") : kind === "vent" ? "THRU ROOF" : "SERVICE";
    const at = rootEl.kind === "run_segment" && entryEnd ? abs3(elements, rootEl.levelId, rootEl[entryEnd]) : rootEl.kind === "run_fitting" ? abs3(elements, rootEl.levelId, rootEl.position) : undefined;
    const levelId = rootEl.kind === "run_segment" || rootEl.kind === "run_fitting" ? rootEl.levelId : null;
    head = node(uniqueId(`root:${system.id}`), rootEl.id, "source", word, [{ text: system.name.toUpperCase(), bold: true }, { text: word }, ...gasTotalLine], levelId, at, undefined, main);
  }

  const pipes: DiagramPipe[] = [];
  for (const n of nodes) {
    const el = elements[n];
    if (el?.kind !== "run_segment") continue;
    pipes.push({ elementId: el.id, systemKind: kind, a: abs3(elements, el.levelId, el.start), b: abs3(elements, el.levelId, el.end) });
  }
  pipes.sort((a, b) => cmp(a.elementId, b.elementId));
  return { root: head, pipes, reads: [...reads].sort() };
}
