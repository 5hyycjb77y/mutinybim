import { createElement } from 'react'
import { Fan, Flame, TableProperties, Wind } from 'lucide-react'
import { ADDON_UI } from '@permitzip/bim-pack-mechanical/ui'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'
import { contributionsFrom, tabsFrom } from '../contributions/screens'
import type { PartSectionProps, RailSectionProps, RouteSectionProps, RunSectionProps, SpaceLoadsSectionProps } from '../contributions/types'

const RAIL_ID = ADDON_UI.slots[0].id
const KITCHEN_HEAT_RAIL_ID = 'kitchen-heat-panel'

/** This add-on's loader map: each id in its `ADDON_UI` and the screen code behind it (here and in `../balance`). */
export const SCREENS = contributionsFrom(ADDON_UI, {
  tabs: tabsFrom(ADDON_UI, () => import('./mechanical-tab')),
  commands: {
    'sheet-ventilation-table': () =>
      Promise.all([import('./ribbon'), import('../balance/ribbon')]).then(([v, b]) => ({
        command: (ctx: BuildingModelRibbonContext) => {
          const place = ctx.sheet?.placeTable
          return v.ventilationTableCommand(place ? () => place((sheet, submit, levelId) => b.placeTableBlock(sheet, v.ventilationTableBlock(levelId ? { kind: 'level', levelId } : { kind: 'model' }), submit)) : undefined, ctx.editBlocked)
        },
      })),
    'model-ventilation': () =>
      import('./ribbon').then((m) => ({
        command: (ctx: BuildingModelRibbonContext) => {
          const rail = ctx.plan?.openRail
          return m.ventilationPanelCommand('model', rail ? () => rail.open(RAIL_ID) : null, rail ? rail.blocked : null)
        },
      })),
    'sheet-pressurization-table': () =>
      import('../balance/ribbon').then((b) => ({
        command: (ctx: BuildingModelRibbonContext) => {
          const place = ctx.sheet?.placeTable
          return b.pressurizationTableCommand(place ? () => place((sheet, submit) => b.placeTableBlock(sheet, b.pressurizationTableBlock({ kind: 'model' }), submit)) : undefined, ctx.editBlocked)
        },
      })),
    'model-kitchen-heat': () =>
      import('./ribbon').then((m) => ({
        command: (ctx: BuildingModelRibbonContext) => {
          const rail = ctx.plan?.openRail
          return m.kitchenHeatPanelCommand(rail ? () => rail.open(KITCHEN_HEAT_RAIL_ID) : null, rail ? rail.blocked : null)
        },
      })),
  },
  icons: { Fan, Flame, TableProperties, Wind },
  components: {
    [RAIL_ID]: () =>
      import('./VentilationPanel').then((m) => {
        function RailSection(props: RailSectionProps) {
          return createElement(m.VentilationPanel, { ...props, adoption: null })
        }
        return RailSection
      }),
    'run-transition-shape': () =>
      import('./RunTransitionShape').then((m) => {
        function TransitionShapeSection({ element, canEdit, onCommand }: RunSectionProps) {
          return element.kind === 'run_fitting' ? createElement(m.RunTransitionShape, { key: `shape:${element.id}:${element.version}`, fitting: element, canEdit, onCommand }) : null
        }
        return TransitionShapeSection
      }),
    'run-design': () =>
      import('./RunDuctDesign').then((m) => {
        function DesignSection({ element, model, canEdit, onCommand, onResize }: RunSectionProps) {
          return createElement(m.RunDuctDesign, { element, model, canEdit, onCommand, onResize })
        }
        return DesignSection
      }),
    'run-pressure': () =>
      import('./RunPressure').then((m) => {
        function PressureSection({ element, model, canEdit, actorName, onCommand }: RunSectionProps) {
          return createElement(m.RunPressure, { element, model, canEdit, actorName, onCommand })
        }
        return PressureSection
      }),
    'part-air-side': () =>
      import('./PartAirSideFields').then((m) => {
        function AirSideSection(props: PartSectionProps) {
          return createElement(m.PartAirSideFields, props)
        }
        return AirSideSection
      }),
    [KITCHEN_HEAT_RAIL_ID]: () =>
      import('./KitchenHeatPanel').then((m) => {
        function KitchenHeatSection(props: RailSectionProps) {
          return createElement(m.KitchenHeatPanel, props)
        }
        return KitchenHeatSection
      }),
    'space-kitchen-heat': () =>
      import('./KitchenHeatLine').then((m) => {
        function SpaceKitchenHeatSection(props: SpaceLoadsSectionProps) {
          return createElement(m.KitchenHeatLine, props)
        }
        return SpaceKitchenHeatSection
      }),
    'mechanical-workflow': () => import('./workflow-host').then((m) => m.WorkflowHost),
    'route-design': () =>
      import('./RouteDuctDesignFields').then((m) => {
        function RouteDesignSection(props: RouteSectionProps) {
          return props.choices.kind === 'duct' ? createElement(m.RouteDuctDesignFields, props) : null
        }
        return RouteDesignSection
      }),
  },
})
