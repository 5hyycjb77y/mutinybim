import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ElementId } from "../types";

/**
 * IFC relationships (contract 1.11.0, `kernel.ifc_relation` v1).
 *
 * A row writes relationships for its kinds beyond containment: an opening
 * voiding its host and a door filling it, a space's boundaries, a footing's
 * void, a sleeve. The exporter (bim-ifc) asks every row once per export, off
 * the edit path. Entity names are IFC schema identifiers.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const IFC_RELATION_ENTITIES = ["IfcRelVoidsElement", "IfcRelFillsElement", "IfcRelSpaceBoundary", "IfcRelContainedInSpatialStructure", "IfcRelAggregates", "IfcRelDefinesByType"] as const;
export type IfcRelationEntity = (typeof IFC_RELATION_ENTITIES)[number];

/** A synthetic IFC object a relationship needs that is no model record (the `IfcOpeningElement` between a wall and its door). */
export interface IfcSyntheticObject {
  /** Stable within one export, derived from the record ids (`opening:<doorId>`). */
  readonly key: string;
  readonly entity: string;
  readonly predefinedType?: string;
  readonly name?: string;
  /** Numeric attributes of the entity by schema name (`NumberOfRisers`, `RiserHeight` in mm); others are written empty. */
  readonly attributes?: Readonly<Record<string, number>>;
}

export interface IfcRelationSpec {
  readonly entity: IfcRelationEntity;
  /** A model record id, or a synthetic object key. */
  readonly relating: ElementId | string;
  readonly related: readonly (ElementId | string)[];
  /** `IfcRelSpaceBoundary`: `PHYSICAL` / `VIRTUAL`, `INTERNAL` / `EXTERNAL`. */
  readonly physicalOrVirtual?: "PHYSICAL" | "VIRTUAL";
  readonly internalOrExternal?: "INTERNAL" | "EXTERNAL" | "NOTDEFINED";
}

export interface IfcRelationRow {
  readonly id: string;
  readonly label: string;
  /** Kinds whose records it writes relationships for. */
  readonly kinds: readonly string[];
  /** The synthetic objects and relationships for one record. */
  relations(el: BimElement, elements: Elements): { readonly objects: readonly IfcSyntheticObject[]; readonly relations: readonly IfcRelationSpec[] };
}

export const IFC_RELATION_POINT = defineExtensionPoint<IfcRelationRow>({
  id: "kernel.ifc_relation",
  version: 1,
  label: "IFC relationships",
  idOf: (row) => row.id,
});

/** Problems with IFC relation rows (pack conformance), in words. */
export function ifcRelationRowProblems(rows: readonly IfcRelationRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`IFC relation ${row.id} has no label`);
    if (row.kinds.length === 0) out.push(`IFC relation ${row.id} names no kind`);
    if (typeof row.relations !== "function") out.push(`IFC relation ${row.id}: relations must be a function`);
  }
  return out;
}

const byKindOf = (set: PackSet): ReadonlyMap<string, readonly IfcRelationRow[]> => {
  const map = new Map<string, IfcRelationRow[]>();
  for (const row of set.items(IFC_RELATION_POINT)) for (const k of row.kinds) map.set(k, [...(map.get(k) ?? []), row]);
  return map;
};

/** The relation rows for a kind in the set in force, in registration order. */
export function ifcRelationRowsFor(kind: string): readonly IfcRelationRow[] {
  return activePackSet().memo("kernel.ifc_relation#byKind", byKindOf).get(kind) ?? [];
}
