import { activePackSet, withModelStatePacks } from "../packs/scope";
import type { ModelState } from "../types";
import type { FindingDisposition } from "./disposition";
import { dispositionIndex, type DispositionIndex, type HeldDisposition } from "./record";
import type { FindingRef } from "./ref";
import "./sources/builtin";
import { FINDING_SOURCE_POINT, type FindingChange, type FindingChangeContext, type FindingSourceRow } from "./sources/point";
import { dispositionStanding, MAIN_VIEW, standingIsOpen, type DispositionStanding, type LineageView, type StandingOptions } from "./standing";

/**
 * One problem list (round 11, D2): every source's findings in one index,
 * updated by the ids an edit changed (like `bim-lint`'s `IndexState`), with
 * each finding's standing on this copy of the model read from the
 * disposition records (and any decisions a sign-off chain carries).
 *
 * The ledger never re-runs a producer over the whole model after an edit:
 * each source says what the edit moved (`FindingSourceRow.changed`), a host
 * feed passes the change it already computed (`apply(…, given)`), and a
 * source with few findings re-reads its own index.
 */

export interface LedgerEntry {
  readonly finding: FindingRef;
  readonly standing: DispositionStanding;
}

export interface LedgerDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface FindingLedgerOptions {
  /** The copy this ledger reads (its id and ancestors). Absent: Main. */
  readonly lineage?: LineageView;
  /** Host-only sources (lint, merge waits), beside the set in force's rows. */
  readonly feeds?: readonly FindingSourceRow[];
  readonly standing?: StandingOptions;
  /** Decisions not stored in the model: a sign-off chain's (`dispositionsFromSignoffRecords`). Read on every standing. */
  extraDispositions?(): readonly FindingDisposition[];
}

export interface LedgerStats {
  readonly findings: number;
  readonly subjects: number;
  /** Sources the last open or apply read in full. */
  readonly rereads: number;
  /** Milliseconds each source took in the last open or apply, by row id. */
  readonly sourceMs: Readonly<Record<string, number>>;
}

function sameFinding(a: FindingRef, b: FindingRef): boolean {
  if (a.severity !== b.severity || a.words !== b.words || a.source.version !== b.source.version || a.source.id !== b.source.id || a.subjects.length !== b.subjects.length) return false;
  for (let i = 0; i < a.subjects.length; i++) if (a.subjects[i] !== b.subjects[i]) return false;
  return a.fix?.commandHint === b.fix?.commandHint;
}

export class FindingLedger {
  private model: ModelState | null = null;
  private readonly byId = new Map<string, FindingRef>();
  private readonly sourceOf = new Map<string, string>();
  private readonly bySource = new Map<string, Map<string, FindingRef>>();
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly opened = new Set<string>();
  private rereads = 0;
  private sourceMs: Record<string, number> = {};
  private extraKey: readonly FindingDisposition[] | null = null;
  private extraIndex: { readonly base: DispositionIndex; readonly merged: DispositionIndex } | null = null;
  readonly lineage: LineageView;

  constructor(private readonly options: FindingLedgerOptions = {}) {
    this.lineage = options.lineage ?? MAIN_VIEW;
  }

  get revision(): number | null {
    return this.model?.revision ?? null;
  }

  private rows(model: ModelState): readonly FindingSourceRow[] {
    const fromSet = withModelStatePacks(model, () => activePackSet().items(FINDING_SOURCE_POINT));
    const feeds = this.options.feeds ?? [];
    if (feeds.length === 0) return fromSet;
    const ids = new Set(fromSet.map((r) => r.id));
    for (const f of feeds) {
      if (ids.has(f.id)) {
        const message = `[bim-kernel/findings] the ledger feed "${f.id}" has the id of a source row in the set`;
        console.error(message);
        throw new Error(message);
      }
    }
    return [...fromSet, ...feeds];
  }

