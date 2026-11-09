'use client'

/**
 * Browser session for the Building Model surface: the 3D viewer, the linked
 * references, and the live sync client to the model authority. Framework-free
 * so the React surface stays a thin shell; created only after the surface's
 * chunk loads (three.js and That Open never reach first load).
 */
import { FLEX_DOMAIN, ROUTING_PLUS_EVERY_RUN_FEATURE, branchClosedMessage, elementEntries, elementsOfKind, hostName, isPitchedOrLevel, type BranchRef, type PartHost } from '@permitzip/bim-kernel'
import type { Actor, BimElement, Command, CommandRequest, Connection, DisplayContext, DuctInsulation, ElementId, FittingChoice, FittingSlot, IntakeChoice, Level, ModelState, ParamDef, ParamValue, PartInstance, PartMount, PartTypeDefinition, PartTypeElement, RouteEndpoint, RouteJoin, RunFitting, RunPoint, RunSegment, RunSize, SelectionScopeKind, SystemKind, Vec2, WorkFrame, ReferenceSnapCandidates } from '@permitzip/bim-kernel'
import type { DesignLimitSources } from '@permitzip/bim-kernel/policy'
import type { CommitOutcome, ConnectionStatus, Presence, SaveState, ScheduleClientPort, ServerMessage, SyncClient } from '@permitzip/bim-sync'
import type { CategoryView, LoadedReference, ModelViewer3D, Pick, ReferenceItemProperties, ViewerColors, ViewerStats } from '@permitzip/bim-viewer-3d'
import type { EditorHostCapabilities, EditorReferencesPort } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import type { RevitElementParameters, RevitParametersResponse, UnplacedElementsResponse, UnplacedElementView } from '../contracts/building-model/revit-parameters-contract'
import { connectionProblem, editsPausedMessage, operatorMessage, problemForDenied, type ConnectionProblem } from './operator-messages'
import { ALIGN_SNAP_MM, GRID_MM, MM_PER_FT, MM_PER_IN, POINT_SNAP_MM, defaultHeightMm, describeElement, feetInches, newElementId, partLabel, snapHint, snapPoint, snapTargets, type SnapTarget } from './placement'
import { linkedSnapNear } from './linked-reference/linked-reference-store'
import { isStarterLevelRace, starterLevelCommand } from './levels/starter-level'
import { axisBadge, resolveRoutePoint, snapDrag, type AxisLock, type RouteAxis } from './route-axis'
import { hostForPlacement, placementOnSurface, routeStartOnSurface, type RouteStart } from './surface-point'
import { LOW_VIEW_DEG, grabFor, grabHint, type RunGrab } from './run-grab'
import { resizeRequestFor } from './resize-scope'
import { faceHandleSides, isDrainService, plusSpots, slopedSideHandles, tapOffsetFor, type BranchFace } from './plus-tee'
import type { FaceHandle } from './PlusHandles'
import { riseHint, type RiseStyle } from './route-rise'
import { currentScope, cycle, hoverTo, scopeWord, tabHint, type PreHighlight } from './tab-select'

/** How long "Connecting…" may show before the person is told why it isn't connecting. */
export const CONNECT_TIMEOUT_MS = 10_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 8000
/** The server answers every heartbeat (10 s); this long with nothing heard means the line is dead even if the socket never closed (laptop sleep, Wi-Fi change). */
export const STALE_CONNECTION_MS = 25_000
const LIVENESS_CHECK_MS = 5000
/** On the canvas while the pointer is over what a click handler would take. */
export const CLICK_TAKEN_CLASS = 'cursor-pointer'

export interface ReferenceInfo {
  readonly id: string
  readonly label: string
  readonly discipline: 'architecture' | 'mep'
  readonly bytes: number
  readonly url: string
  readonly ifcPlacement: number[][] | null
  /** fixture = the project's test export (read-only here); linked = linked through the panel. */
  readonly source?: 'fixture' | 'linked'
  /** Key for this reference's Revit parameters; absent when it has none to offer. */
  readonly parametersSource?: string
}

export interface SessionConfig {
  readonly references: readonly ReferenceInfo[]
  readonly authority: { readonly url: string; readonly modelId: string } | null
  /** The element parameters route; `<url>/unplaced` lists elements the IFC left out. */
  readonly revitParametersUrl?: string
}

/** What the Properties panel knows about the selected element's Revit parameters. */
export type RevitState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly parameters: RevitElementParameters }
  | { readonly status: 'unavailable'; readonly message: string }
  | { readonly status: 'error'; readonly message: string }

/** Per reference: the elements drawn as symbols because the IFC has no shape for them. */
export type UnplacedState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly count: number }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string }

const REVIT_LOAD_FAILED = "Revit's parameters for this element couldn't be loaded. Select it again; if it keeps happening, reload the page."
const UNPLACED_LOAD_FAILED = "The symbols for devices without a 3D shape couldn't be loaded. Reload the page to try again."
const NO_GLOBAL_ID = "This element has no IFC GlobalId, so its Revit parameters can't be matched to it."

export interface SessionEvents {
  onPhase(phase: string): void
  onReferenceLoaded(info: LoadedReference & { readonly bytes: number }): void
  onReferenceRemoved(id: string): void
  /**
   * The model changed. `changedIds`: elements added, changed or removed in `view` since the
   * previous call's `view` (a connection made or cut counts for both its ends). Null when that
   * can't be said without comparing everything (the first model, a reload, a drag preview, an
   * edit sent around this session): treat every element as changed. A listener may ignore it.
   */
  onModel(accepted: ModelState, view: ModelState, changedIds: readonly ElementId[] | null): void
  onStatus(status: ConnectionStatus): void
  onSaveState(state: SaveState): void
  onPresence(people: ReadonlyMap<string, Presence>): void
  onActivity(message: string): void
  /** Why live editing isn't connected (null once it is, or while it's still trying inside the timeout). */
  onProblem(problem: ConnectionProblem | null): void
  onSelection(selection: Selection | null): void
  onStats(stats: ViewerStats): void
  /** A reference's unplaced-device symbols started loading, loaded, or failed. */
  onUnplaced?(referenceId: string, state: UnplacedState): void
  /** Undo / redo availability changed. */
  onUndoState?(state: UndoState): void
  /** An edit the person made here was saved (not an undo or redo, not a views/sheets edit), with the model as it now stands: auto-sizing follows it. */
  onSaved?(command: Command, model: ModelState): void
  /** An edit was refused or not saved: the model's own plain reason. */
  onRefused?(message: string): void
  /** The branch this page is on was closed or merged (here or on another machine); the page stays open and edits are refused. */
  onBranchState?(branch: BranchRef): void
  /** The places the route being drawn meets an add-on's rule (a rated wall, a ceiling), in the add-on's words; empty when none or not routing. */
  onRouteChecks?(checks: readonly RouteCheck[]): void
}

/** One place the route being drawn meets a rule: the Route tool's line for it and where its tick goes on plan. */
export interface RouteCheck {
  readonly key: string
  readonly message: string
  /** Plan point (mm) on the piece the tick sits across. */
  readonly at: Vec2
  readonly segmentId: ElementId
}

/** Why a branch switch waits: edits still saving would be lost with the line they were sent on. */
export function switchWaitsWords(pending: number): string {
  return `Wait for your ${pending === 1 ? 'edit' : `${pending} edits`} to save before switching branch. The 3D view stays as it is.`
}

/**
 * Element ids whose record differs between two models by id and version (added, changed or
 * removed): what a branch switch must redraw. One pass over both models, once per switch.
 */
export function idsChangedBySwitch(before: { readonly elements: ModelState['elements'] }, after: { readonly elements: ModelState['elements'] }): ElementId[] {
  const out: ElementId[] = []
  for (const [id, el] of elementEntries(after.elements)) {
    const prev = before.elements[id]
    if (!prev || prev.version !== el.version || prev.kind !== el.kind) out.push(el.id)
  }
  for (const [id, el] of elementEntries(before.elements)) if (after.elements[id] === undefined) out.push(el.id)
  return out
}

export type Selection =
  | { readonly kind: 'authored'; readonly element: BimElement }
  /** A run, branch or system chosen with Tab, or a box selection. */
  | { readonly kind: 'group'; readonly scope: SelectionScopeKind | 'box'; readonly ids: readonly string[]; readonly anchorId: string | null }
  | {
      readonly kind: 'reference'
      readonly referenceLabel: string
      /** What the IFC file says (null for a device the IFC left out, or when it couldn't be read). */
      readonly properties: ReferenceItemProperties | null
      /** Plain-language reason when the properties could not be read. */
      readonly problem: string | null
      /** Revit's own parameters; null when this reference has no Revit data to offer. */
      readonly revit: RevitState | null
      /** The element isn't in the IFC; the symbol is at Revit's location. */
      readonly unplaced: UnplacedElementView | null
    }

/** What the person can undo / redo right now, in words. */
export interface UndoState {
  readonly undo: string | null
  readonly redo: string | null
}

/** A part type armed for placement, with the choices made in the parts panel. */
export interface PlacementSpec {
  readonly typeId: string
  readonly definition: PartTypeDefinition
  /** False for a library type: its definition goes with the first placement. */
  readonly inModel: boolean
  readonly levelId: string
  readonly heightMm: number
  readonly rotationDeg: number
}

/** One device of a proposal, shown as a ghost until the person accepts it. */
export interface ProposalGhost {
  readonly typeId: string
  readonly definition: PartTypeDefinition
  readonly levelId: string
  readonly position: Vec2
  readonly offsetMm: number
  readonly rotationDeg: number
}

/**
 * Something that takes a plan or 3D click before selection does (a proposal
 * preview accepting the room under the pointer). One at a time.
 */
export interface ClickHandler {
  /** Whether a click on these hovered ids would be taken (the cursor shows it's clickable). Asked with no ids over empty space: a drawing tool claims it, a room proposal doesn't. */
  readonly claims: (hoveredIds: readonly string[]) => boolean
  /** Take the click; true means handled, so the selection doesn't change. */
  readonly click: (hoveredIds: readonly string[]) => boolean
}

/** One placeable type for the parts panel. */
export interface CatalogEntry {
  readonly typeId: string
  readonly definition: PartTypeDefinition
  readonly inModel: boolean
  readonly categoryLabel: string
  /** Where a type not yet in the model comes from (absent: the starter library). */
  readonly library?: 'firm'
}

export type DeletePlan =
  | { readonly kind: 'clear' }
  | { readonly kind: 'dependents'; readonly dependents: readonly { readonly id: string; readonly label: string }[]; readonly connections: number; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string }

interface UndoEntry {
  readonly revision: number
  readonly label: string
  readonly seq: number
}

/** Plain words for an edit, used on the undo / redo buttons. */
export function describeCommand(view: ModelState | null, command: Command): string {
  const name = (id: string) => {
    const el = view?.elements[id]
    return el ? describeElement(view, el) : 'element'
  }
  const many = (ids: readonly string[]) => (ids.length === 1 && ids[0] ? name(ids[0]) : `${ids.length} items`)
  switch (command.type) {
    case 'place_part':
      return `place ${command.partType?.typeName ?? name(command.typeId)}`
    case 'move_elements':
      return `move ${many(command.ids)}`
    case 'rotate_elements':
      return `rotate ${many(command.ids)}`
    case 'copy_elements':
      return `copy ${many(command.ids)}`
    case 'delete_elements':
      return `delete ${many(command.ids)}`
    case 'set_parameters':
      return command.scope === 'type' ? `type change on ${name(command.id)}` : `change to ${name(command.id)}`
    case 'create_level':
      return `add level ${command.name}`
    case 'update_level':
      return command.name !== undefined && command.elevationMm === undefined ? `rename level to ${command.name}` : `level change`
    case 'sync_levels':
      return `levels from the linked model (${command.storeys.length})`
    case 'set_level_linked_storey':
      return command.storeyName === null ? 'linked level choice cleared' : `linked level set to ${command.storeyName}`
    case 'ensure_starter_level':
      return 'starter Level 1'
    case 'undo':
      return 'undo'
    case 'slide_branch':
      return 'branch slide'
    case 'resize_run':
      return 'resize'
    case 'route_run':
      return `${command.domain} route`
    case 'connect_runs':
      return 'connect'
    case 'join_parts':
      return 'join end to end'
    case 'disconnect_run':
      return 'disconnect'
    case 'split_run':
      return 'split'
    case 'resize_stretch':
      return command.segmentIds.length === 1 ? 'resize' : `resize ${command.segmentIds.length} pieces`
    case 'drag_run':
      return `drag ${name(command.elementId)}`
    case 'batch_edits':
      return command.label ? command.label.charAt(0).toLowerCase() + command.label.slice(1) : `${command.commands.length} edits`
    default:
      return 'edit'
  }
}

/** One views/sheets edit you can undo: each touched element as it was before and as your edit left it. */
interface DocumentUndo {
  readonly label: string
  readonly seq: number
  readonly before: Record<string, BimElement | null>
  readonly after: Record<string, BimElement>
}

export interface SlideDrag {
  readonly tapId: string
  readonly elevationMm: number
}

/** What the Route tool draws: duct or pipe, its size, height, level and system (an existing one, or a new one of this kind). */
export interface RouteSpec {
  readonly domain: 'duct' | 'pipe'
  readonly levelId: string
  readonly elevationMm: number
  readonly size: RunSize
  readonly system: { readonly id: string; readonly kind: SystemKind; readonly name?: string }
  /** How a height change mid-run is made: straight up or down, or a slope at 60°, 45° or 22½°. */
  readonly riseStyle: RiseStyle
  /** Fittings this route places over the system's defaults (the elbow and takeoff chosen while drawing). */
  readonly fittings?: Partial<Record<FittingSlot, FittingChoice>>
  /** Duct wrap or liner for this route; null for bare duct; absent: the system's default. */
  readonly insulation?: DuctInsulation | null
  /** Drains: inches of fall per foot; absent: the system's rule for the size. */
  readonly slopeInPerFt?: number
  /** Drains: which way the water runs; absent: into the trunk for a branch, else the way it is drawn. */
  readonly flow?: 'with_points' | 'against_points'
  /** Ending on a part's connector: the stretch from the last point into it is flex (where the run kind has flex). */
  readonly lastStretchFlex?: boolean
}

/** What Inherit read off the piece clicked: the height there (above its level's floor), and its size, system and slope when it has them. */
export interface InheritPick {
  readonly label: string
  readonly levelId: string
  readonly elevationMm: number
  readonly element: RunSegment | RunFitting | null
  /** Inches per foot on a sloped straight piece. */
  readonly slopeInPerFt?: number
}

/** A drawing's pick on the side of a straight run, for a tap: the piece and the model point under the pointer (mm above project zero). */
export interface DrawingRouteSide {
  readonly segmentId: string
  readonly at: RunPoint
}

/** Categories a box selection can keep. */
export type BoxCategory = 'duct' | 'pipe' | 'parts'

/** Something the pointer can start or finish a route on. */
interface RouteTarget {
  readonly endpoint: RouteEndpoint
  /** Plan point the route meets it at (a trunk branch: the point on its centreline). */
  readonly point: Vec2
  readonly label: string
  /** The system of a run it starts or ends on (the route continues it). */
  readonly systemId: string | null
  /** The face shown while hovering: the open end, or where on the trunk's side the tap goes. */
  readonly join?: RouteJoin
  /** Height above the level a route started here takes (the trunk's centreline, the open end's): absent when it has none to give (a connector facing up or down). */
  readonly elevationMm?: number
}

/** How close (plan mm) the pointer must be to an open run end to connect to it rather than branch off the run. */
const RUN_END_SNAP_MM = 450
/** An open run end this close on screen (px) is picked even when the pointer is just off the duct. */
const RUN_END_PICK_PX = 18
/** How far from an air device's neck the Flex command looks for an open duct end. */
const FLEX_REACH_MM = 12 * MM_PER_FT

export { angleLock } from './route-axis'

/**
 * The one move command for a selection, whichever surface asked (the 3D view's
 * Move form, a drag in a plan, section or sheet viewport): the movable pieces,
 * the plan move and the rise. A string is the reason nothing can move.
 */
export function moveCommandFor(view: { readonly elements: ModelState['elements'] }, ids: readonly string[], delta: Vec2, dzMm = 0): Extract<Command, { type: 'move_elements' }> | string {
  const movable = ids.filter((id) => {
    const k = view.elements[id]?.kind
    return k === 'part' || k === 'run_segment' || k === 'run_fitting' || k === 'equipment' || k === 'wall' || k === 'component'
  })
  if (movable.length === 0) return 'Nothing in this selection moves on its own; legacy duct moves with its unit.'
  if (movable.length > 500) return `That is ${movable.length} pieces; move at most 500 at once. Select a branch or a smaller box.`
  return { type: 'move_elements', ids: movable, delta: { x: delta.x, y: delta.y }, ...(dzMm !== 0 ? { dzMm } : {}) }
}

/** A dragged group in words: "the whole run (6 pieces)", or "the AHU-1" when it is one part. */
function groupWords(group: { readonly ids: readonly string[]; readonly word: string }): string {
  return group.ids.length > 1 ? `the whole ${group.word} (${group.ids.length} pieces)` : `the ${group.word}`
}

/** Where along a straight piece a split goes: on the 3" grid, never at an end. */
function splitAlong(seg: RunSegment, s: number): { seg: RunSegment; s: number } {
  const len = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y, seg.end.z - seg.start.z)
  const snapped = Math.round(s / (GRID_MM / 2)) * (GRID_MM / 2)
  return { seg, s: Math.min(len - 1, Math.max(1, snapped)) }
}

/** Does the box filter keep this element? (The 3D view and drawings share it.) */
function boxAccepts(el: BimElement | undefined, categories: ReadonlySet<BoxCategory>): boolean {
  if (!el) return false
  if (el.kind === 'part') return categories.has('parts')
  if (el.kind === 'run_segment' || el.kind === 'run_fitting') return categories.has(el.domain === 'pipe' ? 'pipe' : 'duct')
  if (el.kind === 'duct_segment' || el.kind === 'tap' || el.kind === 'elbow') return categories.has(el.service && el.service !== 'air' ? 'pipe' : 'duct')
  if (el.kind === 'terminal' || el.kind === 'equipment') return categories.has('parts')
  return false
}

function errorText(body: unknown): string {
  return typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : 'no message'
}

function isParametersResponse(body: unknown): body is RevitParametersResponse {
  if (typeof body !== 'object' || body === null || !('available' in body)) return false
  if (body.available === true) return 'parameters' in body && typeof body.parameters === 'object' && body.parameters !== null && 'groups' in body.parameters && Array.isArray(body.parameters.groups)
  return body.available === false && 'message' in body && typeof body.message === 'string'
}

function isUnplacedResponse(body: unknown): body is UnplacedElementsResponse {
  if (typeof body !== 'object' || body === null || !('available' in body)) return false
  if (body.available === true) return 'elements' in body && Array.isArray(body.elements)
  return body.available === false
}

type ViewerModule = typeof import('@permitzip/bim-viewer-3d')
type KernelModule = typeof import('@permitzip/bim-kernel')
const loadPowerPack = () => import('@permitzip/bim-pack-electrical')
type PowerPackModule = Awaited<ReturnType<typeof loadPowerPack>>
const loadAirPack = () => import('../contracts/building-model/air-pressure')
type AirPackModule = Awaited<ReturnType<typeof loadAirPack>>
const loadRatedRoutes = () => import('@permitzip/bim-kernel/rated-routes')
type RatedRoutesModule = Awaited<ReturnType<typeof loadRatedRoutes>>

/** View/sheet edits and live blocks undo on the document stack, not the model stack. */
function isDocumentCommand(kernel: KernelModule, command: Command): boolean {
  return kernel.isViewCommand(command) || kernel.isBlockCommand(command)
}
type SyncModule = typeof import('@permitzip/bim-sync')

/** Route on a drawing in a model with no level: the cause and the fix, as the 3D notice says it. */
export const ROUTE_NEEDS_LEVEL = "Add a level first: routes sit on a level, and this model has none yet. Use Add a level (or the architect's levels) in the notice below."

/** What a client edit the model server couldn't read becomes: refused, in words a person can act on. */
export const EDIT_NOT_UNDERSTOOD = "This change wasn't saved: the model server is older than this page and is being updated. Reload the page in a minute; if it keeps happening, tell the software team."
/** On a laptop the stale model server is the shared dev stack's, and only a restart loads the new engine. */
export const EDIT_NOT_UNDERSTOOD_LOCAL = "The model server needs a restart: it is older than this page, so this change wasn't saved. Run npm run dev:stack -- restart, then try again."

