import type * as InstalledPacks from './installed-packs'
import type * as ElectricalHost from '@permitzip/bim-pack-electrical/host'
import type * as PlumbingHost from '@permitzip/bim-pack-plumbing/host'
import type * as Calc from '@permitzip/bim-calc'

/**
 * The Building Model's add-ons, loaded on first use (product decision, Nov 4 2026:
 * route-level code splitting). The trade add-ons and their engine are their
 * own chunk: the surface's frame paints without them and downloads them in
 * parallel with the model's config, and the model session opens only once
 * they are installed, so no screen ever draws a model without its add-ons.
 * `prefetchAddOns()` starts the download on intent (a pointer over or focus
 * on a link into the Building Model). Server routes and the agent worker keep
 * importing `installed-packs` directly.
 */
export interface AddOns {
  readonly host: typeof InstalledPacks
  readonly electrical: typeof ElectricalHost
  readonly plumbing: typeof PlumbingHost
  readonly calc: typeof Calc
}

let loading: Promise<AddOns> | null = null
let loaded: AddOns | null = null

/** Download and install the add-ons once; a failed download can be retried. */
export function loadAddOns(): Promise<AddOns> {
  loading ??= Promise.all([import('./installed-packs'), import('@permitzip/bim-pack-electrical/host'), import('@permitzip/bim-pack-plumbing/host'), import('@permitzip/bim-calc'), import('../bim/chart-kinds')])
    .then(([host, electrical, plumbing, calc, charts]) => {
      host.ensureFirstPartyAddOns()
      charts.ensureBimChartKinds()
      loaded = { host, electrical, plumbing, calc }
      return loaded
    })
    .catch((err: unknown) => {
      loading = null
      throw err
    })
  return loading
}

/** Start the download early (intent: hovering or focusing a way into the Building Model). */
export function prefetchAddOns(): void {
  loadAddOns().catch((err: unknown) => console.error('[add-ons] prefetch failed; the Building Model retries when it opens', err))
}

/** The add-ons once installed; null before (no model is open then). */
export function addOns(): AddOns | null {
  return loaded
}

/** The add-ons where a model is open, which only happens after they are installed. */
export function requireAddOns(): AddOns {
  if (!loaded) throw new Error('[add-ons] read before the Building Model installed its add-ons; open the model session only after loadAddOns()')
  return loaded
}
