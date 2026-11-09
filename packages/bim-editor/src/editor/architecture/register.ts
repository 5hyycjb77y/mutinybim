import { ADDON_UI } from '@permitzip/bim-pack-architecture/ui'
import type { AddonScheduleOffer } from '../../contracts/bim/addon-schedule-templates'
import { contributionsFrom, tabsFrom } from '../contributions/screens'

/** This add-on's loader map: each id in its `ADDON_UI` and the screen code behind it, all behind `import()`. */
export const SCREENS = contributionsFrom(ADDON_UI, {
  tabs: tabsFrom(ADDON_UI, () => import('./architecture-tab')),
  components: { [ADDON_UI.slots[0].id]: () => import('./workflow-host').then((m) => m.WorkflowHost) },
})

/** The schedule templates this add-on brings, by name, for New schedule… while it is off. */
export const SCHEDULE_OFFER: AddonScheduleOffer = ADDON_UI
