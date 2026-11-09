import { elementsOfKind, isVerticalLeg, loadPointQuantities, loadPointTotals, mergePipeDesign, nominalInOf, runNeighbours, slopeInPerFt, specOfSize, type ElementId, type MepSystem, type ModelState, type RunSegment, runEndOf } from "@permitzip/bim-kernel";
import { pipeLoadWalk, pipeNodeId, type PipeLoadWalk, type PipeWarning } from "../../routing/pipe/hydraulics";
import { nominalLabel, methodCite, ipcCite, type IpcEdition, round, ipcTables } from "@permitzip/bim-calc";
import type { CalcStep, Citation } from "@permitzip/bim-calc";
import { absZ, changeFindings, labelOf, lengthFt, MM_PER_FT, proposalOf, segOf } from "./sizing-common";
import type { PipeSizeProposal, PipeSizingFinding, PipeSizingRole, PipeSystemSizing, SizingOutcome, systemSizingMode } from "./system-sizing";

const { NOT_IN_LIBRARY, STORM_MIN_SLOPE_IN_PER_FT, TABLE_1106_2_1, TABLE_1106_3, TABLE_1106_3_SLOPES, TABLE_710_1_2, TABLE_906_1, TABLE_906_1_VENT_IN, VENT_MIN_IN, VENT_UPSIZE_OVER_FT } = ipcTables;

/**
 * Vent and storm sizing on the same path as water and sanitary
 * (`plumbing.size_system`, then `bim_size_pipes` or auto-sizing): a proposal
 * per pipe against what is drawn, findings in plain words, never an edit.
 *
 * Vent (VPC 2021 906): each vent pipe vents the fixtures whose vent
 * connections lie beyond it from the open air. What it vents is their
 * drainage fixture units; the drain it serves is where their drains come
 * together in the sanitary system; its developed length runs from the
 * farthest of those connections to the open air.
 * - A vertical vent serving a stack (a stack vent or vent stack): Table
 *   906.1 by the stack's size, the units vented and the developed length;
 *   never less than half the stack or 1-1/4 in. (906.1).
 * - Every other vent (individual, branch, circuit, relief; 906.4 common
 *   branch vents on their total): half the drain Table 710.1(2) requires for
 *   the units vented, 1-1/4 in. at least, one size larger over 40 ft of
 *   developed length (906.2).
 *
 * Storm (VPC 2021 1106): each storm pipe carries the roof area of the drains
 * beyond it. The rainfall rate is the system's, from approved local weather
 * data: the code library holds Figure 1106.1 only as images, so with no
 * rate this refuses by name rather than guessing.
 * - Vertical: Table 1106.2(1), leaders.
 * - Horizontal: Table 1106.3 at its slope (1/8 in/ft least, 1106.3).
 * - Read in the column for the next whole inch per hour at or above the
 *   rate (conservative); never smaller than a pipe draining into it.
 */

type Mode = ReturnType<typeof systemSizingMode>;
type Node = string;

/** One sq ft of roof at 1 in/h drains 0.0104 gpm (IPC Appendix B): sq ft = gpm x 96.23 / rate. */
const SQFT_PER_GPM_AT_1_IN_PER_HR = 96.23;
const ROOF_AREA_KEYS = ["roof_area_sqft", "roof_area"] as const;

const vertical = (s: RunSegment) => isVerticalLeg({ x: s.end.x - s.start.x, y: s.end.y - s.start.y, z: s.end.z - s.start.z });

/** The smallest listed size of the pipe's own product at or above `inches`, or null when the product doesn't come that large. */
function listedAtLeast(seg: RunSegment, inches: number): number | null {
  const spec = seg.size.shape === "pipe" ? specOfSize(seg.size) : null;
  if (!spec) return inches;
  return [...spec.sizes].map((s) => s.nominalIn).sort((a, b) => a - b).find((s) => s >= inches - 1e-9) ?? null;
}

/** The next listed size of the pipe's own product above `inches` (906.2's "one nominal pipe size"). */
function listedAbove(seg: RunSegment, inches: number): number | null {
  const spec = seg.size.shape === "pipe" ? specOfSize(seg.size) : null;
  const sizes = spec ? [...spec.sizes].map((s) => s.nominalIn).sort((a, b) => a - b) : [...TABLE_906_1_VENT_IN];
  return sizes.find((s) => s > inches + 1e-9) ?? null;
}

