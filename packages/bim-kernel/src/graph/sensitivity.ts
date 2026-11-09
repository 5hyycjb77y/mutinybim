import { withModelStatePacks } from "../packs/scope";
import type { BimElement, ModelState } from "../types";
import { ruleKeyOf } from "./compile";
import { graphStateIn, type CompiledSet, type GraphState } from "./engine";
import { anchorKeyOf } from "./inputs";
import { kindWords, nameOf, valueWords } from "./names";
import type { RequirementsSourcePin } from "./source";
import { isDeterminationRecord } from "./records";
import { GRAPH_ANSWER_LIMIT, type NodeRef, type Requirement } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Sensitivity: what drives the most requirements (round 8b lane N).
 *
 * Every (rule, anchor) evaluation notes the element ids it read, and the
 * graph keeps a reverse index from those ids to the evaluations (engine.ts).
 * An input "drives" a requirement when the requirement's evaluation read it
 * and the requirement isn't anchored on the input itself (every room reads
 * itself; that says nothing). Counted per governing requirement, the way the
 * Checklist counts, with how many of them still need someone.
 *
 *   sensitivityOf(model, id)     one input: the requirements it drives, from
 *                                the reverse index (its readers only)
 *   sensitivityRanking(model)    the inputs that drive the most, ranked, at
 *                                most five then "and N more"
 *
 * The ranking never walks the model. It walks the anchors the graph has
 * derived (the Checklist derives every anchor before it asks) and keeps
 * per-input counts carried across revisions: after an edit only the anchors
 * whose requirements were re-derived are counted again, and a revision
 * already counted answers from its cache.
 */

export interface SensitivityItem {
  readonly node: NodeRef;
  /** "Room 104 occupancy (B)", "Zone East", "The model jurisdiction (VA)". */
  readonly label: string;
  /** Governing requirements whose evaluation read this input (not those anchored on it). */
  readonly drives: number;
  /** How many of those still need attention. */
  readonly open: number;
  /** "Room 104 occupancy (B) drives 14 requirements; 3 still open". */
  readonly words: string;
}

export interface SensitivityRanking {
  readonly items: readonly SensitivityItem[];
  /** Inputs that drive something beyond the ones shown. */
  readonly more: number;
  /** Every input that drives at least one requirement. */
  readonly inputs: number;
  readonly empty?: string;
}

export interface SensitivityLine {
  readonly requirement: Requirement;
  /** "Head spacing in Room 104". */
  readonly words: string;
  readonly open: boolean;
}

export interface Sensitivity extends SensitivityItem {
  /** The requirements it drives, most in need first. */
  readonly requirements: readonly Requirement[];
  /** The same, as the Checklist lists them. */
  readonly lines: readonly SensitivityLine[];
}

export const SENSITIVITY_EMPTY = "Nothing in the model drives a requirement yet. Requirements appear once a code study or add-on applies to a room, a zone or the model.";

/** Whether a requirement still needs someone: not withdrawn, and not met, or met but neither verified in the model nor in its code study. */
export function isOpenRequirement(r: Requirement): boolean {
  if (r.status === "withdrawn") return false;
  if (r.fulfilment.state !== "met") return true;
  return r.status === "proposed" && r.ruleVerification !== "verified";
}

const counts = (r: Requirement): boolean => r.standing !== "conflicting";

/**
 * The ids that drive a requirement: what its rule's evaluation read, plus what
 * the evaluations of the rules that relaxed or tightened it read (a design
 * choice drives the limit it relaxed). Element ids only, never
 * the requirement's own anchor.
 */
