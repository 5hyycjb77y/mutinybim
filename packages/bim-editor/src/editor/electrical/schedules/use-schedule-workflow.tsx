'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { documentIndex, formScheduleKinds, type ModelState, type ViewElement } from '@permitzip/bim-kernel'
import type { SubmitCommand } from '../../views-sheets/types'
import type { NewScheduleFormSlot } from '../../schedules/new-schedule-plan'
import type { NecRules } from '../use-nec-rules'
import { electricalFormSlot } from './FormScheduleFields'
import { isBoundKind, type ScheduleChoice } from './schedule-plan'
import { ScheduleProperties } from './ScheduleProperties'
import { ScheduleTemplateEditor } from './ScheduleTemplateEditor'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useScheduleTemplatesFrom } from './use-schedule-templates'

export interface ScheduleAction {
  readonly run: (kind: ScheduleChoice) => void
  /** Null when this kind can be made now, else why not. */
  readonly blockedFor: (kind: ScheduleChoice) => string | null
}

export interface ScheduleWorkflowInput {
  readonly model: ModelState | null
  readonly nec: NecRules
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
  /** The panel a new panel schedule is for: the selected one, or the panel of the selected device. */
  readonly panelId: string | null
  /** Panelboards, switchboards and transformers in the model. */
  readonly panelCount: number
  /** Opens the one New schedule window on a pick (`form:<kind>`, `builtin:equipment`); the surface owns the window. */
  readonly openNewSchedule: (pick: string) => void
}

export interface ScheduleWorkflow {
  readonly action: ScheduleAction
  readonly overlay: ReactNode
  /** The Schedule section for a view's properties; null when it isn't a form schedule. */
  readonly propertiesFor: (view: ViewElement) => ReactNode
  /** What this add-on lends the New schedule window for its form kinds. */
  readonly formSlot: NewScheduleFormSlot
}

const PLACE_PANEL_FIRST = 'Place a panel first: Electrical › Panel, then name it in its properties.'

/** Electrical › Schedules (they open the one New schedule window), the form kinds' fields in it, and a schedule's properties and template editor. */
export function useScheduleWorkflow(input: ScheduleWorkflowInput): ScheduleWorkflow {
  const { model, nec, editBlocked, submit, panelId, openNewSchedule } = input
  const [editing, setEditing] = useState<string | null>(null)
  const hasFormSchedule = useMemo(() => (model ? documentIndex(model).views.some((v) => v.props?.formSchedule) : false), [model])
  // Loaded whenever the model has a form schedule or this add-on's kinds may be asked for in the window.
  const templates = useScheduleTemplatesFrom(useEditorHost().data.firmLibrary, model !== null || hasFormSchedule)
  const hasPanels = input.panelCount > 0
  // Read on every render (the pack set memoizes it): a form kind whose add-on registers after this mounts is
  // offered once it has, instead of the New schedule window saying "still loading" until a reload.
  const kindsKey = formScheduleKinds().join('\n')
  const formSlot = useMemo(() => electricalFormSlot(kindsKey === '' ? [] : kindsKey.split('\n'), { nec: { label: nec.label, edition: nec.edition }, templates, initialPanelId: panelId }), [kindsKey, nec.label, nec.edition, templates, panelId])

  const blockedFor = (kind: ScheduleChoice): string | null => {
    if (!model) return 'The model is still opening.'
    if (editBlocked) return editBlocked
    if (isBoundKind(kind) && !hasPanels) return PLACE_PANEL_FIRST
    return null
  }

  const editingView = editing && model ? documentIndex(model).views.find((v) => v.id === editing) : undefined
  const editingDef = editingView?.props?.formSchedule

  const overlay = model && editingView && editingDef ? <ScheduleTemplateEditor key={editingView.id} model={model} viewId={editingView.id} def={editingDef} submit={submit} onClose={() => setEditing(null)} /> : null

  const propertiesFor = (view: ViewElement): ReactNode => {
    const def = view.props?.formSchedule
    if (!model || !def) return null
    return <ScheduleProperties key={view.id} model={model} view={view} def={def} canEdit={editBlocked === null} blockedReason={editBlocked ?? ''} submit={submit} templates={templates} onEditTemplate={() => setEditing(view.id)} />
  }

  return {
    action: {
      run: (kind) => {
        if (blockedFor(kind)) return
        openNewSchedule(kind === 'mechanical_equipment' ? 'builtin:equipment' : `form:${kind}`)
      },
      blockedFor,
    },
    overlay,
    propertiesFor,
    formSlot,
  }
}