interface Tree {
  readonly root: Node;
  readonly order: readonly Node[];
  readonly parent: ReadonlyMap<Node, Node | null>;
  readonly children: ReadonlyMap<Node, readonly Node[]>;
}

function treeFrom(model: ModelState, nodes: ReadonlySet<Node>, root: Node, expand: (n: Node) => boolean, extra: (n: Node) => readonly Node[]): Tree {
  const parent = new Map<Node, Node | null>([[root, null]]);
  const children = new Map<Node, Node[]>();
  const order: Node[] = [];
  const queue: Node[] = [root];
  while (queue.length > 0) {
    const n = queue.shift();
    if (n === undefined) break;
    order.push(n);
    const kids: Node[] = [];
    if (expand(n)) {
      for (const m of [...runNeighbours(model.elements, n), ...extra(n)].sort()) {
        if (!nodes.has(m) || parent.has(m)) continue;
        parent.set(m, n);
        kids.push(m);
        queue.push(m);
      }
    }
    children.set(n, kids);
  }
  return { root, order, parent, children };
}

// ------------------------------------------------------------------ vent

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const dist3 = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function endPoint(model: ModelState, seg: RunSegment, end: "start" | "end"): Point {
  return { x: seg[end].x, y: seg[end].y, z: absZ(model, seg, seg[end].z) };
}

function nearestEnd(model: ModelState, seg: RunSegment, to: Point): Point {
  const a = endPoint(model, seg, "start");
  const b = endPoint(model, seg, "end");
  return dist3(a, to) <= dist3(b, to) ? a : b;
}

/** The open air end of a root vent pipe: its unlinked end, the higher if both are. */
function rootEndOf(model: ModelState, seg: RunSegment): Point {
  const a = endPoint(model, seg, "start");
  const b = endPoint(model, seg, "end");
  if (!seg.links.start && seg.links.end) return a;
  if (!seg.links.end && seg.links.start) return b;
  return a.z >= b.z ? a : b;
}

/** Where a walk node sits: a fitting's position, a part's insertion, a load point's host end. */
function pointOf(model: ModelState, n: Node): Point | null {
  const el = model.elements[n.includes("#") ? pipeNodeId(n) : n];
  const floor = (levelId: string) => {
    const level = model.elements[levelId];
    return level?.kind === "level" ? level.elevationMm : 0;
  };
  if (el?.kind === "run_fitting") return { x: el.position.x, y: el.position.y, z: floor(el.levelId) + el.position.z };
  if (el?.kind === "part") return { x: el.position.x, y: el.position.y, z: floor(el.levelId) + el.offsetMm };
  if (el?.kind === "load_point") {
    const at = runEndOf(el);
    const host = at ? model.elements[at.elementId] : undefined;
    if (at && host?.kind === "run_segment" && (at.port === "start" || at.port === "end")) return endPoint(model, host, at.port);
    return host ? pointOf(model, host.id) : null;
  }
  return null;
}

/** Where child `n` leaves pipe `seg`: its fitting or load point, else the end of the child nearest the pipe. */
function attachPoint(model: ModelState, seg: RunSegment, n: Node, entry: Point): Point {
  const p = pointOf(model, n);
  if (p) return p;
  const child = segOf(model, n);
  if (!child) return nearestEnd(model, seg, entry);
  const far = endPoint(model, seg, dist3(endPoint(model, seg, "start"), entry) <= dist3(endPoint(model, seg, "end"), entry) ? "end" : "start");
  const a = endPoint(model, child, "start");
  const b = endPoint(model, child, "end");
  // Joined end to end: the pipe's far end. A branch off its side: the child's end that lies on it.
  if (dist3(a, far) < 1 || dist3(b, far) < 1) return far;
  return Math.min(dist3(a, entry), dist3(a, far)) <= Math.min(dist3(b, entry), dist3(b, far)) ? a : b;
}

interface SanitaryView {
  readonly systemId: string;
  readonly walks: readonly PipeLoadWalk[];
  readonly sizing: PipeSystemSizing | null;
}

/** Where a vent connection drains: a sanitary walk node, the units it brings, and in which walk. */
interface Served {
  readonly dfu: number;
  readonly sanitary: { readonly view: SanitaryView; readonly walk: PipeLoadWalk; readonly node: Node } | null;
}