function drivers(state: GraphState, r: Requirement): Set<string> {
  const out = new Set<string>();
  const add = (reads: readonly string[]) => {
    for (const id of reads) if (id !== r.anchor.id && !id.startsWith("slot:")) out.add(id);
  };
  add(r.reads);
  if (r.effects && r.effects.length > 0) {
    const anchorKey = anchorKeyOf({ kind: r.anchor.kind, id: r.anchor.id });
    for (const e of r.effects) add(state.evaluation(anchorKey, ruleKeyOf(e.provider, e.ruleId))?.reads ?? []);
  }
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How the Checklist names an input. */
export function sensitivityLabel(elements: Elements, id: string): string {
  const el = elements[id];
  if (!el) return id;
  if (isDeterminationRecord(el)) {
    const d = el.determination;
    const subject = d.subject.id ? nameOf(elements[d.subject.id], d.subject.id) : "The model";
    return `${subject} ${d.key.replace(/[._]/g, " ")} (${valueWords(d.value, d.unit)})`;
  }
  const named = nameOf(el, id);
  const base = named === id ? `${capitalise(kindWords(el))} ${id}` : named;
  const spaceId: unknown = "spaceId" in el ? (el as { readonly spaceId?: unknown }).spaceId : undefined;
  if (typeof spaceId === "string" && el.kind !== "space") {
    const room = elements[spaceId];
    if (room) return `${base} in ${nameOf(room, spaceId)}`;
  }
  return base;
}

function nodeOf(elements: Elements, id: string): NodeRef {
  const el = elements[id];
  if (!el) return { kind: "input", id };
  if (isDeterminationRecord(el)) return { kind: "determination", id };
  if (el.kind === "space" || el.kind === "zone") return { kind: el.kind, id };
  return { kind: "element", id };
}

function sensitivityWords(label: string, drives: number, open: number): string {
  const n = `${drives.toLocaleString("en-US")} requirement${drives === 1 ? "" : "s"}`;
  const o = open === 0 ? "none open" : open === drives ? (drives === 1 ? "still open" : "all still open") : `${open.toLocaleString("en-US")} still open`;
  return `${label} drives ${n}; ${o}`;
}

function item(elements: Elements, id: string, drives: number, open: number): SensitivityItem {
  const label = sensitivityLabel(elements, id);
  return { node: nodeOf(elements, id), label, drives, open, words: sensitivityWords(label, drives, open) };
}

// ── one input, from the reverse index ──────────────────────────────────────

/** The requirements one input drives, read from the graph's reverse index (its readers only, no model walk). */
export function sensitivityOf(model: ModelState, id: string): Sensitivity {
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    const found = new Map<string, Requirement>();
    const anchors = new Set<string>();
    for (const ev of state.evaluationsReading(id)) anchors.add(ev.anchorKey);
    for (const anchorKey of anchors) {
      const entry = state.anchors.get(anchorKey);
      if (!entry) continue;
      for (const r of state.requirementsAt(entry.ref)) if (counts(r) && drivers(state, r).has(id)) found.set(r.id, r);
    }
    const requirements = [...found.values()].sort((a, b) => Number(isOpenRequirement(b)) - Number(isOpenRequirement(a)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const lines = requirements.map((r): SensitivityLine => ({ requirement: r, words: `${r.title} in ${r.anchor.id === null ? "the model" : nameOf(model.elements[r.anchor.id], r.anchor.id)}`, open: isOpenRequirement(r) }));
    const open = lines.filter((l) => l.open).length;
    return { ...item(model.elements, id, requirements.length, open), requirements, lines };
  });
}

// ── the ranking, counted incrementally per graph state ─────────────────────

interface Tally {
  drives: number;
  open: number;
}

interface AnchorCount {
  readonly key: string;
  readonly requirements: readonly Requirement[];
  /** Per driving id: [drives, open] this anchor adds. */
  readonly adds: ReadonlyMap<string, readonly [number, number]>;
}

class SensitivityTracker {
  private readonly tallies = new Map<string, Tally>();
  /** drives → open → the ids with those counts (few distinct counts, so ranking sorts the counts, not the ids). */
  private readonly buckets = new Map<number, Map<number, Set<string>>>();
  /** Keyed by the graph's own anchor entry (identity): a dropped and re-made anchor is a new entry. */
  private readonly byEntry = new Map<object, AnchorCount>();
  private syncedBound: Elements | null = null;
  private syncedCompiled: CompiledSet | null = null;
  private syncedPins: readonly RequirementsSourcePin[] | null = null;
  private syncedAnchors = -1;
  private readonly answers = new Map<number, SensitivityRanking>();
  /** Anchors re-counted by the last sync (tests and perf). */
  lastRecounted = 0;

  private bucketOf(drives: number, open: number, make: boolean): Set<string> | undefined {
    let byOpen = this.buckets.get(drives);
    if (!byOpen) {
      if (!make) return undefined;
      byOpen = new Map();
      this.buckets.set(drives, byOpen);
    }
    let ids = byOpen.get(open);
    if (!ids && make) {
      ids = new Set();
      byOpen.set(open, ids);
    }
    return ids;
  }

  private unbucket(id: string, drives: number, open: number): void {
    const byOpen = this.buckets.get(drives);
    const ids = byOpen?.get(open);
    if (!byOpen || !ids) return;
    ids.delete(id);
    if (ids.size > 0) return;
    byOpen.delete(open);
    if (byOpen.size === 0) this.buckets.delete(drives);
  }

  private move(id: string, dDrives: number, dOpen: number): void {
    const prior = this.tallies.get(id);
    if (prior) this.unbucket(id, prior.drives, prior.open);
    const drives = (prior?.drives ?? 0) + dDrives;
    const open = (prior?.open ?? 0) + dOpen;
    if (drives <= 0) {
      this.tallies.delete(id);
      return;
    }
    if (prior) {
      prior.drives = drives;
      prior.open = open;
    } else this.tallies.set(id, { drives, open });
    this.bucketOf(drives, open, true)?.add(id);
  }

  private apply(adds: ReadonlyMap<string, readonly [number, number]>, sign: 1 | -1): void {
    for (const [id, [d, o]] of adds) this.move(id, sign * d, sign * o);
  }

  /** Bring the counts up to the state's derived anchors. False when nothing changed since the last sync. */
  sync(state: GraphState): boolean {
    if (this.syncedBound === state.bound && this.syncedCompiled === state.compiled && this.syncedPins === state.pins && this.syncedAnchors === state.anchors.size) {
      this.lastRecounted = 0;
      return false;
    }
    const known = this.byEntry.size;
    let seen = 0;
    let recounted = 0;
    for (const entry of state.anchors.values()) {
      const requirements = entry.requirements ?? state.requirementsAt(entry.ref);
      const prior = this.byEntry.get(entry);
      if (prior) {
        seen += 1;
        if (prior.requirements === requirements) continue;
        this.apply(prior.adds, -1);
      }
      recounted += 1;
      const adds = new Map<string, [number, number]>();
      for (const r of requirements) {
        if (!counts(r)) continue;
        const open = isOpenRequirement(r) ? 1 : 0;
        for (const id of drivers(state, r)) {
          const a = adds.get(id);
          if (a) {
            a[0] += 1;
            a[1] += open;
          } else adds.set(id, [1, open]);
        }
      }
      this.apply(adds, 1);
      this.byEntry.set(entry, { key: entry.key, requirements, adds });
    }
    // Every entry counted before was seen again: none was dropped, so no second pass.
    if (seen < known) {
      for (const [entry, a] of this.byEntry) {
        if (state.anchors.get(a.key) === entry) continue;
        this.apply(a.adds, -1);
        this.byEntry.delete(entry);
        recounted += 1;
      }
    }
    this.syncedBound = state.bound;
    this.syncedCompiled = state.compiled;
    this.syncedPins = state.pins;
    this.syncedAnchors = state.anchors.size;
    this.answers.clear();
    this.lastRecounted = recounted;
    return true;
  }

  ranking(elements: Elements, limit: number): SensitivityRanking {
    const cached = this.answers.get(limit);
    if (cached) return cached;
    const picked: { id: string; drives: number; open: number }[] = [];
    // Most driven first, then most still open, then by id (so the answer never depends on edit order).
    for (const drives of [...this.buckets.keys()].sort((x, y) => y - x)) {
      const byOpen = this.buckets.get(drives);
      if (!byOpen) continue;
      for (const open of [...byOpen.keys()].sort((x, y) => y - x)) {
        const room = limit - picked.length;
        if (room <= 0) break;
        const best: string[] = [];
        for (const id of byOpen.get(open) ?? []) {
          const last = best[best.length - 1];
          if (best.length === room && last !== undefined && id >= last) continue;
          let at = best.length;
          while (at > 0 && id < (best[at - 1] ?? "")) at -= 1;
          best.splice(at, 0, id);
          if (best.length > room) best.pop();
        }
        for (const id of best) picked.push({ id, drives, open });
      }
      if (picked.length >= limit) break;
    }
    const items = picked.map(({ id, drives, open }) => item(elements, id, drives, open));
    const answer: SensitivityRanking = { items, more: Math.max(0, this.tallies.size - items.length), inputs: this.tallies.size, ...(items.length === 0 ? { empty: SENSITIVITY_EMPTY } : {}) };
    this.answers.set(limit, answer);
    return answer;
  }
}

const trackers = new WeakMap<GraphState, SensitivityTracker>();

function trackerOf(state: GraphState): SensitivityTracker {
  let t = trackers.get(state);
  if (!t) {
    t = new SensitivityTracker();
    trackers.set(state, t);
  }
  return t;
}

/** The inputs that drive the most requirements, most first; at most `limit` (five), then "and N more". */
export function sensitivityRanking(model: ModelState, options: { readonly limit?: number } = {}): SensitivityRanking {
  const limit = Math.max(0, options.limit ?? GRAPH_ANSWER_LIMIT);
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    const tracker = trackerOf(state);
    tracker.sync(state);
    return tracker.ranking(model.elements, limit);
  });
}

/** How many anchors the last ranking re-counted (tests and perf: an unrelated revision re-counts a handful, a repeat none). */
export function sensitivityRecounted(model: ModelState): number {
  return withModelStatePacks(model, () => trackerOf(graphStateIn(model)).lastRecounted);
}
