'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ROUTING_CONNECT_INTO_FEATURE, ROUTING_INSERT_PART_FEATURE, type ModelState } from '@permitzip/bim-kernel'
import { CLEANOUT_PROPOSAL_WORDS, cleanoutProposalBlocked, FIXTURE_CONNECT_WORDS, fixtureConnectBlocked, type FixtureConnectTarget, type PlumbingDemandCurve, projectPlumbingSettings, outfallConnectionBlocked } from '@permitzip/bim-pack-plumbing'
import type { SubmitCommand } from '../views-sheets/types'
import { HunterCurveDialog } from './HunterCurveDialog'
import { PipeTypesDialog } from './PipeTypesDialog'
import type { PlumbingAction, PlumbingRibbon } from './plumbing-tab'
import { PlumbingSystemsDialog, pipeSystems, projectSettingsCommand, type PlumbingSystemsTab } from './PlumbingSystemsDialog'
import { OutfallConnectionDialog } from './OutfallConnectionDialog'
import { StacksDialog } from './StacksDialog'
import { ProposeCleanoutsPanel } from './ProposeCleanoutsPanel'
import { ConnectFixturesPanel } from './ConnectFixturesPanel'
import type { ProposalGhost } from '../model-session'

export interface PlumbingWorkflowInput {
  readonly model: ModelState | null
  /** Null when editing is allowed; otherwise why not, in the operator's words. */
  readonly editBlocked: string | null
  /** Why model tools can't run where the person is (a sheet or a detail view is open); null in a plan or the 3D model. */
  readonly modelToolsBlocked: string | null
  readonly submit: SubmitCommand
  /** Start the Route tool on pipe. */
  readonly routePipe: () => void
  /** Open Place part on the catalog. */
  readonly placeFixture: () => void
  /** Open (or make) the live plumbing riser; returns why it can't, or null. */
  readonly openRiser?: () => string | null
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  /** What is selected, and selecting from a finding. */
  readonly selectedIds?: readonly string[]
  readonly select?: (ids: readonly string[]) => void
  /** Show proposed parts as ghosts in the plan (null clears). */
  readonly previewParts?: (ghosts: readonly ProposalGhost[] | null) => void
  /** What the model server advertises; absent while the surface doesn't pass it (Approve then follows the edit rules only). */
  readonly serverFeatures?: readonly string[]
}

export interface PlumbingWorkflow {
  readonly ribbon: PlumbingRibbon
  /** The dialogs, mounted over the canvas. */
  readonly overlay: ReactNode
}

type DialogState = { readonly kind: 'systems'; readonly tab: PlumbingSystemsTab } | { readonly kind: 'pipe_types' } | { readonly kind: 'hunter_curve' } | { readonly kind: 'stacks' } | { readonly kind: 'outfall'; readonly drainId: string } | { readonly kind: 'cleanouts'; readonly drainIds: readonly string[] } | { readonly kind: 'connect'; readonly target: FixtureConnectTarget; readonly ids: readonly string[] } | null

const LOADING = 'The model is still loading.'

