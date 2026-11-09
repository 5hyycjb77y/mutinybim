// Frozen copy of the map-based NetworkIndex (as of commit 4b794635c), before the index moved to slot arrays.
// Equivalence reference for __tests__/network-index-equivalence.test.ts only; never imported by src.
import { elementOrder, elementValues } from "../../src/store";
import type { BimElement, Connection, ConnectorEnd, ElementId } from "../../src/types";

/** Round 9's fixed table (frozen here when round 10 lane K10 moved connector ends onto the add-ons' kind rows). */
const DOWNSTREAM_ENDS: Readonly<Record<string, readonly ConnectorEnd[]>> = { equipment: ["out"], duct_segment: ["end"], tap: ["branch"], elbow: ["out"], terminal: [] };
const NETWORK_KINDS: ReadonlySet<string> = new Set(["equipment", "duct_segment", "tap", "elbow", "terminal"]);
function isNetworkElement(el: BimElement): boolean {
  return NETWORK_KINDS.has(el.kind);
}

/** Elements whose own position or value depends on another element: hosted openings, tags, dimensions. */
function referencesOf(el: BimElement): readonly ElementId[] {
  switch (el.kind) {
    case "opening":
      return [el.hostId];
    case "tag":
      return [el.targetId];
    case "dimension":
      return [el.aId, el.bId];
    default:
      return NO_IDS;
  }
}

const NO_IDS: readonly ElementId[] = [];
const NO_CONNECTIONS: readonly Connection[] = [];
/**
 * Topology of one model: who connects to whom. Depends only on the element
 * set, element kinds, tap hosts and the connection list, none of which a
 * command changes, so one index serves every revision of a model.
 */
export class NetworkIndex {
  /** Position of each element id in the record's key order (iteration order). */
  readonly order: ReadonlyMap<string, number>;
  readonly connectionIndex = new Map<Connection, number>();
  private readonly byElement = new Map<string, Connection[]>();
  private readonly taps = new Map<string, ElementId[]>();
  private readonly kids = new Map<string, readonly ElementId[]>();
  private readonly parents = new Map<string, ElementId>();
  private readonly referencedBy = new Map<string, ElementId[]>();
  private readonly risers = new Map<string, ElementId[]>();
  /** False when some element has two parents or the graph has a cycle. */
  readonly isTree: boolean;
  private rank: Map<ElementId, number> | null = null;
  /** Per-equipment-tree post order, built on first use of that tree. */
  private readonly treeRank = new Map<ElementId, Map<ElementId, number>>();
  /** Equipment in element order, and whether any equipment sits under another (then only the global walk is exact). */
  private equipmentOrder: Map<ElementId, number> | null = null;
  private nestedEquipment = false;
  private unreached: readonly ElementId[] | null = null;

  constructor(
    readonly connections: readonly Connection[],
    private readonly elements: Readonly<Record<string, BimElement>>,
  ) {
    connections.forEach((c, i) => {
      this.connectionIndex.set(c, i);
      this.listFor(this.byElement, c.a.elementId).push(c);
      if (c.b.elementId !== c.a.elementId) this.listFor(this.byElement, c.b.elementId).push(c);
    });
    this.order = elementOrder(elements);
    const all = elementValues(elements);
    for (const el of all) {
      if (el.kind === "tap") this.listFor(this.taps, el.hostId).push(el.id);
      for (const ref of referencesOf(el)) this.listFor(this.referencedBy, ref).push(el.id);
      if (el.kind === "riser_segment") this.listFor(this.risers, el.riserId).push(el.id);
    }
    let tree = true;
    for (const el of all) {
      const ends = DOWNSTREAM_ENDS[el.kind] ?? [];
      if (ends.length === 0 && el.kind !== "duct_segment") continue;
      const out: ElementId[] = [];
      for (const end of ends) {
        const c = this.connectionAt(el.id, end);
        if (c) out.push(c.a.elementId === el.id && c.a.end === end ? c.b.elementId : c.a.elementId);
      }
      if (el.kind === "duct_segment") out.push(...this.hostedTaps(el.id));
      if (out.length === 0) continue;
      this.kids.set(el.id, out);
      for (const child of out) {
        if (this.parents.has(child) || child === el.id) tree = false;
        this.parents.set(child, el.id);
      }
    }
    this.isTree = tree && !this.hasCycle();
  }

  /** The first connection (in connection order) at this connector end. */
  connectionAt(id: string, end: ConnectorEnd): Connection | undefined {
    for (const c of this.byElement.get(id) ?? NO_CONNECTIONS) {
      if ((c.a.elementId === id && c.a.end === end) || (c.b.elementId === id && c.b.end === end)) return c;
    }
    return undefined;
  }

  connectionsOf(id: string): readonly Connection[] {
    return this.byElement.get(id) ?? NO_CONNECTIONS;
  }

  /** Taps hosted on a segment, in element order. */
  hostedTaps(hostId: string): readonly ElementId[] {
    return this.taps.get(hostId) ?? NO_IDS;
  }

  /** Openings hosted on, and tags / dimensions pointing at, an element, in element order. */
  dependents(id: string): readonly ElementId[] {
    return this.referencedBy.get(id) ?? NO_IDS;
  }

