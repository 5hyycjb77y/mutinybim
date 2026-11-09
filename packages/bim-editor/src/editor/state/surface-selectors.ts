import { elementsOfKind, modelLevels, plannedPartGroups, siteOf, type BimElement, type SiteFrame } from '@permitzip/bim-kernel'
import { addonAvailability } from '../contributions/availability'
import type { AddonAvailability } from '../contributions/types'
import { selectElementsOfKinds, type ModelSelector } from '../model-store'
import { disciplinesForTab } from '../planned/place-surface'
import { planTabIds } from '../ribbon/plan-group'

/**
 * Reads the Building Model surface used to take from the whole model, as
 * store selectors (round 7 lane S; round 8 lane H: site, plan levels, add-ons). Each
 * returns the previous value when nothing it shows changed, so the surface's
 * chrome stops depending on them; the surface itself still re-renders on
 * every edit until its last whole-model read has moved.
 */

const SYSTEM_KINDS: ReadonlySet<BimElement['kind']> = new Set(['mep_system'])

/** The model's systems (Route's system picker). One per surface: the selector remembers the last snapshot it saw. */
export function createSystemsSelector(): ModelSelector<readonly BimElement[]> {
  return selectElementsOfKinds(SYSTEM_KINDS)
}

const CATALOG_KINDS: ReadonlySet<BimElement['kind']> = new Set(['service_catalog'])

/** The project's catalog records (pipe types and the like), from the kind index: Route reads its pipe types from these, never the whole model. */
export function createCatalogSelector(): ModelSelector<readonly BimElement[]> {
  return selectElementsOfKinds(CATALOG_KINDS)
}

/** How many parts are not placed yet, per Plan tab (the Not placed yet badges). */
export const selectPlannedCounts: ModelSelector<Readonly<Record<string, number>>> = (s) => {
  const out: Record<string, number> = {}
  for (const tabId of planTabIds()) out[tabId] = s.model ? plannedPartGroups(s.model.elements, disciplinesForTab(tabId)).reduce((sum, g) => sum + g.rows.length, 0) : 0
  return out
}

const EMPTY_ELEMENTS: Readonly<Record<string, BimElement>> = {}

/** The model's site frame (origin, base point, north). The same object until an edit changes the site. */
export const selectSite: ModelSelector<SiteFrame> = (s) => siteOf(s.model ?? { elements: EMPTY_ELEMENTS })

/** The model's own level names for the New plan picker: its levels, then any level a run or piece of equipment names. Compare with `shallowArrayEqual`. */
export const selectModelLevelNames: ModelSelector<readonly string[]> = (s) => {
  const model = s.model
  if (!model) return []
  const names = modelLevels(model).map((l) => l.name)
  for (const el of elementsOfKind(model.elements, 'duct_segment', 'equipment')) names.push(el.partition?.level ?? 'L1')
  return names
}

/** Which add-ons this model uses and which this host lacks. The same object until the model's add-on pins change. */
export const selectAddons: ModelSelector<AddonAvailability> = (s) => addonAvailability(s.model)

/** Same counts on every tab. */
export function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}
