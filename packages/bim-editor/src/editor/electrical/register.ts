import { ADDON_UI } from '@permitzip/bim-pack-electrical/ui'
import { contributionsFrom, tabsFrom } from '../contributions/screens'

/** This add-on's loader map: each id in its `ADDON_UI` and the screen code behind it. */
export const SCREENS = contributionsFrom(ADDON_UI, {
  tabs: tabsFrom(ADDON_UI, () => import('./electrical-tab')),
  components: { [ADDON_UI.slots[0].id]: () => import('./workflow-host').then((m) => m.WorkflowHost) },
})
