import { activePackSet } from "../packs/scope";
import { firstPartyBaseRevision, packSetReadsRecorded, type PackSet } from "../packs/set";
import { ELEMENT_KIND_POINT, type ConnectorEndsFace, type ElementKindItem } from "../registry/element-kind-point";
import { isKernelElementKind } from "../registry/element-kinds";
import type { BimElement, ConnectorEnd, Vec2 } from "../types";

/**
 * Connector ends by kind, as the pack set in force declares them on its
 * element-kind rows (`connectorEnds`, contract 1.8.0). The network index,
 * topology and connector positions read this table; the kernel names no
 * kind's ends. A kind no row gives ends to joins no tree (a bare kernel, or
 * a stored record whose add-on isn't loaded, is kept as stored).
 *
 * Each kind with ends gets a one-byte code (from `FIRST_ENDS_CODE`) so the
 * index's passes over every slot read its ends without reading the element.
 * Codes fit a 32-bit kind mask; kinds past the 27th share `SHARED_ENDS_CODE`
 * and are read per element.
 */

/** The first code a kind with ends gets; lower codes are the index's own. */
export const FIRST_ENDS_CODE = 4;
/** The code every kind past the 27th with ends shares (bit 31 of a kind mask). */
export const SHARED_ENDS_CODE = 31;

// Plain arrays, not frozen: a frozen array leaves the fast iteration path the index walks every slot with.
const NO_ENDS: readonly ConnectorEnd[] = [];

export interface ConnectorEndsTable {
  /** Kinds with connector ends, in row order. */
  readonly kinds: readonly string[];
  /** Kinds that start a tree. */
  readonly rootKinds: readonly string[];
  /** Kinds that hang on a host without a connection. */
  readonly hostedKinds: readonly string[];
  /** True when a row gives `kind` connector ends. */
  isNetworkKind(kind: string): boolean;
  /** `kind`'s downstream ends, in walk order. */
  downstream(kind: string): readonly ConnectorEnd[];
  /** `kind`'s upstream end, or null (a root, or no ends). */
  upstream(kind: string): ConnectorEnd | null;
  isRoot(kind: string): boolean;
  /** The stored field holding the host id of a hosted kind, or null. */
  hostField(kind: string): string | null;
  /** Kinds a row places along their host (`hostedBy.placement`), in row order. */
  readonly placedKinds: readonly string[];
  /** Where a record of `kind` sits along its host, or null when its row doesn't place it. A short list scanned by interned kind (most models have one placed kind). */
  placement(kind: string): HostedPlacement | null;
  /** World position of `el`'s `end` from its row; null when the row can't place it; undefined when no row places this kind's ends. */
  point(el: BimElement, end: ConnectorEnd, elements: Readonly<Record<string, BimElement>>): Vec2 | null | undefined;
  /** `kind`'s code: 0 when it has no ends, else `FIRST_ENDS_CODE`… or `SHARED_ENDS_CODE`. */
  code(kind: string): number;
  /** Ends by code; `SHARED_ENDS_CODE` and 0 give none (read the kind). */
  downstreamOfCode(code: number): readonly ConnectorEnd[];
  isRootCode(code: number): boolean;
  isHostedCode(code: number): boolean;
  /** `kinds` as bits of a 32-bit mask over codes (`1 << code`). Kinds without ends set no bit. */
  mask(kinds: readonly string[]): number;
  /** Downstream ends by code, for passes over every slot (index 0…31; `SHARED_ENDS_CODE` and unused codes hold none). */
  readonly downstreamByCode: readonly (readonly ConnectorEnd[])[];
  /** Per code: `ROOT_FLAG` and `HOSTED_FLAG` bits. */
  readonly flagsByCode: Uint8Array;
  /** Per code: the stored host field of a hosted kind, else null. */
  readonly hostFieldByCode: readonly (string | null)[];
}