function sanitaryViews(model: ModelState, sanitarySizing: (systemId: string) => PipeSystemSizing | null): SanitaryView[] {
  const out: SanitaryView[] = [];
  for (const s of elementsOfKind(model.elements, "mep_system")) {
    if (s.systemKind !== "sanitary") continue;
    const design = mergePipeDesign(undefined, s.design?.pipe);
    const seen = new Set<string>();
    const walks: PipeLoadWalk[] = [];
    for (const seg of elementsOfKind(model.elements, "run_segment")) {
      if (seg.systemId !== s.id || seen.has(seg.id)) continue;
      const lw = pipeLoadWalk(model.elements, s, seg.id as ElementId, design, []);
      for (const id of lw.memberIds) seen.add(id);
      walks.push(lw);
    }
    if (walks.length > 0) out.push({ systemId: s.id, walks, sizing: sanitarySizing(s.id) });
  }
  return out;
}

function findSanitary(views: readonly SanitaryView[], match: (walk: PipeLoadWalk, n: Node) => boolean): Served["sanitary"] {
  for (const view of views) for (const walk of view.walks) for (const n of walk.walk.order) if (match(walk, n)) return { view, walk, node: n };
  return null;
}

/** The sanitary pipe where every served connection's drain comes together, its size (as the sizing requires it, else drawn) and role. */
function drainServed(model: ModelState, served: readonly Served[]): { readonly segment: RunSegment; readonly inches: number; readonly role: PipeSizingRole | null } | null {
  const withDrain = served.map((s) => s.sanitary).filter((s): s is NonNullable<Served["sanitary"]> => s !== null);
  const first = withDrain[0];
  if (!first) return null;
  // Different drainage systems or walks: the largest drain any of them reaches is what is served.
  const sameWalk = withDrain.every((s) => s.walk === first.walk);
  const ancestors = (walk: PipeLoadWalk, n: Node): Node[] => {
    const out: Node[] = [];
    for (let a: Node | null | undefined = n; a !== null && a !== undefined; a = walk.walk.parent.get(a)) out.push(a);
    return out;
  };
  let meet: Node | null = null;
  if (sameWalk) {
    const lists = withDrain.map((s) => ancestors(first.walk, s.node));
    const others = lists.slice(1).map((l) => new Set(l));
    meet = (lists[0] ?? []).find((a) => others.every((o) => o.has(a))) ?? null;
  }
  const pick = (view: SanitaryView, walk: PipeLoadWalk, from: Node) => {
    for (const a of ancestors(walk, from)) {
      const seg = segOf(model, a);
      if (!seg) continue;
      const p = view.sizing?.proposals.find((x) => x.segmentId === seg.id);
      return { segment: seg, inches: p?.proposedIn ?? nominalInOf(seg.size), role: p?.role ?? null };
    }
    return null;
  };
  if (meet !== null) return pick(first.view, first.walk, meet);
  let best: ReturnType<typeof pick> = null;
  for (const s of withDrain) {
    const d = pick(s.view, s.walk, s.node);
    if (d && (!best || d.inches > best.inches)) best = d;
  }
  return best;
}

function ventByTable(stackIn: number, dfu: number, developedFt: number): { readonly inches: number; readonly row: { readonly stackIn: number; readonly dfu: number } } | { readonly reason: string } {
  const stackRow = TABLE_906_1.map((r) => r.stackIn).find((s) => s >= stackIn - 1e-9);
  if (stackRow === undefined) return { reason: `a ${nominalLabel(stackIn)}" stack is beyond Table 906.1` };
  const row = TABLE_906_1.find((r) => r.stackIn === stackRow && r.dfu >= dfu - 1e-9);
  if (!row) return { reason: `${round(dfu, 2)} DFU on a ${nominalLabel(stackRow)}" stack is beyond Table 906.1` };
  const i = row.maxFt.findIndex((ft) => ft !== null && ft >= developedFt - 1e-9);
  const inches = i >= 0 ? TABLE_906_1_VENT_IN[i] : undefined;
  if (inches === undefined) return { reason: `no vent in Table 906.1 reaches ${round(developedFt, 1)} ft for ${row.dfu} DFU on a ${nominalLabel(row.stackIn)}" stack` };
  return { inches, row };
}

