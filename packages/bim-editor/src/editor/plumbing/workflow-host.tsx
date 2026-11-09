'use client'

import type { ReactNode } from 'react'
import { usePublishWorkflow } from '../contributions/host-slots'
import type { WorkflowHostProps, WorkflowServices } from '../contributions/types'
import { usePlumbingWorkflow } from './use-plumbing-workflow'

function inputFrom(s: WorkflowServices) {
  return {
    model: s.model,
    editBlocked: s.editBlocked,
    modelToolsBlocked: s.modelToolsOff ? 'Route pipe in a plan or the 3D model: open one from the Views and sheets panel.' : null,
    submit: s.submit,
    routePipe: () => s.routeAs('pipe'),
    placeFixture: s.choosePlace,
    openRiser: () => s.openDiagram('plumbing_riser'),
    notify: s.notify,
    selectedIds: s.selectedIds,
    select: s.select,
    previewParts: s.previewParts,
    serverFeatures: s.serverFeatures,
  }
}

/** This add-on's workflow, mounted by the surface over the canvas: its dialogs draw here; its ribbon input goes up through the outlet. */
export function WorkflowHost({ services, outlet }: WorkflowHostProps): ReactNode {
  const workflow = usePlumbingWorkflow(inputFrom(services))
  usePublishWorkflow(outlet, { data: { ribbon: workflow.ribbon, autoTab: null, shared: {} } })
  return workflow.overlay
}
