'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactElement } from 'react'
import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useEditorNavigation } from '@permitzip/bim-editor/host'
import { toast } from 'sonner'
import { RefreshCw, Wind, X, ArrowLeft } from 'lucide-react'
import { AUTO_TAG_CATEGORIES, ORGANIZATION_ZONE, elementsOfKind, planAutoTags, runLabel, type RunFitting, type RunSegment, SYSTEM_KINDS, displayContextOf, documentIndex, viewCamera3d, type Aabb3, normalizeLevelName, organizationOf, sheetDependsOn, sheetViewports, type Actor, type DisplayContext, type GroupVisibility, type ModelState, type PartInstance, type PartTypeDefinition, type SectionCut, type Sheet, type Vec2, type ViewElement, originPointPosition, viewFloorMm, viewModelLevel, canonicalViewLevel, modelLevels, viewRotationDeg, type OriginPoint, diagramKindLabel, type StoredDiagramKind, type ScheduleCategory, type ElementId, type WorkFrame, asElementId, type AuthorRef, type BranchRef, parseBranchModelId, type SubmittalCommand, matchingPlanCrop, projectParametersOf } from '@permitzip/bim-kernel'
import type { ConnectionStatus, Presence, SaveState } from '@permitzip/bim-sync'
import { type ConnectionProblem } from './operator-messages'
import { SHEET_FIRM_NAME, type SheetTitle } from '../contracts/building-model/sheet-title'
import { panButtonOf } from '@permitzip/bim-viewer-3d/pan-buttons'
import type { LoadedReference, ModelViewer3D, Pick as ViewerPick } from '@permitzip/bim-viewer-3d'
import { elevationCut, kernelToScene, livePlanCutMm, liveView, type Projection } from '@permitzip/bim-viewer-3d/light'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { undrawnLoadHint } from './schedules/loads-list'
import { BUILTIN_LIST_DESCRIPTIONS, BUILTIN_LIST_LABELS, LOAD_SCHEDULE_IDS, builtinListBlocked, builtinListCommand, findBuiltinListView, type BuiltinListId } from './schedules/builtin-lists'
import type { EquipmentListDialog as EquipmentListDialogComponent, EquipmentListTrade } from './equipment-list/EquipmentListDialog'
import type { NewScheduleFormSlot } from './schedules/new-schedule-plan'
import { useEquipmentLibraryFrom } from '@permitzip/bim-editor/editor/equipment-list/library-fields'
import { disciplinesForTab } from './planned/place-surface'
import { armPlanned, clickPlaces, clickPlanned, drawingPlacingNow, placeSurfaceNow, plannedPlacingFor, toolNeedsLiveModel, type ClickClaimer, type PlannedPlacing } from './place-planned-live'
import { useBlockFreshnessFrom } from './blocks/use-block-freshness'
import { placeLoadSummary } from './blocks/insert'
import { useSpacesTool } from './spaces/use-spaces-tool'
import { useRoomChords } from './spaces/use-room-chords'
import { useCeilingTool } from './ceilings/use-ceiling-tool'
import { LoadsLayer } from './electrical/allocated-actual-engine'
import { ShowInScheduleButton } from './schedules/ShowInScheduleButton'
import { loadsBreakdown } from './loads/loads-breakdown'
import { announceModelSchedules } from './schedules/use-model-schedule-tree'
import { ModelSession, isNudgeKey, type CatalogEntry, type PlusHandle, type ProposalGhost, type DeletePlan, type ReferenceInfo, type RouteCheck, type Selection, type SlideDrag, type UndoState, type UnplacedState } from './model-session'
import { LayoutPrefsProviderFrom } from '@permitzip/bim-editor/editor/layout/LayoutPrefsProvider'
import { SurfaceRail, type SurfaceRailProps } from './SurfaceRail'
import { ModelStore, selectElement, shallowArrayEqual, type ModelSelector } from './model-store'
import { createModelForIdsSelector, createSurfaceChromeSelector } from './surface-selectors-chrome'
import { createCatalogSelector, createSystemsSelector, sameCounts, selectAddons, selectModelLevelNames, selectPlannedCounts, selectSite } from './state/surface-selectors'
import { useModelSelector } from './use-model-selector'
import { ModelFromStore } from './state/model-from-store'
import { useDocumentIndex, useDocumentsModel } from './state/use-canvas-model'
import { useStableHandlers } from './stable-props'
import type { QuestionCommand } from '../contracts/bim/questions/kernel'
import { selectionLabel as questionSelectionLabel } from './questions/question-rows'
import { ask as askBranch } from './branches/useBranches'
import { useFirmPartLibrary } from './part-editor/use-firm-part-library'
import { BranchHeader, CANT_START_BRANCHES } from './branches/BranchHeader'
import { useFollowThreadBranchFrom } from '@permitzip/bim-editor/editor/branches/useFollowThreadBranch'
import { useVersions } from './versions/useVersions'
import { branchIdFromHref, withBranch } from '../contracts/building-model/branch-href'
import type { MergeApplyResult } from './merge/ProposeMergeDialog'
import type { LineageRequest, MergePreview } from '@permitzip/bim-sync'

const PartEditorWindow = dynamic(() => import('./part-editor/PartEditorWindow'), { ssr: false })
const ModelSchedulePane = dynamic(() => import('./schedules/ModelSchedulePane').then((m) => m.ModelSchedulePane), { ssr: false })
const ChecklistPane = dynamic(() => import('./checklist/ChecklistPane').then((m) => m.ChecklistPane), { ssr: false })
const DivergenceBadge = dynamic(() => import('./submittals/DivergenceBadge').then((m) => m.DivergenceBadge), { ssr: false })
// Sheets and detail views only: the model view never needs the drawing canvas on first load.
const DrawingCanvas = dynamic(() => import('./views-sheets/DrawingCanvas').then((m) => m.DrawingCanvas), { ssr: false })
const ResponsibilitiesDialog = dynamic(() => import('./responsibilities/ResponsibilitiesDialog').then((m) => m.ResponsibilitiesDialog), { ssr: false })
const ChangeOrdersDialog = dynamic(() => import('./change-orders/ChangeOrdersDialog').then((m) => m.ChangeOrdersDialog), { ssr: false })
const ProposeMergeDialog = dynamic(() => import('./merge/ProposeMergeDialog').then((m) => m.ProposeMergeDialog), { ssr: false })
const CopiesDialog = dynamic(() => import('./copies/CopiesDialog').then((m) => m.CopiesDialog), { ssr: false })
const ConstructionStagesDialog = dynamic(() => import('./construction/ConstructionStagesDialog').then((m) => m.ConstructionStagesDialog), { ssr: false })
// Round 10 S10 (`ui.first_chunk.kb`): opened on demand, so off the page's first download.
const EquipmentListDialog = dynamic(() => import('./equipment-list/EquipmentListDialog').then((m) => m.EquipmentListDialog), { ssr: false })
const AddonsPreview = dynamic(() => import('./settings/AddonsPreview').then((m) => m.AddonsPreview), { ssr: false })
const TagStylesDialog = dynamic(() => import('./organization/TagStylesDialog').then((m) => m.TagStylesDialog), { ssr: false })
const ManageGroupsDialog = dynamic(() => import('./organization/ManageGroupsDialog').then((m) => m.ManageGroupsDialog), { ssr: false })
const NewListScheduleDialog = dynamic(() => import('./schedules/NewListScheduleDialog').then((m) => m.NewScheduleWindow), { ssr: false })
const SheetFigureDialog = dynamic(() => import('./views-sheets/SheetFigureDialog').then((m) => m.SheetFigureDialog), { ssr: false })
const InsertCalculationDialog = dynamic(() => import('./calc-sheets/InsertCalculationDialog').then((m) => m.InsertCalculationDialog), { ssr: false })
// The one-time trackpad tip reads the person's saved preferences (the database client): on demand, never on the first download.
const TrackpadHint = dynamic(() => import('./input/TrackpadHint').then((m) => m.TrackpadHint), { ssr: false })
const PhaseFiltersDialog = dynamic(() => import('./organization/PhaseFiltersDialog').then((m) => m.PhaseFiltersDialog), { ssr: false })
const ManagePhasesDialog = dynamic(() => import('./organization/ManagePhasesDialog').then((m) => m.ManagePhasesDialog), { ssr: false })
const CoordinatesDialog = dynamic(() => import('./orientation/CoordinatesDialog').then((m) => m.CoordinatesDialog), { ssr: false })
const NewViewDialog = dynamic(() => import('./views-sheets/ViewsSheetsDialogs').then((m) => m.NewViewDialog), { ssr: false })
const SheetDialog = dynamic(() => import('./views-sheets/ViewsSheetsDialogs').then((m) => m.SheetDialog), { ssr: false })
const ProjectInfoDialog = dynamic(() => import('./views-sheets/ProjectInfoDialog').then((m) => m.ProjectInfoDialog), { ssr: false })
const RenameViewDialog = dynamic(() => import('./views-sheets/ViewsSheetsDialogs').then((m) => m.RenameViewDialog), { ssr: false })
const DeleteDialog = dynamic(() => import('./views-sheets/ViewsSheetsDialogs').then((m) => m.DeleteDialog), { ssr: false })
const PrintDialog = dynamic(() => import('./views-sheets/ViewsSheetsDialogs').then((m) => m.PrintDialog), { ssr: false })
// Round 10 C10 / T10: Manage › Model settings › Codes and Manage › Connect an agent, opened on demand.
const CodesOfRecordDialog = dynamic(() => import('./code-change/CodesOfRecordDialog').then((m) => m.CodesOfRecordDialog), { ssr: false })
const SheetCodeChangeBanner = dynamic(() => import('./code-change/SheetCodeChangeBanner').then((m) => m.SheetCodeChangeBanner), { ssr: false })
const ConnectAgentDialog = dynamic(() => import('./connect-agent/ConnectAgentDialog').then((m) => m.ConnectAgentDialog), { ssr: false })
const ViewProperties = dynamic(() => import('./views-sheets/ViewPropertiesPanel').then((m) => m.ViewPropertiesPanel), { ssr: false, loading: () => <LoadingLine label="Loading view properties…" /> })
// Round 11 R11-pre: the diagram properties panel loads when a diagram is first open (`ui.first_chunk.kb`).
const DiagramProperties = dynamic(() => import('./diagrams/DiagramProperties').then((m) => m.DiagramProperties), { ssr: false, loading: () => <LoadingLine label="Loading diagram properties…" /> })
const SelectionPanel = dynamic(() => import('./SelectionPanel').then((m) => m.SelectionPanel), { ssr: false, loading: () => <LoadingLine label="Loading properties…" /> })
const GroupProperties = dynamic(() => import('./GroupProperties').then((m) => m.GroupProperties), { ssr: false, loading: () => <LoadingLine label="Loading selection properties…" /> })
const ElementOrganizationFields = dynamic(() => import('./organization/ElementOrganizationFields').then((m) => m.ElementOrganizationFields), { ssr: false, loading: () => <LoadingLine label="Loading groups and phases…" /> })
const LoadsBreakdownPopover = dynamic(() => import('./loads/LoadsBreakdownPopover').then((m) => m.LoadsBreakdownPopover), { ssr: false, loading: () => <LoadingLine label="Loading loads…" /> })
const OriginOverlay = dynamic(() => import('./orientation/OriginOverlay').then((m) => m.OriginOverlay), {
  ssr: false,
  loading: () => (
    <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border bg-background/95 px-3 py-1.5 shadow-sm">
      <LoadingLine label="Loading origin tools…" />
    </div>
  ),
})
const MountingPlaneDialog = dynamic(() => import('./MountingPlaneDialog').then((m) => m.MountingPlaneDialog), { ssr: false })
const SelectionContextMenu = dynamic(() => import('./views-sheets/SelectionContextMenu').then((m) => m.SelectionContextMenu), { ssr: false })
const StaleAnswerNoticesHost = dynamic(() => import('./state/surface-store-hosts').then((m) => m.StaleAnswerNoticesHost), { ssr: false })
const LevelTools = dynamic(() => import('./levels/LevelTools').then((m) => m.LevelTools), { ssr: false })
const DeleteConfirmDialog = dynamic(() => import('./DeleteConfirmDialog').then((m) => m.DeleteConfirmDialog), { ssr: false })
const CodeStudyModelLinkHost = dynamic(() => import('./code-study/CodeStudyModelLinkHost').then((m) => m.CodeStudyModelLinkHost), { ssr: false })
const SectionCutOverlay = dynamic(() => import('./views-sheets/SectionCutOverlay').then((m) => m.SectionCutOverlay), { ssr: false })
const SheetBlockFreshnessChip = dynamic(() => import('./blocks/SheetBlockFreshnessChip').then((m) => m.SheetBlockFreshnessChip), { ssr: false, loading: () => <LoadingLine label="Checking the sheet's blocks…" /> })
const VersionsDialog = dynamic(() => import('./versions/VersionsDialog').then((m) => m.VersionsDialog), { ssr: false })
const CropBox3dOverlay = dynamic(() => import('./views-sheets/CropBox3dOverlay').then((m) => m.CropBox3dOverlay), {
  ssr: false,
  loading: () => (
    <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border bg-background/95 px-3 py-1.5 shadow-sm">
      <LoadingLine label="Loading the crop box…" />
    </div>
  ),
})
import type { SaveLabel } from './PartProperties'
import { LoadingLine } from './LoadingLine'
import { DEFAULT_ROUTE, routeFittings, routeSize, systemKindsFor, type ExistingSystem, type RouteChoices } from './RoutePanel'
import { choicesWithDefaults } from './route-defaults'
import { useRouteDefaultsFrom } from './use-route-defaults'
import { routeInsulationChoice } from './route-design'
import { axisLockHint, type AxisLock } from './route-axis'
import { MM_PER_FT, describeElement, feetInches, newElementId } from './placement'
import { routeChoicesLike } from './route-like'
import { routeSlope, slopeChoiceOf } from './route-slope'
import type { ClickHandler, InheritPick } from './model-session'
import type { DrawingTool } from './views-sheets/DrawingCanvas'
import { useDraftController } from './views-sheets/draft/useDraftController'
import { printSheetPdf } from './views-sheets/print-sheet'
import { useViewBackgroundsFrom, useWarmViewBackgroundsFrom } from './views-sheets/view-backgrounds'
import { ConnectionStatusChip } from './connection-status/ConnectionStatusChip'
import { ViewerStatsFeed, ViewerStatsReadout } from './ViewerStatsReadout'
import { CropBoxOverlay } from './views-sheets/CropBoxOverlay'
import { useCrop3d } from './views-sheets/use-crop-3d'
import { linkDescription, linkSourcesOf, linkUnavailableReason } from './linked-api'
import { useLinkedDisplay } from './linked-display/use-linked-display'
import { useLinkedReferenceLoader } from './linked-reference/use-linked-reference'
import { clipOf, copiedHint, currentClip, pasteBlocked, pasteIds, pasteNear, rememberClip, subscribeClip, typingIn } from './views-sheets/draft/copy-paste'
import { isDetailShape, type DetailShape } from './ribbon/annotate-tab'
import type { PrintChoice } from './views-sheets/ViewsSheetsDialogs'
import { DrawingSetRequests } from './views-sheets/DrawingSetRequests'
import type { PanelRequest } from './views-sheets/ViewsSheetsPanel'
import { besidePropertiesRight, propertiesSurfaceClass } from './layout/properties-cover'
import type { ViewDisplay } from './views-sheets/ViewPropertiesPanel'
import { newViewDisplay, useViewDisplayPrefsFrom } from './views-sheets/use-view-display-prefs'
import { useViewCameraMemoryFrom } from './views-sheets/use-view-camera-memory'
import { cameraMemoryKey, framingSignature } from './views-sheets/view-camera-memory'
import { FREE_3D_KEY } from '../contracts/building-model/view-camera-prefs'
import { VIEW_TYPE_LABEL, newId, type CreatableViewType, type OpenItem, type SubmitCommand } from './views-sheets/types'
import { useSheetImagesFrom } from '@permitzip/bim-editor/editor/views-sheets/use-sheet-images'
import { addOns, loadAddOns } from '../contracts/building-model/add-ons'

import { MemoRibbon, useStableCommands, useStableRibbonTabs } from './ribbon/stable-ribbon'
import { useModelPacks } from './state/use-model-packs'
import { buildingModelQuickCommands, buildingModelRibbon, PROJECTION_SHORTCUT, type BoxCategory, type BuildingModelTool, type RibbonSelection } from './building-model-ribbon'
import { OrientationControls } from './orientation/OrientationControls'
import { OrbitPointMarker } from './orientation/OrbitPointMarker'
import { OrbitPointClicks } from './orbit-point'
import { PlusHandles, plusHandlesViewFor, type FaceHandle } from './PlusHandles'
import { useCopyChord } from './copy-chord'
import { PROPERTIES_DEFAULT_WIDTH_PX, PROPERTIES_SURFACE, ResizableSideRail } from './layout/ResizableSideRail'
import { isPlaneLockKey, isTurnKey } from './placement-keys'
import { LivePlanConnectGrip } from './connect-grip/LivePlanConnectGrip'
import { LivePlanRouteTicks, type LivePlanRouteTicksProps } from './LivePlanRouteTicks'
import { RunGrabHandle } from './RunGrabHandle'
import type { ModelEditBridge } from './view-input/bridge'
import { planPointsOffOnSheet, type PlanPointer } from './view-input/plan-pointer'
import { inPlaceWords, modelInPlaceCommand, type InPlaceSpot } from './part-editor/model-in-place'
import { emptyDragFor, GestureArbiter } from './input/gesture-arbiter'
import { orderedSteps } from './input/ordered-steps'
import { resultHold } from './input/result-hold'
import { autoRibbonTab, ribbonContextKey, useRibbonTabMemory } from './ribbon/use-ribbon-tab-memory'
import { tabForPoint, type CoordinatesTab } from './orientation/coordinates-tab'
import { useWorkingAngle } from './orientation/use-working-angle'
import { movableOriginPoint, type OriginMoveMode } from './coordinates'
import type { LevelRequest } from './levels/LevelTools'
import { ToolHintBar } from './ToolHintBar'
import { proposedSystemName } from './system-name'
import { runCreateSimilar, useCreateSimilar } from './create-similar'
import { ToolReadinessNotice } from './ToolReadinessNotice'
import { ZoomThroughNotice } from './ZoomThroughNotice'
import { toolBlocker } from './tool-readiness'
import { escapeLeavesField, leftFieldHint } from './escape-step'
import { drawingToolStopsModelTool, stoppedByModelTool } from './tool-switch'
import { TopDownPlanMemory, openWholeModel } from './open-whole-model'
import { groupSelectionKeys } from './selection-keys'
import { deleteKeyTarget } from './delete-key'
import { heightAfterChoosingPart, type TypedPlaceHeight } from './place-height'
import { useContributionsVersion } from './contributions/AddonComponent'
import { sharedValue, useAddonWorkflows } from './contributions/host-slots'
import type { WorkflowServices } from './contributions/types'
import { useAutoSize, useRoutePipeTypes } from './plumbing/surface'
import { createDiagramCommand, diagramViews } from './diagrams/diagram-commands'
import { OrganizationStatusBar } from './organization/OrganizationStatusBar'
import { ViewPhaseFields } from './organization/ViewPhaseFields'
import { Portal } from 'radix-ui'
import type { EditorFileChrome } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { MutinyMark, MutinySplash, WindowControls, useFullscreen, useMutinyPortalContainer, useMutinyPresentation, useMutinyTheme } from '@permitzip/bim-ui'
import { SessionChromeStore, useSessionChrome } from './state/session-chrome-store'

/** The session's sync channel (branch, version and merge requests). */
type SurfaceSyncChannel = NonNullable<ReturnType<ModelSession['syncChannel']>>

/** Views whose drawing shows the model, so Tag all has something to tag. */
const TAGGABLE_VIEW_TYPES: ReadonlySet<string> = new Set(['floor_plan', 'ceiling_plan', 'section'])

/** The status bar reads only the active group and phase: an edit elsewhere skips it. */
const ORGANIZATION_ZONES: ReadonlySet<string> = new Set([ORGANIZATION_ZONE])

export type BuildingModelView = '3d' | 'plan' | 'sheet'

export type { BuildingModelTool } from './building-model-ribbon'

/** Space the properties panel takes on the right of the canvas (w-80), so overlays clear it. */
const PROPERTIES_PANEL_PX = 320

/** Keys typed into a field are the field's, not the view's. */
function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

interface Props {
  projectId: string
  projectName: string
  /** Printed as PROJECT NO. in the title block unless a sheet sets its own. */
  projectNumber?: string
  userName: string
  userId: string
  initialView: BuildingModelView
  /** Open this view (a schedule from the project tree) as soon as the model shows it; a new id opens that one. */
  openViewId?: string
}

interface SurfaceConfig {
  projectNumber: string | null
  references: ReferenceInfo[]
  authority: { url: string; modelId: string } | null
  revitParametersUrl?: string
}

function isSurfaceConfig(value: unknown): value is SurfaceConfig {
  return typeof value === 'object' && value !== null && 'references' in value && Array.isArray(value.references) && 'authority' in value
}

/** What a saved view's camera frames from (type, crop and props), leaving out its projection. A 3D view frames from its saved camera only: moving its crop box never moves the camera. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

/** What shared dialogs read from the add-ons' workflows (sizing rules, the code edition), typed by the dialog. */
type ListProps = ComponentProps<typeof EquipmentListDialogComponent>

/** Bring a section of the open view's properties into sight and put the keyboard on its first control. */
function focusViewSection(id: string): void {
  const section = document.getElementById(id) ?? document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!section) {
    toast.info('Open the view’s properties on the right to see this.')
    return
  }
  section.scrollIntoView({ block: 'start', behavior: 'smooth' })
  section.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [role="combobox"]:not([disabled])')?.focus({ preventScroll: true })
}

/** No host header around the editor: its title and status sit in its own ribbon. */
function useNoFileChrome(): EditorFileChrome | null {
  return null
}

/** The open title and status in the ribbon's own trailing slot, so they update without re-rendering the ribbon. */
function RibbonTrailing({ targetId, children }: { targetId: string; children: ReactElement }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTarget(document.getElementById(targetId))
  }, [targetId])
  if (!target) return null
  return (
    <Portal.Root asChild container={target}>
      {children}
    </Portal.Root>
  )
}

/** The project's black-only printing choice (Sheets › Black only), re-read only when the model changes. */
const printBlackOnlySelector: ModelSelector<boolean> = (snapshot) => (snapshot.model ? organizationOf(snapshot.model).printBlackOnly : false)