export function sizeVentSystem(model: ModelState, system: MepSystem, ipc: IpcEdition, mode: Mode, sanitarySizing: (systemId: string) => PipeSystemSizing | null): SizingOutcome {
  const findings: PipeSizingFinding[] = [];
  const steps: CalcStep[] = [];
  const cites: Citation[] = [ipcCite(ipc, "vent_stack"), ipcCite(ipc, "vent_branch"), ipcCite(ipc, "vent_length"), ipcCite(ipc, "branch_stack")];
  const proposals: PipeSizeProposal[] = [];
  const members = new Set<string>();
  for (const el of elementsOfKind(model.elements, "run_segment", "run_fitting")) if (el.systemId === system.id) members.add(el.id);
  const pointsOn = new Map<string, Set<string>>();
  const pointIdsOn = new Map<string, string[]>();
  for (const lp of elementsOfKind(model.elements, "load_point")) {
    const end = runEndOf(lp);
    if (!end || !members.has(end.elementId)) continue;
    const at = pointsOn.get(end.elementId) ?? new Set<string>();
    at.add(end.port);
    pointsOn.set(end.elementId, at);
    pushTo(pointIdsOn, end.elementId, lp.id);
  }
  const views = sanitaryViews(model, sanitarySizing);
  const inSystem = (n: Node) => members.has(n);
  // A node is walked into when it is this vent's piping, a fixture's vent end, or a load point on the vent; another system's pipe is a vent connection to it.
  const walkable = (n: Node): boolean => {
    if (members.has(n)) return true;
    if (n.includes("#")) return model.elements[pipeNodeId(n)]?.kind === "part";
    const el = model.elements[n];
    if (el?.kind === "load_point") {
      const end = runEndOf(el);
      return end !== null && members.has(end.elementId);
    }
    return el?.kind === "run_segment" || el?.kind === "run_fitting";
  };
  const covered = new Set<Node>();
  let totalVented = 0;
  let longest = 0;
  let noTerminal = false;
  let anyStack = false;
  for (const start of [...members].sort()) {
    if (covered.has(start)) continue;
    // The connected piece, stopping at other systems' pipes and at fixtures.
    const nodes = new Set<Node>([start]);
    const stack: Node[] = [start];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined) break;
      if (!inSystem(n)) continue;
      for (const m of runNeighbours(model.elements, n)) {
        if (nodes.has(m) || !walkable(m)) continue;
        nodes.add(m);
        stack.push(m);
      }
      for (const id of pointIdsOn.get(n) ?? []) nodes.add(id);
    }
    for (const n of nodes) covered.add(n);
    // The open air: the highest open pipe end (no link, no load point), or a terminal fitting with no drain connection (a vent through the roof).
    let root: { node: Node; z: number } | null = null;
    for (const n of nodes) {
      const seg = segOf(model, n);
      if (seg && seg.systemId === system.id) {
        for (const end of ["start", "end"] as const) {
          if (seg.links[end] || pointsOn.get(seg.id)?.has(end)) continue;
          const z = absZ(model, seg, seg[end].z);
          if (!root || z > root.z + 0.5) root = { node: n, z };
        }
      } else if (n.includes("#")) {
        const part = model.elements[pipeNodeId(n)];
        const type = part?.kind === "part" ? model.elements[part.typeId] : undefined;
        const drains = type?.kind === "part_type" && type.definition.connectors.some((c) => c.systemKind === "sanitary" || c.systemKind === "storm");
        if (part?.kind === "part" && !drains) {
          const level = model.elements[part.levelId];
          const z = (level?.kind === "level" ? level.elevationMm : 0) + (part.offsetMm ?? 0);
          if (!root || z > root.z + 0.5) root = { node: n, z };
        }
      }
    }
    if (!root) {
      noTerminal = true;
      const highest = [...nodes].map((n) => segOf(model, n)).filter((s): s is RunSegment => s !== null && s.systemId === system.id).sort((a, b) => Math.max(absZ(model, b, b.start.z), absZ(model, b, b.end.z)) - Math.max(absZ(model, a, a.start.z), absZ(model, a, a.end.z)))[0];
      if (!highest) continue;
      root = { node: highest.id, z: 0 };
    }
    const rootNode = root.node;
    const tree = treeFrom(model, nodes, rootNode, (n) => inSystem(n) || n === rootNode, (n) => pointIdsOn.get(n) ?? []);
    // What each connection beyond the vent brings.
    const served = new Map<Node, Served>();
    for (const n of tree.order) {
      if (n === tree.root || inSystem(n)) continue;
      const el = model.elements[n];
      if (el?.kind === "load_point") {
        const dfu = loadPointTotals(model.elements, el).dfu;
        const mark = el.mark ?? null;
        const sanitary = mark
          ? findSanitary(views, (_w, s) => {
              const other = model.elements[s];
              return other?.kind === "load_point" && other.id !== el.id && other.mark === mark;
            })
          : null;
        served.set(n, { dfu, sanitary });
      } else if (n.includes("#")) {
        const partId = pipeNodeId(n);
        const sanitary = findSanitary(views, (_w, s) => s.includes("#") && pipeNodeId(s) === partId);
        served.set(n, { dfu: sanitary ? (sanitary.walk.own.get(sanitary.node) ?? 0) : 0, sanitary });
      } else if (el?.kind === "run_segment" || el?.kind === "run_fitting") {
        const sanitary = findSanitary(views, (_w, s) => s === n);
        served.set(n, { dfu: sanitary ? (sanitary.walk.load.get(sanitary.node) ?? 0) : 0, sanitary });
      }
    }
    // Developed length from the open air to where the walk enters each node (a branch counts from where it leaves its pipe, not the pipe's far end).
    const at = new Map<Node, Point>();
    const d0 = new Map<Node, number>();
    for (const n of tree.order) {
      const p = tree.parent.get(n);
      if (p === null || p === undefined) {
        const seg = segOf(model, n);
        at.set(n, seg ? rootEndOf(model, seg) : (pointOf(model, n) ?? { x: 0, y: 0, z: 0 }));
        d0.set(n, 0);
        continue;
      }
      const from = at.get(p) ?? { x: 0, y: 0, z: 0 };
      const pSeg = segOf(model, p);
      const attach = pSeg ? attachPoint(model, pSeg, n, from) : from;
      d0.set(n, (d0.get(p) ?? 0) + (pSeg ? dist3(from, attach) / MM_PER_FT : 0));
      const seg = segOf(model, n);
      at.set(n, seg ? nearestEnd(model, seg, attach) : attach);
    }
    const farEnd = (n: Node) => (d0.get(n) ?? 0) + (segOf(model, n)?.systemId === system.id ? lengthFt(segOf(model, n) as RunSegment) : 0);
    const beyond = new Map<Node, { readonly served: Served[]; readonly farFt: number }>();
    for (let i = tree.order.length - 1; i >= 0; i--) {
      const n = tree.order[i];
      if (n === undefined) continue;
      const own = served.get(n);
      const list: Served[] = own ? [own] : [];
      let far = own ? (d0.get(n) ?? 0) : 0;
      for (const k of tree.children.get(n) ?? []) {
        const b = beyond.get(k);
        if (!b) continue;
        list.push(...b.served);
        far = Math.max(far, b.farFt);
      }
      beyond.set(n, { served: list, farFt: far });
    }
    const rootBeyond = beyond.get(tree.root);
    totalVented += (rootBeyond?.served ?? []).reduce((sum, s) => sum + s.dfu, 0);
    longest = Math.max(longest, rootBeyond?.farFt ?? 0);
    // Stack vents and vent stacks: vertical vents serving a stack. Their developed length runs to the open air (906.1 note a); every other vent's runs to the vent stack or stack vent it joins (906.3).
    const drainOf = new Map<Node, ReturnType<typeof drainServed>>();
    const isStackVent = new Set<Node>();
    for (const n of tree.order) {
      const seg = segOf(model, n);
      const b = beyond.get(n);
      if (!seg || seg.systemId !== system.id || !b || b.served.length === 0) continue;
      const drain = drainServed(model, b.served);
      drainOf.set(n, drain);
      if (vertical(seg) && drain?.role === "stack") isStackVent.add(n);
    }
    const joinsAt = new Map<Node, number>();
    for (const n of tree.order) {
      const p = tree.parent.get(n);
      joinsAt.set(n, p === null || p === undefined ? 0 : isStackVent.has(p) && !isStackVent.has(n) ? (d0.get(n) ?? 0) : (joinsAt.get(p) ?? 0));
    }
    for (const n of tree.order) {
      const seg = segOf(model, n);
      if (!seg || seg.systemId !== system.id) continue;
      const b = beyond.get(n);
      if (!b || b.served.length === 0) continue;
      const dfu = b.served.reduce((sum, s) => sum + s.dfu, 0);
      const stackVent = isStackVent.has(n);
      const developed = Math.max(b.farFt, farEnd(n)) - (stackVent ? 0 : (joinsAt.get(n) ?? 0));
      const drain = drainOf.get(n) ?? null;
      const label = labelOf(model, seg);
      const carries = `${round(dfu, 2)} DFU vented, ${round(developed, 1)} ft developed length${drain ? `, serving the ${nominalLabel(drain.inches)}" ${drain.role === "stack" ? "stack" : "drain"}` : ""}`;
      let inches: number;
      let governs: string;
      let role: PipeSizingRole;
      if (stackVent && drain) {
        anyStack = true;
        role = "vent_stack";
        const t = ventByTable(drain.inches, dfu, developed);
        if ("reason" in t) {
          findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `The ${label}: ${t.reason}` });
          continue;
        }
        inches = Math.max(t.inches, drain.inches / 2, VENT_MIN_IN);
        governs = inches > t.inches + 1e-9 ? `906.1: half the ${nominalLabel(drain.inches)}" stack, 1-1/4" least` : `Table 906.1 (${nominalLabel(t.row.stackIn)}" stack, ${t.row.dfu} DFU row)`;
      } else {
        role = "branch_vent";
        const required = TABLE_710_1_2.find((r) => r.branch >= dfu - 1e-9)?.nominalIn ?? null;
        if (required === null) {
          findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `The ${label}: ${round(dfu, 2)} DFU is beyond Table 710.1(2), so 906.2 has no drain to halve` });
          continue;
        }
        const half = Math.max(required / 2, VENT_MIN_IN);
        governs = half > required / 2 + 1e-9 ? '906.2: 1-1/4" least' : `906.2: half the ${nominalLabel(required)}" drain Table 710.1(2) requires`;
        inches = half;
        if (developed > VENT_UPSIZE_OVER_FT) {
          const base = listedAtLeast(seg, half) ?? half;
          const up = listedAbove(seg, base);
          if (up === null) {
            findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `The ${label} is over ${VENT_UPSIZE_OVER_FT} ft and its product has no size above ${nominalLabel(base)}"` });
            continue;
          }
          inches = up;
          governs = `${governs}, one size up over ${VENT_UPSIZE_OVER_FT} ft developed length`;
        }
      }
      const listed = listedAtLeast(seg, inches);
      if (listed === null) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `The ${label}'s product doesn't come as large as ${nominalLabel(inches)}"` });
        continue;
      }
      proposals.push(proposalOf(seg, label, role, listed, carries, governs));
    }
    for (const [n, s] of served) {
      if (s.sanitary === null && s.dfu > 0) findings.push({ code: "walk", severity: "warning", elementId: n.includes("#") ? pipeNodeId(n) : n, message: `${labelFor(model, n)} vents a fixture whose drain isn't in a sanitary system, so the drain it serves is unknown; vents there are sized on 906.2 alone` });
    }
  }
  if (noTerminal) findings.push({ code: "no_vent_terminal", severity: "warning", elementId: system.id, message: `${system.name} has a piece with no open end to the air (a vent through the roof); its developed length is counted from its highest pipe. Run it through the roof or to a vent stack.` });
  steps.push({ label: "Vented", detail: `${round(totalVented, 2)} DFU; longest developed length ${round(longest, 1)} ft (from the farthest vent connection to the open air, 906.3)`, cite: [ipcCite(ipc, "vent_length")] });
  if (anyStack) steps.push({ label: "Stack vents and vent stacks", detail: "Table 906.1 by the stack's size, the units vented and the developed length; at least half the stack and 1-1/4 in.", cite: [ipcCite(ipc, "vent_stack")] });
  steps.push({ label: "Other vents", detail: `Half the drain Table 710.1(2) requires for the units vented, 1-1/4 in. at least, one size up over ${VENT_UPSIZE_OVER_FT} ft`, cite: [ipcCite(ipc, "vent_branch"), ipcCite(ipc, "branch_stack")] });
  changeFindings(proposals, findings);
  return {
    ok: true,
    sizing: { systemId: system.id, systemName: system.name, systemKind: system.systemKind, service: "vent", sizingMode: mode.mode, sizingModeFrom: mode.from, curve: null, designPoint: null, availablePsi: null, allowablePsiPer100Ft: null, maxVelocityFps: null, developedLengthFt: longest > 0 ? round(longest, 1) : null, totalLoad: round(totalVented, 2), proposals: proposals.sort((a, b) => a.segmentId.localeCompare(b.segmentId)), findings },
    steps,
    cites,
  };
}

