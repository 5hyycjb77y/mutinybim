import { convert, unitCandidates, type UnitCode } from "@permitzip/bim-units";
import type { QuantityDelta } from "../graph/types";
import type { BimElement } from "../types";
import { carryHostedIndex, hostIdOf } from "./hosted";
import { measureElement } from "./measure";
import { qtoGroupOf, type QtoGroup } from "./group";
import type { MeasureDef } from "./types";

/**
 * What a change does to quantities, without prices: "+42 ft of 1-hour wall",
 * "-2 doors". Lane G's `dependsOn` carries these next to what a change
 * re-opens (NEXT-BATCH-7 §3 lane Q, "Impact in quantities").
 *
 * Reads only the given ids and the hosts they name, before and after,
 * through the measure rules: never the whole model. `ids` must be every
 * element that differs between `before` and `after` (what a changeset or a
 * scenario overlay touched); a host whose hosted openings changed is
 * re-measured even when it isn't listed.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface QuantityDeltaOptions {
  /** Every measure, not only each class's primary one (a wall's length, a door's count). Default false. */
  readonly all?: boolean;
  /** Group by this classification system's codes. Absent: each element's first code. */
  readonly system?: string;
  /** How labels print numbers. Default `us` (ft, ft², ft³, lb). */
  readonly display?: "us" | "metric";
}

const US_UNIT: Readonly<Record<string, { readonly unit: UnitCode; readonly word: string }>> = {
  length: { unit: "ft", word: "ft" },
  area: { unit: "ft2", word: "ft²" },
  volume: { unit: "ft3", word: "ft³" },
  mass: { unit: "lb", word: "lb" },
};
const METRIC_WORD: Readonly<Record<string, string>> = { m: "m", m2: "m²", m3: "m³", kg: "kg" };

function rounded(v: number): string {
  const a = Math.abs(v);
  const r = a >= 10 ? Math.round(a) : Math.round(a * 10) / 10;
  return r.toLocaleString("en-US");
}

function groupWords(group: QtoGroup, n: number): string {
  const lower = group.kind === "class" || group.kind === "kind";
  let label = lower ? group.label.toLowerCase() : group.label;
  if (lower && Math.abs(n) === 1 && label.endsWith("s")) label = label.slice(0, -1);
  return label;
}

/** "+42 ft of 1-hour wall", "-2 doors", "+1 × TEST-0100". */
export function quantityDeltaLabel(def: MeasureDef, group: QtoGroup, delta: number, display: "us" | "metric" = "us"): string {
  const sign = delta > 0 ? "+" : "-";
  if (def.kind === "count") {
    const n = rounded(delta);
    return group.kind === "class" || group.kind === "kind" ? `${sign}${n} ${groupWords(group, delta)}` : `${sign}${n} × ${group.label}`;
  }
  const us = display === "us" ? US_UNIT[def.kind] : undefined;
  let value = delta;
  let word = METRIC_WORD[def.unit] ?? def.unit;
  const from = unitCandidates(def.unit).find((c) => c === def.unit);
  if (us && from) {
    try {
      value = convert(delta, from, us.unit);
      word = us.word;
    } catch (err) {
      console.error("[qto/delta] a measure's unit doesn't convert for display; shown in its own unit", { key: def.key, unit: def.unit, err });
    }
  }
  return `${sign}${rounded(value)} ${word} of ${groupWords(group, 2)}`;
}

interface Acc {
  def: MeasureDef;
  group: QtoGroup;
  delta: number;
}

function addMeasured(acc: Map<string, Acc>, elements: Elements, el: BimElement, sign: 1 | -1, opts: QuantityDeltaOptions): void {
  const m = measureElement(elements, el);
  if (!m) return;
  const group = qtoGroupOf(elements, el, opts.system);
  const keep = opts.all === true ? m.rule.measures : m.rule.measures.filter((d) => d.primary === true);
  for (const ruleDef of keep) {
    const v = m.values[ruleDef.key];
    if (v === undefined || v === 0) continue;
    const def = ruleDef;
    const key = `${ruleDef.key}\u0000${group.key}\u0000${m.sizeGroup ?? ""}`;
    const prior = acc.get(key);
    if (prior) prior.delta += sign * v;
    else acc.set(key, { def: m.sizeGroup ? { ...def, from: `${def.from} (${m.sizeGroup})` } : def, group: m.sizeGroup ? { ...group, key: `${group.key}|${m.sizeGroup}`, label: `${m.sizeGroup} ${group.label}` } : group, delta: sign * v });
  }
}

/** Quantity changes between two records of a model over the elements `ids` (and the hosts they name). */
export function quantityDeltasBetween(before: Readonly<Record<string, BimElement>>, after: Readonly<Record<string, BimElement>>, ids: readonly string[], options: QuantityDeltaOptions = {}): QuantityDelta[] {
  const touched = new Set<string>(ids);
  /** Hosts named by a changed element: re-measured even when their own record is unchanged (a door removed changes its wall's net area). */
  const hosts = new Set<string>();
  for (const id of ids) {
    const hb = hostIdOf(before[id]);
    const ha = hostIdOf(after[id]);
    if (hb !== null) hosts.add(hb);
    if (ha !== null) hosts.add(ha);
  }
  for (const h of hosts) touched.add(h);
  carryHostedIndex(before, after, ids);
  const acc = new Map<string, Acc>();
  for (const id of touched) {
    const b = before[id];
    const a = after[id];
    if (b === a && !hosts.has(id)) continue;
    if (b) addMeasured(acc, before, b, -1, options);
    if (a) addMeasured(acc, after, a, 1, options);
  }
  const display = options.display ?? "us";
  const out: QuantityDelta[] = [];
  for (const { def, group, delta } of acc.values()) {
    if (Math.abs(delta) < 1e-9) continue;
    out.push({ measure: def.key, group: group.key, delta, unit: def.unit, label: quantityDeltaLabel(def, group, delta, display) });
  }
  out.sort((x, y) => x.group.localeCompare(y.group) || x.measure.localeCompare(y.measure));
  return out;
}
