'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ScheduleTab } from '../schedule-tab/ScheduleTab'
import { dockTitle } from '../schedule-tab/dock'
import { useDockedSchedule } from '../schedule-tab/use-docked-schedule'
import { Lightbulb, Plug, X } from 'lucide-react'
import { type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import { ADDON_UI, circuitTemplates, distributionEquipment, electricalConnections, polesForMembers, uncircuitedLoads, planCircuitDrop, planCircuitMove, planRemoveFromCircuits, type CircuitPlanResult } from '@permitzip/bim-pack-electrical'
import type { NecEdition } from '@permitzip/bim-calc'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { newElementId } from '../placement'
import type { SubmitCommand } from '../views-sheets/types'
import { AddToCircuitDialog } from './AddToCircuitDialog'
import { ApplyTemplateDialog } from './ApplyTemplateDialog'
import { CheckPanel } from './CheckPanel'
import { ElectricalTypesDialog, type ElectricalTypesTab } from './ElectricalTypesDialog'
import { RebalanceDialog } from './RebalanceDialog'
import { EditCircuitDialog } from './EditCircuitDialog'
import { ELECTRICAL_PLACE_TYPES, type ElectricalPlaceKind, type ElectricalRibbon } from './electrical-tab'
import { ElectricalProperties } from './ElectricalProperties'
import { FeedPanelDialog } from './FeedPanelDialog'
import { PanelView } from './PanelView'
import { ContinueCircuitPanel } from './ContinueCircuitPanel'
import { ProposePanel } from './ProposePanel'
import { ServiceSizeDialog } from './ServiceSizeDialog'
import { ServiceLayoutDialog, type ServiceLayoutDraft, type ServiceLayoutSeed } from './ServiceLayoutDialog'
import { PlanPointPick } from './PlanPointPick'
import type { ClickHandler, ProposalGhost } from '../model-session'
import { electricalTarget, ribbonElectricalSelection } from './selection'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useNecRulesFrom, type NecRules } from './use-nec-rules'
import { useCapacityTargets } from './use-capacity-targets'
import { useScheduleWorkflow } from './schedules/use-schedule-workflow'
import type { NewScheduleFormSlot } from '../schedules/new-schedule-plan'

export interface ElectricalWorkflowInput {
  /** The host project, for its Code Study's NEC edition. */
  readonly projectId: string
  readonly model: ModelState | null
  readonly selectedIds: readonly string[]
  /** Null when editing is allowed; otherwise why not, in the operator's words. */
  readonly editBlocked: string | null
  /** Why model tools can't run where the person is (a sheet or a detail view is open); null in a plan or the 3D model. */
  readonly modelToolsBlocked: string | null
  readonly submit: SubmitCommand
  /** Arm Place part with this starter type; returns why it can't, or null. */
  readonly place: (typeId: string) => string | null
  /** The ribbon tab showing, for the first-run hint. */
  readonly activeTab: string
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  /** The open sheet, where a new schedule goes by default; null when none is open. */
  readonly openSheetId?: string | null
  /** Open a sheet (a new schedule's sheet opens so the person sees it). */
  readonly onOpenSheet?: (sheetId: string) => void
  /** Open the one New schedule window on a pick (`form:<kind>`); the surface owns it. */
  readonly openNewSchedule?: (pick: string) => void
  /** Open (or make) a live diagram view; returns why it can't, or null. */
  readonly openDiagram?: (kind: 'one_line' | 'electrical_riser') => string | null
  /** Select these elements in the model (a finding's items). */
  readonly select: (ids: readonly string[]) => void
  /** The placed part under a screen point in the plan or 3D view, for dragging devices onto panels. */
  readonly pickPartAt: (clientX: number, clientY: number) => string | null
  /** The plan point (mm, on the open level) under a screen point, for Service layout's Pick in plan; null off the plan. */
  readonly pickPlanPointAt?: (clientX: number, clientY: number) => Vec2 | null
  /** Show a proposal's devices as ghosts in the plan (null clears). */
  readonly previewParts?: (ghosts: readonly ProposalGhost[] | null) => void
  /** Hear what the pointer is over (the Propose tool previews the room under it). */
  readonly subscribeHover?: (listener: (ids: readonly string[] | null) => void) => () => void
  /** Take plan clicks before selection (a click on a previewed room places its devices); returns the unregister. */
  readonly setClickHandler?: (handler: ClickHandler) => () => void
  /** Frame these plan points (the rooms a proposal is for). */
  readonly framePlan?: (points: readonly Vec2[]) => void
  /** The level the open plan shows, where proposed devices go when their room names no level. */
  readonly levelId?: string | null
}

