import { PARAMETER_SET_POINT, type PackParameter } from "../fields/pack-parameters";
import { activePackSet } from "../packs/scope";
import { activeClassRegistry, buildClassIndex } from "../registry/index";
import type { ClassIndex, Registry } from "../registry/types";
import { spaceOf } from "../spaces/space-index";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId } from "../types";
import { isDeterminationRecord, isRequirementStateRecord } from "./records";
import type { Ceiling } from "../ceilings/types";
import type { DeterminationElement, RequirementStateElement } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The small indexes the graph reads inputs through, kept per model and moved
 * along by the ids an edit changed (never rebuilt by a pass on an edit):
 * determinations by subject and key, ceilings by space, requirement states
 * by requirement, and class instances by space (filled per class on first
 * read, dropped per class when an instance of it changes).
 */

/** The subject key a determination is filed under: the space, zone or element id, or "model". */
export function subjectKeyOf(d: DeterminationElement): string {
  return d.determination.subject.kind === "model" || !d.determination.subject.id ? "model" : d.determination.subject.id;
}

/** Slot names: what a record not there yet would fill, so its arrival re-runs what looked for it. */
export const slot = {
  determination: (subject: string, key: string) => `slot:det:${subject}:${key}`,
  ceiling: (spaceId: string) => `slot:ceiling:${spaceId}`,
  classIn: (spaceId: string, classId: string) => `slot:class:${spaceId}:${classId}`,
} as const;

/** Kinds `spaceOf` can place in a space (what a class count in a space reads). */
const LOCATED_KINDS: ReadonlySet<string> = new Set(["part", "load_point", "run_segment", "run_fitting"]);

export function isLocatedKind(el: BimElement | undefined): boolean {
  return el !== undefined && LOCATED_KINDS.has(el.kind);
}

export class GraphAux {
  private readonly dets = new Map<string, Map<string, Set<ElementId>>>();
  private readonly detPlace = new Map<ElementId, { readonly subject: string; readonly key: string }>();
  private readonly superseded = new Set<ElementId>();
  private readonly supersedes = new Map<ElementId, ElementId>();
  private readonly ceilings = new Map<ElementId, Set<ElementId>>();
  private readonly ceilingPlace = new Map<ElementId, ElementId>();
  private readonly states = new Map<string, ElementId>();
  private readonly statePlace = new Map<ElementId, string>();
  private classBySpace = new Map<string, Map<ElementId, ElementId[]>>();
  private registry: Registry | null = null;

  constructor(public elements: Elements) {
    for (const d of elementsOfKind(elements, "determination")) this.putDetermination(d);
    for (const c of elementsOfKind(elements, "ceiling")) this.putCeiling(c);
    for (const s of elementsOfKind(elements, "requirement_state")) this.putState(s);
  }

  private putDetermination(el: BimElement): void {
    if (!isDeterminationRecord(el)) return;
    const subject = subjectKeyOf(el);
    const key = el.determination.key;
    let byKey = this.dets.get(subject);
    if (!byKey) {
      byKey = new Map();
      this.dets.set(subject, byKey);
    }
    let ids = byKey.get(key);
    if (!ids) {
      ids = new Set();
      byKey.set(key, ids);
    }
    ids.add(el.id);
    this.detPlace.set(el.id, { subject, key });
    const old = el.determination.supersedes;
    if (old) {
      this.superseded.add(old as ElementId);
      this.supersedes.set(el.id, old as ElementId);
    }
  }

  private dropDetermination(id: ElementId): void {
    const place = this.detPlace.get(id);
    if (place) this.dets.get(place.subject)?.get(place.key)?.delete(id);
    this.detPlace.delete(id);
    const old = this.supersedes.get(id);
    if (old) {
      this.superseded.delete(old);
      this.supersedes.delete(id);
    }
  }

  private putCeiling(el: BimElement): void {
    if (el.kind !== "ceiling") return;
    const space = el.spaceId ?? null;
    if (!space) return;
    let set = this.ceilings.get(space);
    if (!set) {
      set = new Set();
      this.ceilings.set(space, set);
    }
    set.add(el.id);
    this.ceilingPlace.set(el.id, space);
  }

  private dropCeiling(id: ElementId): void {
    const space = this.ceilingPlace.get(id);
    if (space) this.ceilings.get(space)?.delete(id);
    this.ceilingPlace.delete(id);
  }

  private putState(el: BimElement): void {
    if (!isRequirementStateRecord(el)) return;
    this.states.set(el.state.requirementId, el.id);
    this.statePlace.set(el.id, el.state.requirementId);
  }

  private dropState(id: ElementId): void {
    const req = this.statePlace.get(id);
    if (req !== undefined && this.states.get(req) === id) this.states.delete(req);
    this.statePlace.delete(id);
  }

