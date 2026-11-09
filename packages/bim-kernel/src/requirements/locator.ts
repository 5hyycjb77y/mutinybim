import { pushTo } from "../collections";
import { registerRevisionCarry } from "../revision-carry";
import { spaceIndexStats, spaceOf } from "../spaces/space-index";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Vec2 } from "../types";

/**
 * "Which space is this in?", the one question loads ask of spaces. Spaces and
 * zones are owned by spaces/ (KERNEL-REQUIREMENTS-MODEL §3.2); this is the seam
 * requirements read through, so allocated-vs-actual and density estimates work
 * against any implementation: the spaces module's incremental locator in the
 * model, a fixed map in tests, or none at all (`NO_SPACES`).
 *
 * Every method must be an indexed read (no pass over the model per call).
 */
export interface SpaceLocator {
  /** The space a part or run element is in, or undefined (outside every space, or not placed). */
  spaceOf(elementId: ElementId): ElementId | undefined;
  /** The space a point on a level is in. */
  spaceAt(levelId: ElementId, position: Vec2): ElementId | undefined;
  /** The zones that list this space. */
  zonesOf(spaceId: ElementId): readonly ElementId[];
  /** The spaces a zone lists. */
  spacesOf(zoneId: ElementId): readonly ElementId[];
  /** Area (square metres, from geometry) and occupants of a space, for density loads. Undefined: not drawn yet. */
  measureOf(spaceId: ElementId): SpaceMeasure | undefined;
  /**
   * What a cached answer about `elementId` depends on, so a derived value that
   * read it is re-derived when one of these ids changes (its space, the space's
   * outline, the zone). Absent: the element itself.
   */
  dependenciesOf?(elementId: ElementId): readonly ElementId[];
  /**
   * The parts a space holds (each one `spaceOf` answers with this space), so a
   * reader that totals a space's parts reads them, not every part in the model.
   * Absent: the locator can't say; `withModelSpaceParts` adds the model's.
   */
  partsIn?(spaceId: ElementId): readonly ElementId[];
}

export interface SpaceMeasure {
  readonly areaSqM: number;
  readonly occupants: number;
}

const NONE: readonly ElementId[] = Object.freeze([]);

/** No spaces: every load is outside every space, so estimates and devices never meet. */
export const NO_SPACES: SpaceLocator = {
  spaceOf: () => undefined,
  spaceAt: () => undefined,
  zonesOf: () => NONE,
  spacesOf: () => NONE,
  measureOf: () => undefined,
};

/** A fixed locator (tests, imports, a host that already knows): element → space, plus zones and measures. */
export function fixedSpaceLocator(input: {
  readonly spaceOf?: Readonly<Record<string, ElementId>>;
  readonly zones?: Readonly<Record<string, readonly ElementId[]>>;
  readonly measures?: Readonly<Record<string, SpaceMeasure>>;
}): SpaceLocator {
  const zonesOfSpace = new Map<string, ElementId[]>();
  for (const [zone, spaces] of Object.entries(input.zones ?? {})) {
    for (const s of spaces) pushTo(zonesOfSpace, s, zone as ElementId);
  }
  const inSpace = new Map<string, ElementId[]>();
  for (const [id, space] of Object.entries(input.spaceOf ?? {})) pushTo(inSpace, space, id as ElementId);
  return {
    spaceOf: (id) => input.spaceOf?.[id],
    spaceAt: () => undefined,
    zonesOf: (spaceId) => zonesOfSpace.get(spaceId) ?? NONE,
    spacesOf: (zoneId) => input.zones?.[zoneId] ?? NONE,
    measureOf: (spaceId) => input.measures?.[spaceId],
    partsIn: (spaceId) => inSpace.get(spaceId) ?? NONE,
  };
}

// ---------------------------------------------------------------- the model's parts by space

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Parts by space for a model, kept beside the spaces index and carried from
 * one revision to the next: a part an edit wrote or removed is re-located on
 * its own (O(changed)); when the spaces index re-measures a space (an outline,
 * a room or a bounding wall changed) every part is located again, once, on the
 * next read.
 */
class SpacePartsState {
  bound: Elements;
  generation = -1;
  readonly spaceOfPart = new Map<ElementId, ElementId>();
  readonly bySpace = new Map<ElementId, Set<ElementId>>();
  readonly pending = new Set<ElementId>();

  constructor(elements: Elements) {
    this.bound = elements;
  }
}

const partsByElements = new WeakMap<Elements, SpacePartsState>();

function unlocate(state: SpacePartsState, id: ElementId): void {
  const prior = state.spaceOfPart.get(id);
  if (prior === undefined) return;
  state.spaceOfPart.delete(id);
  state.bySpace.get(prior)?.delete(id);
}

function locatePart(state: SpacePartsState, elements: Elements, id: ElementId): void {
  unlocate(state, id);
  if (elements[id]?.kind !== "part") return;
  const space = spaceOf(elements, id)?.id;
  if (space === undefined) return;
  state.spaceOfPart.set(id, space);
  let set = state.bySpace.get(space);
  if (!set) {
    set = new Set();
    state.bySpace.set(space, set);
  }
  set.add(id);
}

function partsStateFor(elements: Elements): SpacePartsState {
  let state = partsByElements.get(elements);
  if (!state || state.bound !== elements) {
    state = new SpacePartsState(elements);
    partsByElements.set(elements, state);
  }
  const generation = spaceIndexStats(elements).measured;
  if (generation !== state.generation) {
    state.spaceOfPart.clear();
    state.bySpace.clear();
    state.pending.clear();
    for (const part of elementsOfKind(elements, "part")) locatePart(state, elements, part.id);
    state.generation = generation;
  } else if (state.pending.size > 0) {
    for (const id of state.pending) locatePart(state, elements, id);
    state.pending.clear();
  }
  return state;
}

registerRevisionCarry("requirements.space_parts", (from, to, changedIds) => {
  const state = partsByElements.get(from);
  if (!state || state.bound !== from) return;
  for (const id of changedIds) {
    const el = to[id] ?? from[id];
    if (el?.kind === "part") state.pending.add(el.id);
  }
  partsByElements.delete(from);
  state.bound = to;
  partsByElements.set(to, state);
});

/** The parts the model places in a space (by where each stands, or a planned part's space hint), in id order. */
export function modelSpaceParts(elements: Elements, spaceId: ElementId): readonly ElementId[] {
  const set = partsStateFor(elements).bySpace.get(spaceId);
  if (!set || set.size === 0) return NONE;
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `locator` with the model's parts-by-space read when it has none of its own. */
export function withModelSpaceParts(elements: Elements, locator: SpaceLocator): SpaceLocator {
  if (locator.partsIn) return locator;
  return { ...locator, partsIn: (spaceId) => modelSpaceParts(elements, spaceId) };
}
