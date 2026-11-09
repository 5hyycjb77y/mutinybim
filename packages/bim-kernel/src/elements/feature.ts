import { schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import type { MepSystem, RunSegment } from "../routing/types";
import type { Space, Zone } from "../spaces/types";
import type { BimElement, Beam, Column, Component, ElementTypeElement, GridLine, Opening, PartInstance, Room, Slab, Wall } from "../types";

/**
 * Typed elements (KERNEL-FOUNDATION §3.1, FOUNDATION-COVERAGE §2.7 items 2–3):
 * the building and structure kinds carry `ElementCore` (class, type, values,
 * provenance, placement, lock). Expand, then contract: every reader of this
 * release reads the new fields; a writer stores them only when the peers
 * advertise `elements:core`, through the per-kind schema steps registered in
 * `upgrade.ts` (the feature joins `gatedRecordFeatures()`, so every client and
 * server of this release advertises it).
 */
export const ELEMENTS_CORE_FEATURE = "elements:core";

/** The protocol feature for `element_type` records (shared types for the building and structure kinds). */
export const ELEMENT_TYPES_FEATURE = "elements:types";

export const ELEMENT_CORE_KINDS = ["wall", "slab", "opening", "room", "grid", "column", "beam", "component"] as const;
export type ElementCoreKind = (typeof ELEMENT_CORE_KINDS)[number];
export type CoreElement = Wall | Slab | Opening | Room | GridLine | Column | Beam | Component;

const CORE_KINDS: ReadonlySet<string> = new Set(ELEMENT_CORE_KINDS);

export function isCoreElement(el: BimElement | undefined): el is CoreElement {
  return el !== undefined && CORE_KINDS.has(el.kind);
}

/** Kinds that carry `classId` and `provenance` (and, but for parts, `values`) without the rest of element core. */
export const CLASSIFIED_KINDS = ["zone", "space", "mep_system", "run_segment", "part", "element_type"] as const;
export type ClassifiedKind = (typeof CLASSIFIED_KINDS)[number];
export type ClassifiedElement = Zone | Space | MepSystem | RunSegment | PartInstance | ElementTypeElement;
/** Classified kinds whose `values` are element-core values (a part's are its type's instance parameters). */
export type ValuedElement = Zone | Space | MepSystem | RunSegment | ElementTypeElement;

const CLASSIFIED: ReadonlySet<string> = new Set(CLASSIFIED_KINDS);

export function isClassifiedElement(el: BimElement | undefined): el is ClassifiedElement {
  return el !== undefined && CLASSIFIED.has(el.kind);
}

export function isValuedElement(el: BimElement | undefined): el is ValuedElement {
  return isClassifiedElement(el) && el.kind !== "part";
}

export const ELEMENT_CORE_STEP = "element_core";

/** The kind's element-core step, once `upgrade.ts` has registered it. */
export function elementCoreStep(kind: ElementCoreKind): SchemaStep | undefined {
  return schemaSteps(kind).find((s) => s.name === ELEMENT_CORE_STEP);
}

/** Whether the command being decided may write a shape gated on `feature`: the server advertised it (client) or every peer did (server); false inside undo. */
export function peerReads(feature: string): boolean {
  return stepAllowed({ kind: "wall", from: 1, to: 2, name: `probe:${feature}`, feature });
}

/** Whether the command being decided may store element-core fields (the peers read `elements:core`). */
export function elementCoreWritable(): boolean {
  return peerReads(ELEMENTS_CORE_FEATURE);
}

/** Inside undo: no step runs, gated or not, and the element gates stand aside (undo restores stored records exactly). */
export function decidingUndo(): boolean {
  return !stepAllowed({ kind: "wall", from: 1, to: 2, name: "elements:undo-probe", feature: null });
}

const KIND_WORDS: Readonly<Record<ElementCoreKind, string>> = {
  wall: "Wall",
  slab: "Slab",
  opening: "Opening",
  room: "Room",
  grid: "Grid",
  column: "Column",
  beam: "Beam",
  component: "Component",
};

/** How any classed element is named in a refusal: the building kinds as `coreElementName`, then "Zone Catchment C1", "Space 101 Office", "System Storm 1", "Run segment r-3", "Part MH-1". */
export function elementName(el: CoreElement | ClassifiedElement): string {
  switch (el.kind) {
    case "zone":
      return `Zone ${el.name || el.id}`;
    case "space":
      return `Space ${[el.number, el.name].filter(Boolean).join(" ") || el.id}`;
    case "mep_system":
      return `System ${el.name || el.id}`;
    case "run_segment":
      return `Run segment ${el.id}`;
    case "part":
      return `Part ${el.mark || el.id}`;
    case "element_type":
      return `Type ${el.name || el.id}`;
    default:
      return coreElementName(el);
  }
}

/** How an element is named in a refusal ("Wall W-3", "Room 101 Kitchen", "Grid A"). */
export function coreElementName(el: CoreElement): string {
  const words = KIND_WORDS[el.kind];
  switch (el.kind) {
    case "opening":
      return el.mark ? `${el.openingType === "window" ? "Window" : el.openingType === "door" ? "Door" : words} ${el.mark}` : `${words} ${el.id}`;
    case "room":
      return `Room ${[el.number, el.name].filter(Boolean).join(" ") || el.id}`;
    case "grid":
      return `Grid ${el.label || el.id}`;
    case "component":
      return `${el.typeName || words} ${el.id}`;
    case "beam":
      return `${el.sectionName ? `${el.sectionName} beam` : words} ${el.id}`;
    default:
      return `${words} ${el.id}`;
  }
}