/** The tab: Route pipe, systems and their look, the drain to the manhole, cleanouts proposed on a drain, auto-sizing, the demand curve and its chart, pipe types. Every edit is a kernel command (undoable, the same the agent tools send). */
export function usePlumbingWorkflow({ model, editBlocked, modelToolsBlocked, submit, routePipe, placeFixture, openRiser, notify, selectedIds = [], select, previewParts, serverFeatures }: PlumbingWorkflowInput): PlumbingWorkflow {
  const [dialog, setDialog] = useState<DialogState>(null)
  const settings = model ? projectPlumbingSettings(model.elements) : null
  const systemsOwnMode = useMemo(() => (model ? pipeSystems(model).filter((s) => s.design?.pipe?.sizingMode).length : 0), [model])
  const sizingBlocked = model ? editBlocked : LOADING

  const saveSettings = (patch: Parameters<typeof projectSettingsCommand>[1], label: string): boolean => {
    if (!settings) return false
    const refusal = submit(projectSettingsCommand(settings, patch), label)
    if (refusal) notify(refusal, 'error')
    return refusal === null
  }

  const connectAction = (target: FixtureConnectTarget): PlumbingAction => ({
    run: () => setDialog({ kind: 'connect', target, ids: [...selectedIds] }),
    blocked: model ? (modelToolsBlocked ?? editBlocked ?? fixtureConnectBlocked(model.elements, selectedIds, target)) : LOADING,
  })

  const ribbon: PlumbingRibbon = {
    routePipe: { run: routePipe, blocked: modelToolsBlocked ?? editBlocked },
    placeFixture: { run: placeFixture, blocked: modelToolsBlocked ?? editBlocked },
    systems: { run: () => setDialog({ kind: 'systems', tab: 'systems' }), blocked: model ? null : LOADING },
    sizing: {
      mode: settings?.sizingMode ?? 'check',
      systemsOwnMode,
      curve: settings?.demandCurve ?? null,
      buildingType: settings?.buildingType ?? null,
      blocked: sizingBlocked,
      toggle: () => {
        const on = settings?.sizingMode !== 'auto'
        if (saveSettings({ sizingMode: on ? 'auto' : 'check' }, on ? 'turn auto-sizing on' : 'turn auto-sizing off'))
          notify(on ? 'Auto-sizing is on: suggested pipe sizes apply as you model.' : 'Auto-sizing is off: pipes are checked and sizes suggested; nothing changes until you accept.')
      },
      setCurve: (curve: PlumbingDemandCurve | null) => saveSettings({ demandCurve: curve }, 'set the demand curve'),
      chart: { run: () => setDialog({ kind: 'hunter_curve' }), blocked: model ? null : LOADING },
    },
    pipeTypes: { run: () => setDialog({ kind: 'pipe_types' }), blocked: model ? null : LOADING },
    stacks: { run: () => setDialog({ kind: 'stacks' }), blocked: model ? null : LOADING },
    ...(select
      ? {
          outfallConnection: {
            run: () => {
              const drainId = selectedIds[0]
              if (drainId) setDialog({ kind: 'outfall', drainId })
            },
            blocked: model ? (modelToolsBlocked ?? editBlocked ?? outfallConnectionBlocked(model, selectedIds)) : LOADING,
          },
        }
      : {}),
    ...(select && previewParts
      ? {
          proposeCleanouts: {
            run: () => setDialog({ kind: 'cleanouts', drainIds: [...selectedIds] }),
            blocked: model ? (modelToolsBlocked ?? cleanoutProposalBlocked(model, selectedIds)) : LOADING,
          },
        }
      : {}),
    ...(select
      ? {
          connectFixtures: { drain: connectAction('drain'), vent: connectAction('vent'), cold_water: connectAction('cold_water'), hot_water: connectAction('hot_water') },
        }
      : {}),
    ...(openRiser
      ? {
          riser: {
            run: () => {
              const refusal = openRiser()
              if (refusal) notify(refusal, 'error')
            },
            blocked: model ? null : LOADING,
          },
        }
      : {}),
  }

  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const overlay = model ? (
    <>
      {dialog?.kind === 'systems' && <PlumbingSystemsDialog open onOpenChange={close} tab={dialog.tab} model={model} editBlocked={editBlocked} submit={submit} />}
      {dialog?.kind === 'pipe_types' && <PipeTypesDialog open onOpenChange={close} model={model} editBlocked={editBlocked} submit={submit} />}
      {dialog?.kind === 'hunter_curve' && <HunterCurveDialog open onOpenChange={close} model={model} />}
      {dialog?.kind === 'stacks' && <StacksDialog open onOpenChange={close} model={model} editBlocked={editBlocked} submit={submit} />}
      {dialog?.kind === 'outfall' && select && <OutfallConnectionDialog open onOpenChange={close} model={model} drainId={dialog.drainId} editBlocked={editBlocked} submit={submit} select={select} />}
      {dialog?.kind === 'cleanouts' && select && previewParts && (
        <ProposeCleanoutsPanel
          model={model}
          drainIds={dialog.drainIds}
          editBlocked={editBlocked}
          insertBlocked={serverFeatures && !serverFeatures.includes(ROUTING_INSERT_PART_FEATURE) ? CLEANOUT_PROPOSAL_WORDS.peerMissing : null}
          submit={submit}
          select={select}
          previewParts={previewParts}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'connect' && select && (
        <ConnectFixturesPanel
          model={model}
          selectedIds={dialog.ids}
          target={dialog.target}
          editBlocked={editBlocked}
          serverFeatures={serverFeatures}
          connectBlocked={serverFeatures && !serverFeatures.includes(ROUTING_CONNECT_INTO_FEATURE) ? FIXTURE_CONNECT_WORDS.peerMissing : null}
          submit={submit}
          select={select}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  ) : null

  return { ribbon, overlay }
}