export function BuildingModelSurface({ projectId, projectName, projectNumber, userName, userId, initialView, openViewId }: Props) {
  const host = useEditorHost()
  const { openConfig: openModelConfig, getAccessToken } = host.session
  const referencesPort = host.data.references
  const hostCapabilities = host.capabilities
  const linkedModelsPort = host.data.linkedModels
  const linkSources = useMemo(() => linkSourcesOf(linkedModelsPort), [linkedModelsPort])
  const firmLibraryPort = host.data.firmLibrary
  const sheetTitle = useMemo<SheetTitle>(() => ({ projectName, projectNumber: projectNumber ?? '', firmName: SHEET_FIRM_NAME }), [projectName, projectNumber])
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<ModelSession | null>(null)
  const autoSize = useAutoSize(projectId, (command, label) => sessionRef.current?.submitCommand(command, label) ?? "Live editing isn't connected, so changes can't be saved.")
  const dragRef = useRef<{ drag: SlideDrag; s: number | null } | null>(null)
  const [requested, setOpen] = useState<OpenItem>({ kind: 'model', mode: initialView === 'plan' ? 'plan' : '3d' })
  const [viewDisplay, setViewDisplay] = useState<ViewDisplay>('model')
  const viewDisplayPrefs = useViewDisplayPrefsFrom(host.data.viewPrefs, projectId)
  const cameraMemory = useViewCameraMemoryFrom(host.data.viewPrefs, projectId)
  /** The person picked live model or printed drawing since this view opened (their saved choice arriving late must not undo it). */
  const displayChosenRef = useRef(false)
  const [sectionTool, setSectionTool] = useState(false)
  const [request, setRequest] = useState<PanelRequest | null>(null)
  /** Sheets › Project info, open over whatever else is open (the sheet dialog keeps what was typed). */
  const [projectInfoOpen, setProjectInfoOpen] = useState(false)
  /** Print dialog: the saved revision and how many of your unsaved edits touch the sheet, taken when it opened. */
  const [printing, setPrinting] = useState<{ savedRevision: number; pendingOnSheet: number } | null>(null)
  const [viewer, setViewer] = useState<ModelViewer3D | null>(null)
  const mutinyTheme = useMutinyTheme()
  const presentation = useMutinyPresentation()
  const bimRoot = useMutinyPortalContainer()
  const { active: fullscreen } = useFullscreen(bimRoot)
  const viewerColorsRef = useRef(mutinyTheme.viewer)
  const [levelElevations, setLevelElevations] = useState<Record<string, number>>({})
  const [config, setConfig] = useState<SurfaceConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>('Opening the model…')
  // The trade add-ons are their own download, fetched beside the model's config; the session opens once they are installed.
  const [addOnsReady, setAddOnsReady] = useState(() => addOns() !== null)
  useEffect(() => {
    if (addOnsReady) return
    let cancelled = false
    loadAddOns()
      .then(() => {
        if (!cancelled) setAddOnsReady(true)
      })
      .catch((err: unknown) => {
        console.error('[BuildingModelSurface] the add-ons failed to load', err)
        if (!cancelled) setLoadError(`The trade tools for this model didn't load (${err instanceof Error ? err.message : String(err)}).`)
      })
    return () => {
      cancelled = true
    }
  }, [addOnsReady])
  const [references, setReferences] = useState<(LoadedReference & { bytes: number })[]>([])
  /** The free 3D model's phase, filter and group visibility (this tab only; saved views keep their own). */
  const [freeDisplay, setFreeDisplay] = useState<DisplayContext>({})
  const [organizationDialog, setOrganizationDialog] = useState<'groups' | 'phases' | 'filters' | 'stages' | 'addons' | 'codes' | null>(null)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  /** Tag styles open: on which style, previewed on which element. */
  const [tagStylesOpen, setTagStylesOpen] = useState<{ readonly styleId: string | null; readonly sampleElementId: string | null } | null>(null)
  const [level, setLevel] = useState<string>('all')
  const [connection, setStatus] = useState<ConnectionStatus>('connecting')
  const [problem, setProblem] = useState<ConnectionProblem | null>(null)
  const [save, setSave] = useState<SaveState>({ pending: 0, retrying: 0, message: null })
  const [people, setPeople] = useState<ReadonlyMap<string, Presence>>(new Map())
  const [selection, setSelection] = useState<Selection | null>(null)
  /** The open model as the session last showed it (drag preview included), for every panel through selectors. */
  const [modelStore] = useState(() => new ModelStore())
  /** The session's committed view (no drag preview): the part and run properties in the Inspector read it. */
  const [viewStore] = useState(() => new ModelStore())
  /** Edits paused, the branch and merge availability from the session, updated on its events (not on re-renders). */
  const [sessionChromeStore] = useState(() => new SessionChromeStore<SurfaceSyncChannel, BranchRef>())
  const sessionChrome = useSessionChrome(sessionChromeStore)
  // An add-on's workflow code arriving (or failing) changes what its ribbon commands say.
  useContributionsVersion()
  /**
   * The model for the surface's own chrome (levels, part types, systems, the site, documents,
   * organization), refreshed only by an edit to those: an ordinary edit doesn't re-render the surface.
   * Readers of other elements read the store (`ModelFromStore`), or `currentModel()` when they run.
   */
  const [chromeSelector] = useState(createSurfaceChromeSelector)
  const model = useModelSelector(modelStore, chromeSelector)
  const printBlackOnly = useModelSelector(modelStore, printBlackOnlySelector)
  /** The newest model, for handlers and effects; reading it never re-renders the surface. */
  const currentModel = useCallback((): ModelState | null => modelStore.getSnapshot().model, [modelStore])
  const selectedIds = useMemo<readonly string[]>(() => (selection?.kind === 'authored' ? [selection.element.id] : selection?.kind === 'group' ? selection.ids : []), [selection])
  /** The model for readers of the selection (label, totals, copy, the "+" handles): refreshed when a selected element changes. */
  const selectionModelSelector = useMemo(() => createModelForIdsSelector(selectedIds), [selectedIds])
  const selectionModel = useModelSelector(modelStore, selectionModelSelector)
  const { router, pathname, searchParams } = useEditorNavigation()
  /** New list schedule dialog, open on this category; null: closed. */
  const [listScheduleFor, setListScheduleFor] = useState<ScheduleCategory | null>(null)
  // The one New schedule window's starting pick when a trade's button opened it (`form:<kind>`); undefined: what it lists by category.
  const [schedulePick, setSchedulePick] = useState<string | undefined>(undefined)
  const [equipmentListFor, setEquipmentListFor] = useState<EquipmentListTrade | null>(null)
  /** Firm and project equipment fields over the built-in baseline (equipment list columns, Inspector sections). */
  const equipmentLibrary = useEquipmentLibraryFrom(host.data.firmLibrary, projectId)
  /** The Not placed yet list, opened from this ribbon tab's Plan group; null: closed. */
  const [notPlacedFor, setNotPlacedFor] = useState<string | null>(null)
  /** A part from Not placed yet being placed in the live view; null: none. */
  const [plannedPlacing, setPlannedPlacing] = useState<PlannedPlacing | null>(null)
  /** Spaces and zones in the left panel (Plan › Spaces). */
  const [spacesOpen, setSpacesOpen] = useState(false)
  /** The add-on rail section open in the left panel (its id); null: none. */
  const [openRail, setOpenRail] = useState<string | null>(null)
  const [questionFocus, setQuestionFocus] = useState<{ readonly questionId: ElementId } | null>(null)
  const openQuestion = useCallback((questionId: ElementId) => {
    setQuestionFocus({ questionId })
    setCoordinationOpen(true)
  }, [])
  /** One loads engine per open model, advanced from each edit (k2-loads). */
  const [loadsLayer] = useState(() => new LoadsLayer())
  const [sectionOn, setSectionOn] = useState(false)
  const [freeProjection, setFreeProjection] = useState<Projection>('perspective')
  /** Someone without edit access switched a saved 3D view's projection: shown here only, not saved. */
  const [projectionLook, setProjectionLook] = useState<{ key: string; value: Projection } | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [statsFeed] = useState(() => new ViewerStatsFeed())
  const [dragHint, setDragHint] = useState<string | null>(null)
  const [referenceList, setReferenceList] = useState<ReferenceInfo[] | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [connectAgentOpen, setConnectAgentOpen] = useState(false)
  const [canLink, setCanLink] = useState(false)
  const [unplaced, setUnplaced] = useState<ReadonlyMap<string, UnplacedState>>(new Map())
  const [tool, setTool] = useState<BuildingModelTool>('select')
  const [placeType, setPlaceType] = useState<CatalogEntry | null>(null)
  const [placeLevel, setPlaceLevel] = useState<string | null>(null)
  /** The sheet a view was opened from by double-clicking it there (the way back). */
  const [returnSheet, setReturnSheet] = useState<string | null>(null)
  /** The plan or section opened for editing in place on the open sheet (double-click), null when none. */
  const [sheetModelView, setSheetModelView] = useState<string | null>(null)
  /** That view's screen ↔ plan points through the sheet's paper, when it is a floor or ceiling plan (plan tools draw in it). */
  const [sheetPlanPointer, setSheetPlanPointer] = useState<PlanPointer | null>(null)
  const [placeHeightFt, setPlaceHeightFt] = useState('0')
  /** The Place height the person typed and what for: choosing the same kind of part keeps it. */
  const placeHeightTyped = useRef<TypedPlaceHeight>(null)
  const [routeChoices, setRouteChoices] = useState<RouteChoices>(DEFAULT_ROUTE)
  // The Route panel opens on the person's saved defaults (database, per person and project).
  const routeDefaults = useRouteDefaultsFrom(host.data.routeDefaults, projectId, (rows) =>
    setRouteChoices((c) => rows.reduce((acc, r) => (r.effective ? choicesWithDefaults(acc, r.domain, r.effective) : acc), c)),
  )
  /** Id a new system gets when the next route creates it (kept while you draw, so retries make one system). */
  const [newSystemId, setNewSystemId] = useState(() => newElementId('sys'))
  const [routePoints, setRoutePoints] = useState(0)
  const [toolHint, setToolHint] = useState<string | null>(null)
  /** The last refusal, so the hint line shows it in the warning tone while it is still the hint. */
  const [refusal, setRefusal] = useState<string | null>(null)
  /** The origin marker (Show origin & axes), which point it sits on, and Move origin. */
  const [showOrigin, setShowOrigin] = useState(true)
  const [originPoint, setOriginPoint] = useState<OriginPoint>('project_base_point')
  const [movingOrigin, setMovingOrigin] = useState(false)
  /** How the last origin move applied (this session); the next move offers it first. */
  const [originMode, setOriginMode] = useState<OriginMoveMode>('move_point')
  /** While dragging the origin, a click in the view places it instead of selecting. */
  const movingOriginRef = useRef(false)
  const [coordinatesOpen, setCoordinatesOpen] = useState<CoordinatesTab | null>(null)
  const [pickingNorth, setPickingNorth] = useState(false)
  const [undoState, setUndoState] = useState<UndoState>({ undo: null, redo: null })
  const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; title: string; plan: DeletePlan } | null>(null)
  /** The tab you picked, for what was open when you picked it; opening something else (or selecting) shows its own tab. */
  /** The drawing tool, for the drawing it was picked in; a newly opened drawing starts on Select. */
  const [drawingPick, setDrawingPick] = useState<{ readonly openKey: string; readonly tool: DrawingTool }>({ openKey: '', tool: 'select' })
  const [lastDetailShape, setLastDetailShape] = useState<DetailShape>('line')
  const [drawingTools, setDrawingTools] = useState<readonly DrawingTool[]>([])
  const [levelRequest, setLevelRequest] = useState<LevelRequest | null>(null)
  const [routeChecks, setRouteChecks] = useState<readonly RouteCheck[]>([])
  const [routeTickMarks, setRouteTickMarks] = useState<Pick<LivePlanRouteTicksProps, 'ticks' | 'pieces'> | null>(null)
  const [planeDialogOpen, setPlaneDialogOpen] = useState(false)
  const [showLevels, setShowLevels] = useState(true)
  /** Bumped by the ribbon's Edit type, so the part's properties open the type editor. */
  const [editTypeRequest, setEditTypeRequest] = useState(0)
  /** The part editor; `spot`: Model in place, whose first save also places the part there. */
  const [partEditor, setPartEditor] = useState<{ definition: PartTypeDefinition | null; spot?: InPlaceSpot | null } | null>(null)
  /** Model in place is waiting for the click that says where the part goes. */
  const [inPlacePick, setInPlacePick] = useState(false)
  const movingRef = useRef(false)
  /** A box being dragged (window / crossing), in client pixels. */
  const [boxDrag, setBoxDrag] = useState<BoxDrag | null>(null)
  const boxRef = useRef<BoxDrag | null>(null)
  const runDragRef = useRef(false)
  const routeDragRef = useRef<{ x: number; y: number; started: boolean } | null>(null)
  const [boxFilter, setBoxFilter] = useState<Readonly<Record<BoxCategory, boolean>>>({ duct: true, pipe: true, parts: true })
  const [axisLock, setAxisLockState] = useState<AxisLock>('auto')
  /** The lock to go back to when Alt (any angle) is let go; null while Alt isn't held. */
  const altLockRef = useRef<AxisLock | null>(null)
  const [axisBadge, setAxisBadge] = useState<{ text: string; x: number; y: number } | null>(null)
  const [grabHandle, setGrabHandle] = useState<{ x: number; y: number; kind: 'segment' | 'corner' | 'end'; hint: string } | null>(null)
  useEffect(() => viewer?.onCameraChange(() => setGrabHandle(null)), [viewer])
  const [plusHandles, setPlusHandles] = useState<readonly PlusHandle[]>([])
  /** A "+" was picked: once the Route tool is armed with the piece's choices, start on this open end. */
  const pendingRouteStart = useRef<{ readonly elementId: string; readonly port: string } | null>(null)
  const [faceHandles, setFaceHandles] = useState<readonly FaceHandle[]>([])
  /** A top / bottom "+" was picked: once the Route tool is armed with the run's choices, start off that face. */
  const pendingFaceStart = useRef<FaceHandle | null>(null)
  // A "+" on a sloped pipe's side, waiting for the Route tool to arm.
  const pendingSideStart = useRef<{ readonly elementId: string; readonly s: number } | null>(null)
  const [offsetArmed, setOffsetArmed] = useState(false)
  // Route › Inherit: the next click in the view takes what is clicked's height, size, system and slope.
  const [inheritArmed, setInheritArmed] = useState(false)
  const applyInheritRef = useRef<(pick: InheritPick) => void>(() => undefined)
  /** The live session once it has a model (state, so render can read levels and types from it). */
  const [live, setLive] = useState<ModelSession | null>(null)
  const publishActivity = useCallback((activity: Presence['activity']) => live?.publishActivity(activity), [live])

  const actor = useMemo<Actor>(() => ({ id: userId, name: userName, kind: 'human' }), [userId, userName])

  // The open branch rides on the address (`?branch=`): the route answers that branch's model id, and a new one reopens the session.
  const pageBranch = branchIdFromHref(`?${searchParams.toString()}`)
  // Round 9 lane Q9: who you are to a question (Ask again, the bell), and stale answers told once.
  const questionMe = useMemo<AuthorRef>(() => ({ provider: 'unsigned', subject: userId, kind: 'person', displayName: userName }), [userId, userName])
  // Round 9 lane Q9: the bell's "Questions for you" opens a thread by `?question=<id>`.
  const pageQuestion = searchParams.get('question')
  const [seenPageQuestion, setSeenPageQuestion] = useState<string | null>(null)
  if (pageQuestion && pageQuestion !== seenPageQuestion && /^[A-Za-z0-9._:-]{1,200}$/.test(pageQuestion)) {
    setSeenPageQuestion(pageQuestion)
    setQuestionFocus({ questionId: asElementId(pageQuestion) })
    setCoordinationOpen(true)
  }
  useEffect(() => {
    let cancelled = false
    openModelConfig(projectId, { branch: pageBranch })
      .then((body: unknown) => {
        if (!isSurfaceConfig(body)) throw new Error('The model service sent an unexpected answer.')
        if (!cancelled) setConfig((prev) => (prev && prev.authority?.modelId === body.authority?.modelId && prev.authority?.url === body.authority?.url ? prev : body))
      })
      .catch((err: unknown) => {
        console.error('[BuildingModelSurface] config load failed', err)
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't open the model.")
      })
    return () => {
      cancelled = true
    }
  }, [projectId, pageBranch, openModelConfig])

  // The session opens once per model server (or none); another branch of the same model rides
  // `ModelSession.reconnect` below, so the 3D view, linked models and camera stay put.
  const [openConfig, setOpenConfig] = useState<SurfaceConfig | null>(null)
  if (config !== openConfig && (openConfig === null || config === null || (config.authority?.url ?? null) !== (openConfig.authority?.url ?? null))) setOpenConfig(config)

  useEffect(() => {
    const container = canvasRef.current
    if (!openConfig || !container || !addOnsReady) return
    const session = new ModelSession(container, actor, {
      onPhase: setPhase,
      onReferenceLoaded: (info) => setReferences((prev) => [...prev.filter((r) => r.id !== info.id), info]),
      onReferenceRemoved: (id) => setReferences((prev) => prev.filter((r) => r.id !== id)),
      onModel: (_accepted, current, changedIds) => {
        loadsLayer.noteChanged(changedIds)
        modelStore.publish(current, changedIds)
        viewStore.publish(session.currentView(), null)
        setLive(session)
        sessionChromeStore.notify()
      },
      onStatus: (next) => {
        setStatus(next)
        sessionChromeStore.notify()
      },
      onSaveState: (next) => {
        setSave(next)
        sessionChromeStore.notify()
      },
      onBranchState: () => sessionChromeStore.notify(),
      onPresence: setPeople,
      onActivity: (message) => toast(message),
      onProblem: (next) => {
        setProblem(next)
        sessionChromeStore.notify()
      },
      onSelection: setSelection,
      onStats: statsFeed.publish,
      onUnplaced: (referenceId, state) => setUnplaced((prev) => new Map(prev).set(referenceId, state)),
      onUndoState: setUndoState,
      onSaved: autoSize,
      onRefused: (message) => {
        setRefusal(message)
        setToolHint(message)
      },
      onRouteChecks: (checks) => {
        setRouteChecks(checks)
        setRouteTickMarks(checks.length > 0 ? { ticks: session.routeTicks(), pieces: session.routeTickPieces() } : null)
      },
    }, getAccessToken, referencesPort, hostCapabilities)
    session.setViewerColors(viewerColorsRef.current)
    sessionRef.current = session
    sessionChromeStore.setSource(session)
    session
      .open(openConfig)
      .then(() => setViewer(session.viewer))
      .catch((err: unknown) => {
        console.error('[BuildingModelSurface] model open failed', err)
        setLoadError(err instanceof Error ? err.message : "Couldn't open the model.")
        setPhase('')
      })
    return () => {
      session.dispose()
      sessionRef.current = null
      sessionChromeStore.setSource(null)
      setViewer(null)
    }
  }, [openConfig, addOnsReady, actor, statsFeed, autoSize, loadsLayer, modelStore, viewStore, sessionChromeStore, getAccessToken, referencesPort, hostCapabilities])

  // Route checks read the firm's and the project's design limits (clearances); until they load, the add-ons' defaults.
  useEffect(() => {
    if (!live) return
    let gone = false
    import('@permitzip/bim-editor/editor/design-limits/design-limits-client')
      .then((m) => m.loadDesignLimitSourcesFrom(firmLibraryPort, projectId))
      .then((limits) => {
        if (!gone) live.setDesignLimits(limits)
      })
      .catch((err: unknown) => {
        console.error('[BuildingModelSurface] design limits failed to load for route checks', err)
        if (!gone) toast.error("The firm's design limits couldn't be loaded, so route checks use the add-ons' defaults. Reload the page to try again.")
      })
    return () => {
      gone = true
    }
  }, [live, projectId, firmLibraryPort])

  /** A linked model became ready, switched version, moved or was unlinked: update the 3D view in place. */
  const refreshReferences = useCallback(() => {
    openModelConfig(projectId, { fresh: true })
      .then(async (body: unknown) => {
        if (!isSurfaceConfig(body)) throw new Error('The model service sent an unexpected answer.')
        setReferenceList(body.references)
        await sessionRef.current?.syncReferences(body.references)
      })
      .catch((err: unknown) => {
        console.error('[BuildingModelSurface] reference refresh failed', err)
        toast.error("The linked models changed, but the 3D view couldn't update. Reload the page to see them.")
      })
  }, [projectId, openModelConfig])

  /** Views, sheets and what is placed on them: unchanged (same object) while an edit touches no document. */
  const documentsModel = useDocumentsModel(modelStore)
  const index = useDocumentIndex(modelStore)
  useModelPacks(model)
  const requestedView = requested.kind === 'view' ? index?.views.find((v) => v.id === requested.id) ?? null : null
  const requestedSheet = requested.kind === 'sheet' ? index?.sheets.find((s) => s.id === requested.id) ?? null : null
  /** The open view or sheet was removed (by someone else, or deleted here): show the 3D model; undo brings it back open. */
  const vanished = index !== null && ((requested.kind === 'view' && !requestedView) || (requested.kind === 'sheet' && !requestedSheet))
  const open: OpenItem = vanished ? { kind: 'model', mode: '3d' } : requested
  const openView = vanished ? null : requestedView
  const openSheet = vanished ? null : requestedSheet
  const sheetImages = useSheetImagesFrom(host.data.sheetImages, projectId, documentsModel)
  const [figureDialog, setFigureDialog] = useState<'chart' | 'picture' | null>(null)
  const [calcDialog, setCalcDialog] = useState(false)
  const [placedFigure, setPlacedFigure] = useState<{ readonly id: string } | null>(null)
  // Detail views are only a drawing; plans, sections and 3D views show the live model or their drawing (sections open as the drawing).
  const showDrawing = open.kind === 'sheet' || (openView !== null && (openView.viewType === 'detail' || viewDisplay === 'drawing'))
  const propertiesOpen = selection !== null || (!showDrawing && openView !== null)
  /** A schedule view on its live side opens as the editable grid. */
  const scheduleGridOpen = openView !== null && openView.viewType === 'schedule' && !showDrawing
  /** A saved view with a live model is showing its drawing: the model tools switch it to the live model. */
  const liveViewOnDrawing = openView !== null && openView.viewType !== 'detail' && showDrawing
  const planOpen = openView !== null && (openView.viewType === 'floor_plan' || openView.viewType === 'ceiling_plan') && viewDisplay === 'model'
  /** Views drawn on screen as they print: every view on the open sheet, or the open view's drawing. */
  const drawingViews = useMemo(() => {
    if (!documentsModel) return []
    if (openSheet) return sheetViewports(documentsModel, openSheet).map((e) => e.view)
    return openView && showDrawing ? [openView] : []
  }, [documentsModel, openSheet, openView, showDrawing])
  /** The model's levels: a plan's linked background follows the linked level a person chose for its level. */
  const backgroundLevels = useMemo(() => (documentsModel ? modelLevels(documentsModel) : []), [documentsModel])
  const { backgrounds, states: backgroundStates } = useViewBackgroundsFrom(host.data.viewBackgrounds, projectId, drawingViews, backgroundLevels)
  /** Every plan and section, so opening a sheet draws the architect's background from this tab. */
  const warmViews = useMemo(() => (documentsModel ? elementsOfKind(documentsModel.elements, 'view') : []), [documentsModel])
  useWarmViewBackgroundsFrom(host.data.viewBackgrounds, projectId, warmViews, (referenceList ?? config?.references ?? []).length > 0, backgroundLevels)
  const drawingSection = sectionTool && planOpen
  /** A 3D camera (the free model, a 3D view or a section's live model) fills the canvas. */
  const live3dOpen = !showDrawing && !planOpen && !(open.kind === 'model' && open.mode === 'plan')
  const livePlanOpen = !showDrawing && (planOpen || (open.kind === 'model' && open.mode === 'plan'))
  // A saved 3D view keeps its projection; the free model and sections use this tab's choice.
  const viewItemKey = open.kind === 'model' ? null : `${open.kind}:${open.id}`
  const savedProjection: Projection | null = openView?.viewType === 'three_d' ? (openView.props?.projection ?? 'perspective') : null
  const projection: Projection = (projectionLook && projectionLook.key === viewItemKey ? projectionLook.value : null) ?? savedProjection ?? freeProjection

  useEffect(() => {
    if (vanished) toast(`That ${requested.kind} was removed, so the 3D model is showing. Ctrl+Z brings it back if you removed it.`)
  }, [vanished, requested.kind])

  /** Floor elevation of a level: the same-floor model level's, else the linked models' storey (cached); 0 when neither has it. */
  const elevationOf = useCallback(
    async (levelName: string | undefined): Promise<number> => {
      if (!levelName) return 0
      const own = model ? viewModelLevel(model, levelName) : null
      if (own) return own.elevationMm
      const cached = levelElevations[levelName]
      if (cached !== undefined) return cached
      const found = (await sessionRef.current?.viewer?.levelElevationMm(levelName)) ?? null
      const value = found ?? 0
      setLevelElevations((prev) => ({ ...prev, [levelName]: value }))
      return value
    },
    [levelElevations, model],
  )
  /** The open view's floor, the one its drawing and the live canvas both cut from. */
  const openFloorMm = openView ? ((model ? viewFloorMm(model, openView.props?.level, openView.props?.levelElevationMm) : null) ?? levelElevations[openView.props?.level ?? ''] ?? 0) : 0

  const site = useModelSelector(modelStore, selectSite)
  const originVisible = showOrigin && !showDrawing
  // The marker sits on the chosen point; with nothing selected or loaded the 3D view orbits around the project base point.
  useEffect(() => {
    if (!viewer) return
    const p = originPointPosition(site, originPoint)
    viewer.setOriginGizmo(kernelToScene(p.x, p.y, p.z), originVisible)
    viewer.setProjectOrigin(kernelToScene(site.basePoint.x, site.basePoint.y, site.basePoint.z))
  }, [viewer, site, originPoint, originVisible])
  // Before the camera effect, so a turned plan (true north or the working angle) opens already turned.
  const planUpDeg = planOpen && openView ? viewRotationDeg(site, openView) : 0
  useEffect(() => {
    viewer?.setPlanUp(planUpDeg)
  }, [viewer, planUpDeg])

  // Latest values for the camera effect, which runs only when what is open changes (not on every revision).
  const latest = useRef({ openView, level, elevationOf, cameraFor: cameraMemory.cameraFor })
  useEffect(() => {
    latest.current = { openView, level, elevationOf, cameraFor: cameraMemory.cameraFor }
  })
  const openKey = open.kind === 'model' ? `model:${open.mode}` : `${open.kind}:${open.id}:${openView?.version ?? 0}`
  // Switching projection keeps the picture, so saving it on the view must not re-frame the camera to the crop box.
  const cameraKey = open.kind === 'model' || !openView ? openKey : `${open.kind}:${open.id}:${framingSignature(openView)}`

  // Before the camera effect, so a saved orthographic view opens orthographic.
  useEffect(() => {
    viewer?.setProjection(projection)
  }, [viewer, projection])

  // What the canvas last showed (a drawing doesn't move it), so coming back to the same whole-model plan keeps its camera.
  const shownCamera = useRef<{ readonly viewer: unknown; readonly key: string } | null>(null)
  // Where the Top-down plan was left, for this tab: it reopens there after other views.
  const topDownPlan = useRef(new TopDownPlanMemory())
  // Read before the canvas resizes under the drawing and the viewer re-fits the plan beneath it.
  useLayoutEffect(() => {
    if (viewer && showDrawing && shownCamera.current?.viewer === viewer) topDownPlan.current.coveredByDrawing(viewer, shownCamera.current.key)
  }, [viewer, showDrawing])
  // The camera follows what is open; drawings are drawn by the sheet engine instead.
  useEffect(() => {
    if (!viewer || showDrawing) return
    const returning = shownCamera.current?.viewer === viewer && shownCamera.current.key === cameraKey
    if (shownCamera.current?.viewer === viewer) topDownPlan.current.switching(viewer, shownCamera.current.key, cameraKey)
    shownCamera.current = { viewer, key: cameraKey }
    let cancelled = false
    const { openView: view, level: levelFilter, elevationOf: elevation, cameraFor } = latest.current
    const current = currentModel()
    const run = async () => {
      if (cameraKey.startsWith('model:')) {
        const planCamera = topDownPlan.current.cameraFor(viewer, cameraKey)
        await openWholeModel(viewer, cameraKey === 'model:plan' ? 'plan' : '3d', levelFilter, { frame: !returning, planCamera })
        // The model's own 3D reopens where this person left it.
        const left = cameraKey === 'model:3d' ? cameraFor(FREE_3D_KEY) : undefined
        if (left && !cancelled) await viewer.setCamera3d(left)
        return
      }
      if (!view || !current) return
      const props = view.props ?? {}
      // The same levels and floor the view's drawing uses, so what prints is what you edit.
      const shown = liveView(current, view)
      const floor = shown.floorMm ?? (await elevation(props.level))
      if (cancelled) return
      viewer.setAuthoredLevels(shown.levels)
      if (view.viewType === 'floor_plan' || view.viewType === 'ceiling_plan') {
        await viewer.setVerticalSection(null)
        await viewer.isolateLevel(props.level ?? null)
        const cut = livePlanCutMm(current, view, floor)
        viewer.setMode('plan', cut)
        viewer.setPlanCut(cut)
        await viewer.framePlanRect(view.cropMin, view.cropMax, { animate: false })
        // Crop view on: the live model is cut at the crop box too, as it prints.
        if (!cancelled) viewer.setPlanCrop(props.cropView === false ? null : { min: view.cropMin, max: view.cropMax })
      } else if (view.viewType === 'section' && props.section) {
        await viewer.isolateLevel(null)
        await viewer.setVerticalSection({ ...props.section, eyeElevationMm: floor + 1600 })
      } else if (view.viewType === 'three_d') {
        await viewer.setVerticalSection(null)
        viewer.setMode('3d')
        viewer.setPlanCrop(null)
        await viewer.isolateLevel(props.level ?? null)
        // The 3D crop box itself is applied by useCrop3d.
        // Where this person left this view last, else the view's own camera (what prints).
        const camera = cameraFor(view.id) ?? viewCamera3d(current, view)
        if (camera) await viewer.setCamera3d(camera)
        else await viewer.framePlanRect(view.cropMin, view.cropMax)
      }
    }
    void run().catch((err: unknown) => {
      console.error('[BuildingModelSurface] opening the view in the canvas failed', { cameraKey, err })
      toast.error("The view couldn't be shown in the canvas. Its printed drawing is still available.")
    })
    return () => {
      cancelled = true
    }
  }, [cameraKey, showDrawing, viewer, currentModel, cameraMemory.loaded])

  // Remember where this person is in a 3D view each time the camera rests (saved per person, per view, in the database).
  const cameraRememberKey = cameraMemoryKey(open, openView, showDrawing)
  const rememberCamera = cameraMemory.remember
  useEffect(() => {
    if (!viewer || !cameraRememberKey || !cameraMemory.loaded) return
    return viewer.onCameraSettled(() => {
      const camera = viewer.camera3dState()
      if (camera) rememberCamera(cameraRememberKey, camera)
    })
  }, [viewer, cameraRememberKey, cameraMemory.loaded, rememberCamera])

  // An open plan or 3D view shows the live model in the visual style it sets; otherwise shaded with edges, as before.
  const liveStyle = openView && !showDrawing ? openView.props?.visualStyle ?? 'shaded_edges' : 'shaded_edges'
  useEffect(() => {
    viewer?.setVisualStyle(liveStyle)
  }, [viewer, liveStyle])

  // The live model draws by the open view's phase, phase filter and groups (or the free model's own choices).
  const displayContext = useMemo<DisplayContext>(() => (openView ? displayContextOf(openView) : freeDisplay), [openView, freeDisplay])
  useEffect(() => {
    sessionRef.current?.setDisplayContext(displayContext)
  }, [viewer, displayContext])
  // …and by the open view's Visibility/Graphics switches, the same answer its printed drawing reads.
  useEffect(() => {
    sessionRef.current?.setCategoryView(openView ?? null)
  }, [viewer, openView])

  // The level filter applies to the free 3D model; an open view isolates its own level.
  const modelOpen = open.kind === 'model'
  useEffect(() => {
    if (modelOpen) void sessionRef.current?.viewer?.isolateLevel(level === 'all' ? null : level)
  }, [level, modelOpen])

  useEffect(() => {
    const viewer = sessionRef.current?.viewer
    if (!viewer) return
    if (!sectionOn) {
      viewer.setSectionBox(null)
      return
    }
    // Lift the roof off: cut just above the new ductwork (or one storey up) around the work area.
    void viewer.workBox().then((box) => {
      const work = viewer.authoredBox()
      const cut = box.clone()
      cut.max.y = work.isEmpty() ? box.min.y + 3.6 : work.max.y + 0.9
      viewer.setSectionBox(cut)
      void viewer.frame(cut)
    })
  }, [sectionOn])

  const referenceLevels = useMemo(() => {
    const names = new Set<string>()
    for (const r of references) for (const l of r.levels) names.add(l.name)
    return [...names]
  }, [references])

  /**
   * Levels a new plan can be for: the linked models' storeys, plus the model's
   * own levels that no storey already names (the same floor written "LEVEL 1"
   * and "Level 1" is one entry; drawing matches them either way).
   */
  const ownLevelNames = useModelSelector(modelStore, selectModelLevelNames, shallowArrayEqual)
  const planLevels = useMemo(() => {
    const names = [...referenceLevels]
    const seen = new Set(names.map(normalizeLevelName))
    for (const name of ownLevelNames) {
      if (seen.has(normalizeLevelName(name))) continue
      seen.add(normalizeLevelName(name))
      names.push(name)
    }
    return names
  }, [referenceLevels, ownLevelNames])

  const status: ConnectionStatus | 'read_only' = config && !config.authority ? 'read_only' : connection
  const canEdit = status !== 'read_only' && model !== null && problem?.kind !== 'no_access' && status !== 'denied'
  const blockedReason =
    status === 'read_only' || problem?.kind === 'no_model'
      ? "Live editing isn't connected for this project, so views and sheets can't be made here yet."
      : problem?.kind === 'no_access' || status === 'denied'
        ? "You can look, but you don't have editing access to this model. Ask a project lead."
        : 'Connecting to the model server…'

  // Branches, versions, responsibilities, merges and change orders (round 8b) ride the same model socket.
  const syncChannel = sessionChrome.channel
  const socketLive = connection === 'live' || connection === 'degraded'
  const authorityModelId = config?.authority?.modelId ?? null
  const versions = useVersions({ channel: syncChannel, connected: socketLive, projectId, modelId: authorityModelId })
  const versionEntries = versions.state.status === 'ready' ? versions.state.entries : null
  const [historyDialog, setHistoryDialog] = useState<'versions' | 'responsibilities' | 'change_orders' | 'propose_merge' | 'copies' | null>(null)
  const [startFrom, setStartFrom] = useState<{ readonly key: string; readonly nonce: number } | null>(null)
  const openBranch = useCallback((branchId: string | null) => router.replace(withBranch(`${pathname}?${searchParams.toString()}`, branchId)), [pathname, router, searchParams])
  // A branch switch on the same model server keeps the session; edits still saving make it wait, and the address goes back.
  const switchAuthorityUrl = config?.authority?.url ?? null
  const switchModelId = config?.authority?.modelId ?? null
  useEffect(() => {
    const session = sessionRef.current
    if (!session || switchAuthorityUrl === null || switchModelId === null) return
    const stayingOn = session.liveModelId()
    const why = session.reconnect({ url: switchAuthorityUrl, modelId: switchModelId })
    if (!why) return
    toast(why)
    openBranch(stayingOn ? (parseBranchModelId(stayingOn)?.branchId ?? null) : null)
  }, [switchAuthorityUrl, switchModelId, openBranch])
  const { personChose } = useFollowThreadBranchFrom({ agent: host.agent, threadBranch: host.data.threadBranch }, { projectId, pageBranch, navigate: openBranch })
  const onBranch = sessionChrome.branch
  const showBranches = syncChannel !== null && (onBranch !== null || (socketLive && sessionChrome.branchesAvailable))
  const mergeBlocked = !canEdit ? blockedReason : syncChannel && !sessionChrome.mergeAvailable ? "This model server doesn't merge branches yet." : null
  /** Manage › Copies: one copy question to the model server. */
  const askCopies = useCallback((msg: LineageRequest) => (syncChannel ? syncChannel.lineageRequest(msg) : Promise.reject(new Error('Not connected to the model server yet. Try again in a moment.'))), [syncChannel])
  const requestMergePreview = useCallback(async (): Promise<MergePreview> => {
    if (!syncChannel) throw new Error('Not connected to the model server yet. Try again in a moment.')
    const answer = await syncChannel.mergeRequest({ type: 'merge_preview' })
    if (answer.type === 'merge_preview_result') return answer.preview
    throw new Error(answer.type === 'merge_refused' ? answer.message : "The model server's answer didn't match the question. Try again.")
  }, [syncChannel])
  const requestMergeApply = useCallback(
    async (proposalId: string): Promise<MergeApplyResult> => {
      if (!syncChannel) throw new Error('Not connected to the model server yet. Try again in a moment.')
      const answer = await syncChannel.mergeRequest({ type: 'merge_apply', proposalId })
      if (answer.type === 'merge_apply_result') return { landed: answer.landed, waiting: answer.waiting, allLanded: answer.allLanded }
      throw new Error(answer.type === 'merge_refused' ? answer.message : "The model server's answer didn't match the question. Try again.")
    },
    [syncChannel],
  )

  const submit = useCallback<SubmitCommand>((command, label) => {
    const session = sessionRef.current
    if (!session) return "Live editing isn't connected, so changes can't be saved."
    return session.submitCommand(command, label)
  }, [])

  /** Undo your newest edit, whether a part, ductwork, view or sheet change (Ctrl+Z does the same). */
  const undo = useCallback(() => {
    const refused = sessionRef.current?.undo() ?? null
    if (refused) toast.error(refused)
  }, [])

  const openItem = useCallback(
    (item: OpenItem, display?: ViewDisplay) => {
      const from = requested.kind === 'view' ? index?.views.find((v) => v.id === requested.id) : undefined
      setOpen(item)
      const view = item.kind === 'view' ? index?.views.find((v) => v.id === item.id) : undefined
      displayChosenRef.current = display !== undefined
      setViewDisplay(display ?? (view ? viewDisplayPrefs.displayFor(view) : 'model'))
      setSectionTool(false)
      // Equipment picked on a live diagram stays picked in the plan or 3D (and the other way): the diagram is the model.
      if (!view?.props?.diagram && !from?.props?.diagram) setSelection(null)
      setPlaceLevel(null)
      setReturnSheet(null)
    },
    [index, viewDisplayPrefs, requested],
  )

  // The project tree's Building model › Schedules follows the model's list schedules live.
  const scheduleListKey = useMemo(
    () => JSON.stringify((index?.views ?? []).filter((v) => v.viewType === 'schedule' && (v.props?.schedule || v.props?.scheduleV2)).map((v) => [v.id, v.name])),
    [index],
  )
  useEffect(() => {
    if (!index) return
    const parsed: unknown = JSON.parse(scheduleListKey)
    const items = Array.isArray(parsed) ? parsed.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' ? [{ id: p[0], name: p[1] }] : [])) : []
    announceModelSchedules({ projectId, items })
  }, [index, scheduleListKey, projectId])
  const openedFromTree = useRef<string | null>(null)
  useEffect(() => {
    if (!openViewId || openedFromTree.current === openViewId || !index?.views.some((v) => v.id === openViewId)) return
    openedFromTree.current = openViewId
    openItem({ kind: 'view', id: openViewId })
  }, [openViewId, index, openItem])

  // A view opened before the saved choices arrived takes its saved choice once they do, unless the person already picked.
  const displayPrefsApplied = useRef(false)
  useEffect(() => {
    if (!viewDisplayPrefs.loaded || displayPrefsApplied.current) return
    displayPrefsApplied.current = true
    if (!displayChosenRef.current && requestedView) setViewDisplay(viewDisplayPrefs.displayFor(requestedView))
  }, [viewDisplayPrefs, requestedView])

  /** The person picked live model or printed drawing for the open view: show it and remember it for them. */
  const chooseDisplay = useCallback(
    (display: ViewDisplay) => {
      displayChosenRef.current = true
      setViewDisplay(display)
      if (requestedView) viewDisplayPrefs.remember(requestedView.id, display)
    },
    [requestedView, viewDisplayPrefs],
  )

  /** After an edit, a toast with Undo (Ctrl+Z does the same). */
  const submitWithUndo = useCallback<SubmitCommand>(
    (command, label = 'change') => {
      const refusal = submit(command, label)
      if (!refusal) toast(`${label.charAt(0).toUpperCase()}${label.slice(1)}`, { action: { label: 'Undo', onClick: undo } })
      return refusal
    },
    [submit, undo],
  )

  const crop3d = useCrop3d({
    viewer,
    model,
    views: index?.views ?? [],
    openView3d: openView?.viewType === 'three_d' && !showDrawing ? openView : null,
    free3d: !showDrawing && open.kind === 'model' && open.mode === '3d',
    selection,
    userId,
    userName,
    canEdit,
    blockedReason,
    submit: submitWithUndo,
    onOpenView: (id) => openItem({ kind: 'view', id }),
    notify: (message, kind = 'info') => (kind === 'error' ? toast.error(message) : toast(message)),
  })
  const linkedDisplay = useLinkedDisplay({
    viewer,
    references,
    openView: openView ?? null,
    views: index?.views ?? [],
    userId,
    userName,
    canEdit,
    blockedReason,
    submit: submitWithUndo,
    notify: (message, kind = 'info') => (kind === 'error' ? toast.error(message) : toast(message)),
    extent: async () => (await viewer?.sceneExtentMm()) ?? undefined,
  })
  const crop3dRef = useRef(crop3d)
  useEffect(() => {
    crop3dRef.current = crop3d
  })
  const crop3dControls = {
    box: crop3d.box,
    on: crop3d.on,
    shown: crop3d.shown,
    set: crop3d.set,
    setBox: crop3d.setBox,
    reset: () => void crop3d.reset(),
    workingAngleDeg: crop3d.workingAngleDeg,
    alignToWorkingAngle: crop3d.alignToWorkingAngle,
    alignToEdge: () => workingAngle.startPick({ kind: 'crop', label: openView?.name ?? 'the 3D view' }),
    alignBlocked: crop3d.alignBlocked,
    useCamera: (): string | null => {
      const camera = viewer?.camera3dState()
      if (!camera || !openView || openView.viewType !== 'three_d') return 'Open the 3D view in the canvas first.'
      return submitWithUndo({ type: 'set_3d_view_camera', viewId: openView.id, camera, projection }, `save the camera of ${openView.name}`)
    },
  }
  /** What the crop box's faces snap to: everything loaded, linked models included. */
  const [sceneExtent, setSceneExtent] = useState<Aabb3 | null>(null)
  useEffect(() => {
    if (!viewer || !crop3d.shown) return
    let cancelled = false
    viewer
      .sceneExtentMm()
      .then((e) => !cancelled && setSceneExtent(e))
      .catch((err: unknown) => console.error('[BuildingModelSurface] reading the model extent for crop snapping failed', err))
    return () => {
      cancelled = true
    }
  }, [viewer, crop3d.shown, references])
  /** Right-click on the canvas without dragging: the selection's menu. */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const rightDownAt = useRef<{ x: number; y: number } | null>(null)
  /** This press became a left + right chord pan: its release opens no menu. */
  const chordPressRef = useRef(false)

  /** Perspective or orthographic: saved on an open 3D view, or for the free model and sections in this tab. */
  const changeProjection = (next: Projection) => {
    if (!live3dOpen) {
      toast.info('Plans and sheets are always orthographic. Open the 3D model or a 3D view to switch projection.')
      return
    }
    if (next === projection) return
    const label = next === 'orthographic' ? 'orthographic' : 'perspective'
    if (openView?.viewType !== 'three_d' || !viewItemKey) {
      setFreeProjection(next)
      return
    }
    if (!canEdit) {
      setProjectionLook({ key: viewItemKey, value: next })
      toast.info(`Showing ${openView.name} ${label} here only. ${blockedReason}`)
      return
    }
    setProjectionLook(null)
    const refusal = submitWithUndo({ type: 'set_view_properties', viewId: openView.id, props: { projection: next } }, `switch ${openView.name} to ${label}`)
    if (refusal) toast.error(refusal)
  }
  const toggleProjection = () => changeProjection(projection === 'orthographic' ? 'perspective' : 'orthographic')
  const toggleProjectionRef = useRef(toggleProjection)
  useEffect(() => {
    toggleProjectionRef.current = toggleProjection
  })

  /** Show, halftone or hide a group: saved on the open view, or for the free 3D model in this tab. */
  const setGroupVisibility = (groupId: string, visibility: GroupVisibility): string | null => {
    const name = model ? (organizationOf(model).groupById.get(groupId)?.entry.name ?? 'the group') : 'the group'
    if (!openView) {
      setFreeDisplay((prev) => ({ ...prev, groupDisplay: { ...prev.groupDisplay, [groupId]: visibility } }))
      return null
    }
    const refusal = submitWithUndo({ type: 'set_view_properties', viewId: openView.id, props: { groupDisplay: { ...openView.props?.groupDisplay, [groupId]: visibility } } }, `${visibility} ${name} in ${openView.name}`)
    if (refusal) toast.error(refusal)
    return refusal
  }

  const viewPhaseFields = (view: ViewElement) => (
    <ModelFromStore store={modelStore}>
      {(shown) =>
        shown && (
          <ViewPhaseFields
            idPrefix="view"
            model={shown}
            context={displayContextOf(view)}
            disabledReason={canEdit ? null : blockedReason}
            onEditFilters={() => setOrganizationDialog('filters')}
            onChange={(change) => submitWithUndo({ type: 'set_view_properties', viewId: view.id, props: change }, change.phaseId ? 'change the view phase' : 'change the phase filter')}
          />
        )
      }
    </ModelFromStore>
  )

  const startSection = useCallback(() => {
    if (planOpen) {
      setSectionTool(true)
      return
    }
    const plan = index?.views.find((v) => v.viewType === 'floor_plan')
    if (plan) {
      openItem({ kind: 'view', id: plan.id })
      setSectionTool(true)
      toast(`Opened ${plan.name}. Drag across it where the section cuts.`)
    } else {
      toast('Sections are drawn on a floor plan. Make one first.')
      setRequest({ kind: 'new_view', viewType: 'floor_plan' })
    }
  }, [planOpen, index, openItem])

  /** Open the live diagram of a kind, making it (one undoable view, no line work) when there is none yet or `forceNew`. */
  const openDiagram = useCallback(
    (kind: StoredDiagramKind, forceNew = false): string | null => {
      const now = currentModel()
      if (!now) return "The model isn't open yet."
      const existing = forceNew ? undefined : diagramViews(now, kind)[0]
      if (existing) {
        openItem({ kind: 'view', id: existing.id })
        return null
      }
      if (!canEdit) return blockedReason
      const id = newId('view')
      const refusal = submitWithUndo(createDiagramCommand(now, kind, id), `make a live ${diagramKindLabel(kind).toLowerCase()}`)
      if (refusal) return refusal
      openItem({ kind: 'view', id })
      return null
    },
    [currentModel, openItem, canEdit, blockedReason, submitWithUndo],
  )

  const onPanelRequest = useCallback(
    (r: PanelRequest) => {
      if (r.kind === 'new_diagram') {
        const refusal = openDiagram(r.diagramKind, true)
        if (refusal) toast.error(refusal)
      } else if (r.kind === 'new_schedule') setListScheduleFor('mechanical_equipment')
      else if (r.kind === 'project_info') setProjectInfoOpen(true)
      else if (r.kind === 'new_view' && r.viewType === 'section') startSection()
      else if (r.kind === 'duplicate_view') {
        const id = newId('view')
        const refusal = submitWithUndo({ type: 'duplicate_view', viewId: r.view.id, newViewId: id }, `duplicate ${r.view.name}`)
        if (refusal) toast.error(refusal)
        else openItem({ kind: 'view', id })
      } else setRequest(r)
    },
    [startSection, submitWithUndo, openItem, openDiagram],
  )

  const downAt = useRef<{ x: number; y: number } | null>(null)
  const [arbiter] = useState(() => new GestureArbiter())
  /** Where the pointer last was over the canvas, so a wheel zoom or orbit can re-run the preview under it. */
  const lastPointer = useRef<{ x: number; y: number; shift: boolean; alt: boolean } | null>(null)
  const toolRef = useRef(tool)
  useEffect(() => {
    toolRef.current = tool
  }, [tool])
  const plannedPlacingRef = useRef<PlannedPlacing | null>(null)
  useEffect(() => {
    plannedPlacingRef.current = plannedPlacing
  }, [plannedPlacing])
  const stopPlannedPlacing = useCallback((hint: string | null) => {
    plannedPlacingRef.current = null
    sessionRef.current?.armPlacement(null)
    setPlannedPlacing(null)
    setToolHint(hint)
  }, [])
  /** The session's own ghost for the part from Not placed yet: the surface under the pointer (slab, linked roof, mounting plane), snapped as Place part is. */
  const previewPlanned = useCallback((session: ModelSession, x: number, y: number): string | null => (plannedPlacingRef.current ? session.previewPlacement(x, y) : null), [])
  const showPlannedClick = useCallback(
    (click: ReturnType<typeof clickPlanned>) => {
      if (click.refused) {
        setToolHint(click.refused)
        toast.error(click.refused)
      } else if (click.placed) stopPlannedPlacing(click.hint)
      else setToolHint(click.hint)
    },
    [stopPlannedPlacing],
  )
  const commitPlanned = useCallback(
    (session: ModelSession, x: number, y: number) => {
      const p = plannedPlacingRef.current
      if (!p) return
      showPlannedClick(clickPlanned(session, p, x, y))
    },
    [showPlannedClick],
  )
  useEffect(() => {
    arbiter.attach(viewer)
    return () => {
      arbiter.cancel()
    }
  }, [arbiter, viewer])
  const [orbitClicks] = useState(() => new OrbitPointClicks())

  const orbitPointClicked = useCallback((hit: ViewerPick | null) => {
    orbitClicks.clicked(sessionRef.current?.viewer, hit, { tool, planOpen })
  }, [orbitClicks, tool, planOpen])

  // Off the canvas, the hover hint no longer describes anything (it named the duct last hovered while the pointer sat on Properties).
  const hoverHintRef = useRef<string | null>(null)
  // Route clicks land in order, each once the surface under it is known; Finish and Enter wait for them,
  // so click, click, Enter never finishes before the points it was given.
  const [routeSteps] = useState(() => orderedSteps('BuildingModelSurface route'))
  // "Routed." stays up while the pointer is still; the still-pointer refresh below would otherwise replace it at once.
  const [routeResult] = useState(resultHold)
  const finishRouteAfterClicks = useCallback(() => {
    void routeSteps(() => {
      setToolHint(sessionRef.current?.finishRoute() ?? null)
      setRoutePoints(sessionRef.current?.routePointCount() ?? 0)
      routeResult.hold(lastPointer.current)
    })
  }, [routeSteps, routeResult])
  const onPointerLeave = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0 || hoverHintRef.current === null) return
    const stale = hoverHintRef.current
    hoverHintRef.current = null
    sessionRef.current?.clearHover()
    setGrabHandle(null)
    setToolHint((prev) => (prev === stale ? null : prev))
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    lastPointer.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey }
    const wasDrag = arbiter.active()?.moved === true
    arbiter.move(e.pointerId, e.clientX, e.clientY)
    const session = sessionRef.current
    if (!session || movingOriginRef.current) return
    if (boxRef.current) {
      // Select's box keeps the hover (and its Tab pre-highlight) until the press turns into a drag.
      if (!wasDrag && arbiter.active()?.moved) session.clearHover()
      boxRef.current = { ...boxRef.current, end: { x: e.clientX, y: e.clientY } }
      setBoxDrag(boxRef.current)
      return
    }
    if (runDragRef.current) {
      // The Tab pre-highlight must survive a press that turns out to be a click.
      const start = downAt.current
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return
      session.clearHover()
      setToolHint(session.previewRunDrag(e.clientX, e.clientY, e.shiftKey, e.altKey))
      return
    }
    if (tool === 'split') {
      setToolHint(session.previewSplit(e.clientX, e.clientY))
      return
    }
    if (plannedPlacingRef.current && e.buttons === 0) {
      setToolHint(previewPlanned(session, e.clientX, e.clientY))
      return
    }
    if (tool === 'select' && e.buttons === 0 && !dragRef.current) {
      const hint = session.hoverAt(e.clientX, e.clientY)
      hoverHintRef.current = hint
      setToolHint((prev) => (prev === hint ? prev : hint))
      const handle = session.grabHandle()
      setGrabHandle((prev) => (prev && handle && prev.kind === handle.kind && Math.abs(prev.x - handle.x) < 0.5 && Math.abs(prev.y - handle.y) < 0.5 ? prev : handle))
      return
    }
    if (tool === 'place') {
      // Shift from the pointer, as Route reads it: with the Height field focused, the Shift keydown goes to the
      // field and never reaches the canvas, and the mounting plane under the pointer took the part.
      session.setShiftHeld(e.shiftKey)
      setToolHint(session.previewPlacement(e.clientX, e.clientY))
      return
    }
    if (tool === 'route') {
      session.setShiftHeld(e.shiftKey)
      setToolHint(session.previewRoute(e.clientX, e.clientY))
      const badge = session.routeAxisBadge()
      const rect = e.currentTarget.getBoundingClientRect()
      setAxisBadge(badge ? { text: badge, x: e.clientX - rect.left + 16, y: e.clientY - rect.top + 16 } : null)
      return
    }
    if (tool === 'move' && movingRef.current) {
      setToolHint(session.previewMove(e.clientX, e.clientY))
      return
    }
    const current = dragRef.current
    if (!current) return
    const res = session.previewSlide(current.drag, e.clientX, e.clientY)
    if (!res) return
    current.s = res.s
    setDragHint(res.limited && res.reason ? `Stopped: ${res.reason}` : `${(res.s / 304.8).toFixed(1)} ft from the start of the trunk`)
  }, [arbiter, tool, previewPlanned])


  /** A click (no camera drag) acts with the current tool: select, place, or measure. */
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = downAt.current
    downAt.current = null
    // The gesture ends here: the camera gets the pointer back before anything is committed.
    arbiter.release(e.pointerId, e.clientX, e.clientY)
    // Only a completed click sets the orbit point, from what it hit; a press or a drag never does.
    const completedClick = orbitClicks.release(e.clientX, e.clientY)
    const session = sessionRef.current
    if (!session || movingOriginRef.current) return
    const box = boxRef.current
    if (box) {
      boxRef.current = null
      setBoxDrag(null)
      const categories = new Set((Object.keys(boxFilter) as BoxCategory[]).filter((c) => boxFilter[c]))
      if (Math.hypot(box.end.x - box.start.x, box.end.y - box.start.y) < 4) {
        void session.selectAt(e.clientX, e.clientY).then((hit) => {
          if (completedClick) orbitPointClicked(hit)
        })
        return
      }
      void session.boxSelect(box.start, box.end, categories).then(setToolHint)
      return
    }
    if (runDragRef.current) {
      runDragRef.current = false
      // A press without a drag on a duct is a click: select it (Tab widens what a click selects).
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) {
        session.endRunDrag(false)
        setToolHint(null)
        void session.selectAt(e.clientX, e.clientY).then((hit) => {
          if (completedClick) orbitPointClicked(hit)
        })
        return
      }
      const refused = session.endRunDrag(true)
      setToolHint(refused)
      if (refused) toast.error(refused)
      return
    }
    if (routeDragRef.current) {
      const from = routeDragRef.current
      routeDragRef.current = null
      setToolHint(session.endRouteDrag(e.clientX, e.clientY, Math.hypot(e.clientX - from.x, e.clientY - from.y) >= 6, from.started))
      setRoutePoints(session.routePointCount())
      return
    }
    if (tool === 'move' && movingRef.current) {
      movingRef.current = false
      const refused = session.endMove(true)
      setToolHint(refused ?? 'Click a part and drag it to move it. Esc to stop.')
      return
    }
    if (dragRef.current) {
      // A press on a branch takeoff that never moved is a click (it selected on the press).
      if (completedClick) void session.viewer?.pick(e.clientX, e.clientY).then(orbitPointClicked)
      return
    }
    const click = start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4
    if (!click) return
    // A click lands on the surface under it, linked models included: it waits only when that pixel's linked-model cast hasn't come back yet.
    // A placement click waiting on its surface still places if Esc or another tool comes first (the session holds what was armed).
    const settled = session.surfaceSettledAt(e.clientX, e.clientY)
    const planned = plannedPlacingRef.current
    if (planned) {
      if (settled) commitPlanned(session, e.clientX, e.clientY)
      else
        void session.placeWhenSurfaceKnown(e.clientX, e.clientY, () => clickPlanned(session, planned, e.clientX, e.clientY)).then((click) => {
          if (!click) return
          if (plannedPlacingRef.current === planned) showPlannedClick(click)
          else if (click.refused) toast.error(click.refused)
        })
      return
    }
    if (tool === 'place') {
      const place = () => {
        const hint = session.previewPlacement(e.clientX, e.clientY)
        return { hint, refused: session.commitPlacement() }
      }
      if (settled) {
        const { hint, refused } = place()
        setToolHint(refused ?? hint)
        return
      }
      void session.placeWhenSurfaceKnown(e.clientX, e.clientY, place).then((click) => {
        if (!click) return
        if (toolRef.current === tool) setToolHint(click.refused ?? click.hint)
        else if (click.refused) toast.error(click.refused)
      })
      return
    }
    if (tool === 'route' && inheritArmed) {
      setInheritArmed(false)
      const pick = session.inheritAt(e.clientX, e.clientY)
      if (typeof pick === 'string') setToolHint(pick)
      else applyInheritRef.current(pick)
      return
    }
    if (tool === 'route' && offsetArmed) {
      setOffsetArmed(false)
      void session.offsetAround(e.clientX, e.clientY).then((hint) => {
        setToolHint(hint)
        setRoutePoints(session.routePointCount())
      })
      return
    }
    if (tool === 'route') {
      const { clientX, clientY } = e
      void routeSteps(async () => {
        if (!session.surfaceSettledAt(clientX, clientY)) {
          await session.settleSurfaceAt(clientX, clientY)
          if (toolRef.current !== 'route') return
        }
        setToolHint(session.clickRoute(clientX, clientY))
        setRoutePoints(session.routePointCount())
      })
      return
    }
    if (tool === 'split') {
      setToolHint(session.clickSplit(e.clientX, e.clientY))
      return
    }
    if (tool === 'measure') {
      setToolHint(session.measureAt(e.clientX, e.clientY, session.levels()[0]?.elevationMm ?? 0))
      return
    }
    void session.selectAt(e.clientX, e.clientY).then((hit) => {
      if (completedClick) orbitPointClicked(hit)
    })
  }, [arbiter, tool, boxFilter, offsetArmed, inheritArmed, orbitClicks, orbitPointClicked, commitPlanned, showPlannedClick, routeSteps])

  const finishDrag = useCallback((commit: boolean) => {
    const current = dragRef.current
    if (!current) return
    dragRef.current = null
    if (arbiter.active()?.kind === 'slide') arbiter.cancel()
    setDragHint(null)
    sessionRef.current?.endSlide(current.drag, commit ? current.s : null)
  }, [arbiter])

  /** Pointercancel or a lost capture mid-edit: drop the gesture; nothing is saved. */
  const cancelGesture = useCallback(() => {
    const session = sessionRef.current
    arbiter.cancel()
    downAt.current = null
    if (dragRef.current) finishDrag(false)
    if (runDragRef.current) {
      runDragRef.current = false
      setToolHint(session?.endRunDrag(false) ?? null)
    }
    if (movingRef.current) {
      movingRef.current = false
      session?.endMove(false)
    }
    if (boxRef.current) {
      boxRef.current = null
      setBoxDrag(null)
    }
    routeDragRef.current = null
  }, [arbiter, finishDrag])

  // A wheel zoom or an orbit moves what is under a still pointer: re-run the live preview there, once per frame.
  useEffect(() => {
    if (!viewer) return
    let frame: number | null = null
    const refresh = () => {
      frame = null
      const session = sessionRef.current
      const p = lastPointer.current
      if (!session || !p) return
      const moved = arbiter.active()?.moved ?? false
      if (runDragRef.current) {
        if (moved) setToolHint(session.previewRunDrag(p.x, p.y, p.shift, p.alt))
      } else if (movingRef.current) {
        setToolHint(session.previewMove(p.x, p.y))
      } else if (toolRef.current === 'route') {
        if (routeResult.mayRefresh(p)) setToolHint(session.previewRoute(p.x, p.y))
      } else if (plannedPlacingRef.current) {
        setToolHint(previewPlanned(session, p.x, p.y))
      } else if (toolRef.current === 'place') {
        setToolHint(session.previewPlacement(p.x, p.y))
      }
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(refresh)
    }
    const off = viewer.onCameraChange(schedule)
    // A linked model's surface under a still pointer came back: the ghost moves onto it.
    const offSurface = viewer.onSurfaceHit(schedule)
    return () => {
      off()
      offSurface()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [viewer, arbiter, previewPlanned, routeResult])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current
    if (!session || e.button !== 0 || movingOriginRef.current) return
    routeResult.release()
    arbiter.attach(session.viewer ?? null)
    // One owner per press, decided here: tool > grab > click > camera (input/gesture-arbiter.ts).
    const took: { route?: { readonly started: boolean; readonly hint: string }; move?: string; grab?: string; slide?: SlideDrag } = {}
    const emptyDrag = emptyDragFor(e.pointerType, session.viewer?.getMode() ?? null)
    const gesture = arbiter.press(e.pointerId, e.clientX, e.clientY, { tool: plannedPlacingRef.current ? 'place' : tool, shiftKey: e.shiftKey, offsetArmed: offsetArmed || inheritArmed, emptyDrag }, {
      box: () => true,
      'route-stroke': () => (took.route = session.beginRouteDragAt(e.clientX, e.clientY) ?? undefined) !== undefined,
      move: () => (took.move = session.beginMoveAt(e.clientX, e.clientY) ?? undefined) !== undefined,
      'run-drag': () => (took.grab = session.beginRunDragAt(e.clientX, e.clientY) ?? undefined) !== undefined,
      'move-selection': () => (took.grab = session.beginSelectionDragAt(e.clientX, e.clientY) ?? undefined) !== undefined,
      slide: () => (took.slide = session.beginSlideAt(e.clientX, e.clientY) ?? undefined) !== undefined,
    })
    if (!gesture) return
    downAt.current = { x: e.clientX, y: e.clientY }
    orbitClicks.press(e.clientX, e.clientY)
    setGrabHandle(null)
    if (gesture.owner !== 'click') e.currentTarget.setPointerCapture(e.pointerId)
    switch (gesture.kind) {
      case 'box': {
        if (tool !== 'select') session.clearHover()
        const r = e.currentTarget.getBoundingClientRect()
        boxRef.current = { start: { x: e.clientX, y: e.clientY }, end: { x: e.clientX, y: e.clientY }, origin: { x: r.left, y: r.top } }
        setBoxDrag(boxRef.current)
        return
      }
      case 'route-stroke':
        if (!took.route) return
        routeDragRef.current = { x: e.clientX, y: e.clientY, started: took.route.started }
        setToolHint(took.route.hint)
        setRoutePoints(session.routePointCount())
        return
      case 'move':
        movingRef.current = true
        setToolHint(`Moving ${took.move}. Release to save, Esc to cancel.`)
        return
      case 'run-drag':
      case 'move-selection':
        // A straight piece, an end or an elbow of a routed run (what it meets follows), or the whole selection pressed on.
        runDragRef.current = true
        setToolHint(took.grab ?? null)
        return
      case 'slide': {
        const drag = took.slide
        if (!drag) return
        dragRef.current = { drag, s: null }
        setDragHint('Slide along the trunk. Release to save, Esc to cancel.')
        // The quick check only sees new ductwork; if a wall or roof is actually in front, this was not a grab.
        void session.selectAt(e.clientX, e.clientY).then((pick) => {
          if (pick?.source !== 'native' && dragRef.current?.drag === drag) finishDrag(false)
        })
        return
      }
      case 'click':
        return
    }
  }, [arbiter, finishDrag, tool, offsetArmed, inheritArmed, orbitClicks, routeResult])

  const chooseTool = useCallback((next: BuildingModelTool) => {
    const session = sessionRef.current
    arbiter.cancel()
    if (plannedPlacingRef.current) {
      plannedPlacingRef.current = null
      setPlannedPlacing(null)
    }
    if (movingRef.current) {
      movingRef.current = false
      session?.endMove(false)
    }
    session?.armPlacement(null)
    session?.resetMeasure()
    if (next !== 'route') session?.armRoute(null)
    session?.armSplit(next === 'split')
    session?.clearHover()
    setOffsetArmed(false)
    setAxisBadge(null)
    setRoutePoints(0)
    setTool(next)
    setToolHint(
      next === 'place'
        ? 'Choose a part on the left, then click in the view to place it.'
        : next === 'route'
          ? 'Click a connector, a run, or a point to start the route.'
          : next === 'move'
          ? 'Click a part and drag it to move it. Esc to stop.'
          : next === 'measure'
            ? 'Click two points to measure between them.'
            : next === 'box'
              ? 'Drag a box: left to right picks what is fully inside, right to left what it touches. Esc to stop.'
              : next === 'split'
                ? 'Click on a straight duct or pipe where it should be split. Esc to stop.'
                : null,
    )
    if (next !== 'place') {
      setPlaceType(null)
      placeHeightTyped.current = null
    }
  }, [arbiter])

  const levels = useMemo(() => (live && model ? live.levels() : []), [live, model])
  const firmLibrary = useFirmPartLibrary(tool === 'place' || partEditor !== null)
  const catalog = useMemo(() => {
    if (!live || !model || tool !== 'place') return []
    const own = live.partCatalog()
    const seen = new Set(own.map((e) => e.typeId))
    return [...own, ...firmLibrary.entries.filter((e) => !seen.has(e.typeId))]
  }, [live, model, tool, firmLibrary.entries])
  const [systemsSelector] = useState(createSystemsSelector)
  const systemRecords = useModelSelector(modelStore, systemsSelector, shallowArrayEqual)
  const [catalogSelector] = useState(createCatalogSelector)
  const catalogRecordsNow = useModelSelector(modelStore, catalogSelector, shallowArrayEqual)
  const pipeTypes = useRoutePipeTypes(tool === 'route', catalogRecordsNow, currentModel)
  const systems = useMemo<ExistingSystem[]>(
    () => (tool === 'route' ? systemRecords.flatMap((el) => (el.kind === 'mep_system' ? [{ id: el.id, name: el.name, kind: el.systemKind, domain: el.domain, ...(el.design ? { design: el.design } : {}) }] : [])) : []),
    [systemRecords, tool],
  )
  const routeSizeOrReason = useMemo(() => routeSize(routeChoices), [routeChoices])
  // In a saved view, new work goes on the view's own model level unless you pick another (a view opened on a sheet too).
  const sheetOpenedView = model && sheetModelView ? model.elements[sheetModelView] : undefined
  const levelView = openView ?? (sheetOpenedView?.kind === 'view' && !sheetOpenedView.deleted ? sheetOpenedView : null)
  const viewLevelId = model && levelView ? (viewModelLevel(model, levelView.props?.level, levelView.props?.levelElevationMm)?.id ?? null) : null
  const activeLevel =
    placeLevel && levels.some((l) => l.id === placeLevel) ? placeLevel : viewLevelId && levels.some((l) => l.id === viewLevelId) ? viewLevelId : (levels[0]?.id ?? null)
  const workingAngle = useWorkingAngle({
    viewer,
    model,
    currentModel,
    openView,
    applyFrame: useCallback((frame: WorkFrame | null) => {
      sessionRef.current?.setWorkFrame(frame)
    }, []),
    workPlaneMm: levels.find((l) => l.id === activeLevel)?.elevationMm ?? site.basePoint.z,
    drawingShown: showDrawing,
    submit: submitWithUndo,
    alignCropToEdge: crop3d.alignToEdge,
    onHint: setToolHint,
  })

  const routeKindKnown = systems.some((sys) => sys.id === routeChoices.system) || SYSTEM_KINDS.some((k) => `new:${k}` === routeChoices.system)
  const editPaused = sessionChrome.editPaused
  // Every view answers why a tool can't act: the 3D model, a live plan, a printed drawing and a sheet.
  const modelToolsOff = showDrawing && !liveViewOnDrawing && sheetModelView === null
  const sheetLabel = openSheet?.number ?? null
  const architectLevelsAvailable = canEdit && references.length > 0
  const blocker = useMemo(
    () =>
      toolBlocker({
        tool,
        canEdit,
        blockedReason,
        editPaused,
        levelCount: levels.length,
        partChosen: placeType !== null || plannedPlacing !== null,
        routeSizeProblem: typeof routeSizeOrReason === 'string' ? routeSizeOrReason : null,
        routeSystemKnown: routeKindKnown,
        modelToolsOff,
        sheetLabel,
        architectLevelsAvailable,
      }),
    [tool, canEdit, blockedReason, levels.length, placeType, plannedPlacing, routeSizeOrReason, routeKindKnown, editPaused, modelToolsOff, sheetLabel, architectLevelsAvailable],
  )

  // Keep the armed placement in step with the panel's choices.
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    if (plannedPlacing) {
      // On a printed drawing the drawing's own layer shows the outline and takes the click.
      if (showDrawing) {
        session.armPlacement(null)
        return
      }
      const refused = armPlanned(session, plannedPlacing)
      if (refused) stopPlannedPlacing(refused)
      return
    }
    const heightFt = Number(placeHeightFt)
    // On a printed drawing a new part is placed by the drawing's own layer too.
    if (showDrawing || tool !== 'place' || !placeType || !activeLevel || !Number.isFinite(heightFt)) {
      session.armPlacement(null)
      return
    }
    session.armPlacement({ typeId: placeType.typeId, definition: placeType.definition, inModel: placeType.inModel, levelId: activeLevel, heightMm: heightFt * MM_PER_FT, rotationDeg: 0 })
  }, [tool, placeType, activeLevel, placeHeightFt, plannedPlacing, showDrawing, stopPlannedPlacing])

  // Not placed yet › Place: in the view you are on, never another.
  const openKind = open.kind
  const openModelMode = open.kind === 'model' ? open.mode : undefined
  const sheetEditView = useMemo(() => (sheetModelView ? (index?.views.find((v) => v.id === sheetModelView) ?? null) : null), [sheetModelView, index])
  const placeSurface = useMemo(
    () =>
      placeSurfaceNow({
        openKind,
        modelMode: openModelMode,
        view: openView ? { name: openView.name, viewType: openView.viewType } : null,
        showDrawing,
        sheetLabel: openSheet?.number ?? null,
        sheetView: sheetEditView ? { name: sheetEditView.name, viewType: sheetEditView.viewType } : null,
      }),
    [openKind, openModelMode, openView, showDrawing, openSheet, sheetEditView],
  )
  /** A part from the list, or a new part from Place part, placed on the printed drawing: the drawing's own layer takes the click (the 3D ghost stays off). */
  const drawingPlacing = useMemo(
    () => drawingPlacingNow({ surface: placeSurface, planned: plannedPlacing, tool, newPart: placeType, heightMm: Number(placeHeightFt) * MM_PER_FT }),
    [placeSurface, plannedPlacing, tool, placeType, placeHeightFt],
  )
  const placingNewOnDrawing = drawingPlacing?.kind === 'new'
  const startPlannedPlacement = useCallback(
    (partId: string) => {
      const now = currentModel()
      if (!now) return
      if (!placeSurface.canPlace) {
        setToolHint(placeSurface.reason)
        return
      }
      const next = plannedPlacingFor(now, partId, planOpen ? viewLevelId : null, activeLevel)
      if (typeof next === 'string') {
        setToolHint(next)
        toast.error(next)
        return
      }
      chooseTool('select')
      plannedPlacingRef.current = next
      setPlannedPlacing(next)
      setToolHint(`Click in ${placeSurface.label} to place ${next.label}. R turns it, Esc stops.`)
    },
    [currentModel, placeSurface, planOpen, viewLevelId, activeLevel, chooseTool],
  )
  // Moving to a view that can't take it, or someone else placing it, ends the placement.
  const plannedPartSelector = useMemo(() => selectElement(plannedPlacing?.partId ?? null), [plannedPlacing?.partId])
  const plannedPart = useModelSelector(modelStore, plannedPartSelector)
  useEffect(() => {
    if (!plannedPlacing) return
    const el = plannedPart ?? undefined
    if (!placeSurface.canPlace) stopPlannedPlacing(`Stopped placing ${plannedPlacing.label}: ${placeSurface.reason ?? 'this view cannot take parts.'}`)
    else if (model && el?.kind !== 'part') stopPlannedPlacing(`${plannedPlacing.label} is no longer in the model.`)
    else if (el?.kind === 'part' && el.planned === undefined) stopPlannedPlacing(`${plannedPlacing.label} is placed.`)
  }, [plannedPlacing, placeSurface, model, plannedPart, stopPlannedPlacing])
  const notPlacedDisciplines = useMemo(() => (notPlacedFor ? disciplinesForTab(notPlacedFor) : undefined), [notPlacedFor])
  const plannedCountsByTab = useModelSelector(modelStore, selectPlannedCounts, sameCounts)

  // Plan › Spaces: spaces and zones typed, made from the architect's rooms, or traced over a PDF.
  const spacesLevelEl = viewLevelId && model ? model.elements[viewLevelId] : undefined
  const spacesLevelName = spacesLevelEl?.kind === 'level' ? spacesLevelEl.name : null
  const spacesLevelId = spacesLevelEl?.kind === 'level' ? spacesLevelEl.id : null
  const spacesTool = useSpacesTool({ projectId, model, levelId: spacesLevelId, levelName: spacesLevelName, submit: submitWithUndo, planCentre: { x: 0, y: 0 }, currentModel })
  const spaceLoads = useCallback(
    (spaceId: ElementId) => {
      const now = currentModel()
      return now ? loadsLayer.spaceLoads(now, spaceId) : null
    },
    [currentModel, loadsLayer],
  )
  /** Tracing happens on the plan's drawing (over its PDF): a plan shown as the live model switches to its drawing, and no other tool keeps the clicks. */
  const { onDrawSpace: armDrawSpace, onRedrawSpace: armRedrawSpace, drawing: spacesDrawing } = spacesTool.panel
  const traceOnDrawing = useCallback(
    (arm: () => void) => {
      if (planOpen) setViewDisplay('drawing')
      chooseTool('select')
      arm()
    },
    [planOpen, chooseTool],
  )
  const drawSpace = useCallback(() => traceOnDrawing(armDrawSpace), [traceOnDrawing, armDrawSpace])
  const redrawSpace = useCallback((spaceId: ElementId) => traceOnDrawing(() => armRedrawSpace(spaceId)), [traceOnDrawing, armRedrawSpace])
  // Rooms from walls work on the plan's drawing like Draw space; each opens Spaces so the room it makes is in view.
  const { onRoomFromWalls: armRoomFromWalls, onSeparationLine: armSeparationLine, propose: spacesPropose } = spacesTool.panel
  const roomFromWalls = useCallback(() => {
    setSpacesOpen(true)
    traceOnDrawing(armRoomFromWalls)
  }, [traceOnDrawing, armRoomFromWalls])
  const separationLine = useCallback(() => {
    setSpacesOpen(true)
    traceOnDrawing(armSeparationLine)
  }, [traceOnDrawing, armSeparationLine])
  const findRoomsFromWalls = useCallback(() => {
    setSpacesOpen(true)
    spacesPropose.startFromWalls()
  }, [spacesPropose])
  useRoomChords({ active: canEdit && tool === 'select' && !plannedPlacing && model !== null, run: (chord) => (chord === 'room_from_walls' ? roomFromWalls() : findRoomsFromWalls()) })

  // Once a route has created the new system, later routes continue it (choosing "New …" again starts another).
  const routeSystem = routeChoices.system.startsWith('new:') && systems.some((sys) => sys.id === newSystemId) ? newSystemId : routeChoices.system
  const chooseRoute = useCallback((next: RouteChoices) => {
    if (next.system.startsWith('new:') && next.system !== routeChoices.system) setNewSystemId(newElementId('sys'))
    setRouteChoices(next)
  }, [routeChoices.system])

  /** "Route another like this": the Route tool with the piece's kind, system, size, insulation and height, on its level. */
  const routeLike = useCallback(
    (el: RunSegment | RunFitting) => {
      const next = routeChoicesLike(el, routeChoices)
      if (typeof next === 'string') {
        setToolHint(next)
        return
      }
      chooseTool('route')
      chooseRoute(next)
      setPlaceLevel(el.levelId)
      const view = sessionRef.current?.currentView()
      const label = view ? runLabel(view.elements, el) : 'piece'
      setToolHint(`Routing another like the ${label}: same size, insulation and system, at ${feetInches(Number(next.elevationFt) * MM_PER_FT)}. Click where it starts.`)
    },
    [routeChoices, chooseTool, chooseRoute],
  )
  // Inherit: the clicked piece's height there, and its size, system and slope (a part: its connector's height).
  const applyInherit = useCallback((pick: InheritPick) => {
    const base = pick.element ? routeChoicesLike(pick.element, routeChoices) : routeChoices
    if (typeof base === 'string') {
      setToolHint(base)
      return
    }
    const slope = pick.slopeInPerFt !== undefined ? slopeChoiceOf(pick.slopeInPerFt) : ''
    chooseRoute({ ...base, elevationFt: String(Math.round((pick.elevationMm / MM_PER_FT) * 10000) / 10000), ...(slope ? { slopeInPerFt: slope } : {}) })
    setPlaceLevel(pick.levelId)
    setToolHint(`Inherited from the ${pick.label}: ${feetInches(pick.elevationMm)}${pick.element ? ', its size and system' : ''}${slope ? ` and ${slope}" per ft` : ''}. Click where the route starts.`)
  }, [routeChoices, chooseRoute])
  useEffect(() => {
    applyInheritRef.current = applyInherit
  }, [applyInherit])
  const placeLikePart = useCallback(
    (part: PartInstance): string | null => {
      const entry = sessionRef.current?.partCatalog().find((e) => e.typeId === part.typeId)
      if (!entry) return "That part's type isn't in the parts list. Reload the page and try again."
      setPlaceType(entry)
      placeHeightTyped.current = { forCategory: entry.definition.category }
      setPlaceHeightFt(String(Math.round((part.offsetMm / MM_PER_FT) * 100) / 100))
      setPlaceLevel(part.levelId)
      chooseTool('place')
      setToolHint(`Placing another ${entry.definition.typeName} at ${feetInches(part.offsetMm)} on its level. Click where it goes; R or Space rotates, Esc stops.`)
      return null
    },
    [chooseTool],
  )
  const createSimilar = useCreateSimilar({
    active: canEdit && tool === 'select' && !showDrawing,
    selected: selection?.kind === 'authored' ? selection.element : null,
    routeLike,
    placeLike: placeLikePart,
    onHint: setToolHint,
  })

  // Keep the armed route in step with the panel's choices.
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    const elevationFt = Number(routeChoices.elevationFt)
    if (tool !== 'route' || !activeLevel || typeof routeSizeOrReason === 'string' || !Number.isFinite(elevationFt)) {
      session.armRoute(null)
      return
    }
    const existing = systems.find((sys) => sys.id === routeSystem)
    const newKind = routeSystem.startsWith('new:') ? routeSystem.slice(4) : null
    const kind = existing?.kind ?? SYSTEM_KINDS.find((k) => k === newKind) ?? null
    if (!kind) {
      session.armRoute(null)
      return
    }
    const insulation = routeInsulationChoice(routeChoices)
    const hint = session.armRoute({
      domain: routeChoices.kind,
      levelId: activeLevel,
      elevationMm: elevationFt * MM_PER_FT,
      size: routeSizeOrReason,
      system: existing ? { id: existing.id, kind } : { id: newSystemId, kind, name: routeChoices.systemName.trim() || proposedSystemName(kind, systems) },
      riseStyle: routeChoices.riseStyle,
      fittings: routeFittings(routeChoices, pipeTypes),
      ...(insulation !== undefined ? { insulation } : {}),
      ...routeSlope(routeChoices, kind),
      ...(routeChoices.lastStretchFlex ? { lastStretchFlex: true } : {}),
    })
    const pending = pendingRouteStart.current
    if (pending) {
      pendingRouteStart.current = null
      setToolHint(session.startRouteOn(pending.elementId, pending.port))
      setRoutePoints(session.routePointCount())
      return
    }
    const face = pendingFaceStart.current
    if (face) {
      pendingFaceStart.current = null
      setToolHint(session.startBranchFromFace(face))
      setRoutePoints(session.routePointCount())
      return
    }
    const onSide = pendingSideStart.current
    if (onSide) {
      pendingSideStart.current = null
      setToolHint(session.startBranchOnSide(onSide.elementId, onSide.s))
      setRoutePoints(session.routePointCount())
      return
    }
    if (hint) setToolHint(hint)
  }, [tool, activeLevel, routeChoices, routeSystem, routeSizeOrReason, systems, newSystemId, pipeTypes])

  // Whether the camera is still easing (a wheel zoom, an orbit), on the canvas as data-camera for people's tools and tests.
  const [cameraStill, setCameraStill] = useState(true)
  useEffect(() => {
    if (!viewer) return undefined
    const offMove = viewer.onCameraChange(() => setCameraStill(false))
    const offStill = viewer.onCameraSettled(() => setCameraStill(true))
    return () => {
      offMove()
      offStill()
    }
  }, [viewer])

  // The live plan's "+" grip goes on the one selected element, else the hovered one, as on plan drawings.
  const [hoverIds, setHoverIds] = useState<readonly string[] | null>(null)
  useEffect(() => sessionRef.current?.onHoverChange(setHoverIds), [viewer])

  // The "+" buttons follow the selected piece and the camera.
  useEffect(() => {
    const session = sessionRef.current
    if (!session || tool !== 'select' || showDrawing || selection?.kind !== 'authored') {
      setPlusHandles([])
      setFaceHandles([])
      return
    }
    setPlusHandles(session.plusHandles())
    setFaceHandles(session.faceHandles())
    let frame = 0
    const off = viewer?.onCameraChange(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setPlusHandles(sessionRef.current?.plusHandles() ?? [])
        setFaceHandles(sessionRef.current?.faceHandles() ?? [])
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      off?.()
    }
  }, [selection, selectionModel, viewer, tool, showDrawing, canEdit])

  const pickPlus = useCallback(
    (h: Pick<PlusHandle, 'kind' | 'elementId' | 'port' | 'face' | 's'>) => {
      const session = sessionRef.current
      if (!session) return
      if (h.kind === 'side') {
        const el = session.element(h.elementId)
        if (el?.kind !== 'run_segment' || h.s === undefined) return
        pendingSideStart.current = { elementId: h.elementId, s: h.s }
        routeLike(el)
        return
      }
      let open: { elementId: string; port: string } = { elementId: h.elementId, port: h.port }
      if (h.kind === 'tee') {
        const made = session.teeAtElbow(h.elementId, h.port, h.face)
        if ('refused' in made) {
          toast.error(made.refused)
          setToolHint(made.refused)
          return
        }
        if ('joined' in made) {
          setToolHint(made.hint)
          return
        }
        open = made.open
      }
      const el = session.element(open.elementId)
      if (el?.kind !== 'run_segment' && el?.kind !== 'run_fitting') return
      pendingRouteStart.current = open
      routeLike(el)
    },
    [routeLike],
  )

  const pickFace = useCallback(
    (h: FaceHandle) => {
      const el = sessionRef.current?.element(h.elementId)
      if (el?.kind !== 'run_segment') return
      pendingFaceStart.current = h
      routeLike(el)
    },
    [routeLike],
  )

  const requestDelete = useCallback((id: string) => {
    const session = sessionRef.current
    const el = session?.element(id)
    const now = currentModel()
    if (!session || !el || !now) return
    setPendingDelete({ ids: [id], title: describeElement(now, el), plan: session.planDelete([id]) })
  }, [currentModel])

  const requestGroupDelete = useCallback((ids: readonly string[]) => {
    const session = sessionRef.current
    if (!session || ids.length === 0) return
    if (ids.length > 500) {
      toast.error(`That is ${ids.length} elements; delete at most 500 at once. Select a branch or a smaller box.`)
      return
    }
    setPendingDelete({ ids: [...ids], title: `these ${ids.length} elements`, plan: session.planDelete(ids) })
  }, [])

  const confirmDelete = useCallback((policy: 'refuse' | 'disconnect' | 'cascade') => {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    const refused = sessionRef.current?.deleteElements(target.ids, policy) ?? null
    if (refused) toast.error(refused)
  }, [pendingDelete])

  const runUndo = useCallback((direction: 'undo' | 'redo') => {
    const session = sessionRef.current
    if (!session) return
    const refused = direction === 'undo' ? session.undo() : session.redo()
    if (refused) toast.error(refused)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingInField(e.target)) {
        // Esc in a tool's own field (Route's width) leaves the field; the next Esc stops the tool. Drawings do this in their own layer.
        const field = showDrawing ? null : escapeLeavesField(e, tool !== 'select' || plannedPlacingRef.current !== null)
        if (field) {
          field.blur()
          setToolHint(leftFieldHint(plannedPlacingRef.current ? 'place' : tool))
        }
        return
      }
      const session = sessionRef.current
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
        e.preventDefault()
        runUndo(e.key === 'y' || e.shiftKey ? 'redo' : 'undo')
        return
      }
      const toDelete = deleteKeyTarget(e.key, selection, e.defaultPrevented)
      if (toDelete) {
        e.preventDefault()
        if (toDelete.kind === 'group') requestGroupDelete(toDelete.ids)
        else requestDelete(toDelete.id)
        return
      }
      // Drawings handle their own Tab, Escape and drafting keys (`ModelDrawingLayer`, `DrawingCanvas`).
      if (showDrawing) return
      if (tool === 'select' && session && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ids = selection?.kind === 'group' ? selection.ids : selection?.kind === 'authored' ? [selection.element.id] : []
        if (ids.length > 0 && isNudgeKey(e.key)) {
          e.preventDefault()
          setToolHint(session.nudgeSelection(ids, e.key, e.shiftKey))
          return
        }
        if ((e.key === 'a' || e.key === 'A') && canEdit && selection?.kind === 'authored' && (selection.element.kind === 'run_segment' || selection.element.kind === 'run_fitting')) {
          e.preventDefault()
          routeLike(selection.element)
          return
        }
      }
      if (e.key === 'Tab' && tool === 'select' && session?.hovering()) {
        e.preventDefault()
        setToolHint(session.tabCycle(e.shiftKey ? -1 : 1))
        return
      }
      // Holding Alt (Option) draws the next leg at any angle; letting go snaps again.
      if (tool === 'route' && e.key === 'Alt' && session && session.axisLockState() !== 'free') {
        e.preventDefault()
        altLockRef.current = session.axisLockState()
        session.setAxisLock('free')
        setAxisLockState('free')
        setToolHint(axisLockHint('free'))
        return
      }
      if (tool === 'route' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'x' || key === 'y' || key === 'z') {
          e.preventDefault()
          if (session) {
            session.setAxisLock(key)
            setAxisLockState(session.axisLockState())
            setToolHint(axisLockHint(session.axisLockState()))
          }
          return
        }
        if (key === 'shift') session?.setShiftHeld(true)
        if (key === ']' || key === '[') {
          e.preventDefault()
          const ft = Number(routeChoices.elevationFt)
          if (Number.isFinite(ft)) chooseRoute({ ...routeChoices, elevationFt: String(Math.round((ft + (key === ']' ? 1 : -1)) * 100) / 100) })
          return
        }
        if (key === 'o') {
          e.preventDefault()
          setOffsetArmed(true)
          setToolHint('Click the beam, pipe or wall in the way of the leg you are drawing.')
          return
        }
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const key = e.key.toLowerCase()
        const next: BuildingModelTool | null = key === 'p' ? 'place' : key === 'd' ? 'route' : key === 'm' ? 'move' : key === 't' ? 'measure' : key === 'b' ? 'box' : key === 's' ? 'split' : null
        if (next && (next === 'measure' || next === 'box' || canEdit)) {
          e.preventDefault()
          chooseTool(next)
          return
        }
        if (key === 'f') {
          e.preventDefault()
          void session?.viewer?.frame().catch((err: unknown) => console.error('[BuildingModelSurface] fit failed', err))
          return
        }
        if (key === PROJECTION_SHORTCUT) {
          e.preventDefault()
          toggleProjectionRef.current()
          return
        }
      }
      // R or Space (as in Revit) turns what is being placed; Space on the Move tool turns the selected part.
      const turnKey = isTurnKey(e)
      if (turnKey && plannedPlacingRef.current) {
        e.preventDefault()
        setPlannedPlacing((p) => (p ? { ...p, rotationDeg: (p.rotationDeg + 90) % 360 } : p))
        return
      }
      if (turnKey && tool === 'place') {
        e.preventDefault()
        session?.rotatePlacement(90)
        return
      }
      if (e.key === ' ' && turnKey && tool === 'move' && session && selection?.kind === 'authored' && selection.element.kind === 'part') {
        e.preventDefault()
        const refused = session.rotatePart(selection.element.id, 90)
        setToolHint(refused ?? 'Turned it 90°. Space again to keep turning; Undo takes it back.')
        return
      }
      if (isPlaneLockKey(e) && session && (tool === 'place' || tool === 'route')) {
        e.preventDefault()
        setToolHint(session.togglePlaneLock())
        return
      }
      if (e.key === 'Enter' && tool === 'route') {
        e.preventDefault()
        finishRouteAfterClicks()
        return
      }
      // Sheets and detail drawings handle their own Escape; the section tool cancels itself.
      if (e.key !== 'Escape' || showDrawing || drawingSection) return
      arbiter.cancel()
      if (plannedPlacingRef.current) {
        stopPlannedPlacing(`Stopped placing ${plannedPlacingRef.current.label}; nothing changed.`)
        return
      }
      if (session?.cancelNudge()) setToolHint('Nudge dropped; nothing was saved.')
      else if (dragRef.current) finishDrag(false)
      else if (runDragRef.current) {
        runDragRef.current = false
        setToolHint(session?.endRunDrag(false) ?? null)
      } else if (boxRef.current) {
        boxRef.current = null
        setBoxDrag(null)
      } else if (tool === 'route' && inheritArmed) {
        setInheritArmed(false)
        setToolHint('Inherit cancelled; the route choices are unchanged.')
      } else if (tool === 'route' && offsetArmed) {
        setOffsetArmed(false)
        setToolHint('Offset cancelled.')
      } else if (tool === 'route' && session?.cancelRoute()) {
        setRoutePoints(0)
        setToolHint('Route cancelled; nothing was saved. Click to start another, or Esc again to stop routing.')
      } else if (movingRef.current) {
        movingRef.current = false
        session?.endMove(false)
        setToolHint('Move cancelled. Click a part and drag it to move it.')
      } else if (tool !== 'select') chooseTool('select')
      else void session?.clearSelection()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') sessionRef.current?.setShiftHeld(false)
      const before = altLockRef.current
      if (e.key === 'Alt' && before !== null) {
        altLockRef.current = null
        const s = sessionRef.current
        if (s && s.axisLockState() === 'free') {
          s.setAxisLock(before === 'auto' ? 'free' : before)
          setAxisLockState(s.axisLockState())
          setToolHint(axisLockHint(s.axisLockState()))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [arbiter, finishDrag, tool, selection, chooseTool, requestDelete, requestGroupDelete, runUndo, showDrawing, drawingSection, canEdit, routeChoices, chooseRoute, offsetArmed, inheritArmed, routeLike, stopPlannedPlacing, finishRouteAfterClicks])
  const createView = useCallback(
    async (viewType: Exclude<CreatableViewType, 'section'>, input: { name: string; level: string | null; scale: number }): Promise<string | null> => {
      const viewer = sessionRef.current?.viewer
      if (viewType === 'three_d') {
        // What you are looking at now: this camera and projection, and the crop box that is cropping it (else the whole model).
        const camera = viewer?.camera3dState() ?? undefined
        const extent = (await viewer?.sceneExtentMm()) ?? undefined
        const box = crop3dRef.current.active && crop3dRef.current.on ? crop3dRef.current.box : null
        const id = newId('view')
        const refusal = submitWithUndo(
          { type: 'create_3d_view', viewId: id, name: input.name, projection, ...(camera ? { camera } : {}), ...(box ? { cropBox: box } : extent ? { extent } : {}) },
          `create ${input.name}`,
        )
        if (!refusal) openItem({ kind: 'view', id })
        return refusal
      }
      // A level that already has a plan: the same crop, so a ceiling plan lines up with its floor plan on sheets.
      // Otherwise the new work and a few metres around it, so the view fits a sheet at its scale.
      const shown = currentModel()
      const crop = viewType === 'detail' ? undefined : ((shown ? matchingPlanCrop(shown, viewType, input.level) : null) ?? (await viewer?.workRectMm(3)) ?? undefined)
      const levelElevationMm = input.level ? await elevationOf(input.level) : undefined
      const id = newId('view')
      const refusal = submitWithUndo(
        {
          type: 'create_view',
          viewId: id,
          name: input.name,
          viewType,
          ...(crop ? { crop } : {}),
          props: {
            scale: input.scale,
            ...(input.level ? { level: input.level } : {}),
            ...(levelElevationMm !== undefined ? { levelElevationMm } : {}),
          },
        },
        `create ${input.name}`,
      )
      if (refusal) return refusal
      // A new plan opens as the printed drawing (Show › Live model to edit in the model); remembered like a pick.
      const display = newViewDisplay(viewType)
      if (display === 'drawing') viewDisplayPrefs.remember(id, display)
      openItem({ kind: 'view', id }, display)
      return null
    },
    [elevationOf, submitWithUndo, openItem, projection, currentModel, viewDisplayPrefs],
  )

  const createSection = useCallback(
    (cut: SectionCut, name: string): string | null => {
      const plan = openView
      const id = newId('view')
      const props = plan?.props ?? {}
      const refusal = submitWithUndo(
        {
          type: 'create_view',
          viewId: id,
          name,
          viewType: 'section',
          props: {
            section: cut,
            scale: props.scale ?? 48,
            ...(props.level ? { level: props.level } : {}),
            ...(props.levelElevationMm !== undefined ? { levelElevationMm: props.levelElevationMm } : levelElevations[props.level ?? ''] !== undefined ? { levelElevationMm: levelElevations[props.level ?? ''] } : {}),
          },
        },
        `create ${name}`,
      )
      if (!refusal) {
        setSectionTool(false)
        toast(`${name} created. It's in the panel under Sections; click its cut line to open it.`)
      }
      return refusal
    },
    [openView, submitWithUndo, levelElevations],
  )

  /** The orientation controls' "elevation from here": a section just outside the model on the camera's side, looking across all of it. */
  const createElevation = useCallback(
    async (side: 'north' | 'south' | 'east' | 'west') => {
      const rect = await sessionRef.current?.viewer?.sceneRectMm()
      if (!rect) {
        toast.error('There is nothing in the model to make an elevation of yet. Link a model or draw something first.')
        return
      }
      const title = `${side.charAt(0).toUpperCase()}${side.slice(1)} elevation`
      const taken = new Set((index?.views ?? []).map((v) => v.name.toLowerCase()))
      let name = title
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${title} ${n}`
      const id = newId('view')
      const refusal = submitWithUndo({ type: 'create_view', viewId: id, name, viewType: 'section', props: { section: elevationCut(side, rect), scale: 48 } }, `create ${name}`)
      if (refusal) toast.error(refusal)
      else {
        openItem({ kind: 'view', id })
        toast(`${name} created. It's in the panel under Sections.`)
      }
    },
    [index, submitWithUndo, openItem],
  )

  // The properties panel covers the canvas's right side: a framed plan keeps its crop box clear of it.
  const propertiesRef = useRef<HTMLElement | null>(null)
  // Properties is as wide as this person dragged it (or a strip when collapsed); the canvas and hint line keep clear of it.
  const [propertiesWidth, setPropertiesWidth] = useState(PROPERTIES_DEFAULT_WIDTH_PX)
  useLayoutEffect(() => {
    viewer?.setFrameInsets({ left: 0, top: 0, bottom: 0, right: propertiesOpen ? propertiesWidth : 0 })
  }, [viewer, propertiesOpen, propertiesWidth])

  const waitForSaved = useCallback((ms: number) => sessionRef.current?.waitForSaved(ms) ?? Promise.resolve(false), [])
  const setSaveState = useMemo(() => ({ pending: save.pending, waitForSaved }), [save.pending, waitForSaved])

  const openPrint = useCallback(() => {
    const session = sessionRef.current
    const now = currentModel()
    if (!session || !openSheet || !now) return
    const depends = sheetDependsOn(now, openSheet.id)
    setPrinting({ savedRevision: session.confirmedModel()?.revision ?? 0, pendingOnSheet: session.pendingChanges().filter((c) => depends(c.id, c.element)).length })
  }, [openSheet, currentModel])

  const print = useCallback(
    async (choice: PrintChoice): Promise<string | null> => {
      const session = sessionRef.current
      if (!session || !openSheet) return 'Open a sheet to print it.'
      if (choice === 'wait' && !(await session.waitForSaved(30_000))) {
        return "Your edits still aren't saved after 30 seconds. Print the last saved revision, or try again once the status says All changes saved."
      }
      const saved = session.confirmedModel()
      if (!saved) return "The model isn't loaded yet. Try again in a moment."
      if (saved.elements[openSheet.id]?.kind !== 'sheet') return "This sheet isn't saved yet. Wait for it to save, then print."
      try {
        const printed = await printSheetPdf(saved, openSheet.id, sheetTitle, backgrounds, sheetImages.source)
        toast.success(`Printed ${openSheet.number} from Rev ${printed.revision} (${printed.fileName})`)
        return null
      } catch (err) {
        console.error('[BuildingModelSurface] printing the sheet failed', { sheetId: openSheet.id, err })
        return err instanceof Error ? `The PDF couldn't be drawn: ${err.message}` : "The PDF couldn't be drawn. Try again."
      }
    },
    [openSheet, sheetTitle, backgrounds, sheetImages.source],
  )

  const others = [...people.entries()].filter(([, p]) => p.actor.id !== userId)
  const currentReferences = referenceList ?? config?.references ?? []
  // The linked models as reference geometry: Wall, Draw space, Route, Place and Dimension snap to their walls; Find rooms uses them.
  useLinkedReferenceLoader({ port: host.data.coordination, projectId, modelId: authorityModelId ?? model?.modelId ?? null, model, linkedKey: currentReferences.map((r) => `${r.id}:${r.url}`).join('|') })
  const fixtureReferences = currentReferences.filter((r) => r.source === 'fixture')
  const editBlocked = canEdit ? null : blockedReason
  useEffect(() => {
    movingOriginRef.current = movingOrigin && canEdit
  }, [movingOrigin, canEdit])
  /** Start dragging the origin: the marker moves the project base point when it shows the fixed internal origin. */
  const startOriginMove = () => {
    if (editBlocked) {
      toast.error(editBlocked)
      return
    }
    setOriginPoint((p) => movableOriginPoint(p))
    setShowOrigin(true)
    setPickingNorth(false)
    setMovingOrigin(true)
  }
  const saveLabel: SaveLabel = save.retrying > 0 || save.message ? 'not_saved' : save.pending > 0 ? 'saving' : 'saved'
  const sectionsOnPlan = useMemo(
    () => (planOpen && openView ? (index?.views ?? []).filter((v) => v.viewType === 'section' && (v.props?.level ?? null) === (openView.props?.level ?? null)) : []),
    [planOpen, openView, index],
  )
  const backSheet = returnSheet && open.kind === 'view' ? (index?.sheets.find((s) => s.id === returnSheet) ?? null) : null
  const openTitle =
    open.kind === 'model' ? (open.mode === 'plan' ? 'Top-down plan' : '3D model') : openSheet ? `${openSheet.number} · ${openSheet.title}` : openView ? `${openView.name} · ${VIEW_TYPE_LABEL[openView.viewType]}` : ''

  useEffect(() => {
    viewerColorsRef.current = mutinyTheme.viewer
    sessionRef.current?.setViewerColors(mutinyTheme.viewer)
  }, [mutinyTheme.viewer])

  const useHostFileChrome = host.shell.useFileChrome ?? useNoFileChrome
  const chrome = useHostFileChrome()
  // Full screen shows only the BIM root, so the host's header (where the status would portal) is off screen.
  const hosted = chrome !== null && !fullscreen
  const HostHeaderTrailing = chrome?.HeaderTrailing ?? null
  const standaloneHref = `/mutinybim/${projectId}?view=${open.kind === 'model' && open.mode === 'plan' ? 'plan' : '3d'}`
  const setHostTitle = chrome?.setTitle
  useEffect(() => {
    setHostTitle?.(openTitle || null)
  }, [setHostTitle, openTitle])
  useEffect(() => {
    if (!setHostTitle) return
    return () => setHostTitle(null)
  }, [setHostTitle])

  /** Model editing on plan, section and elevation drawings: the same session, selection and commands as the 3D view. */
  /** What takes plan clicks before selection now (a previewed room's parts), so the drawing can show the hand over it. */
  const clickClaimerRef = useRef<ClickClaimer | null>(null)
  const modelEdit = useMemo<ModelEditBridge | null>(
    () =>
      live
        ? {
            canEdit,
            blockedReason,
            tool,
            selectedIds,
            hover: (id) => sessionRef.current?.hoverElement(id) ?? null,
            highlighted: () => sessionRef.current?.highlightedIds() ?? null,
            clickPlaces: () => clickPlaces(clickClaimerRef.current, sessionRef.current?.highlightedIds() ?? null),
            tab: (direction) => sessionRef.current?.tabCycle(direction) ?? null,
            select: (id) => {
              const session = sessionRef.current
              if (!session) return
              void session.selectElement(id).catch((err: unknown) => console.error('[BuildingModelSurface] selecting in the drawing failed', { id, err }))
            },
            claimEmptyClick: () => sessionRef.current?.takeEmptyClick() ?? false,
            selectBox: (ids, mode) => {
              const session = sessionRef.current
              if (!session) return "The model isn't open yet."
              const categories = new Set((Object.keys(boxFilter) as BoxCategory[]).filter((c) => boxFilter[c]))
              void session
                .selectBoxIds(ids, mode, categories)
                .then(setToolHint)
                .catch((err: unknown) => console.error('[BuildingModelSurface] box select in the drawing failed', err))
              return `${ids.length} in the box.`
            },
            moveBy: (ids, delta) => sessionRef.current?.moveGroupBy(ids, { x: delta.x, y: delta.y }, delta.z) ?? "Live editing isn't connected, so nothing can be moved.",
            submit: submitWithUndo,
            runDrag: {
              begin: (id, at) => sessionRef.current?.beginRunDragOn(id, at) ?? null,
              preview: (delta, strict) => sessionRef.current?.previewRunDragBy(delta, strict) ?? "Live editing isn't connected, so the duct can't be changed.",
              previewModel: () => sessionRef.current?.runDragPreview() ?? null,
              end: (commit) => sessionRef.current?.endRunDrag(commit) ?? null,
              toLength: (mm) => sessionRef.current?.runDragToLength(mm) ?? null,
            },
            tools: {
              previewSplit: (id, at) => sessionRef.current?.previewSplitOn(id, at) ?? "Live editing isn't connected.",
              split: (id, at) => sessionRef.current?.splitOn(id, at) ?? "Live editing isn't connected, so nothing can be split.",
              previewRoute: (p, vertical, end, side) => sessionRef.current?.previewRouteOnDrawing(p, vertical, end, side) ?? null,
              clickRoute: (p, vertical, end, side) => {
                const hint = sessionRef.current?.clickRouteOnDrawing(p, vertical, end, side) ?? "Live editing isn't connected, so nothing can be routed."
                setRoutePoints(sessionRef.current?.routePointCount() ?? 0)
                return hint
              },
              finishRoute: () => {
                const hint = sessionRef.current?.finishRoute() ?? null
                setRoutePoints(sessionRef.current?.routePointCount() ?? 0)
                return hint
              },
              cancelRoute: () => {
                const had = sessionRef.current?.cancelRoute() ?? false
                setRoutePoints(0)
                return had
              },
              routeLastPoint: () => sessionRef.current?.routeLastPoint() ?? null,
              routePreviewModel: () => sessionRef.current?.routePreviewModel() ?? null,
              routeTicks: () => sessionRef.current?.routeTicks() ?? [],
            },
            hint: setToolHint,
            stopTool: () => chooseTool('select'),
            plus: pickPlus,
            serverFeatures: sessionRef.current?.serverFeatures() ?? [],
          }
        : null,
    [live, canEdit, blockedReason, tool, selectedIds, boxFilter, submitWithUndo, chooseTool, pickPlus],
  )

  const groupSelection = selection?.kind === 'group' ? selection : null
  const groupTotals = useMemo(() => (groupSelection && live && selectionModel ? live.groupSummary(groupSelection.ids) : null), [groupSelection, live, selectionModel])
  const ribbonSelection: RibbonSelection = (() => {
    if (groupSelection) {
      const word = groupSelection.scope === 'box' ? 'Box selection' : groupSelection.scope === 'run' ? 'Run' : groupSelection.scope === 'branch' ? 'Branch' : 'System'
      const movable = groupSelection.ids.filter((id) => {
        const k = selectionModel?.elements[id]?.kind
        return k === 'part' || k === 'run_segment' || k === 'run_fitting' || k === 'equipment' || k === 'wall' || k === 'component'
      }).length
      return { kind: 'group', label: `${word} (${groupSelection.ids.length})`, count: groupSelection.ids.length, runs: groupTotals?.summary.segments ?? 0, movable }
    }
    if (selection?.kind !== 'authored' || !selectionModel) return null
    const el = selection.element
    const label = describeElement(selectionModel, el)
    if (el.kind === 'part' || el.kind === 'equipment') return { kind: 'part', label }
    if (el.kind === 'run_segment' || el.kind === 'run_fitting') return { kind: 'run', label, domain: 'domain' in el && el.domain === 'pipe' ? 'pipe' : 'duct', fitting: el.kind === 'run_fitting' }
    if (el.kind === 'tap' || el.kind === 'duct_segment') return { kind: 'branch', label }
    return null
  })()
  const selectedId = selection?.kind === 'authored' ? selection.element.id : null
  const liveGripId = selectedId ?? (hoverIds?.length === 1 ? (hoverIds[0] ?? null) : null)
  /** Open the plan or section being edited on the sheet by itself, for the model tools that need its live model; Back returns. */
  const openSheetModelView = (): boolean => {
    if (!sheetModelView || !openSheet) return false
    const from = openSheet.id
    openItem({ kind: 'view', id: sheetModelView })
    setViewDisplay('model')
    setReturnSheet(from)
    return true
  }
  const drawingOpen: 'sheet' | 'detail' | null = !showDrawing ? null : open.kind === 'sheet' ? 'sheet' : 'detail'
  const drawingTool: DrawingTool = drawingPick.openKey === openKey ? drawingPick.tool : 'select'
  const setDrawingTool = useCallback(
    (next: DrawingTool) => {
      if (isDetailShape(next)) setLastDetailShape(next)
      setDrawingPick({ openKey, tool: next })
      // One tool takes the clicks: a dimension or tag picked while Route is on ends the route tool.
      if (drawingToolStopsModelTool(next, tool)) chooseTool('select')
    },
    [openKey, tool, chooseTool],
  )
  const draft = useDraftController()
  const drawnSelected = drawingOpen !== null && draft.selectedIds.length > 0
  const ribbonContext = ribbonContextKey({ openKey, drawingOpen, selectedIds: selectedId ? [selectedId] : (groupSelection?.ids ?? []), drawnIds: drawnSelected ? draft.selectedIds : [], routing: tool === 'route', drawingTool })
  const ribbonMemory = useRibbonTabMemory(ribbonContext)
  const previewProposal = useCallback((ghosts: readonly ProposalGhost[] | null) => sessionRef.current?.showProposalGhosts(ghosts), [])
  const frameProposal = useCallback((points: readonly Vec2[]) => sessionRef.current?.framePlan(points), [])
  /** Route duct / Route pipe: the Route tool on that kind, keeping the system when it is already that kind. */
  const routeAs = useCallback(
    (kind: 'duct' | 'pipe') => {
      if (routeChoices.kind !== kind) {
        const existing = systems.find((sys) => sys.domain === kind)
        chooseRoute({ ...routeChoices, kind, system: existing ? existing.id : `new:${systemKindsFor(kind)[0]?.kind ?? 'other'}` })
      }
      chooseTool('route')
    },
    [routeChoices, systems, chooseRoute, chooseTool],
  )
  /** A floor or ceiling plan opened on the open sheet: plan tools take their points through the sheet. */
  const sheetPlan = showDrawing && open.kind === 'sheet' && sheetPlanPointer && sheetPlanPointer.viewId === sheetModelView ? sheetPlanPointer : null
  const sheetOpenedViewType = sheetOpenedView?.kind === 'view' ? sheetOpenedView.viewType : null
  const workflowServices: WorkflowServices = {
    planPointsOff: showDrawing && open.kind === 'sheet' ? planPointsOffOnSheet(openSheet?.number ?? 'this sheet', sheetPlan ? 'floor_plan' : sheetOpenedViewType) : null,
    projectId,
    model,
    selectedIds,
    editBlocked,
    modelToolsOff: showDrawing && !liveViewOnDrawing && sheetModelView === null,
    submit: submitWithUndo,
    placeType: (typeId) => {
      const entry = sessionRef.current?.partCatalog().find((e) => e.typeId === typeId)
      if (!entry) return "That part isn't in the catalog. Reload the page and try again."
      if (toolNeedsLiveModel('place', placeSurface) && !openSheetModelView() && liveViewOnDrawing) setViewDisplay('model')
      setPlaceType(entry)
      const next = heightAfterChoosingPart(placeHeightFt, placeHeightTyped.current, entry.definition.category)
      placeHeightTyped.current = next.typed
      setPlaceHeightFt(next.heightFt)
      chooseTool('place')
      setToolHint(`Click in the view to place ${entry.definition.familyName.toLowerCase()}. R rotates, Esc stops.`)
      return null
    },
    activeTab: ribbonMemory.picked ?? '',
    notify: (message, kind = 'info') => (kind === 'error' ? toast.error(message) : toast(message)),
    openSheetId: open.kind === 'sheet' ? open.id : null,
    onOpenSheet: (id) => openItem({ kind: 'sheet', id }),
    newScheduleRequested: request?.kind === 'new_schedule',
    onNewScheduleClosed: () => setRequest(null),
    openNewSchedule: (pick) => {
      setSchedulePick(pick)
      setListScheduleFor('mechanical_equipment')
    },
    openDiagram,
    choosePlace: () => chooseTool('place'),
    routeAs,
    previewParts: previewProposal,
    subscribeHover: (listener) => sessionRef.current?.onHoverChange(listener) ?? (() => undefined),
    setClickHandler: (claimer) => {
      clickClaimerRef.current = claimer
      const unregister = sessionRef.current?.setClickHandler(claimer) ?? (() => undefined)
      return () => {
        if (clickClaimerRef.current === claimer) clickClaimerRef.current = null
        unregister()
      }
    },
    framePlan: frameProposal,
    levelId: activeLevel || null,
    requestLevel: () => setLevelRequest('add'),
    serverFeatures: sessionRef.current?.serverFeatures(),
    select: (ids) => {
      const session = sessionRef.current
      if (!session || ids.length === 0) return
      const first = ids[0] ?? ''
      void (ids.length === 1 ? session.selectElement(first) : session.selectGroup('box', ids, null)).catch((err: unknown) => console.error('[BuildingModelSurface] selecting a finding failed', { ids, err }))
    },
    pickPartAt: (x, y) => sessionRef.current?.partIdAt(x, y) ?? null,
    pickPlanPointAt: (x, y) => {
      if (sheetPlan) return sheetPlan.toPlan(x, y)
      if (showDrawing) return null
      const session = sessionRef.current
      const levels = session?.levels() ?? []
      const level = levels.find((l) => l.id === activeLevel) ?? levels[0]
      return session?.viewer?.planPointAt(x, y, level?.elevationMm ?? 0) ?? null
    },
    planPointOnScreen: (p) => {
      if (sheetPlan) {
        // Overlays sit in the canvas's own box, over the sheet.
        const at = sheetPlan.toClient(p)
        const host = canvasRef.current?.parentElement?.getBoundingClientRect()
        return at && host ? { x: at.x - host.left, y: at.y - host.top } : null
      }
      // A drawing is showing (the 3D canvas is hidden): only a plan opened on a sheet has points on screen.
      if (showDrawing) return null
      const session = sessionRef.current
      const levels = session?.levels() ?? []
      const level = levels.find((l) => l.id === activeLevel) ?? levels[0]
      return session?.viewer?.canvasPointOf(p.x, p.y, level?.elevationMm ?? 0) ?? null
    },
    ...(liveViewOnDrawing
      ? {
          showLiveModel: () => {
            if (!openSheetModelView()) setViewDisplay('model')
          },
        }
      : {}),
    propertiesOpen,
  }
  const addons = useModelSelector(modelStore, selectAddons)
  const workflows = useAddonWorkflows(workflowServices, addons, modelStore)

  // Model in place: the next click in a plan, the 3D model or a plan opened on a sheet says where; Esc cancels.
  const inPlacePoint = useRef(workflowServices.pickPlanPointAt)
  useLayoutEffect(() => {
    inPlacePoint.current = workflowServices.pickPlanPointAt
  })
  const inPlaceLevel = levels.find((l) => l.id === activeLevel) ?? null
  useEffect(() => {
    if (!inPlacePick) return undefined
    const session = sessionRef.current
    if (!session || !inPlaceLevel) {
      setInPlacePick(false)
      toast.error(inPlaceLevel ? "The model isn't open yet." : 'Add a level first: Model in place puts the part on a level.')
      return undefined
    }
    const pointer = { x: Number.NaN, y: Number.NaN }
    const move = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setInPlacePick(false)
      setToolHint('Model in place cancelled.')
    }
    const claimer: ClickHandler = {
      claims: () => true,
      click: () => {
        const at = inPlacePoint.current(pointer.x, pointer.y)
        if (!at) {
          toast(`Click inside a plan or the 3D model on ${inPlaceLevel.name}. Esc cancels.`)
          return true
        }
        setInPlacePick(false)
        setToolHint(null)
        setPartEditor({ definition: null, spot: { levelId: inPlaceLevel.id, levelName: inPlaceLevel.name, at } })
        return true
      },
    }
    setToolHint(`Click where the new part goes on ${inPlaceLevel.name}. Esc cancels.`)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', move, true)
    window.addEventListener('keydown', key, true)
    clickClaimerRef.current = claimer
    const unregister = session.setClickHandler(claimer)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', move, true)
      window.removeEventListener('keydown', key, true)
      if (clickClaimerRef.current === claimer) clickClaimerRef.current = null
      unregister()
    }
  }, [inPlacePick, inPlaceLevel])

  const autoTab = autoRibbonTab({ routing: tool === 'route', drawingOpen, drawingTool, drawnSelected, modelSelected: ribbonSelection !== null, selectionTab: workflows.autoTab ?? null, scheduleOpen: openView?.viewType === 'schedule' })

  /** The selected placed part's type, when it was drawn in the part editor (catalog parts have no shape to edit). */
  const selectedPartType = (() => {
    if (selection?.kind !== 'authored' || selection.element.kind !== 'part' || !live) return null
    const type = live.element(selection.element.typeId)
    return type?.kind === 'part_type' ? type.definition : null
  })()
  const editPartBlocked = !canEdit
    ? blockedReason
    : selection?.kind !== 'authored' || selection.element.kind !== 'part'
      ? 'Select a placed part to edit its type, or open Place part and press the pencil beside one.'
      : !selectedPartType?.model
        ? 'This part comes from the starter catalog and has no drawn shape to edit. Use New part to draw one.'
        : null
  const editSelectedPart = () => {
    if (editPartBlocked === null && selectedPartType) setPartEditor({ definition: selectedPartType })
  }

  /** Tag all untagged in the open plan or section: the same deterministic placement agents preview, as one undoable edit. */
  const tagAllView = drawingOpen === 'detail' && openView && TAGGABLE_VIEW_TYPES.has(openView.viewType) ? openView : null
  const tagAll = tagAllView
    ? {
        disabledReason: editBlocked,
        run: () => {
          const now = currentModel()
          if (!now) return
          const plan = planAutoTags(now, tagAllView.id, { categories: [...AUTO_TAG_CATEGORIES], idPrefix: newId('tag') })
          if (plan.items.length === 0) {
            toast(plan.alreadyTagged > 0 ? 'Everything in this view is already tagged.' : 'Nothing in this view to tag.')
            return
          }
          const n = plan.items.length
          const refusal = submitWithUndo(
            { type: 'batch_documents', label: `Tag ${n} element${n === 1 ? '' : 's'}`, commands: plan.items.slice(0, 500).map((it) => ({ type: 'add_drawing_item' as const, itemId: it.itemId, ownerId: tagAllView.id, shape: 'tag' as const, points: [it.at], tag: it.tag })) },
            `tag ${n} element${n === 1 ? '' : 's'}`,
          )
          if (refusal) toast.error(refusal)
          else if (plan.skipped.length > 0) toast(`${plan.skipped.length} couldn't be tagged: no clear spot beside them. Tag those by hand.`)
        },
      }
    : null

  /** Views › Schedules › Load schedules: each opens the model's own, or says why it can't be made yet. */
  // Checking a definition opens it (every row), so that runs on the click, not on every edit.
  const loadScheduleLists = LOAD_SCHEDULE_IDS.map((id) => ({
    id,
    label: BUILTIN_LIST_LABELS[id],
    description: BUILTIN_LIST_DESCRIPTIONS[id],
    blocked: !model ? 'The model is still loading.' : findBuiltinListView(model, id) ? null : editBlocked,
  }))
  /** Open the model's Equipment list (or Not placed yet, Loads) schedule, making it the first time. */
  const openBuiltinList = (id: BuiltinListId) => {
    const now = currentModel()
    if (!now) return
    const existing = findBuiltinListView(now, id)
    const viewId = existing ?? newId('view')
    if (!existing) {
      const refusal = submitWithUndo(builtinListCommand(now, viewId, BUILTIN_LIST_LABELS[id], id), `make the ${BUILTIN_LIST_LABELS[id]} schedule`)
      if (refusal) {
        toast.error(`The ${BUILTIN_LIST_LABELS[id]} schedule wasn't made: ${refusal}`)
        return
      }
    }
    openItem({ kind: 'view', id: viewId })
    setViewDisplay('model')
  }

  // Copy and paste of placed parts (Ctrl+C / Ctrl+V): one clipboard for this tab, shared with every drawing.
  const partClip = useSyncExternalStore(subscribeClip, currentClip, () => null)
  const clipNow = useMemo(() => (selectionModel ? clipOf(selectionModel, selectedIds) : 'The model is still loading.'), [selectionModel, selectedIds])
  const copyBlocked = typeof clipNow === 'string' ? clipNow : null
  const partPasteBlocked = pasteBlocked(partClip, editBlocked) ?? (showDrawing ? 'On a drawing, point where the copies go and press Ctrl+V (⌘V on a Mac).' : null)
  const copyParts = useCallback(() => {
    if (typeof clipNow === 'string') {
      setToolHint(clipNow)
      toast.info(clipNow)
      return
    }
    rememberClip(clipNow)
    setToolHint(copiedHint(clipNow))
  }, [clipNow])
  const pasteParts = useCallback(() => {
    const clip = currentClip()
    const blocked = pasteBlocked(clip, editBlocked)
    if (blocked || !clip) {
      setToolHint(blocked)
      toast.error(blocked ?? 'Nothing to paste.')
      return
    }
    const level = activeLevel ? model?.elements[activeLevel] : undefined
    const pointer = lastPointer.current
    // Read the pointer on the copies' own height (a ceiling device's), so they land under it rather than where its ray meets the floor.
    const planeMm = clip.heightMm ?? (level?.kind === 'level' ? level.elevationMm : null)
    const at = pointer && planeMm !== null ? (sessionRef.current?.viewer?.planPointAt(pointer.x, pointer.y, planeMm) ?? null) : null
    const paste = pasteNear(clip, at, pasteIds())
    const refused = submitWithUndo(paste.command, paste.label)
    if (refused) toast.error(refused)
    setToolHint(refused ?? paste.hint)
  }, [editBlocked, activeLevel, model, submitWithUndo])
  // C then C copies too (Revit's CC), in every view and drawing.
  useCopyChord({ active: selectedIds.length > 0, onCopy: copyParts })
  // Drawings answer Ctrl+C / Ctrl+V themselves (where the pointer is on the paper); this is the 3D and live plan view.
  useEffect(() => {
    if (showDrawing) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || typingIn(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'c' && selectedIds.length > 0) {
        e.preventDefault()
        copyParts()
      } else if (key === 'v' && currentClip()) {
        e.preventDefault()
        pasteParts()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showDrawing, selectedIds, copyParts, pasteParts])

  const startCeilingTool = useCallback(() => traceOnDrawing(() => undefined), [traceOnDrawing])
  const ceilingTool = useCeilingTool({ model, openView, editBlocked, onStart: startCeilingTool })
  // Picking a model tool (Place part, Route…) stops whatever else holds the clicks: Draw space, the ceiling tracer, a drawing tool.
  const toolPicked = useRef(tool)
  const stopSpacesTool = spacesTool.stop
  const stopCeilingTool = ceilingTool.stop
  useEffect(() => {
    if (toolPicked.current === tool) return
    toolPicked.current = tool
    for (const other of stoppedByModelTool(tool, { spacesDrawing, ceilingTracing: ceilingTool.active, drawingTool })) {
      if (other === 'spaces') stopSpacesTool()
      else if (other === 'ceiling') stopCeilingTool()
      else setDrawingPick({ openKey, tool: 'select' })
    }
  }, [tool, spacesDrawing, ceilingTool.active, drawingTool, stopSpacesTool, stopCeilingTool, openKey])
  const ribbonInput: Parameters<typeof buildingModelRibbon>[0] = {
    addons,
    ceiling: ceilingTool.ribbon,
    clipboard: { copyBlocked, copy: copyParts, pasteBlocked: partPasteBlocked, paste: pasteParts },
    plan: {
      equipmentList: setEquipmentListFor,
      equipmentListBlocked: model ? null : 'The model is still loading.',
      notPlacedYet: { open: setNotPlacedFor, counts: plannedCountsByTab, blocked: model ? null : 'The model is still loading.' },
      spaces: { open: () => setSpacesOpen(true), blocked: model ? null : 'The model is still loading.', roomFromWalls, findFromWalls: findRoomsFromWalls, split: separationLine },
      openRail: { open: setOpenRail, blocked: model ? null : 'The model is still loading.' },
    },
    schedules: {
      views: (index?.views ?? []).filter((v) => v.viewType === 'schedule').map((v) => ({ id: v.id, name: v.name })),
      newSchedule: setListScheduleFor,
      open: (viewId) => {
        openItem({ kind: 'view', id: viewId })
        setViewDisplay('model')
      },
      openLibrary: () => {
        // A new tab keeps the model open here; say so, and offer this tab if the browser blocked it.
        const url = '/settings/mutinybim-library'
        // `noopener` would make window.open return null even when the tab opened; drop the opener by hand instead.
        const tab = window.open(url, '_blank')
        if (tab) tab.opener = null
        if (tab) toast.success('Opened Settings › MutinyBIM library in a new tab.')
        else toast.info('Your browser blocked the new tab.', { action: { label: 'Open here', onClick: () => router.push(url) } })
      },
      editBlocked: canEdit ? null : blockedReason,
      loadSchedules: {
        lists: loadScheduleLists,
        open: (id) => {
          const list = LOAD_SCHEDULE_IDS.find((l) => l === id)
          if (!list) return
          const now = currentModel()
          const problem = now && !findBuiltinListView(now, list) ? builtinListBlocked(now, list) : null
          if (problem) {
            toast.error(problem)
            return
          }
          openBuiltinList(list)
        },
      },
    },
    tool,
    chooseTool: (next) => {
      // Select, box, Split, Route and (on a printed plan or section) Place part work on the drawing itself; the other tools draw in the live model.
      if (toolNeedsLiveModel(next, placeSurface) && !openSheetModelView() && liveViewOnDrawing) setViewDisplay('model')
      chooseTool(next)
    },
    editBlocked,
    drawingOpen,
    liveViewOnDrawing: liveViewOnDrawing || sheetModelView !== null,
    showLiveModel: () => {
      if (!openSheetModelView()) setViewDisplay('model')
    },
    undoLabel: undoState.undo,
    redoLabel: undoState.redo,
    undo,
    redo: () => runUndo('redo'),
    fit: () => void viewer?.frame().catch((err: unknown) => console.error('[BuildingModelSurface] fit failed', err)),
    model3dOpen: !showDrawing && open.kind === 'model' && open.mode === '3d',
    roofOff: sectionOn,
    setRoofOff: setSectionOn,
    showStats,
    setShowStats,
    projection: live3dOpen ? { value: projection, toggle: toggleProjection } : null,
    drawingTool,
    drawingTools,
    setDrawingTool,
    lastDetailShape,
    draft,
    tagAll,
    request: onPanelRequest,
    sectionDrawing: drawingSection,
    toggleSection: () => (drawingSection ? setSectionTool(false) : startSection()),
    planOpen,
    openModel: (mode) => openItem({ kind: 'model', mode }),
    crop:
      openView && openView.viewType !== 'detail'
        ? {
            on: openView.props?.cropView !== false,
            shown: openView.props?.showCropBox !== false,
            set: (change) => {
              const refusal = submitWithUndo({ type: 'set_view_crop', viewId: openView.id, ...change }, change.cropView === undefined ? (change.showCropBox ? 'show the crop box' : 'hide the crop box') : change.cropView ? 'crop the view' : 'stop cropping the view')
              if (refusal) toast.error(refusal)
            },
          }
        : null,
    crop3d: crop3d.active
      ? {
          on: crop3d.on,
          shown: crop3d.shown,
          set: crop3d.set,
          toSelection: () => void crop3d.toSelection(),
          reset: () => void crop3d.reset(),
          selectionBlocked: crop3d.selectionBlocked,
          alignToWorkingAngle: () => {
            const refusal = crop3d.alignToWorkingAngle()
            if (refusal) toast(refusal)
          },
          alignToEdge: () => workingAngle.startPick({ kind: 'crop', label: openView?.name ?? 'the 3D view' }),
          alignBlocked: crop3d.alignBlocked,
        }
      : null,
    sheet: openSheet
      ? {
          number: openSheet.number,
          editTitleBlock: () => setRequest({ kind: 'edit_sheet', sheet: openSheet }),
          print: openPrint,
          arrange: () => setRequest({ kind: 'arrange_sheet', sheet: openSheet }),
          revisions: () => setRequest({ kind: 'sheet_revisions', sheet: openSheet }),
          chart: () => setFigureDialog('chart'),
          picture: () => setFigureDialog('picture'),
          calculation: () => setCalcDialog(true),
          loadSummary: () => {
            const placed = placeLoadSummary(openSheet, submitWithUndo)
            if ('refusal' in placed) toast.error(placed.refusal)
            else setPlacedFigure({ id: placed.itemId })
          },
          placeTable: (place) => {
            const placed = place(openSheet, submitWithUndo, spacesLevelId)
            if ('refusal' in placed) toast.error(placed.refusal)
            else setPlacedFigure({ id: placed.itemId })
          },
        }
      : null,
    hasSheets: (index?.sheets.length ?? 0) > 0,
    printBlackOnly,
    setPrintBlackOnly: (on) => {
      const err = submit({ type: 'set_print_black_only', blackOnly: on }, on ? 'Print sheets black only' : 'Print sheets in colour')
      if (err) toast.error(err)
    },
    canLink,
    openLink: () => setLinkOpen(true),
    linkDescription: linkDescription(linkSources),
    linkUnavailableReason: linkUnavailableReason(linkSources, hostCapabilities.hostName),
    openConnectAgent: () => setConnectAgentOpen(true),
    addLevel: () => setLevelRequest('add'),
    addMountingPlane: () => setPlaneDialogOpen(true),
    useArchitectLevels: () => setLevelRequest('architect'),
    showLevels,
    setShowLevels,
    parts: {
      newPart: () => setPartEditor({ definition: null }),
      newBlocked: canEdit ? null : blockedReason,
      modelInPlace: () => {
        chooseTool('select')
        setInPlacePick(true)
      },
      editSelected: editSelectedPart,
      editBlocked: editPartBlocked,
    },
    selection: ribbonSelection,
    rotateSelected: (deg) => {
      const refused = selectedId ? sessionRef.current?.rotatePart(selectedId, deg) : null
      if (refused) toast.error(refused)
    },
    editType: () => setEditTypeRequest((n) => n + 1),
    createSimilar,
    resizeSelected: () => document.getElementById(ribbonSelection?.kind === 'group' ? 'bm-group-size' : ribbonSelection?.kind === 'run' ? 'bm-run-a' : 'bm-w')?.focus(),
    chooseFittingType: () => {
      const picker = document.getElementById('bm-fitting-type')
      if (picker) {
        picker.scrollIntoView({ block: 'nearest' })
        picker.focus()
        return
      }
      toast.info(document.querySelector('[data-testid="run-pressure-unavailable"]')?.textContent || "This fitting's type can't be chosen until it is on a duct system with a fan.")
    },
    reducerShape: () => {
      const transition = document.getElementById('bm-group-transition')
      if (transition) {
        transition.scrollIntoView({ block: 'nearest' })
        transition.focus()
      } else if (ribbonSelection?.kind === 'run' && ribbonSelection.fitting) {
        document.getElementById('bm-fitting-type')?.focus()
      } else {
        setToolHint('Press Tab until the whole run is selected, then pick a reducer shape under "Transitions where it meets another size".')
      }
    },
    focusRunInsulation: () => {
      const insulation = document.getElementById('bm-run-insulation')
      if (!insulation) {
        toast.info('Insulation is set on routed duct. Select a duct piece to set its wrap or liner.')
        return
      }
      insulation.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      insulation.querySelector<HTMLElement>('button')?.focus()
    },
    viewGraphics: openView
      ? {
          lines: () => focusViewSection('view-lines'),
          range: openView.viewType === 'floor_plan' || openView.viewType === 'ceiling_plan' ? () => focusViewSection('view-range') : null,
          linked: references.length > 0 && openView.viewType !== 'detail' ? () => focusViewSection('view-linked-models') : null,
        }
      : null,
    showPressure: () => {
      const section = document.querySelector('[data-testid="run-pressure"], [data-testid="run-pressure-unavailable"]')
      if (section) section.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      else toast.info("No pressure to show: this piece isn't on a duct system with a fan yet.")
    },
    deleteSelected: () => (groupSelection ? requestGroupDelete(groupSelection.ids) : selectedId && requestDelete(selectedId)),
    clearSelection: () => void sessionRef.current?.clearSelection(),
    splitSelected: () => chooseTool(tool === 'split' ? 'select' : 'split'),
    moveSelected: () => document.getElementById('bm-group-dx')?.focus(),
    boxFilter,
    toggleBoxFilter: (c) => setBoxFilter((prev) => ({ ...prev, [c]: !prev[c] })),
    coordination: { open: () => setCoordinationOpen(true) },
    history: {
      openVersions: () => setHistoryDialog('versions'),
      openResponsibilities: () => setHistoryDialog('responsibilities'),
      ...(syncChannel ? { openCopies: () => setHistoryDialog('copies') } : {}),
      openChangeOrders: () => setHistoryDialog('change_orders'),
    },
    organization: {
      openGroups: () => setOrganizationDialog('groups'),
      openPhases: () => setOrganizationDialog('phases'),
      openFilters: () => setOrganizationDialog('filters'),
      openConstructionStages: () => setOrganizationDialog('stages'),
      openAddons: () => setOrganizationDialog('addons'),
      openCodes: () => setOrganizationDialog('codes'),
      openTagStyles: () => setTagStylesOpen({ styleId: null, sampleElementId: null }),
    },
    route:
      tool === 'route'
        ? {
            riseStyle: routeChoices.riseStyle,
            setRiseStyle: (style) => chooseRoute({ ...routeChoices, riseStyle: style }),
            rise: (ft) => {
              const now = Number(routeChoices.elevationFt)
              if (Number.isFinite(now)) chooseRoute({ ...routeChoices, elevationFt: String(Math.round((now + ft) * 100) / 100) })
            },
            lock: axisLock,
            setLock: (lock) => {
              const session = sessionRef.current
              if (!session) return
              session.setAxisLock(lock)
              setAxisLockState(session.axisLockState())
              setToolHint(axisLockHint(session.axisLockState()))
            },
            chooseElbow: () => document.getElementById('bm-route-elbow')?.focus(),
            chooseTakeoff: () => document.getElementById('bm-route-takeoff')?.focus(),
            offsetArmed,
            armOffset: () => {
              setOffsetArmed((on) => !on)
              setToolHint(offsetArmed ? 'Offset cancelled.' : 'Click the beam, pipe or wall in the way of the leg you are drawing.')
            },
            finish: finishRouteAfterClicks,
            cancel: () => {
              sessionRef.current?.cancelRoute()
              setRoutePoints(0)
              setToolHint('Route cancelled; nothing was saved.')
            },
            finishBlocked: routePoints === 0 ? 'Click where the route starts first.' : null,
            riseBlocked: routePoints === 0 ? 'Click a first point along the run, then rise or drop there.' : null,
          }
        : null,
    coordinates: {
      showOrigin,
      setShowOrigin: (on) => {
        setShowOrigin(on)
        if (!on) setMovingOrigin(false)
      },
      moving: movingOrigin,
      toggleMove: () => (movingOrigin ? setMovingOrigin(false) : startOriginMove()),
      openTrueNorth: () => setCoordinatesOpen('north'),
      openWorkingAngle: () => setCoordinatesOpen('working_angle'),
      openOrigin: () => {
        setOriginPoint('project_base_point')
        setShowOrigin(true)
        setCoordinatesOpen('origin')
      },
      alignAxes: () => {
        workingAngle.startPick(planOpen && openView && openView.props?.workingAngleDeg !== undefined ? { kind: 'view', viewId: openView.id, viewName: openView.name } : { kind: 'model' })
      },
      aligningAxes: workingAngle.picking !== null && workingAngle.picking.kind !== 'crop',
      openSurveyPoint: () => {
        setOriginPoint('survey_point')
        setShowOrigin(true)
        setCoordinatesOpen('site_point')
      },
      orientation:
        planOpen && openView
          ? {
              value: openView.props?.orientation ?? 'plan_north',
              set: (value) => {
                const refusal = submitWithUndo({ type: 'set_view_properties', viewId: openView.id, props: { orientation: value } }, value === 'true_north' ? 'turn the plan to true north' : value === 'working_angle' ? 'turn the plan to the working angle' : 'turn the plan to plan north')
                if (refusal) toast.error(refusal)
              },
            }
          : null,
    },
    addonInputs: workflows.ribbonInputs,
    routeAs,
    routeKind: routeChoices.kind,
  }
  const ribbonTabs = useStableRibbonTabs(buildingModelRibbon(ribbonInput))
  const ribbonQuick = useStableCommands(buildingModelQuickCommands({ undoLabel: undoState.undo, redoLabel: undoState.redo, undo, redo: () => runUndo('redo'), editBlocked }))
  const ribbonTrailingId = useId()
  const onRibbonTab = ribbonMemory.pick
  const ribbonTab = ribbonMemory.picked !== null && ribbonTabs.some((t) => t.id === ribbonMemory.picked) ? ribbonMemory.picked : autoTab
  const loadsListMissing = model ? findBuiltinListView(model, 'loads') === null : true
  const selectFromBreakdown = (ids: readonly ElementId[], label: string) => {
    const session = sessionRef.current
    const first = ids[0]
    if (!session || !first) {
      toast.error(`Couldn't select ${label}: live editing isn't connected.`)
      return
    }
    void (ids.length === 1 ? session.selectElement(first) : session.selectGroup('box', ids, null)).catch((err: unknown) => {
      console.error('[BuildingModelSurface] selecting from the Loads breakdown failed', { ids, err })
      toast.error(`Couldn't select ${label}. It may have nothing drawn yet; find it in the Loads list.`)
    })
  }
  const headerStatus = (
    <div className="flex items-center gap-2">
      {others.length > 0 && (
        <div className="flex -space-x-2" aria-label={`${others.length} other ${others.length === 1 ? 'person' : 'people'} here`}>
          {others.slice(0, 5).map(([id, p]) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Avatar size="sm" className="ring-2 ring-background">
                  <AvatarFallback>{initials(p.actor.name)}</AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>{p.activity.kind === 'dragging_tap' ? `${p.actor.name} is moving a branch` : p.activity.kind === 'editing_note' ? `${p.actor.name} is editing a note` : `${p.actor.name} is here`}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
      {open.kind === 'sheet' && openSheet ? (
        <ModelFromStore store={modelStore}>
          {(shown) => (shown ? <SheetFreshness projectId={projectId} modelId={config?.authority?.modelId ?? shown.modelId} sheetNumber={openSheet.number} revision={shown.revision} /> : null)}
        </ModelFromStore>
      ) : null}
      <ModelFromStore store={modelStore}>
        {(shown) => {
          const loadsChip = shown ? loadsLayer.chipLine(shown, ribbonTab) : null
          return loadsChip && shown ? (
            <LoadsBreakdownPopover
              chip={loadsChip}
              breakdown={() => loadsBreakdown(shown, loadsLayer.advanceNoted(shown))}
              onSelect={selectFromBreakdown}
              openListBlocked={loadsListMissing && editBlocked ? `it can't be made yet: ${editBlocked}` : null}
              onOpenList={() => openBuiltinList('loads')}
            />
          ) : null
        }}
      </ModelFromStore>
      <ConnectionStatusChip status={status} save={save} problem={problem} editPaused={editPaused} onRetry={() => live?.retry()} />
      {presentation === 'embedded' ? <MutinyMark className="hidden lg:inline-flex" /> : null}
      <WindowControls
        fullscreenTarget={bimRoot}
        newWindowHref={presentation === 'embedded' ? standaloneHref : undefined}
        newWindowName={`mutinybim-${projectId}`}
        onProblem={(message) => toast.error(message)}
      />
    </div>
  )

  const selectSpace = (id: ElementId) => void live?.selectElement(id).catch((err: unknown) => console.error('[BuildingModelSurface] selecting the space failed', err))
  const rail = useStableHandlers<SurfaceRailProps>({
    store: modelStore,
    onOpenChecklist: () => setCoordinationOpen(true),
    projectId,
    userId,
    loadError,
    canEdit,
    blockedReason,
    open,
    onOpen: openItem,
    onRequest: onPanelRequest,
    spaces: spacesOpen
      ? {
          levelId: spacesLevelId,
          levelName: spacesLevelName,
          submit: submitWithUndo,
          ...spacesTool.panel,
          onDrawSpace: drawSpace,
          onRedrawSpace: redrawSpace,
          onRoomFromWalls: roomFromWalls,
          onSeparationLine: separationLine,
          onSelectSpace: selectSpace,
          onSelectElements: (ids: readonly ElementId[]) => selectFromBreakdown(ids, ids.length === 1 ? 'that' : 'those'),
          onUndo: undo,
          loads: spaceLoads,
          onClose: () => {
            spacesTool.stop()
            setSpacesOpen(false)
          },
        }
      : null,
    addonRail: openRail
      ? {
          id: openRail,
          props: {
            levelId: spacesLevelId,
            levelName: spacesLevelName,
            onSelectSpace: selectSpace,
            onOpenSpaces: () => setSpacesOpen(true),
            onClose: () => setOpenRail(null),
            projectId,
          },
        }
      : null,
    notPlaced:
      notPlacedFor !== null
        ? {
            circuitRules: sharedValue<ListProps['circuitRules']>(workflows.shared, 'circuitRules'),
            disciplines: notPlacedDisciplines,
            surface: placeSurface,
            placingId: plannedPlacing?.partId ?? null,
            onPlace: startPlannedPlacement,
            onStopPlacing: () => stopPlannedPlacing(plannedPlacing ? `Stopped placing ${plannedPlacing.label}; nothing changed.` : null),
            submit: submitWithUndo,
            onClose: () => {
              if (plannedPlacing) stopPlannedPlacing(`Stopped placing ${plannedPlacing.label}; nothing changed.`)
              setNotPlacedFor(null)
            },
          }
        : null,
    parts:
      tool === 'place' && (!showDrawing || placeSurface.on === 'drawing')
        ? {
            catalog,
            levels,
            selectedTypeId: placeType?.typeId ?? null,
            onSelectType: (entry) => {
              setPlaceType(entry)
              setToolHint(`Click in the view to place ${entry.definition.typeName}. R rotates, Esc stops.`)
              const next = heightAfterChoosingPart(placeHeightFt, placeHeightTyped.current, entry.definition.category)
              placeHeightTyped.current = next.typed
              setPlaceHeightFt(next.heightFt)
            },
            levelId: activeLevel,
            onLevel: setPlaceLevel,
            heightFt: placeHeightFt,
            onHeight: (value) => {
              placeHeightTyped.current = { forCategory: placeType?.definition.category ?? null }
              setPlaceHeightFt(value)
            },
            onAddLevel: (name, elevationMm) => sessionRef.current?.createLevel(name, elevationMm) ?? "Live editing isn't connected.",
            onStop: () => chooseTool('select'),
            firmLibrary: { status: firmLibrary.status, retry: () => void firmLibrary.retry() },
            onNewPart: canEdit ? () => setPartEditor({ definition: null }) : undefined,
            onUseArchitectLevels: canEdit ? () => setLevelRequest('architect') : undefined,
            onEditPart: canEdit ? (entry) => setPartEditor({ definition: entry.definition }) : undefined,
          }
        : null,
    route:
      tool === 'route'
        ? {
            choices: { ...routeChoices, system: routeSystem },
            onChange: chooseRoute,
            systems,
            levels,
            levelId: activeLevel,
            onLevel: setPlaceLevel,
            pointCount: routePoints,
            finishBlocked: routePoints === 0 ? 'Click where the route starts first.' : null,
            onFinish: finishRouteAfterClicks,
            onStop: () => chooseTool('select'),
            myDefaults: routeDefaults,
            checks: routeChecks,
            pipeTypes,
            inheritArmed,
            onAddLevel: (name, elevationMm) => sessionRef.current?.createLevel(name, elevationMm) ?? "Live editing isn't connected.",
            onUseArchitectLevels: canEdit ? () => setLevelRequest('architect') : undefined,
            onInherit: () => {
              setInheritArmed((on) => !on)
              setToolHint(inheritArmed ? 'Inherit cancelled.' : 'Click a pipe, a fitting or a part: the route takes its height there, and its size, system and slope.')
            },
          }
        : null,
    level,
    onLevel: setLevel,
    referenceLevels,
    openView,
    showDrawing,
    displayContext,
    onGroupVisibility: setGroupVisibility,
    freeDisplay,
    onFreeDisplay: (change) => setFreeDisplay((prev) => ({ ...prev, ...change })),
    onEditFilters: () => setOrganizationDialog('filters'),
    references,
    linkedDisplay,
    unplaced,
    linkOpen,
    onLinkOpenChange: setLinkOpen,
    onViewChange: refreshReferences,
    onCanEditChange: setCanLink,
    fixtureReferences,
  })

  return (
    <LayoutPrefsProviderFrom port={host.data.layoutPrefs}>
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="building-model-root"
      data-phase={loadError ? 'error' : phase ? 'loading' : 'ready'}
      data-open={open.kind === 'model' ? open.mode : `${open.kind}:${open.id}`}
    >
      {hosted && HostHeaderTrailing ? <HostHeaderTrailing>{headerStatus}</HostHeaderTrailing> : null}
      <MemoRibbon tabs={ribbonTabs} quick={ribbonQuick} value={ribbonTab} onValueChange={onRibbonTab} trailingSlotId={hosted ? undefined : ribbonTrailingId} />
      {hosted ? null : (
        <RibbonTrailing targetId={ribbonTrailingId}>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm" data-testid="open-title">
              {openTitle}
            </span>
            {headerStatus}
          </div>
        </RibbonTrailing>
      )}
      <CodeStudyModelLinkHost projectId={projectId} modelId={model?.modelId ?? null} session={live} />
      <StaleAnswerNoticesHost store={modelStore} me={questionMe} projectId={projectId} modelId={authorityModelId} />
      {showBranches ? (
        <div className="border-b border-border px-3 py-1.5" data-testid="building-model-branches">
          <ModelFromStore store={modelStore}>
            {(shown) => (
          <BranchHeader
            channel={syncChannel}
            connected={socketLive}
            canEdit={canEdit}
            revision={shown?.revision ?? null}
            versions={versionEntries}
            startFrom={startFrom}
            onPersonChose={personChose}
            trailing={
              mergeBlocked ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button size="sm" variant="outline" disabled data-testid="propose-merge-open">
                        Propose merge to Main
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{mergeBlocked}</TooltipContent>
                </Tooltip>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setHistoryDialog('propose_merge')} data-testid="propose-merge-open">
                  Propose merge to Main
                </Button>
              )
            }
          />
            )}
          </ModelFromStore>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <SurfaceRail {...rail} />

        <div className="relative min-w-0 flex-1 bg-muted/40">
          <div
            ref={canvasRef}
            data-testid="building-model-canvas"
            data-camera={cameraStill ? 'still' : 'moving'}
            className={showDrawing ? 'hidden' : 'absolute inset-0 touch-none'}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            onPointerUp={(e) => {
              onPointerUp(e)
              finishDrag(true)
            }}
            onPointerCancel={cancelGesture}
            onLostPointerCapture={() => {
              if (arbiter.editing()) cancelGesture()
            }}
            onPointerDownCapture={(e) => {
              if (panButtonOf(e.nativeEvent) === null) chordPressRef.current = false
              if (e.button === 2) rightDownAt.current = { x: e.clientX, y: e.clientY }
            }}
            onPointerMoveCapture={(e) => {
              // Left + right held together pans (the camera does it); whatever the left press started gives way, nothing is selected or moved.
              if (chordPressRef.current || panButtonOf(e.nativeEvent) !== 'chord') return
              chordPressRef.current = true
              rightDownAt.current = null
              cancelGesture()
            }}
            onPointerUpCapture={(e) => {
              if (e.button !== 2) return
              const from = rightDownAt.current
              rightDownAt.current = null
              // A right-drag or a chord pans; only a right-click opens the menu.
              if (chordPressRef.current || !from || Math.hypot(e.clientX - from.x, e.clientY - from.y) >= 4 || !crop3d.active || tool !== 'select') return
              const rect = e.currentTarget.getBoundingClientRect()
              const at = { x: e.clientX - rect.left, y: e.clientY - rect.top }
              if (selection) setContextMenu(at)
              else void sessionRef.current?.selectAt(e.clientX, e.clientY).then(() => setContextMenu(at))
            }}
            onContextMenu={(e) => e.preventDefault()}
            onDoubleClick={(e) => void orbitClicks.doubleClicked(sessionRef.current?.viewer, e.clientX, e.clientY, { tool, planOpen })}
            aria-label="3D model view. Drag to orbit; scroll or pinch to zoom toward the pointer, which then becomes the point the view orbits around. Click a spot to orbit around it; double-click empty space to go back to the middle of the model. Drag a branch takeoff to slide it, or a selection to move it."
            role="application"
            data-tool={tool}
            data-plan-up={planUpDeg}
          />
          {viewer && openView && !showDrawing && !drawingSection && openView.viewType !== 'detail' && openView.viewType !== 'three_d' && openView.props?.cropView !== false && openView.props?.showCropBox !== false && (
            <CropBoxOverlay
              key={openView.id}
              viewer={viewer}
              view={openView}
              crop={{ min: openView.cropMin, max: openView.cropMax }}
              elevationMm={openFloorMm}
              canEdit={canEdit}
              blockedReason={blockedReason}
              submit={submitWithUndo}
            />
          )}
          {viewer && model && crop3d.active && crop3d.box && crop3d.shown && !showDrawing && (
            <CropBox3dOverlay
              viewer={viewer}
              model={model}
              box={crop3d.box}
              cropOn={crop3d.on}
              extent={sceneExtent}
              canEdit
              blockedReason={blockedReason}
              onCommit={crop3d.setBox}
            />
          )}
          <SelectionContextMenu
            at={contextMenu}
            onClose={() => setContextMenu(null)}
            selectionLabel={selection?.kind === 'authored' && selectionModel ? describeElement(selectionModel, selection.element) : selection?.kind === 'group' ? `${selection.ids.length} selected` : selection?.kind === 'reference' ? selection.referenceLabel : null}
            blocked={crop3d.selectionBlocked ?? (canEdit ? null : blockedReason)}
            onCrop={() => void crop3d.toSelection()}
            onNewView={() => void crop3d.newViewOfSelection()}
            editDefinition={selection?.kind === 'authored' && selection.element.kind === 'part' ? { blocked: editPartBlocked, run: editSelectedPart } : null}
            copy={{ blocked: copyBlocked, run: copyParts }}
            paste={{ blocked: pasteBlocked(partClip, editBlocked), run: pasteParts }}
          />
          {planOpen && viewer && openView && (
            <SectionCutOverlay
              key={drawingSection ? 'drawing' : 'marks'}
              viewer={viewer}
              elevationMm={openFloorMm + (openView.props?.cutHeightMm ?? 1219.2)}
              drawing={drawingSection}
              sections={sectionsOnPlan}
              suggestedName={nextSectionName(index?.views ?? [])}
              onOpenSection={(id) => openItem({ kind: 'view', id })}
              onCreate={createSection}
              onCancel={() => setSectionTool(false)}
              onFarClip={canEdit ? (viewId, depthMm) => submitWithUndo({ type: 'set_view_crop', viewId, farClipMm: depthMm }, 'change how far the section sees') : undefined}
            />
          )}
          {viewer && model && !showDrawing && (showOrigin || pickingNorth) && (
            <ModelFromStore store={modelStore}>
              {(originModel) =>
                originModel && (
            <OriginOverlay
              viewer={viewer}
              model={originModel}
              site={site}
              which={originPoint}
              editing={movingOrigin && canEdit}
              toolArmed={tool !== 'select'}
              editBlocked={editBlocked}
              mode={originMode}
              onModeChange={setOriginMode}
              pickingNorth={pickingNorth}
              onCommit={submitWithUndo}
              onStartMove={startOriginMove}
              onOpenDialog={() => setCoordinatesOpen(tabForPoint(originPoint))}
              onHide={() => {
                setShowOrigin(false)
                setMovingOrigin(false)
              }}
              onSetTrueNorth={() => setCoordinatesOpen('north')}
              onExit={() => {
                setMovingOrigin(false)
                setPickingNorth(false)
              }}
              onHint={setToolHint}
            />
                )
              }
            </ModelFromStore>
          )}
          {pickingNorth && !showDrawing && (
            <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background/95 p-1.5 shadow-sm" data-testid="true-north-bar">
              <span className="px-1 text-xs text-muted-foreground">Set true north: click a point, then a second point toward true north.</span>
              <Button size="sm" variant="outline" onClick={() => setPickingNorth(false)}>
                Cancel (Esc)
              </Button>
            </div>
          )}
          {workingAngle.overlay}
          {coordinatesOpen && (
            <CoordinatesDialog
              site={site}
              initialTab={coordinatesOpen}
              initialMode={originMode}
              editBlocked={editBlocked}
              view={openView ? { id: openView.id, name: openView.name, isPlan: openView.viewType === 'floor_plan' || openView.viewType === 'ceiling_plan', orientation: openView.props?.orientation ?? 'plan_north', ownWorkingAngleDeg: openView.props?.workingAngleDeg } : null}
              onCancel={() => setCoordinatesOpen(null)}
              onSubmit={submitWithUndo}
              onPickTrueNorth={() => {
                setCoordinatesOpen(null)
                setPickingNorth(true)
              }}
              onPickWorkingAngle={() => {
                setCoordinatesOpen(null)
                if (showDrawing && !openSheetModelView()) setViewDisplay('model')
                workingAngle.startPick(openView && openView.props?.workingAngleDeg !== undefined ? { kind: 'view', viewId: openView.id, viewName: openView.name } : { kind: 'model' })
              }}
              onPointChange={(point) => {
                setOriginPoint(point)
                setShowOrigin(true)
              }}
            />
          )}
          {viewer && !showDrawing && !scheduleGridOpen && !planOpen && !(open.kind === 'model' && open.mode === 'plan') && !loadError && (
            <OrientationControls
              trueNorthDeg={site.trueNorthDeg}
              viewer={viewer}
              rightInset={openView || selection ? PROPERTIES_PANEL_PX : 0}
              canCreateViews={canEdit}
              blockedReason={blockedReason}
              onCreatePlan={() => setRequest({ kind: 'new_view', viewType: 'floor_plan' })}
              onCreateElevation={(side) => void createElevation(side)}
              projection={projection}
              onProjectionChange={changeProjection}
            />
          )}
          {showDrawing && open.kind === 'sheet' && openSheet && (
            <ModelFromStore store={modelStore}>
              {(shownModel) =>
                shownModel && (
                  // C10: "Code changed since this was signed", one line per signer who must act.
                  <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-center">
                    <div className="pointer-events-auto max-w-xl">
                      <SheetCodeChangeBanner projectId={projectId} modelId={config?.authority?.modelId ?? shownModel.modelId} model={shownModel} sheet={openSheet} viewerId={userId} onRecheck={() => setHistoryDialog('responsibilities')} />
                    </div>
                  </div>
                )
              }
            </ModelFromStore>
          )}
          {showDrawing && model && (open.kind === 'sheet' || openView) && (
            <ModelFromStore store={modelStore}>
              {(shownModel) =>
                shownModel && (
            <div className="absolute inset-0">
              <DrawingCanvas
                onCreateSimilar={(id) => runCreateSimilar({ selected: shownModel.elements[id] ?? null, routeLike, placeLike: placeLikePart, onHint: setToolHint })}
                key={open.kind === 'sheet' ? open.id : openView?.id}
                target={open.kind === 'sheet' ? { kind: 'sheet', sheetId: open.id } : { kind: 'detail', viewId: openView?.id ?? '' }}
                model={shownModel}
                sheetTitle={sheetTitle}
                canEdit={canEdit}
                blockedReason={blockedReason}
                submit={submitWithUndo}
                onOpenView={(id) => {
                  const from = openSheet?.id ?? null
                  openItem({ kind: 'view', id })
                  setReturnSheet(from)
                }}
                onEditSheet={openSheet ? () => setRequest({ kind: 'edit_sheet', sheet: openSheet }) : undefined}
                tool={drawingTool}
                onToolChange={setDrawingTool}
                onToolsAvailable={setDrawingTools}
                draft={draft}
                people={people}
                selfActorId={userId}
                onActivity={publishActivity}
                backgrounds={backgrounds}
                printedPreview
                sheetImages={sheetImages}
                focusItem={placedFigure}
                modelEdit={modelEdit}
                placing={drawingPlacing}
                onPlaced={() => {
                  // A new part stays armed for the next click; a part from the list is placed once.
                  if (!placingNewOnDrawing) stopPlannedPlacing(plannedPlacing ? `Placed ${plannedPlacing.label} on ${placeSurface.label}. Undo takes it back.` : null)
                }}
                onPlacingCancel={() => {
                  if (placingNewOnDrawing) chooseTool('select')
                  else stopPlannedPlacing(plannedPlacing ? `Stopped placing ${plannedPlacing.label}; nothing changed.` : null)
                }}
                spaces={{ projectId, mode: spacesTool.mode, onDrawn: spacesTool.onDrawn, onCancel: spacesTool.stop, onSeparatorLine: spacesTool.onSeparatorLine }}
                ceilings={ceilingTool.canvas}
                questions={{ onOpen: openQuestion, focusedQuestionId: questionFocus?.questionId ?? null }}
                blockFreshness={openSheet ? (itemId) => <SheetFreshness projectId={projectId} modelId={config?.authority?.modelId ?? shownModel.modelId} sheetNumber={openSheet.number} revision={shownModel.revision} blockId={itemId} /> : undefined}
                onActiveViewChange={setSheetModelView}
                onPlanPointer={setSheetPlanPointer}
                onOpenTagStyles={(styleId, sampleElementId) => setTagStylesOpen({ styleId, sampleElementId })}
                viewportProperties={(viewId) => {
                  const view = index?.views.find((v) => v.id === viewId)
                  return view ? workflows.viewProperties(view) : null
                }}
                viewProperties={
                  openView ? (
                    <ViewProperties
                      view={openView}
                      canEdit={canEdit}
                      blockedReason={blockedReason}
                      submit={submitWithUndo}
                      references={references.map((r) => ({ id: r.id, label: r.label }))}
                      display={viewDisplay}
                      onDisplay={chooseDisplay}
                      onRename={() => setRequest({ kind: 'rename_view', view: openView })}
                      background={backgroundStates[openView.id]}
                      hostLevelId={viewLevelId}
                      levelName={model ? (canonicalViewLevel(model, openView.props?.level) ?? null) : null}
                      phaseFields={viewPhaseFields(openView)}
                      schedule={workflows.viewProperties(openView)}
                      diagram={
                        openView.props?.diagram ? (
                          <ModelFromStore store={modelStore}>
                            {(shown) =>
                              shown && (
                                <DiagramProperties
                                  model={shown}
                                  view={openView}
                                  selectedIds={selectedIds}
                                  canEdit={canEdit}
                                  blockedReason={blockedReason}
                                  submit={submitWithUndo}
                                  onSelect={(id) => modelEdit?.select(id)}
                                />
                              )
                            }
                          </ModelFromStore>
                        ) : undefined
                      }
                    />
                  ) : undefined
                }
              />
            </div>
                )
              }
            </ModelFromStore>
          )}
          {scheduleGridOpen && openView && (
            // Keys typed in the grid stay in the grid: the model's shortcuts (undo, delete, tools) must not also fire.
            <div className="absolute inset-y-0 left-0 bg-background" style={{ right: besidePropertiesRight(propertiesOpen, propertiesWidth) }} onKeyDown={(e) => e.stopPropagation()} data-testid="model-schedule-pane">
              <ModelFromStore store={modelStore}>
                {(scheduleModel) => (
              <ModelSchedulePane
                projectId={projectId}
                session={live}
                branchChannel={syncChannel}
                connected={connection === 'live' || connection === 'catching_up' || connection === 'degraded'}
                view={openView}
                actor={actor}
                model={scheduleModel}
                onShowInModel={(ids) => {
                  const session = sessionRef.current
                  const first = ids[0]
                  if (!session || !first) return
                  const now = currentModel()
                  const undrawn = now ? undrawnLoadHint(now, ids) : null
                  if (undrawn) {
                    toast.info(undrawn)
                    return
                  }
                  openItem({ kind: 'model', mode: '3d' })
                  void (ids.length === 1 ? session.selectElement(first) : session.selectGroup('box', ids, null)).catch((err: unknown) => console.error('[BuildingModelSurface] showing schedule rows in the model failed', { ids, err }))
                }}
                onUndo={() => runUndo('undo')}
                onRedo={() => runUndo('redo')}
                submit={submitWithUndo}
                editBlocked={canEdit ? null : blockedReason}
                onOpenSheet={(sheetId) => openItem({ kind: 'sheet', id: sheetId })}
              />
                )}
              </ModelFromStore>
            </div>
          )}
          {phase && !loadError && (
            <div
              className={
                presentation === 'standalone'
                  ? 'pointer-events-none absolute inset-0 flex items-center justify-center bg-(--mutiny-canvas)'
                  : 'pointer-events-none absolute inset-0 flex items-center justify-center'
              }
            >
              <MutinySplash status={phase} className={presentation === 'standalone' ? undefined : 'rounded-md border bg-background/95 px-4 py-3 shadow-sm'} />
            </div>
          )}
          {loadError && (
            <div className="absolute inset-x-4 top-4">
              <Alert variant="destructive">
                <AlertTitle>The model didn&apos;t open</AlertTitle>
                <AlertDescription>{loadError} Reload the page to try again; if it keeps happening, tell the software team.</AlertDescription>
              </Alert>
            </div>
          )}
          {problem && status !== 'read_only' && status !== 'live' && !showDrawing && (
            <div className="absolute bottom-3 left-3 max-w-md" data-testid="building-model-connection-problem">
              <Alert variant={problem.kind === 'no_model' ? 'default' : 'destructive'}>
                <Wind />
                <AlertTitle>{problem.title}</AlertTitle>
                <AlertDescription>
                  <p>{problem.message}</p>
                  {problem.kind !== 'no_model' && (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => sessionRef.current?.retry()}>
                      <RefreshCw data-icon="inline-start" />
                      Try again
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            </div>
          )}
          {status === 'read_only' && !phase && !showDrawing && (
            <div className="absolute bottom-3 left-3 max-w-sm">
              <Alert>
                <Wind />
                <AlertTitle>View only</AlertTitle>
                <AlertDescription>Live editing isn&apos;t connected for this project yet, so ductwork, views and sheets can&apos;t be changed here.</AlertDescription>
              </Alert>
            </div>
          )}
          {blocker && (
            <ToolReadinessNotice
              blocker={blocker}
              onCreateLevel={(name, elevationMm) => sessionRef.current?.createLevel(name, elevationMm) ?? "Live editing isn't connected, so the level can't be saved."}
              onOpenAddLevel={() => setLevelRequest('add')}
              onRetry={() => live?.retry()}
              onUseArchitectLevels={() => setLevelRequest('architect')}
            />
          )}
          {toolHint && !dragHint && !blocker && (
            <ToolHintBar text={toolHint} tone={toolHint === refusal ? 'warning' : 'info'} style={propertiesOpen ? { right: propertiesWidth + 24 } : undefined} />
          )}
          {showDrawing && <TrackpadHint />}
          {viewer && !showDrawing && !scheduleGridOpen && <OrbitPointMarker viewer={viewer} enabled={!planOpen} />}
          {viewer && !showDrawing && !scheduleGridOpen && <ZoomThroughNotice viewer={viewer} />}
          {backSheet && !showDrawing && !drawingSection && (
            <Button size="sm" variant="secondary" className="absolute left-3 top-3 shadow-sm" onClick={() => openItem({ kind: 'sheet', id: backSheet.id })} data-testid="back-to-sheet">
              <ArrowLeft data-icon="inline-start" />
              Back to {backSheet.number}
            </Button>
          )}
          {boxDrag && <BoxOverlay drag={boxDrag} />}
          {grabHandle && tool === 'select' && !showDrawing && <RunGrabHandle handle={grabHandle} />}
          {viewer && model && livePlanOpen && tool === 'select' && canEdit && (
            // The grip reads what a source already serves and has spare: the newest model, not the chrome's.
            <ModelFromStore store={modelStore}>{(live) => live && <LivePlanConnectGrip viewer={viewer} model={live} elementId={liveGripId} submit={submitWithUndo} hint={setToolHint} />}</ModelFromStore>
          )}
          {viewer && livePlanOpen && tool === 'route' && routeTickMarks && (
            <LivePlanRouteTicks viewer={viewer} ticks={routeTickMarks.ticks} pieces={routeTickMarks.pieces} />
          )}
          {(plusHandles.length > 0 || faceHandles.length > 0) && (
            <PlusHandles handles={plusHandles} onPick={pickPlus} faceHandles={faceHandles} view={plusHandlesViewFor(faceHandles)} onPickFace={pickFace} onCancel={() => void sessionRef.current?.clearSelection().catch((err) => console.error('[BuildingModelSurface] clearing the selection on Esc failed', err))} />
          )}
          {axisBadge && tool === 'route' && !showDrawing && (
            <div
              className="pointer-events-none absolute rounded-sm border bg-background/95 px-1.5 py-0.5 font-mono text-xs shadow-sm"
              style={{ left: axisBadge.x, top: axisBadge.y }}
              data-testid="route-axis-badge"
              aria-hidden
            >
              {axisBadge.text}
            </div>
          )}
          {dragHint && (
            <ToolHintBar
              text={dragHint}
              tone={dragHint.startsWith('Stopped:') ? 'warning' : 'info'}
              testId="building-model-drag-hint"
              style={propertiesOpen ? { right: propertiesWidth + 24 } : undefined}
            />
          )}
          {workflows.overlays}
          {propertiesOpen && (
            // Opaque over a drawing or a schedule pane: what sits underneath must not show through.
            <ResizableSideRail
              ref={propertiesRef}
              side="right"
              surface={PROPERTIES_SURFACE}
              title="Properties"
              defaultWidthPx={PROPERTIES_DEFAULT_WIDTH_PX}
              onWidthChange={setPropertiesWidth}
              className={`absolute inset-y-0 right-0 border-l shadow-sm ${propertiesSurfaceClass(showDrawing, scheduleGridOpen)}`}
              bodyClassName="gap-3 p-3"
            >
              {selection ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Properties</span>
                    <Button variant="ghost" size="icon-sm" aria-label="Close properties" onClick={() => void sessionRef.current?.clearSelection()}>
                      <X />
                    </Button>
                  </div>
                  {selection.kind === 'authored' && (
                    <ModelFromStore store={modelStore}>
                      {(shown) =>
                        shown && (
                          <ShowInScheduleButton
                            model={shown}
                            elementId={selection.element.id}
                            onOpen={(viewId) => {
                              openItem({ kind: 'view', id: viewId })
                              setViewDisplay('model')
                            }}
                          />
                        )
                      }
                    </ModelFromStore>
                  )}
                  {selection.kind === 'group' ? (
                    <GroupProperties
                      key={groupSelectionKeys(selection).properties}
                      scope={selection.scope}
                      count={selection.ids.length}
                      totals={groupTotals}
                      canEdit={canEdit}
                      onMove={(delta, upMm) => {
                        // null is success; only a missing session is "not connected".
                        const session = sessionRef.current
                        return session ? session.moveGroupBy(selection.ids, delta, upMm) : "Live editing isn't connected."
                      }}
                      onResize={(size, transition) => {
                        const session = sessionRef.current
                        return session ? session.resizeGroup(selection.ids, size, transition) : "Live editing isn't connected."
                      }}
                      onDelete={() => requestGroupDelete(selection.ids)}
                    />
                  ) : (
                  <SelectionPanel
                    projectId={projectId}
                    equipmentParameters={equipmentLibrary.parameters}
                    selection={selection}
                    session={live}
                    viewStore={viewStore}
                    onResize={(id, w, h) => sessionRef.current?.resizeRun(id, w, h) ?? null}
                    canEdit={canEdit}
                    saveLabel={saveLabel}
                    saveMessage={save.message}
                    onDelete={requestDelete}
                    editTypeRequest={editTypeRequest}
                    onEditDefinition={(definition) => setPartEditor({ definition })}
                    onRouteLike={routeLike}
                  />
                  )}
                  {workflows.properties}
                  {openView?.props?.diagram && selection.kind === 'authored' && (
                    <ModelFromStore store={modelStore}>
                      {(shown) => shown && <DiagramProperties model={shown} view={openView} selectedIds={selectedIds} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onSelect={(id) => modelEdit?.select(id)} />}
                    </ModelFromStore>
                  )}
                  {(selection.kind === 'authored' || selection.kind === 'group') && (
                    <ModelFromStore store={modelStore}>
                      {(shown) =>
                        shown && (
                          <ElementOrganizationFields
                            key={selection.kind === 'authored' ? selection.element.id : groupSelectionKeys(selection).organization}
                            model={shown}
                            ids={selection.kind === 'authored' ? [selection.element.id] : selection.ids}
                            canEdit={canEdit}
                            blockedReason={blockedReason}
                            submit={submitWithUndo}
                          />
                        )
                      }
                    </ModelFromStore>
                  )}
                  {selection.kind === 'authored' && (
                    <ModelFromStore store={modelStore}>
                      {(shown) =>
                        shown && (
                          <DivergenceBadge
                            model={shown}
                            elementId={selection.element.id}
                            canEdit={canEdit && showBranches}
                            blockedReason={canEdit ? "This model server doesn't open branches yet, so the design can't be updated here." : blockedReason}
                            onUpdateDesign={() => setStartFrom({ key: 'now', nonce: Date.now() })}
                          />
                        )
                      }
                    </ModelFromStore>
                  )}
                </>
              ) : openView ? (
                <ViewProperties
                  view={openView}
                  canEdit={canEdit}
                  blockedReason={blockedReason}
                  submit={submitWithUndo}
                  references={references.map((r) => ({ id: r.id, label: r.label }))}
                  display={viewDisplay}
                  onDisplay={chooseDisplay}
                  onRename={() => setRequest({ kind: 'rename_view', view: openView })}
                  phaseFields={viewPhaseFields(openView)}
                  crop3d={openView.viewType === 'three_d' ? crop3dControls : undefined}
                  schedule={workflows.viewProperties(openView)}
                />
              ) : null}
            </ResizableSideRail>
          )}
          {showStats && !showDrawing && <ViewerStatsReadout feed={statsFeed} />}
          {coordinationOpen && (
            <ModelFromStore store={modelStore}>
              {(shown) =>
                shown && (
                  <ChecklistPane
                    projectId={projectId}
                    branchChannel={syncChannel}
                    modelId={config?.authority?.modelId ?? shown.modelId}
                    model={shown}
                    canEdit={canEdit}
                    blockedReason={blockedReason ?? "Changing the checklist needs edit access to this project's model; ask a project lead."}
                    actorName={userName}
                    submit={(command, label) => submitWithUndo(command, label)}
                    onSelect={(ids) => void sessionRef.current?.selectGroup('box', ids, null)}
                    onClose={() => setCoordinationOpen(false)}
                    questions={{
                      model: shown,
                      projectName,
                      canEdit,
                      blockedReason: blockedReason ?? "Asking questions needs edit access to this project's model; ask a project lead.",
                      submit: (command: QuestionCommand, label: string) => submitWithUndo(command, label),
                      selection: selectedIds.map(asElementId),
                      selectionLabel: questionSelectionLabel(shown, selectedIds),
                      focusRequest: questionFocus,
                      onSelect: (ids) => void sessionRef.current?.selectGroup('box', ids, null),
                      // Round 9 lane Q9: who you are (Ask again, the bell), where notices go, and Revise the design opening a branch.
                      me: questionMe,
                      notices: { projectId, modelId: config?.authority?.modelId ?? shown.modelId },
                      revise: syncChannel
                        ? { create: async (name: string) => (await askBranch(syncChannel, { type: 'branch_create', name }, 'branch_saved')).branch.branchId, open: (branchId: string) => openBranch(branchId) }
                        : null,
                    }}
                    submittals={{
                      model: shown,
                      canEdit,
                      blockedReason: blockedReason ?? "Recording submittals needs edit access to this project's model; ask a project lead.",
                      submit: (command: SubmittalCommand, label: string) => submitWithUndo(command, label),
                      selection: selectedIds.map(asElementId),
                      selectionLabel: questionSelectionLabel(shown, selectedIds),
                    }}
                  />
                )
              }
            </ModelFromStore>
          )}
        </div>
      </div>
      <ModelFromStore store={modelStore} zones={ORGANIZATION_ZONES}>
        {(shown) => <OrganizationStatusBar model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onRefused={(message) => toast.error(message)} />}
      </ModelFromStore>
      {organizationDialog !== null && (
        <ModelFromStore store={modelStore}>
          {(shown) =>
            shown &&
            (organizationDialog === 'groups' ? (
              <ManageGroupsDialog model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} />
            ) : organizationDialog === 'phases' ? (
              <ManagePhasesDialog model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} />
            ) : organizationDialog === 'addons' ? (
              <AddonsPreview model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} />
            ) : organizationDialog === 'codes' ? (
              <CodesOfRecordDialog projectId={projectId} modelId={config?.authority?.modelId ?? shown.modelId} model={shown} canEdit={canEdit} actorName={userName} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} />
            ) : organizationDialog === 'stages' ? (
              <ConstructionStagesDialog model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} selectedIds={selection?.kind === 'authored' ? [selection.element.id] : selection?.kind === 'group' ? selection.ids : []} />
            ) : (
              <PhaseFiltersDialog model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setOrganizationDialog(null)} />
            ))
          }
        </ModelFromStore>
      )}
      {connectAgentOpen && <ConnectAgentDialog open onOpenChange={setConnectAgentOpen} />}
      {tagStylesOpen && (
        <ModelFromStore store={modelStore}>
          {(shown) => shown && <TagStylesDialog model={shown} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} initialStyleId={tagStylesOpen.styleId} sampleElementId={tagStylesOpen.sampleElementId} onClose={() => setTagStylesOpen(null)} />}
        </ModelFromStore>
      )}
      {partEditor && (
        <PartEditorWindow
          initial={partEditor.definition}
          canEdit={canEdit}
          onSave={(definition) => {
            const spot = partEditor.spot
            if (!spot) return sessionRef.current?.savePartDefinition(definition) ?? "Live editing isn't connected."
            const command = modelInPlaceCommand(definition, spot, newId('part'))
            if (typeof command === 'string') return command
            const refused = sessionRef.current?.submitCommand(command, command.type === 'batch_edits' ? command.label : undefined) ?? "Live editing isn't connected."
            // Placed once: later saves in this window only update the type.
            if (!refused) setPartEditor({ definition, spot: null })
            return refused
          }}
          placesAt={partEditor.spot ? inPlaceWords(partEditor.spot) : null}
          {...(partEditor.spot ? { newCategory: 'generic' as const } : {})}
          firmLibrary={
            firmLibrary.status.state === 'ready'
              ? { canWrite: firmLibrary.canWrite, ...(firmLibrary.canWrite ? {} : { reason: 'Your role can place firm library parts but not add them' }), save: firmLibrary.save }
              : undefined
          }
          onClose={() => setPartEditor(null)}
        />
      )}
      {historyDialog === 'versions' ? (
        <VersionsDialog
          onOpenChange={(isOpen) => !isOpen && setHistoryDialog(null)}
          projectId={projectId}
          modelId={authorityModelId}
          state={versions.state}
          onRetry={versions.reload}
          cantEditReason={canEdit ? null : CANT_START_BRANCHES}
          onSaveVersion={versions.save}
          onNewBranchFrom={(entry) => {
            setHistoryDialog(null)
            setStartFrom({ key: entry.key, nonce: Date.now() })
          }}
          channel={syncChannel}
          store={modelStore}
        />
      ) : null}
      {historyDialog === 'responsibilities' && model ? (
        <ModelFromStore store={modelStore}>{(shown) => shown && <ResponsibilitiesDialog open onOpenChange={(isOpen) => !isOpen && setHistoryDialog(null)} projectId={projectId} model={shown} />}</ModelFromStore>
      ) : null}
      {historyDialog === 'change_orders' ? (
        <ModelFromStore store={modelStore}>{(shown) => <ChangeOrdersDialog open onOpenChange={(isOpen) => !isOpen && setHistoryDialog(null)} projectId={projectId} model={shown} channel={syncChannel} versions={versionEntries} />}</ModelFromStore>
      ) : null}
      {historyDialog === 'copies' && syncChannel ? (
        <CopiesDialog open onOpenChange={(isOpen) => !isOpen && setHistoryDialog(null)} projectId={projectId} ask={askCopies} />
      ) : null}
      {historyDialog === 'propose_merge' && onBranch ? (
        <ProposeMergeDialog
          open
          onOpenChange={(isOpen) => !isOpen && setHistoryDialog(null)}
          projectId={projectId}
          branchId={onBranch.branchId}
          blockedReason={mergeBlocked}
          requestPreview={requestMergePreview}
          requestApply={requestMergeApply}
        />
      ) : null}
      <DeleteConfirmDialog pending={pendingDelete} onClose={() => setPendingDelete(null)} onConfirm={confirmDelete} />

      {request?.kind === 'new_view' && request.viewType !== 'section' && (
        <NewViewDialog
          viewType={request.viewType}
          levels={planLevels}
          onCancel={() => setRequest(null)}
          onCreate={(input) => createView(request.viewType === 'section' ? 'floor_plan' : request.viewType, input)}
        />
      )}
      {(request?.kind === 'new_sheet' || request?.kind === 'edit_sheet') && (
        <SheetDialog
          sheet={request.kind === 'edit_sheet' ? request.sheet : null}
          suggestedNumber={nextSheetNumber(index?.sheets ?? [])}
          projectValues={model ? projectParametersOf(model).values : undefined}
          onProjectInfo={() => setProjectInfoOpen(true)}
          onCancel={() => setRequest(null)}
          onSave={(input) => {
            if (request.kind === 'edit_sheet') {
              const old = request.sheet.props?.fields ?? {}
              const fields: Record<string, string> = { ...input.fields }
              for (const key of Object.keys(old)) if (!(key in fields)) fields[key] = ''
              return submitWithUndo({ type: 'set_sheet_properties', sheetId: request.sheet.id, number: input.number, name: input.name, titleBlock: input.titleBlock, titleBlockRow: input.titleBlockRow, fields }, `update sheet ${input.number}`)
            }
            const id = newId('sheet')
            const fields = Object.fromEntries(Object.entries(input.fields).filter(([, v]) => v.trim() !== ''))
            const refusal = submitWithUndo({ type: 'create_sheet', sheetId: id, number: input.number, name: input.name, titleBlock: input.titleBlock, ...(input.titleBlockRow ? { titleBlockRow: input.titleBlockRow } : {}), fields }, `create sheet ${input.number}`)
            if (!refusal) openItem({ kind: 'sheet', id })
            return refusal
          }}
        />
      )}
      {projectInfoOpen && model && (
        <ProjectInfoDialog model={model} host={{ projectName, ...(projectNumber ? { projectNumber } : {}) }} canEdit={canEdit} blockedReason={blockedReason} submit={submitWithUndo} onClose={() => setProjectInfoOpen(false)} />
      )}
      {figureDialog && openSheet && (
        <ModelFromStore store={modelStore}>
          {(shown) =>
            shown && (
              <SheetFigureDialog
                mode={figureDialog}
                sheet={openSheet}
                model={shown}
                images={sheetImages}
                submit={submitWithUndo}
                onClose={() => setFigureDialog(null)}
                onPlaced={(itemId) => {
                  setFigureDialog(null)
                  setPlacedFigure({ id: itemId })
                  toast.success(figureDialog === 'chart' ? 'Chart placed. Drag it to move, drag a corner to resize; Ctrl+Z takes it off.' : 'Picture placed. Drag it to move, drag a corner to resize; Ctrl+Z takes it off.')
                }}
              />
            )
          }
        </ModelFromStore>
      )}
      {calcDialog && openSheet && (
        <ModelFromStore store={modelStore}>
          {(shown) =>
            shown && (
              <InsertCalculationDialog
                sheet={openSheet}
                model={shown}
                selectedId={selectedId}
                submit={submitWithUndo}
                onClose={() => setCalcDialog(false)}
                onPlaced={(itemId) => {
                  setCalcDialog(false)
                  setPlacedFigure({ id: itemId })
                  toast.success('Calculation placed. It updates with every edit and freezes when the set is issued; Ctrl+Z takes it off.')
                }}
              />
            )
          }
        </ModelFromStore>
      )}
      {request?.kind === 'rename_view' && (
        <RenameViewDialog view={request.view} onCancel={() => setRequest(null)} onRename={(name) => submitWithUndo({ type: 'rename_view', viewId: request.view.id, name }, `rename to ${name}`)} />
      )}
      {request?.kind === 'delete_view' && (
        <ModelFromStore store={modelStore}>
          {(shown) => <DeleteViewConfirm view={request.view} model={shown} onCancel={() => setRequest(null)} onDelete={(placed) => submitWithUndo({ type: 'delete_view', viewId: request.view.id, placed }, `delete ${request.view.name}`)} />}
        </ModelFromStore>
      )}
      {request?.kind === 'delete_sheet' && (
        <DeleteDialog
          title={`Delete sheet ${request.sheet.number}?`}
          description={`Its notes and lines go with it. The ${index?.viewportsBySheet.get(request.sheet.id)?.length ?? 0} views on it stay in the panel, just off the sheet. Ctrl+Z brings the sheet back.`}
          confirmLabel="Delete sheet"
          onCancel={() => setRequest(null)}
          onConfirm={() => submitWithUndo({ type: 'delete_sheet', sheetId: request.sheet.id }, `delete sheet ${request.sheet.number}`)}
        />
      )}
      <LevelTools
        projectId={projectId}
        model={model}
        levels={levels}
        viewer={viewer}
        live3d={live3dOpen}
        showPlanes={showLevels}
        extentKey={references.length}
        canEdit={canEdit}
        blockedReason={blockedReason}
        submit={submitWithUndo}
        request={levelRequest}
        onRequest={setLevelRequest}
        hint={setToolHint}
      />
      {spacesTool.dialogs}
      {ceilingTool.bar}
      {equipmentListFor && (
        <ModelFromStore store={modelStore}>
          {(shown) => (
            <EquipmentListDialog
              model={shown}
              circuitRules={sharedValue<ListProps['circuitRules']>(workflows.shared, 'circuitRules')}
              necEdition={sharedValue<ListProps['necEdition']>(workflows.shared, 'necEdition')}
              computedColumns={sharedValue<ListProps['computedColumns']>(workflows.shared, 'equipmentListColumns') ?? undefined}
              trade={equipmentListFor}
              editBlocked={editBlocked}
              submit={submitWithUndo}
              onClose={() => setEquipmentListFor(null)}
              projectId={projectId}
              library={equipmentLibrary}
              onAdded={(ids) => toast.success(`Added ${ids.length} planned item${ids.length === 1 ? '' : 's'}. They're in Not placed yet.`)}
              onOpenSchedule={() => {
                setEquipmentListFor(null)
                openBuiltinList('equipment_list')
              }}
            />
          )}
        </ModelFromStore>
      )}
      {listScheduleFor && (
        <ModelFromStore store={modelStore}>
          {(shown) =>
            shown && (
              <NewListScheduleDialog
                model={shown}
                initialCategory={listScheduleFor}
                initialPick={schedulePick}
                initialSheetId={open.kind === 'sheet' ? open.id : null}
                formSlot={sharedValue<NewScheduleFormSlot>(workflows.shared, 'newScheduleForms')}
                submit={submitWithUndo}
                onClose={() => {
                  setListScheduleFor(null)
                  setSchedulePick(undefined)
                }}
                onCreated={(viewId, sheetId) => {
                  setListScheduleFor(null)
                  setSchedulePick(undefined)
                  // The new view (and its sheet) is already in this tab's model (the edit applies here before it saves).
                  openItem(sheetId ? { kind: 'sheet', id: sheetId } : { kind: 'view', id: viewId })
                }}
              />
            )
          }
        </ModelFromStore>
      )}
      <ModelFromStore store={modelStore}>
        {(shown) => (
          <DrawingSetRequests
            request={request}
            onDone={() => setRequest(null)}
            onRequest={setRequest}
            projectId={projectId}
            projectName={projectName}
            projectNumber={projectNumber ?? null}
            modelId={config?.authority?.modelId ?? null}
            model={shown}
            sheets={index?.sheets ?? []}
            save={setSaveState}
            canEdit={canEdit}
            blockedReason={blockedReason}
            submit={submitWithUndo}
          />
        )}
      </ModelFromStore>
      {printing && openSheet && (
        <PrintDialog sheet={openSheet} savedRevision={printing.savedRevision} pendingOnSheet={printing.pendingOnSheet} onCancel={() => setPrinting(null)} onPrint={print} />
      )}
      {planeDialogOpen && live && (
        <MountingPlaneDialog
          levels={live.levels().map((l) => ({ id: l.id, name: l.name }))}
          initialLevelId={live.levels().find((l) => openView?.props?.level !== undefined && l.name === openView.props.level)?.id ?? null}
          rectFor={(levelId) => live.planeRectFor(levelId)}
          onCancel={() => setPlaneDialogOpen(false)}
          onAdd={(levelId, name, heightMm, corner1, corner2) => {
            const refused = live.createMountingPlane(levelId, name, heightMm, corner1, corner2)
            if (!refused) setPlaneDialogOpen(false)
            return refused
          }}
        />
      )}
    </div>
    </LayoutPrefsProviderFrom>
  )
}