export interface ElectricalWorkflow {
  readonly ribbon: ElectricalRibbon
  /** The tab a fresh selection should open: Circuit for anything electrical, else null (the surface decides). */
  readonly autoTab: 'circuit' | null
  /** The Electrical section of the properties panel; null when nothing electrical is selected. */
  readonly properties: ReactNode
  /** Dialogs, the docked panel view and the first-run hint, mounted over the canvas. */
  readonly overlay: ReactNode
  /** The Schedule section of a view's properties (panel, code rules, template); null for anything but a form schedule. */
  readonly scheduleProperties: (view: ViewElement) => ReactNode
  /** What this add-on lends the one New schedule window for its form kinds. */
  readonly newScheduleForms: NewScheduleFormSlot
  /** The NEC edition the totals use (Code Study or the person's pick); null: connected loads only. */
  readonly necEdition: NecEdition | null
  /** The project's code rules (engine + edition), for dialogs mounted elsewhere that size circuits (Not placed yet › Circuit). */
  readonly nec: Pick<NecRules, 'engine' | 'necEdition'>
}

type DialogState =
  | { readonly kind: 'add'; readonly memberIds: readonly string[]; readonly linkId: string }
  | { readonly kind: 'edit'; readonly linkId: string }
  | { readonly kind: 'feed'; readonly panelId: string; readonly linkId: string }
  | { readonly kind: 'rebalance'; readonly panelId: string | null }
  | { readonly kind: 'types'; readonly tab: ElectricalTypesTab }
  | { readonly kind: 'template'; readonly name: string | null }
  | { readonly kind: 'service' }
  | { readonly kind: 'layout'; readonly seed: ServiceLayoutSeed | null; readonly draft?: ServiceLayoutDraft }
  | { readonly kind: 'layout_pick'; readonly seed: ServiceLayoutSeed | null; readonly draft: ServiceLayoutDraft }
  | null

/** What docks at the bottom of the canvas: the panel view or the check list. */
type Dock = { readonly kind: 'check' } | { readonly kind: 'propose' } | { readonly kind: 'continue' } | null

/** This add-on's docked schedule (its declaration in `ADDON_UI.docks`). */
const DOCK = ADDON_UI.docks[0]

/** A docked record's name for the tab's title ("L1"), else its id. */
function dockedName(model: ModelState, id: string): string {
  return distributionEquipment(model.elements).find((p) => p.id === id)?.name ?? id
}

const SELECT_LOADS = 'Select the receptacles, lights or equipment to circuit first: click one, or box select several (B).'
const PLACE_PANEL_FIRST = 'Place a panel first: Electrical › Panel, then name it in its properties.'

/**
 * Everything the Electrical tab, the Circuit tab, the properties panel and
 * the panel view do, in one place, so the Building Model surface mounts it
 * once. Every edit goes through `submit` as the same commands the agent tools
 * send (bim_create_circuit and friends).
 */
