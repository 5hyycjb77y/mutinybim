'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { elementsOfKind, OPENING_SILL_KEY, WALLS_SURFACE_BINDING_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE, type ElementId, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import { usePublishWorkflow } from '../contributions/host-slots'
import type { WorkflowHostProps } from '../contributions/types'
import { feetInches } from '../placement'
import { roomFromWallsCommand, wallsRoomHover } from '../spaces/walls-room-tool'
import { ToolHintBar } from '../ToolHintBar'
import { newId } from '../views-sheets/types'
import { levelButton, type ArchitectureRibbon } from './architecture-tab'
import { ArchitectureProperties } from './ArchitectureProperties'
import { DraftOverlay } from './DraftOverlay'
import { EditTypeDialog } from './EditTypeDialog'
import { WallEndGrips, wallEnds } from './WallEndGrips'
import { WallHeightEntry } from './WallHeightEntry'
import { toolById, type ArchitectureToolId } from './tools/catalog'
import { clickDraft, draftHint, hoverDraft, keyDraft, startDraft, type Draft, type DraftContext, type FaceAt } from './tools/draft'
import { DRAFTING_GRID_MM, snapPoint, wallsNear, type Snap } from './tools/snap'
import { toolTypeFor } from './tools/tool-types'
import { linkedReferenceWords, linkedSnapNear } from '../linked-reference/linked-reference-store'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'

/** How near (screen pixels) the pointer must come to snap. */
const SNAP_PX = 12
/** A wall drawn on the top level, with no level above to reach. */
const TOP_LEVEL_WALL_MM = 3048

/** The level drawn on, and how tall its walls are: up to the next level above, else 10'-0". */
export function levelOf(model: ModelState, levelId: string): { readonly name: string; readonly wallHeightMm: number; readonly upTo: string | null; readonly upToId: string | null } {
  const levels = elementsOfKind(model.elements, 'level').sort((a, b) => a.elevationMm - b.elevationMm)
  const here = levels.find((l) => l.id === levelId)
  if (!here) return { name: 'this level', wallHeightMm: TOP_LEVEL_WALL_MM, upTo: null, upToId: null }
  const above = levels.find((l) => l.elevationMm > here.elevationMm + 1)
  return above ? { name: here.name, wallHeightMm: Math.round(above.elevationMm - here.elevationMm), upTo: above.name, upToId: above.id } : { name: here.name, wallHeightMm: TOP_LEVEL_WALL_MM, upTo: null, upToId: null }
}

/**
 * The hint bar's "where" words for the Wall tools: tied walls say they run up
 * to the level above (U unties them), untied ones say their height (U ties
 * them back). No level above: always a typed height, and U says why.
 */
export function wallTopWords(level: { readonly wallHeightMm: number; readonly upTo: string | null }, tied: boolean, typedMm: number | null = null): string {
  if (typedMm !== null) return `walls ${feetInches(typedMm)} tall (typed) · H: change it${level.upTo ? ` · U: up to ${level.upTo}` : ''}`
  if (!level.upTo) return `walls ${feetInches(level.wallHeightMm)} tall (no level above to run up to) · H: type a height`
  return tied ? `walls up to ${level.upTo} (${feetInches(level.wallHeightMm)}), following it if it moves · U: a set height instead · H: type a height` : `walls ${feetInches(level.wallHeightMm)} tall, not tied to a level · U: up to ${level.upTo} · H: type a height`
}

/**
 * How tall the walls drawn next are: a height typed with H wins (never tied
 * to a level); otherwise up to the level above when tied, else the
 * level-to-level height.
 */
export function wallDrawHeight(level: { readonly wallHeightMm: number; readonly upToId: string | null }, tied: boolean, typedMm: number | null): { readonly heightMm: number; readonly topLevelId: string | null } {
  if (typedMm !== null) return { heightMm: typedMm, topLevelId: null }
  return { heightMm: level.wallHeightMm, topLevelId: tied ? level.upToId : null }
}

/** The sill the next door or window gets: its type's sill, else 0 for a door and 900 mm for a window (the model's defaults). */
export function openingToolSillMm(model: ModelState, typeId: string | null, kind: string): number {
  const type = typeId ? model.elements[typeId] : undefined
  const v = type?.kind === 'element_type' ? type.values?.[OPENING_SILL_KEY] : undefined
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return kind === 'door' ? 0 : 900
}

function faceFor(model: ModelState, levelId: string, p: Vec2, room: boolean): FaceAt {
  const h = wallsRoomHover(model, levelId as ElementId, p)
  if (h.kind === 'room') return { ok: true, outline: h.outline, area: h.area }
  // A floor may go where a room already is; a second room may not.
  if (h.kind === 'taken') return room ? { ok: false, message: h.message } : { ok: true, outline: h.outline, area: 'the whole room' }
  return { ok: false, message: h.message }
}

