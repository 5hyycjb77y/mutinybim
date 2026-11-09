/**
 * `@permitzip/bim-ifc`: IFC 4.3 ADD2 export of a MutinyBIM model (Apache-2.0,
 * pure TypeScript, deterministic). It reads the kernel's registries, so a
 * class, parameter, service or zone purpose a pack defines exports with no
 * change here. Must not import any host app's code.
 */
export { BIM_IFC_VERSION, IFC_SCHEMA, exportIfc, type IfcExportCounts, type IfcExportOptions, type IfcExportReport, type IfcExportResult, type IfcZoneHome } from "./export";
export { IFC_GUID_PATTERN, MUTINYBIM_IFC_NAMESPACE, derivedIfcGuid, ifcGuidToUuid, isIfcGuid, isUuid, projectNamespace, relationshipIfcGuid, sha1, uuidToIfcGuid, uuidV5 } from "./guid";
export { PROXY, primaryClass, resolveIfcClass, type ResolvedIfcClass } from "./mapping";
export { ParameterHomes, UNMAPPED_PARAMETER_SET, baselineParameterHomes, registryParameterHomes, type ParameterHome } from "./properties";
export { danglingReferences, decodeStepString, entityCounts, readStep, rootedEntities, type ReadEntity, type StepFile, type StepToken } from "./read";
export { ifcEntityName, isInstantiableEntity, ownAttributes, predefinedTypes } from "./schema-ifc4x3";
export { serializeStep, stepReal, stepString, StepGraph, type StepEntity, type StepHeader, type StepValue } from "./step";
export { measureOf, type IfcMeasure } from "./units";
export { GeometryReader, IfcReadCancelled, boundsOf, hostFrame, importIfc, lengthScale, readIfcSource, schemaEntity, type Frame, type IfcImportInput, type IfcReadOptions } from "./import";
export { IFC_EXPORT_TARGET, IFC_IMPORT_SOURCE, type IfcTargetOutput } from "./formats";
