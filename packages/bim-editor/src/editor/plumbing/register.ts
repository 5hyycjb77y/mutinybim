import { createElement } from 'react'
import { Flame } from 'lucide-react'
import { ADDON_UI } from '@permitzip/bim-pack-plumbing/ui'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'
import { contributionsFrom, tabsFrom } from '../contributions/screens'
import type { InspectorSectionProps, RunSectionProps } from '../contributions/types'

/** This add-on's loader map: each id in its `ADDON_UI` and the screen code behind it (here and in `../blocks`). */
export const SCREENS = contributionsFrom(ADDON_UI, {
  tabs: tabsFrom(ADDON_UI, () => import('./plumbing-tab')),
  commands: {
    'sheet-gas-schedule': () =>
      Promise.all([import('../blocks/gas-ribbon'), import('../balance/ribbon')]).then(([g, b]) => ({
        command: (ctx: BuildingModelRibbonContext) => {
          const place = ctx.sheet?.placeTable
          return g.gasScheduleCommand(place ? () => place((sheet, submit, levelId) => b.placeTableBlock(sheet, g.gasScheduleBlock(levelId ? { kind: 'level', levelId } : { kind: 'model' }), submit)) : undefined, ctx.editBlocked)
        },
      })),
  },
  icons: { Flame },
  components: {
    'load-point': () =>
      import('./LoadPointProperties').then((m) => {
        function LoadPointSection({ model, elementId, canEdit, onCommand }: InspectorSectionProps) {
          const point = model.elements[elementId]
          return point?.kind === 'load_point' ? createElement(m.LoadPointProperties, { model, point, canEdit, onCommand }) : null
        }
        return LoadPointSection
      }),
    [ADDON_UI.slots[1].id]: () => import('./workflow-host').then((m) => m.WorkflowHost),
    'run-inline': () =>
      import('./run/PipeInlineForm').then((m) => {
        function InlineSection({ element, model, canEdit, onCommand }: RunSectionProps) {
          return element.kind === 'run_segment' && element.domain === 'pipe' ? createElement(m.PipeInlineForm, { key: `inline:${element.id}:${element.version}`, segment: element, model, canEdit, onCommand }) : null
        }
        return InlineSection
      }),
    'run-hydraulics': () =>
      import('./run/RunHydraulics').then((m) => {
        function HydraulicsSection({ element, model, canEdit, onCommand, projectId }: RunSectionProps) {
          return createElement(m.RunHydraulics, { element, model, canEdit, onCommand, ...(projectId ? { projectId } : {}) })
        }
        return HydraulicsSection
      }),
  },
})
