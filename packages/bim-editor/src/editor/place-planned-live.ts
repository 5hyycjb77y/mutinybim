import type { ModelState, PartTypeDefinition, ViewType } from '@permitzip/bim-kernel'
import { defaultHeightMm, type DrawingPlacementSpec } from './placement'
import { placeSurfaceFor, type PlaceSurface } from './planned/place-surface'

/**
 * Place from "Not placed yet" in the view the person is on (U2, B9): the live
 * 3D model, or a plan or section shown as the model. The part keeps its id,
 * circuits and values; one `place_planned_part` lands it and the list shrinks.
 */

/** What the Building Model has open, as the surface knows it. */
export interface OpenSurfaceState {
  readonly openKind: 'model' | 'view' | 'sheet'
  /** For the model itself: the 3D model or its plan. */
  readonly modelMode?: '3d' | 'plan'
  /** The open view, when a view is open. */
  readonly view: { readonly name: string; readonly viewType: ViewType } | null
  /** The view or sheet is shown as a printed drawing rather than the live model. */
  readonly showDrawing: boolean
  /** The open sheet's number, when a sheet is open. */
  readonly sheetLabel: string | null
  /** The plan or section opened for editing on the open sheet (double-clicked), if any. */
  readonly sheetView?: { readonly name: string; readonly viewType: ViewType } | null
}

/** Where a click lands the part: the live model (the session's ghost) or the printed drawing (the drawing's own layer). */
export type PlaceSurfaceNow = PlaceSurface & { readonly on: 'live' | 'drawing' | null }

const takesParts = (viewType: ViewType) => viewType === 'floor_plan' || viewType === 'ceiling_plan' || viewType === 'section'

/** Whether a part from the list can be placed where the person is, and if not, why. Never asks to switch view by itself. */
export function placeSurfaceNow(s: OpenSurfaceState): PlaceSurfaceNow {
  if (s.openKind === 'sheet') {
    const label = s.sheetLabel ?? 'this sheet'
    if (s.sheetView && takesParts(s.sheetView.viewType)) return { canPlace: true, label: `${s.sheetView.name} on ${label}`, reason: null, on: 'drawing' }
    return { ...placeSurfaceFor({ kind: 'sheet', label }), on: null }
  }
  if (s.openKind === 'model' || !s.view) return { ...placeSurfaceFor({ kind: 'live', label: s.modelMode === 'plan' ? 'the plan' : 'the 3D model' }), on: 'live' }
  const { name, viewType } = s.view
  if (viewType === 'schedule' || viewType === 'detail' || (viewType === 'three_d' && s.showDrawing)) return { ...placeSurfaceFor({ kind: 'other', label: name }), on: null }
  if (s.showDrawing) return { canPlace: true, label: name, reason: null, on: 'drawing' }
  return { ...placeSurfaceFor({ kind: 'live', label: name }), on: 'live' }
}

/** What the printed drawing places for a part from the list (`DrawingCanvas`'s `placing`). */
export function drawingPlacingFor(p: PlannedPlacing): { readonly kind: 'planned'; readonly partId: string; readonly label: string; readonly heightMm: number; readonly rotationDeg: number } {
  return { kind: 'planned', partId: p.partId, label: p.label, heightMm: p.heightMm, rotationDeg: p.rotationDeg }
}

/** A new part of a type, chosen in Place part. */
export interface NewPartChoice {
  readonly typeId: string
  readonly definition: PartTypeDefinition
  readonly inModel: boolean
}

/**
 * What the printed drawing places right now (`DrawingCanvas`'s `placing`): a
 * part from Not placed yet wins; else, with Place part on and a part chosen,
 * a new part of that type, which stays armed for the next click. Null when
 * the drawing can't take parts (the caller says why) or nothing is chosen.
 */
export function drawingPlacingNow(args: {
  readonly surface: PlaceSurfaceNow
  readonly planned: PlannedPlacing | null
  readonly tool: string
  readonly newPart: NewPartChoice | null
  readonly heightMm: number
}): DrawingPlacementSpec | null {
  if (args.surface.on !== 'drawing') return null
  if (args.planned) return drawingPlacingFor(args.planned)
  if (args.tool !== 'place' || !args.newPart || !Number.isFinite(args.heightMm)) return null
  const { typeId, definition, inModel } = args.newPart
  return { kind: 'new', typeId, definition, inModel, heightMm: args.heightMm, rotationDeg: 0 }
}

/**
 * Whether choosing a ribbon tool has to show the live model first. Select,
 * box, split and route work on any drawing; Place part works on a printed
 * plan or section (and a viewport opened on a sheet) too, so it never jumps.
 */
