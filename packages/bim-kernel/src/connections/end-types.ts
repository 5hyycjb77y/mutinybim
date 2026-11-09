import { isRegistryIdShape } from "../ids";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * Connector end types (contract 1.7.0, `kernel.connector_end_type` v1).
 *
 * How an opening is made to join another: the kind of end a part, a fitting
 * or a run carries where it meets the next piece. Every name is an add-on's
 * row; the kernel only reads the table: which end types exist, the
 * connector domains each is made for, the names older records stored it
 * under, and which pairs join directly or only through a named fitting.
 *
 * Readers are tolerant: an end type no add-on in force declares is kept as
 * stored and judged by nothing (it joins as "unknown", never as a mismatch).
 * A connector's `endType` is written only to peers that read
 * `CONNECTOR_END_TYPES_FEATURE`.
 */
export interface ConnectorEndTypeVia {
  /** The end type it meets. */
  readonly endType: string;
  /** What a person fits between the two ("adapter", "companion flange"). */
  readonly fitting: string;
}

export interface ConnectorEndTypeItem {
  /** `<pack>.<name>`: what a connector's `endType` stores. */
  readonly id: string;
  /** What a person calls it ("Bolted"). */
  readonly label: string;
  /** Connector domains (registry ids) it is made for. Absent: any. */
  readonly domains?: readonly string[];
  /** How older records stored it: a fitting parameter and its values (a run fitting's `params[param]`), read only. */
  readonly stored?: { readonly param: string; readonly values: readonly string[] };
  /** Other end types it joins directly. Joining is symmetric: either row may say it. */
  readonly joins?: readonly string[];
  /** End types it joins only with a fitting between them. */
  readonly joinsVia?: readonly ConnectorEndTypeVia[];
  /** Whether two ends of this type join each other. Default true. */
  readonly joinsItself?: boolean;
}

// Peers that store an end type on a part connector: a service-layer constant (the write gate reads it), re-exported here beside the point.
export { CONNECTOR_END_TYPES_FEATURE } from "../services/types";

export const CONNECTOR_END_TYPE_POINT = defineExtensionPoint<ConnectorEndTypeItem>({
  id: "kernel.connector_end_type",
  version: 1,
  label: "Connector end types",
  idOf: (item) => item.id,
});

/** How two end types meet. */
export type EndTypeJoin =
  | { readonly kind: "direct" }
  | { readonly kind: "via"; readonly fitting: string }
  | { readonly kind: "mismatch" }
  /** One side has no end type, or one no add-on in force declares: nothing to judge. */
  | { readonly kind: "unknown" };

export interface ConnectorEndTypeTable {
  row(id: string): ConnectorEndTypeItem | undefined;
  /** The end type a fitting's `params[param] = value` stores, in `domain` first; undefined when no row reads it. */
  resolveStored(param: string, value: string, domain?: string): ConnectorEndTypeItem | undefined;
  /** Every fitting parameter some row reads stored end types from, in row order. */
  readonly storedParams: readonly string[];
  /** End types made for `domain`, in row order (rows without `domains` included). */
  forDomain(domain: string): readonly ConnectorEndTypeItem[];
  /** Whether any add-on declares an end type made for `domain` itself (rows without `domains` don't count). */
  declaresDomain(domain: string): boolean;
  join(a: string | undefined, b: string | undefined): EndTypeJoin;
  readonly ids: readonly string[];
}

const TABLE_KEY = "kernel.connector_end_type#table";
const DIRECT: EndTypeJoin = Object.freeze({ kind: "direct" });
const MISMATCH: EndTypeJoin = Object.freeze({ kind: "mismatch" });
const UNKNOWN: EndTypeJoin = Object.freeze({ kind: "unknown" });

