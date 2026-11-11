import {
  BookOpenCheck,
  Plug,
  ShieldAlert,
  ChartLine,
  ImagePlus,
  Activity,
  ArrowUpDown,
  FlipVertical2,
  Axis3d,
  Compass,
  CopyPlus,
  MapPinned,
  Move3d,
  Navigation2,
  ArrowDown,
  ArrowUp,
  Check,
  CornerDownRight,
  Filter,
  Spline,
  SquareDashedMousePointer,
  SquareSplitHorizontal,
  Table2,
  Box,
  Copy,
  Focus,
  Expand,
  Crop,
  Eye,
  FileText,
  Frame,
  Gauge,
  Group,
  History,
  Building2,
  Layers,
  Rows3,
  LayoutTemplate,
  Link2,
  Maximize,
  MousePointer2,
  Move,
  MoveHorizontal,
  PackagePlus,
  PenLine,
  PencilRuler,
  Pencil,
  Plus,
  Printer,
  KeyRound,
  LayoutGrid,
  ListOrdered,
  ClipboardList,
  Stamp,
  Redo2,
  RotateCcw,
  RotateCw,
  Route,
  Ruler,
  Scissors,
  Shapes,
  Sigma,
  Square,
  SquareDashed,
  Trash2,
  Undo2,
  X,
  FileBox,
  GitBranch,
  UserCheck,
  FilePen,
  Sparkles,
} from 'lucide-react'
import { DRAFTING_VIEW_REASON } from '@permitzip/bim-kernel'
import type { RibbonCommand, RibbonGroup, RibbonTab } from './ribbon/types'
import type { AxisLock } from './route-axis'
import type { DrawingTool } from './views-sheets/DrawingCanvas'
import { annotateTab, type DetailShape } from './ribbon/annotate-tab'
import { drawnItemsTab, modifyTab } from './ribbon/modify-tab'
import { TOOL_SHORTCUTS, type BuildingModelTool } from './ribbon/tool-shortcuts'
import type { AddonAvailability, AddonId, AddonInput, TablePlacer } from './contributions/types'
import { addonTabAnalyzeCommands, addonTabPlanCommands, contributedCommands, contributedTabs } from './contributions/ribbon'
import { withScheduleGroups, type RibbonSchedules } from './ribbon/schedules-group'
import { withPlanGroups, type RibbonPlan } from './ribbon/plan-group'
import { isTradeTab, withTradeSectionCommands } from './ribbon/trade-tab'
import type { DraftController } from './views-sheets/draft/useDraftController'
import type { PanelRequest } from './views-sheets/ViewsSheetsPanel'
import { calculationCommand } from './calc-sheets/calc-ribbon'
import { riseStyleLabel, type RiseStyle } from './route-rise'
import { placeKeynoteList } from './views-sheets/keynotes'

export { TOOL_SHORTCUTS, type BuildingModelTool }

/** Switches the 3D view between perspective and orthographic (the same key as the numpad toggle in common 3D tools). */
export const PROJECTION_SHORTCUT = '5'

/** Categories box select keeps. */
export type BoxCategory = 'duct' | 'pipe' | 'parts'

/** The Route contextual tab's state and actions, while the Route tool is on. */
export interface RouteRibbon {
  readonly riseStyle: RiseStyle
  readonly setRiseStyle: (style: RiseStyle) => void
  /** Raise (positive) or drop the run at the current point, in feet. */
  readonly rise: (ft: number) => void
  readonly lock: AxisLock
  readonly setLock: (lock: Exclude<AxisLock, 'auto'>) => void
  readonly chooseElbow: () => void
  readonly chooseTakeoff: () => void
  readonly offsetArmed: boolean
  readonly armOffset: () => void
  readonly finish: () => void
  readonly cancel: () => void
  /** Why Finish can't be pressed (null when it can). */
  readonly finishBlocked: string | null
  /** Why a rise can't be added yet (null when it can). */
  readonly riseBlocked: string | null
}

/** What is selected in the model, as far as the ribbon's contextual tab cares. */
export type RibbonSelection =
  | { readonly kind: 'part'; readonly label: string }
  | { readonly kind: 'run'; readonly label: string; readonly domain: 'duct' | 'pipe'; readonly fitting?: boolean }
  | { readonly kind: 'branch'; readonly label: string }
  /** A run, branch or system picked with Tab, or a box selection. */
  | { readonly kind: 'group'; readonly label: string; readonly count: number; readonly runs: number; readonly movable: number }
  | null

export interface BuildingModelRibbonContext {
  readonly tool: BuildingModelTool
  readonly chooseTool: (tool: BuildingModelTool) => void
  /** Null when editing is allowed; otherwise why not, in the operator's words. */
  readonly editBlocked: string | null
  /** A sheet or a view's printed drawing fills the canvas (the model tools don't apply). */
  readonly drawingOpen: 'sheet' | 'detail' | null
  /** The drawing is of a plan, section or 3D view: the model tools still work (they switch it to its live model). */
  readonly liveViewOnDrawing?: boolean
  /** Swap a plan, section or 3D view's drawing for its live model (what the model tools do before they start). */
  readonly showLiveModel: () => void
  readonly undoLabel: string | null
  readonly redoLabel: string | null
  readonly undo: () => void
  readonly redo: () => void
  readonly fit: () => void
  /** The free 3D model is open (the roof can come off). */
  readonly model3dOpen: boolean
  readonly roofOff: boolean
  readonly setRoofOff: (on: boolean) => void
  readonly showStats: boolean
  readonly setShowStats: (on: boolean) => void
  /** The 3D view's projection; null when no 3D view is in the canvas (plans, sheets, drawings). */
  readonly projection: { readonly value: 'perspective' | 'orthographic'; readonly toggle: () => void } | null
  readonly drawingTool: DrawingTool
  readonly drawingTools: readonly DrawingTool[]
  /** Tag every untagged duct, pipe, terminal, fixture and piece of equipment in the open plan or section; null elsewhere. */
  readonly tagAll: { readonly run: () => void; readonly disabledReason: string | null } | null
  readonly setDrawingTool: (tool: DrawingTool) => void
  /** The shape Annotate › Detail line drew last (its face draws it again); line when unset. */
  readonly lastDetailShape?: DetailShape
  /** Draft settings shared with the drawing canvas (snaps, dimension kind, the modify operation waiting for clicks). */
  readonly draft?: DraftController
  readonly request: (r: PanelRequest) => void
  /** Model schedules on every discipline tab, and Manage › Library; absent: none (tests and read-only hosts). */
  readonly schedules?: RibbonSchedules | null
  /** Equipment list, Not placed yet and Spaces, right after Select on each trade tab (ribbon/plan-group.ts). */
  readonly plan?: RibbonPlan | null
  readonly sectionDrawing: boolean
  readonly toggleSection: () => void
  readonly planOpen: boolean
  readonly openModel: (mode: '3d' | 'plan') => void
  /** The open saved view's crop state; null when no saved view (with a crop) is open. */
  readonly crop: { readonly on: boolean; readonly shown: boolean; readonly set: (change: { cropView?: boolean; showCropBox?: boolean }) => void } | null
  /** The 3D crop box of the 3D picture in the canvas (a 3D view, or your working 3D view in the 3D model); null when none is. */
  readonly crop3d: Crop3dRibbon | null
  readonly sheet: { readonly number: string; readonly editTitleBlock: () => void; readonly print: () => void; readonly arrange: () => void; readonly revisions: () => void; readonly chart?: () => void; readonly picture?: () => void; readonly calculation?: () => void; readonly loadSummary?: () => void; readonly placeTable?: (place: TablePlacer) => void } | null
  /** The model has at least one sheet (Print set / Issue set). */
  readonly hasSheets: boolean
  /** Sheets print black only (the project's choice); false: colour. */
  readonly printBlackOnly?: boolean
  readonly setPrintBlackOnly?: (on: boolean) => void
  readonly canLink: boolean
  readonly openLink: () => void
  /** What Link a model brings in here, naming only the sources the host serves; absent: Autodesk Docs or an IFC file. */
  readonly linkDescription?: string
  /** Why nothing can be linked where the editor runs (the host serves no link source), in words; null or absent when something can. */
  readonly linkUnavailableReason?: string | null
  /** Round 10 T10: Manage › Connect an agent (the core and each pack's connection). */
  readonly openConnectAgent?: () => void
  readonly addLevel: () => void
  /** Model › Datum › Mounting plane: a surface to place air devices on where there is no ceiling. */
  readonly addMountingPlane: () => void
  /** Model › Datum › Architect's levels: the linked model's storeys as levels, previewed first. */
  readonly useArchitectLevels: () => void
  /** The level planes in the 3D view. */
  readonly showLevels: boolean
  readonly setShowLevels: (show: boolean) => void
  /** Model › Parts: the part editor, for a new part type or the selected part's type. */
  readonly parts: PartsRibbon
  readonly selection: RibbonSelection
  readonly rotateSelected: (deg: number) => void
  readonly editType: () => void
  readonly resizeSelected: () => void
  /** Duct fittings: jump to the fitting type picker in the properties panel. */
  readonly chooseFittingType: () => void
  /** Where reducer shape (centred, or flat on top or bottom) is chosen for what is selected. */
  readonly reducerShape: () => void
  /** The selected run's insulation, and Make system default. */
  readonly focusRunInsulation: () => void
  /** Duct runs: show the piece's pressure and the fan's required static in the properties panel. */
  readonly showPressure: () => void
  readonly deleteSelected: () => void
  readonly clearSelection: () => void
  /** Duct and pipe runs: arm the split tool on the selected run. */
  readonly splitSelected: () => void
  /** A group: jump to the move fields in the properties panel. */
  readonly moveSelected: () => void
  readonly boxFilter: Readonly<Record<BoxCategory, boolean>>
  readonly toggleBoxFilter: (category: BoxCategory) => void
  /** Non-null while the Route tool is on. */
  readonly route: RouteRibbon | null
  /** Model › Build › Ceiling: the ceiling plan's Ceiling tool (`ceilings/`); absent until wired. */
  readonly ceiling?: RibbonCommand
  /** Manage › Groups & phases. */
  readonly organization: { readonly openGroups: () => void; readonly openPhases: () => void; readonly openFilters: () => void; readonly openTagStyles: () => void; readonly openConstructionStages?: () => void; readonly openAddons?: () => void; readonly openCodes?: () => void }
  /** Jump to a section of the open view's properties; null when no saved view is open. `range`: plans only; `linked`: with linked models. */
  readonly viewGraphics: { readonly lines: () => void; readonly range: (() => void) | null; readonly linked: (() => void) | null } | null
  readonly coordinates: CoordinatesRibbon
  /** Create similar (C S): start the tool that makes another of the selection, set to match it (create-similar.ts). */
  readonly createSimilar?: () => void
  /** Manage › Coordination: clashes and coordination findings (components/building-model/coordination). */
  readonly coordination?: { readonly open: () => void }
  /** Manage › Versions & sign-off (round 8b): saved versions and branches, who is responsible, change orders. Absent: not offered (tests, read-only hosts). */
  readonly history?: { readonly openVersions: () => void; readonly openResponsibilities: () => void; readonly openChangeOrders: () => void; /** Manage › Copies (contractor and shop copies); absent when the model server isn't connected. */ readonly openCopies?: () => void }
  /** Route duct / Route pipe: start the Route tool on duct or pipe. Absent: Route starts on whatever was routed last. */
  readonly routeAs?: (kind: 'duct' | 'pipe') => void
  /** What the Route tool is drawing while it is on. */
  readonly routeKind?: 'duct' | 'pipe'
  /** Copy (Ctrl+C) the selected parts and Paste (Ctrl+V) them under the pointer; each `blocked` says why it is off. */
  readonly clipboard?: { readonly copyBlocked: string | null; readonly copy: () => void; readonly pasteBlocked: string | null; readonly paste: () => void }
  /** The model's add-ons (`addonAvailability`). Absent: the first-party add-ons only. Add-on tabs and commands come from their contributions (contributions/). */
  readonly addons?: AddonAvailability
  /** Each add-on's ribbon input (its workflow's, or why it is not ready); an add-on's tabs show only when it has one. */
  readonly addonInputs?: Readonly<Record<AddonId, AddonInput<unknown>>>
}

