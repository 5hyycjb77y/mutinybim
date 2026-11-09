import { convert, fromSI, isUnitCode, unitAllowed } from "@permitzip/bim-units";
import { withModelStatePacks, activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { registerRevisionCarry } from "../revision-carry";
import { spaceOf } from "../spaces/space-index";
import { elementsOfKind, recordsOfKinds } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { GRAPH_OWN_ANCHOR_KINDS, anchorKindTable } from "./anchors";
import { GraphAux, isLocatedKind, slot, subjectKeyOf } from "./auxiliary";
import { compileRule, compileSnapshot, readRuleOnce, ruleKeyOf, type CompiledRule } from "./compile";
import { evaluateRuleFormula, parameterInputs, quantityInput, scalarInput, valueInUnit, type InputValue } from "./formula";
import { anchorKeyOf, determinationWords, InputReader, ReadNote, type AnchorRef, type Delivered } from "./inputs";
import { nameOf, valueWords } from "./names";
import { PreviewAux } from "./preview-aux";
import { isDeterminationRecord } from "./records";
import { boundSnapshots, snapshotGeneration } from "./snapshots";
import { REQUIREMENTS_SOURCE_POINT, type RequirementsSourcePin } from "./source";
import { LOCAL_SOURCE_ID, localRules } from "./sources/local";
import { requirementIdOf, type DeterminationElement, type FulfilmentState, type Requirement, type RequirementEffectApplied, type RequirementId, type RuleRecord } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The requirements graph engine (contract 1.4.0, REQUIREMENTS-GRAPH §1, §6).
 *
 * Requirements are derived, never stored: every bound source's rules
 * (host snapshots, add-on rows at `kernel.requirements_source`, the model's
 * own `local` rules) are evaluated per anchor (a space, a zone, an element
 * or the model) and cached per (model revision, snapshot revisions). Only a
 * person's verification, override or withdrawal is stored, as a
 * `requirement_state` record.
 *
 * Incremental by declared reads: each (rule, anchor) evaluation notes the
 * element ids and slots it read; an indexed reverse map from those to the
 * evaluations is carried across revisions (`registerRevisionCarry`), so an
 * edit re-runs only the evaluations whose reads it touched, and an
 * unrelated edit re-runs none. Anchors are evaluated on first read, so a
 * "why" or "what depends" on one element reads its neighbourhood only.
 */

export interface SourceBinding {
  readonly id: string;
  readonly label: string;
  readonly origin: "snapshot" | "pack" | "local";
  /** Default precedence when no pin names the source: snapshots, then add-ons, then local. */
  readonly index: number;
  readonly revision: string;
}

export interface CompiledSet {
  readonly rules: ReadonlyMap<string, CompiledRule>;
  readonly bySpaceUse: ReadonlyMap<string, readonly CompiledRule[]>;
  readonly spaceAny: readonly CompiledRule[];
  readonly zone: readonly CompiledRule[];
  readonly model: readonly CompiledRule[];
  readonly elementByClass: ReadonlyMap<string, readonly CompiledRule[]>;
  /** Rules by an anchor kind beyond the graph's own four (`site`, `parcel`, `gate`, `lineage`, an add-on's; round 11). */
  readonly byAnchorKind: ReadonlyMap<string, readonly CompiledRule[]>;
  readonly effects: readonly CompiledRule[];
  readonly sources: readonly SourceBinding[];
}

interface TemplateOutput {
  readonly index: number;
  readonly value: number | string | boolean | null;
  readonly problem?: string;
  readonly delivered?: Delivered;
}

interface Evaluation {
  readonly id: number;
  readonly ruleKey: string;
  readonly anchorKey: string;
  readonly applies: boolean;
  readonly outputs: readonly TemplateOutput[];
  readonly reads: readonly string[];
  readonly determinations: readonly DeterminationElement[];
  /** Inputs kept for design-choice effects (rules with `relaxes` only). */
  readonly inputs?: ReadonlyMap<string, InputValue | null>;
  /** An input the rule narrows on that the anchor lacks ("no occupancy determination yet"). */
  readonly needs?: string;
}

interface AnchorEntry {
  readonly key: string;
  readonly ref: AnchorRef;
  readonly evals: Map<string, number>;
  dirty: Set<string>;
  /** `CompiledSet` generation the candidate rules were taken from; -1: recompute (the anchor itself changed). */
  candidatesOf: number;
  requirements: readonly Requirement[] | null;
}

export interface GraphStats {
  /** (rule, anchor) evaluations run since the state was made. */
  readonly ruleRuns: number;
  readonly evaluations: number;
  /** Live reverse-index entries (read id or slot → evaluation). */
  readonly edges: number;
  readonly reverseKeys: number;
  readonly anchors: number;
  readonly rules: number;
}

const MAX_PENDING_IDS = 20_000;

let nextStateId = 1;

export class GraphState {
  readonly stateId = nextStateId++;
  bound: Elements;
  readonly modelId: string;
  readonly aux: GraphAux;
  private packSet: PackSet;
  private snapGen = -1;
  private sourceRules = new Map<string, readonly CompiledRule[]>();
  compiled: CompiledSet;
  private compiledGen = 0;
  private pinsKey = "";
  pins: readonly RequirementsSourcePin[] = [];
  readonly anchors = new Map<string, AnchorEntry>();
  private readonly evals: (Evaluation | undefined)[] = [];
  private dead = 0;
  private readonly reverse = new Map<string, number[]>();
  private readonly byRule = new Map<string, Set<string>>();
  readonly requirementAnchor = new Map<RequirementId, string>();
  private sourcesStale = true;
  ruleRuns = 0;
  /** Set when this state moved off a record: that record and the ids it changed since. */
  lastFrom: Elements | null = null;
  lastChanged: readonly string[] = [];
  private reader: { readonly elements: Elements; readonly byAnchor: Map<string, InputReader> } | null = null;

  constructor(
    model: ModelState,
    readonly ephemeral = false,
    base?: GraphState,
    /** A preview's touched ids: its indexes fork from `base`'s instead of being rebuilt. */
    changed?: readonly string[],
  ) {
    this.bound = model.elements;
    this.modelId = model.modelId;
    this.aux = base && changed ? new PreviewAux(base.aux, model.elements, changed) : new GraphAux(model.elements);
    this.packSet = activePackSet();
    this.compiled = base?.compiled ?? EMPTY_SET;
    if (base) {
      this.sourceRules = new Map(base.sourceRules);
      this.snapGen = base.snapGen;
      this.compiledGen = base.compiledGen;
      this.sourcesStale = false;
    }
    this.setPins(model);
  }

  private setPins(model: ModelState): boolean {
    const pins = model.settings.requirementsSources ?? [];
    const key = JSON.stringify(pins);
    if (key === this.pinsKey) return false;
    this.pinsKey = key;
    this.pins = pins;
    return true;
  }

  /** Bring the bindings up to date with the model, the pack set and the host's snapshots. False: start a fresh state (the pack set changed). */
  refresh(model: ModelState): boolean {
    if (activePackSet() !== this.packSet) return false;
    if (this.setPins(model)) for (const e of this.anchors.values()) e.requirements = null;
    if (this.sourcesStale || this.snapGen !== snapshotGeneration()) this.rebindSources(model);
    return true;
  }

  private rebindSources(model: ModelState): void {
    this.sourcesStale = false;
    this.snapGen = snapshotGeneration();
    const next = new Map<string, readonly CompiledRule[]>();
    const bindings: SourceBinding[] = [];
    const keepIfSame = (id: string, rules: readonly CompiledRule[]): readonly CompiledRule[] => {
      const prior = this.sourceRules.get(id);
      return prior && prior.length === rules.length && prior.every((r, i) => r === rules[i]) ? prior : rules;
    };
    for (const s of boundSnapshots(this.modelId)) {
      next.set(s.source.id, keepIfSame(s.source.id, compileSnapshot(s).rules));
      bindings.push({ id: s.source.id, label: s.source.label, origin: "snapshot", index: bindings.length, revision: s.revision });
    }
    for (const row of activePackSet().items(REQUIREMENTS_SOURCE_POINT)) {
      const id = row.descriptor.id;
      if (next.has(id) || id === LOCAL_SOURCE_ID) continue;
      let rules: readonly unknown[] = [];
      try {
        rules = row.rules(model);
      } catch (err) {
        console.error(`[bim-kernel/graph] requirements source ${id} failed to read its rules; it supplies none this revision`, err);
      }
      const read: CompiledRule[] = [];
      for (const raw of rules) {
        const r = readRuleOnce(raw, id);
        if (r) read.push(compileRule(r));
      }
      next.set(id, keepIfSame(id, read));
      bindings.push({ id, label: row.descriptor.label, origin: "pack", index: bindings.length, revision: row.descriptor.version });
    }
    next.set(LOCAL_SOURCE_ID, keepIfSame(LOCAL_SOURCE_ID, localRules(model.elements).map(compileRule)));
    bindings.push({ id: LOCAL_SOURCE_ID, label: "This model's code studies", origin: "local", index: bindings.length, revision: "model" });

    // Which rules changed: by rule object identity, per source.
    let changed = next.size !== this.sourceRules.size || this.compiled === EMPTY_SET;
    const killed = new Set<string>();
    for (const [id, rules] of this.sourceRules) {
      const now = next.get(id);
      if (now === rules) continue;
      changed = true;
      const keep = new Set<CompiledRule>(now ?? []);
      for (const r of rules) if (!keep.has(r)) killed.add(r.key);
    }
    if (!changed) return;
    this.sourceRules = next;
    this.compiled = buildCompiledSet(next, bindings);
    this.compiledGen += 1;
    for (const key of killed) this.killRule(key);
  }

  private killRule(ruleKey: string): void {
    for (const anchorKey of this.byRule.get(ruleKey) ?? []) {
      const entry = this.anchors.get(anchorKey);
      if (!entry) continue;
      const id = entry.evals.get(ruleKey);
      if (id !== undefined) this.killEval(id);
      entry.evals.delete(ruleKey);
      entry.requirements = null;
    }
    this.byRule.delete(ruleKey);
  }

  private killEval(id: number): void {
    if (this.evals[id] === undefined) return;
    this.evals[id] = undefined;
    this.dead += 1;
  }

  /**
   * Move onto `next`, a record that differs from the bound one only at
   * `changed` (added, written or removed), marking dirty only what read them.
   */
  advance(next: Elements, changed: readonly string[]): void {
    const prev = this.bound;
    const dirty = new Set<number>();
    const note = (key: string) => {
      for (const id of this.reverse.get(key) ?? []) if (this.evals[id]) dirty.add(id);
    };
    let rulesChanged = false;
    for (const id of changed) {
      note(id);
      const before = prev[id];
      const after = next[id];
      if (before?.kind === "rule" || after?.kind === "rule") rulesChanged = true;
      for (const kind of ["space", "zone", "element"] as const) {
        const entry = this.anchors.get(`${kind}:${id}`);
        if (!entry) continue;
        if (!after) this.dropAnchor(entry);
        else {
          entry.candidatesOf = -1;
          for (const r of entry.evals.keys()) entry.dirty.add(r);
          entry.requirements = null;
        }
      }
    }
    const statesChanged = this.aux.advance(next, changed);
    for (const id of changed) {
      const after = next[id];
      if (after) for (const s of slotsOf(next, this.aux, after)) note(s);
    }
    for (const id of dirty) {
      const ev = this.evals[id];
      if (!ev) continue;
      const entry = this.anchors.get(ev.anchorKey);
      if (!entry) continue;
      entry.dirty.add(ev.ruleKey);
      entry.requirements = null;
    }
    for (const reqId of statesChanged) {
      const anchorKey = this.requirementAnchor.get(reqId) ?? anchorKeyFromRequirementId(reqId, next);
      const entry = anchorKey ? this.anchors.get(anchorKey) : undefined;
      if (entry) entry.requirements = null;
    }
    if (rulesChanged) this.sourcesStale = true;
    // Add-on rows read the model: ask them again (identical rule objects cost nothing).
    if (this.compiled.sources.some((s) => s.origin === "pack")) this.sourcesStale = true;
    this.lastFrom = prev;
    this.lastChanged = changed;
    this.bound = next;
    this.reader = null;
    if (this.dead > 1000 && this.dead > this.evals.length / 2) this.compact();
  }

  private dropAnchor(entry: AnchorEntry): void {
    for (const [ruleKey, id] of entry.evals) {
      this.killEval(id);
      this.byRule.get(ruleKey)?.delete(entry.key);
    }
    for (const r of entry.requirements ?? []) this.requirementAnchor.delete(r.id);
    this.anchors.delete(entry.key);
  }

  private compact(): void {
    for (const [key, list] of this.reverse) {
      const live = list.filter((id) => this.evals[id] !== undefined);
      if (live.length === 0) this.reverse.delete(key);
      else this.reverse.set(key, live);
    }
    this.dead = 0;
  }

  private readerFor(ref: AnchorRef): InputReader {
    if (!this.reader || this.reader.elements !== this.bound) this.reader = { elements: this.bound, byAnchor: new Map() };
    const key = anchorKeyOf(ref);
    let r = this.reader.byAnchor.get(key);
    if (!r) {
      r = new InputReader(this.bound, this.aux, ref);
      this.reader.byAnchor.set(key, r);
    }
    return r;
  }

  /** The candidate rules at an anchor, from the compiled set's indexes. */
  private candidates(ref: AnchorRef): CompiledRule[] {
    const set = this.compiled;
    const out = new Set<CompiledRule>(set.effects);
    if (ref.kind === "model") for (const r of set.model) out.add(r);
    else if (ref.kind === "zone") for (const r of set.zone) out.add(r);
    else if (ref.kind === "space" && ref.id) {
      const el = this.bound[ref.id];
      const use = el?.kind === "space" ? el.use?.useId : undefined;
      for (const r of set.spaceAny) out.add(r);
      if (use) for (const r of set.bySpaceUse.get(use) ?? []) out.add(r);
    } else if (ref.kind === "element" && ref.id) {
      for (const c of this.aux.classesWithAncestors(ref.id as ElementId)) for (const r of set.elementByClass.get(c) ?? []) out.add(r);
    } else {
      for (const r of set.byAnchorKind.get(ref.kind) ?? []) out.add(r);
    }
    return [...out];
  }

  entry(ref: AnchorRef): AnchorEntry {
    const key = anchorKeyOf(ref);
    let entry = this.anchors.get(key);
    if (!entry) {
      entry = { key, ref, evals: new Map(), dirty: new Set(), candidatesOf: -1, requirements: null };
      this.anchors.set(key, entry);
    }
    return entry;
  }

  /** The anchor's requirements, evaluating what is dirty first. */
  requirementsAt(ref: AnchorRef): readonly Requirement[] {
    const entry = this.entry(ref);
    if (entry.candidatesOf !== this.compiledGen) {
      const want = new Map(this.candidates(ref).map((r) => [r.key, r]));
      for (const [ruleKey, id] of [...entry.evals]) {
        if (want.has(ruleKey)) continue;
        this.killEval(id);
        entry.evals.delete(ruleKey);
        this.byRule.get(ruleKey)?.delete(entry.key);
        entry.requirements = null;
      }
      for (const ruleKey of want.keys()) if (!entry.evals.has(ruleKey)) entry.dirty.add(ruleKey);
      entry.candidatesOf = this.compiledGen;
    }
    if (entry.dirty.size > 0) {
      for (const ruleKey of entry.dirty) {
        const prior = entry.evals.get(ruleKey);
        if (prior !== undefined) this.killEval(prior);
        const rule = this.compiled.rules.get(ruleKey);
        if (!rule) {
          entry.evals.delete(ruleKey);
          continue;
        }
        const ev = this.evaluate(rule, entry);
        entry.evals.set(ruleKey, ev.id);
        let anchors = this.byRule.get(ruleKey);
        if (!anchors) {
          anchors = new Set();
          this.byRule.set(ruleKey, anchors);
        }
        anchors.add(entry.key);
      }
      entry.dirty = new Set();
      entry.requirements = null;
    }
    if (!entry.requirements) {
      entry.requirements = this.combine(entry);
      for (const r of entry.requirements) this.requirementAnchor.set(r.id, entry.key);
    }
    return entry.requirements;
  }

  /** The live evaluations that read an id or slot. */
  evaluationsReading(key: string): Evaluation[] {
    const out: Evaluation[] = [];
    for (const id of this.reverse.get(key) ?? []) {
      const ev = this.evals[id];
      if (ev) out.push(ev);
    }
    return out;
  }

  /** How many live evaluations read an id or slot (a node's reach, for ranking). */
  readersOf(key: string): number {
    let n = 0;
    for (const id of this.reverse.get(key) ?? []) if (this.evals[id]) n += 1;
    return n;
  }

  /** How many anchors a rule has been evaluated at. */
  reachOfRule(ruleKey: string): number {
    return this.byRule.get(ruleKey)?.size ?? 0;
  }

  evaluation(anchorKey: string, ruleKey: string): Evaluation | undefined {
    const id = this.anchors.get(anchorKey)?.evals.get(ruleKey);
    return id === undefined ? undefined : this.evals[id];
  }

  private record(ev: Omit<Evaluation, "id">): Evaluation {
    const id = this.evals.length;
    const full: Evaluation = { ...ev, id };
    this.evals.push(full);
    for (const key of ev.reads) {
      const list = this.reverse.get(key);
      if (list) list.push(id);
      else this.reverse.set(key, [id]);
    }
    return full;
  }

  private evaluate(cr: CompiledRule, entry: AnchorEntry): Evaluation {
    this.ruleRuns += 1;
    const reader = this.readerFor(entry.ref);
    const note = new ReadNote();
    if (entry.ref.id) note.id(entry.ref.id);
    const rule = cr.rule;
    const base = { ruleKey: cr.key, anchorKey: entry.key };
    const finish = (applies: boolean, outputs: readonly TemplateOutput[], inputs?: ReadonlyMap<string, InputValue | null>, needs?: string): Evaluation =>
      this.record({ ...base, applies, outputs, reads: [...note.reads], determinations: [...note.determinations.values()], ...(inputs && cr.effects.length > 0 ? { inputs } : {}), ...(needs ? { needs } : {}) });

    // Where and when (round 11): tied to anchors or stages, every listed field narrows.
    const at = rule.appliesAt;
    if (at?.anchors && at.anchors.length > 0 && !at.anchors.some((x) => x.kind === entry.ref.kind && (x.id ?? null) === entry.ref.id)) return finish(false, []);
    if (at?.stages && at.stages.length > 0) {
      const stage = reader.currentStage(note);
      if (stage?.type !== "text" || !at.stages.includes(stage.value)) return finish(false, []);
    }

    // Applicability: every stated field narrows.
    const a = rule.applies;
    if (a.spaceUses && a.spaceUses.length > 0) {
      const use = reader.spaceUse(note);
      if (!use || !a.spaceUses.includes(use)) return finish(false, []);
    }
    if (a.jurisdiction && a.jurisdiction.length > 0) {
      const d = reader.read("model.jurisdiction", note);
      if (d && (d.type !== "text" || !a.jurisdiction.includes(d.value))) return finish(false, []);
    }
    if (a.editions && a.editions.length > 0) {
      const d = reader.read("model.edition", note);
      if (d && (d.type !== "text" || !a.editions.includes(d.value))) return finish(false, []);
    }
    let needs: string | undefined;
    if (a.occupancy && a.occupancy.length > 0) {
      const d = reader.determination("occupancy", note);
      if (!d) needs = `${reader.label()} has no occupancy determination yet; record one to check this`;
      else if (!a.occupancy.includes(String(d.determination.value))) return finish(false, []);
    }
    if (a.classes && a.classes.length > 0 && entry.ref.kind === "space" && !reader.holdsAnyOf(a.classes, note)) return finish(false, []);

    const params = parameterInputs(rule);
    const inputs = new Map<string, InputValue | null>();
    for (const f of cr.fields) {
      if (f === "value") continue;
      inputs.set(f, f.startsWith("param.") ? (params.get(f) ?? null) : reader.read(f, note));
    }
    if (cr.when) {
      if (!cr.when.fields) return finish(false, [{ index: -1, value: null, problem: `its condition "${cr.when.source}" doesn't read as a formula` }]);
      const w = evaluateRuleFormula(rule, cr.when.source, cr.when.fields, inputs);
      if (!w.ok || w.value.type !== "boolean" || !w.value.value) return finish(false, [], inputs);
    }
    const outputs: TemplateOutput[] = [];
    cr.templates.forEach((t, index) => {
      if (t.template.anchor !== entry.ref.kind) return;
      const delivered = t.template.delivered ? reader.delivered(t.template.delivered, note) : undefined;
      const withDelivered = (o: { value: number | string | boolean | null; problem?: string }): TemplateOutput => ({ index, ...o, ...(delivered ? { delivered } : {}) });
      if (rule.manual) {
        outputs.push(withDelivered({ value: null, problem: "this rule has no model check; a person fills it" }));
        return;
      }
      if (needs) {
        outputs.push(withDelivered({ value: null, problem: needs }));
        return;
      }
      if (!t.value.fields) {
        outputs.push(withDelivered({ value: null, problem: `its formula "${t.value.source}" doesn't read` }));
        return;
      }
      const r = evaluateRuleFormula(rule, t.value.source, t.value.fields, inputs, t.expect);
      if (!r.ok) {
        outputs.push(withDelivered({ value: null, problem: "missing" in r ? `needs ${r.missing.map((m) => m.replace(/[._]/g, " ")).join(", ")} for ${reader.label()}` : `its formula can't be worked out: ${r.problem}` }));
        return;
      }
      const v = valueInUnit(r.value, t.template.unit);
      outputs.push(withDelivered(v.ok ? { value: v.value } : { value: null, problem: v.problem }));
    });
    return finish(true, outputs, inputs, needs);
  }

  private rank(provider: string, discipline: string): number {
    const pin = this.pins.find((p) => p.discipline === discipline) ?? this.pins.find((p) => p.discipline === "*");
    const at = pin ? pin.sources.indexOf(provider) : -1;
    if (at >= 0) return at;
    const binding = this.compiled.sources.find((s) => s.id === provider);
    return 1000 + (binding?.index ?? 999);
  }

  private combine(entry: AnchorEntry): Requirement[] {
    const reader = this.readerFor(entry.ref);
    const anchorLabel = reader.label();
    interface Draft {
      cr: CompiledRule;
      ev: Evaluation;
      out: TemplateOutput;
      value: number | string | boolean | null;
      effects: RequirementEffectApplied[];
      problem?: string;
    }
    const drafts: Draft[] = [];
    const effectEvals: { cr: CompiledRule; ev: Evaluation }[] = [];
    for (const [ruleKey, id] of entry.evals) {
      const ev = this.evals[id];
      const cr = this.compiled.rules.get(ruleKey);
      if (!ev || !cr || !ev.applies) continue;
      if (cr.effects.length > 0) effectEvals.push({ cr, ev });
      for (const out of ev.outputs) {
        if (out.index < 0) continue;
        drafts.push({ cr, ev, out, value: out.value, effects: [], ...(out.problem ? { problem: out.problem } : {}) });
      }
    }
    for (const { cr, ev } of effectEvals) {
      for (const e of cr.effects) {
        for (const d of drafts) {
          const t = d.cr.templates[d.out.index]?.template;
          if (!t || t.key !== e.effect.target || d.value === null || !e.value.fields) continue;
          const own = typeof d.value === "number" ? quantityInput(d.value, t.unit) : scalarInput(d.value);
          const inputs = new Map(ev.inputs ?? []);
          inputs.set("value", own);
          const r = evaluateRuleFormula(cr.rule, e.value.source, e.value.fields, inputs, typeof d.value === "number" ? d.cr.templates[d.out.index]?.expect : undefined);
          if (!r.ok) {
            d.problem = `${e.effect.cause} could not be applied: ${"missing" in r ? `needs ${r.missing.join(", ")}` : r.problem}`;
            continue;
          }
          const v = valueInUnit(r.value, t.unit);
          if (!v.ok) {
            d.problem = `${e.effect.cause} could not be applied: ${v.problem}`;
            continue;
          }
          d.effects.push({ provider: cr.rule.provider, ruleId: cr.rule.ruleId, effect: e.effect.effect, before: d.value, after: v.value, cause: e.effect.cause });
          d.value = v.value;
        }
      }
    }
    // Governing vs conflicting, per key on this anchor, by source precedence.
    const byKey = new Map<string, Draft[]>();
    for (const d of drafts) {
      const k = d.cr.templates[d.out.index]?.template.key ?? "";
      const list = byKey.get(k);
      if (list) list.push(d);
      else byKey.set(k, [d]);
    }
    const out: Requirement[] = [];
    for (const [key, list] of byKey) {
      list.sort((x, y) => this.rank(x.cr.rule.provider, x.cr.rule.discipline) - this.rank(y.cr.rule.provider, y.cr.rule.discipline) || x.cr.key.localeCompare(y.cr.key));
      const ids = list.map((d) => requirementIdOf(d.cr.rule.provider, d.cr.rule.ruleId, key, entry.ref.id));
      list.forEach((d, i) => {
        const t = d.cr.templates[d.out.index]?.template;
        if (!t) return;
        const id = ids[i] ?? requirementIdOf(d.cr.rule.provider, d.cr.rule.ruleId, key, entry.ref.id);
        const state = this.aux.stateOf(id);
        const status = state?.state.status ?? "proposed";
        const accepted = d.cr.rule.acceptedValues?.find((a) => a.key === key && a.anchorId === entry.ref.id);
        const sourceValue = accepted ? accepted.value : d.value;
        const sourceUnit = accepted?.unit ?? t.unit;
        const overridden = status === "overridden" && state?.state.value !== undefined;
        const value = overridden ? (state?.state.value ?? null) : sourceValue;
        const unit = overridden && state?.state.unit ? state.state.unit : sourceUnit;
        const others = ids.filter((_, j) => j !== i);
        const fulfilment = fulfilmentOf(this.bound, anchorLabel, entry.ref, value, unit, t.compare, d.out.delivered);
        out.push({
          id,
          provider: d.cr.rule.provider,
          ruleId: d.cr.rule.ruleId,
          key,
          anchor: { kind: entry.ref.kind, id: entry.ref.id },
          value,
          unit,
          compare: t.compare,
          status,
          citation: d.cr.rule.citation,
          title: d.cr.rule.title,
          cause: causeOf(this.bound, d.cr.rule, anchorLabel, d.ev, d.effects),
          causeGroup: causeGroupOf(this.bound, d.cr.rule, anchorLabel, d.ev, d.effects),
          standing: i === 0 ? "governing" : "conflicting",
          ...(others.length > 0 ? { conflictsWith: others } : {}),
          fulfilment,
          reads: d.ev.reads.filter((r) => !r.startsWith("slot:")),
          ...(d.problem ? { problem: d.problem } : {}),
          ...(d.effects.length > 0 ? { effects: d.effects } : {}),
          ...(overridden ? { derivedValue: sourceValue } : {}),
          ...(accepted ? { accepted: { was: d.value, reason: accepted.reason, ...(accepted.acceptedBy ? { acceptedBy: accepted.acceptedBy } : {}), ...(accepted.acceptedAt ? { acceptedAt: accepted.acceptedAt } : {}) } } : {}),
          ...(state ? { stateReason: state.state.reason } : {}),
          ruleVerification: d.cr.rule.verification.status,
          ...(d.cr.rule.chips ? { chips: d.cr.rule.chips } : {}),
          ...(d.cr.rule.sourceRef ? { sourceRef: d.cr.rule.sourceRef } : {}),
        });
      });
    }
    // A person's state on a requirement its rule no longer produces here: shown withdrawn, never lost.
    const produced = new Set(out.map((r) => r.id));
    for (const [reqId, stateId] of this.aux.allStates()) {
      if (produced.has(reqId) || parseRequirementId(reqId)?.anchorId !== entry.ref.id) continue;
      const st = this.bound[stateId];
      if (st?.kind !== "requirement_state") continue;
      const parsed = parseRequirementId(reqId);
      if (!parsed) continue;
      const cr = this.compiled.rules.get(ruleKeyOf(parsed.provider, parsed.ruleId));
      out.push({
        id: reqId,
        provider: parsed.provider,
        ruleId: parsed.ruleId,
        key: parsed.key,
        anchor: { kind: entry.ref.kind, id: entry.ref.id },
        value: st.state.value ?? null,
        unit: st.state.unit ?? "",
        compare: "at_least",
        status: "withdrawn",
        citation: cr?.rule.citation ?? { instrument: parsed.provider, edition: "", section: parsed.ruleId },
        title: cr?.rule.title ?? parsed.key,
        cause: `${cr?.rule.title ?? parsed.key} no longer applies to ${anchorLabel}; ${st.state.by} had marked it ${st.state.status}`,
        standing: "governing",
        fulfilment: { state: "unchecked", elementIds: [] },
        reads: [],
        stateReason: st.state.reason,
      });
    }
    out.sort((x, y) => x.key.localeCompare(y.key) || (x.standing === y.standing ? 0 : x.standing === "governing" ? -1 : 1));
    return out;
  }

  stats(): GraphStats {
    let edges = 0;
    let evaluations = 0;
    for (const ev of this.evals) {
      if (!ev) continue;
      evaluations += 1;
      edges += ev.reads.length;
    }
    return { ruleRuns: this.ruleRuns, evaluations, edges, reverseKeys: this.reverse.size, anchors: this.anchors.size, rules: this.compiled.rules.size };
  }
}

const EMPTY_SET: CompiledSet = { rules: new Map(), bySpaceUse: new Map(), spaceAny: [], zone: [], model: [], elementByClass: new Map(), byAnchorKind: new Map(), effects: [], sources: [] };

function buildCompiledSet(bySource: ReadonlyMap<string, readonly CompiledRule[]>, sources: readonly SourceBinding[]): CompiledSet {
  const rules = new Map<string, CompiledRule>();
  const bySpaceUse = new Map<string, CompiledRule[]>();
  const spaceAny: CompiledRule[] = [];
  const zone: CompiledRule[] = [];
  const model: CompiledRule[] = [];
  const elementByClass = new Map<string, CompiledRule[]>();
  const byAnchorKind = new Map<string, CompiledRule[]>();
  const effects: CompiledRule[] = [];
  const push = <K>(m: Map<K, CompiledRule[]>, k: K, r: CompiledRule) => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  for (const list of bySource.values()) {
    for (const cr of list) {
      if (rules.has(cr.key)) {
        console.error(`[bim-kernel/graph] two rules share the id ${cr.rule.ruleId} from ${cr.rule.provider}; the first is used`);
        continue;
      }
      rules.set(cr.key, cr);
      if (cr.effects.length > 0) effects.push(cr);
      if (cr.anchorKinds.has("space")) {
        const uses = cr.rule.applies.spaceUses;
        if (uses && uses.length > 0) for (const u of uses) push(bySpaceUse, u, cr);
        else spaceAny.push(cr);
      }
      if (cr.anchorKinds.has("zone")) zone.push(cr);
      if (cr.anchorKinds.has("model")) model.push(cr);
      if (cr.anchorKinds.has("element")) for (const c of cr.rule.applies.classes ?? []) push(elementByClass, c, cr);
      for (const k of cr.anchorKinds) if (!GRAPH_OWN_ANCHOR_KINDS.has(k)) push(byAnchorKind, k, cr);
    }
  }
  return { rules, bySpaceUse, spaceAny, zone, model, elementByClass, byAnchorKind, effects, sources };
}

/** The slots a record fills (what an evaluation that looked for it and found nothing noted). */
function slotsOf(elements: Elements, aux: GraphAux, el: BimElement): string[] {
  if (isDeterminationRecord(el)) return [slot.determination(subjectKeyOf(el), el.determination.key)];
  if (el.kind === "ceiling") return el.spaceId ? [slot.ceiling(el.spaceId)] : [];
  if (isLocatedKind(el)) {
    const s = spaceOf(elements, el.id);
    if (!s) return [];
    return aux.classesWithAncestors(el.id).map((c) => slot.classIn(s.id, c));
  }
  return [];
}

/** The anchor of a requirement id, as an anchor ref, reading the anchor's kind from the model. */
export function anchorOfRequirementId(id: RequirementId, elements: Elements): AnchorRef | null {
  const parsed = parseRequirementId(id);
  if (!parsed) return null;
  if (parsed.anchorId === null) return { kind: "model", id: null };
  const el = elements[parsed.anchorId];
  if (el?.kind === "space" || el?.kind === "zone") return { kind: el.kind, id: parsed.anchorId };
  const other = el ? anchorKindTable().anchorOfRecordKind(el.kind) : undefined;
  return { kind: other ?? "element", id: parsed.anchorId };
}

/** The anchor key ("space:S1", "model") of a requirement id; null when it can't be read. */
export function anchorKeyFromRequirementId(id: RequirementId, elements: Elements): string | null {
  const a = anchorOfRequirementId(id, elements);
  return a ? anchorKeyOf(a) : null;
}

/** `<provider>:<ruleId>:<key>:<anchor id or "model">` read back (the rule id may itself hold colons). */
export function parseRequirementId(id: RequirementId): { readonly provider: string; readonly ruleId: string; readonly key: string; readonly anchorId: string | null } | null {
  const parts = id.split(":");
  if (parts.length < 4) return null;
  const provider = parts[0] ?? "";
  const anchor = parts[parts.length - 1] ?? "";
  const key = parts[parts.length - 2] ?? "";
  const ruleId = parts.slice(1, -2).join(":");
  return { provider, ruleId, key, anchorId: anchor === "model" ? null : anchor };
}

function causeGroupOf(elements: Elements, rule: RuleRecord, anchorLabel: string, ev: Evaluation, effects: readonly RequirementEffectApplied[]): string {
  const first = effects[0];
  if (first) return first.cause.charAt(0).toUpperCase() + first.cause.slice(1);
  const because = ev.determinations.map((d) => determinationWords(elements, d));
  const text = because.length > 0 ? because.join(" and ") : rule.triggeredBy?.trim() || anchorLabel;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function causeOf(elements: Elements, rule: RuleRecord, anchorLabel: string, ev: Evaluation, effects: readonly RequirementEffectApplied[]): string {
  const cite = `${rule.citation.instrument} ${rule.citation.section}`.trim();
  const because = ev.determinations.map((d) => determinationWords(elements, d));
  const head = `${cite}: ${rule.title} for ${anchorLabel}`;
  const why = because.length > 0 ? `, because ${because.join(" and ")}` : rule.triggeredBy ? `, because ${rule.triggeredBy}` : "";
  const fx = effects.length > 0 ? `; ${effects.map((e) => e.cause).join("; ")}` : "";
  return `${head}${why}${fx}`;
}

function numberIn(v: InputValue, unit: string): number | null {
  if (v.type !== "quantity") return null;
  if (isUnitCode(unit) && unitAllowed(v.kind, unit)) return fromSI(v.si, unit);
  if (isUnitCode(unit) && isUnitCode(v.unit)) {
    try {
      return convert(fromSI(v.si, v.unit), v.unit, unit);
    } catch (err) {
      console.error(`[bim-kernel/graph] can't compare ${v.unit} with ${unit}`, err);
      return null;
    }
  }
  return v.kind === "dimensionless" || v.kind === "count" ? v.si : null;
}

function fulfilmentOf(elements: Elements, anchorLabel: string, anchor: AnchorRef, value: number | string | boolean | null, unit: string, compare: string, delivered: Delivered | undefined): Requirement["fulfilment"] {
  if (!delivered) return { state: "unchecked", elementIds: [] };
  const ids = delivered.elementIds;
  if (value === null || delivered.value === null) return { state: "open", elementIds: ids };
  let d: number | string | boolean | null;
  if (delivered.value.type === "quantity") d = numberIn(delivered.value, unit);
  else d = delivered.value.value;
  if (d === null) return { state: "open", elementIds: ids };
  let met: boolean;
  if (typeof d === "number" && typeof value === "number") {
    const eps = 1e-9 * Math.max(1, Math.abs(value));
    met = compare === "at_most" ? d <= value + eps : compare === "equal" ? Math.abs(d - value) <= eps : d >= value - eps;
  } else if (compare === "one_of") met = String(value).split("|").map((s) => s.trim()).includes(String(d));
  else met = String(d) === String(value);
  const state: FulfilmentState = met ? "met" : "not_met";
  const dv = valueWords(typeof d === "number" ? Number(d.toPrecision(6)) : d);
  const rv = valueWords(value, unit);
  const phrase = compare === "at_most" ? `${dv}, at most ${rv}` : compare === "equal" ? `${dv}, needs ${rv}` : compare === "one_of" ? `${dv}, one of ${String(value).split("|").join(", ")}` : `${dv} of ${rv}`;
  const own = anchor.id !== null && ids.length === 1 && ids[0] === anchor.id;
  const who = own ? `${anchorLabel} has` : ids.length === 1 ? `${nameOf(elements[ids[0] ?? ""], ids[0])} delivers` : `${ids.length} elements deliver`;
  return { state, delivered: d, elementIds: ids, summary: `${who} ${phrase}` };
}

// ── per-model state and its carry across revisions ─────────────────────────

const byElements = new WeakMap<Elements, GraphState>();
/** A state that moved off a record, keyed by that record (a second revision made from the same head finds it). */
const byFrom = new WeakMap<Elements, GraphState>();
const pending = new WeakMap<Elements, { readonly from: Elements; readonly changed: readonly string[] }>();

registerRevisionCarry("requirements-graph", (from, to, changedIds) => {
  if (from === to) return;
  // A record the graph is already bound to carries from itself, never from the revision before it.
  if (byElements.has(from)) {
    pending.set(to, { from, changed: [...changedIds] });
    return;
  }
  const p = pending.get(from);
  if (p) {
    const ids = [...new Set([...p.changed, ...changedIds])];
    if (ids.length <= MAX_PENDING_IDS) pending.set(to, { from: p.from, changed: ids });
    return;
  }
  if (!byElements.has(from) && !byFrom.has(from)) return;
  pending.set(to, { from, changed: [...changedIds] });
});

function materialize(model: ModelState): GraphState | null {
  const p = pending.get(model.elements);
  if (!p) return null;
  pending.delete(model.elements);
  const direct = byElements.get(p.from);
  if (direct && direct.bound === p.from && direct.modelId === model.modelId) {
    byElements.delete(p.from);
    byFrom.set(p.from, direct);
    direct.advance(model.elements, p.changed);
    return direct;
  }
  const moved = byFrom.get(p.from);
  if (moved && moved.lastFrom === p.from && moved.modelId === model.modelId && !moved.ephemeral) {
    const ids = [...new Set([...p.changed, ...moved.lastChanged])];
    byElements.delete(moved.bound);
    moved.advance(model.elements, ids);
    return moved;
  }
  return null;
}

/** The graph state for a model's record: cached, carried from the revision before, or made (lazily evaluated). Call inside the model's pack scope. */
export function graphStateIn(model: ModelState): GraphState {
  let state = byElements.get(model.elements) ?? null;
  if (state && state.modelId !== model.modelId) state = null;
  if (!state) state = materialize(model);
  if (state && !state.refresh(model)) state = null;
  if (!state) {
    state = new GraphState(model);
    state.refresh(model);
  }
  byElements.set(model.elements, state);
  return state;
}

/**
 * A state for a preview record (a scenario or a proposed edit): shares the bound rules of `base`, cached nowhere.
 * `changed` must list every id where the preview differs from `base`'s record; its indexes then fork from `base`'s.
 */
export function previewStateIn(model: ModelState, base: GraphState, changed?: readonly string[]): GraphState {
  const state = new GraphState(model, true, base, changed);
  state.refresh(model);
  return state;
}

/** Every anchor the model's rules can produce requirements on. */
export function allAnchors(state: GraphState): AnchorRef[] {
  const out: AnchorRef[] = [{ kind: "model", id: null }];
  for (const s of elementsOfKind(state.bound, "space")) out.push({ kind: "space", id: s.id });
  if (state.compiled.zone.length > 0 || state.compiled.effects.length > 0) for (const z of elementsOfKind(state.bound, "zone")) out.push({ kind: "zone", id: z.id });
  for (const classId of state.compiled.elementByClass.keys()) {
    const instances = new Set<string>();
    for (const s of elementsOfKind(state.bound, "space")) for (const id of state.aux.instancesIn(s.id, classId)) instances.add(id);
    for (const id of instances) out.push({ kind: "element", id });
  }
  if (state.compiled.byAnchorKind.size > 0) {
    const table = anchorKindTable();
    for (const [kind, rules] of state.compiled.byAnchorKind) {
      const seen = new Set<string>();
      for (const el of recordsOfKinds(state.bound, table.recordKinds(kind))) {
        seen.add(el.id);
        out.push({ kind, id: el.id });
      }
      // Anchors only a rule names (a lineage id): enumerated from the rules themselves.
      for (const cr of rules) for (const x of cr.rule.appliesAt?.anchors ?? []) if (x.kind === kind && x.id !== null && !seen.has(x.id)) {
        seen.add(x.id);
        out.push({ kind, id: x.id });
      }
    }
  }
  return out;
}

// ── public reads ───────────────────────────────────────────────────────────

/** Every requirement on the model, governing and conflicting (the checklist's source). */
export function requirementsOf(model: ModelState): readonly Requirement[] {
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    return allAnchors(state).flatMap((a) => state.requirementsAt(a));
  });
}