const TOOL_KEYS: ReadonlySet<string> = new Set(['Escape', 'Enter', 'Backspace', 'Tab', ' ', 'u', 'U', 'h', 'H', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.'])

/** Typing in a field (a dialog, the inspector) never drives the tool. */
function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/**
 * The Architecture workflow, mounted over the canvas: the armed tool's
 * drawing (clicks from the plan, keys from the window), the hint bar, and
 * the Architecture section of the properties panel.
 */
export function WorkflowHost({ services, outlet }: WorkflowHostProps): ReactNode {
  const { model, levelId, submit, notify, setClickHandler, subscribeHover, pickPlanPointAt, planPointOnScreen, showLiveModel, editBlocked, modelToolsOff } = services
  const [draft, setDraft] = useState<Draft | null>(null)
  const [aimed, setAimed] = useState<{ readonly point: Vec2; readonly snap: Snap } | null>(null)
  /** Walls drawn run up to the level above (the default) or keep a set height. */
  const [wallsTiedChoice, setWallsTied] = useState(true)
  // An older model server keeps only heights: walls are drawn at the level-to-level height, untied.
  const tiesStored = !services.serverFeatures || services.serverFeatures.includes(WALLS_TOP_CONSTRAINT_FEATURE)
  const wallsTied = wallsTiedChoice && tiesStored
  // An older model server keeps no surface bindings: Properties says so beside the Top and Base choices.
  const surfacesStored = !services.serverFeatures || services.serverFeatures.includes(WALLS_SURFACE_BINDING_FEATURE)
  /** A height typed with H for the walls drawn next; null: the level's height. */
  const [typedHeightMm, setTypedHeight] = useState<number | null>(null)
  const [heightEntryOpen, setHeightEntryOpen] = useState(false)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const hovered = useRef<readonly string[]>([])
  const draftRef = useRef<Draft | null>(null)
  useLayoutEffect(() => {
    draftRef.current = draft
  })

  const blocked = editBlocked ?? services.planPointsOff ?? (modelToolsOff ? 'Draw walls and doors in a plan: open one from the Views and sheets panel' : levelId ? null : 'Open a floor plan to draw on its level')
  const drawLevel = useMemo(() => (model && levelId ? levelOf(model, levelId) : null), [model, levelId])
  const drawHeight = useMemo(() => (drawLevel ? wallDrawHeight(drawLevel, wallsTied, typedHeightMm) : null), [drawLevel, wallsTied, typedHeightMm])
  const armedTool = draft?.tool ?? null
  // The Wall, Door and Window tools draw with a starter type; the model takes it the first time.
  const toolType = useMemo(() => (model && armedTool ? toolTypeFor(model.elements, armedTool) : null), [model, armedTool])

  const ctx = useMemo(
    (): DraftContext | null =>
      model && levelId
        ? {
            elements: model.elements,
            levelId,
            newId: (p) => newId(`arch-${p}`),
            ...(toolType ? { typeId: toolType.typeId } : {}),
            ...(toolType?.thicknessMm ? { thicknessMm: toolType.thicknessMm } : {}),
            ...(toolType?.openingSize ? { openingSize: toolType.openingSize } : {}),
            ...(drawHeight ? { wallHeightMm: drawHeight.heightMm } : {}),
            ...(drawHeight?.topLevelId ? { wallTopLevelId: drawHeight.topLevelId } : {}),
            wallsAt: (p) =>
              wallsNear(model.elements, levelId, p, 600)
                .map((w) => {
                  const dx = w.end.x - w.start.x
                  const dy = w.end.y - w.start.y
                  const t = Math.min(1, Math.max(0, ((p.x - w.start.x) * dx + (p.y - w.start.y) * dy) / (dx * dx + dy * dy || 1)))
                  return { id: w.id, d: Math.hypot(w.start.x + dx * t - p.x, w.start.y + dy * t - p.y) - w.widthMm / 2 }
                })
                .filter((w) => w.d <= 600)
                .sort((a, b) => a.d - b.d)
                .map((w) => w.id),
            faceAt: (p) => faceFor(model, levelId, p, draftRef.current?.tool.mode === 'room'),
            roomCommand: (p) => roomFromWallsCommand(model, levelId as ElementId, p).command,
          }
        : null,
    [model, levelId, drawHeight, toolType],
  )

  const send = useCallback(
    (command: Parameters<typeof submit>[0] | null, label: string) => {
      if (!command) return
      const err = submit(command, label)
      if (err) {
        console.error('[architecture] a drawing command was refused', { type: command.type, err })
        notify(err, 'error')
      }
    },
    [submit, notify],
  )

  /** The plan point under the pointer, snapped (doors and windows take the raw point: they slide along their wall). */
  const aimAt = useCallback((): { readonly point: Vec2; readonly snap: Snap | null } | null => {
    const at = pointer.current
    const raw = at ? pickPlanPointAt(at.x, at.y) : null
    const d = draftRef.current
    if (!at || !raw || !d || !model || !levelId) return null
    if (d.tool.mode === 'hosted' || d.tool.mode === 'room') return { point: raw, snap: null }
    const beside = pickPlanPointAt(at.x + SNAP_PX, at.y)
    const toleranceMm = beside ? Math.hypot(beside.x - raw.x, beside.y - raw.y) : 300
    // A rectangle's opposite corner snaps to walls and grids, never square to its first corner (that would flatten it).
    const snap = snapPoint({ model, levelId, raw, toleranceMm, corners: d.tool.mode === 'rectangle' ? [] : d.chain.points, gridMm: DRAFTING_GRID_MM, linked: linkedSnapNear(model, levelId, raw, toleranceMm) })
    return { point: snap.point, snap }
  }, [pickPlanPointAt, model, levelId])
  const planPoint = useCallback((): Vec2 | null => aimAt()?.point ?? null, [aimAt])

  const setTool = useCallback(
    (id: ArchitectureToolId | null) => {
      const tool = id ? toolById(id) : undefined
      const next = tool && tool.mode !== 'dialog' ? startDraft(tool) : null
      // A plan showing its printed drawing can't take clicks: show its live model, as Place part and Route do.
      if (next) showLiveModel?.()
      setHeightEntryOpen(false)
      setDraft(next)
      setAimed(null)
    },
    [showLiveModel],
  )

  const armed = draft !== null
  useEffect(() => {
    if (!armed) return undefined
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
      const d = draftRef.current
      if (!d || !ctx) return
      const aim = aimAt()
      setAimed(aim?.snap ? { point: aim.point, snap: aim.snap } : null)
      setDraft(hoverDraft(d, ctx, aim?.point ?? null, hovered.current))
    }
    // A wheel zoom moves the camera under a still pointer: the preview follows on the next frame.
    const zoom = (e: WheelEvent) => requestAnimationFrame(() => move(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY })))
    window.addEventListener('pointermove', move)
    window.addEventListener('wheel', zoom, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('wheel', zoom)
    }
  }, [armed, ctx, aimAt])

  // Re-registered only when a tool is armed or put away, not per corner: the handlers read the draft through a ref.
  useEffect(() => (armed && subscribeHover ? subscribeHover((ids) => (hovered.current = ids ?? [])) : undefined), [armed, subscribeHover])

  useEffect(() => {
    if (!armed || !ctx || !setClickHandler) return undefined
    return setClickHandler({
      claims: () => true,
      click: (ids) => {
        const p = planPoint()
        const d = draftRef.current
        if (!p || !d) return true
        const step = clickDraft(d, ctx, p, ids)
        setDraft(step.draft)
        send(step.command, `Draw ${d.tool.noun}`)
        return true
      },
    })
  }, [armed, ctx, setClickHandler, planPoint, send])

  useEffect(() => {
    if (!armed || !ctx) return undefined
    const key = (e: KeyboardEvent) => {
      if (!TOOL_KEYS.has(e.key) || typingInField(e.target) || e.metaKey || e.ctrlKey) return
      const d = draftRef.current
      if (!d) return
      e.preventDefault()
      if (e.key === 'h' || e.key === 'H') {
        if (d.tool.mode === 'chain' || d.tool.mode === 'rectangle') setHeightEntryOpen(true)
        return
      }
      if (e.key === 'u' || e.key === 'U') {
        if (d.tool.mode !== 'chain' && d.tool.mode !== 'rectangle') return
        if (!tiesStored) {
          notify("This model server is an older version that keeps wall heights but not wall tops tied to a level; walls are drawn at the level-to-level height. Try again once the server is updated", 'info')
          return
        }
        if (!drawLevel?.upToId) {
          notify(`There is no level above ${drawLevel?.name ?? 'this level'} for the walls to run up to; add one with Level, or draw them at a set height`, 'info')
          return
        }
        // A typed height goes back to running up to the level above.
        if (typedHeightMm !== null) {
          setTypedHeight(null)
          setWallsTied(true)
          return
        }
        setWallsTied((t) => !t)
        return
      }
      const step = keyDraft(d, ctx, e.key, planPoint())
      send(step.command, `Draw ${d.tool.noun}`)
      setDraft(step.finish ? null : step.draft)
      if (step.finish) setAimed(null)
    }
    // A double-click puts the last corner down and finishes the chain or sketch (the tool stays in hand, as Enter).
    const finish = () => {
      const d = draftRef.current
      if (!d || (d.tool.mode !== 'chain' && d.tool.mode !== 'area')) return
      const step = keyDraft(d, ctx, 'Enter', null)
      send(step.command, `Draw ${d.tool.noun}`)
      setDraft(step.draft)
    }
    // Capture: the tool hears its keys before the surface's shortcuts (Backspace takes a corner back, it doesn't delete the selection).
    window.addEventListener('keydown', key, true)
    window.addEventListener('dblclick', finish)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('dblclick', finish)
    }
  }, [armed, ctx, planPoint, send, drawLevel, notify, tiesStored, typedHeightMm])

  // Edit type… opens on the one selected element's type; nothing typed selected leaves the button saying why.
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null)
  const selectedType = useMemo(() => {
    const el = model && services.selectedIds.length === 1 ? model.elements[services.selectedIds[0] ?? ''] : undefined
    const typeId = el && 'typeId' in el && typeof el.typeId === 'string' ? el.typeId : null
    const type = typeId && model ? model.elements[typeId] : undefined
    return type?.kind === 'element_type' ? type : null
  }, [model, services.selectedIds])
  const editing = editingTypeId && model ? model.elements[editingTypeId] : undefined
  const linkedReference = useLinkedReferenceState()
  const editType = selectedType && editBlocked === null ? () => setEditingTypeId(selectedType.id) : null

  const editTypeWhy = editBlocked ?? (selectedType ? null : 'Select one wall, door or window that has a type (pick one in Properties)')
  const level = levelButton({ editBlocked, modelToolsOff, ...(services.requestLevel ? { requestLevel: services.requestLevel } : {}) })
  const ribbon: ArchitectureRibbon = { tool: draft?.tool.id ?? null, setTool, blocked, editType, editTypeWhy, ...level }

  usePublishWorkflow(outlet, {
    data: { ribbon, autoTab: null, shared: {} },
    properties: <ArchitectureProperties model={model} selectedIds={services.selectedIds} submit={submit} editBlocked={editBlocked} notify={notify} tiesStored={tiesStored} surfacesStored={surfacesStored} />,
  })

  const sillWords = model && draft && (draft.tool.kind === 'window' || draft.tool.kind === 'door') ? `sill ${feetInches(openingToolSillMm(model, toolType?.typeId ?? null, draft.tool.kind))} (change it in Properties after placing)` : null
  const where = drawLevel ? `${drawLevel.name}${toolType ? ` · ${toolType.name}` : ''}${draft?.tool.mode === 'chain' || draft?.tool.mode === 'rectangle' ? ` · ${wallTopWords(drawLevel, wallsTied, typedHeightMm)}` : ''}${sillWords ? ` · ${sillWords}` : ''}` : null
  const refused = (draft?.aim && !draft.aim.ok) || (draft?.tool.mode === 'room' && draft.face && !draft.face.ok)
  const linkedWords = linkedReferenceWords(linkedReference)
  const hintText = draft ? [where, draftHint(draft), draft.tool.mode === 'chain' || draft.tool.mode === 'rectangle' ? linkedWords : null].filter((t): t is string => Boolean(t)).join(' · ') : ''

  // One wall selected and no tool in hand: a grip at each end drags that end.
  const endWall = !draft && editBlocked === null && !modelToolsOff && model && services.selectedIds.length === 1 ? wallEnds(model, services.selectedIds[0], levelId) : null

  return (
    <>
      {endWall && model && levelId && planPointOnScreen ? <WallEndGrips model={model} levelId={levelId} wall={endWall} toScreen={planPointOnScreen} pickPlanPointAt={pickPlanPointAt} submit={submit} notify={notify} hintClassName={services.propertiesOpen ? 'right-[21.5rem]' : undefined} /> : null}
      {draft && model && planPointOnScreen ? <DraftOverlay draft={draft} pointer={aimed?.point ?? null} snap={aimed?.snap ?? null} elements={model.elements} toScreen={planPointOnScreen} /> : null}
      {heightEntryOpen && drawHeight && (draft?.tool.mode === 'chain' || draft?.tool.mode === 'rectangle') ? (
        <WallHeightEntry
          currentMm={drawHeight.heightMm}
          onSet={(mm) => {
            setTypedHeight(mm)
            setHeightEntryOpen(false)
          }}
          onClose={() => setHeightEntryOpen(false)}
        />
      ) : null}
      {draft ? <ToolHintBar text={hintText} tone={refused ? 'warning' : 'info'} testId="architecture-hint" className={services.propertiesOpen ? 'right-[21.5rem]' : undefined} /> : null}
      {model && editing?.kind === 'element_type' ? <EditTypeDialog model={model} type={editing} submit={submit} editBlocked={editBlocked} onClose={() => setEditingTypeId(null)} /> : null}
    </>
  )
}
