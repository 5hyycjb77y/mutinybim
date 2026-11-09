import { carryClassIndexes } from "../registry/recognition";
import { spaceOf } from "../spaces/space-index";
import type { BimElement, ElementId } from "../types";
import type { Ceiling } from "../ceilings/types";
import { GraphAux, isLocatedKind } from "./auxiliary";
import type { DeterminationElement, RequirementStateElement } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

const NO_ELEMENTS: Elements = Object.freeze({});
const RECORD_KINDS: ReadonlySet<string> = new Set(["determination", "ceiling", "requirement_state"]);

/**
 * The graph's input indexes for a preview record (a proposed edit or a
 * scenario): forked from the head's, never rebuilt (round 8 lane F,
 * `agent.preflight.one_edit.250k`). A preview differs from the head only at
 * the touched ids, so every read the touched ids can't affect goes to the
 * head's indexes; the few that can are answered for the preview alone.
 *
 * Built with an empty record so the base constructor scans nothing. When the
 * edit touches a determination, ceiling or requirement state (rare: a code
 * study edit), those three small indexes are built for the preview in full.
 */
export class PreviewAux extends GraphAux {
  private readonly own: GraphAux | null;
  private readonly touched: ReadonlySet<string>;
  private readonly spaceTouched: boolean;
  private readonly locatedTouched: readonly string[];
  private readonly bySpace = new Map<string, Map<ElementId, readonly ElementId[]>>();

  constructor(
    private readonly base: GraphAux,
    after: Elements,
    changed: readonly string[],
  ) {
    super(NO_ELEMENTS);
    this.elements = after;
    const before = base.elements;
    carryClassIndexes(before, after, changed);
    this.touched = new Set(changed);
    const recordTouched = changed.some((id) => RECORD_KINDS.has(before[id]?.kind ?? "") || RECORD_KINDS.has(after[id]?.kind ?? ""));
    this.own = recordTouched ? new GraphAux(after) : null;
    this.spaceTouched = changed.some((id) => before[id]?.kind === "space" || after[id]?.kind === "space");
    this.locatedTouched = changed.filter((id) => isLocatedKind(before[id]) || isLocatedKind(after[id]));
  }

  override advance(): string[] {
    throw new Error("[bim-kernel/graph] a preview's indexes never advance; make a new preview from the head");
  }

  override determination(subject: string, key: string): DeterminationElement | null {
    return (this.own ?? this.base).determination(subject, key);
  }

  override determinationsOn(subject: string): DeterminationElement[] {
    return (this.own ?? this.base).determinationsOn(subject);
  }

  override ceilingsOf(spaceId: ElementId): Ceiling[] {
    return (this.own ?? this.base).ceilingsOf(spaceId);
  }

  override stateOf(requirementId: string): RequirementStateElement | null {
    return (this.own ?? this.base).stateOf(requirementId);
  }

  override allStates(): ReadonlyMap<string, ElementId> {
    return (this.own ?? this.base).allStates();
  }

  override classesWithAncestors(id: ElementId): string[] {
    return this.touched.has(id) ? super.classesWithAncestors(id) : this.base.classesWithAncestors(id);
  }

  /** The head's list for the space, with the touched located elements taken out and put back where the preview has them. */
  override instancesIn(spaceId: ElementId, classId: string): readonly ElementId[] {
    if (this.spaceTouched) return super.instancesIn(spaceId, classId);
    if (this.locatedTouched.length === 0) return this.base.instancesIn(spaceId, classId);
    let forClass = this.bySpace.get(classId);
    if (!forClass) {
      forClass = new Map();
      this.bySpace.set(classId, forClass);
    }
    const held = forClass.get(spaceId);
    if (held) return held;
    const out = this.base.instancesIn(spaceId, classId).filter((id) => !this.touched.has(id));
    for (const id of this.locatedTouched) {
      if (!this.elements[id]) continue;
      if (spaceOf(this.elements, id as ElementId)?.id !== spaceId) continue;
      if (super.classesWithAncestors(id as ElementId).includes(classId)) out.push(id as ElementId);
    }
    forClass.set(spaceId, out);
    return out;
  }
}
