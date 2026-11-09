import type { ElementKind, PipeMaterialRow } from "@permitzip/bim-kernel";
import type { PackClass, ServiceRow } from "@permitzip/bim-pack/runtime";
import { CIVIL_CLASS, CIVIL_RCP, CIVIL_RUNOFF, CIVIL_STORM_ADAPTER, CIVIL_STORM_SERVICE, type CivilClassId } from "./ids";

/**
 * The civil classes and the storm service row: plain data contributed through
 * the pack contract.
 *
 * IFC 4.3 hints (entity / PredefinedType). "(?)" marks a choice this pack
 * could not confirm against the IFC 4.3 ADD2 documentation:
 * - manhole: IfcDistributionChamberElement MANHOLE;
 * - storm inlet: IfcWasteTerminal GULLYSUMP (?) (a catch basin: a gully with a sump);
 * - outfall: IfcDistributionChamberElement USERDEFINED "OUTFALL" (?) (IFC has no outfall type);
 * - storm pipe: IfcPipeSegment RIGIDSEGMENT;
 * - alignment: IfcAlignment (4.3), no PredefinedType;
 * - catchment: IfcSpatialZone USERDEFINED "CATCHMENT".
 *
 * Structures are parts, catchments outlined zones and the storm network a
 * system; each carries its class explicitly (`set_element_class`), and the
 * rule here also names the element kind, so a class can only be given to the
 * right kind. A storm pipe is recognised: any run segment whose system is a
 * `civil.storm` system.
 */

const byClassId = (kind: ElementKind, id: CivilClassId) => ({ elementKinds: [kind], where: [{ path: "classId", op: "equals" as const, value: id }] });

export const CIVIL_CLASSES: readonly PackClass[] = [
  { id: CIVIL_CLASS.stormInlet, label: "Storm inlet", discipline: "civil", ifc: { entity: "IfcWasteTerminal", predefinedType: "GULLYSUMP" }, recognize: byClassId("part", CIVIL_CLASS.stormInlet), description: "A grate or curb inlet that takes surface runoff into the storm network" },
  { id: CIVIL_CLASS.manhole, label: "Manhole", discipline: "civil", ifc: { entity: "IfcDistributionChamberElement", predefinedType: "MANHOLE" }, recognize: byClassId("part", CIVIL_CLASS.manhole), description: "A structure where storm pipes join, with a rim and an invert" },
  { id: CIVIL_CLASS.outfall, label: "Outfall", discipline: "civil", ifc: { entity: "IfcDistributionChamberElement", predefinedType: "USERDEFINED", objectType: "OUTFALL" }, recognize: byClassId("part", CIVIL_CLASS.outfall), description: "Where the storm network discharges, at a fixed invert" },
  { id: CIVIL_CLASS.stormPipe, label: "Storm pipe", discipline: "civil", ifc: { entity: "IfcPipeSegment", predefinedType: "RIGIDSEGMENT" }, recognize: { elementKinds: ["run_segment"], where: [{ path: "system.systemKind", op: "equals", value: CIVIL_STORM_SERVICE }] }, description: "A pipe run segment on a storm system" },
  { id: CIVIL_CLASS.stormSystem, label: "Storm system", discipline: "civil", ifc: { entity: "IfcDistributionSystem", predefinedType: "STORMWATER" }, recognize: byClassId("mep_system", CIVIL_CLASS.stormSystem), description: "A site storm network: its design storm and minimum slope" },
  { id: CIVIL_CLASS.alignment, label: "Alignment", discipline: "civil", ifc: { entity: "IfcAlignment" }, recognize: byClassId("component", CIVIL_CLASS.alignment), description: "A stationed centreline with a vertical profile (a road, a swale, a utility run)" },
  { id: CIVIL_CLASS.catchment, label: "Catchment", discipline: "civil", ifc: { entity: "IfcSpatialZone", predefinedType: "USERDEFINED", objectType: "CATCHMENT" }, recognize: byClassId("zone", CIVIL_CLASS.catchment), description: "An outlined area whose runoff drains to one inlet" },
];

export const CIVIL_STORM_SERVICE_ROW: ServiceRow = {
  id: CIVIL_STORM_SERVICE,
  label: "Storm (site)",
  discipline: "civil",
  medium: "liquid",
  regime: "gravity",
  connector: "pipe",
  adapter: CIVIL_STORM_ADAPTER,
  quantities: [CIVIL_RUNOFF],
  asSystem: true,
  asLoad: false,
  ifc: { system: "IfcDistributionSystem", predefinedType: "STORMWATER" },
  graphics: { colour: "#1f7a9a", pattern: "solid" },
  solver: "rational",
};

/** Reinforced concrete pipe: the kernel's tables size and fit it as PE; the pack's Manning n reads the row. */
export const CIVIL_PIPE_MATERIALS: readonly PipeMaterialRow[] = [{ id: CIVIL_RCP, label: "Reinforced concrete pipe", fallback: "pe", description: "Class III RCP, ASTM C76" }];
