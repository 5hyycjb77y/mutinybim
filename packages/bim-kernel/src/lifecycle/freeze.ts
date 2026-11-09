import { canonicalize, sha256HexOf } from "../authorship/canonical";
import type { AuthorRef } from "../authorship/types";
import { readValueBasis } from "../basis/read";
import type { ReaderCostSources, ReaderParty } from "../cost/sources";
import type { QuantityDelta } from "../graph/types";
import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import { priceQuantityDeltas } from "../qto/delta-price";
import { qtoGroupOf } from "../qto/group";
import { measureElement } from "../qto/measure";
import { elementEntries, elementValues } from "../store";
import type { BimElement, ModelState } from "../types";
import { currentStageOf } from "./current";
import {
  NOT_RECORDED_BASIS_KEY,
  isGateRecord,
  type GateBody,
  type GateElement,
  type GateMoney,
  type GatePurpose,
  type GateQuantityLine,
  type GateTotals,
  type LoadSummary,
} from "./records";
import { nextStageIn, stageExitBlockers, stageIn, type LifecycleStageDef, type OpenFindingLike } from "./stages";

/**
 * Freezing a stage (round 11 D3): what a gate records, built from the model
 * as it stands. Off the edit path: a freeze is one explicit act that reads
 * the whole revision once (`gate.freeze`); nothing here runs on an edit.
 *
 * Freezing never forks (product owner question 6, pending): a stage row's
 * `onFreeze.offerLineageRole` comes back as an offer for the host to show,
 * and nothing else happens.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Each stored record's hash, once per record object (records are never mutated; an edit makes a new object). */
const recordHashes = new WeakMap<object, string>();

function recordHash(el: BimElement): string {
  let h = recordHashes.get(el);
  if (h === undefined) {
    h = sha256HexOf(canonicalize(el));
    recordHashes.set(el, h);
  }
  return h;
}

/**
 * `sha256:<hex>` over a revision's records: each record's id and the hash of
 * its canonical form, sorted by id, and the connections. A record's hash is
 * kept per record object, so a later freeze of the same model hashes only
 * what changed since.
 */
export function modelStateDigest(model: Pick<ModelState, "elements" | "connections">): string {
  const rows: [string, string][] = elementEntries(model.elements)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, el]) => [id, recordHash(el)]);
  const connections = [...model.connections].map((c) => c.id).sort();
  return `sha256:${sha256HexOf(canonicalize({ v: 1, elements: rows, connections }))}`;
}

/** `sha256:<hex>` over a gate body's canonical form. A sign-off names it; any change to the body changes it. */
export function gateDigest(body: GateBody): string {
  return `sha256:${sha256HexOf(canonicalize({ v: 1, gate: body }))}`;
}

/** Quantities by group and measure, each split by the basis of the value it rests on. One pass over the revision. */
export function gateQuantityTotals(elements: Elements, set: PackSet = activePackSet()): GateQuantityLine[] {
  const lines = new Map<string, { group: string; label: string; measure: string; unit: string; total: number; byBasis: Record<string, number>; elementCount: number }>();
  for (const el of elementValues(elements)) {
    const m = measureElement(elements, el, set);
    if (!m) continue;
    const group = qtoGroupOf(elements, el);
    for (const def of m.rule.measures) {
      const value = m.values[def.key];
      if (value === undefined) continue;
      const key = `${group.key}\u0000${def.key}`;
      let line = lines.get(key);
      if (!line) {
        line = { group: group.key, label: group.label, measure: def.key, unit: def.unit, total: 0, byBasis: {}, elementCount: 0 };
        lines.set(key, line);
      }
      const reading = readValueBasis(el, def.key, { set });
      const basis = reading.known ? reading.basis.maturity : NOT_RECORDED_BASIS_KEY;
      line.total += value;
      line.byBasis[basis] = (line.byBasis[basis] ?? 0) + value;
      line.elementCount += 1;
    }
  }
  return [...lines.values()].sort((a, b) => a.group.localeCompare(b.group) || a.measure.localeCompare(b.measure));
}

