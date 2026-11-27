'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SheetTitle } from '../../contracts/building-model/sheet-title'
import { toast } from 'sonner'
import { escapeLeavesField, leftFieldHint } from '../escape-step'
import { ChevronDown, Eye, EyeOff, KeyRound, Circle, Cloud, Minus, MousePointer2, MoveHorizontal, PaintBucket, PenTool, Printer, Puzzle, Rainbow, Repeat, Spline, Square, SquareDashed, Tag, Trash2, Type, Hexagon, Waves, Waypoints, ZoomIn, ZoomOut } from 'lucide-react'
import { DEFAULT_ANNOTATION_CROP_OFFSET_MM, DEFAULT_HIGHLIGHTER_OPACITY, DEFAULT_MARKER_OPACITY, DEFAULT_NOTE_SIZE_MM, ELEV_RADIUS_MM, HEAD_RADIUS_MM, NORTH_ARROW_RADIUS_MM, boxToPaper, paperToBox, LEADER_ARROWS, NOTE_LIMITS, STANDARD_SCALES, calloutBoundaryPolygon, calloutHead, calloutLeaderAnchor, calloutSyncCommands, canonicalJson, chainOf, dimensionPoints, drawDimension, elementsOfKind, elevationMarkCenter, enlargedPlanCommands, gridBubbleEndpoints, layoutDraft, leaderPrimitives, leaderStart, noteAutoShoulderPaper, noteContentFingerprint, noteLabel, noteLeadersAfterMove, noteText, normalizeParagraphs, paragraphsForCommand, polygonBounds, referencingSheet, resolveNote, sectionMarkEndpoints, tagLines, textBlockToSvg, viewportNorthArrow, viewportTitleLayout, cropForWindow, detailItemBounds, documentIndex, frameForViewport, modelToPaper, paperWorkingAngleDeg, paperToModel, planReferenceViews, rectangleLines, sceneToSvg, scaleLabel, sheetViewports, viewCrop, viewOnPaper, viewportOnPaper, LOAD_SUMMARY_TEMPLATE, asElementId, blockFieldChoices, fieldBlockTemplateProblem, renderFieldBlock, type FieldBlockSpec, type DrawingItem, type DrawingShape, type ModelState, type NoteLeader, type NoteParagraph, type Primitive, type TextBlock, type Rect, type Vec2, type ViewElement, type ViewProps, type ViewFrame, type Viewport, type ViewBackgrounds, type ElementId, type TagSpec, scheduleViewColumns } from '@permitzip/bim-kernel'
import { distributionEquipment } from '@permitzip/bim-pack-electrical'
import type { Presence } from '@permitzip/bim-sync'
import { NOTE_LOCK_REFRESH_MS, PresenceClock, editingNoteActivity, lockMessage, noteLocks, type NoteLock } from '@permitzip/bim-sync/note-locks'
import { Button } from '../../ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Switch } from '../../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { CROP_HANDLES, HANDLE_CURSOR, HANDLE_LABEL, centerAndSize, dragRect, handlePoint, rectFromCenter, type CropHandle } from './crop-geometry'
import { VIEW_DRAG_TYPE, newId, type SubmitCommand } from './types'
import { useDrawingZoom } from './drawing-zoom'
import { NoteHandles, type NoteEdge } from './notes/NoteHandles'
import { useNoteFonts } from './notes/note-fonts'
import { PrintedPdfLayer } from './PrintedPdfLayer'
import { FigureProperties } from './FigureProperties'
import type { SheetImages } from './use-sheet-images'
import { EditingViewIndicator } from './EditingViewIndicator'
import { PROPERTIES_DEFAULT_WIDTH_PX, PROPERTIES_SURFACE, ResizableSideRail } from '../layout/ResizableSideRail'
import { KeynotePicker } from './KeynotePicker'
import { cleanKey, keynoteCommand } from './keynotes'
import { useDrawnScene, type DrawingTarget } from './use-drawn-scene'
import type { ModelEditBridge } from '../view-input/bridge'
import { ModelDrawingLayer } from '../view-input/ModelDrawingLayer'
import { LevelLinesLayer } from '../view-input/LevelLinesLayer'
import { PlaceOnDrawingLayer } from '../planned/PlaceOnDrawingLayer'
import { useTagElbows } from './tag-elbow/use-tag-elbows'
import { SelectionContextMenu } from './SelectionContextMenu'
import { useDrawingContextMenu } from './context-menu/use-drawing-context-menu'
import type { DrawingPlacementSpec } from '../placement'
import { SpacesPlanLayer, type DrawSpaceMode } from '../spaces/SpacesPlanLayer'
import type { SeparatorLine } from '../spaces/separator-tool'
import type { CeilingCanvasTool } from '../ceilings/use-ceiling-tool'
import { QuestionPinsLayer } from '../questions/QuestionPinsLayer'
import { FieldBlockProperties, type FieldBlockDraft } from '../blocks/FieldBlockProperties'
import { DiagramLayer } from '../diagrams/DiagramLayer'
import { AnnotationProperties } from './AnnotationProperties'
import { CalloutProperties, CalloutViewDialog } from './CalloutFields'
import { annotationBox, buildGraphicsSnapIndex, dimensionFromDrag, nearestSnap, nudgeEdits, nudgePaperStep, snapPoints, snapToGraphics, tagSpecFor, tagSpecLike, tagTargetAt, type GraphicsSnapHit, type SnapPoint } from './annotation-tools'
import { linkedDimensionAnchors } from '../linked-reference/linked-dimension-anchors'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'
import { DetailSelectionProperties } from './draft/DetailSelectionProperties'
import { DraftOptionsBar } from './draft/DraftOptionsBar'
import { DraftOverlay } from './draft/DraftOverlay'
import { isDraftShape, marqueeHits } from './draft/draft-input'
import { useDraftController, type DraftController } from './draft/useDraftController'
import { useDraftInput } from './draft/useDraftInput'
import { ToolHintBar } from '../ToolHintBar'
import { CLOSES_AT_ONCE } from '../menu-close'
import { CreateSimilarChord } from '../create-similar'
import { ScheduleColumnGrips } from './ScheduleColumnGrips'
import { doubleClickOpensView } from './placed-view-actions'
import { keyTakenByModelTool, planPointerFor, type PlanPointer } from '../view-input/plan-pointer'
import { annotationGrips, calloutBoundaryAfterGrip, gripCommand, type Grip } from './draft/grips'
import { dragGhost, dragMoveCommand, dragStarted, dragTo } from './draft/drag-move'
import { MarkupBar } from './MarkupBar'
import { MarkupProperties } from './MarkupProperties'
import { DEFAULT_MARKUP_BRUSH, SHEET_MARKUP_SHORTCUT, applyMarkupShortcut, hitTestMarkupStroke, recognizeSmartShape, simplifyMarkupStroke, type MarkupBrushState } from './markup-tools'
import { printSheetPdf } from './print-sheet'

const NoteEditor = dynamic(() => import('./notes/NoteEditor').then((m) => m.NoteEditor), { ssr: false })
const CalcBlockProperties = dynamic(() => import('../calc-sheets/CalcBlockProperties').then((m) => m.CalcBlockProperties), { ssr: false })

const CeilingPlanLayer = dynamic(() => import('../ceilings/CeilingPlanLayer').then((m) => m.CeilingPlanLayer), { ssr: false })

/** `polygon`, `arc_radius`, and `arc_tangent` are drafting tools that compile to stored lines/arcs. */
export type DrawingTool = 'select' | DrawingShape | 'polygon' | 'arc_radius' | 'arc_tangent' | 'keynote'
type Tool = DrawingTool

/** A sheet, or a view's printed drawing (drafting tools only in detail views). */
type Target = DrawingTarget

type Selection = { readonly kind: 'viewport'; readonly id: string } | { readonly kind: 'item'; readonly id: string } | null

type Drag =
  | { readonly kind: 'move'; readonly id: string; readonly from: Vec2; readonly origin: Vec2; readonly to: Vec2; readonly extras?: readonly { readonly id: string; readonly origin: Vec2 }[] }
  /** A viewport frame's edge or corner on a sheet: the view's crop follows. */
  | { readonly kind: 'frame'; readonly id: string; readonly handle: CropHandle; readonly from: Vec2; readonly start: Rect; readonly rect: Rect }
  /** The crop box of the open view's drawing. */
  | { readonly kind: 'crop'; readonly handle: CropHandle; readonly from: Vec2; readonly start: Rect; readonly rect: Rect }
  | { readonly kind: 'draw'; readonly shape: DrawingShape; readonly a: Vec2; readonly b: Vec2 }
  /** Window (left-to-right) or crossing (right-to-left) box selection of drafted items. */
  | { readonly kind: 'marquee'; readonly a: Vec2; readonly b: Vec2 }
  /** The Note tool: click where the note starts, or drag across to set its width. */
  | { readonly kind: 'note-new'; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: 'note-move'; readonly id: string; readonly from: Vec2; readonly to: Vec2; readonly wasSelected: boolean }
  /**
   * Placed linework, regions, components, dimensions or tags pressed with Select (or a note in a multi-pick):
   * a click selects, a drag past a few pixels moves them all with one Move command on release.
   */
  | { readonly kind: 'items-move'; readonly ids: readonly string[]; readonly from: Vec2; readonly to: Vec2; readonly started: boolean; readonly collapseTo: string | null }
  /** A grip on a selected dimension, tag or note leader. */
  | { readonly kind: 'grip'; readonly id: string; readonly grip: Grip; readonly to: Vec2 }
  /** A corner of a region or callout boundary being sketched (Edit Boundary), paper mm. */
  | { readonly kind: 'boundary-vertex'; readonly index: number; readonly to: Vec2 }
  /** A whole edge of a boundary being slid in or out (Edit Boundary), paper mm. */
  | { readonly kind: 'boundary-edge'; readonly index: number; readonly from: Vec2; readonly to: Vec2 }
  /** A note's edge: width re-wraps live; the bottom edge fixes the height. */
  | { readonly kind: 'note-size'; readonly id: string; readonly edge: NoteEdge; readonly from: Vec2; readonly start: NoteFrame; readonly frame: NoteFrame }
  /** Freehand felt-tip marker or highlighter stroke drawn directly on sheet paper (mm). */
  | { readonly kind: 'markup'; readonly points: readonly Vec2[] }
  /** Dragging the markup eraser across strokes on the sheet. */
  | { readonly kind: 'markup-erase'; readonly erased: ReadonlySet<string> }

/** A note box on paper while it is dragged: top-left, width, fixed height (null grows with the text). */
interface NoteFrame {
  readonly origin: Vec2
  readonly width: number
  readonly height: number | null
  readonly rotation: number
  /** Height the text needs at `width` (where a bottom-edge drag starts from on an auto-height note). */
  readonly contentHeight: number
}

/** A note open in the in-place editor. Nothing is saved until Esc, Done or a click outside. */
interface NoteEditing {
  /** null: a new note, created on save. */
  readonly itemId: string | null
  readonly ownerId: string
  /** Box top-left on paper, and in the owner's stored coordinates. */
  readonly origin: Vec2
  readonly stored: Vec2
  /** `stored` when editing started: a left-edge drag while open moves the note. */
  readonly startStored: Vec2
  readonly rotation: number
  readonly width: number
  readonly height: number | null
  readonly size: number
  readonly lineSpacing: number
  readonly initial: readonly NoteParagraph[]
  /** What the note said when editing started (the edit names it, so someone else's save in between is refused). */
  readonly startedFrom: string | null
  readonly draft: readonly NoteParagraph[]
}

/** Default width of a note placed with a click, paper mm (about 3"). */
const NEW_NOTE_WIDTH_MM = 76

interface Props {
  readonly target: Target
  readonly model: ModelState
  /** Title-block fallbacks: the project's name and number and the firm. */
  readonly sheetTitle: SheetTitle
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onOpenView: (viewId: string) => void
  /** Jump directly to a sheet (e.g. clicking a section marker `1 / A-201` in paper space opens sheet A-201). */
  readonly onOpenSheet?: (sheetId: string) => void
  readonly onEditSheet?: () => void
  /** Right-hand properties for a detail view (scale etc.), rendered under the selection panel. */
  readonly viewProperties?: React.ReactNode
  /** Optional override for the right Properties rail collapse shortcut (default `]`; pass `null` to disable). */
  readonly propertiesShortcut?: string | null
  /** The drawing tool, when the ribbon owns it (its Annotate tab); the canvas then draws no tool buttons of its own. */
  readonly tool?: DrawingTool
  readonly onToolChange?: (tool: DrawingTool) => void
  /** Which drawing tools apply here (a sheet, a detail view, a view opened on a sheet), as they change. */
  readonly onToolsAvailable?: (tools: readonly DrawingTool[]) => void
  /** Everyone's live presence (note edit locks ride on it), and who you are. */
  readonly people?: ReadonlyMap<string, Presence>
  readonly selfActorId?: string
  /** Announce what you're doing (editing a note locks it for others). */
  readonly onActivity?: (activity: Presence['activity']) => void
  /** Linked-model linework per view id, drawn under each view as it prints. */
  readonly backgrounds?: ViewBackgrounds
  /** Show the printed PDF itself over the paper (same writer as Print PDF). */
  readonly printedPreview?: boolean
  /** Draft settings and the pending modify operation, shared with the ribbon; the canvas keeps its own when absent. */
  readonly draft?: DraftController
  /** Model editing (select, Tab, box, move) on a plan, section or elevation: the view's own drawing, or one opened on the sheet. */
  readonly modelEdit?: ModelEditBridge | null
  /** The plan, section or 3D view opened on the sheet for editing changed (null: none, or a detail view). */
  readonly onActiveViewChange?: (viewId: string | null) => void
  /** Open Tag styles (from a selected tag), on its style when it has one. */
  readonly onOpenTagStyles?: (styleId: string | null, sampleElementId: string | null) => void
  /** Extra properties for the view of a selected viewport (a schedule's panel and template), under the viewport's own. */
  readonly viewportProperties?: (viewId: string) => React.ReactNode
  /** Pictures on sheets: their screen links, print bytes and upload (the host app workspace files). */
  readonly sheetImages?: SheetImages | null
  /** Select this drawn item (a chart or picture just placed); a new object each time asks again. */
  readonly focusItem?: { readonly id: string } | null
  /** A part being placed on this drawing (from Not placed yet): the click lands it here, the view never changes. */
  readonly placing?: DrawingPlacementSpec | null
  readonly onPlaced?: (partId: string) => void
  readonly onPlacingCancel?: () => void
  /** Spaces on a floor plan: underlay pictures, outlines, and the Draw space tool while `mode` is set. */
  readonly spaces?: { readonly projectId: string; readonly mode: DrawSpaceMode | null; readonly drawerOpen?: boolean; readonly onDrawn: (spaceId: string) => void; readonly onCancel: () => void; readonly onSeparatorLine?: (line: SeparatorLine) => void } | null
  /** The ceiling plan's Ceiling tool while it is on (`ceilings/`); null otherwise. */
  readonly ceilings?: CeilingCanvasTool | null
  /** Question pins on floor plans; clicking one opens it in Coordination › Questions. */
  readonly questions?: { readonly onOpen: (questionId: ElementId) => void; readonly focusedQuestionId?: ElementId | null } | null
  /** The freshness chip for a live block on this sheet (matches the last issue, or changed since). */
  readonly blockFreshness?: (itemId: string) => React.ReactNode
  /** Right-click › Create similar on a model element in this drawing; absent: the item says why it can't run. */
  readonly onCreateSimilar?: (elementId: string) => void
  /** Right-click › Add view… on empty sheet paper; absent: the item says to drag one from Views and sheets. */
  readonly onAddView?: () => void
  /** A floor or ceiling plan opened on the sheet: screen ↔ plan points through the paper, so plan tools draw in it (null: none open). */
  readonly onPlanPointer?: (pointer: PlanPointer | null) => void
}

/** Detailing: drawn the same on a sheet, in a detail view and over a plan or section. */
const DRAFT_EXTRA: ReadonlyArray<{ tool: Tool; label: string; icon: React.ReactNode }> = [
  { tool: 'arc', label: 'Arc (centre)', icon: <Rainbow /> },
  { tool: 'arc_radius', label: 'Arc (start-end-bulge)', icon: <Rainbow /> },
  { tool: 'arc_tangent', label: 'Arc (tangent)', icon: <Rainbow /> },
  { tool: 'circle', label: 'Circle', icon: <Circle /> },
  { tool: 'polyline', label: 'Lines (chain)', icon: <Waypoints /> },
  { tool: 'polygon', label: 'Polygon', icon: <Hexagon /> },
  { tool: 'spline', label: 'Spline', icon: <Spline /> },
  { tool: 'region', label: 'Filled or masking region', icon: <PaintBucket /> },
  { tool: 'component', label: 'Detail component', icon: <Puzzle /> },
  { tool: 'repeat', label: 'Repeating detail', icon: <Repeat /> },
  { tool: 'batt', label: 'Insulation', icon: <Waves /> },
]

const SHEET_TOOLS: ReadonlyArray<{ tool: Tool; label: string; icon: React.ReactNode }> = [
  { tool: 'select', label: 'Select and move', icon: <MousePointer2 /> },
  { tool: 'markup', label: 'Marker', icon: <PenTool /> },
  { tool: 'text', label: 'Note', icon: <Type /> },
  { tool: 'line', label: 'Line', icon: <Minus /> },
  { tool: 'rect', label: 'Rectangle', icon: <Square /> },
  { tool: 'cloud', label: 'Revision cloud', icon: <Cloud /> },
  ...DRAFT_EXTRA,
]

const DETAIL_TOOLS: ReadonlyArray<{ tool: Tool; label: string; icon: React.ReactNode }> = [
  { tool: 'select', label: 'Select', icon: <MousePointer2 /> },
  { tool: 'line', label: 'Line', icon: <Minus /> },
  { tool: 'rect', label: 'Rectangle', icon: <Square /> },
  { tool: 'text', label: 'Text', icon: <Type /> },
  { tool: 'dimension', label: 'Dimension', icon: <MoveHorizontal /> },
  { tool: 'cloud', label: 'Revision cloud', icon: <Cloud /> },
  ...DRAFT_EXTRA,
]

/** Annotating the model: notes, dimensions that snap to and follow elements, tags, linework and clouds. */
const ANNOTATE_EXTRA: ReadonlyArray<{ tool: Tool; label: string; icon: React.ReactNode }> = [
  { tool: 'text', label: 'Text', icon: <Type /> },
  { tool: 'dimension', label: 'Dimension', icon: <MoveHorizontal /> },
  { tool: 'tag', label: 'Tag', icon: <Tag /> },
  { tool: 'keynote', label: 'Keynote', icon: <KeyRound /> },
  { tool: 'callout', label: 'Callout', icon: <SquareDashed /> },
  { tool: 'line', label: 'Line', icon: <Minus /> },
  { tool: 'rect', label: 'Rectangle', icon: <Square /> },
  { tool: 'cloud', label: 'Revision cloud', icon: <Cloud /> },
  ...DRAFT_EXTRA,
]

/** A plan or section on a sheet: select and move parts, plus annotation. */
const MODEL_VIEW_TOOLS: ReadonlyArray<{ tool: Tool; label: string; icon: React.ReactNode }> = [{ tool: 'select', label: 'Select and move', icon: <MousePointer2 /> }, ...ANNOTATE_EXTRA]

/** A plan or section drawing opened on its own: the same tools as on a sheet. */
const VIEW_DRAWING_TOOLS = MODEL_VIEW_TOOLS

const ANNOTATED_VIEW_TYPES: ReadonlySet<string> = new Set(['floor_plan', 'ceiling_plan', 'section', 'elevation'])
/** How close a click must be to snap a dimension point, paper mm. */
const SNAP_REACH_MM = 3
/** How close a Tag click must be to an element, paper mm. */
const TAG_REACH_MM = 8

const MIN_DRAG_MM = 1
/** Smallest frame / crop box side on paper while dragging, mm. */
const MIN_FRAME_MM = 10
const PRIMARY = 'var(--mutiny-selection)'

interface PlacedFrame {
  readonly viewport: Viewport
  readonly view: ViewElement
  readonly frame: ViewFrame
  /** The frame on paper: the view's crop window at the viewport's scale. */
  readonly rect: Rect
}