  /** Every level's piece of one riser, in element order. */
  riserSegments(riserId: string): readonly ElementId[] {
    return this.risers.get(riserId) ?? NO_IDS;
  }

  /** Downstream neighbours in the order the airflow walk visits them. */
  children(id: string): readonly ElementId[] {
    return this.kids.get(id) ?? NO_IDS;
  }

  parent(id: string): ElementId | undefined {
    return this.parents.get(id);
  }

  /**
   * Post-order position of each element in the airflow walk (equipment roots
   * in element order, then anything not reached). Derived-change lists are
   * ordered by this so they match a full recompute exactly.
   */
  airflowRank(id: ElementId): number {
    if (!this.rank) this.rank = this.computeRank();
    return this.rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * Orders ids exactly as `airflowRank` would, but only walks the equipment
   * trees the ids belong to. Falls back to the global walk whenever an id is
   * not under an equipment root or equipment is nested under equipment.
   */
  sortByAirflow(ids: Iterable<ElementId>): ElementId[] {
    const list = [...ids];
    if (!this.equipmentOrder) {
      const order = new Map<ElementId, number>();
      for (const el of elementValues(this.elements)) if (el.kind === "equipment" && !order.has(el.id)) order.set(el.id, order.size);
      this.equipmentOrder = order;
      this.nestedEquipment = [...order.keys()].some((eq) => this.parents.has(eq));
    }
    const equipment = this.equipmentOrder;
    const keyed: Array<{ id: ElementId; tree: number; pos: number }> = [];
    for (const id of list) {
      const root = this.rootOf(id);
      const tree = root === undefined ? undefined : equipment.get(root);
      if (this.nestedEquipment || root === undefined || tree === undefined) {
        return list.sort((a, b) => this.airflowRank(a) - this.airflowRank(b));
      }
      keyed.push({ id, tree, pos: this.postOrderIn(root).get(id) ?? Number.MAX_SAFE_INTEGER });
    }
    return keyed.sort((a, b) => a.tree - b.tree || a.pos - b.pos).map((k) => k.id);
  }

  private rootOf(id: ElementId): ElementId | undefined {
    let x: ElementId = id;
    for (let guard = 0; guard <= this.order.size; guard++) {
      const up = this.parents.get(x);
      if (up === undefined) return this.elements[x]?.kind === "equipment" ? x : undefined;
      x = up;
    }
    return undefined;
  }

  private postOrderIn(root: ElementId): Map<ElementId, number> {
    const cached = this.treeRank.get(root);
    if (cached) return cached;
    const rank = new Map<ElementId, number>();
    const seen = new Set<ElementId>([root]);
    const stack: Array<{ id: ElementId; next: number }> = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const kids = this.elements[top.id] ? this.children(top.id) : NO_IDS;
      const child = kids[top.next];
      if (child !== undefined) {
        top.next += 1;
        if (!seen.has(child)) {
          seen.add(child);
          stack.push({ id: child, next: 0 });
        }
        continue;
      }
      stack.pop();
      rank.set(top.id, rank.size);
    }
    this.treeRank.set(root, rank);
    return rank;
  }

  /** Network elements not reachable from any equipment, in element order. Walls, rooms and annotations are not part of a system. */
  disconnected(): readonly ElementId[] {
    if (!this.unreached) {
      const all = elementValues(this.elements);
      const reached = new Set<ElementId>();
      const stack: ElementId[] = [];
      for (const el of all) if (el.kind === "equipment") stack.push(el.id);
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || reached.has(id)) continue;
        reached.add(id);
        if (this.elements[id]) for (const child of this.children(id)) stack.push(child);
      }
      const unreached: ElementId[] = [];
      for (const el of all) if (isNetworkElement(el) && !reached.has(el.id)) unreached.push(el.id);
      this.unreached = unreached;
    }
    return this.unreached;
  }

  private listFor<T>(map: Map<string, T[]>, key: string): T[] {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    return list;
  }

  private hasCycle(): boolean {
    const state = new Map<string, 1 | 2>();
    // Every element on a cycle has a parent, so walks from roots can be skipped.
    for (const start of this.parents.keys()) {
      let x: string | undefined = start;
      const path: string[] = [];
      while (x !== undefined && state.get(x) === undefined) {
        state.set(x, 1);
        path.push(x);
        x = this.parents.get(x);
      }
      if (x !== undefined && state.get(x) === 1) return true;
      for (const p of path) state.set(p, 2);
    }
    return false;
  }

  private computeRank(): Map<ElementId, number> {
    const rank = new Map<ElementId, number>();
    const seen = new Set<ElementId>();
    const walk = (root: ElementId): void => {
      const stack: Array<{ id: ElementId; next: number }> = [{ id: root, next: 0 }];
      seen.add(root);
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top) break;
        const kids = this.elements[top.id] ? this.children(top.id) : NO_IDS;
        const child = kids[top.next];
        if (child !== undefined) {
          top.next += 1;
          if (!seen.has(child)) {
            seen.add(child);
            stack.push({ id: child, next: 0 });
          }
          continue;
        }
        stack.pop();
        rank.set(top.id, rank.size);
      }
    };
    const all = elementValues(this.elements);
    for (const el of all) if (el.kind === "equipment" && !seen.has(el.id)) walk(el.id);
    for (const el of all) if (!seen.has(el.id)) walk(el.id);
    return rank;
  }
}
