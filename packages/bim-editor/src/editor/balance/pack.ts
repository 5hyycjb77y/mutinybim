import type { PressureTargetSource } from '@permitzip/bim-kernel'
import { spaceUsePressureTarget, type SpaceUseCatalog } from '@permitzip/bim-library'

/**
 * Each space's design pressure from its use's row in a space-use library
 * (kitchens negative, dining positive). The page's own targets come from the
 * Mechanical add-on (`@permitzip/bim-pack-mechanical`), which carries this same
 * reading of the built-in library as a pack row, so the zone fields, the
 * pressurization table, the sheet block and the coordination checks all
 * compare against the same targets in every process.
 */
export function pressureTargetsFrom(catalog: SpaceUseCatalog): PressureTargetSource {
  return (space) => (space.use && space.use.libraryId === catalog.libraryId ? spaceUsePressureTarget(catalog, space.use.useId) : null)
}
