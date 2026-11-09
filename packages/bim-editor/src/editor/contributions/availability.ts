import type { ModelState } from '@permitzip/bim-kernel'
import { isFirstPartyPackId, type Pack } from '@permitzip/bim-kernel/packs'
import { addOns } from '../../contracts/building-model/add-ons'
import type { AddonAvailability } from './types'

const cache = new WeakMap<object, { readonly host: readonly Pack[]; readonly availability: AddonAvailability }>()
const NO_PINS: object = {}

/**
 * Which add-ons the model's screens show: the first-party add-ons always; a
 * pinned add-on this host has (the same pins `bindPinnedPacks` binds); and,
 * apart, a pinned add-on this host lacks, which the screens name as not
 * loaded. Pure and memoised on the model's pins, so the ribbon can call it on
 * every render.
 */
export function addonAvailability(model: Pick<ModelState, 'settings'> | null, host: readonly Pack[] = addOns()?.host.installedPacks() ?? []): AddonAvailability {
  const pins = model?.settings.packs
  const key = pins ?? NO_PINS
  const held = cache.get(key)
  if (held && held.host === host) return held.availability
  const active = new Set<string>()
  const notLoaded = new Map<string, string>()
  for (const pin of pins ?? []) {
    if (isFirstPartyPackId(pin.id)) continue
    const pack = host.find((p) => p.manifest.id === pin.id && p.manifest.version === pin.version)
    if (pack) active.add(pin.id)
    else notLoaded.set(pin.id, host.find((p) => p.manifest.id === pin.id)?.manifest.name ?? pin.id)
  }
  const availability: AddonAvailability = { active, notLoaded }
  cache.set(key, { host, availability })
  return availability
}