const storedKey = (param: string, domain: string, value: string): string => `${param}\u0000${domain}\u0000${value}`;
const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function buildTable(items: readonly ConnectorEndTypeItem[]): ConnectorEndTypeTable {
  const rows = new Map<string, ConnectorEndTypeItem>();
  const stored = new Map<string, ConnectorEndTypeItem>();
  const byDomain = new Map<string, ConnectorEndTypeItem[]>();
  const anyDomain: ConnectorEndTypeItem[] = [];
  const pairs = new Map<string, EndTypeJoin>();
  const storedParams: string[] = [];
  for (const item of items) {
    rows.set(item.id, item);
    if (item.domains === undefined) anyDomain.push(item);
    for (const d of item.domains ?? []) {
      const list = byDomain.get(d) ?? [];
      list.push(item);
      byDomain.set(d, list);
    }
    if (item.stored) {
      if (!storedParams.includes(item.stored.param)) storedParams.push(item.stored.param);
      for (const name of item.stored.values) {
        for (const d of item.domains ?? [""]) if (!stored.has(storedKey(item.stored.param, d, name))) stored.set(storedKey(item.stored.param, d, name), item);
        if (!stored.has(storedKey(item.stored.param, "*", name))) stored.set(storedKey(item.stored.param, "*", name), item);
      }
    }
  }
  for (const item of items) {
    if (item.joinsItself !== false) pairs.set(pairKey(item.id, item.id), DIRECT);
    for (const other of item.joins ?? []) pairs.set(pairKey(item.id, other), DIRECT);
  }
  for (const item of items) {
    for (const via of item.joinsVia ?? []) {
      const key = pairKey(item.id, via.endType);
      if (!pairs.has(key)) pairs.set(key, Object.freeze({ kind: "via", fitting: via.fitting }));
    }
  }
  const domainRows = new Map<string, readonly ConnectorEndTypeItem[]>();
  return {
    row: (id) => rows.get(id),
    resolveStored(param, value, domain) {
      return (domain !== undefined ? (stored.get(storedKey(param, domain, value)) ?? stored.get(storedKey(param, "", value))) : undefined) ?? stored.get(storedKey(param, "*", value));
    },
    storedParams,
    forDomain(domain) {
      let list = domainRows.get(domain);
      if (!list) {
        const own = new Set(byDomain.get(domain) ?? []);
        list = Object.freeze(items.filter((i) => own.has(i) || i.domains === undefined));
        domainRows.set(domain, list);
      }
      return list;
    },
    declaresDomain: (domain) => (byDomain.get(domain)?.length ?? 0) > 0,
    join(a, b) {
      if (a === undefined || b === undefined || !rows.has(a) || !rows.has(b)) return UNKNOWN;
      return pairs.get(pairKey(a, b)) ?? MISMATCH;
    },
    ids: [...rows.keys()],
  };
}

/** The end types of `set` (the set in force by default), resolved once per set. */
export function connectorEndTypeTable(set: PackSet = activePackSet()): ConnectorEndTypeTable {
  return set.memo(TABLE_KEY, () => buildTable(set.items(CONNECTOR_END_TYPE_POINT)));
}

/** An end type as a person reads it mid-sentence ("a bolted end"): its label, first letter lower unless the label starts with a short capitalised abbreviation. */
export function endTypeWords(item: Pick<ConnectorEndTypeItem, "label">): string {
  const label = item.label.trim();
  if (/^[A-Z]{2,}/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** "a" or "an" before `word`. */
export function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Problems with end-type rows, in words (pack conformance). */
export function connectorEndTypeRowProblems(items: readonly ConnectorEndTypeItem[]): string[] {
  const out: string[] = [];
  const ids = new Set(items.map((i) => i.id));
  const storedSeen = new Map<string, string>();
  for (const item of items) {
    if (item.label.trim().length === 0) out.push(`end type ${item.id} has no label`);
    for (const d of item.domains ?? []) if (!isRegistryIdShape(d)) out.push(`end type ${item.id}: domain "${d}" is not a registry id`);
    if (item.domains !== undefined && item.domains.length === 0) out.push(`end type ${item.id}: list at least one domain, or leave domains out for any`);
    for (const other of [...(item.joins ?? []), ...(item.joinsVia ?? []).map((v) => v.endType)]) {
      if (!isRegistryIdShape(other)) out.push(`end type ${item.id}: "${other}" is not an end type id`);
    }
    for (const via of item.joinsVia ?? []) {
      if (via.fitting.trim().length === 0) out.push(`end type ${item.id}: say what fitting joins it to ${via.endType}`);
      if ((item.joins ?? []).includes(via.endType)) out.push(`end type ${item.id} joins ${via.endType} both directly and through a fitting; keep one`);
    }
    if (item.stored && !isRegistryIdShape(item.stored.param)) out.push(`end type ${item.id}: stored parameter "${item.stored.param}" is not a parameter name`);
    for (const name of item.stored?.values ?? []) {
      for (const d of item.domains ?? [""]) {
        const key = storedKey(item.stored?.param ?? "", d, name);
        const first = storedSeen.get(key);
        if (first !== undefined && first !== item.id) out.push(`end types ${first} and ${item.id} both read the stored ${item.stored?.param} "${name}"${d ? ` in ${d}` : ""}`);
        else storedSeen.set(key, item.id);
      }
    }
  }
  if (ids.size !== items.length) out.push("two end type rows share one id");
  return out;
}

