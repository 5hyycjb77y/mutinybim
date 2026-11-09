import { registeredVentilationReader } from '@permitzip/bim-kernel'
import { OUTDOOR_AIR_ENGINE, VentilationEngine } from '@permitzip/bim-pack-mechanical'

// What this page's files read: the kernel's outdoor-air reader contract and the Mechanical add-on's engine, standards and table.
export { VENTILATION_STANDARD_IDS, type SpaceVentilation, type VentilationStandardId, type ZoneVentilation } from '@permitzip/bim-kernel'
export {
  resolveGoverningStandard,
  VENTILATION_STANDARDS,
  VENTILATION_TABLE_TITLE,
  ZONE_VENTILATION_TEMPLATE,
  ZONE_VENTILATION_TITLE,
  type VentilationScope,
  type VentilationTable,
} from '@permitzip/bim-pack-mechanical'

/**
 * The ventilation engine for this page: the engine of the model's set in
 * force (a model's own pack may bring one), else the Mechanical add-on's
 * (`OUTDOOR_AIR_ENGINE`, the built-in space uses, the same catalog the Spaces
 * panel pins from), which every space and zone field, schedule and sheet
 * block reads too. The Ventilation panel switches the governing standard on a
 * copy, never here.
 */
export function ventilationEngine(): VentilationEngine {
  const current = registeredVentilationReader()
  return current instanceof VentilationEngine ? current : OUTDOOR_AIR_ENGINE
}