/** The refusal for an edit an older model server couldn't read, worded for where the page runs. */
export function editNotUnderstoodMessage(hostname: string): string {
  const host = hostname.toLowerCase()
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  return local ? EDIT_NOT_UNDERSTOOD_LOCAL : EDIT_NOT_UNDERSTOOD
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The request key of an outgoing command message; null for anything else. Server and client write `type` first. */
function sentCommandKey(data: string): string | null {
  if (!data.startsWith('{"type":"command"')) return null
  try {
    const msg: unknown = JSON.parse(data)
    const request = isRecord(msg) ? msg.request : null
    return isRecord(request) && typeof request.idempotencyKey === 'string' ? request.idempotencyKey : null
  } catch (err) {
    console.error('[building-model] an outgoing edit could not be read back', err)
    return null
  }
}

/** Messages the server always answers (welcome, head, outcome). Presence and reports get no reply, so they can't prove a dead line. */
function expectsAnswer(data: string): boolean {
  return data.startsWith('{"type":"heartbeat"') || data.startsWith('{"type":"hello"') || data.startsWith('{"type":"command"')
}

/** The request key an `outcome` / `unsaved` answer settles; null for other messages. */
function answeredKey(raw: string): string | null {
  if (!raw.startsWith('{"type":"outcome"') && !raw.startsWith('{"type":"unsaved"')) return null
  try {
    const msg: unknown = JSON.parse(raw)
    return isRecord(msg) && typeof msg.idempotencyKey === 'string' ? msg.idempotencyKey : null
  } catch (err) {
    console.error('[building-model] an answer from the model server could not be read', err)
    return null
  }
}

/** The text of a server `error` message ("Message not understood"); null for other messages. */
function serverErrorText(raw: string): string | null {
  if (!raw.startsWith('{"type":"error"')) return null
  try {
    const msg: unknown = JSON.parse(raw)
    return isRecord(msg) && typeof msg.message === 'string' ? msg.message : ''
  } catch (err) {
    console.error('[building-model] an error from the model server could not be read', err)
    return ''
  }
}

type TouchedRecord = {
  readonly removedIds?: readonly ElementId[]
  readonly removedConnections?: readonly Connection[]
  readonly addedConnections?: readonly Connection[]
}

/** Every element an edit (a prediction's result or a saved changeset) wrote, removed, or connected or disconnected. */
function touchedIds(written: readonly ElementId[], change: TouchedRecord): ElementId[] {
  const out = [...written, ...(change.removedIds ?? [])]
  for (const c of [...(change.removedConnections ?? []), ...(change.addedConnections ?? [])]) out.push(c.a.elementId, c.b.elementId)
  return out
}

export class ModelSession {
  viewer: ModelViewer3D | null = null
  private client: SyncClient | null = null
  private socket: WebSocket | null = null
  private accepted: ModelState | null = null
  private view: ModelState | null = null
  private preview: ModelState | null = null
  private readonly people = new Map<string, Presence>()
  private disposed = false
  private kernel: KernelModule | null = null
  /** The add-on that says which parts a power pick can land on; loaded with the kernel. */
  private powerPack: PowerPackModule | null = null
  private airPack: AirPackModule | null = null
  /** Route checks along a drawn route (rated crossings, clearances) and the parts Finish places for them. */
  private ratedRoutes: RatedRoutesModule | null = null
  private routeChecks: readonly RouteCheck[] = []
  /** The firm's and the project's design limits; the add-ons' defaults until the surface hands them over. */
  private designLimits: DesignLimitSources = {}
  private viewerModule: ViewerModule | null = null
  /** Parts that carry power with their scene points, for picking small symbols by screen distance (partIdAt). */
  private powerParts: { readonly view: ModelState; readonly list: readonly { readonly id: string; readonly at: ReturnType<ViewerModule['kernelToScene']> }[] } | null = null
  private reconnectMs = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private authority: { readonly url: string; readonly modelId: string } | null = null
  private status: ConnectionStatus = 'connecting'
  /**
   * When the oldest question still waiting for any answer went out on the current socket (Date.now ms),
   * null once the server has said anything since. Judged from what we asked, not from wall-clock quiet:
   * a hidden tab runs our timers once a minute, so the heartbeat itself only goes out once a minute.
   */
  private askedSince: number | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  /** The browser says this computer has no network; the line is down whatever the socket says. */
  private deviceOffline = false
  private unbindNetworkEvents: (() => void) | null = null
  /** Set when the server refused: retrying won't change its answer until the person asks. */
  private halted = false
  private attempts = 0
  private framedWork = false
  private selectedId: ElementId | null = null
  private referencesReady = false
  private referenceLabels = new Map<string, string>()
  private referenceInfo = new Map<string, ReferenceInfo>()
  private unplaced = new Map<string, Map<string, UnplacedElementView>>()
  private revitParametersUrl: string | null = null
  /** Your views/sheets edits, undone client-side by restoring the records (no redo). */
  private readonly documentUndoStack: DocumentUndo[] = []
  /** Orders both undo stacks, so Undo takes back whichever of your edits is newest. */
  private undoSeq = 0
  /** Bumped on every selection, so a slow answer for an earlier pick never overwrites the current one. */
  private selectionToken = 0
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  /** Undo / redo requests in flight, by request key. */
  private readonly undoing = new Map<string, { readonly direction: 'undo' | 'redo'; readonly label: string }>()
  private placement: PlacementSpec | null = null
  private moving: { readonly ids: readonly string[]; readonly levelId: string; readonly from: Vec2; readonly elevationMm: number; delta: Vec2 | null } | null = null
  private targets: { readonly view: ModelState; readonly levelId: string; readonly exclude: string; readonly list: SnapTarget[] } | null = null
  /** Last point the pointer hit on a linked model, with the pointer position it was asked for. */
  private referenceHit: { readonly x: number; readonly y: number; readonly point: Vec2 } | null = null
  private referencePickBusy = false
  private measureFrom: Vec2 | null = null
  private routeSpec: RouteSpec | null = null
  /** The route being drawn: where it started and the points clicked since. */
  /** The route being drawn. `startElevationMm` (above the level): the height of the trunk, open end or surface it started on, else the typed height. */
  private routing: { from: RouteTarget | null; points: Array<Vec2 & { elevationMm?: number }>; startElevationMm?: number } | null = null
  /** The Route panel's Height as last armed (above the level), so only a change to it rises or drops the route. */
  private routePanelElevationMm: number | null = null
  private axisLock: AxisLock = 'auto'
  /** The work frame route and placement snaps follow (`work-frame.ts`); null: the model's axes. */
  private workFrame: WorkFrame | null = null
  private lastAxis: RouteAxis = 'free'
  private shiftHeld = false
  private planeLocked = false
  private preHighlight: PreHighlight | null = null
  /** Who wants to know what the pointer is over (a proposer previewing the room under it). */
  private readonly hoverListeners = new Set<(ids: readonly string[] | null) => void>()
  private clickHandler: ClickHandler | null = null
  private groupIds: readonly string[] | null = null
  private runDrag: {
    readonly id: string
    readonly kind: 'segment' | 'corner' | 'end'
    readonly grip: 'start' | 'end' | undefined
    readonly axis: RunPoint | null
    readonly from: Vec2
    /** Where the press was on screen; null for a drag started on a drawing. */
    readonly fromClient: Vec2 | null
    readonly plane: number
    /** From a low view: where the press met the upright plane facing the camera (z above project zero); the drag follows that plane. Null from above. */
    readonly facing: RunPoint | null
    delta: { x: number; y: number; z: number } | null
    reroute: boolean
    /** An open end dragged onto another run's side: that run (release taps into it). */
    connectTo: string | null
    readonly label: string
    /** A run, branch or other group widened with Tab (or selected): it moves rigidly with `move_elements`. */
    readonly group: { readonly ids: readonly string[]; readonly word: string } | null
  } | null = null
  /** An arrow-key nudge burst not saved yet: the selection, the total move, the command that saves it, and when it saves. */
  private nudge: { readonly ids: readonly string[]; readonly delta: RunPoint; readonly command: Command; readonly timer: ReturnType<typeof setTimeout> } | null = null
  /** The "Tab selects the whole run" tip shows the first few times a run piece comes under the pointer. */
  private tabTipHovers = 0
  private tabTipFor: string | null = null
  /** The run handle under the pointer while hovering (middle, end or elbow); null when none. */
  private hoverGrab: { readonly grab: RunGrab; readonly levelId: string; readonly label: string } | null = null
  /** The pointer's last spot while routing (the offset-around tool reads the leg being drawn). */
  private routePointer: { x: number; y: number } | null = null
  private pressureEngine: InstanceType<AirPackModule['PressureEngine']> | null = null
  /** Theme colors for the 3D view; applied when the viewer starts and whenever the theme changes. */
  private viewerColors: Partial<ViewerColors> = {}
  private displayContext: DisplayContext | null = null
  private categoryView: CategoryView | null = null
  /**
   * Edits sent on the current socket and not answered yet, oldest first. The server reads one
   * message at a time per connection and answers each in order, so a key-less "not understood"
   * error belongs to the oldest of these.
   */
  private unanswered: string[] = []
  /** Edits refused because the server couldn't read them: settleOutcome says so in those words. */
  private readonly notUnderstood = new Set<string>()
  /** The part from "Not placed yet" the armed placement lands (`place_planned_part`); null for Place part. */
  private plannedPartId: ElementId | null = null
  /** What onModel last reported, so the next call can say which ids changed. */
  private emitted: { readonly confirmed: ModelState | null; readonly view: ModelState; readonly exact: boolean } | null = null
  /** The ids each of this session's unsaved edits changes in the prediction, by request key (null: not known). */
  private readonly predictedIds = new Map<string, readonly ElementId[] | null>()
  /** The ids of an edit being handed to the client right now (its view event fires before submit returns); undefined when none is. */
  private submittingIds: readonly ElementId[] | null | undefined = undefined
  /** Ids of predictions that ended (saved or refused) since the last onModel; null once one of them wasn't known. */
  private endedIds: ElementId[] | null = []
  /** The sync module, kept so a branch switch opens a new line without reloading anything. */
  private syncModule: SyncModule | null = null
  /** What was shown before a branch switch, until the new branch's model arrives (its first onModel names what differs). */
  private switchedFrom: ModelState | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly actor: Actor,
    private readonly events: SessionEvents,
    /** The person's current access token from the host (kept fresh by its sign-in), or null when signed out. */
    private readonly getToken: () => Promise<string | null>,
    /** The host's linked-model files and parameters; absent where the host serves none (the view then says so). */
    private readonly references?: EditorReferencesPort,
    /** Where the host says a missing service can be connected, for that plain message. */
    private readonly capabilities?: EditorHostCapabilities | null,
  ) {}

  /** Why linked models can't be shown here, in words a person can act on. */
  private referencesUnavailable(): string {
    return unavailableWords('Linked models', this.capabilities)
  }

  /** The theme's viewer colors (selection, edges, backgrounds, axes). Safe to call before the viewer exists. */
  setViewerColors(colors: Partial<ViewerColors>): void {
    this.viewerColors = colors
    this.viewer?.setColors(colors)
  }

  async open(config: SessionConfig): Promise<void> {
    this.events.onPhase('Starting the 3D view…')
    const [viewerModule, kernel, sync, powerPack, airPack, ratedRoutes]: [ViewerModule, KernelModule, SyncModule, PowerPackModule, AirPackModule, RatedRoutesModule] = await Promise.all([
      import('@permitzip/bim-viewer-3d'),
      import('@permitzip/bim-kernel'),
      import('@permitzip/bim-sync'),
      loadPowerPack(),
      loadAirPack(),
      loadRatedRoutes(),
    ])
    this.loadPartGeometry()
    if (this.disposed) return
    this.kernel = kernel
    this.powerPack = powerPack
    this.airPack = airPack
    this.ratedRoutes = ratedRoutes
    this.viewerModule = viewerModule
    this.syncModule = sync
    this.viewer = new viewerModule.ModelViewer3D(this.container, {
      workerUrl: '/api/building-model/fragments-worker',
      onStats: (stats) => this.events.onStats(stats),
      colors: this.viewerColors,
    })
    this.viewer.setDisplayContext(this.displayContext)
    this.viewer.setCategoryView(this.categoryView)
    if (process.env.NODE_ENV === 'development') Reflect.set(window, '__buildingModelSession', this)

    // Live editing connects alongside the reference downloads; a slow or failed reference never blocks it.
    // A branch switch asked for before the modules loaded opens that branch instead.
    const authority = this.authority ?? config.authority
    if (authority) this.connect(sync, authority)
    this.revitParametersUrl = config.revitParametersUrl ?? null

    await this.syncReferences(config.references)
    if (this.disposed) return

    this.referencesReady = true
    this.framedWork = this.view !== null
    await this.frameWork()
    this.events.onPhase('')
  }

  /**
   * Make the view show exactly these references: load the new ones, drop the
   * ones that are gone. A new version or placement arrives with a new id, so
   * switching versions is a remove plus an add. Live editing is untouched.
   */
  async syncReferences(references: readonly ReferenceInfo[]): Promise<void> {
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    if (!viewer || !viewerModule) return
    const wanted = new Set(references.map((r) => r.id))
    for (const id of [...this.referenceLabels.keys()]) {
      if (wanted.has(id)) continue
      await viewer.removeReference(id)
      this.referenceLabels.delete(id)
      this.referenceInfo.delete(id)
      this.unplaced.delete(id)
      this.events.onReferenceRemoved(id)
    }
    const toLoad = references.filter((r) => !viewer.hasReference(r.id))
    const port = this.references
    if (!port) {
      if (toLoad.length > 0) this.events.onActivity(this.referencesUnavailable())
      return
    }
    let index = 0
    for (const ref of toLoad) {
      index += 1
      this.events.onPhase(`Loading ${ref.discipline === 'architecture' ? "the architect's model" : 'existing MEP'} (${index} of ${toLoad.length})…`)
      const res = await port.bytes({ url: ref.url })
      if (!res.ok) throw new Error(`Couldn't load ${ref.label} (HTTP ${res.status})`)
      const bytes = await res.arrayBuffer()
      const byteLength = bytes.byteLength
      if (this.disposed) return
      const placement = ref.ifcPlacement && viewerModule.isMat4Rows(ref.ifcPlacement) ? ref.ifcPlacement : undefined
      const info = await viewer.addReference({ id: ref.id, label: ref.label, discipline: ref.discipline, bytes, ifcPlacement: placement })
      this.referenceLabels.set(ref.id, ref.label)
      this.referenceInfo.set(ref.id, ref)
      this.events.onReferenceLoaded({ ...info, bytes: byteLength })
      void this.loadUnplaced(ref)
    }
    if (toLoad.length > 0) this.events.onPhase('')
  }

  private parametersUrl(ref: ReferenceInfo, path: '' | '/unplaced', query: Record<string, string>): string | null {
    if (!this.revitParametersUrl || !ref.parametersSource) return null
    return `${this.revitParametersUrl}${path}?${new URLSearchParams({ source: ref.parametersSource, ...query }).toString()}`
  }

  /** Draw the devices this reference's IFC left out as symbols at Revit's locations. Never blocks the view. */
  private async loadUnplaced(ref: ReferenceInfo): Promise<void> {
    const url = this.parametersUrl(ref, '/unplaced', {})
    if (!url) return
    const port = this.references
    if (!port) {
      this.events.onUnplaced?.(ref.id, { status: 'unavailable' })
      return
    }
    this.events.onUnplaced?.(ref.id, { status: 'loading' })
    try {
      const res = await port.read({ url })
      const body: unknown = await res.json()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${errorText(body)}`)
      if (!isUnplacedResponse(body)) throw new Error('unexpected answer from the unplaced-devices route')
      if (this.disposed || !this.viewer || !this.referenceInfo.has(ref.id)) return
      if (!body.available) {
        this.events.onUnplaced?.(ref.id, { status: 'unavailable' })
        return
      }
      const viewerModule = this.viewerModule
      const placement = ref.ifcPlacement && viewerModule?.isMat4Rows(ref.ifcPlacement) ? ref.ifcPlacement : null
      const byId = new Map(body.elements.map((e) => [String(e.elementId), e]))
      this.unplaced.set(ref.id, byId)
      this.viewer.setMarkers(
        ref.id,
        body.elements.map((e) => ({
          id: String(e.elementId),
          position: viewerModule ? viewerModule.ifcFilePointToScene(placement, e.location) : [e.location[0], e.location[2], -e.location[1]],
          level: e.level,
        })),
      )
      this.events.onUnplaced?.(ref.id, { status: 'ready', count: body.elements.length })
    } catch (err) {
      console.error('[ModelSession] loading the unplaced devices failed', { referenceId: ref.id, err })
      this.events.onUnplaced?.(ref.id, { status: 'error', message: UNPLACED_LOAD_FAILED })
    }
  }

  /** Fetch one element's Revit parameters; the answer is emitted only if the selection hasn't moved on. */
  private async loadRevit(ref: ReferenceInfo, key: { globalId: string } | { elementId: number }, token: number, emit: (revit: RevitState) => void): Promise<void> {
    const url = this.parametersUrl(ref, '', 'globalId' in key ? { globalId: key.globalId } : { elementId: String(key.elementId) })
    if (!url) return
    const port = this.references
    if (!port) {
      if (token === this.selectionToken && !this.disposed) emit({ status: 'unavailable', message: this.referencesUnavailable() })
      return
    }
    let state: RevitState
    try {
      const res = await port.read({ url })
      const body: unknown = await res.json()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${errorText(body)}`)
      if (!isParametersResponse(body)) throw new Error('unexpected answer from the parameters route')
      state = body.available ? { status: 'ready', parameters: body.parameters } : { status: 'unavailable', message: body.message }
    } catch (err) {
      console.error('[ModelSession] loading Revit parameters failed', { referenceId: ref.id, key, err })
      state = { status: 'error', message: REVIT_LOAD_FAILED }
    }
    if (token === this.selectionToken && !this.disposed) emit(state)
  }

  /** The model id live editing is on (a branch is `<model>~<branch>`); null before it connects. */
  liveModelId(): string | null {
    return this.authority?.modelId ?? null
  }

  /**
   * Switch to another branch of this model, or back to Main, keeping the 3D view: the viewer,
   * the linked models, the camera and the level shown stay; only the line to the model server
   * and the model it sends are replaced. The view keeps showing what it showed until the new
   * model arrives, and its first update names what differs. Undo history belongs to the model it
   * was made on, so it is cleared. Returns why it waits (edits still saving), or null.
   */
  reconnect(authority: { readonly url: string; readonly modelId: string }): string | null {
    if (this.disposed) return null
    if (this.authority && this.authority.modelId === authority.modelId && this.authority.url === authority.url) return null
    const sync = this.syncModule
    if (!sync) {
      // Still opening: the line isn't up yet, so the new one is simply the one it opens.
      this.authority = authority
      return null
    }
    const pending = this.client?.saveState().pending ?? 0
    if (pending > 0) return switchWaitsWords(pending)
    // A drag or nudge in progress belongs to the model being left.
    this.cancelNudge()
    if (this.runDrag) this.endRunDrag(false)
    this.closeLine()
    this.switchedFrom = this.preview ?? this.view
    this.accepted = null
    this.view = null
    this.preview = null
    this.emitted = null
    this.endedIds = []
    this.predictedIds.clear()
    this.starterLevelAsked = false
    this.undoStack = []
    this.redoStack = []
    this.documentUndoStack.length = 0
    this.undoing.clear()
    this.emitUndoState()
    this.people.clear()
    this.events.onPresence(new Map())
    this.status = 'connecting'
    this.events.onStatus('connecting')
    this.events.onProblem(null)
    this.connect(sync, authority)
    return null
  }

  /** Close the line to the model server (socket, client, timers) and nothing else. */
  private closeLine() {
    this.clearConnectTimer()
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
    this.unbindNetworkEvents?.()
    this.unbindNetworkEvents = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.client?.dispose()
    this.client = null
    this.unanswered = []
    this.notUnderstood.clear()
    this.askedSince = null
    this.halted = false
    this.attempts = 0
    this.reconnectMs = RECONNECT_MIN_MS
  }

  private connect(sync: SyncModule, authority: { url: string; modelId: string }) {
    this.authority = authority
    const client = new sync.SyncClient(
      {
        send: (data) => {
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
          this.socket.send(data)
          if (this.askedSince === null && expectsAnswer(data)) this.askedSince = Date.now()
          const key = sentCommandKey(data)
          if (key) this.unanswered.push(key)
        },
        close: () => this.socket?.close(),
      },
      this.actor,
      {
        onView: (view) => {
          this.view = view
          this.accepted = client.confirmedModel()
          this.redraw()
          this.askStarterLevel()
        },
        onStatus: (status) => {
          this.status = status
          if (status === 'live') {
            this.deviceOffline = false
            this.clearConnectTimer()
            this.events.onProblem(null)
            this.askStarterLevel()
          }
          this.events.onStatus(status)
        },
        onSaveState: (state) => this.events.onSaveState(state),
        onPresence: (connectionId, presence) => {
          if (presence) this.people.set(connectionId, presence)
          else this.people.delete(connectionId)
          this.events.onPresence(new Map(this.people))
        },
        onRemoteChange: (revision, actor) => this.events.onActivity(`${actor.name} saved revision ${revision}`),
        onOutcome: (request, outcome) => this.settleOutcome(request, outcome),
        onModelReset: (info) => {
          // The client dropped every unsaved edit without answering them one by one.
          this.predictedIds.clear()
          this.emitted = null
          this.events.onActivity(
            info.droppedEdits > 0
              ? `The model was reloaded at revision ${info.toRevision}. Your last ${info.droppedEdits === 1 ? 'edit was' : `${info.droppedEdits} edits were`} not saved.`
              : `The model was reloaded at revision ${info.toRevision}.`,
          )
        },
        onBranchState: (branch) => {
          // Quietly in place: the line stays up, the view stays, and the next edit is refused in these words.
          if (branch.state === 'closed' || branch.state === 'merged') this.events.onActivity(`${branch.name}: ${branchClosedMessage(branch.state)}`)
          this.events.onBranchState?.(branch)
        },
        onDenied: (reason) => {
          this.halted = true
          this.clearConnectTimer()
          const problem = problemForDenied(reason)
          if (problem.kind !== 'no_model') console.error('[building-model] model server refused live editing', { modelId: authority.modelId, reason })
          this.events.onProblem(problem)
        },
      },
      10_000,
      // The meter reports preview / commit / remote-visibility timings to the model server (regional sessions, perf gate).
      { modelId: authority.modelId, meter: new sync.SessionMeter(sync.sessionLabelFromPage()) },
    )
    this.client = client
    this.bindNetworkEvents()
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_CHECK_MS)
    this.armConnectTimer()
    void this.openSocket()
  }

  /** Why Move, Place, Route, Split, drags and nudges are off right now; null while the line is up (or before the model first arrives, which `canEdit` covers). */
  editPausedReason(): string | null {
    const client = this.client
    if (!client || this.halted || !this.accepted) return null
    if (!this.deviceOffline && (this.status === 'live' || this.status === 'degraded')) return null
    return editsPausedMessage(client.saveState().pending, this.deviceOffline)
  }

  /** The paused reason, also shown at the tool (the hint line), so a press that does nothing says why. */
  private refusePaused(): string | null {
    const reason = this.editPausedReason()
    if (reason) this.events.onRefused?.(reason)
    return reason
  }

  /**
   * The server couldn't read a message (an edit it doesn't know yet: an older server than this
   * page). It answers that with no request key, so the client would keep the edit as "saving"
   * forever. Settle the oldest unanswered edit as refused, through the client's own answer path,
   * so it leaves the saving count, its prediction goes and the person is told.
   */
  private refuseNotUnderstood(client: SyncClient, serverMessage: string) {
    const key = this.unanswered.shift()
    if (!key) {
      console.error('[building-model] the model server did not understand a message (no edit was waiting)', { modelId: this.authority?.modelId, serverMessage })
      return
    }
    console.error('[building-model] the model server did not understand an edit; it was not saved', { modelId: this.authority?.modelId, key, serverMessage })
    this.notUnderstood.add(key)
    const refusal: ServerMessage = { type: 'outcome', idempotencyKey: key, outcome: { status: 'rejected', error: { code: 'invalid_value', message: editNotUnderstoodMessage(typeof window === 'undefined' ? '' : window.location.hostname), elementIds: [] } } }
    client.receive(JSON.stringify(refusal))
    // An edit the client had already settled (or never held) gets no outcome event.
    this.notUnderstood.delete(key)
  }

  private bindNetworkEvents() {
    if (typeof window === 'undefined') return
    const offline = () => {
      this.deviceOffline = true
      console.error('[building-model] the browser went offline; live editing paused', { modelId: this.authority?.modelId })
      this.events.onProblem(connectionProblem('device_offline'))
      this.dropSocket('browser offline')
    }
    const online = () => {
      if (!this.deviceOffline) return
      this.deviceOffline = false
      this.events.onProblem(null)
      this.reconnectNow()
    }
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    this.unbindNetworkEvents = () => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
    }
  }

  /** A socket that stopped answering is dead even if the browser never closed it. */
  private checkLiveness() {
    if (this.disposed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (this.askedSince === null) return
    const quietMs = Date.now() - this.askedSince
    if (quietMs <= STALE_CONNECTION_MS) return
    console.error('[building-model] the model server stopped answering; reconnecting', { modelId: this.authority?.modelId, quietMs, status: this.status })
    this.dropSocket('no answer')
  }

  /** Treat the current socket as gone: show it, keep the queued edits, and reconnect. */
  private dropSocket(why: string) {
    const socket = this.socket
    const client = this.client
    if (!socket || !client) return
    this.socket = null
    try {
      socket.close()
    } catch (err) {
      console.error('[building-model] closing a dead live-editing socket failed', { why, err })
    }
    client.closed()
    if (!this.connectTimer) this.armConnectTimer()
    this.scheduleReconnect()
  }

  /** Reconnect at once (the network came back), keeping a refusal if there was one. */
  private reconnectNow() {
    if (this.disposed || this.halted || !this.client) return
    this.reconnectMs = RECONNECT_MIN_MS
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.socket) return
    void this.openSocket()
  }

  /** Try again now (the Retry button): clears a refusal and restarts the backoff. */
  retry(): void {
    if (!this.client || this.disposed) return
    this.halted = false
    this.reconnectMs = RECONNECT_MIN_MS
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const previous = this.socket
    this.socket = null
    previous?.close()
    this.client.closed()
    this.status = 'connecting'
    this.events.onStatus('connecting')
    this.events.onProblem(null)
    this.armConnectTimer()
    void this.openSocket()
  }

  private armConnectTimer() {
    this.clearConnectTimer()
    const attemptsAtArm = this.attempts
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.disposed || this.halted || this.status === 'live') return
      // A hidden tab ran this timer in the same late batch as the reconnect: nothing has been tried yet, so it can't be "unreachable".
      if (this.attempts === attemptsAtArm) {
        this.armConnectTimer()
        return
      }
      console.error('[building-model] live editing did not connect in time', {
        url: this.authority?.url,
        modelId: this.authority?.modelId,
        attempts: this.attempts,
        status: this.status,
      })
      this.events.onProblem(connectionProblem('unreachable'))
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private scheduleReconnect() {
    if (this.disposed || this.halted) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket()
    }, this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
  }

  private async openSocket() {
    const client = this.client
    const authority = this.authority
    if (this.disposed || this.halted || !client || !authority) return
    this.attempts += 1
    let token: string | null
    try {
      token = await this.getToken()
    } catch (err) {
      console.error('[building-model] reading the host session failed', { modelId: authority.modelId, err })
      token = null
    }
    if (this.disposed || this.halted) return
    if (!token) {
      console.error('[building-model] no host session; not connecting live editing', { modelId: authority.modelId })
      this.events.onProblem(connectionProblem('signed_out'))
      this.scheduleReconnect()
      return
    }
    client.setToken(token)
    const socket = new WebSocket(authority.url)
    this.socket = socket
    let opened = false
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      opened = true
      this.askedSince = null
      this.reconnectMs = RECONNECT_MIN_MS
      // A new connection answers only what is sent on it (the client resends waiting edits after welcome).
      this.unanswered = []
      client.opened()
      client.publishPresence({ kind: 'idle' })
    })
    socket.addEventListener('message', (e) => {
      if (this.socket !== socket) return
      this.askedSince = null
      const raw = String(e.data)
      const answered = answeredKey(raw)
      if (answered !== null) this.unanswered = this.unanswered.filter((key) => key !== answered)
      client.receive(raw)
      const error = serverErrorText(raw)
      if (error !== null) this.refuseNotUnderstood(client, error)
    })
    socket.addEventListener('close', (e) => {
      if (this.socket !== socket) return
      this.socket = null
      client.closed()
      if (!opened) {
        console.error('[building-model] live editing connection failed to open', { url: authority.url, modelId: authority.modelId, attempt: this.attempts, code: e.code })
      } else if (this.accepted && !this.connectTimer) {
        // Lost a working line: after the grace period the header says Offline instead of Reconnecting.
        this.armConnectTimer()
      }
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      console.error('[building-model] live editing connection error', { url: authority.url, modelId: authority.modelId, attempt: this.attempts })
    })
  }

  /** The solid engine for modeled parts loads beside the view; parts redraw from boxes to their real shape when it is ready. */
  private loadPartGeometry() {
    import('../contracts/bim/part-geometry')
      .then((m) => m.initPartGeometry())
      .then(
        () => {
          if (!this.disposed) this.redraw()
        },
        (err: unknown) => {
          console.error('[model-session] geometry engine failed to load', err)
          if (!this.disposed) this.events.onActivity(`Modeled parts show as boxes: the geometry engine didn't load (${err instanceof Error ? err.message : String(err)}). Reload the page to try again.`)
        },
      )
  }

  private redraw() {
    if (!this.viewer || !this.accepted || !this.view) return
    this.viewer.setAuthored(this.accepted, this.preview ?? this.view)
    const shown = this.preview ?? this.view
    this.events.onModel(this.accepted, shown, this.changedSinceLastModel(shown))
    if (this.selectedId) {
      const element = (this.preview ?? this.view).elements[this.selectedId]
      this.events.onSelection(element ? { kind: 'authored', element } : null)
      if (!element) this.selectedId = null
    } else if (this.groupIds && !this.preview) {
      const live = this.view.elements
      const kept = this.groupIds.filter((id) => live[id] !== undefined)
      if (kept.length !== this.groupIds.length) {
        this.setGroup(kept)
        this.events.onSelection(this.groupIds ? { kind: 'group', scope: 'box', ids: this.groupIds, anchorId: null } : null)
      }
    }
    if (!this.framedWork && this.referencesReady) {
      this.framedWork = true
      void this.frameWork()
    }
  }

  /**
   * Ids changed in `shown` since the last onModel, from what is already known: the saved
   * changesets the client applied (`committed(r)`) and the ids each of this session's unsaved
   * edits changes in the prediction. Never a pass over every element. A prediction re-run on a
   * newer saved model is assumed to touch what it touched when sent; its changeset corrects that
   * when it is saved. Null when it can't be said this way (first model, reload, drag preview,
   * areas, an edit sent around this session).
   */
  private changedSinceLastModel(shown: ModelState): readonly ElementId[] | null {
    const client = this.client
    const confirmed = this.accepted
    const submitting = this.submittingIds
    const tracked = this.predictedIds.size + (submitting !== undefined ? 1 : 0)
    let known = submitting !== null
    for (const list of this.predictedIds.values()) if (list === null) known = false
    const exact = client !== null && known && this.preview === null && client.pendingCount() <= tracked && client.currentInterest() === undefined
    const last = this.emitted
    this.emitted = { confirmed, view: shown, exact }
    const ended = this.endedIds
    this.endedIds = []
    const switched = this.switchedFrom
    if (switched && !last) {
      // The first model after a branch switch: what differs from what was shown (once per switch).
      this.switchedFrom = null
      return idsChangedBySwitch(switched, shown)
    }
    if (!client || !last || !last.exact || !exact || ended === null) return null
    if (shown === last.view) return []
    const ids = new Set<ElementId>(ended)
    const before = last.confirmed
    if (confirmed !== before && (confirmed?.elements !== before?.elements || confirmed?.connections !== before?.connections)) {
      if (!confirmed || !before || confirmed.revision <= before.revision) return null
      for (let r = before.revision + 1; r <= confirmed.revision; r++) {
        const cs = client.committed(r)
        if (!cs) return null
        for (const id of touchedIds(cs.elements.map((e) => e.id), cs)) ids.add(id)
      }
    }
    for (const list of this.predictedIds.values()) for (const id of list ?? []) ids.add(id)
    for (const id of submitting ?? []) ids.add(id)
    return [...ids]
  }

  /**
   * Every edit goes to the client through here, so onModel knows which ids its prediction
   * changes. The client predicts (and emits the view) inside `submit`, before the request key
   * exists, hence `submittingIds`. `changed`: the ids, when the caller already knows them; null
   * when they can't be known (onModel then reports null until the edit is answered).
   */
  private sendToClient(client: SyncClient, command: Command, changed?: readonly ElementId[] | null): ReturnType<SyncClient['submit']> {
    let ids = changed
    if (ids === undefined) {
      // `view` is the client's view as of its last view event (never a drag preview).
      const before = this.view
      const predicted = before && this.kernel ? this.kernel.executeCommand(before, command) : null
      ids = predicted?.ok ? touchedIds(predicted.changedIds, predicted) : null
    }
    this.submittingIds = ids
    try {
      const res = client.submit(command)
      if (res.ok) this.predictedIds.set(res.request.idempotencyKey, ids)
      return res
    } finally {
      this.submittingIds = undefined
    }
  }

  /** Frame the new work with its surroundings (the whole site when nothing is authored yet). */
  async frameWork(): Promise<void> {
    if (!this.viewer) return
    await this.viewer.frame(await this.viewer.workBox())
  }

  currentView(): ModelState | null {
    return this.view
  }

  /** Draw the model as the open view sets it: its phase, phase filter and which groups show. */
  setDisplayContext(ctx: DisplayContext | null) {
    this.displayContext = ctx
    if (!this.viewer) return
    this.viewer.setDisplayContext(ctx)
    if (this.accepted && this.view) this.viewer.setAuthored(this.accepted, this.preview ?? this.view)
  }

  /** Follow the open view's Visibility/Graphics switches in the live model (null: the free model shows every category). */
  setCategoryView(view: CategoryView | null) {
    this.categoryView = view
    if (!this.viewer) return
    this.viewer.setCategoryView(view)
    if (this.accepted && this.view) this.viewer.setAuthored(this.accepted, this.preview ?? this.view)
  }

  // ------------------------------------------------------------ selection

  async selectAt(clientX: number, clientY: number): Promise<Pick | null> {
    this.flushNudge()
    if (!this.viewer) return null
    if (this.interceptClick()) return null
    // A widened pre-highlight (Tab) selects its whole scope.
    const scope = currentScope(this.preHighlight)
    if (scope && scope.kind !== 'element') {
      const hit = this.viewer.pickNative(clientX, clientY)
      if (hit && scope.ids.includes(hit.elementId)) {
        await this.selectGroup(scope.kind, scope.ids, this.preHighlight?.anchorId ?? null)
        return { source: 'native', elementId: hit.elementId, point: hit.point }
      }
    }
    this.setGroup(null)
    const pick = await this.viewer.pick(clientX, clientY)
    await this.viewer.select(pick)
    const token = ++this.selectionToken
    this.selectedId = pick?.source === 'native' ? pick.elementId : null
    if (!pick) {
      this.events.onSelection(null)
      return null
    }
    if (pick.source === 'native') {
      const element = this.view?.elements[pick.elementId]
      this.events.onSelection(element ? { kind: 'authored', element } : null)
      return pick
    }
    const referenceLabel = this.referenceLabels.get(pick.referenceId) ?? 'Linked model'
    const ref = this.referenceInfo.get(pick.referenceId)
    const hasRevit = !!(ref?.parametersSource && this.revitParametersUrl)
    if (pick.source === 'marker') {
      const unplaced = this.unplaced.get(pick.referenceId)?.get(pick.markerId) ?? null
      const base = { kind: 'reference', referenceLabel, properties: null, problem: null, unplaced } as const
      this.events.onSelection({ ...base, revit: hasRevit && unplaced ? { status: 'loading' } : null })
      if (ref && unplaced) void this.loadRevit(ref, { elementId: unplaced.elementId }, token, (revit) => this.events.onSelection({ ...base, revit }))
      return pick
    }
    let properties: ReferenceItemProperties | null = null
    let problem: string | null = null
    try {
      properties = await this.viewer.referenceProperties(pick.referenceId, pick.localId)
    } catch (err) {
      console.error('[ModelSession] reading linked element properties failed', { referenceId: pick.referenceId, localId: pick.localId, err })
      problem = "This element's properties couldn't be read. Select it again; if it keeps happening, reload the page."
    }
    if (token !== this.selectionToken) return pick
    const base = { kind: 'reference', referenceLabel, properties, problem, unplaced: null } as const
    const globalId = properties?.attributes.find((a) => a.name === 'GlobalId')?.value ?? null
    if (!hasRevit || !ref || !properties) {
      this.events.onSelection({ ...base, revit: null })
    } else if (!globalId) {
      this.events.onSelection({ ...base, revit: { status: 'unavailable', message: NO_GLOBAL_ID } })
    } else {
      this.events.onSelection({ ...base, revit: { status: 'loading' } })
      void this.loadRevit(ref, { globalId }, token, (revit) => this.events.onSelection({ ...base, revit }))
    }
    return pick
  }

  async clearSelection(): Promise<void> {
    this.flushNudge()
    this.selectionToken += 1
    this.selectedId = null
    this.setGroup(null)
    await this.viewer?.select(null)
    this.events.onSelection(null)
  }

  // ------------------------------------------------------------ hover, Tab to select more, groups

  private setGroup(ids: readonly string[] | null) {
    this.groupIds = ids && ids.length > 0 ? ids : null
    this.viewer?.setGroupSelection(this.groupIds ? new Set(this.groupIds) : null)
  }

  /** Select a set of elements as one group (a run, branch or system, or a box selection). */
  async selectGroup(scope: SelectionScopeKind | 'box', ids: readonly string[], anchorId: string | null): Promise<void> {
    this.flushNudge()
    this.selectionToken += 1
    this.selectedId = null
    await this.viewer?.select(null)
    this.setGroup(ids)
    this.clearHover()
    this.events.onSelection(this.groupIds ? { kind: 'group', scope, ids: this.groupIds, anchorId } : null)
  }

  /** Pre-highlight what a click would select; the hint says what Tab would select next. Nothing is sent. */
  hoverAt(clientX: number, clientY: number): string | null {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    if (!viewer || !view || !kernel) return null
    // What the person sees under the pointer: never our duct behind the architect's pipe.
    const hit = viewer.pickNativeInFront(clientX, clientY)
    this.hoverGrab = this.canEdit() ? this.grabAt(clientX, clientY, hit) : null
    const next = hoverTo(this.preHighlight, hit ? hit.elementId : null, (id) => kernel.selectionScopes(view, id))
    if (next !== this.preHighlight) {
      this.preHighlight = next
      const scope = currentScope(next)
      viewer.setHighlight(scope ? new Set(scope.ids) : null)
      this.notifyHover()
    }
    const selection = hit && !this.hoverGrab && this.canEdit() ? this.selectionToDrag(hit.elementId) : null
    if (selection) return `Drag to move ${groupWords(selection)}; while dragging, hold Shift to go up or down.`
    return this.withGrabCue(tabHint(next))
  }

  /**
   * In front of the Tab hint while a run handle is under the pointer: what a
   * drag here does (move, stretch, corner, or the whole Tab group), and for the
   * first few pieces hovered, that Tab takes the whole run along.
   */
  private withGrabCue(hint: string | null): string | null {
    const h = this.hoverGrab
    if (!h || !hint) return hint
    const scope = currentScope(this.preHighlight)
    if (scope && scope.kind !== 'element') return `Drag to move the whole ${scopeWord(scope.kind)} (${scope.ids.length} pieces) together. ${hint}`
    let tip = ''
    if (h.grab.kind !== 'end' && this.preHighlight?.scopes.some((s) => s.kind !== 'element')) {
      if (this.tabTipFor !== h.grab.id) {
        this.tabTipFor = h.grab.id
        this.tabTipHovers += 1
      }
      if (this.tabTipHovers <= 3) tip = ' Tab selects the whole run to move it together.'
    }
    return `${grabHint(h.grab.kind, h.label, this.lowView())}${tip} ${hint}`
  }

  /** Hover by id, for a plan or section drawing that picked it itself: the same pre-highlight and Tab scopes as the 3D view. */
  hoverElement(id: string | null): string | null {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel) return null
    this.hoverGrab = null
    const next = hoverTo(this.preHighlight, id && view.elements[id] ? id : null, (x) => kernel.selectionScopes(view, x))
    if (next !== this.preHighlight) {
      this.preHighlight = next
      const scope = currentScope(next)
      this.viewer?.setHighlight(scope ? new Set(scope.ids) : null)
      this.notifyHover()
    }
    return tabHint(next)
  }

  /** Hear what the pointer is over (the pre-highlight's ids, null when nothing); returns the unsubscribe. */
  onHoverChange(listener: (ids: readonly string[] | null) => void): () => void {
    this.hoverListeners.add(listener)
    return () => {
      this.hoverListeners.delete(listener)
    }
  }

  private notifyHover(): void {
    const ids = currentScope(this.preHighlight)?.ids ?? null
    for (const listener of this.hoverListeners) {
      try {
        listener(ids)
      } catch (err) {
        console.error('[model-session] a hover listener failed', err)
      }
    }
    this.refreshClickCursor()
  }

  /**
   * Let one handler take plan and 3D clicks before selection (a proposal
   * preview accepting the room under the pointer); null clears it. A newer
   * one replaces the last. Returns the unregister, which clears only its own.
   */
  setClickHandler(handler: ClickHandler | null): () => void {
    this.clickHandler = handler
    this.refreshClickCursor()
    return () => {
      if (this.clickHandler !== handler) return
      this.clickHandler = null
      this.refreshClickCursor()
    }
  }

  /** True when the handler took this click on what the pointer is over (nothing: only a handler that claims empty space). */
  private interceptClick(): boolean {
    const handler = this.clickHandler
    if (!handler) return false
    const ids = currentScope(this.preHighlight)?.ids ?? []
    try {
      if (ids.length === 0 && !handler.claims(ids)) return false
      return handler.click(ids)
    } catch (err) {
      console.error('[model-session] the click handler failed; selecting instead', err)
      return false
    }
  }

  /** A click on empty paper in a drawing (nothing hovered): the click handler takes it if it claims empty space. */
  takeEmptyClick(): boolean {
    this.flushNudge()
    return this.interceptClick()
  }

  /** The pointer cursor over what the handler would take, so a click there visibly does something. */
  private refreshClickCursor(): void {
    const handler = this.clickHandler
    const ids = currentScope(this.preHighlight)?.ids ?? []
    let on = false
    if (handler) {
      try {
        on = handler.claims(ids)
      } catch (err) {
        console.error('[model-session] the click handler failed to say what it takes', err)
      }
    }
    this.container.classList.toggle(CLICK_TAKEN_CLASS, on)
  }

  /** What the pre-highlight covers now (Tab widens it); null when nothing is hovered. */
  highlightedIds(): readonly string[] | null {
    return currentScope(this.preHighlight)?.ids ?? null
  }

  /** Select by id (a click in a drawing). A widened pre-highlight that covers it selects its whole scope, as a click in 3D does. */
  async selectElement(id: string | null): Promise<void> {
    this.flushNudge()
    const scope = currentScope(this.preHighlight)
    // A drawing click hovers the element first; a select from a list or finding (pointer elsewhere) is never taken.
    if (id && scope?.ids.some((x) => x === id) && this.interceptClick()) return
    if (id && scope && scope.kind !== 'element' && scope.ids.some((x) => x === id)) {
      await this.selectGroup(scope.kind, scope.ids, this.preHighlight?.anchorId ?? null)
      return
    }
    this.setGroup(null)
    this.selectionToken += 1
    const element = id ? this.view?.elements[id] : undefined
    this.selectedId = element ? element.id : null
    await this.viewer?.selectElement(element ? element.id : null)
    this.events.onSelection(element ? { kind: 'authored', element } : null)
  }

  /** Tab / Shift+Tab while hovering: widen or narrow the pre-highlight. Null when nothing is hovered. */
  tabCycle(direction: 1 | -1): string | null {
    if (!this.preHighlight) return null
    this.preHighlight = cycle(this.preHighlight, direction)
    const scope = currentScope(this.preHighlight)
    this.viewer?.setHighlight(scope ? new Set(scope.ids) : null)
    return this.withGrabCue(tabHint(this.preHighlight))
  }

  hovering(): boolean {
    return this.preHighlight !== null
  }

  clearHover() {
    this.hoverGrab = null
    if (!this.preHighlight) return
    this.preHighlight = null
    this.viewer?.setHighlight(null)
  }

  /** Totals for a group: counts, length, the airflow entering it, and its system's fan static pressure. */
  groupSummary(ids: readonly string[]): { summary: import('@permitzip/bim-kernel').ScopeSummary; pressure: { system: string; espInWc: number | null; reason: string | null }[] } | null {
    const kernel = this.kernel
    const airPack = this.airPack
    const view = this.view
    if (!kernel || !airPack || !view) return null
    const summary = kernel.scopeSummary(view, ids)
    const engine = (this.pressureEngine ??= new airPack.PressureEngine())
    const pressure = summary.systemIds.map((sid) => {
      const report = engine.report(view, sid)
      return { system: report?.systemName ?? sid, espInWc: report?.calculable ? report.requiredEspInWc : null, reason: report && !report.calculable ? (report.reason ?? null) : null }
    })
    return { summary, pressure }
  }

  /** Window (left to right) or crossing (right to left) selection in the open view, kept to the categories asked for. */
  async boxSelect(start: { x: number; y: number }, end: { x: number; y: number }, categories: ReadonlySet<BoxCategory>): Promise<string> {
    const viewer = this.viewer
    const view = this.view
    const viewerModule = this.viewerModule
    if (!viewer || !view || !viewerModule) return "The model isn't open yet."
    const mode = viewerModule.boxModeOf(start, end)
    const ids = viewerModule.boxSelect(viewer.authoredScreenBoxes(), viewerModule.dragRect(start, end), mode, (id) => boxAccepts(view.elements[id], categories))
    return this.finishBoxSelect(ids, mode)
  }

  /** A box selection a plan or section drawing made (it found the ids itself), kept to the same filter as the 3D view's. */
  async selectBoxIds(ids: readonly string[], mode: 'window' | 'crossing', categories: ReadonlySet<BoxCategory>): Promise<string> {
    const view = this.view
    if (!view) return "The model isn't open yet."
    return this.finishBoxSelect(ids.filter((id) => boxAccepts(view.elements[id], categories)), mode)
  }

  private async finishBoxSelect(ids: readonly string[], mode: 'window' | 'crossing'): Promise<string> {
    if (ids.length === 0) {
      await this.clearSelection()
      return mode === 'window' ? 'Nothing lies fully inside the box. Drag right to left to pick what it touches.' : 'The box touches nothing of the kinds selected in Filter.'
    }
    await this.selectGroup('box', ids, null)
    return `${ids.length} selected (${mode === 'window' ? 'fully inside' : 'touching'} the box).`
  }

  /** Move every movable piece of the group by `delta` (plan mm) and `dzMm` up (parts only; runs change height with Change height) in one edit. */
  moveGroupBy(ids: readonly string[], delta: Vec2, dzMm = 0): string | null {
    const view = this.view
    if (!view) return "Live editing isn't connected, so nothing can be moved."
    const paused = this.refusePaused()
    if (paused) return paused
    const move = moveCommandFor(view, ids, delta, dzMm)
    return typeof move === 'string' ? move : this.submit(move)
  }

  /** Resize or reshape what is selected (one piece, or every routed piece of a group) in one edit, with transitions where neighbours keep their size. */
  resizeGroup(ids: readonly string[], size: RunSize, transition?: FittingChoice): string | null {
    const view = this.view
    if (!view) return "Live editing isn't connected, so nothing can be resized."
    const req = resizeRequestFor(view, ids, size, newElementId('rs'), transition)
    return req.ok ? this.submit(req.command) : req.reason
  }

  // ------------------------------------------------------------ split

  armSplit(on: boolean) {
    if (!on) this.clearRoutePreview()
  }

  private splitTarget(clientX: number, clientY: number): { seg: Extract<BimElement, { kind: 'run_segment' }>; s: number } | null {
    const viewer = this.viewer
    const view = this.view
    if (!viewer || !view) return null
    const hit = viewer.pickNative(clientX, clientY)
    const el = hit ? view.elements[hit.elementId] : undefined
    if (el?.kind !== 'run_segment') return null
    const floor = this.levelElevation(el.levelId) ?? 0
    const ax = el.end.x - el.start.x
    const ay = el.end.y - el.start.y
    const az = el.end.z - el.start.z
    const len = Math.hypot(ax, ay, az)
    if (len < 1) return null
    let s: number
    if (Math.hypot(ax, ay) < 1) {
      const v = viewer.verticalPointAt(clientX, clientY, el.start.x, el.start.y)
      if (!v) return null
      s = ((v.elevationMm - floor - el.start.z) / az) * len
    } else {
      const at = viewer.planPointAt(clientX, clientY, floor + (el.start.z + el.end.z) / 2)
      if (!at) return null
      s = ((at.x - el.start.x) * ax + (at.y - el.start.y) * ay) / Math.hypot(ax, ay)
    }
    return splitAlong(el, s)
  }

  /** The split for a model point (mm above project zero) on a straight piece, as a drawing finds it. */
  private splitTargetOn(elementId: string, at: RunPoint): { seg: RunSegment; s: number } | null {
    const el = this.view?.elements[elementId]
    if (el?.kind !== 'run_segment') return null
    const floor = this.levelElevation(el.levelId) ?? 0
    const d = { x: el.end.x - el.start.x, y: el.end.y - el.start.y, z: el.end.z - el.start.z }
    const len = Math.hypot(d.x, d.y, d.z)
    if (len < 1) return null
    return splitAlong(el, ((at.x - el.start.x) * d.x + (at.y - el.start.y) * d.y + (at.z - floor - el.start.z) * d.z) / len)
  }

  private splitPreviewText(t: { seg: RunSegment; s: number } | null): string {
    if (!t || !this.kernel || !this.view) return 'Point at a straight duct or pipe where it should be split.'
    const res = this.kernel.executeCommand(this.view, { type: 'split_run', idPrefix: 'split-preview', segmentId: t.seg.id, atMm: t.s })
    const name = this.kernel.runLabel(this.view.elements, t.seg)
    return res.ok ? `Click to split the ${name} at ${feetInches(t.s)}. Esc to stop.` : `${res.error.message}.`
  }

  private splitAt(t: { seg: RunSegment; s: number } | null): string {
    if (!t) return 'Click on a straight duct or pipe to split it.'
    const paused = this.refusePaused()
    if (paused) return paused
    const refused = this.submit({ type: 'split_run', idPrefix: newElementId('split'), segmentId: t.seg.id, atMm: t.s })
    return refused ?? `Split at ${feetInches(t.s)}. Click to split again, or select a piece and Resize it to change just that stretch.`
  }

  previewSplit(clientX: number, clientY: number): string {
    return this.splitPreviewText(this.splitTarget(clientX, clientY))
  }

  clickSplit(clientX: number, clientY: number): string {
    return this.splitAt(this.splitTarget(clientX, clientY))
  }

  /** Split on a drawing: the piece and model point under the pointer. */
  previewSplitOn(elementId: string, at: RunPoint): string {
    return this.splitPreviewText(this.splitTargetOn(elementId, at))
  }

  splitOn(elementId: string, at: RunPoint): string {
    return this.splitAt(this.splitTargetOn(elementId, at))
  }

  // ------------------------------------------------------------ drag a routed piece

  /** What a press at this point would grab on a routed run (in model mm), or null. */
  private grabAt(clientX: number, clientY: number, picked?: ReturnType<ModelViewer3D['pickNative']>): { grab: RunGrab; levelId: string; label: string } | null {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    const viewerModule = this.viewerModule
    if (!viewer || !view || !kernel || !viewerModule) return null
    const hit = picked === undefined ? viewer.pickNativeInFront(clientX, clientY) : picked
    const el = hit ? view.elements[hit.elementId] : undefined
    if (!hit || !el || (el.kind !== 'run_segment' && el.kind !== 'run_fitting')) return null
    const floor = this.levelElevation(el.levelId) ?? 0
    const plan = viewerModule.sceneToKernel(hit.point)
    const grab = grabFor(view.elements, el, { x: plan.x, y: plan.y, z: hit.point.y / viewerModule.MM - floor })
    return grab ? { grab, levelId: el.levelId, label: kernel.runLabel(view.elements, el) } : null
  }

  /** The handle to draw for what the pointer would grab, in canvas px; null when there is none or editing is off. */
  grabHandle(): { x: number; y: number; kind: RunGrab['kind']; hint: string } | null {
    const h = this.hoverGrab
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    if (!h || !viewer || !viewerModule || !this.canEdit()) return null
    const floor = this.levelElevation(h.levelId) ?? 0
    const p = viewer.screenPointOf(viewerModule.kernelToScene(h.grab.at.x, h.grab.at.y, floor + h.grab.at.z))
    return p ? { ...p, kind: h.grab.kind, hint: grabHint(h.grab.kind, h.label, this.lowView()) } : null
  }

  /** Start dragging the straight piece, end or elbow under the pointer; null when there is none (the camera moves instead). */
  beginRunDragAt(clientX: number, clientY: number): string | null {
    const viewer = this.viewer
    if (!viewer || !this.client) return null
    const found = this.grabAt(clientX, clientY)
    if (!found || this.refusePaused()) return null
    const { grab, levelId, label } = found
    const floor = this.levelElevation(levelId) ?? 0
    const plane = floor + grab.at.z
    const from = viewer.planPointAt(clientX, clientY, plane)
    if (!from) return null
    const facing = this.lowView() ? viewer.facingPointAt(clientX, clientY, grab.at.x, grab.at.y, plane) : null
    return this.startRunDrag(grab, label, from, { x: clientX, y: clientY }, plane, this.groupToDrag(grab.id), facing)
  }

  /**
   * Start dragging the selection from a press on one of its pieces that isn't
   * a duct or pipe handle (a selected part, or any piece of a box selection):
   * the whole selection moves rigidly with one `move_elements`, Shift (or a
   * low camera) for up and down. Null when the press isn't on the selection
   * (the empty-space drag happens instead).
   */
  beginSelectionDragAt(clientX: number, clientY: number): string | null {
    const viewer = this.viewer
    const view = this.view
    const viewerModule = this.viewerModule
    if (!viewer || !view || !viewerModule || !this.client) return null
    const hit = viewer.pickNativeInFront(clientX, clientY)
    if (!hit) return null
    const group = this.selectionToDrag(hit.elementId)
    if (!group || this.refusePaused()) return null
    const plane = hit.point.y / viewerModule.MM
    const from = viewer.planPointAt(clientX, clientY, plane)
    if (!from) return null
    const at = viewerModule.sceneToKernel(hit.point)
    const facing = this.lowView() ? viewer.facingPointAt(clientX, clientY, at.x, at.y, plane) : null
    const grab: RunGrab = { id: hit.elementId, kind: 'segment', at: { x: at.x, y: at.y, z: 0 }, axis: null }
    return this.startRunDrag(grab, group.word, from, { x: clientX, y: clientY }, plane, group, facing)
  }

  /** The selection a press on `id` drags whole: the group it belongs to, or the selected part alone. A lone selected duct piece keeps its run drag. */
  private selectionToDrag(id: string): { ids: readonly string[]; word: string } | null {
    const view = this.view
    if (!view) return null
    if (this.groupIds && this.groupIds.length > 1 && this.groupIds.includes(id)) return { ids: this.groupIds, word: 'selection' }
    const only = this.groupIds?.length === 1 ? this.groupIds[0] : this.selectedId
    const el = only === id ? view.elements[id] : undefined
    if (!el || el.kind === 'run_segment' || el.kind === 'run_fitting') return null
    return { ids: [id], word: el.kind === 'part' ? partLabel(view, el) : 'selection' }
  }

  /** The Tab-widened pre-highlight (or the selected group) the pressed piece belongs to: it moves whole. */
  private groupToDrag(id: string): { ids: readonly string[]; word: string } | null {
    const scope = currentScope(this.preHighlight)
    if (scope && scope.kind !== 'element' && scope.ids.some((x) => x === id)) return { ids: scope.ids, word: scopeWord(scope.kind) }
    if (this.groupIds && this.groupIds.length > 1 && this.groupIds.includes(id)) return { ids: this.groupIds, word: 'selection' }
    return null
  }

  /**
   * Start dragging a routed piece from a plan, section or elevation drawing:
   * the drawing found the piece and the model point under the pointer (`at`,
   * mm above project zero). Same grab, `drag_run` command, elbow limits and
   * reroute as the 3D view. Null when it isn't a run piece or editing is off.
   */
  beginRunDragOn(elementId: string, at: RunPoint): string | null {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel || !this.client) return null
    const el = view.elements[elementId]
    if (!el || (el.kind !== 'run_segment' && el.kind !== 'run_fitting') || this.refusePaused()) return null
    const floor = this.levelElevation(el.levelId) ?? 0
    const grab = grabFor(view.elements, el, { x: at.x, y: at.y, z: at.z - floor })
    if (!grab) return null
    return this.startRunDrag(grab, kernel.runLabel(view.elements, el), { x: at.x, y: at.y }, null, floor + grab.at.z, null, null)
  }

  /** The 3D camera looks at the model from the side (under LOW_VIEW_DEG below level): plain drags go up and down too. */
  private lowView(): boolean {
    const viewer = this.viewer
    return viewer !== null && viewer.viewPitchDeg() < LOW_VIEW_DEG
  }

  private startRunDrag(grab: RunGrab, label: string, from: Vec2, fromClient: Vec2 | null, plane: number, group: { ids: readonly string[]; word: string } | null, facing: RunPoint | null): string {
    this.runDrag = { id: grab.id, kind: grab.kind, grip: grab.grip, axis: grab.axis, from, fromClient, plane, facing, delta: null, reroute: false, connectTo: null, label, group }
    if (group) return `Dragging ${groupWords(group)}. Release to save, Esc to cancel.`
    const what = grab.grip ? `the ${grab.grip === 'start' ? 'near' : 'far'} end of the ${label}` : `the ${label}`
    return `Dragging ${what}. Release to save, Esc to cancel.`
  }

  /** The model as the drag in progress would leave it (for a drawing's live preview); null when nothing would change yet. */
  runDragPreview(): ModelState | null {
    return this.runDrag?.delta ? this.preview : null
  }

  isRunDragging(): boolean {
    return this.runDrag !== null
  }

  /**
   * Preview a drag. A leg pulled back past its elbow flips the elbow and runs
   * the other way; with `strict` (Alt held), or where it can't flip, the drag
   * stops at the limit and says why. It never just refuses while it can move.
   */
  previewRunDrag(clientX: number, clientY: number, vertical: boolean, strict = false): string | null {
    const d = this.runDrag
    const viewer = this.viewer
    if (!d || !viewer) return null
    let raw = { x: 0, y: 0, z: 0 }
    if (vertical) {
      const v = viewer.verticalPointAt(clientX, clientY, d.from.x, d.from.y)
      const rise = v ? v.elevationMm - d.plane : this.screenRise(d, clientY)
      if (rise === null) return null
      raw = { x: 0, y: 0, z: rise }
    } else if (d.facing) {
      // From the side: follow the plane facing the camera, keeping to whichever way the drag goes more (up and down, or sideways).
      const at = viewer.facingPointAt(clientX, clientY, d.facing.x, d.facing.y, d.facing.z)
      if (!at) return null
      const dx = at.x - d.facing.x
      const dy = at.y - d.facing.y
      const dz = at.z - d.facing.z
      raw = Math.abs(dz) >= Math.hypot(dx, dy) ? { x: 0, y: 0, z: dz } : { x: dx, y: dy, z: 0 }
    } else {
      const at = viewer.planPointAt(clientX, clientY, d.plane)
      if (!at) return null
      raw = { x: at.x - d.from.x, y: at.y - d.from.y, z: 0 }
    }
    return this.previewRunDragBy(raw, strict, true)
  }

  /**
   * Looking straight down there is no vertical line to follow: the drag's
   * screen travel up or down, at the plan's scale, is the rise (up on screen is up).
   */
  private screenRise(d: NonNullable<ModelSession['runDrag']>, clientY: number): number | null {
    const viewer = this.viewer
    if (!viewer || !d.fromClient) return null
    const a = viewer.planPointAt(d.fromClient.x, d.fromClient.y, d.plane)
    const b = viewer.planPointAt(d.fromClient.x, clientY, d.plane)
    if (!a || !b) return null
    return Math.hypot(b.x - a.x, b.y - a.y) * (clientY < d.fromClient.y ? 1 : -1)
  }

  /**
   * Preview a run drag by a model move (mm; z up). The 3D canvas and the
   * drawings both end here, so a drag is the same `drag_run` wherever it began.
   */
  previewRunDragBy(raw: RunPoint, strict: boolean, shiftTip = false, exact = false): string | null {
    const d = this.runDrag
    const view = this.view
    const kernel = this.kernel
    if (!d || !view || !kernel) return null
    if (d.group) return this.previewGroupDrag(d, d.group, raw)
    // A typed length is exact; a pointer drag lands on the grid.
    const snapped = exact ? { delta: { x: Math.round(raw.x * 10) / 10, y: Math.round(raw.y * 10) / 10, z: Math.round(raw.z * 10) / 10 }, mode: 'along' as const } : snapDrag(d.kind, d.axis, raw)
    if (Math.hypot(snapped.delta.x, snapped.delta.y, snapped.delta.z) < 1) {
      d.delta = null
      this.clearRoutePreview()
      return `Dragging the ${d.label}. Release to save, Esc to cancel.`
    }
    const cmd = { type: 'drag_run' as const, elementId: d.id, delta: snapped.delta, ...(d.grip ? { grip: d.grip } : {}) }
    let res = kernel.executeCommand(view, cmd)
    let delta = snapped.delta
    let rerouted = false
    let rerouteRefusal: string | null = null
    let stopped: { message: string; canFlip: boolean } | null = null
    if (!res.ok && !strict) {
      const flipped = kernel.executeCommand(view, { ...cmd, reroute: true })
      if (flipped.ok) {
        res = flipped
        rerouted = true
      } else rerouteRefusal = flipped.error.message
    }
    if (!res.ok) {
      const limit = kernel.dragLimit(view, cmd)
      const at = limit.accepted && limit.binding ? kernel.executeCommand(view, { ...cmd, delta: limit.accepted }) : null
      if (at?.ok && limit.accepted && limit.binding) {
        res = at
        delta = limit.accepted
        stopped = { message: limit.binding.message, canFlip: limit.flipsAt !== null }
      }
    }
    if (!res.ok) {
      d.delta = null
      this.clearRoutePreview()
      return `${res.error.message}.`
    }
    d.delta = delta
    d.reroute = rerouted
    d.connectTo = null
    // An open end pulled onto another run's side: release taps into it (the hint says so first).
    const onto = d.kind === 'end' && d.grip ? sideUnderEnd(res.model, d.id, d.grip) : null
    if (onto && d.grip) {
      const tap = kernel.executeCommand(view, { type: 'stretch_to_side', from: { elementId: d.id, port: d.grip }, onto: onto.id, idPrefix: 'stretch-preview' })
      if (tap.ok) {
        d.connectTo = onto.id
        this.preview = tap.model
        if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
        const end = view.elements[d.id]
        const z = heightUnder(onto, end?.kind === 'run_segment' ? (d.grip === 'start' ? end.start : end.end) : onto.start)
        const endZ = end?.kind === 'run_segment' ? (d.grip === 'start' ? end.start.z : end.end.z) : z
        const height = Math.abs(endZ - z) > 1 ? `; it ${z > endZ ? 'rises' : 'drops'} to ${feetInches(z)} on the way` : ''
        return `Release to tap into the ${kernel.runLabel(view.elements, onto)} at its height and system${height}. Esc to cancel.`
      }
      this.preview = res.model
      if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
      return `It can't tap into the ${kernel.runLabel(view.elements, onto)} here: ${tap.error.message}. Release to just stretch it, Esc to cancel.`
    }
    this.preview = res.model
    if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
    const distance = feetInches(Math.hypot(delta.x, delta.y, delta.z))
    if (stopped) {
      const flip = !stopped.canFlip ? '' : strict ? ' Let go of Alt (Option) to flip the elbow and keep going.' : rerouteRefusal ? ` The elbow can't flip here: ${rerouteRefusal}.` : ''
      return `Stopped at ${distance}: ${stopped.message}.${flip} Release to keep it here, Esc to cancel.`
    }
    if (rerouted) return `${distance}; elbow flips, so the leg runs the other way. Release to apply, Esc to cancel, hold Alt (Option) to stop at the elbow instead.`
    const level = Math.abs(delta.x) < 1 && Math.abs(delta.y) < 1
    const how = level ? (delta.z > 0 ? 'up' : 'down') : snapped.mode === 'along' ? 'along itself' : snapped.mode === 'square' ? 'square to itself' : d.grip ? 'at the end' : 'the corner'
    const length = d.kind === 'end' ? this.runDragLength() : null
    const now = length === null ? '' : `, now ${feetInches(length)} long (type a length and press Enter for an exact one)`
    const upDown = !shiftTip || (level && !d.facing) ? '' : d.facing ? ' From this low angle, drag up or down to raise or lower it; Shift keeps it to up and down.' : ' Hold Shift to drag up or down.'
    return `${distance} ${how}${now}; what it meets follows. Release to save, Esc to cancel.${upDown}`
  }

  /** A Tab-widened run (or a selected group) moves rigidly: one `move_elements`, nothing stretches. */
  private previewGroupDrag(d: NonNullable<ModelSession['runDrag']>, group: { ids: readonly string[]; word: string }, raw: RunPoint): string | null {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel) return null
    const plan = snapDrag('corner', null, { x: raw.x, y: raw.y, z: 0 }).delta
    // Up and down (Shift, or from a low view) lands on whole inches.
    const snapped = { x: plan.x, y: plan.y, z: Math.round(raw.z / MM_PER_IN) * MM_PER_IN }
    if (Math.hypot(snapped.x, snapped.y, snapped.z) < 1) {
      d.delta = null
      this.clearRoutePreview()
      return `Dragging ${groupWords(group)}. Release to save, Esc to cancel.`
    }
    const move = moveCommandFor(view, group.ids, { x: snapped.x, y: snapped.y }, snapped.z)
    if (typeof move === 'string') {
      d.delta = null
      this.clearRoutePreview()
      return move
    }
    const res = kernel.executeCommand(view, move)
    if (!res.ok) {
      d.delta = null
      this.clearRoutePreview()
      return `${res.error.message}.`
    }
    d.delta = snapped
    this.preview = res.model
    if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
    const way = Math.hypot(snapped.x, snapped.y) < 1 ? (snapped.z > 0 ? ' up' : ' down') : ''
    return `${feetInches(Math.hypot(snapped.x, snapped.y, snapped.z))}${way}; ${groupWords(group)} moves together. Release to save, Esc to cancel.${way || d.facing ? '' : ' Hold Shift to drag up or down.'}`
  }

  /** The dragged straight piece's length as the preview leaves it; null when it isn't a straight piece. */
  private runDragLength(): number | null {
    const d = this.runDrag
    const el = d ? (this.preview ?? this.view)?.elements[d.id] : undefined
    return el?.kind === 'run_segment' ? Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z) : null
  }

  /**
   * A typed length while dragging an open end: the piece becomes exactly that
   * long (its other end stays put). Previews like a drag; release or Enter saves.
   */
  runDragToLength(lengthMm: number): string | null {
    const d = this.runDrag
    const el = d ? this.view?.elements[d.id] : undefined
    if (!d || d.group || d.kind !== 'end' || !d.grip || !d.axis || el?.kind !== 'run_segment') return 'Typed lengths work while dragging an open end of a straight piece.'
    if (!(lengthMm > 0)) return 'Type a length longer than zero, like 12\'6" or 12.5.'
    const len = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z)
    const k = (lengthMm - len) * (d.grip === 'end' ? 1 : -1)
    return this.previewRunDragBy({ x: d.axis.x * k, y: d.axis.y * k, z: d.axis.z * k }, true, false, true)
  }

  endRunDrag(commit: boolean): string | null {
    const d = this.runDrag
    this.runDrag = null
    this.clearRoutePreview()
    if (!d || !commit) return d ? 'Drag cancelled; nothing changed.' : null
    if (!d.delta) return null
    const paused = this.refusePaused()
    if (paused) return paused
    if (d.group) return this.moveGroupBy(d.group.ids, { x: d.delta.x, y: d.delta.y }, d.delta.z)
    if (d.connectTo && d.grip) return this.submit({ type: 'stretch_to_side', from: { elementId: d.id, port: d.grip }, onto: d.connectTo, idPrefix: newElementId('run') })
    return this.submit({ type: 'drag_run', elementId: d.id, delta: d.delta, ...(d.grip ? { grip: d.grip } : {}), ...(d.reroute ? { reroute: true } : {}) })
  }

  // ------------------------------------------------------------ arrow-key nudge

  /**
   * Arrow keys nudge the selection 1" (Shift: 1 ft); PageUp / PageDown move it
   * up and down. An arrow moves along the model axis that runs nearest that way
   * on screen, so Up moves away from you whichever way the view faces. A burst
   * of presses previews as it goes and saves as one move (one undo step) once
   * the keys pause; Esc drops what hasn't saved.
   */
  nudgeSelection(ids: readonly string[], key: NudgeKey, big: boolean): string {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel || !this.client) return "Live editing isn't connected, so nothing can be nudged."
    const paused = this.refusePaused()
    if (paused) return paused
    if (ids.length === 0) return 'Select something first; arrow keys nudge the selection.'
    if (this.nudge && (this.nudge.ids.length !== ids.length || this.nudge.ids.some((id, i) => id !== ids[i]))) this.flushNudge()
    const step = big ? MM_PER_FT : MM_PER_IN
    const dir = key === 'PageUp' ? { x: 0, y: 0, z: 1 } : key === 'PageDown' ? { x: 0, y: 0, z: -1 } : { ...this.screenAxis(ids, key), z: 0 }
    const before = this.nudge?.delta ?? { x: 0, y: 0, z: 0 }
    const delta = { x: before.x + dir.x * step, y: before.y + dir.y * step, z: before.z + dir.z * step }
    const command = this.nudgeCommand(view, ids, delta)
    if (typeof command === 'string') return command
    const res = kernel.executeCommand(view, command)
    if (!res.ok) return `${res.error.message}.`
    if (this.nudge) clearTimeout(this.nudge.timer)
    this.nudge = { ids: [...ids], delta, command, timer: setTimeout(() => this.flushNudge(), NUDGE_SETTLE_MS) }
    this.preview = res.model
    if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
    return `Nudged ${nudgeWords(delta)}. It saves as one move when you pause; Esc puts it back, Ctrl+Z undoes it after.`
  }

  /** Save a nudge burst now (the keys paused, or the selection changed). Returns the refusal, or null. */
  flushNudge(): string | null {
    const n = this.nudge
    if (!n) return null
    clearTimeout(n.timer)
    this.nudge = null
    this.preview = null
    const refused = this.submit(n.command)
    this.redraw()
    return refused
  }

  /** Esc during a nudge burst: nothing saves. True when there was one. */
  cancelNudge(): boolean {
    const n = this.nudge
    if (!n) return false
    clearTimeout(n.timer)
    this.nudge = null
    this.preview = null
    this.redraw()
    return true
  }

  /** The one move a nudge saves: a single routed piece stretches what it meets (`drag_run`); anything else moves whole. */
  private nudgeCommand(view: ModelState, ids: readonly string[], delta: RunPoint): Command | string {
    const only = ids.length === 1 && ids[0] ? view.elements[ids[0]] : undefined
    if (only?.kind === 'run_segment' || (only?.kind === 'run_fitting' && !only.host && only.ports.length === 2)) {
      const kernel = this.kernel
      const plain: Command = { type: 'drag_run', elementId: only.id, delta: { ...delta } }
      if (!kernel || kernel.executeCommand(view, plain).ok || Math.hypot(delta.x, delta.y) < 1) return plain
      const flipped: Command = { ...plain, reroute: true }
      return kernel.executeCommand(view, flipped).ok ? flipped : plain
    }
    return moveCommandFor(view, ids, { x: delta.x, y: delta.y }, delta.z)
  }

  /** The model axis (east, west, north or south) that runs nearest an arrow's direction on screen; north-up when the view can't say. */
  private screenAxis(ids: readonly string[], key: Exclude<NudgeKey, 'PageUp' | 'PageDown'>): Vec2 {
    const want = key === 'ArrowUp' ? { x: 0, y: -1 } : key === 'ArrowDown' ? { x: 0, y: 1 } : key === 'ArrowLeft' ? { x: -1, y: 0 } : { x: 1, y: 0 }
    const northUp = { x: want.x, y: -want.y }
    const viewer = this.viewer
    const el = ids[0] ? this.view?.elements[ids[0]] : undefined
    const at = el ? anchorOf(el) : null
    const floor = el && 'levelId' in el && typeof el.levelId === 'string' ? (this.levelElevation(el.levelId) ?? 0) : 0
    if (!viewer || !at) return northUp
    const o = viewer.canvasPointOf(at.x, at.y, floor + at.z)
    if (!o) return northUp
    let best: { axis: Vec2; score: number } | null = null
    for (const axis of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const p = viewer.canvasPointOf(at.x + axis.x * 1000, at.y + axis.y * 1000, floor + at.z)
      if (!p) continue
      const len = Math.hypot(p.x - o.x, p.y - o.y)
      if (len < 2) continue
      const score = ((p.x - o.x) * want.x + (p.y - o.y) * want.y) / len
      if (!best || score > best.score) best = { axis, score }
    }
    return best && best.score > 0.3 ? best.axis : northUp
  }

  /** Start sliding a branch if the pointer is on one and editing is live; null otherwise (the camera moves instead). */
  beginSlideAt(clientX: number, clientY: number): SlideDrag | null {
    if (!this.viewer || !this.canEdit()) return null
    const hit = this.viewer.pickNative(clientX, clientY)
    const tapId = hit ? this.tapFor(hit.elementId) : null
    return tapId ? this.beginSlide(tapId) : null
  }

  /** The tap a picked element slides with: the tap itself or the first branch piece hosted by it. */
  tapFor(elementId: ElementId): string | null {
    const view = this.view
    if (!view) return null
    const el = view.elements[elementId]
    if (!el) return null
    if (el.kind === 'tap') return el.id
    // Routed runs: a tap, tee or wye itself, or the first piece of its branch.
    if (el.kind === 'run_fitting' && el.host) return el.id
    if (el.kind === 'run_segment') {
      for (const link of [el.links.start, el.links.end]) {
        const other = link ? view.elements[link.elementId] : undefined
        if (other?.kind === 'run_fitting' && other.host) return other.id
      }
      return null
    }
    for (const c of view.connections) {
      const [a, b] = [c.a, c.b]
      const other = a.elementId === elementId ? b : b.elementId === elementId ? a : null
      if (other && view.elements[other.elementId]?.kind === 'tap') return other.elementId
    }
    return null
  }

  // ------------------------------------------------------------ editing

  beginSlide(tapId: string): SlideDrag | null {
    if (!this.client || !this.viewer) return null
    const routed = this.view?.elements[tapId]
    if (routed?.kind === 'run_fitting') return { tapId, elevationMm: (this.levelElevation(routed.levelId) ?? 0) + routed.position.z }
    const elevations = this.viewerModule?.DEFAULT_ELEVATIONS
    return { tapId, elevationMm: (elevations?.levelElevationMm('L1') ?? 0) + (elevations?.ductCenterAboveFloorMm ?? 3200) }
  }

  /** Local preview only; nothing is sent until the drag ends. */
  previewSlide(drag: SlideDrag, clientX: number, clientY: number): { s: number; limited: boolean; reason: string | null } | null {
    const kernel = this.kernel
    const view = this.view
    if (!kernel || !view || !this.viewer) return null
    const point = this.viewer.planPointAt(clientX, clientY, drag.elevationMm)
    const tap = view.elements[drag.tapId]
    if (!point || !tap) return null
    const hostId = tap.kind === 'tap' ? tap.hostId : tap.kind === 'run_fitting' ? tap.host?.segmentId : undefined
    const host = hostId ? view.elements[hostId] : undefined
    if (!host || (host.kind !== 'duct_segment' && host.kind !== 'run_segment')) return null
    const axis = { x: host.end.x - host.start.x, y: host.end.y - host.start.y }
    const length = Math.hypot(axis.x, axis.y)
    if (length === 0) return null
    const along = ((point.x - host.start.x) * axis.x + (point.y - host.start.y) * axis.y) / length
    const snapped = Math.round(along / 25.4) * 25.4
    const limit = kernel.slideLimit(view, drag.tapId, snapped)
    const result = kernel.executeCommand(view, { type: 'slide_branch', tapId: drag.tapId, s: limit.accepted })
    if (result.ok && this.accepted) {
      this.preview = result.model
      this.viewer.setAuthored(this.accepted, this.preview)
    }
    const limited = limit.binding !== null
    this.client?.publishPresence({ kind: 'dragging_tap', tapId: drag.tapId, s: limit.accepted, limited, binding: limit.binding?.message ?? null })
    return { s: limit.accepted, limited, reason: limit.binding ? (limit.binding.code === 'locked' ? limit.binding.message : operatorMessage(limit.binding.code)) : null }
  }

  /** Tell everyone what you're doing (e.g. editing a note, which others then can't open). Never a model edit. */
  publishActivity(activity: Presence['activity']) {
    this.client?.publishPresence(activity)
  }

  endSlide(drag: SlideDrag, s: number | null) {
    this.preview = null
    this.client?.publishPresence({ kind: 'idle' })
    if (s !== null && this.client) {
      const res = this.sendToClient(this.client, { type: 'slide_branch', tapId: drag.tapId, s })
      if (!res.ok) this.events.onActivity(res.error.code === 'locked' ? res.error.message : operatorMessage(res.error.code))
    }
    this.redraw()
  }

  resizeRun(segmentId: string, widthMm: number, heightMm: number): string | null {
    if (!this.client) return "Live editing isn't connected, so changes can't be saved."
    const res = this.sendToClient(this.client, { type: 'resize_run', segmentId, profile: { shape: 'rect', width: widthMm, height: heightMm } })
    return res.ok ? null : res.error.code === 'locked' ? res.error.message : operatorMessage(res.error.code)
  }

  canEdit(): boolean {
    return this.client !== null && this.editPausedReason() === null
  }

  // ------------------------------------------------------------ parts

  private submit(command: Command): string | null {
    if (!this.client) return "Live editing isn't connected, so changes can't be saved."
    const res = this.sendToClient(this.client, command)
    return res.ok ? null : res.error.message
  }

  /** An empty model gets its starter Level 1 once it is live and editable (the kernel makes it idempotent across people and reconnects). */
  private starterLevelAsked = false
  private askStarterLevel() {
    if (this.starterLevelAsked || this.status !== 'live' || !this.client) return
    const command = starterLevelCommand(this.accepted, this.client.serverProtocolOf()?.features ?? [], this.canEdit())
    if (!command) return
    this.starterLevelAsked = true
    const refused = this.submit(command)
    if (refused !== null) console.error('[model-session] starter Level 1 was not added', { refused })
  }

  private settleOutcome(request: CommandRequest, outcome: CommitOutcome) {
    const mine = request.actor.id === this.actor.id && request.clientSessionId === this.client?.clientSessionId
    const undo = this.undoing.get(request.idempotencyKey)
    this.undoing.delete(request.idempotencyKey)
    if (this.predictedIds.has(request.idempotencyKey)) {
      const ended = this.predictedIds.get(request.idempotencyKey)
      this.predictedIds.delete(request.idempotencyKey)
      this.endedIds = ended && this.endedIds ? [...this.endedIds, ...ended] : null
    }
    if (request.command.type === 'ensure_starter_level') {
      // Not an edit of yours to undo; a lost race (another person's open made it) says nothing.
      if (outcome.status === 'rejected' && !isStarterLevelRace(request.command, outcome.error.code)) this.events.onActivity(`Level 1 wasn't added: ${outcome.error.message}`)
      return
    }
    if (outcome.status === 'rejected') {
      const notUnderstood = this.notUnderstood.delete(request.idempotencyKey)
      const kernelWords = outcome.error.code === 'has_dependents' || outcome.error.code === 'undo_refused' || outcome.error.code === 'conflict' || outcome.error.code === 'already_exists' || outcome.error.code === 'in_use' || outcome.error.code === 'locked'
      const message = notUnderstood || kernelWords ? outcome.error.message : operatorMessage(outcome.error.code)
      this.events.onActivity(notUnderstood ? message : `Your change wasn't saved. ${message}`)
      this.events.onRefused?.(message)
      this.emitUndoState()
      return
    }
    if (!mine) return
    // Views/sheets edits are on the document undo stack already (taken when sent).
    if (this.kernel && isDocumentCommand(this.kernel, request.command)) return
    if (undo?.direction === 'undo') this.redoStack.push({ revision: outcome.revision, label: undo.label, seq: ++this.undoSeq })
    else if (undo?.direction === 'redo') this.undoStack.push({ revision: outcome.revision, label: undo.label, seq: ++this.undoSeq })
    else {
      this.undoStack.push({ revision: outcome.revision, label: describeCommand(this.accepted, request.command), seq: ++this.undoSeq })
      if (this.undoStack.length > 100) this.undoStack.shift()
      this.redoStack = []
    }
    this.emitUndoState()
    if (!undo && this.view) this.events.onSaved?.(request.command, this.view)
  }

  undoState(): UndoState {
    return { undo: this.newestUndo()?.label ?? null, redo: this.redoStack[this.redoStack.length - 1]?.label ?? null }
  }

  /** Your newest undoable edit, from either stack. */
  private newestUndo(): { readonly kind: 'model' | 'document'; readonly label: string } | null {
    const model = this.undoStack[this.undoStack.length - 1]
    const doc = this.documentUndoStack[this.documentUndoStack.length - 1]
    if (doc && (!model || doc.seq > model.seq)) return { kind: 'document', label: doc.label }
    return model ? { kind: 'model', label: model.label } : null
  }

  private emitUndoState() {
    this.events.onUndoState?.(this.undoState())
  }

  /** Undo the person's latest saved change; the model refuses (and says why) if someone has changed it since. */
  undo(): string | null {
    if (this.newestUndo()?.kind === 'document') {
      const res = this.undoDocumentEdit()
      this.emitUndoState()
      if (res.ok) {
        this.events.onActivity(`Undid ${res.label}.`)
        return null
      }
      this.events.onRefused?.(res.message)
      return res.message
    }
    return this.step('undo')
  }

  redo(): string | null {
    return this.step('redo')
  }

  private step(direction: 'undo' | 'redo'): string | null {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack
    const entry = stack.pop()
    if (!entry || !this.client) return direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'
    // An undo puts back what that revision changed.
    const undone = this.client.committed(entry.revision)
    const res = this.sendToClient(this.client, { type: 'undo', revision: entry.revision }, undone ? touchedIds(undone.elements.map((e) => e.id), undone) : null)
    if (!res.ok) {
      this.emitUndoState()
      this.events.onRefused?.(res.error.message)
      return res.error.message
    }
    this.undoing.set(res.request.idempotencyKey, { direction, label: entry.label })
    this.emitUndoState()
    return null
  }

  createLevel(name: string, elevationMm: number): string | null {
    return this.submit({ type: 'create_level', levelId: newElementId('lvl'), name, elevationMm })
  }

  armPlacement(spec: PlacementSpec | null) {
    this.placement = spec
    this.plannedPartId = null
    this.pendingPlacement = null
    this.referenceHit = null
    this.viewer?.setGhost(null)
  }

  /**
   * Place a part from "Not placed yet" (k1-planned): the same ghost, surfaces, snapping and
   * hosting as Place part (a slab, a linked roof, a mounting plane, else the level's floor
   * plane), drawn with the part's own type. The click (`commitPlacement`) sends
   * `place_planned_part`, so the part keeps its id, circuits and values, and the placement
   * ends once it is sent. `at`: the level and height to start from (default: the level the part
   * was planned for and its category's usual height). Returns why it can't be placed, or null.
   * `armPlacement(null)` stops it.
   */
  armPlannedPlacement(partId: string, at: { readonly levelId?: string; readonly heightMm?: number; readonly rotationDeg?: number } = {}): string | null {
    const view = this.view
    if (!view) return "The model hasn't loaded yet."
    const part = view.elements[partId]
    if (part?.kind !== 'part') return 'That part is no longer in the model.'
    const name = part.mark.trim() || 'That part'
    if (part.planned === undefined) return `${name} is already placed; move it instead.`
    const type = view.elements[part.typeId]
    if (type?.kind !== 'part_type') return `${name} has no part type in this model, so there is nothing to draw.`
    const levelId = [at.levelId, part.planned.levelHint].find((id) => id !== undefined && view.elements[id]?.kind === 'level')
    if (!levelId) return 'Choose a level to place it on; this model has no level for it yet.'
    this.armPlacement({
      typeId: type.id,
      definition: type.definition,
      inModel: true,
      levelId,
      heightMm: at.heightMm ?? defaultHeightMm(type.definition.category),
      rotationDeg: at.rotationDeg ?? 0,
    })
    this.plannedPartId = part.id
    return null
  }

  /** The part from "Not placed yet" being placed, or null (Place part, or nothing armed). */
  plannedPlacement(): ElementId | null {
    return this.plannedPartId
  }

  /** Frame these plan points (a proposal's rooms) with a margin, in plan or 3D. */
  framePlan(points: readonly Vec2[], marginMm = 1500) {
    const viewer = this.viewer
    if (!viewer || points.length === 0) return
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    void viewer.framePlanRect({ x: Math.min(...xs) - marginMm, y: Math.min(...ys) - marginMm }, { x: Math.max(...xs) + marginMm, y: Math.max(...ys) + marginMm }).catch((err: unknown) => console.error('[ModelSession] framing the proposal rooms failed', err))
  }

  /**
   * A proposal's devices as ghosts (Electrical › Propose receptacles): each
   * drawn as a 12" marker at its height so it reads in plan; nothing is sent.
   * null clears them.
   */
  showProposalGhosts(items: readonly ProposalGhost[] | null) {
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    const kernel = this.kernel
    if (!viewer || !viewerModule || !kernel) return
    if (!items || items.length === 0) return viewer.setGhost(null)
    const solids = items.flatMap((g, i) => {
      const elevation = this.levelElevation(g.levelId)
      if (elevation === null) return []
      const definition = { ...g.definition, geometry: [{ kind: 'box' as const, center: [0, 0, 80] as [number, number, number], size: [305, 305, 160] as [number, number, number] }] }
      const type: PartTypeElement = { id: kernel.asElementId(g.typeId), kind: 'part_type', version: 0, authoredRev: {}, definition }
      const part: PartInstance = { id: kernel.asElementId(`proposal-ghost-${i}`), kind: 'part', version: 0, authoredRev: {}, typeId: type.id, levelId: kernel.asElementId(g.levelId), position: g.position, offsetMm: g.offsetMm, rotationDeg: g.rotationDeg, mark: '', values: {} }
      return viewerModule.partSolids(part, type, elevation)
    })
    viewer.setGhost(solids)
  }

  private snapTargetsFor(levelId: string, exclude: readonly string[]): SnapTarget[] {
    const view = this.accepted ?? this.view
    const kernel = this.kernel
    const level = view?.elements[levelId]
    if (!view || !kernel || level?.kind !== 'level') return []
    const key = exclude.join(',')
    if (this.targets && this.targets.view === view && this.targets.levelId === levelId && this.targets.exclude === key) return this.targets.list
    // Only that level's area: parts on a level live in the area named after it.
    const list = snapTargets(kernel.sliceModel(view, { areas: [{ level: level.name }] }), levelId, new Set(exclude))
    this.targets = { view, levelId, exclude: key, list }
    return list
  }

  /** Ask the linked models what is under the pointer (at most one question at a time); used for snapping. */
  private probeReference(clientX: number, clientY: number) {
    const viewer = this.viewer
    if (!viewer || this.referencePickBusy) return
    this.referencePickBusy = true
    void viewer
      .pick(clientX, clientY)
      .then((pick) => {
        const kernelPoint = pick && pick.source === 'reference' && this.viewerModule ? this.viewerModule.sceneToKernel(pick.point) : null
        this.referenceHit = kernelPoint ? { x: clientX, y: clientY, point: kernelPoint } : null
      })
      .catch((err: unknown) => console.error('[ModelSession] reference snap probe failed', err))
      .finally(() => {
        this.referencePickBusy = false
      })
  }

  private referenceNear(clientX: number, clientY: number, raw: Vec2): Vec2 | null {
    const hit = this.referenceHit
    if (!hit || Math.hypot(hit.x - clientX, hit.y - clientY) > 6) return null
    return Math.hypot(hit.point.x - raw.x, hit.point.y - raw.y) < 600 ? hit.point : null
  }

  /** A linked model's wall ends, corners and faces round a plan point on a level (Place and Route snap to them); null with none loaded. */
  private linkedNear(levelId: string, at: Vec2): ReferenceSnapCandidates | null {
    return linkedSnapNear(this.view, levelId, at, Math.max(POINT_SNAP_MM, ALIGN_SNAP_MM))
  }

  private levelElevation(levelId: string): number | null {
    const level = this.view?.elements[levelId]
    return level?.kind === 'level' ? level.elevationMm : null
  }

  private ghostFor(part: PartInstance, type: PartTypeElement, levelElevationMm: number) {
    const viewerModule = this.viewerModule
    if (!viewerModule) return
    this.viewer?.setGhost(viewerModule.partSolids(part, type, levelElevationMm))
  }

  /**
   * Live preview of the armed part under the pointer; nothing is sent. Returns the hint to show.
   * The part goes on the surface under the pointer (a linked roof, a floor);
   * with nothing there, or Shift held, on the chosen level's floor plane.
   */
  previewPlacement(clientX: number, clientY: number): string | null {
    const spec = this.placement
    const viewer = this.viewer
    const kernel = this.kernel
    if (!spec || !viewer || !kernel) return null
    const elevation = this.levelElevation(spec.levelId)
    if (elevation === null) return 'Choose a level to place on.'
    const hit = this.surfacesOff() ? null : viewer.pickSurface(clientX, clientY, (id) => this.view?.elements[id] !== undefined)
    const onSurface = hit ? placementOnSurface(hit, this.levels(), spec.heightMm, spec.levelId) : null
    const picked = hit?.elementId ? this.view?.elements[hit.elementId] : undefined
    // A mounting plane under the pointer is offered even when its own mesh wasn't hit (a linked floor or roof
    // beneath it, or nothing at all): it is above whatever the pick found, so it is what the person sees first.
    const under = this.shiftHeld || !this.view ? null : kernel.mountingPlaneUnder(this.view, (mm) => viewer.planPointAt(clientX, clientY, mm))
    const plane = picked?.kind === 'mounting_plane' ? { plane: picked, point: { x: hit?.point.x ?? 0, y: hit?.point.y ?? 0 } } : under && (!hit || under.elevationMm > hit.point.z) ? under : null
    let target: { levelId: string; raw: Vec2; offsetMm: number; where: string; reference: Vec2 | null; planeId?: string }
    if (plane) {
      // On a mounting plane: at its height, and it moves with the plane.
      target = { levelId: plane.plane.levelId, raw: plane.point, offsetMm: plane.plane.heightMm, where: `On mounting plane ${plane.plane.name}, ${feetInches(plane.plane.heightMm)} up`, reference: null, planeId: plane.plane.id }
    } else if (onSurface) {
      target = { levelId: onSurface.levelId, raw: onSurface.position, offsetMm: onSurface.offsetMm, where: onSurface.where, reference: null }
    } else {
      // The point at the part's own height, so the preview sits under the cursor in a tilted 3D view.
      const raw = viewer.planPointAt(clientX, clientY, elevation + spec.heightMm)
      if (!raw) {
        this.viewer?.setGhost(null)
        this.pendingPlacement = null
        return 'Point at a floor, a roof or the model to place it.'
      }
      this.probeReference(clientX, clientY)
      const level = this.view?.elements[spec.levelId]
      const levelName = level?.kind === 'level' ? level.name : 'the level'
      const where = this.planeLocked ? `Work plane locked (L unlocks): ${feetInches(spec.heightMm)} above ${levelName}` : `${this.shiftHeld ? 'Shift' : 'Nothing under the pointer'}: on ${levelName}'s floor plane, ${feetInches(spec.heightMm)} up`
      target = { levelId: spec.levelId, raw, offsetMm: spec.heightMm, where, reference: this.referenceNear(clientX, clientY, raw) }
    }
    const snapped = snapPoint(target.raw, this.snapTargetsFor(target.levelId, []), target.reference, this.workFrame ?? undefined, this.linkedNear(target.levelId, target.raw))
    const type: PartTypeElement = { id: kernel.asElementId(spec.typeId), kind: 'part_type', version: 0, authoredRev: {}, definition: spec.definition }
    const part: PartInstance = {
      id: kernel.asElementId('placement-preview'),
      kind: 'part',
      version: 0,
      authoredRev: {},
      typeId: type.id,
      levelId: kernel.asElementId(target.levelId),
      position: snapped.point,
      offsetMm: target.offsetMm,
      rotationDeg: spec.rotationDeg,
      mark: '',
      values: {},
    }
    this.ghostFor(part, type, this.levelElevation(target.levelId) ?? elevation)
    const hosted = !target.planeId && onSurface && hit ? hostForPlacement(hit, spec.heightMm, spec.definition.category, (id) => this.view?.elements[id]?.kind === 'slab', (ref) => this.referenceLabels.get(ref) ?? 'Linked model') : null
    this.pendingPlacement = { position: snapped.point, levelId: target.levelId, offsetMm: target.offsetMm, hosted, ...(target.planeId ? { planeId: target.planeId } : {}) }
    return `${target.where}${hosted ? `, standing on ${this.hostLabel(hosted.host)}` : ''} (${snapHint(snapped).toLowerCase()}). Click to place, R or Space to rotate, L to lock the work plane, Esc to stop.`
  }

  private pendingPlacement: { readonly position: Vec2; readonly levelId: string; readonly offsetMm: number; readonly hosted: ReturnType<typeof hostForPlacement>; readonly planeId?: string } | null = null

  /**
   * Wait until the surface under this pixel is known, linked models included
   * (a click can beat its hover cast), so the next preview or click uses it.
   */
  surfaceSettledAt(clientX: number, clientY: number): boolean {
    const viewer = this.viewer
    return !viewer || this.surfacesOff() || viewer.surfaceSettledAt(clientX, clientY)
  }

  async settleSurfaceAt(clientX: number, clientY: number): Promise<void> {
    const viewer = this.viewer
    if (!viewer || this.surfacesOff()) return
    await viewer.pickSurfaceAsync(clientX, clientY, (id) => this.view?.elements[id] !== undefined)
  }

  private hostLabel(host: PartHost): string {
    if (host.kind === 'slab') return 'the slab'
    if (host.kind === 'linked') return host.name
    return this.view ? hostName(this.view, host) : host.elementId
  }

  /** Place the armed part where the preview showed it. Returns the plain reason when the model refuses. */
  commitPlacement(): string | null {
    const spec = this.placement
    const at = this.pendingPlacement
    if (!spec || !at) return null
    const paused = this.refusePaused()
    if (paused) return paused
    const plannedId = this.plannedPartId
    if (plannedId) {
      const refused = this.submit({
        type: 'place_planned_part',
        partId: plannedId,
        levelId: at.levelId,
        position: at.position,
        ...(at.planeId ? { planeId: at.planeId } : { offsetMm: at.offsetMm }),
        rotationDeg: spec.rotationDeg,
        ...(at.hosted ? { host: at.hosted.host, ...(at.hosted.curbMm > 0 ? { curbMm: at.hosted.curbMm } : {}) } : {}),
      })
      // One part, one placement: it is drawn now, so the ghost goes.
      if (!refused) this.armPlacement(null)
      return refused
    }
    return this.submit({
      type: 'place_part',
      partId: newElementId('p'),
      typeId: spec.typeId,
      ...(spec.inModel ? {} : { partType: spec.definition }),
      levelId: at.levelId,
      position: at.position,
      ...(at.planeId ? { planeId: at.planeId } : { offsetMm: at.offsetMm }),
      rotationDeg: spec.rotationDeg,
      ...(at.hosted ? { host: at.hosted.host, ...(at.hosted.curbMm > 0 ? { curbMm: at.hosted.curbMm } : {}) } : {}),
    })
  }

  /**
   * A placement click whose surface (a linked model's cast) hasn't come back
   * yet. The click places the part that was armed when it was made: Esc, a
   * tool switch or another part picked while it waits stop the next
   * placement, not this one (Undo takes it back). `act` previews and commits
   * (`previewPlacement` + `commitPlacement`); whatever was armed meanwhile is
   * armed again afterwards. Null when nothing was armed at the click.
   */
  async placeWhenSurfaceKnown<T>(clientX: number, clientY: number, act: () => T): Promise<T | null> {
    const spec = this.placement
    const plannedId = this.plannedPartId
    if (!spec) return null
    await this.settleSurfaceAt(clientX, clientY)
    const now = this.placement
    const nowPlanned = this.plannedPartId
    if (now === spec && nowPlanned === plannedId) return act()
    this.placement = spec
    this.plannedPartId = plannedId
    try {
      return act()
    } finally {
      this.armPlacement(now)
      this.plannedPartId = nowPlanned
    }
  }

  placing(): boolean {
    return this.placement !== null
  }

  rotatePlacement(deg: number): PlacementSpec | null {
    if (!this.placement) return null
    this.placement = { ...this.placement, rotationDeg: (((this.placement.rotationDeg + deg) % 360) + 360) % 360 }
    return this.placement
  }

  /**
   * The placed part under the pointer (a quick native pick, no linked models),
   * else the power-carrying part (a device, equipment, a panel) whose
   * insertion point is nearest on screen within 12 px: a receptacle in a
   * zoomed-out plan is under a pixel, too small for a ray. Null when there is
   * none. The candidates are listed once per model state.
   */
  partIdAt(clientX: number, clientY: number): string | null {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    const viewerModule = this.viewerModule
    if (!viewer || !view) return null
    const hit = viewer.pickNative(clientX, clientY)
    const el = hit ? view.elements[hit.elementId] : undefined
    if (el?.kind === 'part') return el.id
    const powerPack = this.powerPack
    if (!kernel || !viewerModule || !powerPack) return null
    if (this.powerParts?.view !== view) {
      const list: { id: string; at: ReturnType<ViewerModule['kernelToScene']> }[] = []
      for (const p of kernel.elementValues(view.elements)) {
        // A part not placed yet sits at a placeholder (its level's origin); nothing to pick there.
        if (p.kind !== 'part' || p.planned !== undefined) continue
        if (!powerPack.powerPickable(view.elements, p)) continue
        const floor = this.levelElevation(p.levelId) ?? 0
        list.push({ id: p.id, at: viewerModule.kernelToScene(p.position.x, p.position.y, floor + p.offsetMm) })
      }
      this.powerParts = { view, list }
    }
    let best: { id: string; d: number } | null = null
    for (const c of this.powerParts.list) {
      const s = viewer.clientPointOf(c.at)
      if (!s) continue
      const d = Math.hypot(s.x - clientX, s.y - clientY)
      if (d <= 12 && (!best || d < best.d)) best = { id: c.id, d }
    }
    return best?.id ?? null
  }

  /** Start moving the part under the pointer; null when there is none (the camera moves instead). */
  beginMoveAt(clientX: number, clientY: number): string | null {
    const viewer = this.viewer
    const view = this.view
    if (!viewer || !view || !this.client) return null
    const hit = viewer.pickNative(clientX, clientY)
    const el = hit ? view.elements[hit.elementId] : undefined
    if (!el || el.kind !== 'part' || this.refusePaused()) return null
    const elevation = this.levelElevation(el.levelId)
    if (elevation === null) return null
    const from = viewer.planPointAt(clientX, clientY, elevation)
    if (!from) return null
    this.moving = { ids: [el.id], levelId: el.levelId, from, elevationMm: elevation, delta: null }
    return partLabel(view, el)
  }

  previewMove(clientX: number, clientY: number): string | null {
    const moving = this.moving
    const viewer = this.viewer
    const view = this.view
    if (!moving || !viewer || !view) return null
    const id = moving.ids[0]
    const part = id ? view.elements[id] : undefined
    const type = part?.kind === 'part' ? view.elements[part.typeId] : undefined
    if (!part || part.kind !== 'part' || type?.kind !== 'part_type') return null
    const p = viewer.planPointAt(clientX, clientY, moving.elevationMm)
    if (!p) return null
    const raw = { x: part.position.x + p.x - moving.from.x, y: part.position.y + p.y - moving.from.y }
    const snapped = snapPoint(raw, this.snapTargetsFor(moving.levelId, moving.ids), null, this.workFrame ?? undefined)
    moving.delta = { x: snapped.point.x - part.position.x, y: snapped.point.y - part.position.y }
    this.ghostFor({ ...part, position: snapped.point }, type, moving.elevationMm)
    return `${snapHint(snapped)}, ${feetInches(Math.hypot(moving.delta.x, moving.delta.y))} from where it was. Release to save, Esc to cancel.`
  }

  endMove(commit: boolean): string | null {
    const moving = this.moving
    this.moving = null
    this.viewer?.setGhost(null)
    if (!commit || !moving?.delta || (moving.delta.x === 0 && moving.delta.y === 0)) return null
    return this.refusePaused() ?? this.submit({ type: 'move_elements', ids: [...moving.ids], delta: moving.delta })
  }

  isMoving(): boolean {
    return this.moving !== null
  }

  /** Measure tool: first click starts, second click answers with the plan distance. */
  measureAt(clientX: number, clientY: number, elevationMm: number): string | null {
    const p = this.viewer?.planPointAt(clientX, clientY, elevationMm)
    if (!p) return null
    if (!this.measureFrom) {
      this.measureFrom = p
      return 'Click the second point.'
    }
    const from = this.measureFrom
    this.measureFrom = null
    const dx = p.x - from.x
    const dy = p.y - from.y
    return `${feetInches(Math.hypot(dx, dy))} (${feetInches(Math.abs(dx))} east-west, ${feetInches(Math.abs(dy))} north-south). Click to measure again.`
  }

  resetMeasure() {
    this.measureFrom = null
  }

  // ------------------------------------------------------------ routing

  /**
   * Arm (or disarm) the Route tool. Changing size or system keeps the points
   * clicked so far; changing the height mid-route rises or drops there (45° or
   * straight, as the route says), at the last point.
   */
  armRoute(spec: RouteSpec | null): string | null {
    if (!spec || (this.routeSpec && spec.levelId !== this.routeSpec.levelId)) this.routing = null
    const old = this.routeSpec
    let hint: string | null = null
    // Only a changed Height field rises or drops: a route that took its height from a trunk or surface keeps it while the size or system changes.
    const typedBefore = this.routePanelElevationMm ?? old?.elevationMm
    this.routePanelElevationMm = spec?.elevationMm ?? null
    const heightTyped = spec !== null && typedBefore !== undefined && Math.abs(spec.elevationMm - typedBefore) > 0.5
    const fromMm = this.currentRouteElevation(old)
    if (spec && old && this.routing && heightTyped && Math.abs(spec.elevationMm - fromMm) > 0.5) {
      const last = this.routing.points[this.routing.points.length - 1]
      if (last) {
        this.routing.points[this.routing.points.length - 1] = { ...last, elevationMm: spec.elevationMm }
        hint = `${spec.elevationMm > fromMm ? 'Rises' : 'Drops'} to ${feetInches(spec.elevationMm)} at the last point (${riseHint(spec.riseStyle)}).`
      } else {
        hint = 'Click a first point along the run before changing its height; the run leaves a connector at the connector\'s height.'
      }
      // The route keeps the height it started at; the change is the rise just added.
      this.routeSpec = { ...spec, elevationMm: old.elevationMm }
    } else {
      this.routeSpec = spec
    }
    if (!spec) this.clearRoutePreview()
    return hint
  }

  routePointCount(): number {
    const r = this.routing
    return r ? r.points.length + (r.from ? 1 : 0) : 0
  }

  /** Height the next leg is drawn at: the last rise or drop, else where the route started. */
  currentRouteElevation(spec: RouteSpec | null = this.routeSpec): number {
    const pts = this.routing?.points ?? []
    for (let i = pts.length - 1; i >= 0; i--) {
      const e = pts[i]?.elevationMm
      if (e !== undefined) return e
    }
    return this.routing?.startElevationMm ?? spec?.elevationMm ?? 0
  }

  /** The working angle (and grid origin) the route snaps and the placement grid follow. */
  setWorkFrame(frame: WorkFrame | null): void {
    this.workFrame = frame
  }

  setAxisLock(lock: AxisLock): string {
    this.axisLock = this.axisLock === lock ? 'auto' : lock
    return this.axisLock === 'auto' ? 'Axis lock off: 45° steps, and vertical near the last point.' : `Locked to ${this.axisLock.toUpperCase()}${this.axisLock === 'z' ? ': move up or down to rise or drop' : ''}. Press it again to unlock.`
  }

  axisLockState(): AxisLock {
    return this.axisLock
  }

  setShiftHeld(down: boolean) {
    this.shiftHeld = down
  }

  /**
   * Lock the work plane (Revit's "work plane"; L while placing or routing):
   * place and route at the height typed for the tool, whatever is under the
   * pointer, as holding Shift does, until it is unlocked. Returns the hint.
   */
  togglePlaneLock(): string {
    this.planeLocked = !this.planeLocked
    return this.planeLocked
      ? 'Work plane locked: placing and routing stay at the height you typed, whatever is under the pointer. L unlocks.'
      : 'Work plane unlocked: placing and routing follow the floor, ceiling or wall under the pointer again.'
  }

  planeLockOn(): boolean {
    return this.planeLocked
  }

  /** Shift held or the work plane locked: the surface under the pointer is not used. */
  private surfacesOff(): boolean {
    return this.shiftHeld || this.planeLocked
  }

  /** The badge at the cursor while routing: which axis the next leg runs along. */
  routeAxisBadge(): string | null {
    return this.routing ? `${axisBadge(this.lastAxis, this.axisLock)}${this.planeLocked ? ' · plane locked' : ''}` : null
  }

  /**
   * The "+" buttons for the selected piece, in canvas px: one past each open
   * end ("Continue from this end") and, on a level elbow between two straight
   * pieces, one on each side a leg could run straight on through ("Add a tee
   * here"). Each is one named operation; nothing is guessed.
   */
  plusHandles(): PlusHandle[] {
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    const view = this.view
    const kernel = this.kernel
    const el = this.selectedId ? view?.elements[this.selectedId] : undefined
    if (!viewer || !viewerModule || !view || !kernel || !this.canEdit() || (el?.kind !== 'run_segment' && el?.kind !== 'run_fitting')) return []
    const floor = this.levelElevation(el.levelId) ?? 0
    // On screen, a few px out from `at` the way `dir` points.
    const beyond = (at: RunPoint, dir: RunPoint): { x: number; y: number } | null => {
      const a = viewer.screenPointOf(viewerModule.kernelToScene(at.x, at.y, floor + at.z))
      const b = viewer.screenPointOf(viewerModule.kernelToScene(at.x + dir.x * 600, at.y + dir.y * 600, floor + at.z + dir.z * 600))
      if (!a || !b) return null
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      return len < 1 ? { x: a.x + 22, y: a.y } : { x: a.x + ((b.x - a.x) / len) * 22, y: a.y + ((b.y - a.y) / len) * 22 }
    }
    const out: PlusHandle[] = []
    for (const spot of plusSpots(view.elements, el, kernel, this.serverFeatures() ?? [])) {
      const at = beyond(spot.at, spot.toward)
      if (at) out.push({ ...at, kind: spot.kind, elementId: spot.elementId, port: spot.port, label: spot.label, ...(spot.face ? { face: spot.face } : {}) })
    }
    if (el.kind === 'run_segment') {
      for (const side of slopedSideHandles(view.elements, el, kernel)) {
        const p = side.at
        const at = beyond(p, { x: side.left.x * side.side, y: side.left.y * side.side, z: 0 })
        if (at) out.push({ ...at, kind: 'side', elementId: el.id, port: side.side === 1 ? 'left' : 'right', s: side.s, label: side.label })
      }
    }
    return out
  }

  /**
   * Inherit (Revit's "inherit elevation"): what is under the pointer gives the
   * route its height there, and a pipe or fitting its size, system and slope.
   * A part gives the height of its nearest free connector. A string is why
   * nothing was taken.
   */
  inheritAt(clientX: number, clientY: number): InheritPick | string {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    if (!viewer || !view || !kernel) return 'The model is still opening; try again in a moment.'
    const hit = viewer.pickNative(clientX, clientY, (id) => view.elements[id] !== undefined)
    const el = hit ? view.elements[hit.elementId] : undefined
    if (!el) return 'Nothing to inherit from there: click a pipe, a fitting or a part.'
    const floor = this.levelElevation(el.kind === 'run_segment' || el.kind === 'run_fitting' || el.kind === 'part' ? el.levelId : '') ?? 0
    if (el.kind === 'run_segment') {
      const mid = (el.start.z + el.end.z) / 2
      const at = viewer.planPointAt(clientX, clientY, floor + mid)
      const ax = el.end.x - el.start.x
      const ay = el.end.y - el.start.y
      const len2 = ax * ax + ay * ay
      const t = !at || len2 < 1 ? 0.5 : Math.min(1, Math.max(0, ((at.x - el.start.x) * ax + (at.y - el.start.y) * ay) / len2))
      const slope = el.domain === 'pipe' ? kernel.slopeInPerFt(el) : 0
      return { label: kernel.runLabel(view.elements, el), levelId: el.levelId, elevationMm: Math.round((el.start.z + (el.end.z - el.start.z) * t) * 1000) / 1000, element: el, ...(slope > 0.005 ? { slopeInPerFt: slope } : {}) }
    }
    if (el.kind === 'run_fitting') return { label: kernel.runLabel(view.elements, el), levelId: el.levelId, elevationMm: el.position.z, element: el }
    if (el.kind === 'part') {
      const type = view.elements[el.typeId]
      if (type?.kind !== 'part_type') return "That part's type isn't loaded; reload and try again."
      const domain = this.routeSpec ? kernel.connectorDomainOf(this.routeSpec.domain) : null
      const at = viewer.planPointAt(clientX, clientY, floor + el.offsetMm)
      const near = kernel
        .resolveConnectors(type.definition, el.values)
        .filter((c) => (!domain || c.domain === domain) && !el.links?.[c.id])
        .map((c) => ({ c, w: kernel.worldConnector(el, c) }))
        .sort((a, b) => (at ? Math.hypot(a.w.position.x - at.x, a.w.position.y - at.y) - Math.hypot(b.w.position.x - at.x, b.w.position.y - at.y) : 0))[0]
      if (!near) return `${kernel.partLabelOf(view.elements, el)} has no free connector of this kind to inherit from.`
      return { label: `${kernel.partLabelOf(view.elements, el)}'s ${near.c.label.toLowerCase()}`, levelId: el.levelId, elevationMm: Math.round(near.w.position.z * 1000) / 1000, element: null }
    }
    return 'Inherit takes a pipe or other run, a fitting or a part: click one of those.'
  }

  /** The "+" on a sloped pipe's side: begin the armed route as a branch off it there (the next click picks the side for good). */
  startBranchOnSide(elementId: string, s: number): string {
    const spec = this.routeSpec
    const view = this.view
    const kernel = this.kernel
    if (!spec || !view || !kernel) return 'Choose what to route first.'
    const el = view.elements[elementId]
    if (el?.kind !== 'run_segment' || el.domain !== spec.domain) return 'That run has changed; select it again.'
    const len = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y)
    if (len < 1) return 'That run has changed; select it again.'
    const t = Math.min(1, Math.max(0, s / len))
    const target = this.branchTarget(el, { x: el.start.x + (el.end.x - el.start.x) * t, y: el.start.y + (el.end.y - el.start.y) * t }, spec)
    if (!target) return `A branch can't leave the ${kernel.runLabel(view.elements, el)} from its side.`
    this.routing = this.startOn(target)
    return `Branching off ${target.label}. Click the next point on the side it leaves; the branch falls toward the ${kernel.runLabel(view.elements, el)}. Esc cancels.`
  }

  /**
   * The "+" on the selected level straight run's top and bottom (canvas px),
   * where a branch would leave that face: only on a model server that takes a
   * branch off a face, never on a sloped or vertical piece.
   */
  faceHandles(): FaceHandle[] {
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    const view = this.view
    const kernel = this.kernel
    const el = this.selectedId ? view?.elements[this.selectedId] : undefined
    if (!viewer || !viewerModule || !view || !kernel || !this.canEdit() || el?.kind !== 'run_segment') return []
    if (!(this.serverFeatures() ?? []).includes(kernel.ROUTING_TAP_FACES_FEATURE)) return []
    const floor = this.levelElevation(el.levelId) ?? 0
    const out: FaceHandle[] = []
    for (const side of faceHandleSides(view.elements, el, kernel)) {
      const { branch } = kernel.hostedPoints(el, side.s, 1, undefined, side.face)
      const at = viewer.screenPointOf(viewerModule.kernelToScene(branch.x, branch.y, floor + branch.z))
      if (at) out.push({ x: at.x, y: at.y, elementId: el.id, face: side.face, s: side.s, label: side.label })
    }
    return out
  }

  /** The "+" on a run's top or bottom: begin the armed route there, `t` mm across the face from its centre line when the server reads it. */
  startBranchFromFace(h: FaceHandle, t = 0): string {
    const spec = this.routeSpec
    const view = this.view
    const kernel = this.kernel
    if (!spec || !view || !kernel) return 'Choose what to route first.'
    const el = view.elements[h.elementId]
    if (el?.kind !== 'run_segment' || el.domain !== spec.domain || Math.abs(el.start.z - el.end.z) > 1) return 'That run has changed; select it again.'
    const offset = tapOffsetFor(this.serverFeatures() ?? [], 2 * kernel.hostHalfWidth(el.size), t)
    const { branch } = kernel.hostedPoints(el, h.s, 1, undefined, h.face, offset ?? 0)
    const word = h.face === 'top' ? 'top' : 'bottom'
    const target = this.withHeight({
      endpoint: { kind: 'run_branch', segmentId: el.id, face: h.face, ...(offset !== undefined ? { t: offset } : {}) },
      point: { x: branch.x, y: branch.y },
      label: '',
      systemId: el.systemId,
    })
    this.routing = this.startOn({ ...target, label: `the ${word} of the ${kernel.runLabel(view.elements, el)} (a new branch)` })
    return `Branching off the ${word} of the ${kernel.runLabel(view.elements, el)}. Click the next point; Esc cancels.`
  }

  /** Start the armed route on an open end (the "+" past it): continue it from there. */
  startRouteOn(elementId: string, port: string): string {
    const spec = this.routeSpec
    if (!spec) return 'Choose what to route first.'
    const target = this.openEndTarget(elementId, port)
    if (!target) return 'That end is connected now, or is another kind of run; pick an open end.'
    this.routing = this.startOn(target)
    return `Continuing from ${target.label}${this.transitionNote(target, spec)}. Click the next point; change the size in the Route panel first to continue at another size.`
  }

  /** The "+" on an elbow's side: the elbow becomes a tee and the leg through `through` runs on past the corner. The open end to route on from, or the refusal. */
  teeAtElbow(
    elbowId: string,
    through: string,
    face?: BranchFace,
  ): { readonly open: { readonly elementId: string; readonly port: 'start' | 'end' } } | { readonly joined: true; readonly hint: string } | { readonly refused: string } {
    const view = this.view
    const el = view?.elements[elbowId]
    const link = el?.kind === 'run_fitting' ? el.ports.find((p) => p.id === through)?.link : undefined
    if (!view || !link || (link.port !== 'start' && link.port !== 'end')) return { refused: 'That elbow has changed; select it again.' }
    const level = view.elements[link.elementId]
    const name = level?.kind === 'run_segment' && this.kernel ? this.kernel.runLabel(view.elements, level) : 'run'
    const refused = this.submit({ type: 'elbow_to_tee', fittingId: elbowId, through, idPrefix: newElementId('tee'), ...(face ? { face } : {}) })
    if (refused) return { refused }
    // At the base of a stack the drain ran on back through the corner: route on from its new open end.
    const system = level?.kind === 'run_segment' ? view.elements[level.systemId] : undefined
    const drain = level?.kind === 'run_segment' && level.domain === 'pipe' && system?.kind === 'mep_system' && (this.kernel ? isDrainService(this.kernel, system.systemKind) : false)
    if (face && !drain) return { joined: true, hint: `Joined the ${face === 'top' ? 'rising' : 'dropping'} leg to the ${face} of the ${name}` }
    return { open: { elementId: link.elementId, port: link.port } }
  }

  /** Esc: drop the route being drawn. True when there was one (a second Esc leaves the tool). */
  cancelRoute(): boolean {
    const had = this.routing !== null
    this.routing = null
    this.clearRoutePreview()
    return had
  }

  private clearRoutePreview() {
    this.showRouteJoin(null)
    this.viewer?.setGhost(null)
    this.publishRouteChecks([])
    if (this.preview) {
      this.preview = null
      this.redraw()
    }
  }

  private routeElevation(spec: RouteSpec): number | null {
    const floor = this.levelElevation(spec.levelId)
    return floor === null ? null : floor + this.currentRouteElevation(spec)
  }

  /** What is under the pointer that a route can start or end on: a free connector of the right system, an open run end, or a run to branch off. */
  private routeTarget(clientX: number, clientY: number, spec: RouteSpec): RouteTarget | null {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    if (!viewer || !view || !kernel) return null
    // An open end is a small target: take one near the pointer on screen before what is under it.
    const openEnd = this.nearestOpenEnd(clientX, clientY, spec)
    if (openEnd) return openEnd
    // The live preview's own pieces aren't in the model yet; look past them.
    const hit = viewer.pickNative(clientX, clientY, (id) => view.elements[id] !== undefined)
    const el = hit ? view.elements[hit.elementId] : undefined
    if (!el) return null
    const floor = this.levelElevation(spec.levelId) ?? 0
    // A diffuser on the floor below a roof route: picked at its own floor's height.
    const floorOf = (levelId: string) => this.levelElevation(levelId) ?? floor
    if (el.kind === 'part') {
      const type = view.elements[el.typeId]
      if (type?.kind !== 'part_type') return null
      const at = viewer.planPointAt(clientX, clientY, floorOf(el.levelId) + el.offsetMm)
      const candidates = kernel
        .resolveConnectors(type.definition, el.values)
        .filter((c) => c.domain === kernel.connectorDomainOf(spec.domain) && c.systemKind === spec.system.kind && !el.links?.[c.id])
        .map((c) => ({ c, w: kernel.worldConnector(el, c) }))
      if (candidates.length === 0) return null
      const near = (q: { x: number; y: number }) => (at ? Math.hypot(q.x - at.x, q.y - at.y) : 0)
      const best = candidates.sort((a, b) => near(a.w.position) - near(b.w.position))[0]
      if (!best) return null
      return this.withHeight({ endpoint: { kind: 'part', partId: el.id, connectorId: best.c.id }, point: { x: best.w.position.x, y: best.w.position.y }, label: `${kernel.partLabelOf(view.elements, el)}'s ${best.c.label.toLowerCase()}`, systemId: null }, spec.levelId)
    }
    if (el.kind === 'run_segment' || el.kind === 'run_fitting') {
      const z = el.kind === 'run_segment' ? (el.start.z + el.end.z) / 2 : el.position.z
      const at = viewer.planPointAt(clientX, clientY, floorOf(el.levelId) + z)
      if (!at) return null
      const open: Array<{ port: string; p: Vec2 }> = []
      if (el.kind === 'run_segment') {
        if (!el.links.start) open.push({ port: 'start', p: el.start })
        if (!el.links.end) open.push({ port: 'end', p: el.end })
      } else {
        for (const port of el.ports) if (!port.link) open.push({ port: port.id, p: port.position })
      }
      const end = open.map((o) => ({ ...o, d: Math.hypot(o.p.x - at.x, o.p.y - at.y) })).sort((a, b) => a.d - b.d)[0]
      const label = kernel.runLabel(view.elements, el)
      if (end && (el.kind === 'run_fitting' || end.d <= RUN_END_SNAP_MM)) {
        return this.withHeight({ endpoint: { kind: 'run_end', elementId: el.id, port: end.port }, point: { x: end.p.x, y: end.p.y }, label: `the open end of the ${label}`, systemId: el.systemId, join: { kind: 'run_end', elementId: el.id, port: end.port } }, spec.levelId)
      }
      return el.kind === 'run_segment' ? this.branchTarget(el, at, spec) : null
    }
    return null
  }

  /**
   * A new branch off the side of a level straight run, or of a pitched pipe (a
   * sloped drain), where `at` (plan mm) is nearest its centreline: the tap
   * takes the trunk's height there and its system, and the kernel places the
   * system's branch fitting and pitches the branch towards the trunk. The 3D
   * view and every drawing route a tap through here. Null for a riser.
   */
  private branchTarget(el: RunSegment, at: Vec2, spec: RouteSpec): RouteTarget | null {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel || el.domain !== spec.domain) return null
    if (Math.abs(el.start.z - el.end.z) > 0.5 && !(el.domain === 'pipe' && kernel.isPitchedOrLevel(el))) return null
    const ax = el.end.x - el.start.x
    const ay = el.end.y - el.start.y
    const len = Math.hypot(ax, ay)
    if (len < 1) return null
    const t = Math.min(1, Math.max(0, ((at.x - el.start.x) * ax + (at.y - el.start.y) * ay) / (len * len)))
    // On a trunk square to the plan, land on the building's 6" grid (so a branch lines up with parts placed on it).
    const onGrid = (v: number) => Math.round(v / GRID_MM) * GRID_MM
    const point =
      Math.abs(ay) < 0.5 ? { x: onGrid(el.start.x + ax * t), y: el.start.y } : Math.abs(ax) < 0.5 ? { x: el.start.x, y: onGrid(el.start.y + ay * t) } : { x: el.start.x + ax * t, y: el.start.y + ay * t }
    // The tap goes on the side the pointer is on; the next point decides for good.
    const side: 1 | -1 = (at.x - el.start.x) * -ay + (at.y - el.start.y) * ax >= 0 ? 1 : -1
    const s = Math.hypot(point.x - el.start.x, point.y - el.start.y)
    const target = this.withHeight({ endpoint: { kind: 'run_branch', segmentId: el.id }, point, label: '', systemId: el.systemId, join: { kind: 'run_branch', segmentId: el.id, s, side, size: spec.size } })
    const height = target.elevationMm === undefined ? '' : ` at ${feetInches(target.elevationMm)}`
    return { ...target, label: `the ${kernel.runLabel(view.elements, el)}${height} (a new branch)` }
  }

  /** The target with the height a route started on it takes, read by the kernel's own rule (the one a route with no height follows). */
  private withHeight(target: RouteTarget, levelId?: string): RouteTarget {
    const view = this.view
    const kernel = this.kernel
    if (!view || !kernel) return target
    try {
      // Heights from the route's own floor, so a connector on another floor reads as it will be routed.
      return { ...target, elevationMm: kernel.inheritedRouteHeight(view, { from: target.endpoint, points: [target.point], ...(levelId ? { levelId } : {}) }) }
    } catch (err) {
      // A connector facing up or down has no single height to give: the route keeps the typed one.
      if (err instanceof kernel.KernelError) return target
      throw err
    }
  }

  /** Begin a route on a target: it starts at that target's height when it has one, so a tap or continued end meets it. */
  private startOn(target: RouteTarget): NonNullable<ModelSession['routing']> {
    return { from: target, points: [], ...(target.elevationMm !== undefined ? { startElevationMm: target.elevationMm } : {}) }
  }

  /** The open run end of this route's kind nearest the pointer on screen, within a few pixels; null when none is. */
  private nearestOpenEnd(clientX: number, clientY: number, spec: RouteSpec): RouteTarget | null {
    const viewer = this.viewer
    const view = this.view
    const kernel = this.kernel
    if (!viewer || !view || !kernel) return null
    const floor = this.levelElevation(spec.levelId) ?? 0
    const rect = this.container.getBoundingClientRect()
    let best: { d: number; el: RunSegment | RunFitting; port: string; p: Vec2 } | null = null
    for (const el of elementsOfKind(view.elements, 'run_segment', 'run_fitting')) {
      if (el.domain !== spec.domain || el.levelId !== spec.levelId) continue
      const ends =
        el.kind === 'run_segment'
          ? [...(el.links.start ? [] : [{ port: 'start', p: el.start }]), ...(el.links.end ? [] : [{ port: 'end', p: el.end }])]
          : el.ports.filter((q) => !q.link).map((q) => ({ port: q.id, p: q.position }))
      for (const e of ends) {
        const at = viewer.canvasPointOf(e.p.x, e.p.y, floor + e.p.z)
        if (!at) continue
        const d = Math.hypot(rect.left + at.x - clientX, rect.top + at.y - clientY)
        if (d <= RUN_END_PICK_PX && (!best || d < best.d)) best = { d, el, port: e.port, p: e.p }
      }
    }
    if (!best) return null
    const { el, port, p } = best
    return this.withHeight({ endpoint: { kind: 'run_end', elementId: el.id, port }, point: { x: p.x, y: p.y }, label: `the open end of the ${kernel.runLabel(view.elements, el)}`, systemId: el.systemId, join: { kind: 'run_end', elementId: el.id, port } })
  }

  /** While routing, mark the face a click would join (or clear it). */
  private showRouteJoin(target: RouteTarget | null) {
    const viewer = this.viewer
    const spec = this.routeSpec
    if (!viewer) return
    if (!target?.join || !spec || !this.view) {
      viewer.setRouteJoin(null, null)
      this.container.style.cursor = ''
      return
    }
    viewer.setRouteJoin(this.view, target.join, this.levelElevation(spec.levelId) ?? 0)
    this.container.style.cursor = 'copy'
  }

  /**
   * Where a route's first free point goes: on the surface under the pointer
   * (under a soffit, over a floor or roof, out from a wall), snapped in plan.
   * Null with nothing under the pointer or Shift held (the typed height's plane then).
   */
  private routeStartAt(clientX: number, clientY: number, spec: RouteSpec): RouteStart | null {
    const viewer = this.viewer
    const floor = this.levelElevation(spec.levelId)
    if (!viewer || floor === null || this.surfacesOff()) return null
    const hit = viewer.pickSurface(clientX, clientY, (id) => this.view?.elements[id] !== undefined)
    if (!hit) return null
    const start = routeStartOnSurface(hit, floor, spec.elevationMm, runHalfExtents(spec.size))
    const snapped = snapPoint(start.point, this.snapTargetsFor(spec.levelId, []), null, this.workFrame ?? undefined, this.linkedNear(spec.levelId, start.point))
    return { ...start, point: snapped.point }
  }

  /** Before the first click: a short stub of the run where it would start (the ghost; nothing is sent). */
  private showRouteStart(start: RouteStart | null, spec: RouteSpec) {
    const viewer = this.viewer
    const viewerModule = this.viewerModule
    const kernel = this.kernel
    const floor = this.levelElevation(spec.levelId)
    if (!viewer || !viewerModule || !kernel) return
    if (!start || floor === null) {
      viewer.setGhost(null)
      return
    }
    const half = runHalfExtents(spec.size)
    const round = spec.size.shape !== 'rect' && spec.size.shape !== 'oval'
    const length = Math.max(GRID_MM * 2, half.widthMm * 4)
    viewer.setGhost([
      {
        elementId: kernel.asElementId('route-start-preview'),
        version: 0,
        group: spec.domain === 'duct' ? 'duct' : 'pipe',
        shape: round ? 'cylinder' : 'box',
        center: viewerModule.kernelToScene(start.point.x, start.point.y, floor + start.elevationMm),
        size: round ? [length * MM_TO_M, half.widthMm * 2 * MM_TO_M, half.widthMm * 2 * MM_TO_M] : [length * MM_TO_M, half.depthMm * 2 * MM_TO_M, half.widthMm * 2 * MM_TO_M],
        yaw: 0,
      },
    ])
  }

  /** The point a free click lands on: an axis from the previous point (X, Y, 45°, or Z up and down), else the grid, the parts or the architect's model. */
  private routePoint(clientX: number, clientY: number, spec: RouteSpec): (Vec2 & { elevationMm?: number }) | null {
    const viewer = this.viewer
    const elevation = this.routeElevation(spec)
    const floor = this.levelElevation(spec.levelId)
    if (!viewer || elevation === null || floor === null) return null
    const raw = viewer.planPointAt(clientX, clientY, elevation)
    const r = this.routing
    const prev = r ? (r.points[r.points.length - 1] ?? r.from?.point ?? null) : null
    if (prev) {
      const vertical = viewer.verticalPointAt(clientX, clientY, prev.x, prev.y)
      const res = resolveRoutePoint({
        prev: { x: prev.x, y: prev.y, elevationMm: this.currentRouteElevation(spec) },
        raw,
        vertical: vertical ? { elevationMm: vertical.elevationMm - floor, pixelDistance: vertical.pixelDistance } : null,
        lock: this.axisLock,
        shift: this.shiftHeld,
        pipe: spec.domain === 'pipe',
        ...(this.workFrame ? { frame: this.workFrame } : {}),
      })
      if (!res) return null
      this.lastAxis = res.axis
      return res.axis === 'z' ? { ...res.point, elevationMm: res.elevationMm } : res.point
    }
    if (!raw) return null
    this.probeReference(clientX, clientY)
    return snapPoint(raw, this.snapTargetsFor(spec.levelId, []), this.referenceNear(clientX, clientY, raw), this.workFrame ?? undefined, this.linkedNear(spec.levelId, raw)).point
  }

  /** The route_run command for what is drawn so far, plus the pointer's point or target. */
  private routeCommand(spec: RouteSpec, extra: (Vec2 & { elevationMm?: number }) | null, to: RouteTarget | null, idPrefix: string): Command | null {
    const r = this.routing
    const from = r?.from ?? null
    const drawn = [...(r?.points ?? [])]
    // A vertical step stays at the last point's plan position: it is a rise or drop there.
    if (extra && extra.elevationMm !== undefined) {
      const last = drawn[drawn.length - 1]
      if (last && Math.hypot(last.x - extra.x, last.y - extra.y) < 1) drawn[drawn.length - 1] = { ...last, elevationMm: extra.elevationMm }
      else if (!last && from) drawn.push(extra)
    } else if (extra) drawn.push(extra)
    const points = [...(from?.endpoint.kind === 'run_branch' ? [from.point] : []), ...drawn]
    if (to?.endpoint.kind === 'run_branch') points.push(to.point)
    const everyRun = this.serverFeatures()?.includes(ROUTING_PLUS_EVERY_RUN_FEATURE) ?? false
    const continued = from?.systemId ?? to?.systemId ?? null
    const continuedSystem = continued ? this.view?.elements[continued] : undefined
    const system = continuedSystem?.kind === 'mep_system' ? { id: continuedSystem.id, kind: continuedSystem.systemKind } : spec.system
    if (!from && !to && points.length < 2) return null
    const run = {
      idPrefix,
      levelId: spec.levelId,
      domain: spec.domain,
      size: spec.size,
      elevationMm: r?.startElevationMm ?? spec.elevationMm,
      system,
      points,
      ...(spec.riseStyle !== 'vertical' ? { riseStyle: spec.riseStyle } : {}),
      ...(spec.fittings && Object.keys(spec.fittings).length > 0 ? { fittings: spec.fittings } : {}),
      ...(spec.domain === 'duct' && spec.insulation !== undefined ? { insulation: spec.insulation } : {}),
      ...(spec.slopeInPerFt !== undefined ? { slopeInPerFt: spec.slopeInPerFt } : {}),
      ...(spec.flow ? { flow: spec.flow } : {}),
      ...(from ? { from: from.endpoint } : {}),
      // Continued from an open end, a first leg that turns puts its elbow right on that end (Revit's "+"), when it fits.
      ...(from?.endpoint.kind === 'run_end' && everyRun ? { turnAtStart: true } : {}),
    }
    // Into a part's connector with flex asked for: the rigid run stops at the last point and flex finishes it, one edit.
    if (spec.lastStretchFlex && everyRun && spec.domain === FLEX_DOMAIN && to?.endpoint.kind === 'part' && (from ? points.length >= 1 : points.length >= 2)) {
      return { type: 'route_into_flex', route: run, to: { partId: to.endpoint.partId, connectorId: to.endpoint.connectorId } }
    }
    return { type: 'route_run', ...run, ...(to ? { to: to.endpoint } : {}) }
  }

  private routeSummary(view: ModelState, changed: readonly string[]): string {
    const counts = new Map<string, number>()
    let segments = 0
    for (const id of changed) {
      const el = view.elements[id]
      if (el?.kind === 'run_segment' && el.version === 0) segments += 1
      if (el?.kind === 'run_fitting' && el.version === 0) counts.set(el.label, (counts.get(el.label) ?? 0) + 1)
    }
    const fittings = [...counts.entries()].map(([label, n]) => `${n} ${label.toLowerCase()}${n === 1 ? '' : 's'}`)
    return [`${segments} straight piece${segments === 1 ? '' : 's'}`, ...fittings].join(', ')
  }

  /** Velocity, friction and the straight-duct loss of the route being drawn, in plain words. */
  private routeReadout(view: ModelState, changed: readonly string[]): string | null {
    const airPack = this.airPack
    if (!airPack) return null
    const fresh = changed.filter((id) => {
      const el = view.elements[id]
      return el?.kind === 'run_segment' && el.version === 0
    })
    const r = airPack.runReadout(view, fresh)
    if (!r) return null
    if (!r.calculable) return r.reason ?? null
    if (r.flowCfm <= 0) return 'No airflow yet: finish on an air device or a run to see velocity and friction'
    return `${r.flowCfm} CFM, ${r.velocityFpm} fpm, ${r.frictionInPer100Ft.toFixed(3)} in. w.c./100 ft, this run ${r.straightLossInWc.toFixed(3)} in. w.c. straight`
  }

  /** Live preview of the route with the pointer as its next point (or finishing on what is under it). Nothing is sent. */
  previewRoute(clientX: number, clientY: number): string | null {
    const spec = this.routeSpec
    const kernel = this.kernel
    const view = this.view
    if (!spec || !kernel || !view || !this.viewer) return null
    this.routePointer = { x: clientX, y: clientY }
    if (this.routeElevation(spec) === null) return 'Choose a level to route on.'
    const target = this.routeTarget(clientX, clientY, spec)
    this.showRouteJoin(target)
    if (!this.routing) {
      if (!target) {
        const start = this.routeStartAt(clientX, clientY, spec)
        this.showRouteStart(start, spec)
        return start
          ? `${start.where}. Click to start here, or press and drag from a connector or run. Shift: the typed height.`
          : 'Click (or press and drag from) a connector, a run, or a point to start the route.'
      }
      this.showRouteStart(null, spec)
      const transition = target.endpoint.kind === 'run_end' ? this.transitionNote(target, spec) : ''
      return `Start on ${target.label}${transition}. Click, or press and drag to draw.`
    }
    this.showRouteStart(null, spec)
    const point = target ? null : this.routePoint(clientX, clientY, spec)
    return this.previewRouteWith(spec, point, target, 'Z or Shift: up and down; X / Y lock.')
  }

  /** What the model server this model is open on advertised (none before it answers); undefined when no server is attached. */
  serverFeatures(): readonly string[] | undefined {
    return this.client ? (this.client.serverProtocolOf()?.features ?? []) : undefined
  }

  /** Decide a preview the way the server will: shapes gated on a protocol feature (a grease waste system) only when the server advertised it. */
  private decideLikeServer(kernel: KernelModule, view: ModelState, command: Command) {
    const features = this.client?.serverProtocolOf()?.features ?? []
    return kernel.withUpgradePolicy((feature) => features.includes(feature), () => kernel.executeCommand(view, command))
  }

  /** The live route preview with `point` (or finishing on `target`) as what comes next; the hint. */
  private previewRouteWith(spec: RouteSpec, point: (Vec2 & { elevationMm?: number }) | null, target: RouteTarget | null, keys: string): string | null {
    const kernel = this.kernel
    const view = this.view
    if (!kernel || !view) return null
    const command = this.routeCommand(spec, point, target, 'route-preview')
    if (!command) return 'Click the next point.'
    let res = this.decideLikeServer(kernel, view, command)
    let worked = false
    let auto: Command | null = null
    if (!res.ok) {
      auto = this.autoConnectFor(target, 'route-preview')
      const joined = auto ? this.decideLikeServer(kernel, view, auto) : null
      if (!joined?.ok) {
        this.clearRoutePreview()
        return `${res.error.message}.${joined ? ` Connecting the two ends another way didn't fit either: ${joined.error.message}.` : ''}`
      }
      res = joined
      worked = true
    }
    this.preview = res.model
    if (this.accepted) this.viewer?.setAuthored(this.accepted, this.preview)
    const what = `${this.routeSummary(res.model, res.changedIds)} at ${feetInches(point?.elevationMm ?? this.currentRouteElevation(spec))}`
    const readout = this.routeReadout(res.model, res.changedIds)
    const tail = readout ? ` ${readout}.` : ''
    const checks = this.checkRoute(res.model, res.changedIds)
    const along = checks === null
      ? " The rules along this route couldn't be checked; the Checklist checks it once it lands."
      : checks[0] ? ` ${checks[0].message}${checks.length > 1 ? ` (and ${checks.length - 1} more along this route)` : ''}` : ''
    if (worked && target && auto?.type === 'join_parts') return `Join end to end with ${target.label}.${along} Click to join, Esc to cancel.`
    if (worked && target) return `Connect to ${target.label}: the ends don't meet face to face, so a route is worked out between them (${this.routeSummary(res.model, res.changedIds)}).${along} Click to connect, Esc to cancel.`
    return target
      ? `Finish on ${target.label}: ${what}.${tail}${along} Click to connect, Esc to cancel.`
      : `${what}.${tail}${along} Click to add a point, Enter to finish here, Esc to cancel.${keys ? ` ${keys}` : ''}`
  }

  /** The firm's and the project's design limits for route checks (clearances): the surface reads them from the library. */
  setDesignLimits(limits: DesignLimitSources): void {
    this.designLimits = limits
  }

  /** Where the route checks' ticks go (mm above project zero, at the route's height); empty when not routing. */
  routeTicks(): readonly RunPoint[] {
    const spec = this.routeSpec
    const floor = spec ? this.levelElevation(spec.levelId) : null
    if (!this.routing || !spec || floor === null) return []
    const z = floor + this.currentRouteElevation(spec)
    return this.routeChecks.map((c) => ({ x: c.at.x, y: c.at.y, z }))
  }

  /** The previewed pieces the route checks sit across, at the ticks' height (mm above project zero); looked up by id, never a model scan. */
  routeTickPieces(): readonly { readonly a: RunPoint; readonly b: RunPoint }[] {
    const ticks = this.routeTicks()
    const preview = this.preview
    const z = ticks[0]?.z
    if (!preview || z === undefined) return []
    const out: { a: RunPoint; b: RunPoint }[] = []
    const seen = new Set<string>()
    for (const c of this.routeChecks) {
      if (seen.has(c.segmentId)) continue
      seen.add(c.segmentId)
      const piece = preview.elements[c.segmentId]
      if (piece?.kind === 'run_segment') out.push({ a: { x: piece.start.x, y: piece.start.y, z }, b: { x: piece.end.x, y: piece.end.y, z } })
    }
    return out
  }

  private publishRouteChecks(checks: readonly RouteCheck[]) {
    const same = checks.length === this.routeChecks.length && checks.every((c, i) => c.key === this.routeChecks[i]?.key && c.message === this.routeChecks[i]?.message)
    if (same) return
    this.routeChecks = checks
    this.events.onRouteChecks?.(checks)
  }

  /** The route checks for the pieces a preview changed (one leg at a time, the indexes near it); published to the Route tool. */
  private checkRoute(model: ModelState, changedIds: readonly ElementId[]): readonly RouteCheck[] | null {
    const rated = this.ratedRoutes
    if (!rated) return []
    try {
      const checks = rated.routeCheckLines(rated.checkRouteLegs(model, changedIds, { limits: this.designLimits }))
      this.publishRouteChecks(checks)
      return checks
    } catch (err) {
      console.error('[model-session] route checks failed on a preview', err)
      this.publishRouteChecks([])
      return null
    }
  }

  /** On a server that cuts parts into runs: the route and the parts its crossings need, as one edit (one undo step); null otherwise. */
  private routeWithCrossings(before: ModelState, route: Command): { readonly batch: Command; readonly words: string | null } | null {
    const kernel = this.kernel
    const rated = this.ratedRoutes
    if (!kernel || !rated || !(this.serverFeatures() ?? []).includes(kernel.ROUTING_INSERT_PART_FEATURE)) return null
    const decided = this.decideLikeServer(kernel, before, route)
    if (!decided.ok) return null
    try {
      const plan = rated.routeFinishPlan(decided.model, decided.changedIds, newElementId('crossing'), {
        limits: this.designLimits,
        inline: (model, command) => {
          const d = this.decideLikeServer(kernel, model, command)
          return d.ok ? d.model : { refused: d.error.message }
        },
      })
      const batch = rated.routeFinishBatch(route, plan, 'Route, with the parts at its crossings')
      return batch ? { batch, words: rated.routeFinishWords(decided.model, plan) } : null
    } catch (err) {
      console.error('[model-session] route finish plan failed; sending the route alone', err)
      return null
    }
  }

  /** After a route lands: the parts its crossings need (a damper at a rated wall), each its own edit; the words for what was placed and what stays on the Checklist. */
  private finishCrossings(before: ModelState, landed: Command): string | null {
    const kernel = this.kernel
    const rated = this.ratedRoutes
    if (!kernel || !rated) return null
    const decided = this.decideLikeServer(kernel, before, landed)
    if (!decided.ok) return null
    let plan: ReturnType<RatedRoutesModule['routeFinishPlan']>
    try {
      plan = rated.routeFinishPlan(decided.model, decided.changedIds, newElementId('crossing'), { limits: this.designLimits })
    } catch (err) {
      console.error('[model-session] route finish plan failed', err)
      return "The rules along this route couldn't be checked, so nothing was placed at its crossings: open the Checklist to see them."
    }
    const refused: string[] = []
    for (const command of plan.commands) {
      const why = this.submit(command)
      if (why) refused.push(why)
    }
    const words = rated.routeFinishWords(decided.model, plan)
    const notPlaced = refused.length > 0 ? `${refused.length === 1 ? 'One part' : `${refused.length} parts`} couldn't be placed: ${refused[0]}` : null
    return [words, notPlaced].filter((w): w is string => !!w).join(' ') || null
  }

  // ------------------------------------------------------------ route on a drawing

  /** An open run end as a route target: start there to continue it, or finish there to connect. Null when it isn't open or is another kind. */
  private openEndTarget(elementId: string, port: string): RouteTarget | null {
    const view = this.view
    const kernel = this.kernel
    const spec = this.routeSpec
    const el = view?.elements[elementId]
    if (!view || !kernel || !spec || (el?.kind !== 'run_segment' && el?.kind !== 'run_fitting') || el.domain !== spec.domain) return null
    const p = el.kind === 'run_segment' ? (port === 'start' && !el.links.start ? el.start : port === 'end' && !el.links.end ? el.end : null) : (el.ports.find((q) => q.id === port && !q.link)?.position ?? null)
    if (!p) return null
    return this.withHeight({ endpoint: { kind: 'run_end', elementId: el.id, port }, point: { x: p.x, y: p.y }, label: `the open end of the ${kernel.runLabel(view.elements, el)}`, systemId: el.systemId, join: { kind: 'run_end', elementId: el.id, port } }, spec.levelId)
  }

  /**
   * A point a drawing gives (mm above project zero; `z` only from a section).
   * `vertical`: a section click straight above or below the last point is a
   * rise or drop there (a riser drawn directly). Otherwise a level leg at the
   * route's height, on the 6" grid.
   */
  private routeDrawingPoint(p: { readonly x: number; readonly y: number; readonly z?: number }, vertical: boolean): (Vec2 & { elevationMm?: number }) | null {
    const spec = this.routeSpec
    const floor = spec ? this.levelElevation(spec.levelId) : null
    if (!spec || floor === null) return null
    const r = this.routing
    const prev = r ? (r.points[r.points.length - 1] ?? r.from?.point ?? null) : null
    const onGrid = (v: number) => Math.round(v / GRID_MM) * GRID_MM
    if (vertical && prev && p.z !== undefined) return { x: prev.x, y: prev.y, elevationMm: onGrid(p.z - floor) }
    return { x: onGrid(p.x), y: onGrid(p.y) }
  }

  /** The route's last point (mm above project zero), so a drawing can draw from it and keep a section's depth; null when not routing. */
  routeLastPoint(): RunPoint | null {
    const spec = this.routeSpec
    const r = this.routing
    const last = r ? (r.points[r.points.length - 1] ?? r.from?.point) : undefined
    const floor = spec ? this.levelElevation(spec.levelId) : null
    return last && spec && floor !== null ? { x: last.x, y: last.y, z: floor + this.currentRouteElevation(spec) } : null
  }

  /** The model with the route being drawn; null when nothing is previewed. */
  routePreviewModel(): ModelState | null {
    return this.routing ? this.preview : null
  }

  /** A drawing's pick for the Route tool: an open end to continue or finish on, else the side of a straight run (a tap off it). */
  private drawingTarget(end: { readonly elementId: string; readonly port: string } | null, side: DrawingRouteSide | null, spec: RouteSpec): RouteTarget | null {
    if (end) return this.openEndTarget(end.elementId, end.port)
    const el = side ? this.view?.elements[side.segmentId] : undefined
    return el?.kind === 'run_segment' && side ? this.branchTarget(el, side.at, spec) : null
  }

  /** Why Route can't start yet, named for the cause: no level is the usual one on a fresh plan. */
  private routeUnarmedReason(): string {
    return this.levels().length === 0 ? ROUTE_NEEDS_LEVEL : 'Choose what to route in the Route panel first.'
  }

  /** Hover with Route on a drawing: what a click would do there (start on or finish at an open end, or tap off a run's side), previewed. */
  previewRouteOnDrawing(p: { readonly x: number; readonly y: number; readonly z?: number }, vertical: boolean, end: { readonly elementId: string; readonly port: string } | null, side: DrawingRouteSide | null = null): string | null {
    const spec = this.routeSpec
    if (!spec) return this.routeUnarmedReason()
    if (this.routeElevation(spec) === null) return 'Choose a level to route on.'
    const target = this.drawingTarget(end, side, spec)
    if (!this.routing) {
      if (!target) return 'Click an open end of a duct or pipe to continue it, the side of a run to tap off it, or a point to start a new run.'
      return target.endpoint.kind === 'run_branch'
        ? `Tap off ${target.label}. Click to start the branch here.`
        : `Start on ${target.label}${this.transitionNote(target, spec)}. Click to continue it from here.`
    }
    return this.previewRouteWith(spec, target ? null : this.routeDrawingPoint(p, vertical), target, 'Straight up or down from the last point in a section: a riser.')
  }

  /** A click with Route on a drawing: start (on an open end, a run's side, or a free point), add a point or rise, or finish on an open end or a run's side. */
  clickRouteOnDrawing(p: { readonly x: number; readonly y: number; readonly z?: number }, vertical: boolean, end: { readonly elementId: string; readonly port: string } | null, side: DrawingRouteSide | null = null): string | null {
    const spec = this.routeSpec
    if (!spec) return this.routeUnarmedReason()
    const paused = this.refusePaused()
    if (paused) return paused
    const floor = this.levelElevation(spec.levelId)
    if (floor === null) return 'Choose a level to route on.'
    const target = this.drawingTarget(end, side, spec)
    if (!this.routing) {
      if (target) {
        this.routing = this.startOn(target)
        return `Started on ${target.label}${this.transitionNote(target, spec)}. Click the next point.`
      }
      const point = this.routeDrawingPoint(p, false)
      if (!point) return null
      this.routing = { from: null, points: [point], ...(p.z !== undefined ? { startElevationMm: Math.round((p.z - floor) / GRID_MM) * GRID_MM } : {}) }
      return 'Click the next point.'
    }
    if (target) return this.commitRoute(target)
    const point = this.routeDrawingPoint(p, vertical)
    return point ? this.addRoutePoint(point) : null
  }

  private addRoutePoint(point: Vec2 & { elevationMm?: number }): string {
    const r = this.routing
    if (!r) return 'Click where the route starts first.'
    if (point.elevationMm !== undefined) {
      const last = r.points[r.points.length - 1]
      if (last && Math.hypot(last.x - point.x, last.y - point.y) < 1) r.points[r.points.length - 1] = { ...last, elevationMm: point.elevationMm }
      else r.points.push(point)
      return `${feetInches(point.elevationMm)} at this point. Click the next point along, or Enter to finish here.`
    }
    r.points.push(point)
    return 'Click the next point, a connector or a run to finish there, or press Enter to finish here.'
  }

  /**
   * Started on one open end and finishing on another with nothing drawn between: the connect that
   * works out the route between them; from a part's connector to another part's, the join end to end
   * (mismatched ends still join, and the checks report them).
   */
  private autoConnectFor(to: RouteTarget | null, idPrefix: string): Command | null {
    const r = this.routing
    const from = r?.from
    if (!r || !from || !to || r.points.length > 0) return null
    if (from.endpoint.kind === 'part' && to.endpoint.kind === 'part') {
      return { type: 'join_parts', a: { elementId: from.endpoint.partId, port: from.endpoint.connectorId }, b: { elementId: to.endpoint.partId, port: to.endpoint.connectorId } }
    }
    if (from.endpoint.kind !== 'run_end' || to.endpoint.kind !== 'run_end') return null
    return { type: 'auto_connect_runs', a: { elementId: from.endpoint.elementId, port: from.endpoint.port }, b: { elementId: to.endpoint.elementId, port: to.endpoint.port }, idPrefix }
  }

  /** "; a transition to 12"Ø is added" when continuing an open end at another size. */
  private transitionNote(target: RouteTarget, spec: RouteSpec): string {
    const kernel = this.kernel
    const view = this.view
    if (!kernel || !view || target.endpoint.kind !== 'run_end') return ''
    const info = kernel.portInfo(view.elements, { elementId: target.endpoint.elementId as ElementId, port: target.endpoint.port })
    if (!info?.size || kernel.sameSize(info.size, spec.size)) return ''
    return `; a transition from ${kernel.sizeLabel(info.size)} to ${kernel.sizeLabel(spec.size)} is added there`
  }

  /** A click with the Route tool: start, add a point, or finish on a connector or run. Returns the hint (or the plain refusal). */
  clickRoute(clientX: number, clientY: number): string | null {
    const spec = this.routeSpec
    if (!spec) return 'Choose what to route first.'
    const paused = this.refusePaused()
    if (paused) return paused
    const target = this.routeTarget(clientX, clientY, spec)
    if (!this.routing) {
      if (target) {
        this.routing = this.startOn(target)
        return `Started on ${target.label}${this.transitionNote(target, spec)}. Click the next point.`
      }
      const start = this.routeStartAt(clientX, clientY, spec)
      if (start) {
        this.viewer?.setGhost(null)
        this.routing = { from: null, points: [start.point], startElevationMm: start.elevationMm }
        return `Started: ${start.where}. Click the next point.`
      }
      const point = this.routePoint(clientX, clientY, spec)
      if (!point) return 'Point at a floor, a ceiling, a wall or the model to start.'
      this.routing = { from: null, points: [point] }
      return 'Click the next point.'
    }
    if (target) return this.commitRoute(target)
    const point = this.routePoint(clientX, clientY, spec)
    return point ? this.addRoutePoint(point) : null
  }

  /**
   * Press with the Route tool. On a connector, open end or run (before a route
   * has started), or on the last point of the route being drawn, the press
   * draws: the release places the next point. Anywhere else it returns null
   * and the camera moves as usual.
   */
  beginRouteDragAt(clientX: number, clientY: number): { readonly started: boolean; readonly hint: string } | null {
    const spec = this.routeSpec
    const viewer = this.viewer
    if (!spec || !viewer) return null
    if (this.routing) {
      const last = this.routing.points[this.routing.points.length - 1] ?? this.routing.from?.point
      const floor = this.levelElevation(spec.levelId)
      if (!last || floor === null) return null
      const at = viewer.canvasPointOf(last.x, last.y, floor + this.currentRouteElevation(spec))
      const rect = this.container.getBoundingClientRect()
      if (!at || Math.hypot(rect.left + at.x - clientX, rect.top + at.y - clientY) > 24) return null
      return { started: false, hint: 'Drag to the next point and release to place it.' }
    }
    const target = this.routeTarget(clientX, clientY, spec)
    if (!target) return null
    this.routing = this.startOn(target)
    return { started: true, hint: `Drawing from ${target.label}${this.transitionNote(target, spec)}. Release where the next point goes.` }
  }

  /** Release after a press with the Route tool: place the point (or finish on what is under it). */
  endRouteDrag(clientX: number, clientY: number, moved: boolean, started: boolean): string | null {
    const spec = this.routeSpec
    const from = this.routing?.from
    if (started && !moved) return from && spec ? `Started on ${from.label}${this.transitionNote(from, spec)}. Click the next point, or press and drag to it.` : null
    return this.clickRoute(clientX, clientY)
  }

  /** Enter / Finish here: route to the last point clicked. */
  finishRoute(): string | null {
    return this.commitRoute(null)
  }

  private commitRoute(to: RouteTarget | null): string | null {
    const spec = this.routeSpec
    if (!spec || !this.routing) return 'Nothing to finish yet: click where the route starts.'
    const command = this.routeCommand(spec, null, to, newElementId('run'))
    if (!command) return 'Click at least one more point before finishing.'
    const before = this.view
    const together = before ? this.routeWithCrossings(before, command) : null
    const batched = together !== null && this.submit(together.batch) === null
    let refused = batched ? null : this.submit(command)
    let landed: Command | null = refused ? null : command
    const auto = refused ? this.autoConnectFor(to, newElementId('run')) : null
    if (auto && !this.submit(auto)) {
      refused = null
      landed = auto
    }
    if (refused) return refused
    this.routing = null
    this.preview = null
    this.showRouteJoin(null)
    this.publishRouteChecks([])
    this.redraw()
    const crossings = batched && together ? together.words : before && landed ? this.finishCrossings(before, landed) : null
    const done = to && auto?.type === 'join_parts' ? `Joined end to end with ${to.label}.` : to ? `Routed and connected to ${to.label}.` : 'Routed.'
    return crossings ? `${done} ${crossings}` : done
  }

  /**
   * Offset around an obstacle: the leg being drawn rises over the picked
   * element and comes back down past it. Straightforward cases only: a level
   * leg running east-west or north-south that crosses the element; anything
   * else is refused with the reason.
   */
  async offsetAround(clientX: number, clientY: number): Promise<string> {
    const viewer = this.viewer
    const spec = this.routeSpec
    const r = this.routing
    if (!viewer || !spec || !r) return 'Start a route first, then pick what is in its way.'
    const prev = r.points[r.points.length - 1] ?? r.from?.point
    const pointer = this.routePointer
    if (!prev || !pointer) return 'Draw towards the obstacle first, so the leg it is in the way of is known.'
    const ahead = this.routePoint(pointer.x, pointer.y, spec)
    if (!ahead || ahead.elevationMm !== undefined) return 'Offsets go around obstacles on a level leg; this leg is going up or down.'
    const pick = await viewer.pick(clientX, clientY)
    if (!pick) return 'Nothing was picked. Click the beam, pipe or wall in the way.'
    const box = await viewer.pickBoxMm(pick)
    const floor = this.levelElevation(spec.levelId)
    if (!box || floor === null) return "That element's size couldn't be read, so the route can't go around it automatically. Add the rise with Z instead."
    const dx = ahead.x - prev.x
    const dy = ahead.y - prev.y
    const alongX = Math.abs(dy) < 0.5
    const alongY = Math.abs(dx) < 0.5
    if (!alongX && !alongY) return 'Automatic offsets work on east-west or north-south legs. Lock the leg with X or Y, then pick again.'
    const lo = alongX ? box.min.x : box.min.y
    const hi = alongX ? box.max.x : box.max.y
    const across = alongX ? prev.y : prev.x
    const crossLo = alongX ? box.min.y : box.min.x
    const crossHi = alongX ? box.max.y : box.max.x
    const from = alongX ? prev.x : prev.y
    const to = alongX ? ahead.x : ahead.y
    if (across < crossLo || across > crossHi || Math.max(from, to) < lo || Math.min(from, to) > hi) return "The picked element isn't in the way of the leg being drawn. Point the leg through it, then pick it."
    const run = this.currentRouteElevation(spec) + floor
    const half = spec.size.shape === 'rect' || spec.size.shape === 'oval' ? spec.size.height / 2 : spec.size.shape === 'round' ? spec.size.diameter / 2 : spec.size.shape === 'pipe' ? spec.size.nominalMm / 2 : spec.size.tradeSizeMm / 2
    if (run + half < box.min.z || run - half > box.max.z) return "The run already passes above or below that element; no offset is needed."
    const clearance = 2 * 25.4
    const over = Math.ceil((box.max.z + clearance + half - floor) / GRID_MM) * GRID_MM
    const dir = Math.sign(to - from)
    const margin = Math.max(GRID_MM, half * 2)
    const enter = dir > 0 ? lo - margin : hi + margin
    const leave = dir > 0 ? hi + margin : lo - margin
    if ((enter - from) * dir < this.minStraight() || (to - leave) * dir < 0) return 'There is no room before the obstacle for the rise; start the leg further back, or route around it by hand.'
    const at = (v: number): Vec2 => (alongX ? { x: v, y: prev.y } : { x: prev.x, y: v })
    const back = this.currentRouteElevation(spec)
    r.points.push({ ...at(enter), elevationMm: over }, { ...at(leave), elevationMm: back })
    const kernel = this.kernel
    const view = this.view
    const command = this.routeCommand(spec, null, null, 'route-preview')
    if (kernel && view && command) {
      const res = kernel.executeCommand(view, command)
      if (!res.ok) {
        r.points.splice(r.points.length - 2, 2)
        return `The offset doesn't fit: ${res.error.message}. Route around it by hand.`
      }
    }
    return `Rises to ${feetInches(over)} over it and back to ${feetInches(back)} past it. Click the next point, or Enter to finish.`
  }

  private minStraight(): number {
    return this.view?.settings.minStraightMm ?? 150
  }

  setPartValues(id: string, scope: 'instance' | 'type', values: Readonly<Record<string, ParamValue | null>>, mark?: string): string | null {
    return this.submit({ type: 'set_parameters', id, scope, values, ...(mark !== undefined ? { mark } : {}) })
  }

  movePartBy(id: string, delta: Vec2, dzMm = 0): string | null {
    return this.submit({ type: 'move_elements', ids: [id], delta, ...(dzMm !== 0 ? { dzMm } : {}) })
  }

  rotatePart(id: string, angleDeg: number): string | null {
    return this.submit({ type: 'rotate_elements', ids: [id], angleDeg })
  }

  /** Turn a placed part over or onto its side (the same command the agent's bim_set_parameters sends). */
  setPartMount(id: string, mount: 'as_drawn' | PartMount): string | null {
    return this.submit({ type: 'set_parameters', id, scope: 'instance', mount })
  }

  /** Hood, louver or screen on one of a part's outdoor-air openings; null goes back to the type's. */
  setPartIntake(id: string, connectorId: string, choice: IntakeChoice | null): string | null {
    return this.submit({ type: 'set_parameters', id, scope: 'instance', intakes: { [connectorId]: choice } })
  }

  /** A mounting plane over a plan rectangle at a height above a level. */
  createMountingPlane(levelId: string, name: string, heightMm: number, corner1: Vec2, corner2: Vec2): string | null {
    return this.submit({ type: 'create_mounting_plane', planeId: newElementId('mp'), levelId, name, heightMm, corner1, corner2 })
  }

  /** How many parts are placed on a plane (they move with it). */
  partsOnPlane(planeId: string): number {
    const view = this.view
    return view && this.kernel ? this.kernel.partsOnPlane(view, planeId).length : 0
  }

  /**
   * Where a new mounting plane goes by default: around the parts and runs on
   * the level, 5 ft out, else 40 ft square around the origin. The person
   * changes it in the dialog.
   */
  planeRectFor(levelId: string): { readonly corner1: Vec2; readonly corner2: Vec2 } {
    const view = this.view
    let lo = { x: Infinity, y: Infinity }
    let hi = { x: -Infinity, y: -Infinity }
    const take = (p: Vec2) => {
      lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) }
      hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) }
    }
    if (view) {
      for (const el of elementsOfKind(view.elements, 'part', 'run_segment')) {
        if (el.levelId !== levelId) continue
        if (el.kind === 'part') take(el.position)
        else {
          take(el.start)
          take(el.end)
        }
      }
    }
    if (!Number.isFinite(lo.x)) return { corner1: { x: -20 * MM_PER_FT, y: -20 * MM_PER_FT }, corner2: { x: 20 * MM_PER_FT, y: 20 * MM_PER_FT } }
    const pad = 5 * MM_PER_FT
    return { corner1: { x: lo.x - pad, y: lo.y - pad }, corner2: { x: hi.x + pad, y: hi.y + pad } }
  }

  /** Change a plane; a new height moves the parts placed on it (their duct follows). */
  setMountingPlane(planeId: string, change: { name?: string; heightMm?: number }): string | null {
    return this.submit({ type: 'set_mounting_plane', planeId, ...change })
  }

  /**
   * Open duct ends a flex into this part's neck could leave, nearest first:
   * same system kind, round and the neck's size, within reach. What the
   * Flex command in the part's properties offers.
   */
  flexCandidates(partId: string, connectorId = 'neck'): Array<{ elementId: string; port: string; label: string; distanceMm: number }> {
    const view = this.view
    const kernel = this.kernel
    const part = view?.elements[partId]
    if (!view || !kernel || part?.kind !== 'part') return []
    const type = view.elements[part.typeId]
    if (type?.kind !== 'part_type') return []
    const neck = kernel.partConnector(part, type, connectorId)
    if (!neck || neck.connector.domain !== 'duct' || part.links?.[connectorId]) return []
    const neckAbs = (this.levelElevation(part.levelId) ?? 0) + neck.position.z
    const out: Array<{ elementId: string; port: string; label: string; distanceMm: number }> = []
    for (const el of elementsOfKind(view.elements, 'run_segment', 'run_fitting')) {
      if (el.domain !== 'duct') continue
      const system = view.elements[el.systemId]
      if (system?.kind !== 'mep_system' || system.systemKind !== neck.connector.systemKind) continue
      const ports = el.kind === 'run_segment' ? (['start', 'end'] as const).filter((p) => !el.links[p]) : el.ports.filter((p) => !p.link).map((p) => p.id)
      for (const port of ports) {
        const info = kernel.portInfo(view.elements, { elementId: el.id, port })
        if (!info || info.size?.shape !== 'round' || Math.abs(info.size.diameter - (neck.connector.diameter ?? -1)) > 0.5) continue
        const abs = (this.levelElevation(el.levelId) ?? 0) + info.position.z
        const d = Math.hypot(info.position.x - neck.position.x, info.position.y - neck.position.y, abs - neckAbs)
        if (d <= FLEX_REACH_MM) out.push({ elementId: el.id, port, label: `${kernel.runLabel(view.elements, el)} (${feetInches(d)} away)`, distanceMm: d })
      }
    }
    return out.sort((a, b) => a.distanceMm - b.distanceMm)
  }

  /** Flex from an open duct end into an air device's neck. */
  routeFlex(from: { elementId: string; port: string }, to: { partId: string; connectorId: string }): string | null {
    const command: Command = { type: 'route_flex', segmentId: newElementId('flex'), from, to }
    const predicted = this.kernel && this.view ? this.kernel.executeCommand(this.view, command) : null
    const res = this.submit(command)
    // Say how long it came out, and warn past the usual limit, as the agent hears.
    if (res === null && predicted?.ok && predicted.summary) this.events.onActivity(`${predicted.summary.join('. ')}.`)
    return res
  }

  /** What a delete would take with it, decided by the kernel on the current view; nothing is sent. */
  planDelete(ids: readonly string[]): DeletePlan {
    const kernel = this.kernel
    const view = this.view
    if (!kernel || !view) return { kind: 'refused', message: "Live editing isn't connected, so nothing can be deleted." }
    const res = kernel.executeCommand(view, { type: 'delete_elements', ids: [...ids], policy: 'refuse' })
    if (res.ok) return { kind: 'clear' }
    if (res.error.code !== 'has_dependents') return { kind: 'refused', message: res.error.message }
    const dependents = res.error.elementIds
      .filter((id) => !ids.includes(id))
      .map((id) => {
        const el = view.elements[id]
        return { id, label: el ? describeElement(view, el) : id }
      })
    const cut = kernel.executeCommand(view, { type: 'delete_elements', ids: [...ids], policy: 'disconnect' })
    const runLinks = ids.reduce((n, id) => {
      const el = view.elements[id]
      return n + (el ? kernel.linksOf(el).filter(([, link]) => !ids.includes(link.elementId)).length : 0)
    }, 0)
    const connections = runLinks + ids.reduce((n, id) => n + view.connections.filter((c) => c.a.elementId === id || c.b.elementId === id).length, 0)
    return { kind: 'dependents', dependents: cut.ok ? [] : dependents, connections, message: res.error.message }
  }

  deleteElements(ids: readonly string[], policy: 'refuse' | 'disconnect' | 'cascade'): string | null {
    const predicted = this.kernel && this.view ? this.kernel.executeCommand(this.view, { type: 'delete_elements', ids: [...ids], policy }) : null
    const res = this.submit({ type: 'delete_elements', ids: [...ids], policy })
    // Say what happened to connected runs (capped, left open, trunk kept whole).
    if (res === null && predicted?.ok && predicted.summary) this.events.onActivity(`${predicted.summary.join('. ')}.`)
    if (res === null && this.selectedId && ids.includes(this.selectedId)) void this.clearSelection()
    return res
  }

  /**
   * Levels and part types only, without walking the whole model: they live in
   * the global area, which the area index hands back directly.
   */
  private globals(): ModelState | null {
    const kernel = this.kernel
    // Saved state: its area index is carried from revision to revision; a local prediction's is not.
    const model = this.accepted ?? this.view
    if (!kernel || !model) return null
    return kernel.sliceModel(model, { areas: [{ level: kernel.GLOBAL_LEVEL }] })
  }

  levels(): Level[] {
    const g = this.globals()
    if (!g || !this.kernel) return []
    return this.kernel
      .elementValues(g.elements)
      .filter((el): el is Level => el.kind === 'level')
      .sort((a, b) => a.elevationMm - b.elevationMm)
  }

  /** The model's own part types, then the starter library's not yet in the model. */
  partCatalog(): CatalogEntry[] {
    const kernel = this.kernel
    const view = this.globals()
    if (!kernel) return []
    const own: CatalogEntry[] = []
    const seen = new Set<string>()
    if (view) {
      for (const el of kernel.elementValues(view.elements)) {
        if (el.kind !== 'part_type') continue
        seen.add(el.id)
        own.push({ typeId: el.id, definition: el.definition, inModel: true, categoryLabel: kernel.PART_CATEGORY_LABELS[el.definition.category] })
      }
    }
    const library = kernel.builtinPartTypes().filter((t) => !seen.has(t.id)).map((t) => ({ typeId: t.id, definition: t.definition, inModel: false, categoryLabel: kernel.PART_CATEGORY_LABELS[t.definition.category] }))
    return [...own, ...library]
  }

  /** A parameter value in plain units (lengths in feet and inches). */
  formatValue(def: ParamDef | undefined, value: ParamValue): string {
    return this.kernel ? this.kernel.formatParam(def, value) : String(value)
  }

  /** Parts of a type in the current view (the Edit type dialog says how many change). */
  partsOfType(typeId: string): number {
    const kernel = this.kernel
    const view = this.view
    if (!kernel || !view) return 0
    let n = 0
    for (const el of kernel.elementValues(view.elements)) if (el.kind === 'part' && el.typeId === typeId) n += 1
    return n
  }

  /** The current view's element by id (the properties panel reads type values from here). */
  element(id: string): BimElement | null {
    return this.view?.elements[id] ?? null

  }

  /** Who is editing, as the model records them (an engineer's coefficient override is stamped with it). */
  actorName(): string {
    return this.actor.name
  }

  /**
   * Send a views/sheets (or any) command. Returns null when it was accepted
   * locally and is on its way, or the plain reason it was refused. Views and
   * sheets edits are remembered for undo.
   */
  /** Save a part definition (every size in its types table) to the project library. */
  savePartDefinition(definition: PartTypeDefinition): string | null {
    const kernel = this.kernel
    if (!kernel) return "The model isn't loaded yet."
    let types: ReturnType<KernelModule['definitionTypes']>
    try {
      types = kernel.definitionTypes(definition)
    } catch (err) {
      console.error('[model-session] part definition sizes', err)
      return err instanceof Error ? err.message : 'The sizes table can’t be saved'
    }
    return this.submitCommand({ type: 'save_part_types', label: `Save ${kernel.partGroupName(definition)}`, types }, `Save ${kernel.partGroupName(definition)}`)
  }

  submitCommand(command: Command, undoLabel?: string): string | null {
    const kernel = this.kernel
    const client = this.client
    if (!client || !kernel) return "Live editing isn't connected, so changes can't be saved."
    const before = client.view()
    const predicted = before ? kernel.executeCommand(before, command) : null
    const res = this.sendToClient(client, command, predicted?.ok ? touchedIds(predicted.changedIds, predicted) : null)
    if (!res.ok) return res.error.message
    if (before && predicted?.ok && isDocumentCommand(kernel, command) && command.type !== 'restore_document_elements') {
      const entry: DocumentUndo = { label: undoLabel ?? 'last change', seq: ++this.undoSeq, before: {}, after: {} }
      for (const id of predicted.changedIds) {
        entry.before[id] = before.elements[id] ?? null
        const after = predicted.model.elements[id]
        if (after) entry.after[id] = after
      }
      this.documentUndoStack.push(entry)
      if (this.documentUndoStack.length > 50) this.documentUndoStack.shift()
      this.emitUndoState()
    }
    return null
  }

  /** What the next undo would undo, or null. */
  undoLabel(): string | null {
    return this.documentUndoStack[this.documentUndoStack.length - 1]?.label ?? null
  }

  /**
   * Undo your last views/sheets change, unless someone changed the same thing
   * since (then nothing changes and the reason comes back).
   */
  undoDocumentEdit(): { ok: true; label: string } | { ok: false; message: string } {
    const kernel = this.kernel
    const view = this.client?.view()
    const entry = this.documentUndoStack[this.documentUndoStack.length - 1]
    if (!kernel || !view) return { ok: false, message: "Live editing isn't connected, so nothing can be undone." }
    if (!entry) return { ok: false, message: 'Nothing to undo.' }
    const strip = (el: BimElement) => kernel.canonicalJson({ ...el, version: 0, authoredRev: {} })
    const items = []
    for (const [id, after] of Object.entries(entry.after)) {
      const current = view.elements[id]
      if (!current || strip(current) !== strip(after)) {
        this.documentUndoStack.pop()
        return { ok: false, message: `Someone changed this since your edit, so undo would overwrite their work. Nothing was undone.` }
      }
      const prior = entry.before[id] ?? null
      items.push({ elementId: id, before: prior ? kernel.toDocumentRecord(prior) : null, expectedVersion: current.version })
    }
    const refusal = this.submitCommand({ type: 'restore_document_elements', items })
    if (refusal) return { ok: false, message: refusal }
    this.documentUndoStack.pop()
    return { ok: true, label: entry.label }
  }

  /** The live-sync client the schedule grid subscribes through (null until the model has connected). */
  scheduleClient(): ScheduleClientPort | null {
    return this.client
  }

  /** The same client for branch, version, history and merge requests (null until the model has connected). */
  syncChannel(): SyncClient | null {
    return this.client
  }

  /** The last saved model (no local predictions): what "print last saved" prints. */
  confirmedModel(): ModelState | null {
    return this.client?.confirmedModel() ?? null
  }

  /** Elements your not-yet-saved edits change, judged against the last saved model. */
  pendingChanges(): Array<{ id: string; element: BimElement | undefined }> {
    const kernel = this.kernel
    const confirmed = this.client?.confirmedModel()
    const view = this.client?.view()
    if (!kernel || !confirmed || !view || view === confirmed || (this.client?.pendingCount() ?? 0) === 0) return []
    const out: Array<{ id: string; element: BimElement | undefined }> = []
    for (const [id, el] of kernel.elementEntries(view.elements)) if (confirmed.elements[id] !== el) out.push({ id, element: el })
    return out
  }

  /** Resolves true once every edit you sent is saved, false if that takes longer than `timeoutMs`. */
  waitForSaved(timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed) return resolve(false)
        if ((this.client?.pendingCount() ?? 0) === 0) return resolve(true)
        if (Date.now() - started > timeoutMs) return resolve(false)
        setTimeout(check, 150)
      }
      check()
    })
  }

  dispose() {
    this.disposed = true
    this.clickHandler = null
    this.container.classList.remove(CLICK_TAKEN_CLASS)
    this.clearConnectTimer()
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
    this.unbindNetworkEvents?.()
    this.unbindNetworkEvents = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.client?.dispose()
    this.viewer?.dispose()
  }
}

