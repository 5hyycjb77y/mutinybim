import { sha256HexOf } from "../authorship/canonical";
import { canonicalJson } from "../canonical";
import { requirementById } from "../graph/engine";
import { isDeterminationRecord, isRuleRecordElement } from "../graph/records";
import type { RuleRecord } from "../graph/types";
import { CODE_OF_RECORD_KEY, CurrentRuleIndex, codeOfRecordOf, codesOfRecord, contextStanding, readCheckingContext, ruleVersionRef, type RuleVersionRef } from "../responsibility/checking-context";
import { registerRevisionCarry } from "../revision-carry";
import { elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";

/**
 * Temporal validity (round 9, FIX FIRST): a record that was true of the model
 * at one revision says what it relied on, so a later revision can tell it
 * "may no longer hold" without anyone re-reading the model.
 *
 * Generic: an answer is the first user; an approval, a classification or a
 * determination adopts it by storing a `Reliance` and registering a
 * `RelianceSource` (see `registerRelianceSource`). Nothing here reopens,
 * withdraws or edits the record: it only reads whether what it relied on is
 * still the same, and names what changed ("Room 104 changed in Rev 52").
 *
 * Reliance reuses the requirements graph's dependency index: relying on a
 * requirement relies on every element that requirement reads and the
 * elements that fulfil it (`Requirement.reads`, `fulfilment.elementIds`, the
 * same index "what re-opens" walks).
 *
 * Rules are a reliance source too (round 10, C10): a record may pin the rules
 * it was checked against (`Reliance.rules`, each with its version, edition
 * and section). It then "may no longer hold — checked against an older rule"
 * when the project's code of record for that instrument moves to another
 * edition (unless the code pack declares the rule carried forward), or the
 * rule's own version changes. Such records are filed under the rule and the
 * instrument, so a rule edit or a code-of-record change re-checks only them.
 *
 * Incremental: a per-snapshot index files each record under the ids it relied
 * on; each new revision carries the index forward (`registerRevisionCarry`)
 * and re-checks only the records filed under the changed ids. A cold build
 * reads the registered records (a kind-index read), never the model.
 */

/** Peers that read and store `reliance` on records (round 9). A peer without it never receives the field; readers keep it untouched. */
export const VALIDITY_RELIANCE_FEATURE = "validity:reliance";

/** The most ids one record may rely on; beyond this a record says so instead of growing without bound. */
export const MAX_RELIED_FACTS = 500;

export interface ReliedFact {
  readonly id: ElementId;
  /** The element's record version at the revision the record relied on it. */
  readonly version: number;
  /** A short digest of the element's facts then (what a person set and the model derived, without bookkeeping). */
  readonly digest: string;
}

export interface Reliance {
  /** The model revision the record was true of. */
  readonly revision: number;
  readonly facts: readonly ReliedFact[];
  /** Requirements it relied on (their reads and fulfilments are in `facts`). */
  readonly requirementRefs?: readonly string[];
  /** `sha256:<hex>` of the canonical facts, so two records relying on the same thing compare by one string. */
  readonly digest: string;
  /** True when more than `MAX_RELIED_FACTS` ids were named; the first ones are kept. */
  readonly truncated?: boolean;
  /** Rules it was checked against, as they were then (round 10). */
  readonly rules?: readonly RuleVersionRef[];
}

export interface ReliedChange {
  readonly id: ElementId;
  /** "Room 104". */
  readonly name: string;
  /** `older_rule`: a rule it was checked against changed version or the project moved to another edition (round 10). */
  readonly kind: "changed" | "removed" | "older_rule";
  /** The revision a person last set something on it, when the model knows (derived-only changes don't say). */
  readonly revision: number | null;
}

export type Validity = { readonly state: "holds" } | { readonly state: "may_not_hold"; readonly changes: readonly ReliedChange[]; readonly words: string };

type Elements = Readonly<Record<string, BimElement>>;

function factDigest(el: BimElement): string {
  const { version: _v, authoredRev: _a, ...facts } = el;
  return sha256HexOf(canonicalJson(facts)).slice(0, 16);
}

function textField(el: BimElement, key: string): string | null {
  const v: unknown = key in el ? Reflect.get(el, key) : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function nameOf(el: BimElement | undefined, id: string): string {
  if (!el) return id;
  const text = (k: string) => textField(el, k);
  const kindWords = el.kind.replace(/_/g, " ");
  const label = kindWords.charAt(0).toUpperCase() + kindWords.slice(1);
  const number = text("number");
  const name = text("name");
  if (number && name) return `${name} ${number}`;
  return text("mark") ?? (number ? `${label} ${number}` : name ?? `${label} ${id}`);
}

/** What a record relies on at this revision: the named elements, plus each named requirement's reads and fulfilments. */
export function relianceFor(model: ModelState, on: { readonly elementIds?: readonly string[]; readonly requirementRefs?: readonly string[]; readonly rules?: readonly RuleRecord[] }): Reliance {
  const ids = new Set<string>(on.elementIds ?? []);
  const reqs = [...new Set(on.requirementRefs ?? [])];
  for (const ref of reqs) {
    const r = requirementById(model, ref as Parameters<typeof requirementById>[1]);
    if (!r) continue;
    for (const id of r.reads) ids.add(id);
    for (const id of r.fulfilment.elementIds) ids.add(id);
  }
  const all = [...ids].sort();
  const kept = all.slice(0, MAX_RELIED_FACTS);
  const facts: ReliedFact[] = [];
  for (const id of kept) {
    const el = model.elements[id];
    if (el) facts.push({ id: el.id, version: el.version, digest: factDigest(el) });
  }
  return {
    revision: model.revision,
    facts,
    ...(reqs.length > 0 ? { requirementRefs: reqs } : {}),
    digest: `sha256:${sha256HexOf(canonicalJson(facts))}`,
    ...(all.length > kept.length ? { truncated: true } : {}),
    ...(on.rules && on.rules.length > 0 ? { rules: on.rules.map(ruleVersionRef) } : {}),
  };
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFact(v: unknown): v is ReliedFact {
  return isRecord(v) && typeof v.id === "string" && typeof v.version === "number" && typeof v.digest === "string";
}

function isReliance(v: unknown): v is Reliance {
  return isRecord(v) && typeof v.revision === "number" && typeof v.digest === "string" && Array.isArray(v.facts) && v.facts.every(isFact) && (v.rules === undefined || Array.isArray(v.rules));
}

/** Pinned rules, read with the checking-context reader (malformed ones dropped). */
function pinnedRules(r: Reliance): readonly RuleVersionRef[] {
  if (!r.rules || r.rules.length === 0) return [];
  return readCheckingContext({ determinationsDigest: "", rules: r.rules })?.rules ?? [];
}

/** A stored reliance, checked; null when it isn't one (a record without it simply has no validity to check). Unknown fields are kept. */
export function readReliance(raw: unknown): Reliance | null {
  return isReliance(raw) ? raw : null;
}

function lastAuthoredRevision(el: BimElement): number | null {
  const revs = Object.values(el.authoredRev ?? {}).filter((n): n is number => typeof n === "number");
  return revs.length > 0 ? Math.max(...revs) : null;
}

function changeOf(elements: Elements, fact: ReliedFact, since: number): ReliedChange | null {
  const el = elements[fact.id];
  if (!el) return { id: fact.id, name: fact.id, kind: "removed", revision: null };
  if (el.version === fact.version) return null;
  if (factDigest(el) === fact.digest) return null;
  const rev = lastAuthoredRevision(el);
  return { id: fact.id, name: nameOf(el, fact.id), kind: "changed", revision: rev !== null && rev > since ? rev : null };
}

/** "May no longer hold — Room 104 changed in Rev 52" (the first two changes named, then a count). */
export function validityWords(changes: readonly ReliedChange[]): string {
  const say = (c: ReliedChange) => (c.kind === "older_rule" ? `checked against an older rule (${c.name})` : c.kind === "removed" ? `${c.name} was removed` : c.revision !== null ? `${c.name} changed in Rev ${c.revision}` : `${c.name} changed`);
  const named = changes.slice(0, 2).map(say).join("; ");
  const more = changes.length > 2 ? `; and ${changes.length - 2} more` : "";
  return `May no longer hold — ${named}${more}`;
}

const currentRules = new WeakMap<Elements, CurrentRuleIndex>();

/** The rules stored with the model (local source) and its codes of record, indexed once per revision (kind-index reads). */
function currentRulesOf(elements: Elements): CurrentRuleIndex {
  const hit = currentRules.get(elements);
  if (hit) return hit;
  const rules: RuleRecord[] = [];
  for (const el of elementsOfKind(elements, "rule" as BimElement["kind"])) if (isRuleRecordElement(el)) rules.push(el.rule);
  const built = new CurrentRuleIndex({ codesOfRecord: codesOfRecord(elements), rules });
  currentRules.set(elements, built);
  return built;
}

/** Whether what a record relied on is still the same in `elements`: O(relied facts + pinned rules), no model read. */
export function validityOf(elements: Elements, reliance: Reliance, names?: Elements): Validity {
  const changes: ReliedChange[] = [];
  for (const f of reliance.facts) {
    const c = changeOf(elements, f, reliance.revision);
    if (c) changes.push(c.kind === "removed" && names ? { ...c, name: nameOf(names[c.id], c.id) } : c);
  }
  const rules = pinnedRules(reliance);
  if (rules.length > 0) {
    const standing = contextStanding({ v: 1, lineageId: "main", jurisdiction: null, codesOfRecord: [], packs: [], rules, determinationsDigest: "" }, currentRulesOf(elements));
    if (standing.state === "older") for (const item of standing.items) changes.push({ id: asElementId(`rule:${item.rule.provider}:${item.rule.ruleId}`), name: `${item.rule.instrument} ${item.rule.edition} §${item.rule.section.replace(/^§/, "")}`, kind: "older_rule", revision: null });
  }
  return changes.length === 0 ? { state: "holds" } : { state: "may_not_hold", changes, words: validityWords(changes) };
}

// ---------------------------------------------------------------- the model-wide index

/** Records that carry a reliance, by kind: an answer, an approval, a classification. */
export interface RelianceSource {
  /** Stable name ("question_answer"). */
  readonly name: string;
  /** The element kinds whose records may carry a reliance (the index reads only those). */
  readonly kinds: readonly string[];
  /** A record's reliance, or null. */
  relianceOf(el: BimElement): Reliance | null;
}

const sources = new Map<string, RelianceSource>();
let sourceKinds: ReadonlySet<string> = new Set();

/** Register a kind of record that relies on the model (re-registering replaces it). */
export function registerRelianceSource(source: RelianceSource): void {
  sources.set(source.name, source);
  sourceKinds = new Set([...sources.values()].flatMap((s) => s.kinds));
}

interface ValidityState {
  readonly byFact: Map<string, Set<string>>;
  readonly reliances: Map<string, Reliance>;
  readonly stale: Map<string, Validity & { readonly state: "may_not_hold" }>;
  rechecks: number;
}

const states = new WeakMap<Elements, ValidityState>();

function relianceOfRecord(el: BimElement | undefined): Reliance | null {
  if (!el || !sourceKinds.has(el.kind)) return null;
  for (const s of sources.values()) {
    if (!s.kinds.includes(el.kind)) continue;
    const r = s.relianceOf(el);
    if (r) return r;
  }
  return null;
}

/** The index keys a pinned rule files a record under: the rule, and its instrument (for a code-of-record change). */
function ruleKeys(r: Reliance): string[] {
  const out: string[] = [];
  for (const rule of pinnedRules(r)) out.push(`rule:${rule.provider}:${rule.ruleId}`, `code:${rule.instrument.toLowerCase()}`);
  return out;
}

/** The rule or instrument key a changed element moves, if it is a rule record or a code-of-record determination. */
function reliedKeysOf(el: BimElement | undefined): string[] {
  if (!el) return [];
  if (isRuleRecordElement(el)) return [`rule:${el.rule.provider}:${el.rule.ruleId}`];
  if (isDeterminationRecord(el) && el.determination.key.startsWith(`${CODE_OF_RECORD_KEY}.`)) {
    const c = codeOfRecordOf(el);
    const instrument = c?.instrument ?? el.determination.inputs.find((i) => i.key === "instrument")?.value;
    return typeof instrument === "string" ? [`code:${instrument.toLowerCase()}`] : [];
  }
  return [];
}

function unfile(state: ValidityState, recordId: string): void {
  const prior = state.reliances.get(recordId);
  if (prior) {
    for (const f of prior.facts) state.byFact.get(f.id)?.delete(recordId);
    for (const k of ruleKeys(prior)) state.byFact.get(k)?.delete(recordId);
  }
  state.reliances.delete(recordId);
  state.stale.delete(recordId);
}

function check(state: ValidityState, elements: Elements, recordId: string, previous?: Elements): void {
  const r = state.reliances.get(recordId);
  if (!r) return;
  state.rechecks += 1;
  const v = validityOf(elements, r, previous);
  if (v.state === "holds") state.stale.delete(recordId);
  else state.stale.set(recordId, v);
}

function file(state: ValidityState, elements: Elements, el: BimElement): void {
  unfile(state, el.id);
  const r = relianceOfRecord(el);
  if (!r) return;
  state.reliances.set(el.id, r);
  for (const key of [...r.facts.map((f) => f.id as string), ...ruleKeys(r)]) {
    let set = state.byFact.get(key);
    if (!set) state.byFact.set(key, (set = new Set()));
    set.add(el.id);
  }
  check(state, elements, el.id);
}

function build(elements: Elements): ValidityState {
  const state: ValidityState = { byFact: new Map(), reliances: new Map(), stale: new Map(), rechecks: 0 };
  // The store indexes any kind string: read only the registered record kinds (the matches, not the model).
  for (const kind of sourceKinds) for (const el of elementsOfKind(elements, kind as BimElement["kind"])) file(state, elements, el);
  return state;
}

function stateFor(elements: Elements): ValidityState {
  const hit = states.get(elements);
  if (hit) return hit;
  const built = build(elements);
  states.set(elements, built);
  return built;
}

/**
 * Move the index onto the next revision: re-file changed records, re-check
 * only the records relying on changed ids. A revision that touches no relied
 * id and no reliance record shares the index as it is (O(changed)); one that
 * does copies it and re-checks just those dependants. The earlier revision
 * keeps its own index (a prediction and its commit both carry from the head).
 */
function carry(from: Elements, to: Elements, changedIds: readonly string[]): void {
  const prior = states.get(from);
  if (!prior || sources.size === 0) return;
  const moved = (id: string) => [...reliedKeysOf(to[id]), ...reliedKeysOf(from[id])];
  const relevant = changedIds.some((id) => prior.byFact.has(id) || sourceKinds.has(to[id]?.kind ?? from[id]?.kind ?? "") || moved(id).some((k) => prior.byFact.has(k)));
  if (!relevant) {
    states.set(to, { byFact: prior.byFact, reliances: prior.reliances, stale: prior.stale, rechecks: 0 });
    return;
  }
  const next: ValidityState = { byFact: new Map([...prior.byFact].map(([k, v]) => [k, new Set(v)])), reliances: new Map(prior.reliances), stale: new Map(prior.stale), rechecks: 0 };
  const recheck = new Set<string>();
  for (const id of changedIds) {
    const el = to[id];
    if (sourceKinds.has(el?.kind ?? from[id]?.kind ?? "")) {
      if (el) file(next, to, el);
      else unfile(next, id);
    }
    for (const rec of next.byFact.get(id) ?? []) recheck.add(rec);
    for (const key of moved(id)) for (const rec of next.byFact.get(key) ?? []) recheck.add(rec);
  }
  for (const rec of recheck) check(next, to, rec, from);
  states.set(to, next);
}

registerRevisionCarry("validity", carry);

/** Every record whose reliance may no longer hold, by record id (from the index: no model scan). */
export function staleRecords(elements: Elements): ReadonlyMap<string, Validity & { readonly state: "may_not_hold" }> {
  return stateFor(elements).stale;
}

/** One record's validity, from the index. `holds` when it relies on nothing. */
export function recordValidity(elements: Elements, recordId: string): Validity {
  return stateFor(elements).stale.get(recordId) ?? { state: "holds" };
}

/** For tests and perf: how many records the last carry re-checked, and how many are filed. */
export function validityStats(elements: Elements): { readonly filed: number; readonly rechecks: number; readonly stale: number } {
  const s = stateFor(elements);
  return { filed: s.reliances.size, rechecks: s.rechecks, stale: s.stale.size };
}