/** On a drawing a Select drag on empty paper is already the box; the command is what keeps the box on for the 3D view. */
export const BOX_ON_DRAWING_DESCRIPTION = 'Drag on empty space selects; this keeps the box on for the 3D view'

/** Model › Parts (and Manage › Part types): open the part editor. */
export interface PartsRibbon {
  readonly newPart: () => void
  /** Why New part can't open (null when it can). */
  readonly newBlocked: string | null
  readonly editSelected: () => void
  /** Why Edit part can't open the selection's type (null when it can). */
  readonly editBlocked: string | null
  /** Model in place: click a spot, then draw the part there in the part editor; absent where the host has no spot pick. */
  readonly modelInPlace?: () => void
}

/** Views › Crop while a 3D picture is in the canvas. */
export interface Crop3dRibbon {
  readonly on: boolean
  readonly shown: boolean
  readonly set: (change: { readonly enabled?: boolean; readonly show?: boolean }) => void
  readonly toSelection: () => void
  readonly reset: () => void
  /** Why Crop to selection can't run (null when it can). */
  readonly selectionBlocked: string | null
  /** Turn the box about its middle to the working angle (a command; the box has no rotate handle). */
  readonly alignToWorkingAngle: () => void
  /** Pick a building edge and turn the box square to it. */
  readonly alignToEdge: () => void
  /** Why aligning can't run (null when it can). */
  readonly alignBlocked: string | null
}

/** Manage › Coordinates: moving the origin, the Coordinates dialog (project origin, site point, true north, working angle), aligning the axes to an edge, and the open plan's orientation (Show origin & axes is under Model › Display). */
export interface CoordinatesRibbon {
  readonly showOrigin: boolean
  readonly setShowOrigin: (on: boolean) => void
  /** Dragging the origin: the marker follows the pointer and a click places it. */
  readonly moving: boolean
  readonly toggleMove: () => void
  readonly openTrueNorth: () => void
  readonly openSurveyPoint: () => void
  /** Coordinates on its Project origin tab, the marker on the project origin. */
  readonly openOrigin: () => void
  /** Coordinates on its Working angle tab. */
  readonly openWorkingAngle: () => void
  /** Pick a building edge: the working angle turns square to it. */
  readonly alignAxes: () => void
  /** An edge pick for the working angle is in progress. */
  readonly aligningAxes: boolean
  /** The open saved plan's orientation; null when no saved plan is open. */
  readonly orientation: { readonly value: PlanOrientationChoice; readonly set: (value: PlanOrientationChoice) => void } | null
}

export type PlanOrientationChoice = 'plan_north' | 'true_north' | 'working_angle'

const ORIENTATION_LABEL: Readonly<Record<PlanOrientationChoice, string>> = { plan_north: 'Plan north', true_north: 'True north', working_angle: 'Working angle' }
const ORIENTATION_HELP: Readonly<Record<PlanOrientationChoice, string>> = {
  plan_north: 'Draw the plan with plan north (model +Y) up',
  true_north: 'Turn the plan so true north points up',
  working_angle: 'Turn the plan so the building’s walls (the working angle) run square to the screen',
}

const OPEN_MODEL_FOR_ORIGIN = 'The origin shows in the 3D model and plans. Open one from the Views and sheets panel.'
const OPEN_A_PLAN_FOR_ORIENTATION = 'Open a saved floor or ceiling plan to set which north is up.'

const OPEN_3D_TO_CROP = 'Works in 3D: open the 3D model or a 3D view.'

/** Views › Crop in 3D: the box crops (or not), shows its grips (or not), fits the selection, resets. Your own working view needs no edit access to try. */
function crop3dCommands(c: Crop3dRibbon): RibbonCommand[] {
  return [
    { id: 'crop-view', label: '3D crop box', icon: Crop, description: c.on ? 'Cropping to the 3D box. Press to show everything again' : 'Show only what is inside the 3D crop box', keywords: ['section box', 'clip', 'crop'], pressed: c.on, run: () => c.set({ enabled: !c.on, ...(c.on ? {} : { show: true }) }), testId: 'ribbon-crop-3d' },
    { id: 'crop-show', label: 'Show crop box', icon: Frame, description: 'Draw the box and its six grips so you can push and pull its sides', pressed: c.shown, run: () => c.set({ show: !c.shown }), testId: 'ribbon-crop-3d-show' },
    { id: 'crop-3d-selection', label: 'Crop to selection', icon: Focus, description: 'Fit the box to the storey and grid bay around what is selected, and crop', keywords: ['section box', 'selection box', 'isolate'], disabledReason: c.selectionBlocked, run: c.toSelection, testId: 'ribbon-crop-3d-selection' },
    { id: 'crop-3d-reset', label: 'Reset crop', icon: Expand, description: 'Put the box back around the whole model, square to the working angle, linked models included', run: c.reset, testId: 'ribbon-crop-3d-reset' },
    {
      id: 'crop-3d-align',
      label: 'Align crop box',
      icon: RotateCw,
      description: 'Turn the box about its middle, size kept: to the working angle, or square to a building edge you pick',
      keywords: ['rotate crop', 'turn crop', 'section box', 'skewed building'],
      disabledReason: c.alignBlocked,
      children: [
        { id: 'crop-3d-align-working', label: 'To the working angle', icon: Axis3d, description: 'Turn the box square to the working angle', disabledReason: c.alignBlocked, run: c.alignToWorkingAngle, testId: 'ribbon-crop-3d-align-working' },
        { id: 'crop-3d-align-edge', label: 'To an edge…', icon: Ruler, description: 'Click a wall, or two points along a building edge, and the box turns square to it', disabledReason: c.alignBlocked, run: c.alignToEdge, testId: 'ribbon-crop-3d-align-edge' },
      ],
      testId: 'ribbon-crop-3d-align',
    },
  ]
}