/** The stored fields that place a hosted record along its host (`hostedBy` with its `placement`). */
export interface HostedPlacement {
  readonly kind: string;
  readonly hostField: string;
  readonly along: string;
  readonly side: string;
  readonly at: string;
}

/** `flagsByCode` bit: the kind starts a tree. */
export const ROOT_FLAG = 1;
/** `flagsByCode` bit: the kind hangs on a host. */
export const HOSTED_FLAG = 2;

interface KindEnds {
  readonly kind: string;
  readonly code: number;
  readonly downstream: readonly ConnectorEnd[];
  readonly upstream: ConnectorEnd | null;
  readonly root: boolean;
  readonly hostField: string | null;
  readonly face: ConnectorEndsFace;
}

function resolve(rows: readonly ElementKindItem[]): ConnectorEndsTable {
  const byKind = new Map<string, KindEnds>();
  const byCode: KindEnds[] = [];
  for (const row of rows) {
    const face = row.connectorEnds;
    if (face === undefined || byKind.has(row.kind)) continue;
    const next = FIRST_ENDS_CODE + byKind.size;
    const code = next < SHARED_ENDS_CODE ? next : SHARED_ENDS_CODE;
    const downstream: readonly ConnectorEnd[] = face.ends.filter((e) => e.role === "downstream").map((e) => e.end);
    const up = face.root === true ? undefined : face.ends.find((e) => e.role === "upstream");
    const entry: KindEnds = {
      kind: row.kind,
      code,
      downstream: downstream.length === 0 ? NO_ENDS : downstream,
      upstream: up?.end ?? null,
      root: face.root === true,
      hostField: face.hostedBy?.field ?? null,
      face,
    };
    byKind.set(row.kind, entry);
    if (code !== SHARED_ENDS_CODE) byCode[code] = entry;
  }
  const entries = [...byKind.values()];
  type PointFn = NonNullable<ConnectorEndsFace["point"]>;
  const placed = entries.flatMap((e) => (e.face.point !== undefined ? [[e.kind, e.face.point] as const] : []));
  const pointKinds: readonly string[] = placed.map(([kind]) => kind);
  const pointFns: readonly PointFn[] = placed.map(([, fn]) => fn);
  const pointMap: ReadonlyMap<string, PointFn> | null = placed.length > 16 ? new Map(placed) : null;
  const placements: readonly HostedPlacement[] = entries.flatMap((e) => {
    const p = e.face.hostedBy?.placement;
    return p !== undefined && e.hostField !== null ? [{ kind: e.kind, hostField: e.hostField, along: p.along, side: p.side, at: p.at }] : [];
  });
  const placedKinds: readonly string[] = placements.map((p) => p.kind);
  const downstreamByCode: (readonly ConnectorEnd[])[] = Array.from({ length: SHARED_ENDS_CODE + 1 }, () => NO_ENDS);
  const flagsByCode = new Uint8Array(SHARED_ENDS_CODE + 1);
  const hostFieldByCode: (string | null)[] = Array.from({ length: SHARED_ENDS_CODE + 1 }, () => null);
  for (const e of entries) {
    if (e.code === SHARED_ENDS_CODE) continue;
    downstreamByCode[e.code] = e.downstream;
    hostFieldByCode[e.code] = e.hostField;
    flagsByCode[e.code] = (e.root ? ROOT_FLAG : 0) | (e.hostField !== null ? HOSTED_FLAG : 0);
  }
  return Object.freeze({
    downstreamByCode,
    flagsByCode,
    hostFieldByCode,
    kinds: Object.freeze(entries.map((e) => e.kind)),
    rootKinds: Object.freeze(entries.filter((e) => e.root).map((e) => e.kind)),
    hostedKinds: Object.freeze(entries.filter((e) => e.hostField !== null).map((e) => e.kind)),
    isNetworkKind: (kind: string) => byKind.has(kind),
    downstream: (kind: string) => byKind.get(kind)?.downstream ?? NO_ENDS,
    upstream: (kind: string) => byKind.get(kind)?.upstream ?? null,
    isRoot: (kind: string) => byKind.get(kind)?.root === true,
    hostField: (kind: string) => byKind.get(kind)?.hostField ?? null,
    placedKinds: Object.freeze(placedKinds),
    placement: (kind: string) => {
      for (let i = 0; i < placements.length; i++) if (placedKinds[i] === kind) return placements[i] ?? null;
      return null;
    },
    point: (el: BimElement, end: ConnectorEnd, elements: Readonly<Record<string, BimElement>>) => {
      // Placed once per connection end in a full check: a short list is scanned (kind strings are interned), a long one is a map.
      const kind = el.kind;
      if (pointMap === null) {
        for (let i = 0; i < pointKinds.length; i++) if (pointKinds[i] === kind) return pointFns[i]?.(el, end, elements);
        return undefined;
      }
      return pointMap.get(kind)?.(el, end, elements);
    },
    code: (kind: string) => byKind.get(kind)?.code ?? 0,
    downstreamOfCode: (code: number) => byCode[code]?.downstream ?? NO_ENDS,
    isRootCode: (code: number) => byCode[code]?.root === true,
    isHostedCode: (code: number) => (byCode[code]?.hostField ?? null) !== null,
    mask: (kinds: readonly string[]) => {
      let m = 0;
      for (const kind of kinds) {
        const code = byKind.get(kind)?.code;
        if (code !== undefined) m |= 1 << code;
      }
      return m;
    },
  });
}

