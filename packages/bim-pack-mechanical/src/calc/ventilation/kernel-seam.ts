/**
 * What the engine reads and returns: the kernel's outdoor-air reader contract
 * (`kernel.outdoor_air_reader`) and this add-on's fields and table.
 */
export {
  OUTDOOR_AIR_READER_POINT,
  registeredVentilationReader,
  VENTILATION_NOT_LOADED,
  VENTILATION_STANDARD_IDS,
  type GoverningStandard,
  type SpaceStandardVentilation,
  type SpaceVentilation,
  type VentilationCite,
  type VentilationInput,
  type VentilationReader,
  type VentilationStandardId,
  type ZoneServingUnit,
  type ZoneStandardVentilation,
  type ZoneVentilation,
} from "@permitzip/bim-kernel";
export * from "../../fields/ventilation";
export * from "../../blocks/ventilation-table";