const MODEL_TOOLS_ON_SHEET = 'Model tools work in plans, sections and the 3D model. Double-click a plan or section on this sheet to edit it here, or open one from the Views and sheets panel.'

/**
 * Select, at the left of every tab: one Select that picks whatever is under
 * the pointer (parts and runs in the model, drawn items on a drawing), box
 * select, and what box select keeps.
 */
function selectGroup(ctx: BuildingModelRibbonContext, modelToolsOffReason: string | null): RibbonGroup {
  const selecting = ctx.drawingOpen && !ctx.liveViewOnDrawing ? ctx.drawingTool === 'select' && !ctx.draft?.pending : ctx.tool === 'select' && (!ctx.drawingOpen || ctx.drawingTool === 'select')
  const chooseSelect = () => {
    ctx.draft?.setPending(null)
    if (ctx.drawingOpen) ctx.setDrawingTool('select')
    ctx.chooseTool('select')
  }
  return {
    id: 'select',
    label: 'Select',
    shared: true,
    tool: { value: ctx.tool === 'box' ? 'box' : selecting ? 'select' : '', onValueChange: (v) => (v === 'box' ? ctx.chooseTool('box') : chooseSelect()), ariaLabel: 'Select' },
    commands: [
      { id: 'select', label: 'Select', icon: MousePointer2, description: 'Pick something to see its properties: a part or a run in the model, a line or a note on a drawing. Drag on empty space of a drawing or plan to box select (left to right: wholly inside; right to left: touching). In 3D, drag turns the view and Shift+drag boxes; the middle button pans. Drag a selection to move it (hold Shift while dragging for up and down)', shortcut: TOOL_SHORTCUTS.select, keywords: ['pick', 'modify'], disabledReason: null, run: chooseSelect, testId: 'ribbon-select' },
      {
        id: 'box',
        label: 'Box select',
        icon: SquareDashedMousePointer,
        description: ctx.drawingOpen ? BOX_ON_DRAWING_DESCRIPTION : 'Drag a box: left to right picks what is fully inside, right to left what it touches (Shift+drag with Select does the same)',
        shortcut: TOOL_SHORTCUTS.box,
        keywords: ['window', 'crossing', 'marquee', 'region', 'lasso'],
        pressed: ctx.tool === 'box',
        disabledReason: modelToolsOffReason,
        run: () => ctx.chooseTool(ctx.tool === 'box' ? 'select' : 'box'),
        testId: 'ribbon-box-select',
      },
      {
        id: 'box-filter',
        label: 'Filter',
        icon: Filter,
        description: `Box select keeps: ${(['duct', 'pipe', 'parts'] as const).filter((c) => ctx.boxFilter[c]).join(', ') || 'nothing (turn a kind on)'}`,
        keywords: ['category', 'filter'],
        children: (['duct', 'pipe', 'parts'] as const).map((c) => ({
          id: `box-filter-${c}`,
          label: c === 'parts' ? 'Parts' : c === 'duct' ? 'Duct' : 'Pipe',
          icon: ctx.boxFilter[c] ? Check : Square,
          description: `${ctx.boxFilter[c] ? 'Keep' : 'Skip'} ${c} in box selections`,
          pressed: ctx.boxFilter[c],
          run: () => ctx.toggleBoxFilter(c),
          testId: `ribbon-box-filter-${c}`,
        })),
        testId: 'ribbon-box-filter',
      },
    ],
  }
}

/** Undo and Redo: beside Find a tool on every tab. */
export function buildingModelQuickCommands(ctx: Pick<BuildingModelRibbonContext, 'undoLabel' | 'redoLabel' | 'undo' | 'redo' | 'editBlocked'>): RibbonCommand[] {
  return [
    { id: 'undo', label: 'Undo', ariaLabel: ctx.undoLabel ? `Undo ${ctx.undoLabel}` : 'Undo', icon: Undo2, description: ctx.undoLabel ? `Undo ${ctx.undoLabel}` : 'Undo your last edit', shortcut: '⌘Z', disabledReason: ctx.editBlocked ?? (ctx.undoLabel ? null : 'Nothing of yours to undo yet'), run: ctx.undo, testId: 'ribbon-undo' },
    { id: 'redo', label: 'Redo', ariaLabel: ctx.redoLabel ? `Redo ${ctx.redoLabel}` : 'Redo', icon: Redo2, description: ctx.redoLabel ? `Redo ${ctx.redoLabel}` : 'Redo', shortcut: '⇧⌘Z', disabledReason: ctx.editBlocked ?? (ctx.redoLabel ? null : 'Nothing to redo'), run: ctx.redo, testId: 'ribbon-redo' },
  ]
}