  /**
   * Move onto `next`, a record that differs from the bound one only at
   * `ids`. Returns the requirement ids whose stored state changed.
   */
  advance(next: Elements, ids: readonly string[]): string[] {
    const prev = this.elements;
    const statesChanged: string[] = [];
    const touchedClasses = new Set<string>();
    const located = ids.some((id) => isLocatedKind(prev[id]) || isLocatedKind(next[id]) || prev[id]?.kind === "space" || next[id]?.kind === "space");
    for (const id of ids) {
      const key = id as ElementId;
      const before = prev[id];
      const after = next[id];
      if (before?.kind === "determination" || after?.kind === "determination") {
        this.dropDetermination(key);
        if (after) this.putDetermination(after);
      }
      if (before?.kind === "ceiling" || after?.kind === "ceiling") {
        this.dropCeiling(key);
        if (after) this.putCeiling(after);
      }
      if (before?.kind === "requirement_state" || after?.kind === "requirement_state") {
        const was = this.statePlace.get(key);
        if (was !== undefined) statesChanged.push(was);
        this.dropState(key);
        if (after) this.putState(after);
        const now = this.statePlace.get(key);
        if (now !== undefined && now !== was) statesChanged.push(now);
      }
    }
    if (located && this.classBySpace.size > 0) {
      const registry = this.registry;
      if (registry) {
        const was = buildClassIndex(registry, { elements: prev });
        const now = buildClassIndex(registry, { elements: next });
        for (const id of ids) {
          if (prev[id]?.kind === "space" || next[id]?.kind === "space") {
            // A space's outline moved: every class count by space may have changed.
            this.classBySpace = new Map();
            break;
          }
          for (const c of [...(prev[id] ? was.classesOf(id as ElementId) : []), ...(next[id] ? now.classesOf(id as ElementId) : [])]) for (const a of registry.ancestors(c)) touchedClasses.add(a);
        }
        for (const c of touchedClasses) this.classBySpace.delete(c);
      } else this.classBySpace = new Map();
    }
    this.elements = next;
    return statesChanged;
  }

  /** The determination in force for a subject and key: recorded, not superseded, the latest decided. */
  determination(subject: string, key: string): DeterminationElement | null {
    const ids = this.dets.get(subject)?.get(key);
    if (!ids || ids.size === 0) return null;
    let best: DeterminationElement | null = null;
    for (const id of ids) {
      const el = this.elements[id];
      if (!isDeterminationRecord(el)) continue;
      const st = el.determination.status;
      if (st === "superseded" || st === "draft" || this.superseded.has(el.id)) continue;
      if (!best || (el.determination.decidedAt ?? "") >= (best.determination.decidedAt ?? "")) best = el;
    }
    return best;
  }

  /** Every determination in force on a subject (for "why" and the Inspector). */
  determinationsOn(subject: string): DeterminationElement[] {
    const byKey = this.dets.get(subject);
    if (!byKey) return [];
    const out: DeterminationElement[] = [];
    for (const key of byKey.keys()) {
      const d = this.determination(subject, key);
      if (d) out.push(d);
    }
    return out;
  }

  ceilingsOf(spaceId: ElementId): Ceiling[] {
    const out: Ceiling[] = [];
    for (const id of this.ceilings.get(spaceId) ?? []) {
      const el = this.elements[id];
      if (el?.kind === "ceiling") out.push(el);
    }
    return out;
  }

  stateOf(requirementId: string): RequirementStateElement | null {
    const id = this.states.get(requirementId);
    const el = id ? this.elements[id] : undefined;
    return isRequirementStateRecord(el) ? el : null;
  }

  /** Every stored requirement state, by requirement id. */
  allStates(): ReadonlyMap<string, ElementId> {
    return this.states;
  }

  private classIndex(): { readonly registry: Registry; readonly index: ClassIndex } {
    const registry = activeClassRegistry();
    if (this.registry !== registry) {
      this.registry = registry;
      this.classBySpace = new Map();
    }
    return { registry, index: buildClassIndex(registry, { elements: this.elements }) };
  }

  /** The classes an element is, with their ancestors. */
  classesWithAncestors(id: ElementId): string[] {
    const { registry, index } = this.classIndex();
    const out = new Set<string>();
    for (const c of index.classesOf(id)) for (const a of registry.ancestors(c)) out.add(a);
    return [...out];
  }

  /** Instances of a class (and its subclasses) placed in a space. */
  instancesIn(spaceId: ElementId, classId: string): readonly ElementId[] {
    const { index } = this.classIndex();
    let bySpace = this.classBySpace.get(classId);
    if (!bySpace) {
      const m = new Map<ElementId, ElementId[]>();
      for (const el of index.elementsOf(classId)) {
        const s = spaceOf(this.elements, el.id);
        if (!s) continue;
        const list = m.get(s.id);
        if (list) list.push(el.id);
        else m.set(s.id, [el.id]);
      }
      bySpace = m;
      this.classBySpace.set(classId, bySpace);
    }
    return bySpace.get(spaceId) ?? [];
  }
}

/** Pack parameters by key in the set in force (built once per set). */
export function packParameterByKey(): ReadonlyMap<string, PackParameter> {
  const set = activePackSet();
  return set.memo("graph.parameters_by_key", () => {
    const out = new Map<string, PackParameter>();
    for (const ps of set.items(PARAMETER_SET_POINT)) for (const p of ps.parameters) out.set(p.key, p);
    return out;
  });
}