export function toolNeedsLiveModel(tool: string, surface: PlaceSurfaceNow): boolean {
  if (tool === 'select' || tool === 'box' || tool === 'split' || tool === 'route') return false
  if (tool === 'place' && surface.on === 'drawing') return false
  return true
}

/** A part from the list being placed in the live model. */
export interface PlannedPlacing {
  readonly partId: string
  /** Its mark, else its type's name. */
  readonly label: string
  readonly typeId: string
  readonly definition: PartTypeDefinition
  readonly levelId: string
  readonly heightMm: number
  readonly rotationDeg: number
}

/**
 * Start placing a planned part. Its level is the open plan's level (placing
 * happens where you are), else the level the plan named, else the level the
 * model tools are on.
 */
export function plannedPlacingFor(model: ModelState, partId: string, viewLevelId: string | null, fallbackLevelId: string | null): PlannedPlacing | string {
  const part = model.elements[partId]
  if (part?.kind !== 'part') return 'That part is no longer in the model.'
  if (part.planned === undefined) return `${part.mark.trim() || 'That part'} is already placed.`
  const type = model.elements[part.typeId]
  if (type?.kind !== 'part_type') return `${part.mark.trim() || 'That part'} has no part type in this model, so there is nothing to draw.`
  const isLevel = (id: string | null | undefined): id is string => !!id && model.elements[id]?.kind === 'level'
  const levelId = [viewLevelId, part.planned.levelHint ?? null, fallbackLevelId].find(isLevel)
  if (!levelId) return 'This model has no levels yet; add a level before placing parts.'
  return {
    partId: part.id,
    label: part.mark.trim() || type.definition.typeName,
    typeId: part.typeId,
    definition: type.definition,
    levelId,
    heightMm: defaultHeightMm(type.definition.category),
    rotationDeg: 0,
  }
}

/** The model session's planned-part placement (model-session.ts): its own ghost, surface pick, snapping and hosting. */
export interface PlannedPlacementSession {
  armPlannedPlacement(partId: string, at?: { readonly levelId?: string; readonly heightMm?: number; readonly rotationDeg?: number }): string | null
  previewPlacement(clientX: number, clientY: number): string | null
  commitPlacement(): string | null
  plannedPlacement(): string | null
}

/** Arm the session on the part from the list; the refusal in words, or null. */
export function armPlanned(session: PlannedPlacementSession, p: PlannedPlacing): string | null {
  return session.armPlannedPlacement(p.partId, { levelId: p.levelId, heightMm: p.heightMm, rotationDeg: p.rotationDeg })
}

/** A click in the live view: aim at the pointer, place, and say whether the part landed (the session disarms itself once it has). */
export function clickPlanned(session: PlannedPlacementSession, p: PlannedPlacing, clientX: number, clientY: number): { readonly placed: boolean; readonly refused: string | null; readonly hint: string | null } {
  const hint = session.previewPlacement(clientX, clientY)
  const refused = session.commitPlacement()
  if (refused) return { placed: false, refused, hint: refused }
  if (session.plannedPlacement() === null) return { placed: true, refused: null, hint: `Placed ${p.label}.` }
  return { placed: false, refused: null, hint }
}

/** What takes a click before selection (the session's `ClickHandler`): whether a click on these hovered ids would be taken. */
export interface ClickClaimer {
  readonly claims: (hoveredIds: readonly string[]) => boolean
}

/** Whether a click on the hovered ids places something (a previewed room's parts); a claimer that throws is logged and answers no. */
export function clickPlaces(claimer: ClickClaimer | null, hoveredIds: readonly string[] | null): boolean {
  if (!claimer || !hoveredIds || hoveredIds.length === 0) return false
  try {
    return claimer.claims(hoveredIds)
  } catch (err) {
    console.error('[place-planned-live] the click interceptor failed to say what it takes', err)
    return false
  }
}

/**
 * The plan or section drawing's cursor over the model. Routing and splitting
 * aim (crosshair); a drag holds; a click that will place a previewed room's
 * parts shows the hand, even over a selected element (which otherwise offers
 * a move); any other hovered element is clickable; else the arrow.
 */
export function drawingCursorClass(s: {
  readonly aiming: boolean
  readonly dragging: boolean
  readonly clickPlaces: boolean
  readonly overSelected: boolean
  readonly canEdit: boolean
  readonly hovering: boolean
}): 'cursor-crosshair' | 'cursor-grabbing' | 'cursor-pointer' | 'cursor-move' | 'cursor-default' {
  if (s.aiming) return 'cursor-crosshair'
  if (s.dragging) return 'cursor-grabbing'
  if (s.clickPlaces) return 'cursor-pointer'
  if (s.overSelected && s.canEdit) return 'cursor-move'
  return s.hovering ? 'cursor-pointer' : 'cursor-default'
}