function labelFor(model: ModelState, n: Node): string {
  const el = model.elements[n.includes("#") ? pipeNodeId(n) : n];
  if (el?.kind === "load_point") return `Vent point ${el.mark ?? el.connectionType ?? el.id}`;
  return el ? `${el.kind === "part" ? "Fixture" : "Pipe"} ${el.id}` : n;
}

// ------------------------------------------------------------------ storm

/** A drain's roof area: what the point or part says, else its flow back to area at the design rate. */
function ownRoofArea(model: ModelState, lw: PipeLoadWalk, n: Node, rate: number): number {
  const el = model.elements[n.includes("#") ? pipeNodeId(n) : n];
  if (el?.kind === "load_point") {
    const custom = loadPointQuantities(model.elements, el).custom ?? [];
    const area = custom.find((c) => /roof\s*area|drain(ed|age)?\s*area/i.test(c.name));
    if (area && Number.isFinite(area.value)) return area.value;
  } else if (el?.kind === "part" && n.includes("#")) {
    const type = model.elements[el.typeId];
    for (const k of ROOF_AREA_KEYS) {
      const v = el.values?.[k] ?? (type?.kind === "part_type" ? type.definition.typeValues[k] : undefined);
      if (typeof v === "number" && v > 0) return v;
    }
  }
  const gpm = lw.own.get(n) ?? 0;
  return gpm > 0 ? (gpm * SQFT_PER_GPM_AT_1_IN_PER_HR) / rate : 0;
}

