import { defineExtensionPoint } from "../packs/contract";
import type { PackRefusal } from "../packs/points";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { partNode, runNeighbours, type RunGraphNode } from "../routing/derive";
import type { BimElement, ElementId, ModelState } from "../types";

/**
 * Gravity outfalls (contract 1.11.0, `kernel.gravity_outfall` v1).
 *
 * A node a gravity walk ends at: a manhole on the public main, a storm
 * structure, a civil catchment's outfall. A row reads one record's invert, rim and
 * whether it can back up. The walk never guesses a missing invert; it says
 * what to add.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface GravityOutfall {
  readonly elementId: ElementId;
  readonly label: string;
  /** mm above project zero; null when not set (the walk says so). */
  readonly invertMm: number | null;
  readonly rimMm: number | null;
  /** The outfall can back up into the building (a backwater valve is asked for below the rim). */
  readonly backwater: boolean;
}

export interface GravityOutfallRow {
  /** `<pack>.<name>`; a first-party row keeps its bare id. */
  readonly id: string;
  readonly label: string;
  /** The stored kinds whose records it reads (`part`, `zz.structure`). */
  readonly kinds: readonly string[];
  /** One record as an outfall, or null when it isn't one. */
  read(el: BimElement, elements: Elements): GravityOutfall | null;
}

export const GRAVITY_OUTFALL_POINT = defineExtensionPoint<GravityOutfallRow>({
  id: "kernel.gravity_outfall",
  version: 1,
  label: "Gravity outfalls",
  idOf: (row) => row.id,
});

/** Problems with gravity outfall rows (pack conformance), in words. */
export function gravityOutfallRowProblems(rows: readonly GravityOutfallRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`gravity outfall ${row.id} has no label`);
    if (row.kinds.length === 0) out.push(`gravity outfall ${row.id} names no kind`);
    if (typeof row.read !== "function") out.push(`gravity outfall ${row.id}: read must be a function`);
  }
  return out;
}

const byKindOf = (set: PackSet): ReadonlyMap<string, readonly GravityOutfallRow[]> => {
  const map = new Map<string, GravityOutfallRow[]>();
  for (const row of set.items(GRAVITY_OUTFALL_POINT)) for (const k of row.kinds) map.set(k, [...(map.get(k) ?? []), row]);
  return map;
};

/** One record as an outfall in the set in force (first row that reads it), or null. */
export function outfallOf(el: BimElement, elements: Elements): GravityOutfall | null {
  for (const row of activePackSet().memo("kernel.gravity_outfall#byKind", byKindOf).get(el.kind) ?? []) {
    const o = row.read(el, elements);
    if (o) return o;
  }
  return null;
}

export interface OutfallWalk {
  readonly outfall: GravityOutfall;
  /** Every record from the start to the outfall, in walk order (the start first, the outfall last). */
  readonly path: readonly ElementId[];
}

/** The first record the walk can start from: a part's connected connectors, else the record itself. */
function startNodes(from: BimElement): RunGraphNode[] {
  if (from.kind !== "part") return [from.id];
  const linked = Object.keys(from.links ?? {});
  return linked.length > 0 ? linked.map((c) => partNode(from.id, c)) : [];
}

const elementIdOf = (node: RunGraphNode): ElementId => {
  const hash = node.indexOf("#");
  return (hash >= 0 ? node.slice(0, hash) : node) as ElementId;
};

/**
 * A walk from one record (a part, a run, a load) along what is drawn
 * connected to it, to the nearest record an outfall row reads (fewest
 * connections; the connection index, never a model scan). Refuses in words
 * when nothing drawn reaches one, naming what to draw.
 */
export function walkToOutfall(model: ModelState, fromId: ElementId): OutfallWalk | PackRefusal {
  const elements = model.elements;
  const from = elements[fromId];
  if (!from) return { refused: `${fromId} isn't in this model` };
  const here = outfallOf(from, elements);
  if (here) return { outfall: here, path: [fromId] };
  const starts = startNodes(from);
  if (starts.length === 0) return { refused: `${fromId} isn't connected to anything drawn yet: connect it, then draw the line on to where it leaves the building` };
  const cameFrom = new Map<RunGraphNode, RunGraphNode | null>(starts.map((s) => [s, null]));
  const queue: RunGraphNode[] = [...starts];
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i] as RunGraphNode;
    for (const next of runNeighbours(elements, node)) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, node);
      const el = elements[elementIdOf(next)];
      const outfall = el ? outfallOf(el, elements) : null;
      if (outfall) {
        const path: ElementId[] = [];
        for (let at: RunGraphNode | null = next; at !== null; at = cameFrom.get(at) ?? null) {
          const id = elementIdOf(at);
          if (path[path.length - 1] !== id) path.push(id);
        }
        if (path[path.length - 1] !== fromId) path.push(fromId);
        return { outfall, path: path.reverse() };
      }
      queue.push(next);
    }
  }
  return { refused: `Nothing drawn connects ${fromId} to where it leaves the building: draw the line on to an outfall (a connection to the public main, a structure or a receptor)` };
}
