import type { Symbol2D, SymbolPrim } from "../annotation/detailing";
import { isRegistryIdShape } from "../ids";
import { defineExtensionPoint } from "../packs/contract";
import type { FirstPartyPackId } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { firstPartyBaseRevision, firstPartyOwnerOf, packSetReadsRecorded, type PackSet } from "../packs/set";
import type { Dim } from "../part-dim";
import type { SymbolPrimitive } from "../parts";

/**
 * Symbols as data (round 5b E2). A symbol is a registry row: an id, its
 * lines in the plan-symbol vocabulary parts already use (`symbolSchema`,
 * millimetres from its insertion point), and where a conductor or pipe
 * attaches. A class names one by `symbolId`; a drafting view places one as a
 * detail component by the same id. Adding a symbol is adding a row.
 *
 * The built-in rows are the electrical one-line symbols. They keep their
 * drafting form (`drafting`: unit-box strokes with pens, fills and stroke
 * letters), so they print exactly as before; a row with no drafting form
 * drafts from its primitives.
 *
 * A registry is an immutable value. Built-ins are the default; a host passes
 * a firm's or a pack's rows with `withSymbolRegistry`, which is in force only
 * while a synchronous draw runs, so one firm's symbols never reach another
 * model drawn in the same process.
 */
export interface SymbolDef {
  readonly id: string;
  readonly label: string;
  readonly primitives: readonly SymbolPrimitive[];
  /** Where a conductor or pipe attaches, mm from the insertion point. */
  readonly connectionPoint: readonly [number, number];
  /** The exact drafting form, when the symbol has one (the built-in one-line symbols). */
  readonly drafting?: Symbol2D;
}

export interface SymbolRegistry {
  readonly rows: readonly SymbolDef[];
  readonly byId: ReadonlyMap<string, SymbolDef>;
}

/** A registry from rows. Refuses an id that isn't a registry id or appears twice: a broken registry must never draw. */
export function createSymbolRegistry(rows: readonly SymbolDef[]): SymbolRegistry {
  const byId = new Map<string, SymbolDef>();
  for (const row of rows) {
    if (!isRegistryIdShape(row.id)) throw new Error(`[symbols] "${row.id}" is not a symbol id. Use lower snake case, firm:<slug> or <namespace>.<name>.`);
    if (byId.has(row.id)) throw new Error(`[symbols] symbol ${row.id} is defined twice`);
    byId.set(row.id, row);
  }
  return { rows: [...byId.values()], byId };
}

/** A registry with more rows on top (a firm's or a pack's). Same refusals as `createSymbolRegistry`. */
export function withSymbolRows(base: SymbolRegistry, rows: readonly SymbolDef[]): SymbolRegistry {
  return createSymbolRegistry([...base.rows, ...rows]);
}

const pt = (c: Symbol2D, p: readonly [number, number]): [number, number] => [p[0] * c.widthMm, p[1] * c.heightMm];

const PRIM_TO_PLAN: { readonly [K in SymbolPrim["k"]]: (c: Symbol2D, prim: Extract<SymbolPrim, { k: K }>) => SymbolPrimitive } = {
  line: (c, prim) => ({ kind: "polyline", points: prim.pts.map((p) => pt(c, p)), closed: false }),
  circle: (c, prim) => ({ kind: "circle", center: pt(c, prim.c), radius: prim.r * c.widthMm }),
  fill: (c, prim) => ({ kind: "polyline", points: prim.pts.map((p) => pt(c, p)), closed: true }),
};

function planPrimitive(c: Symbol2D, prim: SymbolPrim): SymbolPrimitive {
  const convert = PRIM_TO_PLAN[prim.k] as (c: Symbol2D, prim: SymbolPrim) => SymbolPrimitive;
  return convert(c, prim);
}

/** A drafting component as a symbol row: its strokes in mm, attached at its line (supply) terminal, keeping the exact drafting form. */
export function symbolOfComponent(c: Symbol2D): SymbolDef {
  const at = c.terminals?.line ?? c.terminals?.load ?? [0.5, 0.5];
  return { id: c.id, label: c.name, primitives: c.prims.map((p) => planPrimitive(c, p)), connectionPoint: pt(c, at), drafting: c };
}

/** The kernel's own symbols: none; every trade's symbols are its pack's rows of `SYMBOL_POINT`. */
export const BUILTIN_SYMBOL_REGISTRY: SymbolRegistry = createSymbolRegistry([]);

let active: SymbolRegistry | null = null;

function isThenable(v: unknown): boolean {
  return typeof v === "object" && v !== null && "then" in v && typeof v.then === "function";
}

/** Draw `fn` (synchronously) with `registry`'s symbols; see the module comment for why it must be synchronous. */
export function withSymbolRegistry<T>(registry: SymbolRegistry, fn: () => T): T {
  const previous = active;
  active = registry;
  let result: T;
  try {
    result = fn();
  } finally {
    active = previous;
  }
  if (isThenable(result)) throw new Error("[symbols] withSymbolRegistry takes a synchronous draw: build the scene inside it and await outside.");
  return result;
}