/** Sheet editor and detail-view drafting canvas: the printed drawing underneath, interaction on top. */
export function DrawingCanvas({ target, model, sheetTitle, canEdit, blockedReason, submit, onOpenView, onOpenSheet, onEditSheet, viewProperties, propertiesShortcut, tool: controlledTool, onToolChange, onToolsAvailable, backgrounds, printedPreview = false, people, selfActorId, onActivity, draft: sharedDraft, modelEdit, onActiveViewChange, onOpenTagStyles, viewportProperties, sheetImages = null, focusItem = null, placing = null, onPlaced, onPlacingCancel, spaces = null, ceilings = null, questions = null, blockFreshness, onCreateSimilar, onAddView, onPlanPointer }: Props) {
  const overlayRef = useRef<SVGSVGElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const paperRef = useRef<HTMLDivElement | null>(null)
  const [ownTool, setOwnTool] = useState<Tool>('select')
  const setTool = useCallback(
    (next: Tool) => {
      setOwnTool(next)
      onToolChange?.(next)
    },
    [onToolChange],
  )
  const [selection, setSelection] = useState<Selection>(null)
  /** Create similar on a tag: new tags look like this one until the Tag tool is left. */
  const [tagLike, setTagLike] = useState<TagSpec | null>(null)
  /** The Keynote tool's key (picked from a table, or typed). */
  const [keynoteKey, setKeynoteKey] = useState('')
  const [drag, setDragState] = useState<Drag | null>(null)
  // The pointer handlers read the drag from here, not from the last render: on a busy page (the printed
  // sheet re-rendering) the press, the moves and the release arrive before React renders between them,
  // and a release that read the render's drag saw a drag that hadn't moved and drew nothing.
  const dragRef = useRef<Drag | null>(null)
  const setDrag = useCallback((next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }, [])
  const [noteEdit, setNoteEdit] = useState<NoteEditing | null>(null)
  /** A callout box or sketched P-line polygon just drawn, waiting for the view it refers to. */
  const [calloutDraft, setCalloutDraft] = useState<{ readonly a: Vec2; readonly b: Vec2; readonly head: Vec2; readonly polygon?: readonly Vec2[] } | null>(null)
  /** New callout creation shape: classic rectangle or custom Revit-style P-line polygon. */
  const [calloutMode, setCalloutMode] = useState<'rect' | 'pline'>('rect')
  /** Active click-by-click P-line sketch (itemId === null creates a new callout; non-null replaces that callout's boundary). */
  const [plineSketch, setPlineSketch] = useState<{ readonly itemId: string | null; readonly points: readonly Vec2[]; readonly hover: Vec2 | null } | null>(null)
  /** Active graphics snap indicator while dragging callout grips, editing a boundary, or sketching a P-line. */
  const [activeSnap, setActiveSnap] = useState<GraphicsSnapHit | null>(null)
  const noteFonts = useNoteFonts()
  const [dropHint, setDropHint] = useState(false)
  /** The viewport opened for editing in place on the sheet (double-click). If it leaves the sheet, sheet editing resumes. */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Felt-tip Marker / Highlighter settings for sheet review markups. */
  const [markupBrush, setMarkupBrush] = useState<MarkupBrushState>(DEFAULT_MARKUP_BRUSH)

  const drawn = useDrawnScene(model, target, sheetTitle, backgrounds, undefined, {
    includeMarkups: markupBrush.showMarkups,
    includeResolvedMarkups: markupBrush.showResolved,
  })
  const blocks = useMemo(() => new Map<string, TextBlock>((drawn.scene?.textBlocks ?? []).map((b) => [b.itemId, b])), [drawn.scene])
  /** The note or dimension drawn live in the overlay (editing, resizing, moving, or dragging a grip) instead of the static base SVG. */
  const liveNoteId =
    noteEdit?.itemId ??
    (drag?.kind === 'note-size' || drag?.kind === 'note-move'
      ? drag.id
      : drag?.kind === 'grip' && (drag.grip.kind === 'leader-tip' || drag.grip.kind === 'leader-elbow' || drag.grip.kind === 'dim-offset' || drag.grip.kind === 'dim-point')
        ? drag.id
        : drag?.kind === 'items-move' && drag.started && drag.ids.length === 1 && model.elements[drag.ids[0]!]?.kind === 'drawing_item' && Boolean((model.elements[drag.ids[0]!] as DrawingItem).dim)
          ? drag.ids[0]!
          : null)
  const imageHref = sheetImages?.url
  const svg = useMemo(() => (drawn.scene ? sceneToSvg(drawn.scene, { ...(liveNoteId ? { hideNoteIds: new Set([liveNoteId]) } : {}), ...(imageHref ? { imageHref } : {}) }) : ''), [drawn.scene, liveNoteId, imageHref])
  const paper = drawn.scene?.paper ?? { x: 1, y: 1 }
  const frame = drawn.frame
  const zoomControl = useDrawingZoom(scrollRef, paperRef, paper)
  const { zoom, navigator: viewNav } = zoomControl
  // An edit drag (a grip, a frame, a new note, a move) owns the pointer: buttons don't pan under it. The wheel still zooms.
  const dragKind = drag?.kind ?? null
  useEffect(() => (dragKind && viewNav ? viewNav.claimPointer(dragKind) : undefined), [dragKind, viewNav])
  const [pxPerMm, setPxPerMm] = useState(1)
  const hasScene = drawn.scene !== null
  useEffect(() => {
    const el = paperRef.current
    if (!el) return
    const measure = () => setPxPerMm(el.getBoundingClientRect().width / paper.x || 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [paper.x, hasScene])

  // Note edit locks: who else is editing which note, expiring on this machine's clock.
  const presenceClock = useRef(new PresenceClock())
  const [lockTick, setLockTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setLockTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])
  const [locks, setLocks] = useState<ReadonlyMap<string, NoteLock>>(() => new Map())
  useEffect(() => {
    // lockTick re-reads the clock while presence is quiet, so a lock whose holder went silent lapses.
    const now = Date.now()
    setLocks(people ? noteLocks(presenceClock.current.update(people, now), now) : new Map())
  }, [people, lockTick])
  const editingId = noteEdit?.itemId ?? null
  const editingOwner = noteEdit?.ownerId ?? null
  useEffect(() => {
    if (!onActivity || !editingId || !editingOwner) return
    const announce = () => onActivity(editingNoteActivity(editingId, editingOwner))
    announce()
    const t = setInterval(announce, NOTE_LOCK_REFRESH_MS)
    return () => {
      clearInterval(t)
      onActivity({ kind: 'idle' })
    }
  }, [onActivity, editingId, editingOwner])
  const [paperWidthPx, setPaperWidthPx] = useState(0)
  useEffect(() => {
    const el = paperRef.current
    if (!el || !printedPreview) return
    const observer = new ResizeObserver(() => setPaperWidthPx(Math.round(el.clientWidth)))
    observer.observe(el)
    setPaperWidthPx(Math.round(el.clientWidth))
    return () => observer.disconnect()
  }, [printedPreview])

  const index = useMemo(() => documentIndex(model), [model])
  const sheet = target.kind === 'sheet' ? model.elements[target.sheetId] : undefined
  const sheetMarkups = useMemo(
    () => (target.kind === 'sheet' ? (index.markupsBySheet.get(target.sheetId) ?? []) : []),
    [index, target],
  )
  const visibleSheetMarkups = useMemo(
    () =>
      markupBrush.showMarkups
        ? sheetMarkups.filter((m) => markupBrush.showResolved || (m.markup?.status ?? 'open') !== 'resolved')
        : [],
    [sheetMarkups, markupBrush.showMarkups, markupBrush.showResolved],
  )
  const openMarkupCount = useMemo(
    () => sheetMarkups.filter((m) => (m.markup?.status ?? 'open') === 'open').length,
    [sheetMarkups],
  )
  const titleView = target.kind === 'detail' ? model.elements[target.viewId] : undefined
  const printTitle = sheet?.kind === 'sheet' ? `${sheet.number} ${sheet.title}` : titleView?.kind === 'view' ? titleView.name : 'Drawing'
  const placed = useMemo<PlacedFrame[]>(() => {
    if (sheet?.kind !== 'sheet' || sheet.deleted) return []
    return sheetViewports(model, sheet).map(({ viewport, view }) => {
      const f = frameForViewport(model, viewport, view)
      return { viewport, view, frame: f, rect: rectFromCenter(f.center, f.size) }
    })
  }, [model, sheet])

  const active = activeId ? placed.find((p) => p.viewport.id === activeId) ?? null : null
  const activeDrafting = active?.view.viewType === 'detail'
  const targetView = target.kind === 'detail' ? model.elements[target.viewId] : undefined
  const openView = targetView?.kind === 'view' && !targetView.deleted ? targetView : null
  const drafting = openView?.viewType === 'detail'
  const hasActive = active !== null
  const tools = useMemo(
    () =>
      hasActive
        ? activeDrafting
          ? DETAIL_TOOLS
          : MODEL_VIEW_TOOLS
        : target.kind === 'sheet'
          ? SHEET_TOOLS
          : drafting
            ? DETAIL_TOOLS
            : openView && ANNOTATED_VIEW_TYPES.has(openView.viewType)
              ? VIEW_DRAWING_TOOLS
              : SHEET_TOOLS.slice(0, 1),
    [hasActive, activeDrafting, target.kind, drafting, openView],
  )
  const requestedTool = controlledTool ?? ownTool
  // A tool that doesn't apply here (a dimension after leaving a detail view) is Select.
  const tool: Tool = tools.some((t) => t.tool === requestedTool) ? requestedTool : 'select'

  /** Whose lines and notes the drawing tools write: the open view on the sheet, the detail view, or the sheet. */
  const ownerId = active ? active.view.id : target.kind === 'sheet' ? target.sheetId : target.viewId
  /** Paper ↔ stored coordinates: a view opened on the sheet or a detail view stores model mm. */
  const drawFrame = active ? active.frame : frame
  const items = useMemo(() => index.itemsByOwner.get(ownerId) ?? [], [index, ownerId])
  const toPaperPoint = useCallback((p: Vec2) => (drawFrame ? modelToPaper(drawFrame, p) : p), [drawFrame])
  const toStored = useCallback((p: Vec2) => (drawFrame ? paperToModel(drawFrame, p) : p), [drawFrame])
  /** The view the drawing tools annotate (the one opened on the sheet, or the open drawing); null on the sheet itself. */
  const annotatedView = active ? active.view : openView
  /** Ortho and polar steps start from the working angle as it reads on paper (0 on a sheet or a plan turned to it). */
  const trackBaseDeg = useMemo(() => paperWorkingAngleDeg(model, annotatedView ?? null), [model, annotatedView])
  /** Points a dimension snaps to (and then follows): element ends, middles, edges and insertion points, or a detail's linework. */
  const dimSelected = selection?.kind === 'item' && Boolean(items.find((i) => i.id === selection.id)?.dim)
  const linkedReference = useLinkedReferenceState()
  const ownDraft = useDraftController()
  const draft = sharedDraft ?? ownDraft
  const draftingSnapActive = isDraftShape(tool) || draft.pending !== null
  const snaps = useMemo<SnapPoint[]>(() => {
    if (!annotatedView || (tool !== 'dimension' && !dimSelected && !draftingSnapActive)) return []
    const own = snapPoints(model, annotatedView, items, toPaperPoint)
    // A linked model's walls too: dimensions and detail lines snap to linked walls cleanly.
    return linkedReference.status === 'ready' ? [...own, ...linkedDimensionAnchors(linkedReference.index, model, annotatedView, toPaperPoint)] : own
  }, [model, annotatedView, items, toPaperPoint, tool, dimSelected, draftingSnapActive, linkedReference])
  const [hoverSnap, setHoverSnap] = useState<SnapPoint | null>(null)
  const snapReach = SNAP_REACH_MM / Math.max(zoom, 0.25)
  /** Drawn items picked besides the selection (Shift+click), for modify operations on several. */
  const [alsoPicked, setAlsoPicked] = useState<readonly string[]>([])
  /** Sheet viewports picked besides the selection (Shift+click), for moving or removing several together. */
  const [alsoViewports, setAlsoViewports] = useState<readonly string[]>([])
  const selectedViewportIds = useMemo(
    () => (selection?.kind === 'viewport' ? [selection.id, ...alsoViewports.filter((id) => id !== selection.id)] : []),
    [selection, alsoViewports],
  )
  // A chart or picture just placed becomes the selection (adjusting state while rendering, React's pattern for a prop that asks once).
  const [seenFocus, setSeenFocus] = useState(focusItem)
  if (focusItem !== seenFocus) {
    setSeenFocus(focusItem)
    if (focusItem) {
      setSelection({ kind: 'item', id: focusItem.id })
      setAlsoPicked([])
    }
  }
  /** Edit Boundary on a filled/masking region OR enlarged callout: its corners (paper mm) until Finish or Cancel. */
  const [boundary, setBoundary] = useState<{ readonly itemId: string; readonly kind: 'region' | 'callout'; readonly points: readonly Vec2[]; readonly picked: number | null } | null>(null)
  /** Paper-space snap index for wall faces/corners, grids & intersections — active for all drafting tools, callouts, and P-lines. */
  const needGraphicsSnap =
    annotatedView !== null &&
    (draftingSnapActive ||
      tool === 'callout' ||
      boundary?.kind === 'callout' ||
      plineSketch !== null ||
      (selection?.kind === 'item' && items.some((i) => i.id === selection.id && i.shape === 'callout')))
  const graphicsIndex = useMemo(
    () => (needGraphicsSnap && annotatedView ? buildGraphicsSnapIndex(model, annotatedView, toPaperPoint) : null),
    [needGraphicsSnap, model, annotatedView, toPaperPoint],
  )

  /** The view under model editing: the open plan or section drawing, or the one opened on the sheet. */
  const modelView = useMemo(() => {
    if (active) return activeDrafting ? null : viewportOnPaper(model, active.viewport, active.view)
    return frame && openView && openView.viewType !== 'detail' ? viewOnPaper(model, openView, frame) : null
  }, [active, activeDrafting, model, frame, openView])
  /** Spaces draw on floor plans only: the plan by itself, or its viewport opened on a sheet. */
  const floorPlanView = modelView && modelView.view.viewType === 'floor_plan' ? modelView : null
  /** The Draw space tool owns the clicks (and Enter / Backspace / Esc) while it is on, over any drafting tool. */
  /** The Ceiling tool draws on ceiling plans only, and owns the clicks the same way while it is on. */
  const ceilingPlanView = modelView && modelView.view.viewType === 'ceiling_plan' ? modelView : null
  const tracing = ((spaces?.mode != null && floorPlanView !== null) || (ceilings !== null && ceilingPlanView !== null)) && !noteEdit
  // One selection at a time: picking a note or viewport here drops the model selection (and a model pick clears this one, `onPicked`).
  useEffect(() => {
    if (selection && modelEdit && modelEdit.selectedIds.length > 0) modelEdit.select(null)
  }, [selection, modelEdit])
  const activeModelViewId = active && !activeDrafting ? active.view.id : null
  useEffect(() => {
    onActiveViewChange?.(activeModelViewId)
  }, [activeModelViewId, onActiveViewChange])
  useEffect(() => () => onActiveViewChange?.(null), [onActiveViewChange])
  /** The plan opened on the sheet, for the plan tools (an add-on's Wall, Floor): its points come through this paper. */
  const planPointer = useMemo(
    () => (active && !activeDrafting && modelView ? planPointerFor(modelView, { x: paper.x, y: paper.y }, () => overlayRef.current?.getBoundingClientRect() ?? null) : null),
    [active, activeDrafting, modelView, paper.x, paper.y],
  )
  useEffect(() => {
    onPlanPointer?.(planPointer)
  }, [planPointer, onPlanPointer])
  useEffect(() => () => onPlanPointer?.(null), [onPlanPointer])

  const paperAt = useCallback(
    (clientX: number, clientY: number): Vec2 | null => {
      const el = overlayRef.current
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0) return null
      return { x: ((clientX - r.left) / r.width) * paper.x, y: ((clientY - r.top) / r.height) * paper.y }
    },
    [paper.x, paper.y],
  )

  const send = useCallback(
    (command: Parameters<SubmitCommand>[0], label: string) => {
      const refusal = submit(command, label)
      if (refusal) toast.error(refusal)
      return refusal === null
    },
    [submit],
  )

  const selectedIds = useMemo(() => (selection?.kind === 'item' ? [selection.id, ...alsoPicked.filter((id) => id !== selection.id)] : []), [selection, alsoPicked])
  /** A schedule picked on the sheet shows grips on its column edges. */
  const selectedSchedule = selection?.kind === 'viewport' ? (placed.find((p) => p.viewport.id === selection.id && p.view.viewType === 'schedule') ?? null) : null
  const scheduleColumns = useMemo(() => (selectedSchedule ? scheduleViewColumns(model, selectedSchedule.view.props) : null), [model, selectedSchedule])
  const { setSelectedIds, setPending, pending: draftPending } = draft
  useEffect(() => setSelectedIds(selectedIds), [selectedIds, setSelectedIds])
  // A modify or leader pick waits on Select; picking a drawing tool drops it, and so does leaving this drawing.
  useEffect(() => {
    if (tool !== 'select' && draftPending) setPending(null)
  }, [tool, draftPending, setPending])
  useEffect(() => () => setPending(null), [setPending])
  // Modify › Delete and Deselect on the ribbon act on what is picked here.
  const { registerSelectionActions } = draft
  useEffect(() => {
    registerSelectionActions({
      deselect: () => {
        setSelection(null)
        setAlsoPicked([])
      },
      delete: () => {
        const [first] = selectedIds
        if (!canEdit || first === undefined) return
        const command = selectedIds.length > 1 ? { type: 'batch_documents' as const, label: `Delete ${selectedIds.length} items`, commands: selectedIds.map((itemId) => ({ type: 'delete_drawing_item' as const, itemId })) } : { type: 'delete_drawing_item' as const, itemId: first }
        if (send(command, 'delete')) {
          setSelection(null)
          setAlsoPicked([])
        }
      },
    })
    return () => registerSelectionActions(null)
  }, [registerSelectionActions, canEdit, selectedIds, send])
  const draftInput = useDraftInput({
    tool,
    settings: draft.settings,
    params: draft.params,
    pending: draft.pending,
    setPending: draft.setPending,
    items,
    selectedIds,
    ownerId,
    toPaper: toPaperPoint,
    toStored,
    storedPerPaperMm: drawFrame ? drawFrame.scale : 1,
    reachMm: snapReach,
    trackBaseDeg,
    anchors: snaps,
    graphicsIndex,
    send,
    onSaved: (id) => {
      setAlsoPicked([])
      setSelection(id ? { kind: 'item', id } : null)
    },
    onRefused: (reason) => toast(reason),
  })

  const activate = useCallback((viewportId: string) => {
    setActiveId(viewportId)
    setSelection(null)
    setTool('select')
    setNoteEdit(null)
  }, [setTool])

  /**
   * Double-click on a placed view: it opens for editing in place on the sheet,
   * the rest of the sheet dimmed. A plan or section takes the model tools there
   * (select, Tab, box, move; the ribbon's other tools open it by itself and
   * come back); a detail view takes the drafting tools. A schedule has nothing
   * to draw in place, so it opens as itself (its grid), as a sheet's schedule
   * does in Revit.
   */
  const openPlaced = useCallback(
    (viewportId: string) => {
      const entry = placed.find((p) => p.viewport.id === viewportId)
      if (entry && doubleClickOpensView(entry.view)) onOpenView(entry.view.id)
      else activate(viewportId)
    },
    [placed, activate, onOpenView],
  )

  const finishEditing = useCallback(() => {
    const was = active
    setActiveId(null)
    setTool('select')
    setNoteEdit(null)
    setSelection(was ? { kind: 'viewport', id: was.viewport.id } : null)
  }, [active, setTool])

  /** Open a saved note in the in-place editor, unless someone else is editing it. */
  const editNote = useCallback(
    (item: DrawingItem) => {
      if (!canEdit) {
        toast.error(blockedReason)
        return
      }
      const lock = locks.get(item.id)
      if (lock) {
        toast(`${lockMessage(lock, selfActorId)}. You can edit it when that's finished.`)
        return
      }
      const resolved = resolveNote(item)
      const block = blocks.get(item.id)
      if (!resolved || !block) return
      setNoteEdit({
        itemId: item.id,
        ownerId: item.ownerId,
        origin: block.origin,
        stored: resolved.anchor,
        startStored: resolved.anchor,
        rotation: resolved.note.box.rotation,
        width: resolved.note.box.width,
        height: resolved.note.box.height,
        size: resolved.size,
        lineSpacing: resolved.note.lineSpacing,
        initial: resolved.note.paragraphs,
        startedFrom: noteContentFingerprint(item),
        draft: resolved.note.paragraphs,
      })
      setSelection({ kind: 'item', id: item.id })
      setTool('select')
    },
    [canEdit, blockedReason, locks, blocks, setTool, selfActorId],
  )

  /** Save the open note: one create, or one edit (plus a resize if its box changed while open). A refusal keeps the editor open with your text. */
  const commitNote = useCallback(
    (paragraphs: readonly NoteParagraph[]) => {
      const e = noteEdit
      if (!e) return
      const content = normalizeParagraphs(paragraphs)
      const empty = noteText(content).trim().length === 0
      if (e.itemId === null) {
        if (empty) {
          setNoteEdit(null)
          return
        }
        const id = newId('note')
        if (send({ type: 'create_text_note', itemId: id, ownerId: e.ownerId, at: e.stored, width: e.width, height: e.height, textSize: e.size, paragraphs: paragraphsForCommand(content) }, 'add a note')) {
          setNoteEdit(null)
          setSelection({ kind: 'item', id })
        }
        return
      }
      if (empty) {
        toast('A note needs some text. Type something, or press Delete after closing it to remove the note.')
        return
      }
      const saved = model.elements[e.itemId]
      const savedNote = saved?.kind === 'drawing_item' ? resolveNote(saved) : null
      const textChanged = canonicalJson(content) !== canonicalJson(normalizeParagraphs(e.initial))
      const boxChanged = !savedNote || Math.abs(savedNote.note.box.width - e.width) > 1e-3 || savedNote.note.box.height !== e.height
      const moved = e.stored !== e.startStored
      let ok = true
      if (textChanged && e.startedFrom) ok = send({ type: 'edit_text_note', itemId: e.itemId, expectedContent: e.startedFrom, paragraphs: paragraphsForCommand(content) }, 'edit the note')
      if (ok && (boxChanged || moved)) ok = send({ type: 'resize_text_note', itemId: e.itemId, width: e.width, height: e.height, ...(moved ? { at: e.stored } : {}) }, 'resize the note')
      if (ok) setNoteEdit(null)
    },
    [noteEdit, send, model],
  )

  const discardNote = useCallback(() => {
    if (noteEdit?.itemId === null || !noteEdit) {
      setNoteEdit(null)
      return
    }
    setNoteEdit(null)
    toast('Changes discarded. The note is as it was.')
  }, [noteEdit])

  const startBoundary = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId && (i.shape === 'region' || i.shape === 'callout'))
      if (!item) return
      if (item.pinned) {
        toast("It's pinned. Unpin it first (Modify > Unpin).")
        return
      }
      setTool('select')
      draft.setPending(null)
      setPlineSketch(null)
      setActiveSnap(null)
      if (item.shape === 'callout') {
        const poly = calloutBoundaryPolygon(item)
        if (!poly || poly.length < 3) return
        setSelection({ kind: 'item', id: item.id })
        setBoundary({ itemId, kind: 'callout', points: poly.map(toPaperPoint), picked: null })
        return
      }
      setBoundary({ itemId, kind: 'region', points: item.points.map(toPaperPoint), picked: null })
    },
    [items, toPaperPoint, setTool, draft],
  )

  /** Start click-by-click Revit-style P-line callout sketching (itemId = null creates a new callout; non-null replaces that callout's boundary). */
  const startCalloutPlineSketch = useCallback(
    (itemId: string | null) => {
      if (!canEdit) {
        toast.error(blockedReason)
        return
      }
      setBoundary(null)
      setActiveSnap(null)
      draft.setPending(null)
      if (itemId) setTool('select')
      setPlineSketch({ itemId, points: [], hover: null })
    },
    [canEdit, blockedReason, draft, setTool],
  )

  /** Convert a custom polygonal P-line callout back to a clean axis-aligned rectangle (and clear target `cropPolygon`). */
  const resetCalloutRectangle = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId && i.shape === 'callout' && i.callout)
      if (!item) return
      const poly = calloutBoundaryPolygon(item)
      const bounds = poly ? polygonBounds(poly) : null
      if (!bounds) return
      const rectPoly: Vec2[] = [bounds.min, { x: bounds.max.x, y: bounds.min.y }, bounds.max, { x: bounds.min.x, y: bounds.max.y }]
      const cmds = calloutSyncCommands(model, item, rectPoly)
      if (typeof cmds === 'string') {
        toast.error(cmds)
        return
      }
      const ok =
        cmds.length === 1 && cmds[0]
          ? send(cmds[0], 'reset callout to rectangle')
          : send({ type: 'batch_documents', label: 'Reset callout boundary to rectangle', commands: cmds }, 'reset callout to rectangle')
      if (ok) {
        setBoundary(null)
        setSelection({ kind: 'item', id: item.id })
      }
    },
    [items, model, send],
  )

  /** Create similar on a tag (C S, or its properties' button): the Tag tool, set to tag the next element the same way. */
  const startTagLike = useCallback(
    (like: TagSpec) => {
      if (!canEdit) {
        toast.error(blockedReason)
        return
      }
      setTagLike(like)
      setTool('tag')
      toast('Tagging like the selected tag. Click the next element; Esc stops.')
    },
    [canEdit, blockedReason, setTool],
  )
  useEffect(() => {
    if (tool !== 'tag' && tagLike) setTagLike(null)
  }, [tool, tagLike])
  useEffect(() => {
    // Switching away from Callout cancels any in-progress new-callout P-line sketch
    if (tool !== 'callout' && plineSketch && plineSketch.itemId === null) {
      setPlineSketch(null)
      setActiveSnap(null)
    }
  }, [tool, plineSketch])
  const similarChord = useRef(new CreateSimilarChord())

  const cancelBoundary = useCallback(() => {
    const kind = boundary?.kind
    setBoundary(null)
    setActiveSnap(null)
    toast(kind === 'callout' ? 'Boundary edit cancelled. The callout is as it was.' : 'Boundary edit cancelled. The region is as it was.')
  }, [boundary])

  const finishBoundary = useCallback(() => {
    if (!boundary) return
    if (boundary.points.length < 3) {
      toast('A boundary needs at least three corners.')
      return
    }
    setActiveSnap(null)
    if (boundary.kind === 'callout') {
      const item = items.find((i) => i.id === boundary.itemId && i.shape === 'callout')
      if (!item) return
      const cmds = calloutSyncCommands(model, item, boundary.points.map(toStored))
      if (typeof cmds === 'string') {
        toast.error(cmds)
        return
      }
      const ok =
        cmds.length === 1 && cmds[0]
          ? send(cmds[0], 'update callout boundary')
          : send({ type: 'batch_documents', label: 'Update callout P-line boundary and sync enlarged plan crop', commands: cmds }, 'update callout boundary')
      if (ok) {
        setBoundary(null)
        setSelection({ kind: 'item', id: boundary.itemId })
      }
      return
    }
    if (send({ type: 'update_drawing_item', itemId: boundary.itemId, points: boundary.points.map(toStored) }, 'change the region boundary')) {
      setBoundary(null)
      setSelection({ kind: 'item', id: boundary.itemId })
    }
  }, [boundary, items, model, send, toStored])

  const cancelPlineSketch = useCallback(() => {
    setPlineSketch(null)
    setActiveSnap(null)
  }, [])

  const finishPlineSketch = useCallback(
    (paperPts?: readonly Vec2[]) => {
      const sketch = plineSketch
      if (!sketch) return
      const pts = paperPts ?? sketch.points
      if (pts.length < 3) {
        toast('Click at least three corners to close a custom P-line callout.')
        return
      }
      const storedPts = pts.map(toStored)
      const bounds = polygonBounds(storedPts)
      if (!bounds || bounds.max.x - bounds.min.x < 25.4 || bounds.max.y - bounds.min.y < 25.4) {
        toast('The P-line callout needs to span at least 1 in each way.')
        return
      }
      setActiveSnap(null)
      if (sketch.itemId) {
        const item = items.find((i) => i.id === sketch.itemId && i.shape === 'callout')
        if (!item) {
          setPlineSketch(null)
          return
        }
        const cmds = calloutSyncCommands(model, item, storedPts)
        if (typeof cmds === 'string') {
          toast.error(cmds)
          return
        }
        const ok =
          cmds.length === 1 && cmds[0]
            ? send(cmds[0], 'update callout P-line boundary')
            : send({ type: 'batch_documents', label: 'Sketch custom P-line callout boundary and sync enlarged plan crop', commands: cmds }, 'update callout P-line boundary')
        if (ok) {
          setPlineSketch(null)
          setSelection({ kind: 'item', id: sketch.itemId })
        }
        return
      }
      // New P-line callout: open CalloutViewDialog with the sketched polygon!
      const paperBounds = polygonBounds(pts)!
      const head = toStored({ x: paperBounds.min.x - 8, y: paperBounds.min.y - 8 })
      setPlineSketch(null)
      setCalloutDraft({ a: bounds.min, b: bounds.max, head, polygon: storedPts })
    },
    [plineSketch, toStored, items, model, send],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = e.target instanceof HTMLElement ? e.target.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target instanceof HTMLElement && e.target.isContentEditable) || noteEdit) {
        // Esc in a drawing tool's option field leaves the field; the next Esc stops the tool.
        const field = noteEdit ? null : escapeLeavesField(e, tool !== 'select')
        if (field) {
          field.blur()
          toast(leftFieldHint(tool))
        }
        return
      }
      // The Draw space and Place layers own Enter, Backspace and Esc while they are on.
      if (tracing || (placing && modelView)) return
      if (keyTakenByModelTool(e)) return
      if (plineSketch) {
        if (e.key === 'Enter') {
          e.preventDefault()
          finishPlineSketch()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelPlineSketch()
        } else if (e.key === 'Backspace' && plineSketch.points.length > 0) {
          e.preventDefault()
          setPlineSketch({ ...plineSketch, points: plineSketch.points.slice(0, -1) })
        }
        return
      }
      if (boundary) {
        if (e.key === 'Enter') {
          e.preventDefault()
          finishBoundary()
        } else if (e.key === 'Escape') cancelBoundary()
        else if ((e.key === 'Delete' || e.key === 'Backspace') && boundary.picked !== null) {
          e.preventDefault()
          if (boundary.points.length <= 3) toast('A boundary needs at least three corners.')
          else setBoundary({ ...boundary, points: boundary.points.filter((_, i) => i !== boundary.picked), picked: null })
        }
        return
      }
      if (draftInput.active && !e.metaKey && !e.ctrlKey && !e.altKey && draftInput.handleKey(e.key)) {
        e.preventDefault()
        return
      }
      if (e.key === 'Enter' && draftInput.finish()) {
        e.preventDefault()
        return
      }
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && tool === 'select' && selection?.kind === 'item') {
        const chain = chainOf(items, selection.id)
        if (chain.length > 1) {
          e.preventDefault()
          setSelection({ kind: 'item', id: chain[0]!.id })
          setAlsoPicked(chain.slice(1).map((c) => c.id))
          toast(`Selected joined chain of ${chain.length} items.`)
          return
        }
        // Otherwise cycle through overlapping drawn items under the currently selected item's footprint.
        const current = items.find((it) => it.id === selection.id)
        const curBox = current ? (current.dim || current.tag ? annotationBox(model, annotatedView, current, toPaperPoint) : detailBox(current, toPaperPoint)) : null
        if (curBox) {
          const cx = curBox.x + curBox.w / 2
          const cy = curBox.y + curBox.h / 2
          const overlapping = items.filter((it) => {
            if (it.deleted) return false
            const b = it.dim || it.tag ? annotationBox(model, annotatedView, it, toPaperPoint) : detailBox(it, toPaperPoint)
            if (!b) return false
            return cx >= b.x - 1.5 && cx <= b.x + b.w + 1.5 && cy >= b.y - 1.5 && cy <= b.y + b.h + 1.5
          })
          if (overlapping.length > 1) {
            e.preventDefault()
            const idx = overlapping.findIndex((it) => it.id === selection.id)
            const next = overlapping[(idx + (e.shiftKey ? overlapping.length - 1 : 1)) % overlapping.length]!
            setAlsoPicked([])
            setSelection({ kind: 'item', id: next.id })
            toast(`Selected ${next.shape} (${((idx + 1) % overlapping.length) + 1} of ${overlapping.length} overlapping).`)
            return
          }
        }
      }
      const plainKey = !e.metaKey && !e.ctrlKey && !e.altKey
      if (plainKey && !e.repeat && target.kind === 'sheet' && !active && canEdit && !drag) {
        const markupNext = applyMarkupShortcut(e.key, tool === 'markup', markupBrush)
        if (markupNext) {
          e.preventDefault()
          setMarkupBrush(markupNext.brush)
          setTool(markupNext.nextTool)
          return
        }
      }
      if (plainKey && !e.repeat && similarChord.current.press(e.key, e.timeStamp) && tool === 'select' && selection?.kind === 'item') {
        const picked = items.find((i) => i.id === selection.id)
        if (picked?.tag) {
          e.preventDefault()
          e.stopImmediatePropagation()
          startTagLike(picked.tag)
          return
        }
      }
      const step = plainKey && tool === 'select' && selection?.kind === 'item' ? nudgePaperStep(e.key, e.shiftKey) : null
      if (step) {
        e.preventDefault()
        if (!canEdit) {
          toast.error(blockedReason)
          return
        }
        const origin = toStored({ x: 0, y: 0 })
        const moved = toStored(step)
        const edits = nudgeEdits(items, selectedIds, { x: moved.x - origin.x, y: moved.y - origin.y })
        if (!edits.ok) toast(edits.reason)
        else if (edits.commands.length === 1 && edits.commands[0]) send(edits.commands[0], 'nudge it')
        else send({ type: 'batch_documents', label: `Nudge ${edits.commands.length} items`, commands: edits.commands }, 'nudge them')
        return
      }
      if (e.key === 'Escape' && draftInput.cancel()) return
      if (e.key === 'F8') {
        e.preventDefault()
        draft.setSettings({ ...draft.settings, ortho: !draft.settings.ortho, ...(draft.settings.ortho ? {} : { polarDeg: null }) })
        toast(draft.settings.ortho ? 'Ortho off.' : 'Ortho on: lines stay square to the paper.')
        return
      }
      if (e.key === 'Enter' && selection?.kind === 'item' && tool === 'select') {
        const item = items.find((i) => i.id === selection.id)
        if (item?.shape === 'text') {
          e.preventDefault()
          editNote(item)
        }
        return
      }
      if (e.key === 'Escape') {
        if (drag) setDrag(null)
        else if (tool !== 'select') setTool('select')
        else if (modelEdit && modelEdit.selectedIds.length > 0) modelEdit.select(null)
        else if (selection && selection.kind !== 'viewport') {
          setSelection(null)
          setAlsoPicked([])
        }
        else if (active) finishEditing()
        else {
          setSelection(null)
          setAlsoViewports([])
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection && canEdit) {
        e.preventDefault()
        if (selection.kind === 'item') {
          const ids = selectedIds
          const command = ids.length > 1 ? { type: 'batch_documents' as const, label: `Delete ${ids.length} items`, commands: ids.map((itemId) => ({ type: 'delete_drawing_item' as const, itemId })) } : { type: 'delete_drawing_item' as const, itemId: selection.id }
          if (send(command, 'delete')) {
            setSelection(null)
            setAlsoPicked([])
          }
        } else {
          const vpIds = selectedViewportIds
          const command =
            vpIds.length > 1
              ? { type: 'batch_documents' as const, label: `Remove ${vpIds.length} views from sheet`, commands: vpIds.map((viewportId) => ({ type: 'remove_viewport' as const, viewportId })) }
              : { type: 'remove_viewport' as const, viewportId: selection.id }
          if (send(command, 'take the view off the sheet')) {
            setSelection(null)
            setAlsoViewports([])
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag, setDrag, noteEdit, tool, setTool, selection, canEdit, send, active, finishEditing, items, editNote, draftInput, draft, selectedIds, selectedViewportIds, modelEdit, boundary, finishBoundary, cancelBoundary, plineSketch, finishPlineSketch, cancelPlineSketch, tracing, placing, modelView, startTagLike, blockedReason, toStored, annotatedView, model, toPaperPoint, target.kind, markupBrush])

  /** Paper point under a pointer event on the overlay or anything in it. */
  const paperOf = (e: React.PointerEvent<SVGElement>): Vec2 | null => {
    const root = e.currentTarget instanceof SVGSVGElement ? e.currentTarget : e.currentTarget.ownerSVGElement
    const r = root?.getBoundingClientRect()
    if (!r || r.width === 0) return null
    return { x: ((e.clientX - r.left) / r.width) * paper.x, y: ((e.clientY - r.top) / r.height) * paper.y }
  }

  // Tag elbow leaders (U9): the grip on a selected tag, the right-click Tags group, and a tag head dragged away.
  const tagElbows = useTagElbows({
    model,
    view: annotatedView && annotatedView.viewType !== 'detail' ? annotatedView : null,
    items,
    selectedIds,
    editBlocked: canEdit ? null : blockedReason,
    send: (command, label) => send(command, label),
    select: (ids) => {
      setSelection(ids[0] ? { kind: 'item', id: ids[0] } : null)
      setAlsoPicked(ids.slice(1))
    },
    toPaper: toPaperPoint,
    toStored,
    paperOf,
    paperMmPerPx: 1 / (pxPerMm || 1),
  })
  const [tagMenuAt, setTagMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null)
  // Right-click on a model element, a placed view or bare paper (C6); the Tags menu above keeps a selected annotation's right-click.
  const drawingMenu = useDrawingContextMenu({
    model,
    onSheet: target.kind === 'sheet',
    view: annotatedView && annotatedView.viewType !== 'detail' ? annotatedView : null,
    canEdit,
    blockedReason,
    modelEdit,
    send,
    onOpenView,
    zoomFit: zoomControl.fit,
    viewportView: (viewportId) => placed.find((p) => p.viewport.id === viewportId)?.view ?? null,
    elementNear: (clientX, clientY) => {
      const at = paperAt(clientX, clientY)
      return at && annotatedView ? (tagTargetAt(model, annotatedView, toPaperPoint, at, TAG_REACH_MM / Math.max(zoom, 0.25))?.elementId ?? null) : null
    },
    onCreateSimilar,
    onAddView,
  })

  /** Start a drag; the overlay keeps the pointer until release even if it leaves the grip. */
  const startDrag = (e: React.PointerEvent<SVGElement>, next: Drag) => {
    e.stopPropagation()
    const root = e.currentTarget instanceof SVGSVGElement ? e.currentTarget : e.currentTarget.ownerSVGElement
    root?.setPointerCapture(e.pointerId)
    setDrag(next)
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const at = paperOf(e)
    if (!at) return
    // Sketching a region or callout boundary: only its grips take clicks until Finish or Cancel.
    if (boundary) return
    // Click-by-click Revit-style P-line callout sketching (either re-sketching an existing callout or drawing a new one).
    if (plineSketch || (tool === 'callout' && calloutMode === 'pline')) {
      if (!canEdit) {
        toast.error(blockedReason)
        return
      }
      if (active && !insideRect(active.rect, at)) {
        toast(`Sketch inside ${active.view.name}'s frame, or press Esc to cancel.`)
        return
      }
      e.preventDefault()
      const currentPts = plineSketch?.points ?? []
      const prevPt = currentPts.length > 0 ? currentPts[currentPts.length - 1]! : null
      const orthoOn = draft.settings.ortho || e.shiftKey
      const hit = snapToGraphics(graphicsIndex, at, snapReach, {
        alignRefs: currentPts,
        orthoFrom: orthoOn ? prevPt : null,
      })
      const pt = hit?.at ?? at
      const closeReach = 4 / Math.max(zoom, 0.25)
      if (currentPts.length >= 3 && Math.hypot(pt.x - currentPts[0]!.x, pt.y - currentPts[0]!.y) <= closeReach) {
        finishPlineSketch(currentPts)
        return
      }
      if (prevPt && Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) < 0.5) return
      setPlineSketch({ itemId: plineSketch?.itemId ?? null, points: [...currentPts, pt], hover: pt })
      return
    }
    // A click outside the open note saves it (and does nothing else). A press on the note itself is not outside it:
    // a double-click on a selected note opens the editor on its first click, and the second must not close it again.
    if (noteEdit) {
      const local = liveBlock ? paperToBox(liveBlock, at) : null
      if (local && liveBlock && local.x >= 0 && local.y >= 0 && local.x <= liveBlock.layout.width && local.y <= liveBlock.layout.height) {
        e.preventDefault()
        return
      }
      commitNote(noteEdit.draft)
      return
    }
    if (draftInput.active) {
      if (!canEdit) toast.error(blockedReason)
      else if (active && !insideRect(active.rect, at)) toast(`Draw inside ${active.view.name}'s frame, or press Esc to finish editing the view.`)
      else {
        e.preventDefault()
        if (tool === 'line' || tool === 'rect') e.currentTarget.setPointerCapture(e.pointerId)
        draftInput.down(at)
      }
      return
    }
    if (tool === 'select') {
      if (e.shiftKey) {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'marquee', a: at, b: at })
        return
      }
      const deselect = () => {
        if (!active) {
          setSelection(null)
          setAlsoPicked([])
          setAlsoViewports([])
        } else if (selection?.kind !== 'viewport') {
          setSelection(null)
          setAlsoPicked([])
        }
      }
      // Empty paper: a drag pans (as in the plan view); a click deselects.
      if (e.target !== e.currentTarget || !viewNav?.pressEmpty(e.nativeEvent, deselect)) deselect()
      return
    }
    if (!canEdit) {
      toast.error(blockedReason)
      return
    }
    if (active && !insideRect(active.rect, at)) {
      toast(`Draw inside ${active.view.name}'s frame, or press Esc to finish editing the view.`)
      return
    }
    if (tool === 'tag') {
      const hit = annotatedView ? tagTargetAt(model, annotatedView, toPaperPoint, at, TAG_REACH_MM / Math.max(zoom, 0.25)) : null
      if (!annotatedView || !hit) {
        toast('Click on a run or a part to tag it, or inside a room or space to label it.')
        return
      }
      // The head goes where you clicked; a leader when that's away from the element. A room or space tag sits where you clicked inside it.
      const away = !hit.floor && Math.hypot(at.x - hit.at.x, at.y - hit.at.y) > 6
      const head = hit.floor || away ? at : { x: hit.at.x + 6, y: hit.at.y - 4 }
      const id = newId('tag')
      const spec = tagLike ? tagSpecLike(model, tagLike, hit.elementId, { floor: hit.floor === true }) : tagSpecFor(model, hit.elementId, away)
      if (send({ type: 'add_drawing_item', itemId: id, ownerId, shape: 'tag', points: [toStored(head)], tag: spec }, 'tag it')) setSelection({ kind: 'item', id })
      return
    }
    if (tool === 'keynote') {
      const key = cleanKey(keynoteKey)
      if (!key) {
        toast('Pick or type a keynote first (the bar over the drawing), then click the element it applies to.')
        return
      }
      const hit = annotatedView ? tagTargetAt(model, annotatedView, toPaperPoint, at, TAG_REACH_MM / Math.max(zoom, 0.25)) : null
      if (!annotatedView || !hit || hit.floor) {
        toast('Click on a run or a part to give it the keynote.')
        return
      }
      const away = Math.hypot(at.x - hit.at.x, at.y - hit.at.y) > 6
      const head = away ? at : { x: hit.at.x + 6, y: hit.at.y - 4 }
      const id = newId('tag')
      if (send(keynoteCommand({ elementId: hit.elementId, key, ownerId, itemId: id, head: toStored(head), leader: true }), `keynote ${key}`)) setSelection({ kind: 'item', id })
      return
    }
    if (tool === 'markup') {
      if (target.kind !== 'sheet' || active) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      if (!markupBrush.showMarkups) setMarkupBrush((b) => ({ ...b, showMarkups: true }))
      if (markupBrush.eraser) {
        const hit = visibleSheetMarkups.find((m) => hitTestMarkupStroke(m, at, 3 / Math.max(zoom, 0.25)))
        const erased = new Set<string>()
        if (hit && send({ type: 'delete_drawing_item', itemId: hit.id }, 'erase markup')) {
          erased.add(hit.id)
          if (selection?.kind === 'item' && selection.id === hit.id) setSelection(null)
        }
        setDrag({ kind: 'markup-erase', erased })
        return
      }
      setSelection(null)
      setAlsoPicked([])
      setDrag({ kind: 'markup', points: [at] })
      return
    }
    // A press with a drawing tool starts a drag on the drawing, never a text selection: text already selected on
    // the page (double-clicking a view to edit it selects some) was dragged instead, the browser cancelled the
    // pointer, and the line was dropped (crop-on-sheet, main run 42378325886).
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (tool === 'text') {
      setDrag({ kind: 'note-new', a: at, b: at })
      return
    }
    if (tool === 'polygon' || tool === 'arc_radius' || tool === 'arc_tangent') return
    if (tool === 'callout') {
      const hit = snapToGraphics(graphicsIndex, at, snapReach)
      setActiveSnap(hit)
      const start = hit?.at ?? at
      setDrag({ kind: 'draw', shape: 'callout', a: start, b: start })
      return
    }
    const start = tool === 'dimension' ? at : draftInput.constrain(at, null).at
    setDrag({ kind: 'draw', shape: tool, a: start, b: start })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const at = paperOf(e)
    if (!at) return
    const drag = dragRef.current
    if (snaps.length > 0) {
      const near = nearestSnap(snaps, at, snapReach)
      if (near?.ref.elementId !== hoverSnap?.ref.elementId || near?.ref.anchor !== hoverSnap?.ref.anchor) setHoverSnap(near)
    } else if (hoverSnap) setHoverSnap(null)
    if (!drag && (plineSketch || (tool === 'callout' && calloutMode === 'pline'))) {
      const currentPts = plineSketch?.points ?? []
      const prevPt = currentPts.length > 0 ? currentPts[currentPts.length - 1]! : null
      const orthoOn = draft.settings.ortho || e.shiftKey
      const hit = snapToGraphics(graphicsIndex, at, snapReach, {
        alignRefs: currentPts,
        orthoFrom: orthoOn ? prevPt : null,
      })
      setActiveSnap(hit)
      if (plineSketch) setPlineSketch((cur) => (cur ? { ...cur, hover: hit?.at ?? at } : cur))
      return
    }
    draftInput.move(at)
    if (!drag) {
      if (activeSnap) setActiveSnap(null)
      return
    }
    switch (drag.kind) {
      case 'draw':
        if (drag.shape === 'callout') {
          const hit = snapToGraphics(graphicsIndex, at, snapReach, { alignRefs: [drag.a] })
          setActiveSnap(hit)
          setDrag({ ...drag, b: hit?.at ?? at })
        } else {
          setDrag({ ...drag, b: drag.shape === 'dimension' ? at : draftInput.constrain(at, drag.a).at })
        }
        break
      case 'grip':
        if (drag.grip.kind === 'callout-corner' || drag.grip.kind === 'callout-edge' || drag.grip.kind === 'callout-poly-edge' || drag.grip.kind === 'callout-vertex') {
          const item = items.find((i) => i.id === drag.id)
          const polyPaper = item ? (calloutBoundaryPolygon(item)?.map(toPaperPoint) ?? []) : []
          const alignRefs =
            drag.grip.kind === 'callout-vertex' && polyPaper.length >= 3
              ? [
                  polyPaper[(drag.grip.index - 1 + polyPaper.length) % polyPaper.length]!,
                  polyPaper[(drag.grip.index + 1) % polyPaper.length]!,
                ]
              : []
          const isAxisEdge = drag.grip.kind === 'callout-edge' || drag.grip.kind === 'callout-poly-edge'
          const hit = snapToGraphics(graphicsIndex, at, snapReach, {
            lockAxis: isAxisEdge ? (drag.grip.axis ?? null) : null,
            alignRefs,
          })
          setActiveSnap(hit)
          const snapped = hit?.at ?? at
          const constrained =
            isAxisEdge && drag.grip.axis === 'x'
              ? { x: snapped.x, y: drag.grip.at.y }
              : isAxisEdge && drag.grip.axis === 'y'
                ? { x: drag.grip.at.x, y: snapped.y }
                : snapped
          setDrag({ ...drag, to: constrained })
        } else if (drag.grip.kind === 'callout-head') {
          setActiveSnap(null)
          setDrag({ ...drag, to: at })
        } else {
          setDrag({ ...drag, to: drag.grip.kind === 'dim-point' ? (nearestSnap(snaps, at, snapReach)?.at ?? at) : drag.grip.kind === 'dim-offset' ? at : draftInput.constrain(at, null).at })
        }
        break
      case 'boundary-edge': {
        const bPts = boundary?.points ?? []
        const n = bPts.length
        const p0 = bPts[drag.index]
        const p1 = bPts[(drag.index + 1) % n]
        if (p0 && p1 && boundary?.kind === 'callout') {
          const dx = Math.abs(p1.x - p0.x)
          const dy = Math.abs(p1.y - p0.y)
          const lockAxis: 'x' | 'y' | null = dy < dx * 0.2 ? 'y' : dx < dy * 0.2 ? 'x' : null
          const hit = snapToGraphics(graphicsIndex, at, snapReach, { lockAxis })
          setActiveSnap(hit)
          setDrag({ ...drag, to: hit?.at ?? at })
        } else {
          setDrag({ ...drag, to: at })
        }
        break
      }
      case 'boundary-vertex':
        if (boundary?.kind === 'callout') {
          const n = boundary.points.length
          const prevPt = boundary.points[(drag.index - 1 + n) % n]
          const nextPt = boundary.points[(drag.index + 1) % n]
          const alignRefs = [prevPt, nextPt].filter((p): p is Vec2 => Boolean(p))
          const hit = snapToGraphics(graphicsIndex, at, snapReach, {
            alignRefs,
            orthoFrom: draft.settings.ortho || e.shiftKey ? (prevPt ?? null) : null,
          })
          setActiveSnap(hit)
          setDrag({ ...drag, to: hit?.at ?? at })
        } else {
          setDrag({ ...drag, to: draftInput.constrain(at, null).at })
        }
        break
      case 'note-new':
        setDrag({ ...drag, b: at })
        break
      case 'items-move': {
        if (!drag.started && !dragStarted(drag.from, at, pxPerMm)) break
        if (!canEdit) {
          toast.error(blockedReason)
          setDrag(null)
          break
        }
        const orthoOn = draft.settings.ortho || e.shiftKey
        let snappedTo = dragTo(drag.from, at, orthoOn, trackBaseDeg)
        // Soft orthogonal alignment guide when dragging freely (snaps cleanly to pure H/V within 1.5 mm paper).
        if (!orthoOn) {
          const dx = snappedTo.x - drag.from.x
          const dy = snappedTo.y - drag.from.y
          if (Math.abs(dy) < 1.5 && Math.abs(dx) > 3) snappedTo = { x: snappedTo.x, y: drag.from.y }
          else if (Math.abs(dx) < 1.5 && Math.abs(dy) > 3) snappedTo = { x: drag.from.x, y: snappedTo.y }
        }
        setDrag({ ...drag, started: true, to: snappedTo })
        break
      }
      case 'note-size':
        setDrag({ ...drag, frame: resizeFrame(drag.start, drag.edge, { x: at.x - drag.from.x, y: at.y - drag.from.y }) })
        break
      case 'frame':
      case 'crop':
        setDrag({ ...drag, rect: dragRect(drag.start, drag.handle, { x: at.x - drag.from.x, y: at.y - drag.from.y }, MIN_FRAME_MM, false) })
        break
      case 'marquee':
        setDrag({ ...drag, b: at })
        break
      case 'markup': {
        const prev = drag.points[drag.points.length - 1]
        if (!prev || Math.hypot(at.x - prev.x, at.y - prev.y) >= 0.45) {
          setDrag({ kind: 'markup', points: [...drag.points, at] })
        }
        break
      }
      case 'markup-erase': {
        const hit = visibleSheetMarkups.find((m) => !drag.erased.has(m.id) && hitTestMarkupStroke(m, at, 3 / Math.max(zoom, 0.25)))
        if (hit && send({ type: 'delete_drawing_item', itemId: hit.id }, 'erase markup')) {
          const erased = new Set(drag.erased)
          erased.add(hit.id)
          if (selection?.kind === 'item' && selection.id === hit.id) setSelection(null)
          setDrag({ kind: 'markup-erase', erased })
        }
        break
      }
      default:
        setDrag({ ...drag, to: at })
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    setDrag(null)
    setActiveSnap(null)
    if (!d) {
      if (draftInput.active) {
        const at = paperOf(e)
        if (at) draftInput.up(at)
      }
      return
    }
    if (d.kind === 'markup-erase') return
    if (d.kind === 'markup') {
      if (target.kind !== 'sheet') return
      const simplified = simplifyMarkupStroke(d.points, 0.5, 400)
      const shaped = markupBrush.smartShapes ? recognizeSmartShape(simplified) : { points: simplified }
      const itemId = newId('markup')
      send(
        {
          type: 'add_sheet_markup',
          itemId,
          sheetId: target.sheetId,
          points: shaped.points,
          markup: {
            tool: markupBrush.tool,
            color: markupBrush.color,
            widthMm: markupBrush.widthMm,
            status: 'open',
            ...(shaped.smartShape ? { smartShape: shaped.smartShape } : {}),
            ...(selfActorId ? { author: selfActorId } : {}),
            createdAt: new Date().toISOString(),
          },
        },
        markupBrush.tool === 'highlighter' ? 'highlight sheet' : 'mark up sheet',
      )
      return
    }
    if (d.kind === 'marquee') {
      if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < MIN_DRAG_MM) return
      const hits = marqueeHits(items, toPaperPoint, d.a, d.b)
      if (hits.length > 0) {
        setSelection({ kind: 'item', id: hits[0]! })
        setAlsoPicked(hits.slice(1))
      } else {
        setSelection(null)
        setAlsoPicked([])
      }
      return
    }
    if (d.kind === 'note-new') {
      const wide = Math.abs(d.b.x - d.a.x) >= 5
      const origin = { x: wide ? Math.min(d.a.x, d.b.x) : d.a.x, y: Math.min(d.a.y, d.b.y) }
      const room = active ? active.rect.max.x - origin.x : paper.x - 12.7 - origin.x
      const width = Math.min(NOTE_LIMITS.maxWidthMm, Math.max(NOTE_LIMITS.minWidthMm, wide ? Math.abs(d.b.x - d.a.x) : Math.min(NEW_NOTE_WIDTH_MM, Math.max(room, 20))))
      setNoteEdit({ itemId: null, ownerId, origin, stored: toStored(origin), startStored: toStored(origin), rotation: 0, width, height: null, size: DEFAULT_NOTE_SIZE_MM, lineSpacing: 1, initial: [{ runs: [] }], startedFrom: null, draft: [{ runs: [] }] })
      setTool('select')
      return
    }
    if (d.kind === 'grip') {
      const item = items.find((i) => i.id === d.id)
      if (!item) return
      if (d.grip.kind === 'tag-head' && item.tag) {
        const moved = tagElbows.moveCommand(item, toStored(d.to))
        send(moved.command, moved.label)
        return
      }
      const command = gripCommand({ model, view: annotatedView, item, grip: d.grip, to: d.to, snap: d.grip.kind === 'dim-point' ? nearestSnap(snaps, d.to, snapReach) : null, toPaper: toPaperPoint, toStored, items, ownerId, idPrefix: newId('grip') })
      if (typeof command === 'string') toast(command)
      else if (command)
        send(
          command,
          d.grip.kind === 'callout-head'
            ? 'move the callout bubble'
            : d.grip.kind.startsWith('callout-')
              ? 'resize callout and sync enlarged plan crop'
              : d.grip.kind === 'frame-corner'
                ? `resize ${item.figure?.kind === 'image' ? 'picture' : 'chart'}`
                : d.grip.kind === 'tag-head'
                  ? 'move the tag'
                  : d.grip.kind.startsWith('leader')
                    ? 'move the leader'
                    : d.grip.kind === 'detail-end'
                      ? 'drag the end'
                      : 'change the dimension',
        )
      return
    }
    if (d.kind === 'boundary-vertex') {
      setBoundary((b) => (b ? { ...b, points: b.points.map((p, i) => (i === d.index ? d.to : p)), picked: d.index } : b))
      return
    }
    if (d.kind === 'boundary-edge') {
      setBoundary((b) => {
        if (!b || b.points.length < 3) return b
        const n = b.points.length
        const i0 = d.index
        const i1 = (i0 + 1) % n
        const p0 = b.points[i0]!
        const p1 = b.points[i1]!
        const ex = p1.x - p0.x
        const ey = p1.y - p0.y
        const len = Math.hypot(ex, ey)
        if (len < 1e-3) return b
        const nx = -ey / len
        const ny = ex / len
        const proj = (d.to.x - d.from.x) * nx + (d.to.y - d.from.y) * ny
        const dx = nx * proj
        const dy = ny * proj
        return { ...b, points: b.points.map((p, i) => (i === i0 || i === i1 ? { x: p.x + dx, y: p.y + dy } : p)), picked: null }
      })
      return
    }
    if (d.kind === 'items-move') {
      if (!d.started) {
        // A click on one item of a multi-pick picks just that item.
        if (d.collapseTo) {
          setAlsoPicked([])
          setSelection({ kind: 'item', id: d.collapseTo })
        }
        return
      }
      // One tag dragged away from what it tags gets an elbow leader; near it, the plain move.
      const lone = d.ids.length === 1 ? items.find((i) => i.id === d.ids[0]) : undefined
      const head = lone?.tag ? lone.points[0] : undefined
      if (lone && head) {
        const at = toPaperPoint(head)
        const moved = tagElbows.moveCommand(lone, toStored({ x: at.x + d.to.x - d.from.x, y: at.y + d.to.y - d.from.y }))
        send(moved.command, moved.label)
        return
      }
      if (lone && lone.shape === 'callout' && lone.callout) {
        const poly = calloutBoundaryPolygon(lone)
        if (poly && poly.length >= 3) {
          const aS = toStored(d.from)
          const bS = toStored(d.to)
          const dS = { x: bS.x - aS.x, y: bS.y - aS.y }
          const shiftedPoly = poly.map((q) => ({ x: q.x + dS.x, y: q.y + dS.y }))
          const shiftedHead = lone.points[2] ? { x: lone.points[2].x + dS.x, y: lone.points[2].y + dS.y } : undefined
          const cmds = calloutSyncCommands(model, lone, shiftedPoly, shiftedHead)
          if (typeof cmds === 'string') toast.error(cmds)
          else if (cmds.length === 1 && cmds[0]) send(cmds[0], 'move the callout')
          else send({ type: 'batch_documents', label: 'Move callout and sync enlarged plan crop', commands: cmds }, 'move the callout')
          return
        }
      }
      if (lone && lone.dim) {
        const spec = lone.dim
        const paper = dimensionPoints(model, annotatedView, lone).points.map(toPaperPoint)
        const [p0, p1] = paper
        if (p0 && p1 && (spec.kind === 'linear' || spec.kind === 'aligned')) {
          const dx = p1.x - p0.x
          const dy = p1.y - p0.y
          const dist = Math.hypot(dx, dy) || 1
          const axis = spec.kind === 'aligned' ? { x: dx / dist, y: dy / dist } : spec.direction === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 }
          const n = { x: -axis.y, y: axis.x }
          const deltaOffset = (d.to.x - d.from.x) * n.x + (d.to.y - d.from.y) * n.y
          send({ type: 'update_drawing_item', itemId: lone.id, dim: { ...spec, offsetMm: Math.round((spec.offsetMm + deltaOffset) * 10) / 10 } }, 'move the dimension')
          return
        }
      }
      const made = dragMoveCommand({ items, ids: d.ids, from: d.from, to: d.to, toStored, ownerId, idPrefix: newId('mod') })
      if (!made.ok) toast(made.reason)
      else send(made.command, made.summary.toLowerCase())
      return
    }
    if (d.kind === 'note-move') {
      const dx = d.to.x - d.from.x
      const dy = d.to.y - d.from.y
      const item = items.find((i) => i.id === d.id)
      if (Math.hypot(dx, dy) < 0.3) {
        if (d.wasSelected && item) editNote(item)
        return
      }
      const block = blocks.get(d.id)
      if (block && item) {
        const nextOrigin = { x: block.origin.x + dx, y: block.origin.y + dy }
        const movedBlock: TextBlock = { ...block, origin: nextOrigin }
        const nextLeaders = noteLeadersAfterMove(item, movedBlock, toPaperPoint, toStored)
        const hasLeaders = nextLeaders.length > 0
        send(
          {
            type: 'move_text_note',
            itemId: d.id,
            at: toStored(nextOrigin),
            ...(hasLeaders ? { leaders: nextLeaders } : {}),
          },
          'move the note',
        )
      }
      return
    }
    if (d.kind === 'note-size') {
      const f = d.frame
      if (Math.abs(f.width - d.start.width) < 0.05 && f.height === d.start.height && f.origin.x === d.start.origin.x) return
      const moved = Math.hypot(f.origin.x - d.start.origin.x, f.origin.y - d.start.origin.y) > 1e-3
      if (noteEdit && noteEdit.itemId === d.id) {
        setNoteEdit({ ...noteEdit, width: f.width, height: f.height, origin: f.origin, stored: moved ? toStored(f.origin) : noteEdit.stored })
        return
      }
      send({ type: 'resize_text_note', itemId: d.id, width: f.width, height: f.height, ...(moved ? { at: toStored(f.origin) } : {}) }, 'resize the note')
      return
    }
    if (d.kind === 'draw') {
      if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < MIN_DRAG_MM) return
      if (d.shape === 'dimension' && annotatedView) {
        // Snapped ends follow what they landed on; a nearly square drag becomes a horizontal or vertical dimension.
        const made = dimensionFromDrag({ at: d.a, snap: nearestSnap(snaps, d.a, snapReach) }, { at: d.b, snap: nearestSnap(snaps, d.b, snapReach) })
        const id = newId('dim')
        if (send({ type: 'add_drawing_item', itemId: id, ownerId, shape: 'dimension', points: made.paper.map(toStored), dim: made.dim }, 'add a dimension')) setSelection({ kind: 'item', id })
        return
      }
      const detailLike = Boolean(active ? activeDrafting : frame)
      const b = d.shape === 'dimension' && detailLike ? straighten(d.a, d.b) : d.b
      const id = newId('item')
      if (d.shape === 'callout') {
        // Which view it refers to is asked next; nothing is saved until that is picked.
        setCalloutDraft({ a: toStored(d.a), b: toStored(b), head: toStored({ x: Math.min(d.a.x, b.x) - 8, y: Math.min(d.a.y, b.y) - 8 }) })
        return
      }
      if (d.shape === 'rect') {
        // A rectangle is four detail lines joined at the corners; the whole chain stays picked.
        const sides = rectangleLines(toStored(d.a), toStored(b)).map(([p, q], k) => ({ type: 'add_drawing_item' as const, itemId: `${id}-${k}`, ownerId, shape: 'line' as const, points: [p, q] }))
        if (send({ type: 'batch_documents', label: 'Draw a rectangle', commands: sides }, 'draw a rectangle')) {
          setSelection({ kind: 'item', id: `${id}-0` })
          setAlsoPicked(sides.slice(1).map((c) => c.itemId))
        }
        return
      }
      if (send({ type: 'add_drawing_item', itemId: id, ownerId, shape: d.shape, points: [toStored(d.a), toStored(b)] }, `add a ${d.shape}`)) setSelection({ kind: 'item', id })
      return
    }
    if (d.kind === 'frame') {
      if (rectMoved(d.start, d.rect) < 0.3) return
      const { center, size } = centerAndSize(d.rect)
      const vp = placed.find((p) => p.viewport.id === d.id)
      send({ type: 'resize_viewport', viewportId: d.id, size, center }, `change the crop box of ${vp?.view.name ?? 'the view'}`)
      return
    }
    if (d.kind === 'crop') {
      if (!frame || !openView || rectMoved(d.start, d.rect) < 0.3) return
      const a = paperToModel(frame, { x: d.rect.min.x, y: d.rect.max.y })
      const b = paperToModel(frame, { x: d.rect.max.x, y: d.rect.min.y })
      const crop = cropForWindow(openView, viewCrop(openView), { min: a, max: b })
      send({ type: 'set_view_crop', viewId: openView.id, crop }, `change the crop box of ${openView.name}`)
      return
    }
    const dx = d.to.x - d.from.x
    const dy = d.to.y - d.from.y
    if (Math.hypot(dx, dy) < 0.3) return
    if (d.extras && d.extras.length > 0) {
      const commands = [
        { type: 'move_viewport' as const, viewportId: d.id, center: { x: d.origin.x + dx, y: d.origin.y + dy } },
        ...d.extras.map((ex) => ({ type: 'move_viewport' as const, viewportId: ex.id, center: { x: ex.origin.x + dx, y: ex.origin.y + dy } })),
      ]
      send({ type: 'batch_documents', label: `Move ${commands.length} viewports`, commands }, 'move the viewports')
      return
    }
    send({ type: 'move_viewport', viewportId: d.id, center: { x: d.origin.x + dx, y: d.origin.y + dy } }, 'move the viewport')
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setDropHint(false)
    const viewId = e.dataTransfer.getData(VIEW_DRAG_TYPE)
    if (!viewId || target.kind !== 'sheet') return
    e.preventDefault()
    if (!canEdit) {
      toast.error(blockedReason)
      return
    }
    const at = paperAt(e.clientX, e.clientY)
    const view = model.elements[viewId]
    if (!at || view?.kind !== 'view') return
    const id = newId('vp')
    if (send({ type: 'place_viewport', viewportId: id, sheetId: target.sheetId, viewId, center: at }, `place ${view.name}`)) {
      setSelection({ kind: 'viewport', id })
      toast.success(`${view.name} placed at ${scaleLabel(view.props?.scale ?? 48)}. Double-click it to edit the view on the sheet.`)
    }
  }

  const selectedViewport = selection?.kind === 'viewport' ? placed.find((v) => v.viewport.id === selection.id) ?? null : null
  const selectedItem = selection?.kind === 'item' ? items.find((i) => i.id === selection.id) ?? null : null
  const selectedMarkup = selection?.kind === 'item' ? sheetMarkups.find((m) => m.id === selection.id) ?? null : null
  const selectedLock = selectedItem ? (locks.get(selectedItem.id) ?? null) : null

  /** The open, resizing, or dragging note, laid out from the live position/box by the same engine that prints it. */
  const liveBlock = useMemo<TextBlock | null>(() => {
    if (noteEdit) {
      const layout = layoutDraft(noteEdit.draft, { box: { width: noteEdit.width, height: noteEdit.height, rotation: noteEdit.rotation }, lineSpacing: noteEdit.lineSpacing }, noteEdit.size)
      return { itemId: noteEdit.itemId ?? 'new-note', origin: noteEdit.origin, rotation: noteEdit.rotation, layout }
    }
    if (drag?.kind === 'note-move') {
      const base = blocks.get(drag.id)
      if (!base) return null
      return {
        ...base,
        origin: { x: base.origin.x + (drag.to.x - drag.from.x), y: base.origin.y + (drag.to.y - drag.from.y) },
      }
    }
    if (drag?.kind === 'note-size') {
      const item = items.find((i) => i.id === drag.id)
      const resolved = item ? resolveNote(item) : null
      if (!resolved) return null
      const f = drag.frame
      return {
        itemId: drag.id,
        origin: f.origin,
        rotation: f.rotation,
        layout: layoutDraft(resolved.note.paragraphs, { box: { width: f.width, height: f.height, rotation: f.rotation }, lineSpacing: resolved.note.lineSpacing }, resolved.size),
        ...(resolved.note.mask ? { mask: true } : {}),
      }
    }
    if (drag?.kind === 'grip' && (drag.grip.kind === 'leader-tip' || drag.grip.kind === 'leader-elbow')) {
      return blocks.get(drag.id) ?? null
    }
    return null
  }, [noteEdit, drag, items, blocks])

  /** Live leader primitives (shoulder + diagonal + arrowhead) while moving/resizing a note or dragging its leader grips. */
  const liveNoteLeaderPrims = useMemo<Primitive[]>(() => {
    if (!liveBlock) return []
    const item = items.find((i) => i.id === liveBlock.itemId)
    if (!item || item.shape !== 'text') return []
    const all = [...(item.note?.leader ? [item.note.leader] : []), ...(item.note?.leaders ?? [])]
    if (all.length === 0) return []
    const out: Primitive[] = []
    for (let i = 0; i < all.length; i++) {
      const l = all[i]!
      let toP = toPaperPoint(l.to)
      let elbowP = l.elbow ? toPaperPoint(l.elbow) : undefined
      if (drag?.kind === 'note-move' || drag?.kind === 'note-size') {
        if (elbowP) elbowP = noteAutoShoulderPaper(liveBlock, toP)
      } else if (drag?.kind === 'grip' && drag.id === item.id && drag.grip.index === i) {
        if (drag.grip.kind === 'leader-tip') toP = drag.to
        else if (drag.grip.kind === 'leader-elbow') {
          const local = paperToBox(liveBlock, drag.to)
          const mids = liveBlock.layout.lines.length > 0 ? liveBlock.layout.lines.map((ln) => ln.top + ln.height / 2) : [liveBlock.layout.height / 2]
          let bestMid: number | null = null
          let bestDist = 2.5
          for (const m of mids) {
            const d = Math.abs(local.y - m)
            if (d <= bestDist) {
              bestDist = d
              bestMid = m
            }
          }
          elbowP = bestMid !== null ? boxToPaper(liveBlock, { x: local.x, y: bestMid }) : drag.to
        }
      }
      const start = leaderStart(liveBlock, elbowP ?? toP)
      out.push(...leaderPrimitives(start, toP, elbowP, l.arrow ?? 'arrow'))
    }
    return out
  }, [liveBlock, items, toPaperPoint, drag])

  /** Live dimension preview while dragging a dimension body, offset grip, or endpoint grip. */
  const liveDimPrims = useMemo<Primitive[]>(() => {
    if (drag?.kind === 'grip' && (drag.grip.kind === 'dim-offset' || drag.grip.kind === 'dim-point')) {
      const item = items.find((i) => i.id === drag.id)
      if (!item?.dim) return []
      const cmd = gripCommand({
        model,
        view: annotatedView,
        item,
        grip: drag.grip,
        to: drag.to,
        snap: drag.grip.kind === 'dim-point' ? nearestSnap(snaps, drag.to, snapReach) : null,
        toPaper: toPaperPoint,
        toStored,
        items,
        ownerId,
      })
      if (!cmd || typeof cmd === 'string' || cmd.type !== 'update_drawing_item') return []
      const previewItem: DrawingItem = {
        ...item,
        ...(cmd.points ? { points: cmd.points } : {}),
        ...(cmd.dim ? { dim: cmd.dim } : {}),
      }
      const prims: Primitive[] = []
      drawDimension({ model, view: annotatedView, toPaper: toPaperPoint, scale: drawFrame ? drawFrame.scale : 1, prims }, previewItem)
      return prims
    }
    if (drag?.kind === 'items-move' && drag.started && drag.ids.length === 1) {
      const item = items.find((i) => i.id === drag.ids[0])
      if (!item?.dim) return []
      const spec = item.dim
      const paper = dimensionPoints(model, annotatedView, item).points.map(toPaperPoint)
      const [p0, p1] = paper
      if (!p0 || !p1 || (spec.kind !== 'linear' && spec.kind !== 'aligned')) return []
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const dist = Math.hypot(dx, dy) || 1
      const axis = spec.kind === 'aligned' ? { x: dx / dist, y: dy / dist } : spec.direction === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 }
      const n = { x: -axis.y, y: axis.x }
      const deltaOffset = (drag.to.x - drag.from.x) * n.x + (drag.to.y - drag.from.y) * n.y
      const previewItem: DrawingItem = { ...item, dim: { ...spec, offsetMm: Math.round((spec.offsetMm + deltaOffset) * 10) / 10 } }
      const prims: Primitive[] = []
      drawDimension({ model, view: annotatedView, toPaper: toPaperPoint, scale: drawFrame ? drawFrame.scale : 1, prims }, previewItem)
      return prims
    }
    return []
  }, [drag, items, model, annotatedView, snaps, snapReach, toPaperPoint, toStored, ownerId, drawFrame])

  useEffect(() => {
    onToolsAvailable?.(tools.map((t) => t.tool))
  }, [tools, onToolsAvailable])

  /** Press on a placed item with Select: pick it (or keep the multi-pick it is in) and hold the pointer, ready to drag. */
  const pressItem = (e: React.PointerEvent<SVGElement>, itemId: string) => {
    const inPick = selectedIds.length > 1 && selectedIds.includes(itemId)
    if (!inPick) {
      setAlsoPicked([])
      setSelection({ kind: 'item', id: itemId })
    }
    const at = paperAt(e.clientX, e.clientY)
    if (!at) {
      e.stopPropagation()
      return
    }
    startDrag(e, { kind: 'items-move', ids: inPick ? selectedIds : [itemId], from: at, to: at, started: false, collapseTo: inPick ? itemId : null })
  }

  const grabNote = (item: DrawingItem, edge: NoteEdge, e: React.PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const block = noteEdit?.itemId === item.id && liveBlock ? liveBlock : blocks.get(item.id)
    const at = paperOf(e)
    if (!block || !at) return
    const height = noteEdit?.itemId === item.id ? noteEdit.height : (resolveNote(item)?.note.box.height ?? null)
    const start: NoteFrame = { origin: block.origin, width: block.layout.width, height, rotation: block.rotation, contentHeight: block.layout.contentHeight }
    startDrag(e, { kind: 'note-size', id: item.id, edge, from: at, start, frame: start })
  }

  if (drawn.error || !drawn.scene) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{drawn.error ?? 'Drawing…'}</div>
  }

  const toolHint = draftInput.prompt
    ? draftInput.prompt
    : tool === 'markup' && target.kind === 'sheet' && !active
    ? markupBrush.eraser
      ? 'Markup eraser: click or drag across review strokes to erase them. M marker · H highlighter · Esc done.'
      : `Sheet ${markupBrush.tool === 'highlighter' ? 'highlighter' : 'marker'}: draw with mouse or stylus${markupBrush.smartShapes ? ' (Smart snap on)' : ''}. M marker · H highlighter · E erase · 1–6 colour · S snap · Esc done.`
    : tool === 'keynote' && !noteEdit
    ? `Click an element to give it keynote ${cleanKey(keynoteKey) ?? '(pick one first)'}: it gets the key and a keynote tag, and the sheet's keynote list shows it. Esc to stop.`
    : noteEdit
    ? 'Editing the note: what you see is what prints. ⌘B / ⌘I / ⌘U, ⌘⇧8 bullets, ⌘⇧7 numbers, Shift+Enter new line. Drag a side grip to re-wrap. Esc or click outside saves.'
    : active
    ? tool === 'select'
      ? activeDrafting
        ? 'Drag anything drawn to move it. Pick a tool to draw inside the view. Drag the frame edges to change its crop box.'
        : 'Click to select, Tab for more, Shift+drag to box select, drag a selection to move it. Drag the frame edges to crop. Route, Split and an add-on’s drawing tools (in a plan) work here; the other model tools open the view by itself and bring you back.'
      : tool === 'text'
        ? 'Click inside the view where the note starts, or drag across to set its width.'
        : `Drag inside the view to draw a ${tool}. Esc to stop.`
    : tool === 'select'
      ? target.kind === 'sheet'
        ? 'Drag views from the panel onto the sheet. Drag a viewport or anything drawn to move it, a viewport’s edges to crop it. Double-click a view to edit it here on the sheet.'
        : drafting
          ? 'Drag anything drawn to move it (Esc cancels). Pick a tool to draw lines, text and dimensions. Drag the crop box edges to crop.'
          : modelView
            ? 'Click to select, Tab for more, Shift+drag to box select, drag a selection to move it. Drag the crop box edges to crop.'
            : 'How this view prints on a sheet. Drag the crop box edges to crop.'
      : tool === 'text'
        ? 'Click where the note starts, or drag across to set its width. Type, then Esc or click outside to save.'
        : `Drag to draw a ${tool === 'cloud' ? 'revision cloud' : tool}. Esc to stop.`

  /** The open view drawing's crop box on paper (the frame of its printed drawing). */
  const showOwnCrop = target.kind === 'detail' && frame && openView && openView.props?.cropView !== false && openView.props?.showCropBox !== false
  const ownCropRect = frame ? (drag?.kind === 'crop' ? drag.rect : rectFromCenter(frame.center, frame.size)) : null
  /** Placed items being dragged with Select: their pick boxes follow the pointer and a preview shows where they land. */
  const moveDelta = drag?.kind === 'items-move' && drag.started ? { x: drag.to.x - drag.from.x, y: drag.to.y - drag.from.y } : null
  const movingIds = new Set(drag?.kind === 'items-move' ? drag.ids : [])
  const moveGhost = moveDelta
    ? dragGhost({
        items,
        ids: [...movingIds],
        delta: moveDelta,
        toPaper: toPaperPoint,
        storedPerPaperMm: drawFrame ? drawFrame.scale : 1,
        boxOf: (item) => {
          const block = item.shape === 'text' ? blocks.get(item.id) : undefined
          if (block) return { x: block.origin.x, y: block.origin.y, w: block.layout.width, h: Math.max(block.layout.height, 4) }
          return item.dim || item.tag ? annotationBox(model, annotatedView, item, toPaperPoint) : detailBox(item, toPaperPoint)
        },
      })
    : null

  const renderFrame = (entry: PlacedFrame) => (
    <ViewportFrame
      key={entry.viewport.id}
      entry={entry}
      drag={drag}
      tool={tool}
      selected={selectedViewportIds.includes(entry.viewport.id)}
      isActive={active?.viewport.id === entry.viewport.id}
      dimmed={active !== null && active.viewport.id !== entry.viewport.id}
      canEdit={canEdit}
      blockedReason={blockedReason}
      onSelect={(e) => {
        if (tool !== 'select' || e.button !== 0) return
        e.stopPropagation()
        if (e.shiftKey && selection?.kind === 'viewport') {
          if (entry.viewport.id === selection.id) {
            if (alsoViewports.length > 0) {
              setSelection({ kind: 'viewport', id: alsoViewports[0]! })
              setAlsoViewports(alsoViewports.slice(1))
            }
          } else {
            setAlsoViewports((cur) => (cur.includes(entry.viewport.id) ? cur.filter((id) => id !== entry.viewport.id) : [...cur, entry.viewport.id]))
          }
          return
        }
        const keepMulti = selectedViewportIds.length > 1 && selectedViewportIds.includes(entry.viewport.id)
        if (!keepMulti) {
          setAlsoViewports([])
          setSelection({ kind: 'viewport', id: entry.viewport.id })
        }
        if (!canEdit) return
        const at = paperOf(e)
        if (!at) return
        const extras = keepMulti
          ? selectedViewportIds
              .filter((id) => id !== entry.viewport.id)
              .map((id) => placed.find((p) => p.viewport.id === id))
              .filter((p): p is PlacedFrame => p !== undefined)
              .map((p) => ({ id: p.viewport.id, origin: p.viewport.center }))
          : undefined
        startDrag(e, { kind: 'move', id: entry.viewport.id, from: at, origin: entry.viewport.center, to: at, ...(extras && extras.length > 0 ? { extras } : {}) })
      }}
      onActivate={() => openPlaced(entry.viewport.id)}
      onGrab={(handle, e) => {
        if (e.button !== 0) return
        if (!canEdit) {
          e.stopPropagation()
          toast.error(blockedReason)
          return
        }
        if (entry.view.viewType === 'three_d' && entry.view.props?.camera3d) {
          e.stopPropagation()
          toast.info(`${entry.view.name}'s frame is its 3D crop box seen from its camera. Double-click it to open the view, then drag the box's grips or type its size.`)
          return
        }
        const at = paperOf(e)
        if (at) startDrag(e, { kind: 'frame', id: entry.viewport.id, handle, from: at, start: entry.rect, rect: entry.rect })
      }}
    />
  )

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 px-2 py-1.5">
          {!onToolChange && (
          <ToggleGroup type="single" size="sm" variant="outline" value={tool} onValueChange={(v) => v && setTool(tools.find((t) => t.tool === v)?.tool ?? 'select')} aria-label="Drawing tools">
            {tools.map((t) => (
              <Tooltip key={t.tool}>
                <TooltipTrigger asChild>
                  <ToggleGroupItem value={t.tool} aria-label={t.label} disabled={t.tool !== 'select' && !canEdit}>
                    {t.icon}
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>{t.tool !== 'select' && !canEdit ? blockedReason : t.label}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
          )}
          <div className="ml-auto flex items-center gap-1">
            {target.kind === 'sheet' && !active && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={tool === 'markup' ? 'secondary' : 'outline'}
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                      disabled={!canEdit}
                      aria-pressed={tool === 'markup'}
                      data-testid="sheet-marker-toggle"
                      onClick={() => setTool(tool === 'markup' ? 'select' : 'markup')}
                    >
                      <PenTool className="size-3.5" style={tool === 'markup' ? { color: markupBrush.color } : undefined} />
                      Marker
                      <kbd className="rounded border border-border/80 bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground">
                        {SHEET_MARKUP_SHORTCUT}
                      </kbd>
                      {openMarkupCount > 0 && (
                        <span className="rounded-full bg-danger-100 px-1.5 text-[10px] font-semibold text-danger-700">
                          {openMarkupCount}
                        </span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{!canEdit ? blockedReason : 'Felt-tip Marker for quick redlines on this sheet (M for Marker, H for Highlighter; non-printing by default)'}</TooltipContent>
                </Tooltip>
                {sheetMarkups.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" data-testid="sheet-markups-menu">
                        {markupBrush.showMarkups ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 text-muted-foreground" />}
                        Markups ({sheetMarkups.length})
                        <ChevronDown className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className={CLOSES_AT_ONCE}>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onSelect={() => setMarkupBrush((b) => ({ ...b, showMarkups: !b.showMarkups }))}>
                          {markupBrush.showMarkups ? <EyeOff className="mr-2 size-3.5" /> : <Eye className="mr-2 size-3.5" />}
                          {markupBrush.showMarkups ? 'Hide markups on screen' : 'Show markups on screen'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setMarkupBrush((b) => ({ ...b, showResolved: !b.showResolved, showMarkups: true }))}>
                          {markupBrush.showResolved ? 'Hide resolved markups' : 'Show resolved markups'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            if (target.kind !== 'sheet') return
                            void printSheetPdf(model, target.sheetId, sheetTitle, backgrounds, sheetImages?.source ?? null, undefined, {
                              includeMarkups: true,
                              includeResolvedMarkups: markupBrush.showResolved,
                            })
                              .then((printed) => toast.success(`Printed check set with markups (${printed.fileName})`))
                              .catch((err) => toast.error(err instanceof Error ? err.message : 'Check-set print failed'))
                          }}
                        >
                          <Printer className="mr-2 size-3.5" />
                          Print check set (with markups)
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          disabled={!canEdit || !sheetMarkups.some((m) => m.markup?.status === 'addressed')}
                          onSelect={() => {
                            if (target.kind !== 'sheet') return
                            send({ type: 'clear_sheet_markups', sheetId: target.sheetId, statuses: ['addressed'] }, 'clear yellow-lined markups')
                          }}
                        >
                          <Trash2 className="mr-2 size-3.5" />
                          Clear yellow-lined markups
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canEdit}
                          className="text-destructive focus:text-destructive"
                          onSelect={() => {
                            if (target.kind !== 'sheet') return
                            send({ type: 'clear_sheet_markups', sheetId: target.sheetId }, 'clear all sheet markups')
                            setSelection(null)
                          }}
                        >
                          <Trash2 className="mr-2 size-3.5" />
                          Clear all markups on sheet
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Separator orientation="vertical" className="mx-0.5 h-4" />
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={zoomControl.zoomOut}>
                  <ZoomOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out (−). Scroll or pinch zooms at the pointer, as in 3D.</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Zoom ${zoomControl.percent}%`} data-testid="drawing-zoom">
                  {zoomControl.percent}%
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={CLOSES_AT_ONCE}>
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={zoomControl.fit}>
                    Zoom to fit
                    <span className="ml-auto pl-4 text-xs text-muted-foreground">F</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={zoomControl.actualSize}>Actual size (100%)</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {[2, 4].map((f) => (
                    <DropdownMenuItem key={f} onSelect={() => zoomControl.setZoom(f)}>
                      {f}× fit
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={zoomControl.zoomIn}>
                  <ZoomIn />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in (+). Pan: middle-drag, Space + drag, or drag empty paper. Fit: F or double-click the middle button.</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col" data-testid="drawing-canvas-area">
        {active && <EditingViewIndicator viewName={active.view.name} onDone={finishEditing} />}
        <div className={`pointer-events-none absolute inset-x-3 z-20 flex justify-center ${active ? 'top-12' : 'top-3'}`} data-testid="draft-options-slot">
          {tool === 'markup' && target.kind === 'sheet' && !active ? (
            <MarkupBar
              brush={markupBrush}
              onChange={setMarkupBrush}
              onDone={() => setTool('select')}
              openCount={openMarkupCount}
            />
          ) : (
            <DraftOptionsBar
            tool={tool}
            settings={draft.settings}
            onSettings={draft.setSettings}
            pending={draft.pending}
            params={draft.params}
            onParams={draft.setParams}
            prompt={null}
            onCancel={() => {
              if (plineSketch) cancelPlineSketch()
              else draftInput.cancel()
            }}
            calloutMode={calloutMode}
            onCalloutMode={(mode) => {
              setCalloutMode(mode)
              if (mode === 'rect' && plineSketch?.itemId === null) cancelPlineSketch()
            }}
            calloutActions={
              !boundary && !plineSketch && tool === 'select' && selectedItem?.shape === 'callout' && selectedItem.callout && alsoPicked.length === 0
                ? {
                    isPolygon: Boolean(selectedItem.callout.boundary && selectedItem.callout.boundary.length >= 3),
                    canEdit,
                    onEditBoundary: () => startBoundary(selectedItem.id),
                    onSketchNew: () => startCalloutPlineSketch(selectedItem.id),
                    ...(selectedItem.callout.boundary && selectedItem.callout.boundary.length >= 3 ? { onResetRect: () => resetCalloutRectangle(selectedItem.id) } : {}),
                    onOpenView: () => onOpenView(selectedItem.callout!.viewId),
                  }
                : null
            }
            sketch={
              plineSketch
                ? {
                    prompt:
                      plineSketch.points.length < 3
                        ? 'Sketch P-line callout: click corners snapping to walls & grids (Shift = 90° ortho, Backspace = undo).'
                        : `Sketch P-line callout (${plineSketch.points.length} corners): click first corner, double-click, or press Enter to close.`,
                    finishLabel: 'Close P-Line (Enter)',
                    onFinish: () => finishPlineSketch(),
                    onCancel: cancelPlineSketch,
                  }
                : boundary
                  ? {
                      prompt:
                        boundary.kind === 'callout'
                          ? 'Edit callout boundary: drag corners (snaps to walls & grids), click/drag + to add an L-shape notch, Delete removes a corner.'
                          : 'Edit boundary: drag a corner, click a + to add a corner, click a corner and press Delete to remove it.',
                      onFinish: finishBoundary,
                      onCancel: cancelBoundary,
                      ...(boundary.kind === 'callout'
                        ? {
                            onSketchNew: () => startCalloutPlineSketch(boundary.itemId),
                            onResetRect: () => resetCalloutRectangle(boundary.itemId),
                          }
                        : {}),
                    }
                  : null
            }
          />
          )}
        </div>
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 touch-none overflow-hidden overscroll-contain data-[space-pan=true]:cursor-grab data-[panning]:cursor-grabbing"
          onDragOver={(e) => {
            if (target.kind === 'sheet' && !active && e.dataTransfer.types.includes(VIEW_DRAG_TYPE)) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDropHint(true)
            }
          }}
          onDragLeave={() => setDropHint(false)}
          onDrop={onDrop}
          data-testid={target.kind === 'sheet' ? 'sheet-canvas' : 'detail-canvas'}
          data-editing-view={active ? active.view.id : undefined}
          onContextMenu={(e) => {
            if (selectedIds.length === 0 || !annotatedView) return drawingMenu.open(e)
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setTagMenuAt({ x: e.clientX - r.left, y: e.clientY - r.top })
          }}
        >
          {drawingMenu.element}
          <SelectionContextMenu at={tagMenuAt} onClose={() => setTagMenuAt(null)} selectionLabel={selectedIds.length === 1 ? 'Tag' : `${selectedIds.length} items`} tags={tagElbows.menu} />
          <div
            className={`bg-white shadow-sm ring-1 ${dropHint ? 'ring-2 ring-primary' : 'ring-border'}`}
            ref={paperRef}
            style={zoomControl.paperStyle}
            data-testid="drawing-paper"
            data-zoom={zoom.toFixed(3)}
          >
            <div className="absolute inset-0 select-none [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
            {printedPreview && drawn.scene && (
              <div className={liveNoteId ? 'invisible pointer-events-none' : undefined}>
                <PrintedPdfLayer
                  scene={drawn.scene}
                  title={printTitle}
                  widthPx={paperWidthPx}
                  images={sheetImages?.source ?? null}
                  viewportRef={scrollRef}
                  frame={`${zoomControl.paperStyle.left}:${zoomControl.paperStyle.top}:${zoomControl.paperStyle.width}`}
                />
              </div>
            )}
            <svg
              ref={overlayRef}
              className={`absolute inset-0 h-full w-full select-none overflow-visible ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
              viewBox={`0 0 ${paper.x} ${paper.y}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={(e) => {
                if (plineSketch && plineSketch.points.length >= 3) {
                  e.preventDefault()
                  finishPlineSketch()
                  return
                }
                if (draftInput.finish()) return
                // A press on a viewport starts a move with the pointer captured here, so the browser sends
                // the double-click to this overlay rather than the viewport: find the viewport under the pointer.
                if (e.target !== e.currentTarget || tool !== 'select') return
                const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.hasAttribute('data-viewport-id'))
                const id = hit?.getAttribute('data-viewport-id')
                if (id && id !== active?.viewport.id) openPlaced(id)
              }}
              role="application"
              aria-label={active ? `Editing ${active.view.name} on the sheet` : target.kind === 'sheet' ? 'Sheet. Drop views here.' : 'Detail view drawing area'}
            >
              {placed.filter((entry) => entry.viewport.id !== active?.viewport.id).map(renderFrame)}
              {active && (
                <path
                  d={`M0 0H${paper.x}V${paper.y}H0Z M${active.rect.min.x} ${active.rect.min.y}V${active.rect.max.y}H${active.rect.max.x}V${active.rect.min.y}Z`}
                  fillRule="evenodd"
                  fill="white"
                  fillOpacity={0.65}
                  data-testid="sheet-dim"
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={finishEditing}
                >
                  <title>Double-click outside the view to finish editing it</title>
                </path>
              )}
              {active && renderFrame(active)}
              {selectedSchedule && scheduleColumns && tool === 'select' && (
                <ScheduleColumnGrips
                  name={selectedSchedule.view.name}
                  rect={selectedSchedule.rect}
                  columns={scheduleColumns}
                  canEdit={canEdit}
                  blockedReason={blockedReason}
                  paperOf={paperOf}
                  onResize={({ columnId, widthMm }) => send({ type: 'edit_schedule', viewId: selectedSchedule.view.id, steps: [{ op: 'resize_column', columnId, widthMm }] }, 'change the column width')}
                />
              )}
              {!active && tool === 'select' && drawn.scene && (
                <g data-testid="sheet-link-hotspots">
                  {drawn.scene.primitives.flatMap((pr, idx) => {
                    if (pr.kind !== 'text' || !pr.href) return []
                    const estW = Math.max(8, pr.text.length * pr.size * 0.65)
                    const estH = pr.size * 1.6
                    const x = pr.anchor === 'middle' ? pr.at.x - estW / 2 : pr.anchor === 'end' ? pr.at.x - estW : pr.at.x
                    const y = pr.at.y - estH * 0.75
                    return [
                      <a
                        key={`href-${idx}`}
                        href={pr.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cursor-pointer"
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <rect x={x} y={y} width={estW} height={estH} fill="transparent">
                          <title>{`Open ${pr.href}`}</title>
                        </rect>
                      </a>,
                    ]
                  })}
                </g>
              )}
              {spaces && modelEdit && floorPlanView && (
                <SpacesPlanLayer
                  projectId={spaces.projectId}
                  model={model}
                  view={floorPlanView}
                  paperOf={paperOf}
                  paperPerPixel={1 / (pxPerMm || 1)}
                  submit={modelEdit.submit}
                  hint={modelEdit.hint}
                  mode={tracing ? spaces.mode : null}
                  drawerOpen={spaces.drawerOpen}
                  onDrawn={spaces.onDrawn}
                  onCancel={spaces.onCancel}
                  onSeparatorLine={spaces.onSeparatorLine}
                />
              )}
              {ceilings && modelEdit && ceilingPlanView && tracing && <CeilingPlanLayer model={model} view={ceilingPlanView} paperOf={paperOf} paperPerPixel={1 / (pxPerMm || 1)} submit={modelEdit.submit} hint={modelEdit.hint} settings={ceilings.settings} parsed={ceilings.parsed} onResult={ceilings.onResult} onCancel={ceilings.onCancel} />}
              {questions && floorPlanView && <QuestionPinsLayer model={model} view={floorPlanView} onOpen={questions.onOpen} focusedQuestionId={questions.focusedQuestionId ?? null} />}
              {modelEdit && modelView && placing && !tracing && (
                <PlaceOnDrawingLayer
                  model={model}
                  view={modelView}
                  spec={placing}
                  paperOf={paperOf}
                  submit={modelEdit.submit}
                  hint={modelEdit.hint}
                  onPlaced={(partId) => onPlaced?.(partId)}
                  onCancel={() => onPlacingCancel?.()}
                />
              )}
              {modelEdit && modelView && tool === 'select' && !noteEdit && !placing && !tracing && (
                <ModelDrawingLayer model={model} view={modelView} bridge={modelEdit} paperOf={paperOf} paperMmPerPx={1 / (pxPerMm || 1)} onPicked={() => setSelection(null)} />
              )}
              {modelEdit && modelView && tool === 'select' && !noteEdit && !placing && !tracing && <LevelLinesLayer model={model} view={modelView} bridge={modelEdit} paperOf={paperOf} paperMmPerPx={1 / (pxPerMm || 1)} />}
              {(() => {
                const diagramView = active?.view.props?.diagram ? active.view : target.kind === 'detail' && openView?.props?.diagram ? openView : null
                const diagramFrame = active?.view.props?.diagram ? active.frame : frame
                if (!modelEdit || !diagramView || !diagramFrame || tool !== 'select' || noteEdit || placing || tracing) return null
                return (
                  <DiagramLayer
                    model={model}
                    view={diagramView}
                    toPaper={(p) => modelToPaper(diagramFrame, p)}
                    toDrawing={(p) => paperToModel(diagramFrame, p)}
                    paperOf={paperOf}
                    selectedIds={modelEdit.selectedIds}
                    canEdit={canEdit}
                    blockedReason={blockedReason}
                    submit={submit}
                    onSelect={(id) => {
                      setSelection(null)
                      modelEdit.select(id)
                    }}
                    hint={(m) => modelEdit.hint(m)}
                  />
                )
              })()}
              {target.kind === 'detail' && openView && ownCropRect && <AnnotationCropRegion rect={ownCropRect} props={openView.props} testId="view-annotation-crop" />}
              {showOwnCrop && ownCropRect && openView?.props?.cropPolygon && openView.props.cropPolygon.length >= 3 && drag?.kind !== 'crop' && (
                <polygon
                  points={openView.props.cropPolygon.map((pt) => {
                    const q = toPaperPoint(pt)
                    return `${q.x},${q.y}`
                  }).join(' ')}
                  fill="none"
                  stroke={PRIMARY}
                  strokeOpacity={0.6}
                  strokeWidth={0.45}
                  strokeDasharray="2 1"
                  pointerEvents="none"
                  data-testid="view-crop-polygon"
                />
              )}
              {showOwnCrop && ownCropRect && (
                <CropBoxGrips
                  rect={ownCropRect}
                  dragging={drag?.kind === 'crop'}
                  canEdit={canEdit}
                  blockedReason={blockedReason}
                  testId="view-crop-box"
                  onGrab={(handle, e) => {
                    if (e.button !== 0 || tool !== 'select') return
                    if (!canEdit) {
                      e.stopPropagation()
                      toast.error(blockedReason)
                      return
                    }
                    const at = paperOf(e)
                    if (at) startDrag(e, { kind: 'crop', handle, from: at, start: ownCropRect, rect: ownCropRect })
                  }}
                />
              )}
              {[...items]
                .sort((a, b) => {
                  const rank = (x: DrawingItem) => (x.shape === 'region' ? 0 : x.shape === 'component' || x.shape === 'repeat' || x.shape === 'batt' ? 2 : x.shape === 'dimension' || x.shape === 'tag' || x.shape === 'text' ? 3 : 1)
                  return rank(a) - rank(b)
                })
                .map((item) => {
                  const noteBlock = item.shape === 'text' ? (liveBlock && liveBlock.itemId === item.id ? liveBlock : blocks.get(item.id)) : undefined
                  if (noteBlock) {
                    const lock = locks.get(item.id)
                    return (
                      <NoteHandles
                        key={item.id}
                        block={noteBlock}
                        selected={selectedIds.includes(item.id)}
                        editing={noteEdit?.itemId === item.id}
                        lockedBy={lock ? lockMessage(lock, selfActorId) : null}
                        canEdit={canEdit}
                        interactive={tool === 'select' && !draftInput.active}
                        blockedReason={blockedReason}
                        onBodyDown={(e) => {
                          if (tool !== 'select' || e.button !== 0 || noteEdit || draftInput.active) return
                          if (e.shiftKey && selection?.kind === 'item') {
                            e.stopPropagation()
                            if (item.id === selection.id) {
                              if (alsoPicked.length > 0) {
                                setSelection({ kind: 'item', id: alsoPicked[0]! })
                                setAlsoPicked(alsoPicked.slice(1))
                              }
                            } else {
                              setAlsoPicked((cur) => (cur.includes(item.id) ? cur.filter((id) => id !== item.id) : [...cur, item.id]))
                            }
                            return
                          }
                          if (selectedIds.length > 1 && selectedIds.includes(item.id) && !e.shiftKey) {
                            pressItem(e, item.id)
                            return
                          }
                          e.stopPropagation()
                          setAlsoPicked([])
                          const wasSelected = selection?.kind === 'item' && selection.id === item.id
                          setSelection({ kind: 'item', id: item.id })
                          const at = paperOf(e)
                          if (at && canEdit && !lock) startDrag(e, { kind: 'note-move', id: item.id, from: at, to: at, wasSelected })
                        }}
                        onEdit={() => editNote(item)}
                        onGrab={(edge, e) => grabNote(item, edge, e)}
                      />
                    )
                  }
                  if (item.shape === 'callout' && item.callout) {
                    const poly = calloutBoundaryPolygon(item)
                    if (!poly || poly.length < 3) return null
                    const paperPoly = poly.map(toPaperPoint)
                    const headPaper = item.points[2] ? toPaperPoint(item.points[2]) : paperPoly[0]!
                    const selected = selectedIds.includes(item.id)
                    const isPoly = Boolean(item.callout.boundary && item.callout.boundary.length >= 3)
                    const hitStrokeW = Math.max(2.6, 4.0 / Math.max(zoom, 0.25))
                    const headInfo = calloutHead(model, item.callout)
                    return (
                      <g
                        key={item.id}
                        data-testid="drawn-callout"
                        data-callout-id={item.id}
                        data-selected={selected || undefined}
                        transform={moveDelta && movingIds.has(item.id) ? `translate(${moveDelta.x} ${moveDelta.y})` : undefined}
                      >
                        <polygon
                          points={paperPoly.map((q) => `${q.x},${q.y}`).join(' ')}
                          fill="none"
                          stroke={selected ? PRIMARY : 'transparent'}
                          strokeWidth={selected ? Math.max(0.7, 0.9 / Math.max(zoom, 0.25)) : hitStrokeW}
                          strokeDasharray={selected ? '3 1.5' : undefined}
                          pointerEvents="none"
                        />
                        <polygon
                          points={paperPoly.map((q) => `${q.x},${q.y}`).join(' ')}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={hitStrokeW}
                          pointerEvents={tool === 'select' && !draftInput.active && !plineSketch && !boundary ? 'stroke' : 'none'}
                          className={tool === 'select' && !draftInput.active && !plineSketch && !boundary ? 'cursor-pointer' : 'pointer-events-none'}
                          onPointerDown={(e) => {
                            if (tool !== 'select' || draftInput.active || plineSketch || boundary || e.button !== 0) return
                            e.stopPropagation()
                            modelEdit?.select(null)
                            if (e.shiftKey && selection?.kind === 'item') {
                              if (item.id !== selection.id) setAlsoPicked((cur) => (cur.includes(item.id) ? cur.filter((id) => id !== item.id) : [...cur, item.id]))
                              return
                            }
                            pressItem(e, item.id)
                          }}
                          onDoubleClick={(e) => {
                            if (tool !== 'select' || !canEdit || boundary) return
                            e.stopPropagation()
                            startBoundary(item.id)
                          }}
                        >
                          <title>{`${headInfo.viewName || 'Callout'} (${isPoly ? 'P-Line' : 'Rectangle'}) — Click to drag extents on sheet; double-click border to edit P-line corners`}</title>
                        </polygon>
                        <circle
                          cx={headPaper.x}
                          cy={headPaper.y}
                          r={HEAD_RADIUS_MM + 1.2}
                          fill="transparent"
                          stroke={selected && !boundary ? PRIMARY : 'transparent'}
                          strokeWidth={0.5}
                          pointerEvents={tool === 'select' && !draftInput.active && !plineSketch && !boundary ? 'all' : 'none'}
                          className={tool === 'select' && !draftInput.active && !plineSketch && !boundary ? 'cursor-pointer' : 'pointer-events-none'}
                          onPointerDown={(e) => {
                            if (tool !== 'select' || draftInput.active || plineSketch || boundary || e.button !== 0) return
                            e.stopPropagation()
                            modelEdit?.select(null)
                            pressItem(e, item.id)
                          }}
                          onDoubleClick={(e) => {
                            if (tool !== 'select') return
                            e.stopPropagation()
                            onOpenView(item.callout!.viewId)
                          }}
                        >
                          <title>{`${headInfo.top}/${headInfo.bottom} ${headInfo.viewName} — Click to select; double-click bubble to open view`}</title>
                        </circle>
                      </g>
                    )
                  }
                  const box = item.dim || item.tag ? annotationBox(model, annotatedView, item, toPaperPoint) : detailBox(item, toPaperPoint)
                  if (!box) return null
                  const selected = selectedIds.includes(item.id)
                  const isMoving = Boolean(moveDelta && movingIds.has(item.id))
                  const liveTagLines = isMoving && item.tag ? (tagLines(model, item.tag) ?? []) : null
                  const zoomScale = 1 / Math.max(zoom, 0.35)
                  const selPad = Math.min(0.75, 0.55 * zoomScale)
                  const selStroke = Math.min(0.45, 0.35 * zoomScale)
                  const selDash = `${(1.4 * Math.min(1, zoomScale)).toFixed(2)} ${(1.0 * Math.min(1, zoomScale)).toFixed(2)}`
                  const hitPad = Math.max(1.2, 1.5 * zoomScale)
                  return (
                    <g key={item.id}>
                      {isMoving && (
                        <rect
                          x={box.x - 1}
                          y={box.y - 1}
                          width={box.w + 2}
                          height={box.h + 2}
                          fill="#ffffff"
                          fillOpacity={0.8}
                          pointerEvents="none"
                        />
                      )}
                      <g transform={isMoving && moveDelta ? `translate(${moveDelta.x} ${moveDelta.y})` : undefined}>
                        {liveTagLines && liveTagLines.length > 0 && (
                          <g pointerEvents="none">
                            <rect
                              x={box.x - 1.2}
                              y={box.y - 1.2}
                              width={box.w + 2.4}
                              height={box.h + 2.4}
                              rx={0.6}
                              fill="#ffffff"
                              fillOpacity={0.95}
                              stroke={PRIMARY}
                              strokeWidth={0.45}
                            />
                            {liveTagLines.map((ln, li) => (
                              <text
                                key={`lt-${li}`}
                                x={box.x + box.w / 2}
                                y={box.y + ((li + 0.72) * box.h) / liveTagLines.length}
                                fontSize={2.4}
                                textAnchor="middle"
                                fill={PRIMARY}
                                fontFamily="Helvetica, Arial, sans-serif"
                              >
                                {ln}
                              </text>
                            ))}
                          </g>
                        )}
                        {selected && (
                          <rect
                            x={box.x - selPad}
                            y={box.y - selPad}
                            width={box.w + selPad * 2}
                            height={box.h + selPad * 2}
                            fill={PRIMARY}
                            fillOpacity={0.05}
                            stroke={PRIMARY}
                            strokeOpacity={0.85}
                            strokeDasharray={selDash}
                            strokeWidth={selStroke}
                            pointerEvents="none"
                          />
                        )}
                        <rect
                          x={box.x - hitPad}
                          y={box.y - hitPad}
                          width={box.w + hitPad * 2}
                          height={box.h + hitPad * 2}
                          fill="transparent"
                          stroke="transparent"
                          className={tool === 'select' && !draftInput.active ? 'cursor-pointer' : 'pointer-events-none'}
                          data-testid={`drawn-${item.shape}`}
                          data-selected={selected || undefined}
                          onPointerDown={(e) => {
                            if (tool !== 'select' || draftInput.active || e.button !== 0) return
                            if (e.shiftKey && selection?.kind === 'item') {
                              e.stopPropagation()
                              // Shift+click adds to (or takes from) the pick for modify operations.
                              if (item.id !== selection.id) setAlsoPicked((cur) => (cur.includes(item.id) ? cur.filter((id) => id !== item.id) : [...cur, item.id]))
                              return
                            }
                            pressItem(e, item.id)
                          }}
                        >
                          <title>{item.shape === 'text' ? item.text : item.tag ? 'Tag' : item.dim ? 'Dimension' : item.shape}</title>
                        </rect>
                      </g>
                    </g>
                  )
                })}
              {tool === 'select' && !noteEdit && !placing && !tracing && (
                <SectionMarkerLinks
                  model={model}
                  views={
                    target.kind === 'sheet'
                      ? active
                        ? [{ view: active.view, frame: active.frame, viewport: active.viewport }]
                        : placed.map((entry) => ({ view: entry.view, frame: entry.frame, viewport: entry.viewport }))
                      : modelView
                        ? [{ view: modelView.view, frame: modelView.frame }]
                        : []
                  }
                  isSheet={target.kind === 'sheet' && !active}
                  canEdit={canEdit}
                  paperOf={paperOf}
                  submit={submit}
                  onOpenView={onOpenView}
                  onOpenSheet={onOpenSheet}
                />
              )}
              {tool === 'select' && target.kind === 'sheet' && !active && !noteEdit && !placing && !tracing && (
                <g data-testid="sheet-callout-shortcuts">
                  {placed.flatMap((entry) => {
                    if (entry.view.viewType !== 'floor_plan' && entry.view.viewType !== 'ceiling_plan') return []
                    const viewItems = documentIndex(model).itemsByOwner.get(entry.view.id) ?? []
                    return viewItems.flatMap((it) => {
                      if (it.deleted || it.shape !== 'callout' || !it.callout) return []
                      const poly = calloutBoundaryPolygon(it)
                      if (!poly || poly.length < 3) return []
                      const paperPoly = poly.map((q) => modelToPaper(entry.frame, q))
                      const hitStrokeW = Math.max(2.6, 4.0 / Math.max(zoom, 0.25))
                      const headInfo = calloutHead(model, it.callout)
                      return [
                        <polygon
                          key={`sheet-co-${entry.viewport.id}-${it.id}`}
                          points={paperPoly.map((q) => `${q.x},${q.y}`).join(' ')}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={hitStrokeW}
                          pointerEvents="stroke"
                          className="cursor-pointer hover:stroke-(--mutiny-selection)"
                          data-testid={`sheet-callout-shortcut-${it.id}`}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            activate(entry.viewport.id)
                            setSelection({ kind: 'item', id: it.id })
                          }}
                        >
                          <title>{`${headInfo.top}/${headInfo.bottom} ${headInfo.viewName} — Double-click to edit callout extents right on the sheet`}</title>
                        </polygon>,
                      ]
                    })
                  })}
                </g>
              )}
              {boundary && (
                <g data-testid="boundary-sketch">
                  {(() => {
                    const n = boundary.points.length
                    let edgeDx = 0
                    let edgeDy = 0
                    let edgeI0 = -1
                    let edgeI1 = -1
                    if (drag?.kind === 'boundary-edge' && n >= 3) {
                      edgeI0 = drag.index
                      edgeI1 = (edgeI0 + 1) % n
                      const ep0 = boundary.points[edgeI0]!
                      const ep1 = boundary.points[edgeI1]!
                      const ex = ep1.x - ep0.x
                      const ey = ep1.y - ep0.y
                      const elen = Math.hypot(ex, ey)
                      if (elen > 1e-3) {
                        const nx = -ey / elen
                        const ny = ex / elen
                        const proj = (drag.to.x - drag.from.x) * nx + (drag.to.y - drag.from.y) * ny
                        edgeDx = nx * proj
                        edgeDy = ny * proj
                      }
                    }
                    const pts = boundary.points.map((p, i) => {
                      if (drag?.kind === 'boundary-vertex' && drag.index === i) return drag.to
                      if (drag?.kind === 'boundary-edge' && (i === edgeI0 || i === edgeI1)) return { x: p.x + edgeDx, y: p.y + edgeDy }
                      return p
                    })
                    const z = Math.max(zoom, 0.25)
                    const r = 1.15 / z
                    return (
                      <>
                        {/* Soft white halo over the underlying original callout border so the editable P-line stands out cleanly */}
                        {boundary.kind === 'callout' && (
                          <polygon points={boundary.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#ffffff" strokeOpacity={0.82} strokeWidth={2.0 / z} pointerEvents="none" />
                        )}
                        <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={boundary.kind === 'callout' ? PRIMARY : 'none'} fillOpacity={boundary.kind === 'callout' ? 0.08 : 0} stroke={PRIMARY} strokeWidth={0.6 / z} strokeDasharray={`${2.2 / z} ${1.1 / z}`} pointerEvents="none" />
                        {/* Direct edge-slide bars: drag any whole edge in or out like a wall */}
                        {pts.map((p, i) => {
                          const q = pts[(i + 1) % pts.length] ?? p
                          const horiz = Math.abs(q.y - p.y) < Math.abs(q.x - p.x) * 0.25
                          const vert = Math.abs(q.x - p.x) < Math.abs(q.y - p.y) * 0.25
                          return (
                            <line
                              key={`e${i}`}
                              x1={p.x}
                              y1={p.y}
                              x2={q.x}
                              y2={q.y}
                              stroke="transparent"
                              strokeWidth={3.2 / z}
                              className={horiz ? 'cursor-ns-resize' : vert ? 'cursor-ew-resize' : 'cursor-move'}
                              data-testid={`boundary-edge-${i}`}
                              onPointerDown={(e) => {
                                if (e.button !== 0) return
                                e.stopPropagation()
                                const at = paperOf(e)
                                if (!at) return
                                startDrag(e, { kind: 'boundary-edge', index: i, from: at, to: at })
                              }}
                            >
                              <title>Drag this edge in or out (snaps to walls &amp; grids)</title>
                            </line>
                          )
                        })}
                        {pts.map((p, i) => {
                          const q = pts[(i + 1) % pts.length] ?? p
                          const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
                          return (
                            <g key={`m${i}`} className="cursor-copy" data-testid={`boundary-add-${i}`} onPointerDown={(e) => {
                              if (e.button !== 0) return
                              const next = [...boundary.points.slice(0, i + 1), mid, ...boundary.points.slice(i + 1)]
                              setBoundary({ ...boundary, points: next, picked: i + 1 })
                              startDrag(e, { kind: 'boundary-vertex', index: i + 1, to: mid })
                            }}>
                              <circle cx={mid.x} cy={mid.y} r={r} fill="var(--mutiny-panel)" stroke={PRIMARY} strokeWidth={0.3 / z} />
                              <path d={`M ${mid.x - r * 0.6} ${mid.y} H ${mid.x + r * 0.6} M ${mid.x} ${mid.y - r * 0.6} V ${mid.y + r * 0.6}`} stroke={PRIMARY} strokeWidth={0.3 / z} />
                              <title>Drag to add a corner here (sculpt an L-shape or notch)</title>
                            </g>
                          )
                        })}
                        {pts.map((p, i) => (
                          <rect
                            key={`v${i}`}
                            x={p.x - r}
                            y={p.y - r}
                            width={r * 2}
                            height={r * 2}
                            fill={boundary.picked === i ? PRIMARY : 'var(--mutiny-panel)'}
                            stroke={PRIMARY}
                            strokeWidth={0.4 / z}
                            className="cursor-grab"
                            data-testid={`boundary-vertex-${i}`}
                            onPointerDown={(e) => {
                              if (e.button !== 0) return
                              setBoundary({ ...boundary, picked: i })
                              startDrag(e, { kind: 'boundary-vertex', index: i, to: p })
                            }}
                          >
                            <title>Drag this corner (snaps to walls &amp; grids); click it and press Delete to remove it</title>
                          </rect>
                        ))}
                      </>
                    )
                  })()}
                </g>
              )}
              {selectedItem && selectedIds.length === 1 && tool === 'select' && !draftInput.active && !noteEdit && !moveDelta && drag?.kind !== 'note-move' && drag?.kind !== 'note-size' && !boundary && !plineSketch && (
                <g data-testid="annotation-grips">
                  {drag?.kind === 'grip' &&
                    selectedItem.shape === 'callout' &&
                    drag.id === selectedItem.id &&
                    (() => {
                      const preview = calloutBoundaryAfterGrip(selectedItem, drag.grip, toStored(drag.to))
                      if (!preview || !selectedItem.callout) return null
                      const pts = preview.boundary.map(toPaperPoint)
                      const headPaper = toPaperPoint(preview.head)
                      const anchorPt = calloutLeaderAnchor(pts, headPaper)
                      const live = calloutHead(model, selectedItem.callout)
                      const z = Math.max(zoom, 0.25)
                      const d = anchorPt ? Math.hypot(anchorPt.x - headPaper.x, anchorPt.y - headPaper.y) : 0
                      const edgePt =
                        anchorPt && d > HEAD_RADIUS_MM
                          ? { x: headPaper.x + ((anchorPt.x - headPaper.x) * HEAD_RADIUS_MM) / d, y: headPaper.y + ((anchorPt.y - headPaper.y) * HEAD_RADIUS_MM) / d }
                          : null
                      return (
                        <g pointerEvents="none" data-testid="callout-grip-preview">
                          <polygon points={pts.map((q) => `${q.x},${q.y}`).join(' ')} fill={PRIMARY} fillOpacity={0.08} stroke={PRIMARY} strokeWidth={0.55 / z} strokeDasharray={`${3 / z} ${1.5 / z}`} />
                          {anchorPt && edgePt && <line x1={anchorPt.x} y1={anchorPt.y} x2={edgePt.x} y2={edgePt.y} stroke={PRIMARY} strokeWidth={0.45 / z} />}
                          <circle cx={headPaper.x} cy={headPaper.y} r={HEAD_RADIUS_MM} fill="#ffffff" fillOpacity={0.94} stroke={PRIMARY} strokeWidth={0.55 / z} />
                          <line x1={headPaper.x - HEAD_RADIUS_MM} y1={headPaper.y} x2={headPaper.x + HEAD_RADIUS_MM} y2={headPaper.y} stroke={PRIMARY} strokeWidth={0.35 / z} />
                          <text x={headPaper.x} y={headPaper.y - 1.2} fontSize={2.4} fontWeight="bold" textAnchor="middle" fill={PRIMARY} fontFamily="Helvetica, Arial, sans-serif">
                            {live.top}
                          </text>
                          <text x={headPaper.x} y={headPaper.y + 3.0} fontSize={2.2} textAnchor="middle" fill={PRIMARY} fontFamily="Helvetica, Arial, sans-serif">
                            {live.bottom}
                          </text>
                        </g>
                      )
                    })()}
                  {annotationGrips(model, annotatedView, selectedItem, toPaperPoint).map((g) => {
                    const at = drag?.kind === 'grip' && drag.grip.key === g.key ? drag.to : g.at
                    const z = Math.max(zoom, 0.25)
                    const r = 1.2 / z
                    const sw = 0.42 / z
                    const onGripDown = (e: React.PointerEvent<SVGElement>) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      if (!canEdit) {
                        toast.error(blockedReason)
                        return
                      }
                      startDrag(e, { kind: 'grip', id: selectedItem.id, grip: g, to: g.at })
                    }
                    if (g.kind === 'callout-edge' || g.kind === 'callout-poly-edge') {
                      const w = g.axis === 'y' ? r * 3.0 : r * 1.4
                      const h = g.axis === 'y' ? r * 1.4 : r * 3.0
                      return (
                        <rect
                          key={g.key}
                          x={at.x - w / 2}
                          y={at.y - h / 2}
                          width={w}
                          height={h}
                          rx={0.4 / z}
                          fill={PRIMARY}
                          stroke="var(--card, #fff)"
                          strokeWidth={sw}
                          className={canEdit ? (g.axis === 'y' ? 'cursor-ns-resize' : g.axis === 'x' ? 'cursor-ew-resize' : 'cursor-move') : 'cursor-not-allowed'}
                          data-testid={`grip-${g.key}`}
                          onPointerDown={onGripDown}
                        >
                          <title>{canEdit ? g.label : blockedReason}</title>
                        </rect>
                      )
                    }
                    if (g.kind === 'callout-head') {
                      return (
                        <circle
                          key={g.key}
                          cx={at.x}
                          cy={at.y}
                          r={r * 1.15}
                          fill={PRIMARY}
                          stroke="var(--card, #fff)"
                          strokeWidth={sw}
                          className={canEdit ? 'cursor-grab' : 'cursor-not-allowed'}
                          data-testid={`grip-${g.key}`}
                          onPointerDown={onGripDown}
                        >
                          <title>{canEdit ? g.label : blockedReason}</title>
                        </circle>
                      )
                    }
                    return (
                      <rect
                        key={g.key}
                        x={at.x - r}
                        y={at.y - r}
                        width={r * 2}
                        height={r * 2}
                        fill={g.follows ? PRIMARY : 'var(--mutiny-panel)'}
                        stroke={PRIMARY}
                        strokeWidth={sw}
                        className={canEdit ? (g.kind === 'callout-corner' || g.kind === 'callout-vertex' ? 'cursor-move' : 'cursor-grab') : 'cursor-not-allowed'}
                        data-testid={`grip-${g.key}`}
                        onPointerDown={onGripDown}
                      >
                        <title>{canEdit ? g.label : blockedReason}</title>
                      </rect>
                    )
                  })}
                </g>
              )}
              {plineSketch && (
                <g pointerEvents="none" data-testid="callout-pline-sketch">
                  {plineSketch.points.length >= 2 && (
                    <polygon
                      points={[...plineSketch.points, ...(plineSketch.hover ? [plineSketch.hover] : [])].map((q) => `${q.x},${q.y}`).join(' ')}
                      fill={PRIMARY}
                      fillOpacity={0.08}
                      stroke={PRIMARY}
                      strokeWidth={0.55 / Math.max(zoom, 0.25)}
                      strokeDasharray="3 1.5"
                    />
                  )}
                  {plineSketch.points.length >= 1 && plineSketch.hover && (
                    <line
                      x1={plineSketch.points[plineSketch.points.length - 1]!.x}
                      y1={plineSketch.points[plineSketch.points.length - 1]!.y}
                      x2={plineSketch.hover.x}
                      y2={plineSketch.hover.y}
                      stroke={PRIMARY}
                      strokeWidth={0.6 / Math.max(zoom, 0.25)}
                    />
                  )}
                  {plineSketch.points.map((pt, i) => {
                    const z = Math.max(zoom, 0.25)
                    const closing = i === 0 && plineSketch.points.length >= 3 && plineSketch.hover && Math.hypot(plineSketch.hover.x - pt.x, plineSketch.hover.y - pt.y) <= 4 / z
                    return closing ? (
                      <circle key={i} cx={pt.x} cy={pt.y} r={2.2 / z} fill="var(--card, #fff)" stroke="#16a34a" strokeWidth={0.6 / z} />
                    ) : (
                      <rect key={i} x={pt.x - 1.1 / z} y={pt.y - 1.1 / z} width={2.2 / z} height={2.2 / z} fill={i === 0 ? PRIMARY : 'var(--card, #fff)'} stroke={PRIMARY} strokeWidth={0.4 / z} />
                    )
                  })}
                </g>
              )}
              {activeSnap && (
                <g pointerEvents="none" data-testid="graphics-snap-indicator">
                  {activeSnap.guideLine && (
                    <line
                      x1={activeSnap.guideLine[0].x}
                      y1={activeSnap.guideLine[0].y}
                      x2={activeSnap.guideLine[1].x}
                      y2={activeSnap.guideLine[1].y}
                      stroke={PRIMARY}
                      strokeOpacity={0.75}
                      strokeWidth={0.35 / Math.max(zoom, 0.25)}
                      strokeDasharray="2 1.5"
                    />
                  )}
                  {activeSnap.kind === 'intersection' ? (
                    <polygon
                      points={(() => {
                        const r = 1.8 / Math.max(zoom, 0.25)
                        const { x, y } = activeSnap.at
                        return `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`
                      })()}
                      fill="none"
                      stroke="#0ea5e9"
                      strokeWidth={0.5 / Math.max(zoom, 0.25)}
                    />
                  ) : activeSnap.kind === 'corner' ? (
                    <rect
                      x={activeSnap.at.x - 1.5 / Math.max(zoom, 0.25)}
                      y={activeSnap.at.y - 1.5 / Math.max(zoom, 0.25)}
                      width={3.0 / Math.max(zoom, 0.25)}
                      height={3.0 / Math.max(zoom, 0.25)}
                      fill="none"
                      stroke="#0ea5e9"
                      strokeWidth={0.5 / Math.max(zoom, 0.25)}
                    />
                  ) : (
                    <circle cx={activeSnap.at.x} cy={activeSnap.at.y} r={1.6 / Math.max(zoom, 0.25)} fill="none" stroke="#0ea5e9" strokeWidth={0.45 / Math.max(zoom, 0.25)} />
                  )}
                  <text
                    x={activeSnap.at.x + 2.4 / Math.max(zoom, 0.25)}
                    y={activeSnap.at.y - 2.0 / Math.max(zoom, 0.25)}
                    fontSize={2.4 / Math.max(zoom, 0.25)}
                    fontFamily="sans-serif"
                    fill="#0369a1"
                    stroke="white"
                    strokeWidth={0.7 / Math.max(zoom, 0.25)}
                    paintOrder="stroke"
                  >
                    {activeSnap.label}
                  </text>
                </g>
              )}
              {tool === 'select' && tagElbows.grip}
              {target.kind === 'sheet' && !active && tool === 'select' && visibleSheetMarkups.map((m) => {
                if (m.points.length === 0) return null
                const selected = selection?.kind === 'item' && selection.id === m.id
                const hitWidth = Math.max(6 / Math.max(zoom, 0.25), (m.markup?.widthMm ?? 2.4) + 3)
                const pts = m.points.map((p) => `${p.x} ${p.y}`).join(' ')
                return (
                  <g
                    key={`mk-hit-${m.id}`}
                    className="cursor-pointer"
                    data-testid={`sheet-markup-hit-${m.id}`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      setSelection({ kind: 'item', id: m.id })
                      setAlsoPicked([])
                    }}
                  >
                    {selected && m.points.length === 1 && (
                      <circle cx={m.points[0]!.x} cy={m.points[0]!.y} r={(m.markup?.widthMm ?? 2.4) * 0.75 + 2} fill="none" stroke={PRIMARY} strokeWidth={0.6 / Math.max(zoom, 0.25)} pointerEvents="none" />
                    )}
                    {selected && m.points.length >= 2 && (
                      <polyline points={pts} fill="none" stroke={PRIMARY} strokeWidth={(m.markup?.widthMm ?? 2.4) + 2.2 / Math.max(zoom, 0.25)} strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                    )}
                    {m.points.length === 1 ? (
                      <circle cx={m.points[0]!.x} cy={m.points[0]!.y} r={hitWidth / 2} fill="transparent" />
                    ) : (
                      <polyline points={pts} fill="none" stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </g>
                )
              })}
              {drag?.kind === 'markup' && drag.points.length > 0 && (
                <g pointerEvents="none" data-testid="sheet-markup-preview">
                  {drag.points.length === 1 ? (
                    <circle
                      cx={drag.points[0]!.x}
                      cy={drag.points[0]!.y}
                      r={markupBrush.widthMm / 2}
                      fill={markupBrush.color}
                      fillOpacity={markupBrush.tool === 'highlighter' ? DEFAULT_HIGHLIGHTER_OPACITY : DEFAULT_MARKER_OPACITY}
                    />
                  ) : (
                    <polyline
                      points={drag.points.map((p) => `${p.x} ${p.y}`).join(' ')}
                      fill="none"
                      stroke={markupBrush.color}
                      strokeWidth={markupBrush.widthMm}
                      strokeOpacity={markupBrush.tool === 'highlighter' ? DEFAULT_HIGHLIGHTER_OPACITY : DEFAULT_MARKER_OPACITY}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </g>
              )}
              {drag?.kind === 'draw' && <DrawPreview drag={drag} />}
              {moveGhost && (
                <g data-testid="drag-move-preview">
                  <DraftOverlay prims={moveGhost} rubber={[]} marker={null} zoom={zoom} />
                </g>
              )}
              {draftInput.active && (
                <DraftOverlay
                  tool={draftInput.preview.tool}
                  prims={draftInput.preview.prims}
                  rubber={draftInput.preview.rubber}
                  marker={draftInput.preview.marker}
                  typedLength={draftInput.preview.typedLength}
                  storedPerPaperMm={draftInput.preview.storedPerPaperMm}
                  zoom={zoom}
                />
              )}
              {drag?.kind === 'marquee' && <DraftOverlay prims={[]} rubber={[]} marker={null} marquee={{ a: drag.a, b: drag.b }} zoom={zoom} />}
              {hoverSnap && (
                <g pointerEvents="none" data-testid="dimension-snap">
                  <circle cx={hoverSnap.at.x} cy={hoverSnap.at.y} r={1.4 / Math.max(zoom, 0.25)} fill="none" stroke={PRIMARY} strokeWidth={0.4 / Math.max(zoom, 0.25)} />
                  <title>{`Snaps to the ${hoverSnap.label}`}</title>
                </g>
              )}
              {drag?.kind === 'note-new' && Math.abs(drag.b.x - drag.a.x) >= 5 && (
                <rect x={Math.min(drag.a.x, drag.b.x)} y={Math.min(drag.a.y, drag.b.y)} width={Math.abs(drag.b.x - drag.a.x)} height={Math.max(4, Math.abs(drag.b.y - drag.a.y))} fill="none" stroke={PRIMARY} strokeWidth={0.4} strokeDasharray="2 1" pointerEvents="none" data-testid="note-new-preview" />
              )}
              {liveDimPrims.length > 0 && (
                <g pointerEvents="none" data-testid="dim-live-preview">
                  {liveDimPrims.map((p, idx) =>
                    p.kind === 'line' ? (
                      <line key={`dl-${idx}`} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={PRIMARY} strokeWidth={0.22} strokeLinecap="round" />
                    ) : p.kind === 'fill' ? (
                      <polygon key={`df-${idx}`} points={p.points.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')} fill={PRIMARY} stroke="none" />
                    ) : p.kind === 'text' ? (
                      <text key={`dt-${idx}`} x={p.at.x} y={p.at.y} fontSize={p.size / 0.72} textAnchor={p.anchor} fill={PRIMARY} fontFamily="Helvetica, Arial, sans-serif">
                        {p.text}
                      </text>
                    ) : null,
                  )}
                </g>
              )}
              {liveNoteLeaderPrims.length > 0 && (
                <g pointerEvents="none" data-testid="note-live-leaders">
                  {liveNoteLeaderPrims.map((p, idx) =>
                    p.kind === 'line' ? (
                      <line key={`nl-${idx}`} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke="#000" strokeWidth={0.18} strokeLinecap="round" />
                    ) : p.kind === 'fill' ? (
                      <polygon key={`nf-${idx}`} points={p.points.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')} fill="#000" stroke="none" />
                    ) : null,
                  )}
                </g>
              )}
              {liveBlock && <g pointerEvents="none" data-testid="note-live-text" dangerouslySetInnerHTML={{ __html: textBlockToSvg(liveBlock) }} />}
              {noteEdit && noteEdit.itemId === null && liveBlock && (
                <polygon points={[0, 1, 2, 3].map((i) => { const c = [liveBlock.origin, { x: liveBlock.origin.x + liveBlock.layout.width, y: liveBlock.origin.y }, { x: liveBlock.origin.x + liveBlock.layout.width, y: liveBlock.origin.y + Math.max(liveBlock.layout.height, 4) }, { x: liveBlock.origin.x, y: liveBlock.origin.y + Math.max(liveBlock.layout.height, 4) }][i]; return c ? `${c.x},${c.y}` : '' }).join(' ')} fill="none" stroke={PRIMARY} strokeWidth={0.4} pointerEvents="none" />
              )}
            </svg>
            {noteEdit && liveBlock && (
              <NoteEditor
                key={noteEdit.itemId ?? 'new-note'}
                origin={noteEdit.origin}
                rotation={noteEdit.rotation}
                width={noteEdit.width}
                height={noteEdit.height}
                paper={paper}
                pxPerMm={pxPerMm}
                size={noteEdit.size}
                lineSpacing={noteEdit.lineSpacing}
                initial={noteEdit.initial}
                overflow={liveBlock.layout.overflow}
                onDraft={(draft) => setNoteEdit((cur) => (cur ? { ...cur, draft } : cur))}
                onCommit={commitNote}
                onDiscard={discardNote}
              />
            )}
          </div>
        </div>
        </div>
        {tool === 'keynote' ? <KeynotePicker value={keynoteKey} onChange={setKeynoteKey} /> : null}
        {toolHint && <ToolHintBar text={toolHint} testId="drawing-tool-hint" />}
        {calloutDraft && (
          <CalloutViewDialog
            model={model}
            ownerId={ownerId}
            open
            onCancel={() => setCalloutDraft(null)}
            onCreateEnlarged={(input) => {
              const viewId = newId('view')
              const calloutId = newId('callout')
              const steps = enlargedPlanCommands(model, {
                parentViewId: ownerId,
                viewId,
                calloutId,
                name: input.name,
                box: { min: calloutDraft.a, max: calloutDraft.b },
                ...(calloutDraft.polygon ? { polygon: calloutDraft.polygon } : {}),
                scale: input.scale,
                head: calloutDraft.head,
                ...(input.label ? { label: input.label } : {}),
              })
              if (typeof steps === 'string') {
                toast.error(steps)
                return
              }
              if (send({ type: 'batch_documents', label: `Create enlarged plan ${input.name}`, commands: steps }, `create enlarged plan ${input.name}`)) setSelection({ kind: 'item', id: calloutId })
              setCalloutDraft(null)
            }}
            onPlace={(callout) => {
              const id = newId('callout')
              const spec = calloutDraft.polygon ? { ...callout, boundary: calloutDraft.polygon } : callout
              if (send({ type: 'add_drawing_item', itemId: id, ownerId, shape: 'callout', points: [calloutDraft.a, calloutDraft.b, calloutDraft.head], callout: spec }, 'add a callout')) setSelection({ kind: 'item', id })
              setCalloutDraft(null)
            }}
          />
        )}
      </div>

      <ResizableSideRail
        side="right"
        surface={PROPERTIES_SURFACE}
        testId="drawing-properties-rail"
        title="Properties"
        defaultWidthPx={PROPERTIES_DEFAULT_WIDTH_PX}
        shortcut={propertiesShortcut}
        className="border-l bg-background"
        bodyClassName="gap-3 p-3"
      >
        {selectedViewport ? (
          <>
          <ViewportProperties
            name={selectedViewport.view.name}
            scale={selectedViewport.viewport.scale}
            size={selectedViewport.frame.size}
            isometric={selectedViewport.view.viewType === 'three_d'}
            canEdit={canEdit}
            blockedReason={blockedReason}
            editing={active?.viewport.id === selectedViewport.viewport.id}
            onEditHere={() => activate(selectedViewport.viewport.id)}
            onOpen={() => onOpenView(selectedViewport.view.id)}
            onScale={(scale) => send({ type: 'set_viewport_scale', viewportId: selectedViewport.viewport.id, scale }, 'change the viewport scale')}
            onRemove={() => {
              if (send({ type: 'remove_viewport', viewportId: selectedViewport.viewport.id }, 'take the view off the sheet')) setSelection(null)
            }}
          />
          {viewportProperties?.(selectedViewport.view.id)}
          </>
        ) : selectedMarkup && alsoPicked.length === 0 ? (
          <MarkupProperties
            item={selectedMarkup}
            canEdit={canEdit}
            blockedReason={blockedReason}
            onUpdate={(patch) =>
              send({ type: 'update_sheet_markup', itemId: selectedMarkup.id, ...patch }, 'update sheet markup')
            }
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedMarkup.id }, 'delete sheet markup')) setSelection(null)
            }}
          />
        ) : selectedItem?.callout && alsoPicked.length === 0 ? (
          <CalloutProperties
            item={selectedItem}
            model={model}
            canEdit={canEdit}
            blockedReason={blockedReason}
            onChange={(callout) => send({ type: 'update_drawing_item', itemId: selectedItem.id, callout }, 'change what the callout refers to')}
            onOpenView={onOpenView}
            onEditBoundary={() => startBoundary(selectedItem.id)}
            onSketchBoundary={() => startCalloutPlineSketch(selectedItem.id)}
            onResetRectangle={() => resetCalloutRectangle(selectedItem.id)}
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedItem.id }, 'delete')) setSelection(null)
            }}
          />
        ) : selectedItem && alsoPicked.length === 0 && selectedItem.shape === 'field_block' && selectedItem.block ? (
          <FieldBlockPanel
            key={`${selectedItem.id}:${selectedItem.block.template}`}
            item={selectedItem}
            block={selectedItem.block}
            model={model}
            canEdit={canEdit}
            blockedReason={blockedReason}
            send={send}
            freshness={blockFreshness?.(selectedItem.id)}
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedItem.id }, 'remove from the sheet')) setSelection(null)
            }}
          />
        ) : selectedItem && alsoPicked.length === 0 && selectedItem.shape === 'figure' ? (
          <FigureProperties
            item={selectedItem}
            canEdit={canEdit}
            blockedReason={blockedReason}
            images={sheetImages}
            send={send}
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedItem.id }, 'remove from the sheet')) setSelection(null)
            }}
          />
        ) : selectedItem && (alsoPicked.length > 0 || (selectedItem.shape !== 'text' && !selectedItem.dim && !selectedItem.tag)) ? (
          <DetailSelectionProperties
            items={items.filter((i) => selectedIds.includes(i.id))}
            model={model}
            ownerId={ownerId}
            canEdit={canEdit}
            blockedReason={blockedReason}
            send={send}
            editingBoundary={boundary !== null}
            onEditBoundary={startBoundary}
            onCleared={() => {
              setSelection(null)
              setAlsoPicked([])
            }}
          />
        ) : selectedItem && (selectedItem.dim || selectedItem.tag) ? (
          <AnnotationProperties
            item={selectedItem}
            model={model}
            view={annotatedView}
            canEdit={canEdit}
            blockedReason={blockedReason}
            onDim={(dim) => send({ type: 'update_drawing_item', itemId: selectedItem.id, dim }, 'change the dimension')}
            onTag={(tag) => send({ type: 'update_drawing_item', itemId: selectedItem.id, tag }, 'change the tag')}
            onMoveTag={(at) => send({ type: 'update_drawing_item', itemId: selectedItem.id, points: [at] }, 'move the tag clear of the others')}
            onTagsBatch={(updates, label) => send({ type: 'batch_documents', label, commands: updates.map((u) => ({ type: 'update_drawing_item' as const, itemId: u.itemId, tag: u.tag })) }, label)}
            onOpenTagStyles={onOpenTagStyles ? (styleId) => onOpenTagStyles(styleId, selectedItem.tag?.elementId ?? null) : undefined}
            onCreateSimilar={selectedItem.tag ? () => selectedItem.tag && startTagLike(selectedItem.tag) : undefined}
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedItem.id }, 'delete')) setSelection(null)
            }}
          />
        ) : selectedItem ? (
          <ItemProperties
            item={selectedItem}
            canEdit={canEdit}
            blockedReason={blockedReason}
            lockedBy={selectedLock ? lockMessage(selectedLock, selfActorId) : null}
            editing={noteEdit?.itemId === selectedItem.id}
            fonts={noteFonts}
            onEditText={() => editNote(selectedItem)}
            onAutoHeight={() => {
              const resolved = resolveNote(selectedItem)
              if (resolved) send({ type: 'resize_text_note', itemId: selectedItem.id, width: resolved.note.box.width, height: null }, 'fit the note to its text')
            }}
            onRotate={(rotation) => send({ type: 'move_text_note', itemId: selectedItem.id, rotation }, 'turn the note')}
            onMask={(mask) => send({ type: 'move_text_note', itemId: selectedItem.id, mask }, mask ? 'turn on note mask' : 'turn off note mask')}
            onAddLeader={(elbow) => {
              setTool('select')
              draft.setPending({ kind: 'leader', noteId: selectedItem.id, elbow })
            }}
            onLeaders={(leaders) => send({ type: 'move_text_note', itemId: selectedItem.id, leaders }, leaders.length === 0 ? 'remove the leaders' : 'change the leaders')}
            onDelete={() => {
              if (send({ type: 'delete_drawing_item', itemId: selectedItem.id }, 'delete')) setSelection(null)
            }}
          />
        ) : active ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Editing on the sheet</span>
            <span className="text-sm font-medium">{active.view.name}</span>
            <span className="text-xs text-muted-foreground">
              {activeDrafting ? 'Lines, text and dimensions you draw here belong to the view and move with it.' : 'Select, move, box select, Split, Route and, in a plan, an add-on’s drawing tools here. The other model tools open the view by itself, with a button back to this sheet.'}
            </span>
            <Button variant="outline" size="sm" onClick={() => onOpenView(active.view.id)}>
              Open the view by itself
            </Button>
          </div>
        ) : target.kind === 'sheet' && sheet?.kind === 'sheet' ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Sheet</span>
            <span className="text-sm font-medium">
              {sheet.number} · {sheet.title}
            </span>
            <span className="text-xs text-muted-foreground">
              {placed.length === 0 ? 'No views placed yet. Drag a view from the panel onto the sheet.' : `${placed.length} view${placed.length === 1 ? '' : 's'} placed. Select one to change its scale; double-click to edit it.`}
            </span>
            {onEditSheet && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="sm" className="w-full" disabled={!canEdit} onClick={onEditSheet}>
                      Edit title block
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canEdit && <TooltipContent>{blockedReason}</TooltipContent>}
              </Tooltip>
            )}
          </div>
        ) : null}
        {viewProperties && (
          <>
            {(selectedItem || selectedViewport || active) && <Separator />}
            {viewProperties}
          </>
        )}
      </ResizableSideRail>
    </div>
  )
}

/** One viewport on the sheet: its hit area, crop boundary (never printed), and grips when selected or open. */
function ViewportFrame({
  entry,
  drag,
  tool,
  selected,
  isActive,
  dimmed,
  canEdit,
  blockedReason,
  onSelect,
  onActivate,
  onGrab,
}: {
  entry: PlacedFrame
  drag: Drag | null
  tool: Tool
  selected: boolean
  isActive: boolean
  dimmed: boolean
  canEdit: boolean
  blockedReason: string
  onSelect: (e: React.PointerEvent<SVGRectElement>) => void
  onActivate: () => void
  onGrab: (handle: CropHandle, e: React.PointerEvent<SVGRectElement>) => void
}) {
  const { viewport, view } = entry
  const moving = drag?.kind === 'move' && (drag.id === viewport.id || drag.extras?.some((ex) => ex.id === viewport.id)) ? drag : null
  const framing = drag?.kind === 'frame' && drag.id === viewport.id ? drag : null
  const base = framing ? framing.rect : entry.rect
  const dx = moving ? moving.to.x - moving.from.x : 0
  const dy = moving ? moving.to.y - moving.from.y : 0
  const rect: Rect = { min: { x: base.min.x + dx, y: base.min.y + dy }, max: { x: base.max.x + dx, y: base.max.y + dy } }
  const w = rect.max.x - rect.min.x
  const h = rect.max.y - rect.min.y
  const cropShown = view.props?.cropView !== false && view.props?.showCropBox !== false
  const cropPolyPaper =
    cropShown && view.props?.cropPolygon && view.props.cropPolygon.length >= 3 && !framing
      ? view.props.cropPolygon.map((pt) => {
          const p = modelToPaper(entry.frame, pt)
          return { x: p.x + dx, y: p.y + dy }
        })
      : null
  return (
    <g data-testid={`viewport-${view.name}`} data-frame={`${rect.min.x.toFixed(1)},${rect.min.y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`}>
      {cropShown && !dimmed && (cropPolyPaper ? (
        <polygon points={cropPolyPaper.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={PRIMARY} strokeOpacity={0.55} strokeWidth={0.4} strokeDasharray="2 1" pointerEvents="none" data-testid={`crop-boundary-${view.name}`} />
      ) : (
        <rect x={rect.min.x} y={rect.min.y} width={w} height={h} fill="none" stroke={PRIMARY} strokeOpacity={0.45} strokeWidth={0.3} strokeDasharray="2 1" pointerEvents="none" data-testid={`crop-boundary-${view.name}`} />
      ))}
      {!dimmed && <AnnotationCropRegion rect={rect} props={view.props} testId={`annotation-crop-${view.name}`} />}
      {!isActive && (
        <rect
          x={rect.min.x}
          y={rect.min.y}
          width={w}
          height={h}
          fill="transparent"
          stroke={selected || moving || framing ? PRIMARY : 'transparent'}
          strokeDasharray="3 2"
          strokeWidth={0.6}
          className={tool === 'select' && !dimmed ? 'cursor-move hover:stroke-(--mutiny-selection)' : 'pointer-events-none'}
          onPointerDown={onSelect}
          onDoubleClick={onActivate}
          data-viewport-id={viewport.id}
          data-testid={`viewport-hit-${view.name}`}
        >
          <title>{doubleClickOpensView(view) ? `${view.name}. Double-click to open it; click it to drag its column edges.` : `${view.name}. Double-click to edit it on the sheet.`}</title>
        </rect>
      )}
      {isActive && <rect x={rect.min.x} y={rect.min.y} width={w} height={h} fill="none" stroke={PRIMARY} strokeWidth={0.6} pointerEvents="none" />}
      {(selected || isActive) && !dimmed && <CropBoxGrips rect={rect} dragging={Boolean(framing)} canEdit={canEdit} blockedReason={blockedReason} testId={`viewport-grips-${view.name}`} onGrab={onGrab} />}
    </g>
  )
}

/**
 * How far a printed view's notes, tags and dimensions may reach on paper: its
 * crop frame grown by the annotation crop offset (paper mm, the same reach the
 * drawing clips notes to). Null when the view's annotation crop is off or the
 * view isn't cropped.
 */
export function annotationCropOnPaper(frame: Rect, props: Pick<ViewProps, 'cropView' | 'annotationCrop' | 'annotationCropOffsetMm'> | undefined): Rect | null {
  if (props?.annotationCrop !== true || props.cropView === false) return null
  const reach = props.annotationCropOffsetMm ?? DEFAULT_ANNOTATION_CROP_OFFSET_MM
  return { min: { x: frame.min.x - reach, y: frame.min.y - reach }, max: { x: frame.max.x + reach, y: frame.max.y + reach } }
}

/** The annotation crop region of a printed view, shown whether or not its crop box is (never printed). */
function AnnotationCropRegion({ rect, props, testId }: { rect: Rect; props: ViewProps | undefined; testId: string }) {
  const region = annotationCropOnPaper(rect, props)
  if (!region) return null
  const w = region.max.x - region.min.x
  const h = region.max.y - region.min.y
  return (
    <g data-testid={testId} data-region={`${region.min.x.toFixed(1)},${region.min.y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`} pointerEvents="none">
      <rect x={region.min.x} y={region.min.y} width={w} height={h} fill="none" stroke={PRIMARY} strokeOpacity={0.7} strokeWidth={0.25} strokeDasharray="0.8 1.2" />
      <text x={region.max.x} y={region.min.y - 1} fontSize={2.2} textAnchor="end" fill={PRIMARY}>
        Annotation crop: notes, tags and dimensions may reach this far
      </text>
    </g>
  )
}

/** Eight grips on a paper rectangle: four edges and four corners. */
function CropBoxGrips({
  rect,
  dragging,
  canEdit,
  blockedReason,
  testId,
  onGrab,
}: {
  rect: Rect
  dragging: boolean
  canEdit: boolean
  blockedReason: string
  testId: string
  onGrab: (handle: CropHandle, e: React.PointerEvent<SVGRectElement>) => void
}) {
  const w = rect.max.x - rect.min.x
  const h = rect.max.y - rect.min.y
  return (
    <g data-testid={testId}>
      <rect x={rect.min.x} y={rect.min.y} width={w} height={h} fill="none" stroke={PRIMARY} strokeWidth={0.5} strokeDasharray={dragging ? undefined : '3 1.5'} pointerEvents="none" />
      {dragging && (
        <text x={rect.min.x} y={rect.min.y - 1.5} fontSize={2.6} fill={PRIMARY} pointerEvents="none">
          {`${w.toFixed(0)} × ${h.toFixed(0)} mm on paper. Release to save, Esc to cancel.`}
        </text>
      )}
      {CROP_HANDLES.map((handle) => {
        const at = handlePoint(rect, handle, false)
        return (
          <rect
            key={handle}
            x={at.x - 1.6}
            y={at.y - 1.6}
            width={3.2}
            height={3.2}
            fill="var(--mutiny-panel)"
            stroke={PRIMARY}
            strokeWidth={0.5}
            className={canEdit ? HANDLE_CURSOR[handle] : 'cursor-not-allowed'}
            onPointerDown={(e) => onGrab(handle, e)}
            data-testid={`${testId}-${handle}`}
          >
            <title>{canEdit ? `Drag the crop box's ${HANDLE_LABEL[handle]}` : blockedReason}</title>
          </rect>
        )
      })}
    </g>
  )
}

function insideRect(r: Rect, p: Vec2): boolean {
  return p.x >= r.min.x && p.x <= r.max.x && p.y >= r.min.y && p.y <= r.max.y
}

function rectMoved(a: Rect, b: Rect): number {
  return Math.abs(a.min.x - b.min.x) + Math.abs(a.min.y - b.min.y) + Math.abs(a.max.x - b.max.x) + Math.abs(a.max.y - b.max.y)
}

/** Dimensions in a detail view snap to horizontal or vertical. */
function straighten(a: Vec2, b: Vec2): Vec2 {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y }
}

/** Selection box for detailing items (arcs, splines, components, batts) and plain linework. */
function detailBox(item: DrawingItem, toPaper: (p: Vec2) => Vec2): { x: number; y: number; w: number; h: number } | null {
  const b = item.shape === 'text' ? null : detailItemBounds(item, toPaper)
  if (!b) return itemBox(item, toPaper)
  return { x: b.min.x, y: b.min.y, w: Math.max(1, b.max.x - b.min.x), h: Math.max(1, b.max.y - b.min.y) }
}

function itemBox(item: DrawingItem, toPaper: (p: Vec2) => Vec2): { x: number; y: number; w: number; h: number } | null {
  const pts = item.points.map(toPaper)
  const [a, b, head] = pts
  if (!a) return null
  // A callout picks by its head, so the box it draws round part of the plan doesn't cover the devices inside it.
  if (item.shape === 'callout' && head) return { x: head.x - 5, y: head.y - 5, w: 10, h: 10 }
  if (item.shape === 'text') {
    const size = item.textSize ?? 2.5
    return { x: a.x, y: a.y - size * 1.2, w: Math.max(6, (item.text?.length ?? 1) * size * 0.62), h: size * 1.6 }
  }
  if (!b) return null
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

function DrawPreview({ drag }: { drag: Extract<Drag, { kind: 'draw' }> }) {
  const { a, b } = drag
  if (drag.shape === 'line' || drag.shape === 'dimension') return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PRIMARY} strokeWidth={0.5} pointerEvents="none" />
  return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill="none" stroke={PRIMARY} strokeWidth={0.5} strokeDasharray={drag.shape === 'cloud' || drag.shape === 'callout' ? '1.5 1' : undefined} pointerEvents="none" />
}

/** A live block on the sheet (load summary): what it reads, its title and its {field} text, with today's print as the preview. */
function FieldBlockPanel({ item, block, model, canEdit, blockedReason, send, freshness, onDelete }: { item: DrawingItem; block: FieldBlockSpec; model: ModelState; canEdit: boolean; blockedReason: string; send: (command: Parameters<SubmitCommand>[0], label: string) => boolean; freshness: React.ReactNode; onDelete: () => void }) {
  const subjects = useMemo(() => distributionEquipment(model.elements).map((p) => ({ id: p.id, label: p.name })), [model])
  const fieldsFor = useCallback((subjectId: string | null) => blockFieldChoices(model, subjectId ? asElementId(subjectId) : undefined), [model])
  const preview = useCallback(
    (d: FieldBlockDraft) => renderFieldBlock(model, { template: d.template, ...(d.title ? { title: d.title } : {}), ...(d.subjectId ? { subjectId: asElementId(d.subjectId) } : {}) }),
    [model],
  )
  if (block.calc) return <CalcBlockProperties item={item} block={block} model={model} canEdit={canEdit} blockedReason={blockedReason} freshness={freshness} onDelete={onDelete} />
  return (
    <FieldBlockProperties
      value={{ template: block.template, title: block.title ?? null, subjectId: block.subjectId ?? null }}
      subjects={subjects}
      fieldsFor={fieldsFor}
      preview={preview}
      templateProblem={fieldBlockTemplateProblem}
      defaultTemplate={LOAD_SUMMARY_TEMPLATE}
      canEdit={canEdit}
      blockedReason={blockedReason}
      onSave={(next, label) => send({ type: 'edit_field_block', itemId: item.id, template: next.template, title: next.title, subjectId: next.subjectId === null ? null : asElementId(next.subjectId) }, label)}
      onDelete={onDelete}
      freshness={freshness}
    />
  )
}

function ViewportProperties({
  name,
  scale,
  size,
  isometric,
  canEdit,
  blockedReason,
  editing,
  onEditHere,
  onOpen,
  onScale,
  onRemove,
}: {
  name: string
  scale: number
  size: Vec2
  isometric: boolean
  canEdit: boolean
  blockedReason: string
  editing: boolean
  onEditHere: () => void
  onOpen: () => void
  onScale: (scale: number) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Viewport</span>
      <span className="text-sm font-medium">{name}</span>
      <span className="text-xs text-muted-foreground">
        {(size.x / 25.4).toFixed(2)}&quot; × {(size.y / 25.4).toFixed(2)}&quot; on paper: the view&apos;s crop box at this scale.
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={onEditHere} disabled={editing} data-testid="open-view-on-sheet">
          Open view on sheet
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={onOpen}>
          Open by itself
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor="vp-scale">Scale on this sheet</FieldLabel>
        <Select value={String(scale)} onValueChange={(v) => onScale(Number(v))} disabled={!canEdit}>
          <SelectTrigger id="vp-scale" size="sm">
            <SelectValue placeholder={scaleLabel(scale)} />
          </SelectTrigger>
          <SelectContent className={CLOSES_AT_ONCE}>
            <SelectGroup>
              {STANDARD_SCALES.map((s) => (
                <SelectItem key={s.scale} value={String(s.scale)}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{isometric ? '3D views print from their own camera, cropped to their 3D box; scale sets their size.' : canEdit ? 'The crop box stays; the frame grows or shrinks on paper.' : blockedReason}</FieldDescription>
      </Field>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="outline" size="sm" className="w-full text-danger-600" disabled={!canEdit} onClick={onRemove}>
              Take off this sheet
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? 'The view itself stays in the panel. Ctrl+Z puts it back.' : blockedReason}</TooltipContent>
      </Tooltip>
    </div>
  )
}

const ROTATIONS = [0, 90, -90, 45, -45, 180] as const

function ItemProperties({
  item,
  canEdit,
  blockedReason,
  lockedBy,
  editing,
  fonts,
  onEditText,
  onAutoHeight,
  onRotate,
  onMask,
  onAddLeader,
  onLeaders,
  onDelete,
}: {
  item: DrawingItem
  onAddLeader: (elbow: boolean) => void
  onLeaders: (leaders: NoteLeader[]) => void
  canEdit: boolean
  blockedReason: string
  lockedBy: string | null
  editing: boolean
  fonts: 'loading' | 'ready' | 'fallback'
  onEditText: () => void
  onAutoHeight: () => void
  onRotate: (rotation: number) => void
  onMask: (mask: boolean) => void
  onDelete: () => void
}) {
  const label = item.shape === 'text' ? 'Note' : item.shape === 'cloud' ? 'Revision cloud' : item.shape === 'rect' ? 'Rectangle' : item.shape === 'dimension' ? 'Dimension' : 'Line'
  const resolved = item.shape === 'text' ? resolveNote(item) : null
  return (
    <div className="flex flex-col gap-3" data-testid="item-properties">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {resolved && (
        <>
          <span className="line-clamp-3 text-sm" data-testid="note-summary">
            {noteLabel(resolved.note.paragraphs, 140) || 'Empty note'}
          </span>
          {lockedBy && (
            <span className="rounded-md bg-warning-50 px-2 py-1 text-xs text-warning-800 ring-1 ring-warning-300" role="status" data-testid="note-locked">
              {lockedBy}. You can edit it when they finish.
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="outline" size="sm" className="w-full" disabled={!canEdit || Boolean(lockedBy) || editing} onClick={onEditText} data-testid="note-edit-text">
                  <Type data-icon="inline-start" />
                  {editing ? 'Editing on the sheet' : 'Edit text'}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{!canEdit ? blockedReason : lockedBy ? `${lockedBy}.` : 'Edit the text in place (or double-click the note, or press Enter).'}</TooltipContent>
          </Tooltip>
          <span className="text-xs text-muted-foreground">
            {(resolved.note.box.width / 25.4).toFixed(2)}&quot; wide, {resolved.note.box.height === null ? 'height grows with the text' : `${(resolved.note.box.height / 25.4).toFixed(2)}" tall (fixed)`}. Drag the side grips to re-wrap.
          </span>
          {resolved.note.box.height !== null && (
            <Button variant="outline" size="sm" disabled={!canEdit} onClick={onAutoHeight}>
              Fit height to text
            </Button>
          )}
          <Field>
            <FieldLabel htmlFor="note-rotation">Rotation</FieldLabel>
            <Select value={String(resolved.note.box.rotation)} onValueChange={(v) => onRotate(Number(v))} disabled={!canEdit}>
              <SelectTrigger id="note-rotation" size="sm">
                <SelectValue placeholder={`${resolved.note.box.rotation}°`} />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                <SelectGroup>
                  {[...new Set<number>([...ROTATIONS, resolved.note.box.rotation])].map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r}°
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>Turns the note about its top-left corner, clockwise.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="note-mask">Opaque background mask</FieldLabel>
            <Switch id="note-mask" checked={resolved.note.mask === true} disabled={!canEdit} onCheckedChange={onMask} data-testid="note-mask" />
          </Field>
          <NoteLeaders item={item} canEdit={canEdit} onAdd={onAddLeader} onChange={onLeaders} />
          {fonts === 'fallback' && <span className="text-xs text-warning-800">The note font didn&apos;t load, so the screen uses a look-alike with the same widths. The PDF embeds the real font.</span>}
        </>
      )}
      <Button variant="outline" size="sm" className="text-danger-600" disabled={!canEdit} onClick={onDelete}>
        Delete
      </Button>
      <span className="text-xs text-muted-foreground">Delete key also removes it. Ctrl+Z brings it back.</span>
    </div>
  )
}

const ARROW_LABEL: Record<(typeof LEADER_ARROWS)[number], string> = {
  arrow: 'Open arrow',
  filled_arrow: 'Filled arrow (NCS)',
  dot: 'Open dot',
  filled_dot: 'Filled dot (NCS)',
  tick: 'Architectural tick',
  none: 'No arrowhead',
}

/** A note's leaders: add one (straight or with a bend) by clicking on the drawing, change each arrowhead, remove. Drag their grips to move them. */
function NoteLeaders({ item, canEdit, onAdd, onChange }: { item: DrawingItem; canEdit: boolean; onAdd: (elbow: boolean) => void; onChange: (leaders: NoteLeader[]) => void }) {
  const leaders = [...(item.note?.leader ? [item.note.leader] : []), ...(item.note?.leaders ?? [])]
  return (
    <Field>
      <FieldLabel>Leaders</FieldLabel>
      {leaders.length === 0 && <span className="text-xs text-muted-foreground">None yet.</span>}
      {leaders.map((l, i) => (
        <div key={i} className="flex items-center gap-2" data-testid={`note-leader-${i}`}>
          <span className="w-16 text-xs text-muted-foreground">{l.elbow ? `${i + 1}, bent` : `${i + 1}`}</span>
          <Select value={l.arrow ?? 'arrow'} disabled={!canEdit} onValueChange={(v) => onChange(leaders.map((x, j) => (j === i ? { ...x, arrow: LEADER_ARROWS.find((a) => a === v) ?? 'arrow' } : x)))}>
            <SelectTrigger size="sm" className="h-7 flex-1" aria-label={`Leader ${i + 1} arrowhead`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={CLOSES_AT_ONCE}>
              <SelectGroup>
                {LEADER_ARROWS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {ARROW_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => onChange(leaders.filter((_, j) => j !== i))} aria-label={`Remove leader ${i + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" disabled={!canEdit || leaders.length >= 9} onClick={() => onAdd(false)} data-testid="note-add-leader">
          Add leader
        </Button>
        <Button variant="outline" size="sm" className="flex-1" disabled={!canEdit || leaders.length >= 9} onClick={() => onAdd(true)} data-testid="note-add-elbow-leader">
          With a bend
        </Button>
      </div>
      <FieldDescription>{leaders.length >= 9 ? 'A note takes up to 9 leaders.' : 'Then click on the drawing. Drag a leader’s grips to move it.'}</FieldDescription>
    </Field>
  )
}

/** Width or fixed height of a note box after dragging one edge by `d` paper mm. */
function resizeFrame(start: NoteFrame, edge: NoteEdge, d: Vec2): NoteFrame {
  const r = (-start.rotation * Math.PI) / 180
  const local = { x: d.x * Math.cos(r) - d.y * Math.sin(r), y: d.x * Math.sin(r) + d.y * Math.cos(r) }
  const min = NOTE_LIMITS.minWidthMm
  if (edge === 'right') return { ...start, width: Math.max(min, Math.round((start.width + local.x) * 10) / 10) }
  if (edge === 'left') {
    const width = Math.max(min, Math.round((start.width - local.x) * 10) / 10)
    const shift = start.width - width
    const a = (start.rotation * Math.PI) / 180
    return { ...start, width, origin: { x: start.origin.x + shift * Math.cos(a), y: start.origin.y + shift * Math.sin(a) } }
  }
  const height = Math.max(NOTE_LIMITS.minHeightMm, Math.round(((start.height ?? start.contentHeight) + local.y) * 10) / 10)
  return { ...start, height }
}

/**
 * Revit-style paper-space section, grid & level datum controls:
 * - Section head bubble (`1 / A-201`): click to jump straight to its sheet (or view), or drag along the section line to stretch the head independently of the cut range!
 * - Section tail flag: drag along the section line to stretch the tail independently of the cut range!
 * - Section center break button: click to split / rejoin the dashed section line across the plan!
 * - Structural grid bubbles: drag either end along the grid axis to pull bubbles cleanly outside the crop box!
 * - Section/elevation level datum margins: drag left/right handles to pull level targets out cleanly into the sheet margin!
 */
function SectionMarkerLinks({
  model,
  views,
  isSheet = false,
  canEdit,
  paperOf,
  submit,
  onOpenView,
  onOpenSheet,
}: {
  readonly model: ModelState
  readonly views: readonly { readonly view: ViewElement; readonly frame: ViewFrame; readonly viewport?: Viewport }[]
  readonly isSheet?: boolean
  readonly canEdit: boolean
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly submit: SubmitCommand
  readonly onOpenView: (viewId: string) => void
  readonly onOpenSheet?: (sheetId: string) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [drag, setDrag] = useState<{
    readonly kind: 'sec-head' | 'sec-tail' | 'sec-line' | 'grid-start' | 'grid-end' | 'grid-line' | 'level-left' | 'level-right' | 'vp-title' | 'vp-rule' | 'vp-north' | 'callout-head'
    readonly id: string
    readonly pointerId: number
    readonly originPaper: Vec2
    readonly curPaper: Vec2
    readonly moved: boolean
    readonly altKey: boolean
    readonly frame: ViewFrame
    readonly view: ViewElement
  } | null>(null)

  const sections = useMemo(() => {
    const index = documentIndex(model)
    const out: Array<{
      readonly key: string
      readonly refView: ViewElement
      readonly frame: ViewFrame
      readonly p0: Vec2
      readonly p1: Vec2
      readonly head: Vec2
      readonly radius: number
      readonly mid: Vec2
      readonly ax: Vec2
      readonly perp: Vec2
      readonly label: string
      readonly sheetId: string | null
    }> = []
    for (const { view, frame } of views) {
      if (view.viewType !== 'floor_plan' && view.viewType !== 'ceiling_plan') continue
      for (const refView of planReferenceViews(model, view)) {
        const cut = refView.props?.section
        const ep = sectionMarkEndpoints(cut)
        if (!cut || !ep) continue
        const p0 = modelToPaper(frame, ep.start)
        const p1 = modelToPaper(frame, ep.end)
        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-3) continue
        const ax = { x: dx / len, y: dy / len }
        const perp = { x: -ax.y, y: ax.x }
        const elevGeo = refView.viewType === 'elevation' ? elevationMarkCenter(cut, (pt) => modelToPaper(frame, pt)) : null
        const head = refView.viewType === 'section' ? { x: p0.x - ax.x * HEAD_RADIUS_MM, y: p0.y - ax.y * HEAD_RADIUS_MM } : (elevGeo?.head ?? { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 })
        const radius = refView.viewType === 'section' ? HEAD_RADIUS_MM + 0.5 : ELEV_RADIUS_MM + 0.5
        const vp = index.viewportByView.get(refView.id)
        const sheet = vp ? model.elements[vp.sheetId] : undefined
        const sheetId = sheet?.kind === 'sheet' && !sheet.deleted ? sheet.id : null
        const sheetNum = sheet?.kind === 'sheet' && !sheet.deleted ? sheet.number : null
        const dragHint = refView.viewType === 'section' ? ' · drag to extend head' : ''
        out.push({
          key: `${view.id}:${refView.id}`,
          refView,
          frame,
          p0,
          p1,
          head,
          radius,
          mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
          ax,
          perp,
          sheetId,
          label: sheetNum ? `Click to open Sheet ${sheetNum} — ${refView.name}${dragHint}` : `Click to open ${refView.name}${dragHint}`,
        })
      }
    }
    return out
  }, [model, views])

  /** Live callout bubbles (`shape === 'callout'`) inside every visible view: click to jump to the target sheet/view, OR drag directly to move the callout bubble & leader. */
  const calloutHeads = useMemo(() => {
    const index = documentIndex(model)
    const out: Array<{
      readonly key: string
      readonly item: DrawingItem
      readonly frame: ViewFrame
      readonly view: ViewElement
      readonly boundaryPaper: readonly Vec2[]
      readonly head: Vec2
      readonly top: string
      readonly bottom: string
      readonly targetViewId: string
      readonly sheetId: string | null
      readonly label: string
    }> = []
    for (const { view, frame } of views) {
      for (const item of index.itemsByOwner.get(view.id) ?? []) {
        if (item.deleted || item.shape !== 'callout' || !item.callout || !item.points[2]) continue
        const target = model.elements[item.callout.viewId]
        if (!target || target.kind !== 'view' || target.deleted) continue
        const live = calloutHead(model, item.callout)
        const head = modelToPaper(frame, item.points[2])
        const poly = calloutBoundaryPolygon(item) ?? []
        const boundaryPaper = poly.map((q) => modelToPaper(frame, q))
        out.push({
          key: `callout:${view.id}:${item.id}`,
          item,
          frame,
          view,
          boundaryPaper,
          head,
          top: live.top,
          bottom: live.bottom,
          targetViewId: target.id,
          sheetId: live.sheetId,
          label: live.sheetId
            ? `Click to open Sheet ${live.bottom} — ${target.name} (or drag bubble to move)`
            : `Click to open ${target.name} (or drag bubble to move)`,
        })
      }
    }
    return out
  }, [model, views])

  /** Sheet viewport titles: movable on sheet, resizable horizontal rule end, and clickable back-reference bubble (`1 / A-101`). */
  const viewportTitles = useMemo(() => {
    if (!isSheet) return []
    const out: Array<{
      readonly key: string
      readonly viewport: Viewport
      readonly view: ViewElement
      readonly frame: ViewFrame
      readonly layout: ReturnType<typeof viewportTitleLayout>
      readonly backRef: ReturnType<typeof referencingSheet>
      readonly backLabel: string | null
      readonly northCenter: Vec2 | null
    }> = []
    for (const { view, frame, viewport } of views) {
      if (!viewport || view.viewType === 'schedule') continue
      const backRef = referencingSheet(model, view)
      const layout = viewportTitleLayout(frame, viewport, view.name, !!backRef)
      const srcView = backRef ? model.elements[backRef.sourceViewId] : undefined
      const srcName = srcView?.kind === 'view' ? ` — ${srcView.name}` : ''
      const arrow = viewportNorthArrow(model, viewport, view)
      const northCenter = arrow
        ? {
            x: layout.ruleEndX + NORTH_ARROW_RADIUS_MM + 8 + (viewport.northArrowOffsetMm?.x ?? 0),
            y: layout.titleY + 7 + (viewport.northArrowOffsetMm?.y ?? 0),
          }
        : null
      out.push({
        key: `vptitle:${viewport.id}`,
        viewport,
        view,
        frame,
        layout,
        backRef,
        backLabel: backRef ? `Click to return to Sheet ${backRef.sheetNumber}${srcName} · drag title to move` : null,
        northCenter,
      })
    }
    return out
  }, [isSheet, model, views])

  /** Structural column grids with exact kernel bubble positions (`gridBubbleEndpoints`) for aligned dragging & lateral relocation. */
  const grids = useMemo(() => {
    const out: Array<{
      readonly key: string
      readonly id: string
      readonly label: string
      readonly levelId: string
      readonly frame: ViewFrame
      readonly view: ViewElement
      readonly pA: Vec2
      readonly pB: Vec2
      readonly bubbleA: Vec2
      readonly bubbleB: Vec2
      readonly hasBubbleB: boolean
      readonly radius: number
      readonly start: Vec2
      readonly end: Vec2
    }> = []
    const allGrids = elementsOfKind(model.elements, 'grid')
    if (allGrids.length === 0) return out
    const firstLevel = elementsOfKind(model.elements, 'level')[0]?.id ?? 'L1'
    for (const { view, frame } of views) {
      if (view.viewType !== 'floor_plan' && view.viewType !== 'ceiling_plan') continue
      const win = frame.windowSize ?? frame.size
      const halfW = (win.x * frame.scale) / 2
      const halfH = (win.y * frame.scale) / 2
      const bMin = { x: frame.modelCenter.x - halfW, y: frame.modelCenter.y - halfH }
      const bMax = { x: frame.modelCenter.x + halfW, y: frame.modelCenter.y + halfH }
      for (const g of allGrids) {
        const geo = gridBubbleEndpoints(g.start, g.end, frame.scale, bMin, bMax, (pt) => modelToPaper(frame, pt))
        if (!geo) continue
        const levelId = g.placement?.kind === 'line' ? g.placement.levelId : firstLevel
        out.push({
          key: `${view.id}:${g.id}`,
          id: g.id,
          label: g.label,
          levelId,
          frame,
          view,
          pA: geo.pA,
          pB: geo.pB,
          bubbleA: geo.bubbleA,
          bubbleB: geo.bubbleB,
          hasBubbleB: geo.hasBubbleB,
          radius: geo.radius,
          start: g.start,
          end: g.end,
        })
      }
    }
    return out
  }, [model, views])

  const levelViews = useMemo(
    () =>
      views
        .filter(({ view }) => view.viewType === 'section' || view.viewType === 'elevation')
        .map(({ view, frame }) => {
          const leftEdge = frame.center.x - frame.size.x / 2
          const rightEdge = frame.center.x + frame.size.x / 2
          const leftExt = view.props?.levelLeftExtMm ?? 0
          const rightX = view.props?.levelRightExtMm !== undefined ? rightEdge + view.props.levelRightExtMm + 2.6 : Math.max(leftEdge + 25, rightEdge - 24) + 2.6
          return {
            view,
            frame,
            leftX: leftEdge - leftExt,
            rightX,
            topY: frame.center.y - frame.size.y / 2,
            botY: frame.center.y + frame.size.y / 2,
            midY: frame.center.y,
          }
        }),
    [views],
  )

  if (sections.length === 0 && calloutHeads.length === 0 && viewportTitles.length === 0 && grids.length === 0 && levelViews.length === 0) return null

  return (
    <g data-testid="section-marker-links">
      {/* Section & elevation marks: click head to open sheet, drag head/tail along axis, drag shaft laterally to move cut plane, click center to split/join */}
      {sections.map((s) => {
        const cut = s.refView.props?.section
        if (!cut) return null
        const draggingHead = drag?.kind === 'sec-head' && drag.id === s.refView.id
        const draggingTail = drag?.kind === 'sec-tail' && drag.id === s.refView.id
        const draggingLine = drag?.kind === 'sec-line' && drag.id === s.refView.id
        const isActive = hovered === s.key || draggingHead || draggingTail || draggingLine
        const axisDelta = drag && (draggingHead || draggingTail) ? (drag.curPaper.x - drag.originPaper.x) * s.ax.x + (drag.curPaper.y - drag.originPaper.y) * s.ax.y : 0
        const perpDelta = drag && draggingLine ? (drag.curPaper.x - drag.originPaper.x) * s.perp.x + (drag.curPaper.y - drag.originPaper.y) * s.perp.y : 0
        const headCx = s.head.x + (draggingHead ? s.ax.x * axisDelta : 0) + (draggingLine ? s.perp.x * perpDelta : 0)
        const headCy = s.head.y + (draggingHead ? s.ax.y * axisDelta : 0) + (draggingLine ? s.perp.y * perpDelta : 0)
        const p0x = s.p0.x + (draggingHead ? s.ax.x * axisDelta : 0) + (draggingLine ? s.perp.x * perpDelta : 0)
        const p0y = s.p0.y + (draggingHead ? s.ax.y * axisDelta : 0) + (draggingLine ? s.perp.y * perpDelta : 0)
        const tailCx = s.p1.x + (draggingTail ? s.ax.x * axisDelta : 0) + (draggingLine ? s.perp.x * perpDelta : 0)
        const tailCy = s.p1.y + (draggingTail ? s.ax.y * axisDelta : 0) + (draggingLine ? s.perp.y * perpDelta : 0)
        return (
          <g key={s.key} onPointerEnter={() => setHovered(s.key)} onPointerLeave={() => setHovered((cur) => (cur === s.key ? null : cur))}>
            {/* Live Revit blue rubberband preview while dragging head, tail, or cut line */}
            {(draggingHead || draggingTail || draggingLine) && (
              <g className="pointer-events-none">
                <line x1={p0x} y1={p0y} x2={tailCx} y2={tailCy} stroke={PRIMARY} strokeWidth={0.65} strokeDasharray="3 1.5" />
                <circle cx={headCx} cy={headCy} r={HEAD_RADIUS_MM} fill={PRIMARY} fillOpacity={0.12} stroke={PRIMARY} strokeWidth={0.65} />
              </g>
            )}

            {/* Section cut line shaft: hover illuminates all Revit controls; drag laterally to move section cut plane */}
            {canEdit && s.refView.viewType === 'section' && (
              <line
                x1={s.p0.x}
                y1={s.p0.y}
                x2={s.p1.x}
                y2={s.p1.y}
                stroke={isActive ? PRIMARY : 'transparent'}
                strokeOpacity={isActive ? 0.35 : 0}
                strokeWidth={3.8}
                className="cursor-move"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'sec-line', id: s.refView.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: s.frame, view: s.refView })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'sec-line' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                  setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.2 })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'sec-line' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const deltaP = (drag.curPaper.x - drag.originPaper.x) * s.perp.x + (drag.curPaper.y - drag.originPaper.y) * s.perp.y
                  setDrag(null)
                  if (!wasMoved) return
                  const m0 = paperToModel(s.frame, drag.originPaper)
                  const m1 = paperToModel(s.frame, { x: drag.originPaper.x + s.perp.x * deltaP, y: drag.originPaper.y + s.perp.y * deltaP })
                  const dxM = Math.round(m1.x - m0.x)
                  const dyM = Math.round(m1.y - m0.y)
                  if (Math.hypot(dxM, dyM) < 20) return
                  submit(
                    {
                      type: 'set_view_crop',
                      viewId: s.refView.id,
                      section: { ...cut, start: { x: cut.start.x + dxM, y: cut.start.y + dyM }, end: { x: cut.end.x + dxM, y: cut.end.y + dyM } },
                    },
                    `Move ${s.refView.name} cut line`,
                  )
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>{`Drag ${s.refView.name} cut line to relocate section plane`}</title>
              </line>
            )}

            {/* Head bubble: click jumps to sheet, drag along axis adjusts headExtMm independently */}
            <circle
              cx={headCx}
              cy={headCy}
              r={s.radius}
              className="cursor-pointer transition-colors"
              fill={isActive ? PRIMARY : 'transparent'}
              fillOpacity={isActive ? 0.14 : 0}
              stroke={isActive ? PRIMARY : 'transparent'}
              strokeWidth={0.75}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                const pt = paperOf(e)
                if (!pt || !canEdit || s.refView.viewType !== 'section') {
                  if (s.sheetId && onOpenSheet) onOpenSheet(s.sheetId)
                  else onOpenView(s.refView.id)
                  return
                }
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({ kind: 'sec-head', id: s.refView.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: s.frame, view: s.refView })
              }}
              onPointerMove={(e) => {
                if (!drag || drag.kind !== 'sec-head' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                const pt = paperOf(e)
                if (!pt) return
                const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.8 })
              }}
              onPointerUp={(e) => {
                if (!drag || drag.kind !== 'sec-head' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                e.stopPropagation()
                const wasMoved = drag.moved
                const proj = (drag.curPaper.x - drag.originPaper.x) * s.ax.x + (drag.curPaper.y - drag.originPaper.y) * s.ax.y
                setDrag(null)
                if (!wasMoved) {
                  if (s.sheetId && onOpenSheet) onOpenSheet(s.sheetId)
                  else onOpenView(s.refView.id)
                  return
                }
                const nextHeadExt = Math.round((cut.headExtMm ?? 0) - proj * s.frame.scale)
                submit({ type: 'set_view_crop', viewId: s.refView.id, section: { ...cut, headExtMm: nextHeadExt } }, 'Extend section head')
              }}
              onLostPointerCapture={() => setDrag(null)}
            >
              <title>{s.label}</title>
            </circle>

            {/* Tail grip: hollow blue Revit dot on hover, drag along axis to extend tail independently of cut range */}
            {canEdit && s.refView.viewType === 'section' && (
              <circle
                cx={tailCx}
                cy={tailCy}
                r={isActive ? 2.4 : 3.8}
                className="cursor-ew-resize transition-all"
                fill={isActive ? '#ffffff' : 'transparent'}
                stroke={isActive ? PRIMARY : 'transparent'}
                strokeWidth={0.75}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'sec-tail', id: s.refView.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: s.frame, view: s.refView })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'sec-tail' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                  setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.2 })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'sec-tail' || drag.id !== s.refView.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const proj = (drag.curPaper.x - drag.originPaper.x) * s.ax.x + (drag.curPaper.y - drag.originPaper.y) * s.ax.y
                  setDrag(null)
                  if (!wasMoved) return
                  const nextTailExt = Math.round((cut.tailExtMm ?? 0) + proj * s.frame.scale)
                  submit({ type: 'set_view_crop', viewId: s.refView.id, section: { ...cut, tailExtMm: nextTailExt } }, 'Extend section tail')
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>Drag to extend section tail independently of cut range</title>
              </circle>
            )}

            {/* Center Revit break/join glyph: visible when hovering section line; click toggles splitGap */}
            {canEdit && s.refView.viewType === 'section' && (
              <g
                className="cursor-pointer"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  submit(
                    { type: 'set_view_crop', viewId: s.refView.id, section: { ...cut, splitGap: !cut.splitGap } },
                    cut.splitGap ? 'Join section line' : 'Split section line',
                  )
                }}
              >
                <circle cx={s.mid.x} cy={s.mid.y} r={3.2} fill={isActive ? '#ffffff' : 'transparent'} stroke={isActive ? PRIMARY : 'transparent'} strokeWidth={0.6} />
                {isActive && (
                  <path
                    d={`M ${s.mid.x - 1.6} ${s.mid.y - 0.8} L ${s.mid.x - 0.5} ${s.mid.y + 1.0} L ${s.mid.x + 0.5} ${s.mid.y - 1.0} L ${s.mid.x + 1.6} ${s.mid.y + 0.8}`}
                    fill="none"
                    stroke={PRIMARY}
                    strokeWidth={0.55}
                    className="pointer-events-none"
                  />
                )}
                <title>{cut.splitGap ? 'Click to rejoin section cut line' : 'Click to split section line in the middle (Revit break)'}</title>
              </g>
            )}
          </g>
        )
      })}

      {/* Callout head bubbles (`shape === 'callout'`): click to open target sheet/view, OR drag directly to move the bubble with live smart leader */}
      {calloutHeads.map((c) => {
        const dragging = drag?.kind === 'callout-head' && drag.id === c.item.id
        const cx = dragging && drag ? c.head.x + (drag.curPaper.x - drag.originPaper.x) : c.head.x
        const cy = dragging && drag ? c.head.y + (drag.curPaper.y - drag.originPaper.y) : c.head.y
        const liveAnchor = dragging && drag?.moved ? calloutLeaderAnchor(c.boundaryPaper, { x: cx, y: cy }) : null
        const d = liveAnchor ? Math.hypot(liveAnchor.x - cx, liveAnchor.y - cy) : 0
        const edgePt =
          liveAnchor && d > HEAD_RADIUS_MM
            ? { x: cx + ((liveAnchor.x - cx) * HEAD_RADIUS_MM) / d, y: cy + ((liveAnchor.y - cy) * HEAD_RADIUS_MM) / d }
            : null
        return (
          <g key={c.key}>
            {dragging && drag?.moved && (
              <g className="pointer-events-none">
                {liveAnchor && edgePt && <line x1={liveAnchor.x} y1={liveAnchor.y} x2={edgePt.x} y2={edgePt.y} stroke={PRIMARY} strokeWidth={0.5} />}
                <circle cx={cx} cy={cy} r={HEAD_RADIUS_MM} fill="#ffffff" fillOpacity={0.94} stroke={PRIMARY} strokeWidth={0.65} />
                <line x1={cx - HEAD_RADIUS_MM} y1={cy} x2={cx + HEAD_RADIUS_MM} y2={cy} stroke={PRIMARY} strokeWidth={0.35} />
                <text x={cx} y={cy - 1.2} fontSize={2.4} fontWeight="bold" textAnchor="middle" fill={PRIMARY} fontFamily="Helvetica, Arial, sans-serif">
                  {c.top}
                </text>
                <text x={cx} y={cy + 3.0} fontSize={2.2} textAnchor="middle" fill={PRIMARY} fontFamily="Helvetica, Arial, sans-serif">
                  {c.bottom}
                </text>
              </g>
            )}
            <circle
              cx={cx}
              cy={cy}
              r={HEAD_RADIUS_MM + 0.5}
              data-testid="callout-head-link"
              className="cursor-pointer fill-transparent stroke-transparent hover:fill-primary/15 hover:stroke-primary/80 transition-colors"
              strokeWidth={0.7}
              onPointerDown={(e) => {
                if (e.button !== 0 || e.shiftKey) return
                e.stopPropagation()
                const pt = paperOf(e)
                if (!pt || !canEdit) {
                  if (c.sheetId && onOpenSheet) onOpenSheet(c.sheetId)
                  else onOpenView(c.targetViewId)
                  return
                }
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({ kind: 'callout-head', id: c.item.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: c.frame, view: c.view })
              }}
              onPointerMove={(e) => {
                if (!drag || drag.kind !== 'callout-head' || drag.id !== c.item.id || e.pointerId !== drag.pointerId) return
                const pt = paperOf(e)
                if (!pt) return
                const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.4 })
              }}
              onPointerUp={(e) => {
                if (!drag || drag.kind !== 'callout-head' || drag.id !== c.item.id || e.pointerId !== drag.pointerId) return
                e.stopPropagation()
                const wasMoved = drag.moved
                const nextPaper = { x: c.head.x + (drag.curPaper.x - drag.originPaper.x), y: c.head.y + (drag.curPaper.y - drag.originPaper.y) }
                setDrag(null)
                if (!wasMoved) {
                  if (c.sheetId && onOpenSheet) onOpenSheet(c.sheetId)
                  else onOpenView(c.targetViewId)
                  return
                }
                const nextModel = paperToModel(c.frame, nextPaper)
                const pts = c.item.points.map((p, i) => (i === 2 ? { x: Math.round(nextModel.x * 10) / 10, y: Math.round(nextModel.y * 10) / 10 } : p))
                submit({ type: 'update_drawing_item', itemId: c.item.id, points: pts, ...(c.item.callout ? { callout: c.item.callout } : {}) }, 'move callout bubble')
              }}
              onLostPointerCapture={() => setDrag(null)}
            >
              <title>{c.label}</title>
            </circle>
          </g>
        )
      })}

      {/* Revit sheet viewport titles: drag title block to move anywhere on sheet, drag right-end blue dot to resize title line, click back-ref bubble to jump back */}
      {viewportTitles.map((vt) => {
        const draggingTitle = drag?.kind === 'vp-title' && drag.id === vt.viewport.id
        const draggingRule = drag?.kind === 'vp-rule' && drag.id === vt.viewport.id
        const draggingNorth = drag?.kind === 'vp-north' && drag.id === vt.viewport.id
        const isActive = hovered === vt.key || draggingTitle || draggingRule
        const northKey = `vpnorth:${vt.viewport.id}`
        const northActive = hovered === northKey || draggingNorth
        const dx = draggingTitle && drag ? drag.curPaper.x - drag.originPaper.x : 0
        const dy = draggingTitle && drag ? drag.curPaper.y - drag.originPaper.y : 0
        const ndx = draggingNorth && drag ? drag.curPaper.x - drag.originPaper.x : 0
        const ndy = draggingNorth && drag ? drag.curPaper.y - drag.originPaper.y : 0
        const ruleDx = draggingRule && drag ? drag.curPaper.x - drag.originPaper.x : 0
        const { hitRect, bubbleCenter, ruleStartX, ruleEndX, ruleY } = vt.layout
        const curRuleEndX = Math.max(ruleStartX + 20, ruleEndX + ruleDx)
        return (
          <g key={vt.key} onPointerEnter={() => setHovered(vt.key)} onPointerLeave={() => setHovered((cur) => (cur === vt.key ? null : cur))}>
            {/* Live ghost outline while dragging viewport title */}
            {draggingTitle && (
              <rect
                x={hitRect.x + dx}
                y={hitRect.y + dy}
                width={hitRect.w}
                height={hitRect.h}
                rx={1.5}
                fill={PRIMARY}
                fillOpacity={0.1}
                stroke={PRIMARY}
                strokeWidth={0.6}
                strokeDasharray="2.5 1.5"
                className="pointer-events-none"
              />
            )}
            {/* Live rubberband title rule while dragging right-end handle */}
            {draggingRule && (
              <line x1={ruleStartX} y1={ruleY} x2={curRuleEndX} y2={ruleY} stroke={PRIMARY} strokeWidth={0.85} className="pointer-events-none" />
            )}

            {/* Draggable viewport title block */}
            {canEdit && (
              <rect
                x={hitRect.x}
                y={hitRect.y}
                width={hitRect.w}
                height={hitRect.h}
                rx={1.5}
                data-testid="viewport-title-drag"
                className="cursor-move transition-colors"
                fill={isActive ? PRIMARY : 'transparent'}
                fillOpacity={isActive ? 0.06 : 0}
                stroke={isActive ? PRIMARY : 'transparent'}
                strokeOpacity={isActive ? 0.65 : 0}
                strokeDasharray="2 1.5"
                strokeWidth={0.5}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'vp-title', id: vt.viewport.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: vt.frame, view: vt.view })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'vp-title' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                  setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.0 })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'vp-title' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const deltaX = drag.curPaper.x - drag.originPaper.x
                  const deltaY = drag.curPaper.y - drag.originPaper.y
                  setDrag(null)
                  if (!wasMoved) return
                  const curOff = vt.viewport.titleOffsetMm ?? { x: 0, y: 0 }
                  submit(
                    { type: 'set_viewport_title', viewportId: vt.viewport.id, titleOffsetMm: { x: Math.round((curOff.x + deltaX) * 10) / 10, y: Math.round((curOff.y + deltaY) * 10) / 10 } },
                    `Move ${vt.view.name} title`,
                  )
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>{`Drag to move ${vt.view.name} title on sheet`}</title>
              </rect>
            )}

            {/* Back-reference circle (`1 / A-101`): click jumps straight back to referencing sheet; drag moves title */}
            {vt.backRef && (
              <circle
                cx={bubbleCenter.x + dx}
                cy={bubbleCenter.y + dy}
                r={HEAD_RADIUS_MM + 0.6}
                data-testid="view-title-back-link"
                className="cursor-pointer fill-transparent stroke-transparent hover:fill-primary/15 hover:stroke-primary/80 transition-colors"
                strokeWidth={0.75}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt || !canEdit) {
                    if (onOpenSheet) onOpenSheet(vt.backRef!.sheetId)
                    else onOpenView(vt.backRef!.sourceViewId)
                    return
                  }
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'vp-title', id: vt.viewport.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: vt.frame, view: vt.view })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'vp-title' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                  setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.8 })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'vp-title' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const deltaX = drag.curPaper.x - drag.originPaper.x
                  const deltaY = drag.curPaper.y - drag.originPaper.y
                  setDrag(null)
                  if (!wasMoved) {
                    if (onOpenSheet) onOpenSheet(vt.backRef!.sheetId)
                    else onOpenView(vt.backRef!.sourceViewId)
                    return
                  }
                  const curOff = vt.viewport.titleOffsetMm ?? { x: 0, y: 0 }
                  submit(
                    { type: 'set_viewport_title', viewportId: vt.viewport.id, titleOffsetMm: { x: Math.round((curOff.x + deltaX) * 10) / 10, y: Math.round((curOff.y + deltaY) * 10) / 10 } },
                    `Move ${vt.view.name} title`,
                  )
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>{vt.backLabel ?? 'Click to return to referencing sheet'}</title>
              </circle>
            )}

            {/* Right-end hollow blue Revit dot: drag horizontally to shorten or lengthen the title underline */}
            {canEdit && (
              <circle
                cx={curRuleEndX}
                cy={ruleY + dy}
                r={isActive ? 2.2 : 3.2}
                data-testid="viewport-title-rule-grip"
                className="cursor-ew-resize transition-all"
                fill={isActive ? '#ffffff' : 'transparent'}
                stroke={isActive ? PRIMARY : 'transparent'}
                strokeWidth={0.75}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'vp-rule', id: vt.viewport.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: vt.frame, view: vt.view })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'vp-rule' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  setDrag({ ...drag, curPaper: pt, moved: true })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'vp-rule' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const deltaX = drag.curPaper.x - drag.originPaper.x
                  setDrag(null)
                  if (!wasMoved || Math.abs(deltaX) < 0.5) return
                  const nextLen = Math.max(20, Math.min(600, Math.round((ruleEndX - ruleStartX + deltaX) * 10) / 10))
                  submit({ type: 'set_viewport_title', viewportId: vt.viewport.id, titleRuleMm: nextLen }, `Resize ${vt.view.name} title line`)
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>Drag to lengthen or shorten viewport title line</title>
              </circle>
            )}

            {/* Draggable North Arrow handle on sheet (mirrors viewport title dragging) */}
            {canEdit && vt.northCenter && (
              <g onPointerEnter={() => setHovered(northKey)} onPointerLeave={() => setHovered((cur) => (cur === northKey ? null : cur))}>
                {draggingNorth && (
                  <circle
                    cx={vt.northCenter.x + ndx}
                    cy={vt.northCenter.y + ndy}
                    r={NORTH_ARROW_RADIUS_MM + 3}
                    fill={PRIMARY}
                    fillOpacity={0.12}
                    stroke={PRIMARY}
                    strokeWidth={0.6}
                    strokeDasharray="2.5 1.5"
                    className="pointer-events-none"
                  />
                )}
                <circle
                  cx={vt.northCenter.x}
                  cy={vt.northCenter.y}
                  r={NORTH_ARROW_RADIUS_MM + 3.5}
                  data-testid="viewport-north-arrow-drag"
                  className="cursor-move transition-colors"
                  fill={northActive ? PRIMARY : 'transparent'}
                  fillOpacity={northActive ? 0.08 : 0}
                  stroke={northActive ? PRIMARY : 'transparent'}
                  strokeOpacity={northActive ? 0.7 : 0}
                  strokeDasharray="2 1.5"
                  strokeWidth={0.55}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    const pt = paperOf(e)
                    if (!pt) return
                    e.currentTarget.setPointerCapture(e.pointerId)
                    setDrag({ kind: 'vp-north', id: vt.viewport.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: vt.frame, view: vt.view })
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.kind !== 'vp-north' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                    const pt = paperOf(e)
                    if (!pt) return
                    const d = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                    setDrag({ ...drag, curPaper: pt, moved: drag.moved || d > 1.0 })
                  }}
                  onPointerUp={(e) => {
                    if (!drag || drag.kind !== 'vp-north' || drag.id !== vt.viewport.id || e.pointerId !== drag.pointerId) return
                    e.stopPropagation()
                    const wasMoved = drag.moved
                    const deltaX = drag.curPaper.x - drag.originPaper.x
                    const deltaY = drag.curPaper.y - drag.originPaper.y
                    setDrag(null)
                    if (!wasMoved) return
                    const curOff = vt.viewport.northArrowOffsetMm ?? { x: 0, y: 0 }
                    submit(
                      { type: 'set_viewport_north_arrow', viewportId: vt.viewport.id, offsetMm: { x: Math.round((curOff.x + deltaX) * 10) / 10, y: Math.round((curOff.y + deltaY) * 10) / 10 } },
                      `Move ${vt.view.name} north arrow`,
                    )
                  }}
                  onLostPointerCapture={() => setDrag(null)}
                >
                  <title>{`Drag to move ${vt.view.name} north arrow on sheet`}</title>
                </circle>
              </g>
            )}
          </g>
        )
      })}

      {/* Draggable Revit structural grids: drag circular bubble along grid axis (moves aligned parallel grids together; hold Alt for single grid), drag line laterally to relocate grid */}
      {canEdit &&
        grids.map((g) => {
          const draggingStart = drag?.kind === 'grid-start' && drag.id === g.id
          const draggingEnd = drag?.kind === 'grid-end' && drag.id === g.id
          const draggingLine = drag?.kind === 'grid-line' && drag.id === g.id
          const isActive = hovered === g.key || draggingStart || draggingEnd || draggingLine
          const pdx = g.pB.x - g.pA.x
          const pdy = g.pB.y - g.pA.y
          const plen = Math.hypot(pdx, pdy) || 1
          const pax = pdx / plen
          const pay = pdy / plen
          const pnx = -pay
          const pny = pax
          const axisDelta = drag && (draggingStart || draggingEnd) ? (drag.curPaper.x - drag.originPaper.x) * pax + (drag.curPaper.y - drag.originPaper.y) * pay : 0
          const perpDelta = drag && draggingLine ? (drag.curPaper.x - drag.originPaper.x) * pnx + (drag.curPaper.y - drag.originPaper.y) * pny : 0
          const bAx = g.bubbleA.x + (draggingStart ? pax * axisDelta : 0) + (draggingLine ? pnx * perpDelta : 0)
          const bAy = g.bubbleA.y + (draggingStart ? pay * axisDelta : 0) + (draggingLine ? pny * perpDelta : 0)
          const bBx = g.bubbleB.x + (draggingEnd ? pax * axisDelta : 0) + (draggingLine ? pnx * perpDelta : 0)
          const bBy = g.bubbleB.y + (draggingEnd ? pay * axisDelta : 0) + (draggingLine ? pny * perpDelta : 0)
          const lineAx = g.pA.x + (draggingStart ? pax * axisDelta : 0) + (draggingLine ? pnx * perpDelta : 0)
          const lineAy = g.pA.y + (draggingStart ? pay * axisDelta : 0) + (draggingLine ? pny * perpDelta : 0)
          const lineBx = g.pB.x + (draggingEnd ? pax * axisDelta : 0) + (draggingLine ? pnx * perpDelta : 0)
          const lineBy = g.pB.y + (draggingEnd ? pay * axisDelta : 0) + (draggingLine ? pny * perpDelta : 0)
          return (
            <g key={g.key} onPointerEnter={() => setHovered(g.key)} onPointerLeave={() => setHovered((cur) => (cur === g.key ? null : cur))}>
              {/* Live blue preview while dragging grid bubble or shifting grid line */}
              {(draggingStart || draggingEnd || draggingLine) && (
                <g className="pointer-events-none">
                  <line x1={lineAx} y1={lineAy} x2={lineBx} y2={lineBy} stroke={PRIMARY} strokeWidth={0.65} strokeDasharray="3 1.5" />
                  <circle cx={bAx} cy={bAy} r={g.radius} fill={PRIMARY} fillOpacity={0.14} stroke={PRIMARY} strokeWidth={0.65} />
                  {g.hasBubbleB && <circle cx={bBx} cy={bBy} r={g.radius} fill={PRIMARY} fillOpacity={0.14} stroke={PRIMARY} strokeWidth={0.65} />}
                </g>
              )}

              {/* Grid line shaft: drag laterally perpendicular to grid to move grid line */}
              <line
                x1={g.pA.x}
                y1={g.pA.y}
                x2={g.pB.x}
                y2={g.pB.y}
                stroke={isActive ? PRIMARY : 'transparent'}
                strokeOpacity={isActive ? 0.3 : 0}
                strokeWidth={3.0}
                className="cursor-move"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const pt = paperOf(e)
                  if (!pt) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ kind: 'grid-line', id: g.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: g.frame, view: g.view })
                }}
                onPointerMove={(e) => {
                  if (!drag || drag.kind !== 'grid-line' || drag.id !== g.id || e.pointerId !== drag.pointerId) return
                  const pt = paperOf(e)
                  if (!pt) return
                  const dist = Math.hypot(pt.x - drag.originPaper.x, pt.y - drag.originPaper.y)
                  setDrag({ ...drag, curPaper: pt, moved: drag.moved || dist > 1.2 })
                }}
                onPointerUp={(e) => {
                  if (!drag || drag.kind !== 'grid-line' || drag.id !== g.id || e.pointerId !== drag.pointerId) return
                  e.stopPropagation()
                  const wasMoved = drag.moved
                  const deltaP = (drag.curPaper.x - drag.originPaper.x) * pnx + (drag.curPaper.y - drag.originPaper.y) * pny
                  setDrag(null)
                  if (!wasMoved) return
                  const m0 = paperToModel(g.frame, drag.originPaper)
                  const m1 = paperToModel(g.frame, { x: drag.originPaper.x + pnx * deltaP, y: drag.originPaper.y + pny * deltaP })
                  const dxM = Math.round(m1.x - m0.x)
                  const dyM = Math.round(m1.y - m0.y)
                  if (Math.hypot(dxM, dyM) < 20) return
                  submit(
                    {
                      type: 'set_element_placement',
                      elementId: g.id,
                      placement: {
                        kind: 'line',
                        levelId: g.levelId,
                        start: { x: g.start.x + dxM, y: g.start.y + dyM },
                        end: { x: g.end.x + dxM, y: g.end.y + dyM },
                        startOffsetMm: 0,
                        endOffsetMm: 0,
                        lateral: 'center',
                        vertical: 'bottom',
                      },
                    },
                    `Move Grid ${g.label}`,
                  )
                }}
                onLostPointerCapture={() => setDrag(null)}
              >
                <title>{`Drag Grid ${g.label} sideways to relocate`}</title>
              </line>

              {/* Grid end bubbles: drag along grid axis to stretch/shrink bubble extent (aligned parallel grids move together; hold Alt for single grid) */}
              {(['grid-start', ...(g.hasBubbleB ? (['grid-end'] as const) : [])] as const).map((endKind) => {
                const cx = endKind === 'grid-start' ? bAx : bBx
                const cy = endKind === 'grid-start' ? bAy : bBy
                return (
                  <circle
                    key={endKind}
                    cx={cx}
                    cy={cy}
                    r={g.radius + 0.6}
                    data-testid={`grid-bubble-${g.label}-${endKind}`}
                    className="cursor-grab active:cursor-grabbing transition-colors"
                    fill={isActive ? PRIMARY : 'transparent'}
                    fillOpacity={isActive ? 0.14 : 0}
                    stroke={isActive ? PRIMARY : 'transparent'}
                    strokeWidth={0.75}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      const pt = paperOf(e)
                      if (!pt) return
                      e.currentTarget.setPointerCapture(e.pointerId)
                      setDrag({ kind: endKind, id: g.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: g.frame, view: g.view })
                    }}
                    onPointerMove={(e) => {
                      if (!drag || drag.kind !== endKind || drag.id !== g.id || e.pointerId !== drag.pointerId) return
                      const pt = paperOf(e)
                      if (!pt) return
                      setDrag({ ...drag, curPaper: pt, moved: true, altKey: e.altKey })
                    }}
                    onPointerUp={(e) => {
                      if (!drag || drag.kind !== endKind || drag.id !== g.id || e.pointerId !== drag.pointerId) return
                      e.stopPropagation()
                      const wasMoved = drag.moved
                      const singleOnly = e.altKey || drag.altKey
                      const deltaA = (drag.curPaper.x - drag.originPaper.x) * pax + (drag.curPaper.y - drag.originPaper.y) * pay
                      setDrag(null)
                      if (!wasMoved || Math.abs(deltaA) < 0.5) return
                      const m0 = paperToModel(g.frame, drag.originPaper)
                      const m1 = paperToModel(g.frame, { x: drag.originPaper.x + pax * deltaA, y: drag.originPaper.y + pay * deltaA })
                      const gdx = g.end.x - g.start.x
                      const gdy = g.end.y - g.start.y
                      const glen = Math.hypot(gdx, gdy) || 1
                      const ux = gdx / glen
                      const uy = gdy / glen
                      const deltaM = Math.round((m1.x - m0.x) * ux + (m1.y - m0.y) * uy)
                      if (Math.abs(deltaM) < 20) return
                      const refPt = endKind === 'grid-start' ? g.start : g.end
                      const refAlong = refPt.x * ux + refPt.y * uy
                      // Revit 3D aligned grid lock: extend all parallel grids sharing this aligned endpoint together (hold Alt to unlock just this grid).
                      const peers = singleOnly
                        ? [g]
                        : grids.filter((o) => {
                            if (o.view.id !== g.view.id) return false
                            const odx = o.end.x - o.start.x
                            const ody = o.end.y - o.start.y
                            const olen = Math.hypot(odx, ody) || 1
                            const dot = (odx / olen) * ux + (ody / olen) * uy
                            if (Math.abs(dot) < 0.995) return false
                            const oPt = endKind === 'grid-start' ? (dot > 0 ? o.start : o.end) : dot > 0 ? o.end : o.start
                            return Math.abs(oPt.x * ux + oPt.y * uy - refAlong) <= 60
                          })
                      const steps = peers
                        .map((o) => {
                          const odx = o.end.x - o.start.x
                          const ody = o.end.y - o.start.y
                          const olen = Math.hypot(odx, ody) || 1
                          const dot = (odx / olen) * ux + (ody / olen) * uy
                          const moveStart = endKind === 'grid-start' ? dot > 0 : dot < 0
                          const nextStart = moveStart ? { x: Math.round(o.start.x + ux * deltaM), y: Math.round(o.start.y + uy * deltaM) } : o.start
                          const nextEnd = !moveStart ? { x: Math.round(o.end.x + ux * deltaM), y: Math.round(o.end.y + uy * deltaM) } : o.end
                          if (Math.hypot(nextEnd.x - nextStart.x, nextEnd.y - nextStart.y) < 300) return null
                          return {
                            type: 'set_element_placement' as const,
                            elementId: o.id,
                            placement: { kind: 'line' as const, levelId: o.levelId, start: nextStart, end: nextEnd, startOffsetMm: 0, endOffsetMm: 0, lateral: 'center' as const, vertical: 'bottom' as const },
                          }
                        })
                        .filter((step): step is NonNullable<typeof step> => step !== null)
                      if (steps.length === 1) submit(steps[0]!, `Adjust Grid ${g.label}`)
                      else if (steps.length > 1) submit({ type: 'batch_edits', label: `Adjust aligned grids (${g.label})`, commands: steps }, `Adjust aligned grids`)
                    }}
                    onLostPointerCapture={() => setDrag(null)}
                  >
                    <title>{`Drag Grid ${g.label} bubble along grid to extend/shorten (moves aligned grids; hold Alt for single grid)`}</title>
                  </circle>
                )
              })}
            </g>
          )
        })}

      {/* Draggable Revit level datum left/right margin grips on section & elevation views */}
      {canEdit &&
        levelViews.map((lv) => (
          <g key={`lvl:${lv.view.id}`}>
            {(['level-left', 'level-right'] as const).map((side) => {
              const key = `lvl:${lv.view.id}:${side}`
              const activeDrag = drag?.kind === side && drag.id === lv.view.id
              const isActive = hovered === key || activeDrag
              const baseX = side === 'level-left' ? lv.leftX : lv.rightX
              const x = activeDrag ? baseX + (drag.curPaper.x - drag.originPaper.x) : baseX
              return (
                <g key={side} onPointerEnter={() => setHovered(key)} onPointerLeave={() => setHovered((cur) => (cur === key ? null : cur))}>
                  {isActive && (
                    <line
                      x1={x}
                      y1={lv.topY}
                      x2={x}
                      y2={lv.botY}
                      stroke={PRIMARY}
                      strokeWidth={0.55}
                      strokeDasharray="2.5 1.5"
                      className="pointer-events-none"
                    />
                  )}
                  {/* Wide vertical hit strip along the entire level margin so you can grab ANY level head on the left or right */}
                  <rect
                    x={x - 3.5}
                    y={lv.topY}
                    width={7}
                    height={Math.max(10, lv.botY - lv.topY)}
                    fill="transparent"
                    className="cursor-ew-resize"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      const pt = paperOf(e)
                      if (!pt) return
                      e.currentTarget.setPointerCapture(e.pointerId)
                      setDrag({ kind: side, id: lv.view.id, pointerId: e.pointerId, originPaper: pt, curPaper: pt, moved: false, altKey: e.altKey, frame: lv.frame, view: lv.view })
                    }}
                    onPointerMove={(e) => {
                      if (!drag || drag.kind !== side || drag.id !== lv.view.id || e.pointerId !== drag.pointerId) return
                      const pt = paperOf(e)
                      if (!pt) return
                      setDrag({ ...drag, curPaper: pt, moved: true })
                    }}
                    onPointerUp={(e) => {
                      if (!drag || drag.kind !== side || drag.id !== lv.view.id || e.pointerId !== drag.pointerId) return
                      e.stopPropagation()
                      const deltaX = drag.curPaper.x - drag.originPaper.x
                      const wasMoved = drag.moved && Math.abs(deltaX) > 0.5
                      setDrag(null)
                      if (!wasMoved) return
                      if (side === 'level-left') {
                        const next = Math.max(-20, Math.min(100, Math.round((lv.view.props?.levelLeftExtMm ?? 0) - deltaX)))
                        submit({ type: 'set_view_crop', viewId: lv.view.id, levelLeftExtMm: next }, 'Extend level lines left')
                      } else {
                        const next = Math.max(-20, Math.min(100, Math.round((lv.view.props?.levelRightExtMm ?? -24) + deltaX)))
                        submit({ type: 'set_view_crop', viewId: lv.view.id, levelRightExtMm: next }, 'Extend level lines right')
                      }
                    }}
                    onLostPointerCapture={() => setDrag(null)}
                  >
                    <title>{side === 'level-left' ? 'Drag horizontally to extend level lines past left crop' : 'Drag horizontally to extend level datum heads past right crop'}</title>
                  </rect>
                  {isActive && <circle cx={x} cy={lv.midY} r={2.2} fill="#ffffff" stroke={PRIMARY} strokeWidth={0.75} className="pointer-events-none" />}
                </g>
              )
            })}
          </g>
        ))}
    </g>
  )
}