export function useElectricalWorkflow(input: ElectricalWorkflowInput): ElectricalWorkflow {
  const { projectId, model, selectedIds, editBlocked, modelToolsBlocked, submit, place, activeTab, notify, openDiagram, select } = input
  const nec = useNecRulesFrom(useEditorHost().data.codeAdoption, projectId)
  const capacityTargets = useCapacityTargets(projectId)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [dock, setDock] = useState<Dock>(null)
  // The docked schedule: which record is open lives in the page address, so Back and reload restore it.
  const docked = useDockedSchedule(DOCK)
  const panelViewId = docked.openId
  const setPanelViewId = (id: string | null) => (id ? docked.open(id) : docked.close())
  const [scheduleAttempt, setScheduleAttempt] = useState(0)
  const [lastPanelId, setLastPanelId] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)
  const inputPreview = input.previewParts
  const previewParts = useCallback((ghosts: readonly ProposalGhost[] | null) => inputPreview?.(ghosts), [inputPreview])
  const closeDock = useCallback(() => setDock(null), [])
  const target = useMemo(() => electricalTarget(model, selectedIds), [model, selectedIds])
  const panels = useMemo(() => (model ? distributionEquipment(model.elements) : []), [model])
  const els = model?.elements ?? {}

  const circuitedLoads = target.loads.filter((id) => electricalConnections(els, id).some((c) => c.circuit))
  const singleCircuit = target.loads.length === 1 ? (electricalConnections(els, target.loads[0] ?? '')[0]?.circuit ?? null) : null
  const unreadyWhy = target.unready.length === 0 ? null : `${target.unready[0]?.reason ?? ''}${target.unready.length > 1 ? ` (${target.unready.length - 1} more selected need the same)` : ''}`
  const addBlocked =
    editBlocked ??
    (target.loads.length === 0
      ? target.panels.length > 0
        ? 'Panels and transformers are fed, not put on a circuit: use Feed panel.'
        : (unreadyWhy ?? SELECT_LOADS)
      : polesForMembers(els, target.loads.map((elementId) => ({ elementId }))) === null
        ? 'These need different breakers (1-, 2- and 3-pole loads, or one has no voltage set); select loads that can share one circuit.'
        : null)
  const editCircuitBlocked = editBlocked ?? (singleCircuit ? null : 'Select one device that is on a circuit, or click a circuit in Panel view.')
  const removeBlocked = editBlocked ?? (circuitedLoads.length === 0 ? 'Nothing selected is on a circuit.' : null)
  const feedBlocked = editBlocked ?? (target.panels.length === 1 && target.loads.length === 0 ? null : (unreadyWhy ?? 'Select one panel or transformer to feed.'))
  const panelViewBlocked = panels.length === 0 ? PLACE_PANEL_FIRST : null

  const panelFor = (): string | null => {
    if (target.panels.length === 1) return target.panels[0] ?? null
    if (singleCircuit) return singleCircuit.sourceId
    if (lastPanelId && panels.some((p) => p.id === lastPanelId)) return lastPanelId
    return panels[0]?.id ?? null
  }

  const openAdd = () => {
    if (addBlocked) return notify(addBlocked)
    setDialog({ kind: 'add', memberIds: target.loads, linkId: newElementId('ckt') })
  }
  const openFeed = (panelId?: string) => {
    const id = panelId ?? (target.panels.length === 1 ? target.panels[0] : undefined)
    if (!id) return notify('Select one panel or transformer to feed.')
    if (editBlocked) return notify(editBlocked)
    setDialog({ kind: 'feed', panelId: id, linkId: newElementId('fdr') })
  }
  const openPanelView = (panelId?: string) => {
    const id = panelId ?? panelFor()
    if (!id) return notify(PLACE_PANEL_FIRST)
    setPanelViewId(id)
    setLastPanelId(id)
  }

  const sendPlan = (plan: CircuitPlanResult): boolean => {
    if (!plan.ok) {
      notify(plan.reason, 'error')
      return false
    }
    for (let i = 0; i < plan.commands.length; i++) {
      const command = plan.commands[i]
      if (!command) continue
      const refusal = submit(command, i === plan.commands.length - 1 ? plan.label : 'take devices off their old circuit')
      if (refusal) {
        notify(refusal, 'error')
        return false
      }
    }
    return true
  }
  const hasCircuits = panels.some((p) => p.kind === 'panelboard' || p.kind === 'switchboard')
  const templateCount = model ? circuitTemplates(model).length : 0

  const schedulePanelId = target.panels.length === 1 ? (target.panels[0] ?? null) : singleCircuit ? singleCircuit.sourceId : (panelViewId ?? lastPanelId)
  const schedules = useScheduleWorkflow({
    model,
    nec,
    editBlocked,
    submit,
    panelId: schedulePanelId && panels.some((p) => p.id === schedulePanelId) ? schedulePanelId : null,
    panelCount: panels.length,
    openNewSchedule: input.openNewSchedule ?? (() => notify('New schedule… is in Views and sheets.')),
  })

  const ribbon: ElectricalRibbon = {
    place: (kind: ElectricalPlaceKind) => {
      const refusal = place(ELECTRICAL_PLACE_TYPES[kind])
      if (refusal) notify(refusal, 'error')
    },
    placeBlocked: modelToolsBlocked ?? editBlocked,
    addToCircuit: openAdd,
    addBlocked,
    editCircuit: () => (singleCircuit ? setDialog({ kind: 'edit', linkId: singleCircuit.linkId }) : notify(editCircuitBlocked ?? '')),
    editBlocked: editCircuitBlocked,
    removeFromCircuit: () => {
      if (!model) return
      const plan = planRemoveFromCircuits(model, target.loads)
      if (!plan.ok) return notify(plan.reason)
      for (const command of plan.commands) {
        const refusal = submit(command, plan.label)
        if (refusal) return notify(refusal, 'error')
      }
    },
    removeBlocked,
    feedPanel: () => openFeed(),
    feedBlocked,
    openPanelView: () => openPanelView(),
    panelViewBlocked,
    schedules: schedules.action,
    ...(openDiagram
      ? {
          diagram: {
            open: (kind: 'one_line' | 'electrical_riser') => {
              const refusal = openDiagram(kind)
              if (refusal) notify(refusal, 'error')
            },
            blocked: model ? null : "The model isn't open yet.",
          },
        }
      : {}),
    selection: ribbonElectricalSelection(model, target),
    check: { run: () => setDock({ kind: 'check' }), blocked: model ? null : 'The model is still loading.' },
    propose: { run: () => setDock({ kind: 'propose' }), blocked: editBlocked ?? (model ? null : 'The model is still loading.') },
    continueCircuit: { run: () => setDock({ kind: 'continue' }), blocked: modelToolsBlocked ?? editBlocked ?? (model ? (panels.length === 0 ? PLACE_PANEL_FIRST : null) : 'The model is still loading.') },
    serviceSize: { run: () => setDialog({ kind: 'service' }), blocked: null },
    serviceLayout: { run: () => setDialog({ kind: 'layout', seed: null }), blocked: editBlocked ?? (model ? null : 'The model is still loading.') },
    balance: { run: () => setDialog({ kind: 'rebalance', panelId: panelFor() }), blocked: editBlocked ?? (hasCircuits ? null : PLACE_PANEL_FIRST) },
    types: { run: () => setDialog({ kind: 'types', tab: 'connection' }), blocked: model ? null : 'The model is still loading.' },
    templates: { run: () => setDialog(templateCount > 0 ? { kind: 'template', name: null } : { kind: 'types', tab: 'template' }), blocked: editBlocked ?? (hasCircuits ? null : PLACE_PANEL_FIRST) },
    docked: { addon: ADDON_UI.addon, dock: DOCK, list: panels.map((p) => ({ id: p.id, name: p.name })), open: (id) => openPanelView(id) },
  }

  const properties =
    model && (target.loads.length > 0 || target.panels.length > 0) ? (
      <ElectricalProperties model={model} target={target} addBlocked={addBlocked} onAdd={openAdd} onEdit={(linkId) => setDialog({ kind: 'edit', linkId })} onPanelView={openPanelView} onFeed={() => openFeed()} submit={submit} editBlocked={editBlocked} onManageTypes={() => setDialog({ kind: 'types', tab: 'connection' })} />
    ) : model && unreadyWhy ? (
      <Alert data-testid="electrical-not-ready">
        <Plug />
        <AlertTitle>Not ready to circuit</AlertTitle>
        <AlertDescription>{unreadyWhy}</AlertDescription>
      </Alert>
    ) : null

  // A docked schedule named in the address before the model has opened: the tab shows that it is loading.
  const loadingSchedule = !model && panelViewId ? (
    <ScheduleTab title={dockTitle(DOCK, null)} besideProperties={false} loading readOnly={null} onClose={() => setPanelViewId(null)} onRetry={() => setScheduleAttempt((n) => n + 1)}>
      {null}
    </ScheduleTab>
  ) : null

  const showHint = activeTab === 'electrical' && panels.length === 0 && !hintDismissed && model !== null
  const overlay = model ? (
    <>
      {showHint && (
        <Alert className="absolute bottom-3 left-3 z-20 w-96 shadow-sm" data-testid="electrical-first-run">
          <Lightbulb />
          <AlertTitle>Circuiting in three steps</AlertTitle>
          <AlertDescription>
            <ol className="list-decimal pl-4">
              <li>Panel ▾ places a panelboard; name it (L1) in its properties.</li>
              <li>Device ▾ places receptacles, lights and equipment.</li>
              <li>Select devices (click one, or box select with B) and press Add to circuit.</li>
            </ol>
          </AlertDescription>
          <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label="Hide these steps" onClick={() => setHintDismissed(true)}>
            <X />
          </Button>
        </Alert>
      )}
      {panelViewId && (
        <ScheduleTab
          title={dockTitle(DOCK, dockedName(model, panelViewId))}
          besideProperties={selectedIds.length > 0}
          loading={false}
          readOnly={editBlocked === null ? null : `${DOCK.readOnly} ${editBlocked}`}
          onClose={() => setPanelViewId(null)}
          onRetry={() => setScheduleAttempt((n) => n + 1)}
          unavailable={panels.some((p) => p.id === panelViewId) ? null : DOCK.missing}
        >
          <PanelView
            key={scheduleAttempt}
            model={model}
            panelId={panelViewId}
            canEdit={editBlocked === null}
            editBlocked={editBlocked}
            submit={submit}
            onPanel={(id) => openPanelView(id)}
            onClose={() => setPanelViewId(null)}
            onEditCircuit={(linkId) => setDialog({ kind: 'edit', linkId })}
            onFeed={(id) => openFeed(id)}
            report={nec.engine.report(model, panelViewId)}
            nec={nec}
            onRebalance={(id) => setDialog({ kind: 'rebalance', panelId: id })}
            capacityTargets={capacityTargets}
            drop={
              editBlocked === null
                ? {
                    onLoads: (ids, at) => {
                      sendPlan(planCircuitDrop(model, ids, { panelId: panelViewId, ...at }, newElementId('ckt')))
                    },
                    onCircuit: (linkId, slot) => {
                      sendPlan(planCircuitMove(model, linkId, slot))
                    },
                  }
                : undefined
            }
            dragLoads={[
              ...(target.loads.length > 0 ? [{ ids: target.loads, label: `${target.loads.length} selected` }] : []),
              ...uncircuitedLoads(model)
                .filter((l) => !target.loads.includes(l.id))
                .slice(0, 12)
                .map((l) => ({ ids: [l.id], label: l.name })),
            ]}
          />
        </ScheduleTab>
      )}
      {dock?.kind === 'check' && (
        <div className="absolute bottom-3 left-3 z-20 flex max-h-[50%] w-[min(48rem,calc(100%-22rem))] flex-col rounded-lg border bg-background/95 shadow-md">
          <CheckPanel model={model} engine={nec.engine} rulesLabel={nec.label} onSelect={select} onOpenPanel={(id) => openPanelView(id)} onClose={() => setDock(null)} />
        </div>
      )}
      {dock?.kind === 'continue' && (
        <ContinueCircuitPanel
          model={model}
          editBlocked={editBlocked}
          submit={submit}
          place={(kind) => place(ELECTRICAL_PLACE_TYPES[kind])}
          onClose={closeDock}
          notify={notify}
        />
      )}
      {dock?.kind === 'propose' && (
        <div className="absolute bottom-3 left-3 z-20 flex max-h-[46%] w-[min(52rem,calc(100%-22rem))] flex-col rounded-lg border bg-background/95 shadow-md">
          <ProposePanel
            model={model}
            nec={nec}
            levelId={input.levelId ?? null}
            editBlocked={editBlocked}
            submit={submit}
            onPreview={previewParts}
            {...(input.subscribeHover ? { subscribeHover: input.subscribeHover } : {})}
            {...(input.setClickHandler ? { setClickHandler: input.setClickHandler } : {})}
            {...(input.framePlan ? { onFrame: input.framePlan } : {})}
            onClose={closeDock}
            onDone={(placed) => {
              setDock(null)
              notify(`Placed ${placed} receptacle${placed === 1 ? '' : 's'}. Select them and press Add to circuit to circuit them.`)
            }}
          />
        </div>
      )}
      {dialog?.kind === 'rebalance' && (
        <RebalanceDialog
          model={model}
          initialPanelId={dialog.panelId}
          submit={submit}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null)
            openPanelView(id)
          }}
        />
      )}
      {dialog?.kind === 'types' && (
        <ElectricalTypesDialog
          model={model}
          engine={nec.engine}
          edition={nec.necEdition}
          canEdit={editBlocked === null}
          editBlocked={editBlocked}
          submit={submit}
          initialTab={dialog.tab}
          selectedDevices={target.loads}
          onApplyTemplate={(name) => setDialog({ kind: 'template', name })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'template' && (
        <ApplyTemplateDialog
          model={model}
          initialTemplate={dialog.name}
          selectedIds={selectedIds}
          submit={submit}
          onClose={() => setDialog(null)}
          onEditTemplates={() => setDialog({ kind: 'types', tab: 'template' })}
          onDone={(id) => {
            setDialog(null)
            if (id) openPanelView(id)
          }}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddToCircuitDialog
          model={model}
          memberIds={dialog.memberIds}
          initialPanelId={singleCircuit?.sourceId ?? lastPanelId}
          newLinkId={dialog.linkId}
          submit={submit}
          onClose={() => setDialog(null)}
          onDone={(panelId) => {
            setDialog(null)
            openPanelView(panelId)
          }}
          onPlacePanel={() => {
            setDialog(null)
            ribbon.place('panel_208')
          }}
        />
      )}
      {dialog?.kind === 'feed' && (
        <FeedPanelDialog
          model={model}
          fedId={dialog.panelId}
          newLinkId={dialog.linkId}
          submit={submit}
          onClose={() => setDialog(null)}
          onDone={(sourceId) => {
            setDialog(null)
            openPanelView(sourceId)
          }}
        />
      )}
      {dialog?.kind === 'service' && <ServiceSizeDialog nec={nec} model={model} capacityTargets={capacityTargets} canEdit={editBlocked === null} onClose={() => setDialog(null)} {...(editBlocked === null ? { onStartLayout: (seed: ServiceLayoutSeed) => setDialog({ kind: 'layout', seed }) } : {})} />}
      {dialog?.kind === 'layout' && (
        <ServiceLayoutDialog
          model={model}
          levelId={input.levelId ?? null}
          seed={dialog.seed}
          draft={dialog.draft ?? null}
          submit={submit}
          onClose={() => setDialog(null)}
          {...(input.pickPlanPointAt && modelToolsBlocked === null ? { onPickPoint: (draft: ServiceLayoutDraft) => setDialog({ kind: 'layout_pick', seed: dialog.seed, draft }) } : {})}
          onDone={() => {
            setDialog(null)
            const refusal = openDiagram?.('one_line') ?? null
            notify(refusal ? `Service equipment placed. ${refusal}` : 'Service equipment placed; the one-line shows it. Undo takes it all out.')
          }}
        />
      )}
      {dialog?.kind === 'layout_pick' && input.pickPlanPointAt && (
        <PlanPointPick
          prompt="Click where the service lineup starts (its left end)."
          pickPlanPointAt={input.pickPlanPointAt}
          onPicked={(point) => setDialog({ kind: 'layout', seed: dialog.seed, draft: { ...dialog.draft, where: 'point', point } })}
          onCancel={() => setDialog({ kind: 'layout', seed: dialog.seed, draft: dialog.draft })}
        />
      )}
      {dialog?.kind === 'edit' && <EditCircuitDialog model={model} linkId={dialog.linkId} submit={submit} onClose={() => setDialog(null)} sizing={{ edition: nec.necEdition, engine: nec.engine }} />}
      {schedules.overlay}
    </>
  ) : null

  return { ribbon, autoTab: target.loads.length > 0 || target.panels.length > 0 ? 'circuit' : null, properties, overlay: overlay ?? loadingSchedule, scheduleProperties: schedules.propertiesFor, newScheduleForms: schedules.formSlot, necEdition: nec.necEdition, nec }
}