/** The selection box while dragging: solid for window (left to right), dashed for crossing (right to left). */
interface BoxDrag {
  readonly start: { readonly x: number; readonly y: number }
  readonly end: { readonly x: number; readonly y: number }
  /** The canvas's top-left on screen when the drag began. */
  readonly origin: { readonly x: number; readonly y: number }
}

function BoxOverlay({ drag }: { drag: BoxDrag }) {
  const r = { left: drag.origin.x, top: drag.origin.y }
  const crossing = drag.end.x < drag.start.x
  return (
    <div
      className={`pointer-events-none absolute border-2 ${crossing ? 'border-dashed border-success-600 bg-success-50/30' : 'border-primary bg-primary-100/30'}`}
      style={{ left: Math.min(drag.start.x, drag.end.x) - r.left, top: Math.min(drag.start.y, drag.end.y) - r.top, width: Math.abs(drag.end.x - drag.start.x), height: Math.abs(drag.end.y - drag.start.y) }}
      data-testid="box-select-rect"
      data-mode={crossing ? 'crossing' : 'window'}
      aria-hidden
    />
  )
}

function DeleteViewConfirm({ view, model, onCancel, onDelete }: { view: ViewElement; model: ModelState | null; onCancel: () => void; onDelete: (placed: 'refuse' | 'remove_from_sheet') => string | null }) {
  const placedOn = useMemo(() => {
    if (!model) return null
    const index = documentIndex(model)
    const vp = index.viewportByView.get(view.id)
    return vp ? index.sheets.find((s) => s.id === vp.sheetId)?.number ?? 'a sheet' : null
  }, [model, view.id])
  return (
    <DeleteDialog
      title={`Delete view "${view.name}"?`}
      description={
        placedOn
          ? `It's placed on sheet ${placedOn}. Deleting it takes it off that sheet too. Ctrl+Z brings both back.`
          : `${view.viewType === 'detail' ? 'Its lines, text and dimensions go with it. ' : ''}Ctrl+Z brings it back.`
      }
      confirmLabel={placedOn ? `Delete and take off ${placedOn}` : 'Delete view'}
      onCancel={onCancel}
      onConfirm={() => onDelete(placedOn ? 'remove_from_sheet' : 'refuse')}
    />
  )
}

function nextSheetNumber(sheets: readonly Sheet[]): string {
  const taken = new Set(sheets.map((s) => s.number.toUpperCase()))
  for (let n = 101; n < 1000; n++) if (!taken.has(`M-${n}`)) return `M-${n}`
  return 'M-1000'
}

function nextSectionName(views: readonly ViewElement[]): string {
  const taken = new Set(views.map((v) => v.name.toLowerCase()))
  for (let i = 0; i < 26; i++) {
    const name = `Section ${String.fromCharCode(65 + i)}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return `Section ${views.length + 1}`
}


/** The open sheet's live blocks against their last issue ("Matches SD issue" / "Changed since SD issue"); nothing when the sheet has no block. */
function SheetFreshness({ projectId, modelId, sheetNumber, revision, blockId }: { projectId: string; modelId: string; sheetNumber: string; revision: number; blockId?: string }) {
  const sheets = useMemo(() => [sheetNumber], [sheetNumber])
  const blocksPort = useEditorHost().data.blocks
  const freshness = useBlockFreshnessFrom(blocksPort, projectId, modelId, sheets, revision)
  return <SheetBlockFreshnessChip freshness={freshness} {...(blockId ? { blockId } : {})} />
}