/** The Building Model's ribbon: every tool it has, in tabs, with why each is off when it is. Undo and Redo are separate (`buildingModelQuickCommands`). */
export function buildingModelRibbon(ctx: BuildingModelRibbonContext): RibbonTab[] {
  const modelToolsOff = ctx.drawingOpen !== null && !ctx.liveViewOnDrawing
  // A view drawing that is off is a detail view: it has no model in it.
  const MODEL_TOOLS_ON_DRAWING = ctx.drawingOpen === 'detail' ? DRAFTING_VIEW_REASON : MODEL_TOOLS_ON_SHEET
  const modelToolReason = (needsEdit: boolean): string | null => (modelToolsOff ? MODEL_TOOLS_ON_DRAWING : needsEdit ? ctx.editBlocked : null)
  const select = selectGroup(ctx, modelToolsOff ? MODEL_TOOLS_ON_DRAWING : null)
  const tool = (id: BuildingModelTool, label: string, icon: RibbonCommand['icon'], description: string, needsEdit: boolean, keywords: string[] = []): RibbonCommand => ({
    id,
    label,
    icon,
    description,
    shortcut: TOOL_SHORTCUTS[id],
    keywords,
    disabledReason: modelToolReason(needsEdit),
    run: () => ctx.chooseTool(id),
    testId: `ribbon-tool-${id}`,
  })

  const routeAs = (kind: 'duct' | 'pipe') => (ctx.routeAs ? ctx.routeAs(kind) : ctx.chooseTool('route'))

  const newItems: RibbonCommand[] = [
    { id: 'new-floor-plan', label: 'Floor plan for a level', icon: Layers, description: 'A plan of one level, cut at desk height', keywords: ['plan', 'view'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_view', viewType: 'floor_plan' }) },
    { id: 'new-ceiling-plan', label: 'Ceiling plan', icon: SquareDashed, description: 'Looking up at the ceiling of a level', keywords: ['rcp', 'reflected'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_view', viewType: 'ceiling_plan' }) },
    { id: 'new-section', label: 'Section (draw a cut line)', icon: Scissors, description: 'Draw where the section cuts on a plan', keywords: ['cut'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_view', viewType: 'section' }) },
    { id: 'new-3d-view', label: '3D view', icon: Box, description: 'A saved 3D view with its own crop box', keywords: ['isometric', 'axon'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_view', viewType: 'three_d' }) },
    { id: 'new-detail', label: 'Detail view (drawing-only)', icon: PenLine, description: 'A blank drafting view for lines, text and dimensions', keywords: ['drafting'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_view', viewType: 'detail' }) },
    { id: 'new-sheet', label: 'New sheet', icon: FileText, description: 'A sheet with a title block to place views on', keywords: ['drawing', 'page'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_sheet' }) },
  ]

  const parts = ctx.parts
  const newPart: RibbonCommand = {
    id: 'new-part',
    label: 'New part',
    icon: Shapes,
    description: 'Draw a new part type (a rooftop unit, a drain, a fan coil) in the part editor, then place it. To draw one where it goes, use Model in place.',
    keywords: ['part editor', 'generic model', 'model element', 'equipment', 'create', 'extrude', 'massing'],
    disabledReason: modelToolsOff ? MODEL_TOOLS_ON_DRAWING : parts.newBlocked,
    run: parts.newPart,
    testId: 'ribbon-new-part',
  }
  const editPart: RibbonCommand = {
    id: 'edit-part',
    label: 'Edit part',
    icon: PencilRuler,
    description: 'Open the selected part’s type in the part editor (right-click it for the same)',
    keywords: ['edit definition', 'part editor', 'generic model', 'change shape'],
    disabledReason: modelToolsOff ? MODEL_TOOLS_ON_DRAWING : parts.editBlocked,
    run: parts.editSelected,
    testId: 'ribbon-edit-part',
  }

  const modelInPlace: RibbonCommand | null = parts.modelInPlace
    ? {
        id: 'model-in-place',
        label: 'Model in place',
        icon: Box,
        description: 'Click a spot in a plan or the 3D model, then draw the part there in the part editor; Save places it, Publish makes it reusable',
        keywords: ['in place', 'in-place', 'massing', 'generic model', 'one-off', 'part editor', 'extrude'],
        disabledReason: modelToolsOff ? MODEL_TOOLS_ON_DRAWING : parts.newBlocked,
        run: parts.modelInPlace,
        testId: 'ribbon-model-in-place',
      }
    : null

  const tabs: RibbonTab[] = [
    {
      id: 'model',
      label: 'Model',
      groups: [
        select,
        {
          id: 'create',
          label: 'Create',
          tool: {
            value: ctx.tool === 'place' ? 'place' : ctx.tool === 'route' ? (ctx.routeAs && ctx.routeKind === 'pipe' ? 'route-pipe' : 'route') : '',
            onValueChange: (v) => (v === 'route-pipe' ? routeAs('pipe') : v === 'route' ? routeAs('duct') : ctx.chooseTool(v === 'place' ? v : 'select')),
            ariaLabel: 'Create',
          },
          commands: [
            tool('place', 'Place part', PackagePlus, 'Add equipment, air devices, receptacles, panels, lights or fixtures', true, ['equipment', 'fixture', 'diffuser', 'insert', 'component']),
            ...(ctx.routeAs
              ? [
                  { ...tool('route', 'Route duct', Route, 'Route duct between parts, with the fittings it needs; it can finish with flex into a device', true, ['duct', 'run', 'draw', 'supply', 'return', 'exhaust', 'flex', 'flexible']), run: () => routeAs('duct') },
                  { id: 'route-pipe', label: 'Route pipe', icon: Spline, description: 'Route pipe (water, sanitary, vent, storm, gas) with the fittings it needs', keywords: ['pipe', 'piping', 'plumbing', 'run', 'draw'], disabledReason: modelToolReason(true), run: () => routeAs('pipe'), testId: 'ribbon-tool-route-pipe' },
                ]
              : [tool('route', 'Route', Route, 'Route duct or pipe between parts, with the fittings it needs', true, ['duct', 'pipe', 'run', 'draw'])]),
          ],
        },
        ...(ctx.ceiling ? [{ id: 'build', label: 'Build', commands: [ctx.ceiling] }] : []),
        { id: 'parts', label: 'Parts', commands: [newPart, ...(modelInPlace ? [modelInPlace] : []), editPart] },
        {
          id: 'datum',
          label: 'Datum',
          commands: [
            { id: 'levels', label: 'Add level', icon: Layers, description: 'Add a level (a storey) at an elevation you type or take from a roof or floor you click', keywords: ['storey', 'floor', 'datum', 'pick surface', 'roof'], disabledReason: modelToolsOff ? MODEL_TOOLS_ON_DRAWING : ctx.editBlocked, run: ctx.addLevel, testId: 'ribbon-add-level' },
            { id: 'mounting-plane', label: 'Mounting plane', icon: SquareDashed, description: 'A flat surface at a height above a level to place diffusers and grilles on where there is no ceiling; parts on it move with it', keywords: ['no ceiling', 'open ceiling', 'diffuser', 'register', 'datum'], disabledReason: modelToolsOff ? MODEL_TOOLS_ON_DRAWING : ctx.editBlocked, run: ctx.addMountingPlane, testId: 'ribbon-mounting-plane' },
            { id: 'levels-architect', label: "Architect's levels", icon: Building2, description: "Make a level for each storey in the architect's linked model, at its height here. Shows what changes first; run it again after the architect moves a floor", keywords: ['storey', 'storeys', 'ifc', 'linked levels', 'sync levels', 'copy monitor'], disabledReason: ctx.editBlocked, run: ctx.useArchitectLevels, testId: 'ribbon-architect-levels' },
            { id: 'levels-show', label: 'Show levels', icon: Rows3, description: 'Draw each level in 3D as a faint outline with its name and height', keywords: ['level planes', 'datum'], pressed: ctx.showLevels, disabledReason: ctx.model3dOpen ? null : 'Levels draw in the 3D model; sections show them as level lines.', run: () => ctx.setShowLevels(!ctx.showLevels), testId: 'ribbon-show-levels' },
          ],
        },
        {
          id: 'display',
          label: 'Display',
          commands: [
            { id: 'fit', label: 'Fit', icon: Maximize, description: 'Fit everything in view', shortcut: 'F', keywords: ['zoom', 'extents', 'home'], disabledReason: ctx.drawingOpen ? `${ctx.drawingOpen === 'sheet' ? 'Sheets' : 'Drawings'} fit with the zoom control above the drawing (0).` : null, run: ctx.fit },
            { id: 'roof', label: 'Lift the roof off', icon: Eye, description: 'Cut the model just above the new work so you can see in', keywords: ['section box', 'hide roof'], pressed: ctx.roofOff, disabledReason: ctx.model3dOpen ? null : 'Works in the 3D model. Open it from the Views and sheets panel.', run: () => ctx.setRoofOff(!ctx.roofOff) },
            {
              id: 'projection',
              label: 'Orthographic',
              icon: Axis3d,
              description: ctx.projection?.value === 'orthographic' ? 'Parallel view is on: cube faces are true elevations, corners true isometrics. Press to go back to perspective' : 'Parallel (orthographic) 3D view instead of perspective',
              shortcut: PROJECTION_SHORTCUT,
              keywords: ['perspective', 'parallel', 'isometric', 'axonometric', 'projection', 'camera'],
              pressed: ctx.projection?.value === 'orthographic',
              disabledReason: ctx.projection ? null : 'Works in 3D views. Plans, sections on paper and sheets are always orthographic.',
              run: ctx.projection?.toggle,
              testId: 'ribbon-projection',
            },
            { id: 'stats', label: 'Performance', icon: Activity, description: 'Show frames per second and draw calls', keywords: ['fps'], pressed: ctx.showStats, run: () => ctx.setShowStats(!ctx.showStats) },
            showOriginCommand(ctx),
          ],
        },
      ],
    },
    ...contributedTabs('ribbon-tab', ctx, select),
    annotateTab(ctx, select),
    modifyTab(ctx, select, modelToolReason(false)),
    {
      id: 'views',
      label: 'Views',
      groups: [
        select,
        {
          id: 'create',
          label: 'Create',
          commands: [
            { id: 'new', label: 'New view', icon: Plus, description: 'Make a plan, section, 3D view, detail view or sheet', disabledReason: ctx.editBlocked, children: newItems, testId: 'new-view-or-sheet' },
            {
              id: 'new-3d-view-now',
              label: 'New 3D view',
              icon: Box,
              description: 'Save what you see now as a 3D view: this camera and the crop box that is cropping it',
              keywords: ['isometric', 'axon', 'save view', 'camera'],
              disabledReason: ctx.editBlocked,
              run: () => ctx.request({ kind: 'new_view', viewType: 'three_d' }),
              testId: 'ribbon-new-3d-view',
            },
            {
              id: 'section-cut',
              label: 'Section cut',
              icon: Scissors,
              description: ctx.planOpen ? 'Drag a cut line across this plan to make a section' : 'Opens a floor plan so you can draw where the section cuts',
              pressed: ctx.sectionDrawing,
              disabledReason: ctx.editBlocked,
              run: ctx.toggleSection,
              testId: 'ribbon-section-cut',
            },
          ],
        },
        {
          id: 'open',
          label: 'Open',
          commands: [
            { id: 'open-3d', label: '3D model', icon: Box, description: 'Everything, live, in 3D', run: () => ctx.openModel('3d') },
            { id: 'open-plan', label: 'Top-down plan', icon: LayoutTemplate, description: 'All levels, looking down', run: () => ctx.openModel('plan') },
          ],
        },
        {
          id: 'graphics',
          label: 'Graphics',
          commands: [
            { id: 'view-lines', label: 'Lines and colours', icon: PenLine, description: 'Line weight for duct, pipe, walls and each linked model, hidden lines and visual style for the open view', keywords: ['line weight', 'pen', 'pen weight', 'halftone', 'linework'], disabledReason: ctx.viewGraphics ? null : 'Open a saved plan, section or 3D view to set how it draws.', run: ctx.viewGraphics?.lines, testId: 'ribbon-view-lines' },
            { id: 'view-range', label: 'What this view shows', icon: ArrowUpDown, description: 'The top, cut height, bottom and depth of the open plan, for our model and the linked models', keywords: ['cut plane', 'cut height', 'view depth', 'bottom', 'top'], disabledReason: ctx.viewGraphics?.range ? null : 'Open a saved floor or ceiling plan to set its top, cut and bottom.', run: ctx.viewGraphics?.range ?? undefined, testId: 'ribbon-view-range' },
            { id: 'view-linked', label: 'Linked model look', icon: Link2, description: 'Halftone, hide what is underneath, leave out small things, and pens for the linked models in the open view', keywords: ['halftone', 'underlay', 'linked models', 'architect', 'simplify', 'furniture'], disabledReason: ctx.viewGraphics?.linked ? null : ctx.viewGraphics ? 'This project has no linked models in view.' : 'Open a saved view to set how its linked models draw.', run: ctx.viewGraphics?.linked ?? undefined, testId: 'ribbon-view-linked' },
          ],
        },
        {
          id: 'crop',
          label: 'Crop',
          commands: ctx.crop3d ? crop3dCommands(ctx.crop3d) : [
            {
              id: 'crop-view',
              label: 'Crop view',
              icon: Crop,
              description: 'Show only what is inside the crop box, as it prints',
              pressed: ctx.crop?.on ?? false,
              disabledReason: ctx.crop ? ctx.editBlocked : 'Open a saved view to crop it.',
              run: () => ctx.crop?.set({ cropView: !ctx.crop.on }),
            },
            {
              id: 'crop-show',
              label: 'Show crop box',
              icon: Frame,
              description: 'Draw the crop box so you can drag its edges',
              pressed: ctx.crop?.shown ?? false,
              disabledReason: ctx.crop ? ctx.editBlocked : 'Open a saved view to show its crop box.',
              run: () => ctx.crop?.set({ showCropBox: !ctx.crop.shown }),
            },
            { id: 'crop-3d-selection', label: 'Crop to selection', icon: Focus, description: 'Fit the 3D crop box to the storey and grid bay around what is selected', disabledReason: OPEN_3D_TO_CROP, testId: 'ribbon-crop-3d-selection' },
            { id: 'crop-3d-reset', label: 'Reset crop', icon: Expand, description: 'Put the 3D crop box back around the whole model', disabledReason: OPEN_3D_TO_CROP, testId: 'ribbon-crop-3d-reset' },
            { id: 'crop-3d-align', label: 'Align crop box', icon: RotateCw, description: 'Turn the 3D crop box to the working angle or a building edge', disabledReason: OPEN_3D_TO_CROP, testId: 'ribbon-crop-3d-align' },
          ],
        },
      ],
    },
    {
      id: 'sheets',
      label: 'Sheets',
      groups: [
        select,
        {
          id: 'sheet',
          label: 'Sheet',
          commands: [
            { id: 'sheet-new', label: 'New sheet', icon: FileText, description: 'A sheet with a title block to place views on', disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'new_sheet' }) },
            { id: 'sheet-title-block', label: 'Title block', icon: Pencil, description: 'Edit the sheet number, name and title block fields', disabledReason: ctx.sheet ? ctx.editBlocked : 'Open a sheet to edit its title block.', run: ctx.sheet?.editTitleBlock },
            { id: 'sheet-arrange', label: 'Arrange views', icon: LayoutGrid, description: "Place the sheet's views and schedules in rows or a grid inside the border", keywords: ['layout', 'auto layout', 'viewports'], disabledReason: ctx.sheet ? ctx.editBlocked : 'Open a sheet to arrange its views.', run: ctx.sheet?.arrange, testId: 'ribbon-sheet-arrange' },
            { id: 'sheet-revisions', label: 'Revisions', icon: ListOrdered, description: "Edit the sheet's revision table", keywords: ['revision table', 'rev', 'title block'], disabledReason: ctx.sheet ? ctx.editBlocked : 'Open a sheet to edit its revisions.', run: ctx.sheet?.revisions, testId: 'ribbon-sheet-revisions' },
            { id: 'sheet-project-info', label: 'Project info', icon: ClipboardList, description: "The project's name, number, address, people, issue date and status, filled in once and printed on every sheet", keywords: ['title block', 'project parameters', 'date', 'status', 'address', 'client', 'engineer of record'], run: () => ctx.request({ kind: 'project_info' }), testId: 'ribbon-sheet-project-info' },
            { id: 'sheet-agent-make', label: 'With the agent', icon: Sparkles, description: 'Open Cmd+J with a drafted request to make sheets, views and schedules by script: edit it and send it; nothing changes until you approve', keywords: ['agent', 'script', 'sheets per level', 'drawing set', 'automate', 'views', 'schedules'], disabledReason: ctx.editBlocked, run: () => ctx.request({ kind: 'agent_make' }), testId: 'ribbon-sheet-agent-make' },
          ],
        },
        {
          id: 'figures',
          // Disabled with no sheet open: the caption says why, not only the tooltip.
          label: ctx.sheet ? 'Figures' : 'Figures · open a sheet first',
          commands: [
            { id: 'sheet-chart', label: 'Chart', icon: ChartLine, description: 'Put a live chart on the sheet (the Hunter curve): drawn from the model every time it shows or prints', keywords: ['hunter curve', 'graph', 'demand curve', 'figure'], disabledReason: ctx.sheet?.chart ? ctx.editBlocked : 'Open a sheet to place a chart: Views and sheets › a sheet.', run: ctx.sheet?.chart, testId: 'ribbon-sheet-chart' },
            { id: 'sheet-picture', label: 'Picture', icon: ImagePlus, description: 'Put a PNG or JPEG on the sheet (a logo, a photo, a key plan); it is kept in the project workspace and prints in the PDF', keywords: ['image', 'logo', 'photo', 'png', 'jpeg', 'figure'], disabledReason: ctx.sheet?.picture ? ctx.editBlocked : 'Open a sheet to place a picture: Views and sheets › a sheet.', run: ctx.sheet?.picture, testId: 'ribbon-sheet-picture' },
            {
              id: 'sheet-live-table',
              label: 'Live table',
              icon: Table2,
              description: 'Put a live table on the sheet (load summary, ventilation, pressurization, gas): drawn from the model with every edit and frozen when the set is issued',
              keywords: ['table', 'schedule', 'block', 'figure'],
              // New live tables go in this menu: Figures must stay under the five-control cap with every table named, not folded under More.
              children: [
                { id: 'sheet-load-summary', label: 'Load summary', icon: Sigma, description: 'Put the live electrical load summary on the sheet: total connected kVA and amps at the service, updated with every edit and frozen when the set is issued', keywords: ['load study', 'block', 'kva', 'amps', 'service'], disabledReason: ctx.sheet?.loadSummary ? ctx.editBlocked : 'Open a sheet to place a load summary: Views and sheets › a sheet.', run: ctx.sheet?.loadSummary, testId: 'ribbon-sheet-load-summary' },
                { id: 'sheet-keynote-list', label: 'Keynote list', icon: KeyRound, description: 'Put the keynote list on the sheet: each keynote used on the views placed here, with its words, updated with every edit and frozen when the set is issued', keywords: ['keynotes', 'legend', 'general notes', 'key notes'], disabledReason: ctx.sheet?.placeTable ? ctx.editBlocked : 'Open a sheet to place a keynote list: Views and sheets › a sheet.', run: ctx.sheet?.placeTable ? () => ctx.sheet?.placeTable?.((sheet, submit) => placeKeynoteList(sheet, submit)) : undefined, testId: 'ribbon-sheet-keynote-list' },
                ...contributedCommands('sheet-live-table', ctx),
                calculationCommand(ctx.sheet?.calculation, ctx.editBlocked),
              ],
              testId: 'ribbon-sheet-live-table',
            },
          ],
        },
        {
          id: 'issue',
          label: ctx.sheet || !ctx.hasSheets ? 'Issue' : 'Issue · open a sheet to print it',
          commands: [
            {
              id: 'print-pdf',
              label: 'Print PDF',
              icon: Printer,
              description: ctx.sheet ? `Print ${ctx.sheet.number} to a vector PDF at scale` : 'Print a sheet to a vector PDF at scale',
              keywords: ['export', 'pdf', 'issue'],
              disabledReason: ctx.sheet ? null : 'Open a sheet from the Views and sheets panel to print it.',
              run: ctx.sheet?.print,
              testId: 'print-pdf',
            },
            { id: 'print-set', label: 'Print set', icon: Printer, description: 'Print the drawing set to one PDF, a page per sheet, at scale', keywords: ['set', 'pdf', 'plot'], disabledReason: ctx.hasSheets ? null : 'Make a sheet first: Views and sheets › +.', run: () => ctx.request({ kind: 'print_set' }), testId: 'ribbon-print-set' },
            { id: 'issue-set', label: 'Issue set', icon: Stamp, description: 'Check the set against its last print, add the revision row and issue it', keywords: ['issue', 'revision', 'permit', 'transmittal'], disabledReason: ctx.hasSheets ? ctx.editBlocked : 'Make a sheet first: Views and sheets › +.', run: () => ctx.request({ kind: 'issue_set' }), testId: 'ribbon-issue-set' },
            {
              id: 'print-black-only',
              label: 'Black only',
              icon: Printer,
              description: ctx.printBlackOnly ? 'Sheets print black only, as a black-only plotter does: colours print black, halftone and fills stay grey. Press to print in colour' : 'Sheets print in colour. Press to print this project black only (colours black, halftone and fills grey), for Print PDF, Print set and Issue set',
              keywords: ['black and white', 'monochrome', 'plot', 'colour', 'color', 'print'],
              pressed: ctx.printBlackOnly === true,
              disabledReason: ctx.setPrintBlackOnly ? (ctx.hasSheets ? ctx.editBlocked : 'Make a sheet first: Views and sheets › +.') : 'Black-only printing is not available here.',
              run: () => ctx.setPrintBlackOnly?.(!ctx.printBlackOnly),
              testId: 'ribbon-print-black-only',
            },
            { id: 'export-ifc', label: 'Export IFC', icon: FileBox, description: 'Write the saved model as an IFC 4.3 file that other BIM and coordination software and contractors open: spaces, zones, systems and every element with its parameters', keywords: ['ifc', 'export', 'bim', 'coordination', 'ifc4', 'open bim'], disabledReason: null, run: () => ctx.request({ kind: 'export_ifc' }), testId: 'ribbon-export-ifc' },
          ],
        },
      ],
    },
    {
      id: 'manage',
      label: 'Manage',
      groups: [
        select,
        {
          id: 'project',
          label: 'Project',
          commands: [
            {
              id: 'part-types',
              label: 'Part types',
              icon: PackagePlus,
              description: 'The part catalog: browse and place a part, or draw a new part type',
              keywords: ['catalog', 'library', 'types'],
              children: [
                { id: 'part-types-browse', label: 'Browse and place', icon: PackagePlus, description: 'Open the catalog in Place part', keywords: ['catalog'], disabledReason: modelToolReason(true), run: () => ctx.chooseTool('place'), testId: 'ribbon-part-types-browse' },
                { ...newPart, id: 'part-types-new', testId: 'ribbon-part-types-new' },
                { ...editPart, id: 'part-types-edit', label: 'Edit the selected part', testId: 'ribbon-part-types-edit' },
              ],
              testId: 'ribbon-part-types',
            },
            { id: 'link', label: 'Link a model', icon: Link2, description: ctx.linkDescription ?? "Bring in the architect's model from Autodesk Docs or an IFC file", keywords: ['ifc', 'linked models', 'reference'], disabledReason: ctx.linkUnavailableReason ?? (ctx.canLink ? null : "Linking needs edit access to this project's model; ask a project lead."), run: ctx.openLink },
            ...(ctx.openConnectAgent ? [{ id: 'connect-agent', label: 'Connect an agent', icon: Plug, description: 'Connect Claude, Cursor, ChatGPT or another agent: the core and each pack as its own connection, with a copy button', keywords: ['agent', 'mcp', 'claude', 'cursor', 'chatgpt', 'connect', 'pack', 'api'], disabledReason: null, run: ctx.openConnectAgent, testId: 'ribbon-connect-agent' }] : []),
          ],
        },
        coordinatesGroup(ctx),
        {
          id: 'groups-phases',
          label: 'Groups & phases',
          commands: [
            { id: 'manage-groups', label: 'Groups', icon: Group, description: 'Create, rename, colour, lock and delete groups', keywords: ['group', 'lock', 'existing', 'new work', 'demolition', 'coordination'], run: ctx.organization.openGroups, testId: 'ribbon-manage-groups' },
            { id: 'manage-phases', label: 'Phases', icon: History, description: 'Add, rename and reorder phases (Existing, New construction…)', keywords: ['phase', 'existing', 'new construction', 'demolish'], run: ctx.organization.openPhases, testId: 'ribbon-manage-phases' },
            { id: 'phase-filters', label: 'Phase filters', icon: Filter, description: 'How new, existing, demolished and temporary work draws in views', keywords: ['phase filter', 'show all', 'show new', 'existing', 'demo', 'halftone', 'dashed'], run: ctx.organization.openFilters, testId: 'ribbon-phase-filters' },
            ...(ctx.organization.openConstructionStages ? [{ id: 'construction-stages', label: 'Construction stages', icon: History, description: 'The order the building goes up in: add, rename, reorder and delete stages; takeoffs total by stage', keywords: ['stage', 'sequence', 'takeoff', 'work area', 'schedule of values', 'quantities'], run: ctx.organization.openConstructionStages, testId: 'ribbon-construction-stages' }] : []),
          ],
        },
        ...(ctx.organization.openAddons
          ? [
              {
                id: 'model-settings',
                label: 'Model settings',
                commands: [
                  { id: 'model-addons', label: 'Add-ons', icon: PackagePlus, description: 'Switch Preview add-ons (Structural, Civil) on or off for this model', keywords: ['add-on', 'structural', 'civil', 'preview', 'pack'], run: ctx.organization.openAddons, testId: 'ribbon-model-addons' },
                  ...(ctx.organization.openCodes ? [{ id: 'model-codes', label: 'Codes', icon: BookOpenCheck, description: "The project's code of record for each discipline, and where the project is; approvals say which code they were checked against", keywords: ['code', 'code of record', 'ibc', 'edition', 'jurisdiction', 'adoption', 'checked against'], run: ctx.organization.openCodes, testId: 'ribbon-model-codes' }] : []),
                ],
              },
            ]
          : []),
        ...(ctx.history
          ? [
              {
                id: 'versions-signoff',
                label: 'Versions & sign-off',
                commands: [
                  { id: 'manage-versions', label: 'Versions', icon: GitBranch, description: 'Saved versions and issued sets: save one, start a branch from one, say what kind of change it was', keywords: ['version', 'branch', 'history', 'save version', 'issued set', 'option', 'what kind of change'], run: ctx.history.openVersions, testId: 'ribbon-manage-versions' },
                  { id: 'manage-responsibilities', label: 'Responsibilities', icon: UserCheck, description: 'Who is responsible for each discipline and part of it; they accept, and approve merges of their parts', keywords: ['responsible', 'engineer of record', 'approve', 'merge', 'sign-off', 'architect of record'], run: ctx.history.openResponsibilities, testId: 'ribbon-manage-responsibilities' },
                  { id: 'manage-change-orders', label: 'Change orders', icon: FilePen, description: 'Open a change order since a version or for a branch, addressed to a contact or company; they accept, refuse or mark it no cost', keywords: ['change order', 'co', 'refuse', 'no cost', 'owner requested', 'quantity change'], run: ctx.history.openChangeOrders, testId: 'ribbon-manage-change-orders' },
                  ...(ctx.history.openCopies ? [{ id: 'manage-copies', label: 'Copies', icon: Copy, description: 'Contractor and shop-drawing copies: name who works in each, review what they changed, accept chosen records back', keywords: ['contractor', 'shop drawings', 'submittal', 'coordination', 'accept back', 'review', 'copy', 'people'], run: ctx.history.openCopies, testId: 'ribbon-manage-copies' }] : []),
                ],
              },
            ]
          : []),
        ...(ctx.coordination
          ? [
              {
                id: 'coordination',
                label: 'Coordination',
                commands: [
                  {
                    id: 'coordination',
                    label: 'Coordination',
                    icon: ShieldAlert,
                    description: 'Opens the Checklist: what the code studies say each room still needs, clashes with our work and linked models, and questions; select one, record a decision, override with a reason, or accept a finding with a reason',
                    keywords: ['checklist', 'requirements', 'code study', 'what is left', 'clash', 'clash detection', 'interference', 'collision', 'lint', 'coordinated', 'outside building', 'floating', 'linked model'],
                    run: ctx.coordination.open,
                    testId: 'ribbon-manage-coordination',
                  },
                ],
              },
            ]
          : []),
      ],
    },
  ]

  const sel = ctx.selection
  if (sel?.kind === 'part') {
    tabs.push({
      id: 'selection',
      label: 'Part',
      contextual: true,
      groups: [
        select,
        {
          id: 'part',
          label: sel.label,
          commands: [
            { id: 'rotate-cw', label: 'Rotate 90°', icon: RotateCw, description: 'Turn the part a quarter turn clockwise', disabledReason: ctx.editBlocked, run: () => ctx.rotateSelected(90) },
            { id: 'rotate-ccw', label: 'Rotate −90°', icon: RotateCcw, description: 'Turn the part a quarter turn back', disabledReason: ctx.editBlocked, run: () => ctx.rotateSelected(-90) },
            { id: 'move-part', label: 'Move', icon: Move, description: 'Drag it to a new spot', shortcut: TOOL_SHORTCUTS.move, disabledReason: ctx.editBlocked, run: () => ctx.chooseTool('move') },
            { id: 'edit-type', label: 'Edit type', icon: Pencil, description: 'Change the values every part of this type shares', disabledReason: ctx.editBlocked, run: ctx.editType },
            ...createSimilarCommand(ctx, 'Place another of this type on its level, at its height'),
            { id: 'delete-part', label: 'Delete…', icon: Trash2, description: 'Delete it (asks first; undo brings it back)', shortcut: 'Del', disabledReason: ctx.editBlocked, run: ctx.deleteSelected },
          ],
        },
        { id: 'done', label: 'Selection', commands: [{ id: 'deselect', label: 'Deselect', icon: X, description: 'Clear the selection', shortcut: 'Esc', run: ctx.clearSelection }] },
      ],
    })
  } else if (sel?.kind === 'run') {
    tabs.push({
      id: 'selection',
      label: sel.domain === 'pipe' ? 'Pipe run' : 'Duct run',
      contextual: true,
      groups: [
        select,
        {
          id: 'run',
          label: sel.label,
          commands: [
            { id: 'resize-run', label: 'Resize', icon: Maximize, description: 'Change its size or shape (the fittings follow; transitions where it meets another size)', disabledReason: ctx.editBlocked, run: ctx.resizeSelected },
            ...(sel.fitting ? [] : [{ id: 'split-run', label: 'Split', icon: Scissors, description: 'Click along the run to split it there (resize a stretch between two splits)', shortcut: TOOL_SHORTCUTS.split, keywords: ['cut', 'break', 'divide'], pressed: ctx.tool === 'split', disabledReason: ctx.editBlocked, run: ctx.splitSelected, testId: 'ribbon-split' }]),
            ...(sel.domain === 'duct' && sel.fitting
              ? [{ id: 'fitting-type', label: 'Fitting type', icon: Shapes, description: 'Choose the fitting (radius elbow, mitered, tee…) and its loss coefficient', keywords: ['elbow', 'tee', 'transition', 'coefficient', 'smacna', 'ashrae'], disabledReason: ctx.editBlocked, run: ctx.chooseFittingType }]
              : []),
            ...(sel.domain === 'duct'
              ? [
                  {
                    id: 'duct-design',
                    label: 'Reducers and insulation',
                    icon: FlipVertical2,
                    description: 'Reducer shape (centred, or flat on top or bottom) and the wrap or liner on this run',
                    keywords: ['eccentric', 'concentric', 'reducer', 'transition', 'wrap', 'liner', 'insulation'],
                    disabledReason: ctx.editBlocked,
                    testId: 'ribbon-duct-design',
                    children: [
                      { id: 'reducer-shape', label: 'Reducer shape', icon: FlipVertical2, description: sel.fitting ? 'Make this reducer centred, or flat on top or bottom (eccentric)' : 'Reducers centred or flat on top or bottom (eccentric): press Tab to select the run, then pick where it meets another size', keywords: ['eccentric', 'concentric', 'flat on top', 'flat on bottom', 'transition', 'reducer'], disabledReason: ctx.editBlocked, run: ctx.reducerShape, testId: 'ribbon-reducer-shape' },
                      { id: 'run-insulation', label: 'Insulation', icon: Layers, description: 'Wrap or liner on this run; Make system default gives new runs on its system the same', keywords: ['wrap', 'liner', 'lining', 'insulation default', 'system default'], disabledReason: ctx.editBlocked, run: ctx.focusRunInsulation, testId: 'ribbon-run-insulation' },
                    ],
                  },
                ]
              : []),
            ...(sel.domain === 'duct'
              ? [{ id: 'pressure', label: 'Pressure', icon: Gauge, description: "Velocity, friction and loss here, and the fan's external static pressure", keywords: ['static', 'esp', 'friction', 'velocity', 'critical path'], run: ctx.showPressure }]
              : []),
            ...createSimilarCommand(ctx, `Route another ${sel.domain} like this: same system, size${sel.domain === 'pipe' ? ', material and slope' : ' and insulation'}, at its height`),
            { id: 'delete-run', label: 'Delete…', icon: Trash2, description: 'Delete it, or it and what depends on it (asks first)', shortcut: 'Del', disabledReason: ctx.editBlocked, run: ctx.deleteSelected },
          ],
        },
        { id: 'done', label: 'Selection', commands: [{ id: 'deselect', label: 'Deselect', icon: X, description: 'Clear the selection', shortcut: 'Esc', run: ctx.clearSelection }] },
      ],
    })
  } else if (sel?.kind === 'group') {
    tabs.push({
      id: 'selection',
      label: 'Selection',
      contextual: true,
      groups: [
        select,
        {
          id: 'group',
          label: sel.label,
          commands: [
            { id: 'move-group', label: 'Move', icon: Move, description: 'Move the selection by a distance (connected runs follow; fixed parts refuse)', disabledReason: ctx.editBlocked ?? (sel.movable > 0 ? null : 'Nothing in this selection moves on its own.'), run: ctx.moveSelected, testId: 'ribbon-move-group' },
            { id: 'resize-group', label: 'Resize', icon: Maximize, description: 'Give every duct or pipe piece a new size or shape in one edit, with transitions where neighbours differ', disabledReason: ctx.editBlocked ?? (sel.runs > 0 ? null : 'There is no routed duct or pipe in this selection.'), run: ctx.resizeSelected, testId: 'ribbon-resize-group' },
            { id: 'reducer-shape-group', label: 'Reducer shape', icon: FlipVertical2, description: 'Centred, or flat on top or bottom (eccentric), where a new size meets the old', keywords: ['eccentric', 'concentric', 'transition', 'reducer'], disabledReason: ctx.editBlocked ?? (sel.runs > 0 ? null : 'There is no routed duct or pipe in this selection.'), run: ctx.reducerShape, testId: 'ribbon-reducer-shape-group' },
            { id: 'delete-group', label: 'Delete…', icon: Trash2, description: `Delete all ${sel.count} (asks first; undo brings them back)`, shortcut: 'Del', disabledReason: ctx.editBlocked, run: ctx.deleteSelected, testId: 'ribbon-delete-group' },
            { id: 'deselect', label: 'Deselect', icon: X, description: 'Clear the selection', shortcut: 'Esc', run: ctx.clearSelection },
          ],
        },
      ],
    })
  } else if (sel?.kind === 'branch') {
    tabs.push({
      id: 'selection',
      label: 'Branch',
      contextual: true,
      groups: [
        select,
        {
          id: 'branch',
          label: sel.label,
          commands: [
            { id: 'resize-branch', label: 'Resize', icon: Maximize, description: 'Change the trunk size in the properties panel', disabledReason: ctx.editBlocked, run: ctx.resizeSelected },
            { id: 'deselect', label: 'Deselect', icon: X, description: 'Clear the selection (drag the branch in the view to slide it)', shortcut: 'Esc', run: ctx.clearSelection },
          ],
        },
      ],
    })
  }
  tabs.push(...contributedTabs('contextual-tab', ctx, select))
  const route = ctx.route
  if (route) {
    tabs.push({
      id: 'route',
      label: 'Route',
      contextual: true,
      groups: [
        select,
        {
          id: 'height',
          label: 'Height',
          commands: [
            { id: 'rise', label: 'Rise 1 ft', icon: ArrowUp, description: 'Rise at the current point (or type a new height)', shortcut: ']', disabledReason: route.riseBlocked, run: () => route.rise(1), testId: 'ribbon-route-rise' },
            { id: 'drop', label: 'Drop 1 ft', icon: ArrowDown, description: 'Drop at the current point', shortcut: '[', disabledReason: route.riseBlocked, run: () => route.rise(-1), testId: 'ribbon-route-drop' },
            { id: 'rise-45', label: route.riseStyle === 'vertical' || route.riseStyle === '45' ? '45° rises' : `${riseStyleLabel(route.riseStyle).replace(' slope', '')} rises`, icon: CornerDownRight, description: route.riseStyle !== 'vertical' ? `Rises and drops slope at ${riseStyleLabel(route.riseStyle).replace(' slope', '')} (two elbows of that angle); press for straight up and down. Other slopes: Route › Rises and drops` : 'Rises and drops go straight up and down (two 90° elbows); press for 45° slopes', pressed: route.riseStyle !== 'vertical', run: () => route.setRiseStyle(route.riseStyle !== 'vertical' ? 'vertical' : '45'), testId: 'ribbon-route-45' },
          ],
        },
        {
          id: 'axis',
          label: 'Axis',
          commands: [
            ...(['x', 'y', 'z'] as const).map((a) => ({
              id: `lock-${a}`,
              label: a.toUpperCase(),
              ariaLabel: `Lock to ${a.toUpperCase()}`,
              icon: a === 'z' ? ArrowUp : MoveHorizontal,
              description: a === 'z' ? 'Draw straight up or down from the last point (Shift does the same while held)' : `Draw ${a === 'x' ? 'east-west' : 'north-south'} only`,
              shortcut: a.toUpperCase(),
              pressed: route.lock === a,
              run: () => route.setLock(a),
              testId: `ribbon-route-lock-${a}`,
            })),
            {
              id: 'lock-free',
              label: 'Any angle',
              icon: Compass,
              description: 'Duct legs snap to 15°, 22.5°, 30°, 45°, 60° and 90°; press (or hold Alt / Option) to draw at any angle. The elbow is made to the angle.',
              shortcut: 'Alt',
              pressed: route.lock === 'free',
              run: () => route.setLock('free'),
              testId: 'ribbon-route-lock-free',
            },
          ],
        },
        {
          id: 'route-fittings',
          label: 'Fittings',
          commands: [
            { id: 'route-elbow', label: 'Elbow type', icon: Spline, description: 'Choose the elbows this route places (radius, mitred with vanes, gored…)', run: route.chooseElbow, testId: 'ribbon-route-elbow' },
            { id: 'route-takeoff', label: 'Takeoff type', icon: SquareSplitHorizontal, description: 'Choose the tap, tee or wye a branch starts with', run: route.chooseTakeoff },
            { id: 'route-around', label: 'Offset around', icon: CornerDownRight, description: 'Pick the beam, pipe or wall in the way: the leg rises over it and comes back down', shortcut: 'O', pressed: route.offsetArmed, run: route.armOffset, testId: 'ribbon-route-around' },
          ],
        },
        {
          id: 'route-finish',
          label: 'Finish',
          commands: [
            { id: 'route-done', label: 'Finish here', icon: Check, description: 'End the route at the last point', shortcut: 'Enter', disabledReason: route.finishBlocked, run: route.finish },
            { id: 'route-cancel', label: 'Cancel', icon: X, description: 'Drop the route being drawn; nothing is saved', shortcut: 'Esc', run: route.cancel },
          ],
        },
      ],
    })
  }
  const drawn = drawnItemsTab(ctx, select, modelToolReason(false))
  if (drawn) tabs.push(drawn)
  const analyze = addonTabAnalyzeCommands(ctx)
  const withAnalyze = tabs.map((tab) => (analyze[tab.id] && isTradeTab(tab) ? withTradeSectionCommands(tab, 'analyze', analyze[tab.id] ?? []) : tab))
  return withPlanGroups(withScheduleGroups(withAnalyze, ctx.schedules), ctx.plan, { ...addonTabPlanCommands(ctx), model: contributedCommands('model-plan', ctx) })
}

function originOff(ctx: BuildingModelRibbonContext): boolean {
  return ctx.drawingOpen !== null && !ctx.liveViewOnDrawing
}

function showOriginCommand(ctx: BuildingModelRibbonContext): RibbonCommand {
  return {
    id: 'show-origin',
    label: 'Show origin & axes',
    icon: Axis3d,
    description: 'Show the origin marker with its X, Y and Z axes running to the edges of the view, and its site coordinates',
    keywords: ['origin', 'axes', 'base point', 'triad', 'coordinates'],
    pressed: ctx.coordinates.showOrigin,
    disabledReason: originOff(ctx) ? OPEN_MODEL_FOR_ORIGIN : null,
    run: () => {
      if (ctx.liveViewOnDrawing) ctx.showLiveModel()
      ctx.coordinates.setShowOrigin(ctx.liveViewOnDrawing ? true : !ctx.coordinates.showOrigin)
    },
    testId: 'ribbon-show-origin',
  }
}

function coordinatesGroup(ctx: BuildingModelRibbonContext): RibbonGroup {
  const c = ctx.coordinates
  const orientationOff = c.orientation ? ctx.editBlocked : OPEN_A_PLAN_FOR_ORIENTATION
  return {
    id: 'coordinates',
    label: 'Coordinates',
    commands: [
      {
        id: 'move-origin',
        label: 'Move origin',
        icon: Move3d,
        description: 'The origin marker follows the pointer (snapping to parts and run ends); click to place it, then say whether only the marker moves or the building moves on the site. Also on the marker: right-click or double-click it',
        keywords: ['project origin', 'project base point', 'relocate', 'shared coordinates'],
        pressed: c.moving,
        disabledReason: originOff(ctx) ? OPEN_MODEL_FOR_ORIGIN : ctx.editBlocked,
        run: () => {
          if (ctx.liveViewOnDrawing) ctx.showLiveModel()
          c.toggleMove()
        },
        testId: 'ribbon-move-origin',
      },
      {
        id: 'coordinates-dialog',
        label: 'Coordinates',
        icon: Compass,
        description: 'See or set the project origin, the site point, true north and the working angle, with a picture of what each one is',
        keywords: ['project base point', 'survey point', 'true north', 'working angle', 'site coordinates'],
        children: [
          { id: 'coord-origin', label: 'Project origin…', icon: Move3d, description: 'Where drawings and site coordinates are measured from', run: c.openOrigin, testId: 'ribbon-coord-origin' },
          {
            id: 'survey-point',
            label: 'Site point…',
            icon: MapPinned,
            description: 'Show the site point (a fixed mark on the land, from the survey) on the marker and see or set its site coordinates',
            keywords: ['survey point', 'shared site', 'site coordinates', 'northing', 'easting'],
            run: c.openSurveyPoint,
            testId: 'ribbon-survey-point',
          },
          {
            id: 'true-north',
            label: 'True north…',
            icon: Compass,
            description: 'Type the angle from plan north to true north, or pick two points along it',
            keywords: ['north', 'rotate', 'bearing', 'angle'],
            disabledReason: ctx.editBlocked,
            run: c.openTrueNorth,
            testId: 'ribbon-true-north',
          },
          { id: 'working-angle', label: 'Working angle…', icon: Axis3d, description: 'Type the angle the building is turned by, or put it back square', keywords: ['rotate project north', 'skewed', 'grid angle'], run: c.openWorkingAngle, testId: 'ribbon-working-angle' },
        ],
        testId: 'ribbon-coordinates',
      },
      {
        id: 'align-axes',
        label: 'Align axes to an edge',
        icon: Ruler,
        description: 'Click a wall, or two points along a building edge: route snaps, the placement grid, drafting ortho and new crop boxes turn to match it. Nothing moves',
        keywords: ['rotate project north', 'skewed building', 'working angle', 'user coordinate system', 'align grid'],
        pressed: c.aligningAxes,
        disabledReason: ctx.editBlocked,
        run: () => {
          if (ctx.liveViewOnDrawing) ctx.showLiveModel()
          c.alignAxes()
        },
        testId: 'ribbon-align-axes',
      },
      {
        id: 'view-orientation',
        label: 'View orientation',
        icon: Navigation2,
        description: c.orientation ? (c.orientation.value === 'working_angle' ? 'This plan is turned to the working angle' : `This plan is drawn with ${c.orientation.value === 'true_north' ? 'true' : 'plan'} north up`) : 'Turn a plan so plan north, true north or the working angle is up',
        keywords: ['true north', 'plan north', 'working angle', 'rotate view'],
        disabledReason: orientationOff,
        children: (['plan_north', 'true_north', 'working_angle'] as const).map((value) => ({
          id: `orientation-${value}`,
          label: ORIENTATION_LABEL[value],
          icon: c.orientation?.value === value ? Check : Square,
          description: ORIENTATION_HELP[value],
          pressed: c.orientation?.value === value,
          disabledReason: orientationOff,
          run: () => c.orientation?.set(value),
          testId: `ribbon-orientation-${value}`,
        })),
        testId: 'ribbon-view-orientation',
      },
    ],
  }
}

/** The Create similar button for a selection tab; absent when the surface doesn't offer it. */
function createSimilarCommand(ctx: BuildingModelRibbonContext, description: string): RibbonCommand[] {
  const run = ctx.createSimilar
  return run ? [{ id: 'create-similar', label: 'Create similar', icon: CopyPlus, description, shortcut: 'C S', keywords: ['cs', 'copy', 'same', 'another like this', 'duplicate'], disabledReason: ctx.editBlocked, run, testId: 'ribbon-create-similar' }] : []
}
