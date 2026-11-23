'use client'

import type { ReactNode } from 'react'
import { usePublishWorkflow } from '../contributions/host-slots'
import type { WorkflowHostProps, WorkflowServices } from '../contributions/types'
import { useElectricalWorkflow } from './use-electrical-workflow'

function inputFrom(s: WorkflowServices) {
  return {
    projectId: s.projectId,
    model: s.model,
    selectedIds: s.selectedIds,
    editBlocked: s.editBlocked,
    modelToolsBlocked: s.modelToolsOff ? 'Place electrical parts in a plan or the 3D model: open one from the Views and sheets panel.' : null,
    submit: s.submit,
    place: s.placeType,
    activeTab: s.activeTab,
    notify: s.notify,
    openSheetId: s.openSheetId,
    onOpenSheet: s.onOpenSheet,
    ...(s.openNewSchedule ? { openNewSchedule: s.openNewSchedule } : {}),
    openDiagram: s.openDiagram,
    previewParts: s.previewParts,
    ...(s.setScalarHeatmap ? { setScalarHeatmap: s.setScalarHeatmap } : {}),
    ...(s.setLightEmitters ? { setLightEmitters: s.setLightEmitters } : {}),
    ...(s.setLightingPreset ? { setLightingPreset: s.setLightingPreset } : {}),
    ...(s.lightingPreset ? { lightingPreset: s.lightingPreset } : {}),
    ...(s.subscribeHover ? { subscribeHover: s.subscribeHover } : {}),
    ...(s.setClickHandler ? { setClickHandler: s.setClickHandler } : {}),
    framePlan: s.framePlan,
    levelId: s.levelId,
    select: s.select,
    pickPartAt: s.pickPartAt,
    pickPlanPointAt: s.pickPlanPointAt,
  }
}

/** This add-on's workflow, mounted by the surface over the canvas: its dialogs and docked views draw here; the rest goes up through the outlet. */
export function WorkflowHost({ services, outlet }: WorkflowHostProps): ReactNode {
  const workflow = useElectricalWorkflow(inputFrom(services))
  usePublishWorkflow(outlet, {
    data: {
      ribbon: workflow.ribbon,
      autoTab: workflow.autoTab,
      shared: {
        circuitRules: workflow.nec,
        necEdition: workflow.necEdition,
        newScheduleForms: workflow.newScheduleForms,
        openFormView: (kind: string, elementId: string) => {
          if (kind !== 'panel') return false
          workflow.openPanelView(elementId)
          return true
        },
      },
    },
    properties: workflow.properties,
    viewProperties: workflow.scheduleProperties,
  })
  return workflow.overlay
}