/** Symbols (v1). A pack's are `<pack>.<name>`; first-party packs keep their stored bare ids (the one-line symbols are Electrical's). */
export const SYMBOL_POINT = defineExtensionPoint<SymbolDef>({
  id: "kernel.symbol",
  version: 1,
  label: "Symbols",
  idOf: (row) => row.id,
  builtins: () => BUILTIN_SYMBOL_REGISTRY.rows,
});

/** The first-party pack a symbol belongs to, for listing; null for another pack's own. */
export function symbolOwner(row: Pick<SymbolDef, "id">): FirstPartyPackId | null {
  return firstPartyOwnerOf(SYMBOL_POINT, row.id);
}

/** Built-in symbols plus the pack set's (first-party packs first), built once per set. */
let last: { readonly set: PackSet; readonly base: number; readonly registry: SymbolRegistry } | null = null;

function packSymbolRegistry(): SymbolRegistry {
  const set = activePackSet();
  const base = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.base === base && !packSetReadsRecorded()) return last.registry;
  const registry = set.memo("kernel.symbol.registry", () => {
    const rows = set.packItems(SYMBOL_POINT);
    return rows.length === 0 ? BUILTIN_SYMBOL_REGISTRY : withSymbolRows(BUILTIN_SYMBOL_REGISTRY, rows);
  });
  last = { set, base, registry };
  return registry;
}

/** The symbols drawings resolve against right now: the scope's registry, else the pack set's, else the built-in one. */
export function activeSymbolRegistry(): SymbolRegistry {
  return active ?? packSymbolRegistry();
}

export function symbolById(id: string, registry: SymbolRegistry = activeSymbolRegistry()): SymbolDef | null {
  return registry.byId.get(id) ?? null;
}

const num = (d: Dim): number => (typeof d === "number" ? d : 0);
const box = (u: number, v: number, w: number, h: number, x: number, y: number): readonly [number, number] => [(x - u) / w, (y - v) / h];

const PLAN_TO_PRIMS: { readonly [K in SymbolPrimitive["kind"]]: (p: Extract<SymbolPrimitive, { kind: K }>, to: (x: number, y: number) => readonly [number, number], w: number) => SymbolPrim[] } = {
  rect: (p, to) => {
    const [cx, cy] = [num(p.center[0]), num(p.center[1])];
    const [hx, hy] = [num(p.size[0]) / 2, num(p.size[1]) / 2];
    return [{ k: "line", pts: [to(cx - hx, cy - hy), to(cx + hx, cy - hy), to(cx + hx, cy + hy), to(cx - hx, cy + hy), to(cx - hx, cy - hy)] }];
  },
  circle: (p, to, w) => [{ k: "circle", c: to(num(p.center[0]), num(p.center[1])), r: num(p.radius) / w }],
  line: (p, to) => [{ k: "line", pts: [to(num(p.from[0]), num(p.from[1])), to(num(p.to[0]), num(p.to[1]))] }],
  polyline: (p, to) => {
    const pts = p.points.map((q) => to(num(q[0]), num(q[1])));
    const first = pts[0];
    return [{ k: "line", pts: p.closed && first ? [...pts, first] : pts }];
  },
  // Drafting draws no fonts: text belongs to plan symbols and tags.
  text: () => [],
};

function extentOf(prims: readonly SymbolPrimitive[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  for (const p of prims) {
    if (p.kind === "rect") {
      add(num(p.center[0]) - num(p.size[0]) / 2, num(p.center[1]) - num(p.size[1]) / 2);
      add(num(p.center[0]) + num(p.size[0]) / 2, num(p.center[1]) + num(p.size[1]) / 2);
    } else if (p.kind === "circle") {
      add(num(p.center[0]) - num(p.radius), num(p.center[1]) - num(p.radius));
      add(num(p.center[0]) + num(p.radius), num(p.center[1]) + num(p.radius));
    } else if (p.kind === "line") {
      add(num(p.from[0]), num(p.from[1]));
      add(num(p.to[0]), num(p.to[1]));
    } else if (p.kind === "polyline") for (const q of p.points) add(num(q[0]), num(q[1]));
    else add(num(p.at[0]), num(p.at[1]));
  }
  return xs.length === 0 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const drafted = new WeakMap<SymbolDef, Symbol2D>();

/** How a drafting view draws a symbol row: its exact drafting form, or its primitives in a unit box their extent fills (numbers only; a parameter dimension drafts as 0). */
export function draftingFormOf(row: SymbolDef): Symbol2D {
  if (row.drafting) return row.drafting;
  const cached = drafted.get(row);
  if (cached) return cached;
  const e = extentOf(row.primitives);
  const w = Math.max(e.maxX - e.minX, 1e-6);
  const h = Math.max(e.maxY - e.minY, 1e-6);
  const to = (x: number, y: number) => box(e.minX, e.minY, w, h, x, y);
  const prims = row.primitives.flatMap((p) => (PLAN_TO_PRIMS[p.kind] as (p: SymbolPrimitive, to: (x: number, y: number) => readonly [number, number], w: number) => SymbolPrim[])(p, to, w));
  const out: Symbol2D = { id: row.id, name: row.label, category: "electrical", widthMm: w, heightMm: h, terminals: { line: to(row.connectionPoint[0], row.connectionPoint[1]) }, prims };
  drafted.set(row, out);
  return out;
}