/**
 * A party's own prices over a gate's quantities, by basis, in the reader's
 * process only (product owner decision 4): nothing is written. Only lines grouped by
 * a classification code meet a rate; the rest are unpriced, never $0.
 */
export interface GatePricing {
  readonly sourceId: string;
  readonly reader: ReaderParty;
  readonly extra?: ReaderCostSources;
}

export function gateCostByBasis(lines: readonly GateQuantityLine[], pricing: GatePricing, set: PackSet = activePackSet()): Record<string, GateMoney> {
  const byBasis = new Map<string, QuantityDelta[]>();
  for (const line of lines) {
    for (const [basis, value] of Object.entries(line.byBasis)) {
      const list = byBasis.get(basis) ?? [];
      list.push({ measure: line.measure, group: line.group, delta: value, unit: line.unit, label: line.label });
      byBasis.set(basis, list);
    }
  }
  const out: Record<string, GateMoney> = {};
  for (const [basis, deltas] of byBasis) {
    const priced = priceQuantityDeltas(deltas, set, pricing.sourceId, pricing.reader, pricing.extra ?? []);
    // A basis the list prices nothing of has no amount (never $0).
    if (priced.lines.length === 0) continue;
    out[basis] = { minor: priced.total.minor, currency: priced.total.currency, sourceId: priced.source.id, party: priced.source.party.id, listBasis: priced.source.basis };
  }
  return out;
}

export interface FreezeInput {
  readonly stageId: string;
  readonly lineageId?: string;
  readonly purpose?: GatePurpose;
  readonly label?: string;
  readonly issuedSetRefs?: readonly string[];
  readonly signoffSeqs?: readonly number[];
  readonly dispositionIds?: readonly string[];
  readonly frozenBy: AuthorRef;
  readonly frozenAt: string;
  /** The host's checkpoint digest of this revision; absent: computed (`modelStateDigest`). */
  readonly stateDigest?: string;
  readonly loads?: LoadSummary;
  /** Open findings the host's problem list has now; a stage's exit blockers refuse the freeze. Dispositions already removed them. */
  readonly openFindings?: readonly OpenFindingLike[];
}

export type FreezeOutcome =
  | {
      readonly ok: true;
      readonly body: GateBody;
      readonly digest: string;
      /** The stage the model moves to (null at the last stage). */
      readonly next: LifecycleStageDef | null;
      /** Data only (question 6): a copy the host may offer to start. Nothing forks. */
      readonly offer?: { readonly lineageRole: string };
    }
  | { readonly ok: false; readonly message: string; readonly blockers?: readonly OpenFindingLike[] };

/** What freezing `stageId` on this revision records. Refuses, in words, a stage not in the model's list or one whose exit blockers are open. */
export function freezeGate(model: ModelState, input: FreezeInput, set: PackSet = activePackSet()): FreezeOutcome {
  const { list } = currentStageOf(model.elements, set);
  const stage = stageIn(list, input.stageId);
  if (!stage) return { ok: false, message: `"${input.stageId}" isn't a stage in this model's list (${list.label})` };
  const blockers = stageExitBlockers(stage, input.openFindings ?? []);
  if (blockers.length > 0) {
    return { ok: false, message: `${stage.label} can't be frozen yet: ${blockers.length} open problem${blockers.length === 1 ? "" : "s"} must be fixed or accepted first`, blockers };
  }
  const totals: GateTotals = {
    quantities: { lines: gateQuantityTotals(model.elements, set) },
    ...(input.loads ? { loads: input.loads } : {}),
  };
  const body: GateBody = {
    stageId: stage.id,
    stageSet: { id: list.id, version: list.version },
    purpose: input.purpose ?? "stage",
    label: input.label ?? stage.label,
    lineageId: input.lineageId ?? "main",
    revision: model.revision,
    stateDigest: input.stateDigest ?? modelStateDigest(model),
    issuedSetRefs: [...(input.issuedSetRefs ?? [])],
    signoffSeqs: [...(input.signoffSeqs ?? [])],
    dispositionIds: [...(input.dispositionIds ?? [])],
    totals,
    frozenBy: input.frozenBy,
    frozenAt: input.frozenAt,
  };
  const offer = stage.onFreeze?.offerLineageRole;
  return { ok: true, body, digest: gateDigest(body), next: nextStageIn(list, stage.id), ...(offer ? { offer: { lineageRole: offer } } : {}) };
}