/**
 * One resolved table per distinct list of rows with ends (by identity), so
 * every set carrying the same rows (each model's set over one first-party
 * base) shares one table, and an index built under one serves the others.
 */
const interned: Array<{ readonly rows: readonly ElementKindItem[]; readonly table: ConnectorEndsTable }> = [];

function internedFor(rows: readonly ElementKindItem[]): ConnectorEndsTable {
  for (const entry of interned) {
    if (entry.rows.length === rows.length && entry.rows.every((r, i) => r === rows[i])) return entry.table;
  }
  const table = resolve(rows);
  interned.push({ rows, table });
  return table;
}

const MEMO_KEY = "kernel.element_kind#ends";

function tableOf(set: PackSet): ConnectorEndsTable {
  return set.memo(MEMO_KEY, () => internedFor(set.items(ELEMENT_KIND_POINT).filter((row) => row.connectorEnds !== undefined)));
}

let last: { readonly set: PackSet; readonly base: number; readonly table: ConnectorEndsTable } | null = null;

/** The connector ends the pack set in force (or `set`) declares: one map read once resolved for that set. */
export function connectorEndsTable(set?: PackSet): ConnectorEndsTable {
  if (set !== undefined) return tableOf(set);
  const active = activePackSet();
  const base = firstPartyBaseRevision();
  if (last !== null && last.set === active && last.base === base && !packSetReadsRecorded()) return last.table;
  const table = tableOf(active);
  last = { set: active, base, table };
  return table;
}

/** `kind`'s downstream connector ends under the set in force (none for a kind no row gives ends). */
export function downstreamEndsOf(kind: string): readonly ConnectorEnd[] {
  return connectorEndsTable().downstream(kind);
}

/** `kind`'s upstream connector end under the set in force, or null. */
export function upstreamEndOf(kind: string): ConnectorEnd | null {
  return connectorEndsTable().upstream(kind);
}

/**
 * True when `kind`'s ends can't be placed because the add-on that owns it
 * isn't loaded (not a kernel kind, and no row in force gives it ends): a
 * connection to it is kept as stored and not measured. Kernel kinds are
 * never kept this way (a connection to a wall is still refused).
 */
export function endsKeptAsStored(kind: string): boolean {
  return !isKernelElementKind(kind) && !connectorEndsTable().isNetworkKind(kind);
}