const MM_TO_M = 0.001

/** Half a run's depth (up-down) and width (across, in plan), mm. */
/** Keys that nudge the selection. */
export type NudgeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown'

const NUDGE_KEYS: ReadonlySet<string> = new Set<NudgeKey>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'])

export function isNudgeKey(key: string): key is NudgeKey {
  return NUDGE_KEYS.has(key)
}

/** A nudge burst saves this long after the last key press, ms. */
const NUDGE_SETTLE_MS = 700

/** "3" east, 1'-0" up" for a nudge so far. */
export function nudgeWords(d: RunPoint): string {
  const parts: string[] = []
  if (Math.abs(d.x) >= 0.5) parts.push(`${feetInches(Math.abs(d.x))} ${d.x > 0 ? 'east' : 'west'}`)
  if (Math.abs(d.y) >= 0.5) parts.push(`${feetInches(Math.abs(d.y))} ${d.y > 0 ? 'north' : 'south'}`)
  if (Math.abs(d.z) >= 0.5) parts.push(`${feetInches(Math.abs(d.z))} ${d.z > 0 ? 'up' : 'down'}`)
  return parts.length > 0 ? parts.join(', ') : 'back where it was'
}

/** Where an element sits, for reading screen directions (mm; z above its level). */
function anchorOf(el: BimElement): RunPoint | null {
  if (el.kind === 'run_segment') return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2, z: (el.start.z + el.end.z) / 2 }
  if (el.kind === 'run_fitting') return el.position
  if (el.kind === 'part') return { x: el.position.x, y: el.position.y, z: el.offsetMm }
  return null
}