/** The requirements anchored on one space, zone, element or the model. */
export function requirementsAt(model: ModelState, anchor: AnchorRef): readonly Requirement[] {
  return withModelStatePacks(model, () => graphStateIn(model).requirementsAt(anchor));
}

/** One requirement by id, or null. */
export function requirementById(model: ModelState, id: RequirementId): Requirement | null {
  return withModelStatePacks(model, () => {
    // Inside the model's packs: an add-on's record kind can be an anchor kind (a parcel).
    let anchor = anchorOfRequirementId(id, model.elements);
    if (!anchor) return null;
    const state = graphStateIn(model);
    const anchorId = anchor.id;
    if (anchor.kind === "element" && anchorId !== null && !model.elements[anchorId]) {
      // No record holds it: an anchor only a rule names by id (a lineage).
      for (const [kind, rules] of state.compiled.byAnchorKind) if (rules.some((cr) => cr.rule.appliesAt?.anchors?.some((x) => x.kind === kind && x.id === anchorId))) anchor = { kind, id: anchorId };
    }
    return state.requirementsAt(anchor).find((r) => r.id === id) ?? null;
  });
}

/** Counters for tests and perf: how many rules ran, how big the reverse index is. */
export function graphStats(model: ModelState): GraphStats {
  return withModelStatePacks(model, () => graphStateIn(model).stats());
}

/** The source bindings in force on a model, highest default precedence first. */
export function requirementsSources(model: ModelState): readonly SourceBinding[] {
  return withModelStatePacks(model, () => graphStateIn(model).compiled.sources);
}