export function sizeStormSystem(model: ModelState, system: MepSystem, ipc: IpcEdition, mode: Mode): SizingOutcome {
  const findings: PipeSizingFinding[] = [];
  const steps: CalcStep[] = [];
  const cites: Citation[] = [ipcCite(ipc, "rainfall"), ipcCite(ipc, "storm_leader"), ipcCite(ipc, "storm_drain")];
  const base = { systemId: system.id, systemName: system.name, systemKind: system.systemKind, service: "storm" as const, sizingMode: mode.mode, sizingModeFrom: mode.from, curve: null, designPoint: null, availablePsi: null, allowablePsiPer100Ft: null, maxVelocityFps: null, developedLengthFt: null };
  const rate = system.design?.pipe?.rainfallInPerHr;
  if (rate === undefined) {
    findings.push({ code: "no_rainfall_rate", severity: "error", elementId: system.id, message: `${NOT_IN_LIBRARY.rainfall}, so storm pipe isn't sized by a guessed rate. Set ${system.name}'s design rainfall (100-year, 1-hour, in/h) from approved local weather data (1106.1).` });
    return { ok: true, sizing: { ...base, totalLoad: 0, proposals: [], findings }, steps, cites };
  }
  const leaderCol = Math.ceil(rate - 1e-9);
  const drainCol = leaderCol;
  steps.push({ label: "Rainfall rate", detail: `${rate} in/h (${system.name}'s design rate), read in the ${leaderCol} in/h column${leaderCol > rate + 1e-9 ? " (the next whole inch per hour, conservative)" : ""}`, cite: [ipcCite(ipc, "rainfall")] });
  const design = mergePipeDesign(undefined, system.design?.pipe);
  const proposals: PipeSizeProposal[] = [];
  const seen = new Set<string>();
  let total = 0;
  let flatNoted = false;
  for (const seg0 of elementsOfKind(model.elements, "run_segment")) {
    if (seg0.systemId !== system.id || seg0.size.shape !== "pipe" || seen.has(seg0.id)) continue;
    const warnings: PipeWarning[] = [];
    const lw = pipeLoadWalk(model.elements, system, seg0.id as ElementId, design, warnings);
    for (const id of lw.memberIds) seen.add(id);
    for (const w of warnings) findings.push({ code: "walk", severity: "warning", elementId: w.elementId, message: w.message.replace(/has no fixed flow; set it/, "has no roof area or flow; give it a custom quantity \"Roof area\" (sq ft) or a flow") });
    const order = lw.walk.order;
    const kids = (n: Node) => lw.walk.children.get(n) ?? [];
    const area = new Map<Node, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n === undefined) continue;
      area.set(n, ownRoofArea(model, lw, n, rate) + kids(n).reduce((sum, k) => sum + (area.get(k) ?? 0), 0));
    }
    total = Math.max(total, area.get(lw.root) ?? 0, ...order.map((n) => area.get(n) ?? 0));
    const required = new Map<Node, { inches: number; role: PipeSizingRole; carries: string; governs: string }>();
    for (const n of order) {
      const seg = segOf(model, n);
      if (!seg) continue;
      const sqft = area.get(n) ?? 0;
      if (sqft <= 0) continue;
      const label = labelOf(model, seg);
      if (vertical(seg)) {
        if (leaderCol > 12) {
          findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${rate} in/h is beyond Table 1106.2(1)'s 12 in/h (the ${label})` });
          continue;
        }
        const row = TABLE_1106_2_1.find((r) => (r.maxSqFt[leaderCol - 1] ?? 0) >= sqft - 1e-9);
        if (!row) {
          findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${round(sqft, 0)} sq ft at ${rate} in/h is beyond Table 1106.2(1) (the ${label}); split it between leaders` });
          continue;
        }
        required.set(n, { inches: row.nominalIn, role: "storm_leader", carries: `${round(sqft, 0)} sq ft of roof at ${rate} in/h`, governs: `Table 1106.2(1), leader` });
        continue;
      }
      const slope = slopeInPerFt(seg);
      if (slope <= 0) findings.push({ code: "level_drain", severity: "error", elementId: seg.id, message: `The ${label} is level; a storm drain needs fall (1/8 in/ft least, 1106.3). Sized at 1/8 in/ft for now.` });
      else if (slope < STORM_MIN_SLOPE_IN_PER_FT - 1e-9 && !flatNoted) {
        flatNoted = true;
        findings.push({ code: "storm_slope", severity: "warning", elementId: seg.id, message: `The ${label} falls ${round(slope, 3)} in/ft, under 1106.3's 1/8 in/ft least; sized at 1/8 in/ft. Steepen it or get it approved.` });
      }
      if (drainCol > 6) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${rate} in/h is beyond Table 1106.3's 6 in/h (the ${label})` });
        continue;
      }
      const s = TABLE_1106_3_SLOPES.map((v, i) => [v, i] as const).filter(([v]) => v <= Math.max(slope, STORM_MIN_SLOPE_IN_PER_FT) + 1e-9).pop() ?? ([TABLE_1106_3_SLOPES[0], 0] as const);
      const row = TABLE_1106_3.find((r) => (r.maxSqFt[s[1]]?.[drainCol - 1] ?? 0) >= sqft - 1e-9);
      if (!row) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `${round(sqft, 0)} sq ft at ${rate} in/h is beyond Table 1106.3 at ${s[0]} in/ft (the ${label})` });
        continue;
      }
      required.set(n, { inches: row.nominalIn, role: "storm_drain", carries: `${round(sqft, 0)} sq ft of roof at ${rate} in/h, ${round(slope, 3)} in/ft`, governs: `Table 1106.3 at ${s[0]} in/ft` });
    }
    // Never smaller than a pipe draining into it.
    const finalIn = new Map<Node, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n === undefined) continue;
      const fromKids = Math.max(0, ...kids(n).map((k) => finalIn.get(k) ?? 0));
      const own = required.get(n);
      finalIn.set(n, own ? Math.max(own.inches, fromKids) : fromKids);
    }
    for (const [n, own] of required) {
      const seg = segOf(model, n);
      if (!seg) continue;
      const inches = finalIn.get(n) ?? own.inches;
      const listed = listedAtLeast(seg, inches);
      if (listed === null) {
        findings.push({ code: "no_size_fits", severity: "error", elementId: seg.id, message: `The ${labelOf(model, seg)}'s product doesn't come as large as ${nominalLabel(inches)}"` });
        continue;
      }
      proposals.push(proposalOf(seg, labelOf(model, seg), own.role, listed, own.carries, inches > own.inches + 1e-9 ? "a larger pipe drains into it" : own.governs));
    }
  }
  cites.push(methodCite("Roof drain flow to area", `sq ft = gpm x ${SQFT_PER_GPM_AT_1_IN_PER_HR} / rainfall in/h, for a drain that gives its flow instead of its area`, "IPC Appendix B, 0.0104 gpm per sq ft per in/h"));
  steps.push({ label: "Roof area", detail: `${round(total, 0)} sq ft at the outfall; leaders by Table 1106.2(1), horizontal drains by Table 1106.3 at their fall, never smaller downstream`, cite: [ipcCite(ipc, "storm_leader"), ipcCite(ipc, "storm_drain")] });
  changeFindings(proposals, findings);
  return { ok: true, sizing: { ...base, totalLoad: round(total, 0), rainfallInPerHr: rate, proposals: proposals.sort((a, b) => a.segmentId.localeCompare(b.segmentId)), findings }, steps, cites };
}

/** Appends to the list under `key` (copying the list per add is quadratic in its size). */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