/** The model's gates, oldest revision first. */
export function gatesOf(elements: Elements): GateElement[] {
  const out: GateElement[] = [];
  for (const el of elementValues(elements)) if (isGateRecord(el)) out.push(el);
  return out.sort((a, b) => a.gate.revision - b.gate.revision || a.id.localeCompare(b.id));
}

// ── estimate versus actual ─────────────────────────────────────────────────

export interface GateLineChange {
  readonly group: string;
  readonly label: string;
  readonly measure: string;
  readonly unit: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  /** By basis: before and after (0 when a side has none). */
  readonly byBasis: readonly { readonly basis: string; readonly before: number; readonly after: number }[];
}

export interface GateCostChange {
  readonly basis: string;
  readonly currency: string;
  readonly before: number | null;
  readonly after: number | null;
}

export interface GateComparison {
  readonly from: { readonly stageId: string; readonly revision: number; readonly lineageId: string };
  readonly to: { readonly stageId: string; readonly revision: number; readonly lineageId: string };
  readonly sameLineage: boolean;
  /** Lines that differ, largest absolute change first. */
  readonly lines: readonly GateLineChange[];
  /** Only for bases both gates priced in one currency, or one side priced. */
  readonly cost: readonly GateCostChange[];
}

/**
 * Estimate versus actual: two gates' totals compared by basis (same lineage,
 * or design record against as-built). With `pricing`, both gates' quantities
 * are priced with the reader's own list in its process; nothing is stored.
 */
export function compareGates(a: GateBody, b: GateBody, pricing?: GatePricing, set: PackSet = activePackSet()): GateComparison {
  const key = (l: GateQuantityLine) => `${l.group}\u0000${l.measure}`;
  const before = new Map(a.totals.quantities.lines.map((l) => [key(l), l] as const));
  const after = new Map(b.totals.quantities.lines.map((l) => [key(l), l] as const));
  const lines: GateLineChange[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(k);
    const y = after.get(k);
    const ref = y ?? x;
    if (!ref) continue;
    const bases = new Set([...Object.keys(x?.byBasis ?? {}), ...Object.keys(y?.byBasis ?? {})]);
    const byBasis = [...bases].sort().map((basis) => ({ basis, before: x?.byBasis[basis] ?? 0, after: y?.byBasis[basis] ?? 0 }));
    const b0 = x?.total ?? 0;
    const b1 = y?.total ?? 0;
    if (b0 === b1 && byBasis.every((r) => r.before === r.after)) continue;
    lines.push({ group: ref.group, label: ref.label, measure: ref.measure, unit: ref.unit, before: b0, after: b1, delta: b1 - b0, byBasis });
  }
  lines.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || p.group.localeCompare(q.group));
  const cost: GateCostChange[] = [];
  const ca = pricing ? gateCostByBasis(a.totals.quantities.lines, pricing, set) : (a.totals.costByBasis ?? {});
  const cb = pricing ? gateCostByBasis(b.totals.quantities.lines, pricing, set) : (b.totals.costByBasis ?? {});
  for (const basis of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) {
    const x = ca[basis];
    const y = cb[basis];
    if (x && y && x.currency !== y.currency) {
      console.error("[bim-kernel/lifecycle] two gates priced one basis in different currencies; not compared", { basis, from: x.currency, to: y.currency });
      continue;
    }
    cost.push({ basis, currency: (y ?? x)?.currency ?? "", before: x?.minor ?? null, after: y?.minor ?? null });
  }
  return {
    from: { stageId: a.stageId, revision: a.revision, lineageId: a.lineageId },
    to: { stageId: b.stageId, revision: b.revision, lineageId: b.lineageId },
    sameLineage: a.lineageId === b.lineageId,
    lines,
    cost,
  };
}