  private run<T>(row: FindingSourceRow, what: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      console.error(`[bim-kernel/findings] the "${row.id}" source failed to ${what}`, err);
      throw err;
    }
  }

  private drop(id: string, delta: { removed: string[] }): void {
    const f = this.byId.get(id);
    if (!f) return;
    this.byId.delete(id);
    const src = this.sourceOf.get(id);
    this.sourceOf.delete(id);
    if (src) this.bySource.get(src)?.delete(id);
    for (const s of f.subjects) {
      const set = this.bySubject.get(s);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.bySubject.delete(s);
    }
    delta.removed.push(id);
  }

  private put(sourceId: string, f: FindingRef, delta: { added: string[]; changed: string[]; removed: string[] }, retired: ReadonlySet<string>): void {
    const had = this.byId.get(f.id);
    if (had && sameFinding(had, f) && this.sourceOf.get(f.id) === sourceId) return;
    if (had) {
      this.drop(f.id, { removed: [] });
      delta.changed.push(f.id);
    } else if (retired.has(f.id)) {
      // Retired and put back in the same change: it changed, it didn't go.
      const at = delta.removed.lastIndexOf(f.id);
      if (at >= 0) delta.removed.splice(at, 1);
      delta.changed.push(f.id);
    } else delta.added.push(f.id);
    this.byId.set(f.id, f);
    this.sourceOf.set(f.id, sourceId);
    let mine = this.bySource.get(sourceId);
    if (!mine) this.bySource.set(sourceId, (mine = new Map()));
    mine.set(f.id, f);
    for (const s of f.subjects) {
      let set = this.bySubject.get(s);
      if (!set) this.bySubject.set(s, (set = new Set()));
      set.add(f.id);
    }
  }

  private replaceAll(row: FindingSourceRow, found: readonly FindingRef[], delta: { added: string[]; changed: string[]; removed: string[] }): void {
    const keep = new Set(found.map((f) => f.id));
    const retired = new Set<string>();
    for (const id of [...(this.bySource.get(row.id)?.keys() ?? [])]) {
      if (keep.has(id)) continue;
      retired.add(id);
      this.drop(id, delta);
    }
    for (const f of found) this.put(row.id, f, delta, retired);
    this.rereads += 1;
  }

  /** Read every source in full: the list for an opened model. */
  open(model: ModelState): LedgerDelta {
    this.model = model;
    this.rereads = 0;
    const delta = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
    const ctx = { model, lineageId: this.lineage.lineageId };
    const live = new Set<string>();
    this.sourceMs = {};
    for (const row of this.rows(model)) {
      const t0 = performance.now();
      live.add(row.id);
      this.replaceAll(row, this.run(row, "read", () => row.all(ctx)), delta);
      this.opened.add(row.id);
      this.sourceMs[row.id] = performance.now() - t0;
    }
    for (const src of [...this.bySource.keys()]) if (!live.has(src)) this.forgetSource(src, delta);
    return delta;
  }

  private forgetSource(src: string, delta: { removed: string[] }): void {
    for (const id of [...(this.bySource.get(src)?.keys() ?? [])]) this.drop(id, delta);
    this.bySource.delete(src);
    this.opened.delete(src);
  }

  /**
   * The model moved to `model` with only `changedIds` changed or removed. `given`: changes a host
   * already computed, by source id (lint's before / after findings in the edit's scope).
   */
  apply(model: ModelState, changedIds: readonly string[], given?: ReadonlyMap<string, FindingChange>): LedgerDelta {
    const previous = this.model;
    if (!previous) return this.open(model);
    this.model = model;
    this.rereads = 0;
    const delta = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
    const live = new Set<string>();
    this.sourceMs = {};
    for (const row of this.rows(model)) {
      const t0 = performance.now();
      live.add(row.id);
      this.applyRow(row, model, previous, changedIds, given, delta);
      this.sourceMs[row.id] = performance.now() - t0;
    }
    for (const src of [...this.bySource.keys()]) if (!live.has(src)) this.forgetSource(src, delta);
    return delta;
  }

  private applyRow(row: FindingSourceRow, model: ModelState, previous: ModelState, changedIds: readonly string[], given: ReadonlyMap<string, FindingChange> | undefined, delta: { added: string[]; changed: string[]; removed: string[] }): void {
    if (!this.opened.has(row.id)) {
      this.replaceAll(row, this.run(row, "read", () => row.all({ model, lineageId: this.lineage.lineageId })), delta);
      this.opened.add(row.id);
      return;
    }
    const current = this.bySource.get(row.id) ?? new Map<string, FindingRef>();
    const ctx: FindingChangeContext = {
      model,
      previous,
      changedIds,
      lineageId: this.lineage.lineageId,
      current,
      touching: (ids) => this.touchingIn(ids, row.id),
    };
    const change = given?.get(row.id) ?? (row.changed ? this.run(row, "update", () => row.changed?.(ctx) ?? null) : "reread");
    if (change === null) return;
    if (change === "reread") {
      this.replaceAll(row, this.run(row, "read", () => row.all(ctx)), delta);
      return;
    }
    const retired = new Set<string>();
    const putIds = new Set(change.put.map((f) => f.id));
    for (const id of change.retire) {
      if (this.sourceOf.get(id) !== row.id) continue;
      if (putIds.has(id)) continue;
      retired.add(id);
      this.drop(id, delta);
    }
    for (const f of change.put) this.put(row.id, f, delta, retired);
  }

  private touchingIn(ids: Iterable<string>, sourceId: string | null): FindingRef[] {
    const seen = new Set<string>();
    const out: FindingRef[] = [];
    for (const s of ids) {
      for (const id of this.bySubject.get(s) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (sourceId !== null && this.sourceOf.get(id) !== sourceId) continue;
        const f = this.byId.get(id);
        if (f) out.push(f);
      }
    }
    return out;
  }

  /** Every finding, sorted: blocking first, then by id. */
  findings(): FindingRef[] {
    return [...this.byId.values()].sort((a, b) => (a.severity === b.severity ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.severity === "blocking" ? -1 : b.severity === "blocking" ? 1 : a.severity === "warning" ? -1 : b.severity === "warning" ? 1 : a.severity < b.severity ? -1 : 1));
  }

  get(id: string): FindingRef | undefined {
    return this.byId.get(id);
  }

  /** Findings that list any of `ids` as a subject (from the subject index, no scan). */
  touching(ids: Iterable<string>): FindingRef[] {
    return this.touchingIn(ids, null);
  }

  /** The disposition index in force: the model's records plus the extra decisions (merged once per change of either). */
  dispositions(): DispositionIndex {
    const model = this.model;
    if (!model) throw new Error("The finding ledger has not read a model yet");
    const base = dispositionIndex(model.elements);
    const extra = this.options.extraDispositions?.() ?? [];
    if (extra.length === 0) return base;
    if (this.extraIndex && this.extraIndex.base === base && this.extraKey === extra) return this.extraIndex.merged;
    const byFinding = new Map<string, HeldDisposition[]>();
    for (const [k, v] of base.byFinding) byFinding.set(k, [...v]);
    for (const d of extra) {
      const h: HeldDisposition = { disposition: d, recordId: null, recordedRevision: null };
      const list = byFinding.get(d.findingId);
      if (list) list.push(h);
      else byFinding.set(d.findingId, [h]);
    }
    const merged: DispositionIndex = { byFinding, count: base.count + extra.length, unreadable: base.unreadable };
    this.extraKey = extra;
    this.extraIndex = { base, merged };
    return merged;
  }

  standingOf(f: FindingRef): DispositionStanding {
    return dispositionStanding(f, this.dispositions(), this.lineage, this.options.standing);
  }

  /** Findings with their standing on this copy. `open`: only those that still need someone. */
  entries(filter: { readonly open?: boolean; readonly touching?: Iterable<string>; readonly source?: string } = {}): LedgerEntry[] {
    const index = this.dispositions();
    const list = filter.touching ? this.touching(filter.touching) : this.findings();
    const out: LedgerEntry[] = [];
    for (const f of list) {
      if (filter.source !== undefined && f.source.kind !== filter.source) continue;
      const standing = dispositionStanding(f, index, this.lineage, this.options.standing);
      if (filter.open === true && !standingIsOpen(standing)) continue;
      out.push({ finding: f, standing });
    }
    return out;
  }

  /**
   * The decisions in force on findings touching `ids`: what a signer whose
   * approval covers those elements signs with it (`signedDispositionsSection`).
   */
  dispositionsTouching(ids: Iterable<string>): FindingDisposition[] {
    const out: FindingDisposition[] = [];
    for (const e of this.entries({ touching: ids })) if (e.standing.state === "disposed") out.push(e.standing.disposition);
    return out;
  }

  stats(): LedgerStats {
    return { findings: this.byId.size, subjects: this.bySubject.size, rereads: this.rereads, sourceMs: { ...this.sourceMs } };
  }
}
