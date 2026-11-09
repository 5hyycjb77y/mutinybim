/**
 * How every IFC -> Fragments conversion is configured, shared by the host app's
 * linked-model worker and the fixture script so both keep the same data.
 * No three.js here: the server imports this module.
 *
 * Fragments' default import keeps property sets with single values, quantity
 * sets and type objects, but silently drops every other IFC property value
 * kind, MEP ports, systems, port connections and classifications. Revit
 * writes enumerated values and type property sets, and the MEP model's
 * meaning is in its ports and systems, so those are added here.
 */
import * as WEBIFC from "web-ifc";

/** The parts of Fragments' IfcImporter this module touches (structural, so callers pass the real importer). */
export interface ConfigurableIfcImporter {
  readonly classes: { readonly abstract: { add(value: number): unknown } };
  readonly relations: Map<number, { forRelating: string; forRelated: string }>;
}

/** Non-element IFC classes whose rows must survive conversion (property values, ports, systems, classification). */
export const EXTRA_IFC_CLASSES: readonly number[] = [
  WEBIFC.IFCPROPERTYSET,
  WEBIFC.IFCPROPERTYSINGLEVALUE,
  WEBIFC.IFCPROPERTYENUMERATEDVALUE,
  WEBIFC.IFCPROPERTYENUMERATION,
  WEBIFC.IFCPROPERTYLISTVALUE,
  WEBIFC.IFCPROPERTYBOUNDEDVALUE,
  WEBIFC.IFCPROPERTYTABLEVALUE,
  WEBIFC.IFCPROPERTYREFERENCEVALUE,
  WEBIFC.IFCCOMPLEXPROPERTY,
  WEBIFC.IFCELEMENTQUANTITY,
  WEBIFC.IFCQUANTITYLENGTH,
  WEBIFC.IFCQUANTITYAREA,
  WEBIFC.IFCQUANTITYVOLUME,
  WEBIFC.IFCQUANTITYCOUNT,
  WEBIFC.IFCQUANTITYWEIGHT,
  WEBIFC.IFCQUANTITYTIME,
  WEBIFC.IFCPHYSICALCOMPLEXQUANTITY,
  WEBIFC.IFCDISTRIBUTIONPORT,
  WEBIFC.IFCDISTRIBUTIONSYSTEM,
  WEBIFC.IFCDISTRIBUTIONCIRCUIT,
  WEBIFC.IFCSYSTEM,
  WEBIFC.IFCBUILDINGSYSTEM,
  WEBIFC.IFCBUILTSYSTEM,
  WEBIFC.IFCZONE,
  WEBIFC.IFCSPATIALZONE,
  WEBIFC.IFCCLASSIFICATION,
  WEBIFC.IFCCLASSIFICATIONREFERENCE,
];

/**
 * Relationships to keep, with the relation names Fragments' own map uses for
 * them. Ports hang off their element by IfcRelNests in IFC4 and 4.3, and by
 * IfcRelConnectsPortToElement in IFC2x3; both are kept.
 */
export const EXTRA_IFC_RELATIONS: ReadonlyArray<readonly [number, { forRelating: string; forRelated: string }]> = [
  [WEBIFC.IFCRELNESTS, { forRelating: "IsNestedBy", forRelated: "Nests" }],
  [WEBIFC.IFCRELASSIGNSTOGROUP, { forRelating: "IsGroupedBy", forRelated: "HasAssignments" }],
  [WEBIFC.IFCRELSERVICESBUILDINGS, { forRelating: "ServicesBuildings", forRelated: "ServicedBySystems" }],
  [WEBIFC.IFCRELCONNECTSPORTS, { forRelating: "ConnectedTo", forRelated: "ConnectedFrom" }],
  [WEBIFC.IFCRELCONNECTSPORTTOELEMENT, { forRelating: "ContainedIn", forRelated: "HasPorts" }],
  [WEBIFC.IFCRELASSOCIATESCLASSIFICATION, { forRelating: "HasReferences", forRelated: "ClassificationRefForObjects" }],
];

export function configureIfcImporter<T extends ConfigurableIfcImporter>(importer: T): T {
  for (const cls of EXTRA_IFC_CLASSES) importer.classes.abstract.add(cls);
  for (const [rel, names] of EXTRA_IFC_RELATIONS) {
    if (!importer.relations.has(rel)) importer.relations.set(rel, { ...names });
  }
  return importer;
}