/** A "+" button on the selected piece (canvas px): continue from an open end, or make a tee at an elbow. */
export interface PlusHandle {
  readonly x: number
  readonly y: number
  /** `side`: a branch off a sloped pipe's side, `s` mm along it. */
  readonly kind: 'continue' | 'tee' | 'side'
  readonly elementId: string
  /** The open end (continue), the elbow port whose leg runs on through the corner (tee), or which side in plan (side: `left` / `right` of the run's direction). */
  readonly port: string
  readonly label: string
  /** A tee whose rising or dropping leg joins the level run's top or bottom (`elbow_to_tee` `face`). */
  readonly face?: BranchFace
  /** Side handles: mm along the run's plan length from its start. */
  readonly s?: number
}

/** The level straight run whose side the dragged end now touches in plan (inside its width, away from its ends); null when none. */
/** A run's centreline height at the plan point nearest `p` (a sloped drain is lower downstream). */
function heightUnder(seg: RunSegment, p: { readonly x: number; readonly y: number }): number {
  const ax = seg.end.x - seg.start.x
  const ay = seg.end.y - seg.start.y
  const len2 = ax * ax + ay * ay
  const t = len2 < 1 ? 0 : Math.min(1, Math.max(0, ((p.x - seg.start.x) * ax + (p.y - seg.start.y) * ay) / len2))
  return seg.start.z + (seg.end.z - seg.start.z) * t
}

