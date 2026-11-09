import { isObservationRecord } from "../graph/records";
import type { ObservationElement } from "../graph/types";
import { elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId } from "../types";
import { divergencesIn, submittalsIn } from "./records";
import type { DesignBasisRef, DivergenceElement, SubmittalElement, SubmittalItem } from "./types";

/**
 * The three product layers of one element, side by side (round 9): what the
 * design says, what was submitted and how it was reviewed, and what others
 * observed in the field. Reads only; nothing here changes the design. Agents
 * read it as context through the model summary's questions argument.
 *
 * Indexed per model snapshot: one kind read of submittals, divergences and
 * observations, then map lookups by element and type id.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface ChainSubmittal {
  readonly submittal: SubmittalElement;
  /** The items offered for this element (or its type); every item when the submittal as a whole is. */
  readonly items: readonly SubmittalItem[];
}

export interface ProductChain {
  readonly elementId: ElementId;
  /** The element's type, when it has one. */
  readonly typeId: ElementId | null;
  /** The design basis: the element as the model has it (never changed by a submittal or a divergence). */
  readonly design: BimElement | null;
  readonly submittals: readonly ChainSubmittal[];
  /** Approved substitutions that differ from the design. "Design not changed." */
  readonly divergences: readonly DivergenceElement[];
  /** The field layer: observations of the element by others. */
  readonly field: readonly ObservationElement[];
}

interface ChainIndex {
  readonly submittalsByRef: Map<string, Set<SubmittalElement>>;
  readonly divergencesByRef: Map<string, DivergenceElement[]>;
  readonly observationsBySubject: Map<string, ObservationElement[]>;
}

const chains = new WeakMap<Elements, ChainIndex>();

function refsOf(b: DesignBasisRef | undefined): string[] {
  return b ? [...(b.elementIds ?? []), ...(b.typeIds ?? [])] : [];
}

function chainIndex(elements: Elements): ChainIndex {
  const hit = chains.get(elements);
  if (hit) return hit;
  const submittalsByRef = new Map<string, Set<SubmittalElement>>();
  const divergencesByRef = new Map<string, DivergenceElement[]>();
  const observationsBySubject = new Map<string, ObservationElement[]>();
  for (const s of submittalsIn(elements)) {
    for (const ref of [...refsOf(s.submittal.offeredFor), ...s.submittal.items.flatMap((i) => refsOf(i.offeredFor))]) {
      const set = submittalsByRef.get(ref) ?? new Set<SubmittalElement>();
      set.add(s);
      submittalsByRef.set(ref, set);
    }
  }
  for (const d of divergencesIn(elements)) {
    for (const ref of refsOf(d.divergence.designBasis)) divergencesByRef.set(ref, [...(divergencesByRef.get(ref) ?? []), d]);
  }
  for (const el of elementsOfKind(elements, "observation")) {
    const candidate: { readonly kind: string } = el;
    if (!isObservationRecord(candidate)) continue;
    const subject = candidate.observation.subject.id;
    if (subject) observationsBySubject.set(subject, [...(observationsBySubject.get(subject) ?? []), candidate]);
  }
  const index = { submittalsByRef, divergencesByRef, observationsBySubject };
  chains.set(elements, index);
  return index;
}

function typeIdOf(el: BimElement | undefined): ElementId | null {
  if (!el) return null;
  const raw: unknown = (el as { readonly typeId?: unknown }).typeId;
  return typeof raw === "string" && raw.length > 0 ? asElementId(raw) : null;
}

function itemsFor(s: SubmittalElement, refs: ReadonlySet<string>): SubmittalItem[] {
  const whole = refsOf(s.submittal.offeredFor).some((r) => refs.has(r));
  const own = s.submittal.items.filter((i) => refsOf(i.offeredFor).some((r) => refs.has(r)));
  if (own.length > 0) return own;
  return whole ? s.submittal.items.filter((i) => i.offeredFor === undefined) : [];
}

/** Design → submittal and review → field, for one element (and its type). */
export function productChainOf(elements: Elements, elementId: string): ProductChain {
  const index = chainIndex(elements);
  const design = elements[elementId] ?? null;
  const typeId = typeIdOf(design ?? undefined);
  const refs = new Set<string>([elementId, ...(typeId ? [typeId] : [])]);
  const found = new Set<SubmittalElement>();
  for (const r of refs) for (const s of index.submittalsByRef.get(r) ?? []) found.add(s);
  const submittals = [...found].sort((a, b) => a.id.localeCompare(b.id)).map((s) => ({ submittal: s, items: itemsFor(s, refs) }));
  const divergences = [...new Set([...refs].flatMap((r) => index.divergencesByRef.get(r) ?? []))].sort((a, b) => a.divergence.at.localeCompare(b.divergence.at) || a.id.localeCompare(b.id));
  const field = [...(index.observationsBySubject.get(elementId) ?? [])].sort((a, b) => a.observation.at.localeCompare(b.observation.at) || a.id.localeCompare(b.id));
  return { elementId: asElementId(elementId), typeId, design, submittals, divergences, field };
}

/** Submittals offered for a type (as a whole or by item). */
export function submittalsDependingOn(elements: Elements, typeId: string): SubmittalElement[] {
  return [...(chainIndex(elements).submittalsByRef.get(typeId) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

/** The words an element's badge reads when an approved substitution names it. */
export const DIVERGENCE_BADGE = "Approved substitution: differs from the design. Design not changed.";

/** Whether an approved substitution names this element or its type. */
export function hasDivergence(elements: Elements, elementId: string): boolean {
  return productChainOf(elements, elementId).divergences.length > 0;
}
