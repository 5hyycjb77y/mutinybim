import type { RevitParameterRecord } from "../library/revit-convert";
import type { BimElement, ModelState } from "../types";
import { groupOf, isOrganized, organizationOf, phaseCreatedOf, phaseDemolishedOf, type Organization } from "./model";

/**
 * Groups and phases across file formats.
 *
 * IFC out: IFC has no phase entity, and groups are IfcGroup with membership
 * through IfcRelAssignsToGroup. An exporter writes one IfcGroup per group
 * that has members (Name = group name, Description = its description) and
 * one property set per element carrying the group and phase names. The set
 * uses the names other authoring tools write ("Phase Created",
 * "Phase Demolished"), so a reader that knows those finds them.
 *
 * Revit in: a linked or extracted Revit element carries its workset and
 * phases as ordinary parameters ("Workset", "Phase Created", "Phase
 * Demolished"). They are hints only: they never change a native element by
 * themselves. `organizationHintsFromRevit` reads them and `matchHints` names
 * the model's own group and phases with the same names, for an import step or
 * a person to apply.
 */

/** Our own set: never the `Pset_` prefix, which buildingSMART reserves for its standard sets. */
export const IFC_ORGANIZATION_PSET = "MutinyBIM_Organization";

/** The name exports before round 5c wrote. Readers still accept it. */
export const LEGACY_IFC_ORGANIZATION_PSET = "Pset_MutinyBIM_Organization";

/** Whether a property set read from IFC is the groups-and-phases set, under its current or its pre-5c name. */
export function isIfcOrganizationPset(name: string): boolean {
  return name === IFC_ORGANIZATION_PSET || name === LEGACY_IFC_ORGANIZATION_PSET;
}

export interface IfcOrganizationProperties {
  /** IfcGroup the element is assigned to (IfcRelAssignsToGroup). */
  readonly group: { readonly name: string; readonly description: string };
  readonly propertySet: {
    readonly name: typeof IFC_ORGANIZATION_PSET;
    readonly properties: Readonly<Record<"Group" | "Phase Created" | "Phase Demolished", string>>;
  };
}

/** What an IFC exporter writes for one element; null for views, sheets, levels and types. */
export function ifcOrganizationProperties(model: ModelState, el: BimElement): IfcOrganizationProperties | null {
  if (!isOrganized(el)) return null;
  const org = organizationOf(model);
  const group = groupOf(org, el);
  const created = phaseName(org, phaseCreatedOf(org, el));
  const demolishedId = phaseDemolishedOf(org, el);
  return {
    group: { name: group.entry.name, description: group.entry.description },
    propertySet: {
      name: IFC_ORGANIZATION_PSET,
      properties: { Group: group.entry.name, "Phase Created": created, "Phase Demolished": demolishedId ? phaseName(org, demolishedId) : "None" },
    },
  };
}

function phaseName(org: Organization, id: string): string {
  return org.phases.find((p) => p.id === id)?.entry.name ?? id;
}

export interface RevitOrganizationHints {
  readonly workset: string | null;
  readonly phaseCreated: string | null;
  readonly phaseDemolished: string | null;
}

function display(records: readonly RevitParameterRecord[], name: string): string | null {
  const p = records.find((r) => r.name.toLowerCase() === name.toLowerCase());
  const value = p?.display ?? (typeof p?.value === "string" ? p.value : null);
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || trimmed.toLowerCase() === "none" ? null : trimmed;
}

/** Workset and phases as a Revit element states them (null where it states none). */
export function organizationHintsFromRevit(parameters: readonly RevitParameterRecord[]): RevitOrganizationHints {
  return { workset: display(parameters, "Workset"), phaseCreated: display(parameters, "Phase Created"), phaseDemolished: display(parameters, "Phase Demolished") };
}

/** The model's group and phases whose names match the hints (case-insensitive); null where none matches. */
export function matchHints(model: Pick<ModelState, "elements" | "connections">, hints: RevitOrganizationHints): { readonly groupId: string | null; readonly phaseCreated: string | null; readonly phaseDemolished: string | null } {
  const org = organizationOf(model);
  const same = (a: string, b: string | null) => b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  return {
    groupId: org.groups.find((g) => same(g.entry.name, hints.workset))?.id ?? null,
    phaseCreated: org.phases.find((p) => same(p.entry.name, hints.phaseCreated))?.id ?? null,
    phaseDemolished: org.phases.find((p) => same(p.entry.name, hints.phaseDemolished))?.id ?? null,
  };
}