function sideUnderEnd(model: ModelState, id: string, grip: 'start' | 'end'): RunSegment | null {
  const piece = model.elements[id]
  if (piece?.kind !== 'run_segment') return null
  const p = grip === 'start' ? piece.start : piece.end
  let best: { seg: RunSegment; d: number } | null = null
  for (const el of elementsOfKind(model.elements, 'run_segment')) {
    // Level runs, and sloped pipe (a drain at its fall): `stretch_to_side` joins either with a branch at the height where the end meets it.
    const sloped = Math.abs(el.start.z - el.end.z) > 1
    if (el.id === id || el.domain !== piece.domain || el.levelId !== piece.levelId || (sloped && (el.domain !== 'pipe' || !isPitchedOrLevel(el)))) continue
    if (el.links.start?.elementId === id || el.links.end?.elementId === id) continue
    const ax = el.end.x - el.start.x
    const ay = el.end.y - el.start.y
    const len2 = ax * ax + ay * ay
    if (len2 < 1) continue
    const t = ((p.x - el.start.x) * ax + (p.y - el.start.y) * ay) / len2
    if (t < 0.02 || t > 0.98) continue
    const d = Math.hypot(el.start.x + ax * t - p.x, el.start.y + ay * t - p.y)
    if (d <= runHalfExtents(el.size).widthMm + 25 && (!best || d < best.d)) best = { seg: el, d }
  }
  return best?.seg ?? null
}

function runHalfExtents(size: RunSize): { depthMm: number; widthMm: number } {
  switch (size.shape) {
    case 'rect':
    case 'oval':
      return { depthMm: size.height / 2, widthMm: size.width / 2 }
    case 'round':
      return { depthMm: size.diameter / 2, widthMm: size.diameter / 2 }
    case 'pipe':
      return { depthMm: size.nominalMm / 2, widthMm: size.nominalMm / 2 }
    default:
      return { depthMm: size.tradeSizeMm / 2, widthMm: size.tradeSizeMm / 2 }
  }
}
