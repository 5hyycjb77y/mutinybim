import { instancesOfType } from "../elements/types";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { registerRevisionCarry } from "../revision-carry";
import { elementValues } from "../store";
import type { BimElement } from "../types";
import { constructionStageIdOf, qtoGroupOf, type QtoGroup } from "./group";
import { hostIdOf } from "./hosted";
import { measureElement } from "./measure";
import type { MeasureDef } from "./types";

/**
 * The model's takeoff: every measured quantity totalled by classification
 * code (or type, or class), size, construction stage and type. Built once per
 * element record and code system, then carried to the next revision by
 * re-measuring only the changed elements, the hosts they name and, when a
 * type changed, its instances; totals move by the difference. This is what a
 * takeoff schedule summarises and what a price source multiplies (in the
 * reader's process only, `cost/price.ts`).
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface TakeoffTotal {
  /** Stable key of the line: group, size, stage, type and measure. */
  readonly key: string;
  readonly group: QtoGroup;
  readonly sizeGroup: string | null;
  readonly stageId: string | null;
  readonly typeId: string | null;
  readonly measure: MeasureDef;
  /** SI, in `measure.unit`. */
  readonly value: number;
  /** Elements contributing. */
  readonly elementCount: number;
}

interface Contribution {
  readonly lineKeys: readonly string[];
  readonly lines: readonly Omit<TakeoffTotal, "elementCount">[];
}

const MAX_DEPTH = 32;

interface Layer {
  readonly parent: Layer | null;
  readonly own: ReadonlyMap<string, Contribution | null>;
  readonly depth: number;
}

interface TakeoffIndex {
  readonly set: PackSet;
  readonly lines: Layer;
  readonly totals: ReadonlyMap<string, TakeoffTotal>;
}

const cache = new WeakMap<Elements, Map<string, TakeoffIndex>>();

function contributionOf(layer: Layer, id: string): Contribution | null {
  for (let l: Layer | null = layer; l; l = l.parent) if (l.own.has(id)) return l.own.get(id) ?? null;
  return null;
}

function fold(layer: Layer): Layer {
  const chain: Layer[] = [];
  for (let l: Layer | null = layer; l; l = l.parent) chain.push(l);
  const own = new Map<string, Contribution | null>();
  for (let i = chain.length - 1; i >= 0; i--) for (const [k, v] of chain[i]?.own ?? []) own.set(k, v);
  for (const [k, v] of own) if (v === null) own.delete(k);
  return { parent: null, own, depth: 0 };
}

function typeIdOf(el: BimElement): string | null {
  if (!("typeId" in el)) return null;
  const t: unknown = el.typeId;
  return typeof t === "string" && t !== "" ? t : null;
}

function contribute(elements: Elements, el: BimElement, set: PackSet, system: string | undefined): Contribution | null {
  const m = measureElement(elements, el, set);
  if (!m) return null;
  const group = qtoGroupOf(elements, el, system);
  const stageId = constructionStageIdOf(el);
  const typeId = typeIdOf(el);
  const lineKeys: string[] = [];
  const lines: Omit<TakeoffTotal, "elementCount">[] = [];
  for (const ruleDef of m.rule.measures) {
    const value = m.values[ruleDef.key];
    if (value === undefined) continue;
    const measure = ruleDef;
    const key = [group.key, m.sizeGroup ?? "", stageId ?? "", typeId ?? "", ruleDef.key].join("\u0000");
    lineKeys.push(key);
    lines.push({ key, group, sizeGroup: m.sizeGroup, stageId, typeId, measure, value });
  }
  return lines.length === 0 ? null : { lineKeys, lines };
}

function apply(totals: Map<string, TakeoffTotal>, c: Contribution | null, sign: 1 | -1): void {
  if (!c) return;
  for (const line of c.lines) {
    const prior = totals.get(line.key);
    const value = (prior?.value ?? 0) + sign * line.value;
    const elementCount = (prior?.elementCount ?? 0) + sign;
    if (elementCount <= 0) totals.delete(line.key);
    else totals.set(line.key, { ...(prior ?? line), group: sign > 0 ? line.group : (prior?.group ?? line.group), measure: line.measure, value, elementCount });
  }
}

function build(elements: Elements, set: PackSet, system: string | undefined): TakeoffIndex {
  const own = new Map<string, Contribution | null>();
  const totals = new Map<string, TakeoffTotal>();
  for (const el of elementValues(elements)) {
    const c = contribute(elements, el, set, system);
    if (!c) continue;
    own.set(el.id, c);
    apply(totals, c, 1);
  }
  return { set, lines: { parent: null, own, depth: 0 }, totals };
}

/** What an edit at `changedIds` may have changed the measure of. */
function dirtyIds(from: Elements, to: Elements, changedIds: readonly string[]): Set<string> {
  const dirty = new Set<string>(changedIds);
  for (const id of changedIds) {
    const hb = hostIdOf(from[id]);
    const ha = hostIdOf(to[id]);
    if (hb !== null) dirty.add(hb);
    if (ha !== null) dirty.add(ha);
    if (from[id]?.kind === "element_type" || to[id]?.kind === "element_type") {
      // A type edit reaches its instances: one pass over the model, the model's own `instancesOfType`.
      for (const inst of instancesOfType(to, id)) dirty.add(inst.id);
      for (const inst of instancesOfType(from, id)) dirty.add(inst.id);
    }
  }
  return dirty;
}

function derive(index: TakeoffIndex, from: Elements, to: Elements, changedIds: readonly string[], system: string | undefined): TakeoffIndex {
  const own = new Map<string, Contribution | null>();
  const totals = new Map(index.totals);
  for (const id of dirtyIds(from, to, changedIds)) {
    const was = contributionOf(index.lines, id);
    const el = to[id];
    const now = el ? contribute(to, el, index.set, system) : null;
    if (was === now) continue;
    apply(totals, was, -1);
    apply(totals, now, 1);
    own.set(id, now);
  }
  const layer: Layer = { parent: index.lines, own, depth: index.lines.depth + 1 };
  return { set: index.set, lines: layer.depth > MAX_DEPTH ? fold(layer) : layer, totals };
}

function systemKey(system: string | undefined): string {
  return system ?? "";
}

/** The takeoff totals of a model record in the set in force. `system`: group codes from this classification system; absent, each element's first code. */
export function takeoffTotals(elements: Elements, options: { readonly system?: string } = {}): readonly TakeoffTotal[] {
  const set = activePackSet();
  let bySystem = cache.get(elements);
  if (!bySystem) {
    bySystem = new Map();
    cache.set(elements, bySystem);
  }
  const k = systemKey(options.system);
  let index = bySystem.get(k);
  if (!index || index.set !== set) {
    index = build(elements, set, options.system);
    bySystem.set(k, index);
  }
  return [...index.totals.values()];
}

/** Make `to`'s takeoff from `from`'s when `to` was made outside the command core (a scenario, a preview). No-op without a `from` takeoff. */
export function carryTakeoff(from: Elements, to: Elements, changedIds: readonly string[]): void {
  const bySystem = cache.get(from);
  if (!bySystem || from === to) return;
  let next = cache.get(to);
  if (!next) {
    next = new Map();
    cache.set(to, next);
  }
  for (const [k, index] of bySystem) {
    if (next.has(k)) continue;
    next.set(k, derive(index, from, to, changedIds, k === "" ? undefined : k));
  }
}

registerRevisionCarry("qto.takeoff", (from, to, changedIds) => carryTakeoff(from, to, changedIds));
