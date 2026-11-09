'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { boxAroundAabb, boxTurnedTo, viewCropBox3d, workingAngleFromEdge, workingAngleOf, workingViewOf, type Aabb3, type CropBox3d, type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import type { Selection } from '../model-session'
import { newId, type SubmitCommand } from './types'

/**
 * The 3D crop box of whatever 3D picture is in the canvas: an open saved 3D
 * view, or (in the free 3D model) your own working 3D view, "{3D - you}",
 * which is made the first time you turn its crop box on. Without edit access
 * the box still works here, in this tab only, and says so.
 */

export interface Crop3d {
  /** A 3D picture is in the canvas, so 3D crop commands apply. */
  readonly active: boolean
  /** The saved view the box belongs to (null: the free model with no working view yet, or a box kept only in this tab). */
  readonly view: ViewElement | null
  readonly box: CropBox3d | null
  readonly on: boolean
  readonly shown: boolean
  /** Turn crop or the box on or off. */
  readonly set: (change: { readonly enabled?: boolean; readonly show?: boolean }) => void
  /** Save a new box (a grip released, numbers typed). Returns the refusal, if any. */
  readonly setBox: (box: CropBox3d, label: string) => string | null
  /** Fit the box to what is selected (grown out to its storey and grid bay) and crop. */
  readonly toSelection: () => Promise<void>
  /** Back to the whole model (linked models included). */
  readonly reset: () => Promise<void>
  /** A new saved 3D view of what is selected, cropped to its storey and bay, looking from here. */
  readonly newViewOfSelection: () => Promise<void>
  /** Why crop to selection / new view of selection can't run (null when they can). */
  readonly selectionBlocked: string | null
  /** The working angle in the 3D picture in the canvas (the view's own, else the model's). */
  readonly workingAngleDeg: number
  /** Turn the box about its middle to the working angle, size kept. Returns the refusal, if any. */
  readonly alignToWorkingAngle: () => string | null
  /** Turn the box about its middle square to an edge through two plan points, size kept. Returns the refusal, if any. */
  readonly alignToEdge: (from: Vec2, to: Vec2) => string | null
  /** Why aligning can't run (null when it can). */
  readonly alignBlocked: string | null
}

interface Args {
  readonly viewer: ModelViewer3D | null
  readonly model: ModelState | null
  readonly views: readonly ViewElement[]
  /** The saved 3D view open in the canvas (live model, not its drawing). */
  readonly openView3d: ViewElement | null
  /** The free 3D model is in the canvas. */
  readonly free3d: boolean
  readonly selection: Selection | null
  readonly userId: string
  readonly userName: string
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onOpenView: (id: string) => void
  readonly notify: (message: string, kind?: 'info' | 'error') => void
}

/** The working 3D view's name for a person, unique among the views. */
export function workingViewName(userName: string, views: readonly ViewElement[]): string {
  const base = `{3D - ${userName.trim() || 'me'}}`
  const taken = new Set(views.map((v) => v.name.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** The ids a crop-to-selection fits to (authored elements), or null for a linked element (its box comes from the viewer). */
function selectedIds(selection: Selection | null): readonly string[] | null {
  if (!selection) return null
  if (selection.kind === 'authored') return [selection.element.id]
  if (selection.kind === 'group') return selection.ids.slice(0, 5000)
  return null
}

export function useCrop3d(args: Args): Crop3d {
  const { viewer, model, views, openView3d, free3d, selection, userId, userName, canEdit, blockedReason, submit, onOpenView, notify } = args
  const working = useMemo(() => workingViewOf(views, userId), [views, userId])
  const view = openView3d ?? (free3d ? working : null)
  const active = openView3d !== null || free3d
  /** A box kept in this tab only (no edit access), per what is open. */
  const [local, setLocal] = useState<{ key: string; box: CropBox3d; on: boolean; shown: boolean } | null>(null)
  const localKey = openView3d ? `view:${openView3d.id}` : 'free'
  const localHere = local && local.key === localKey ? local : null

  const savedBox = view && model ? viewCropBox3d(model, view) : null
  const box = localHere?.box ?? savedBox
  const on = localHere ? localHere.on : view ? view.props?.cropView !== false : false
  const shown = localHere ? localHere.shown : view ? view.props?.showCropBox !== false : false

  useEffect(() => {
    if (!viewer) return
    viewer.setCropBox(active && box ? box : null, { crop: on, show: shown })
  }, [viewer, active, box, on, shown])
  useEffect(() => () => viewer?.setCropBox(null), [viewer])

  const extent = useCallback(async (): Promise<Aabb3 | undefined> => (await viewer?.sceneExtentMm()) ?? undefined, [viewer])

  /** Make your working 3D view (free model, first crop). Returns the refusal, if any. */
  const createWorking = useCallback(
    async (fit: { box?: CropBox3d; elementIds?: readonly string[]; region?: Aabb3 } | null, change: { enabled?: boolean; show?: boolean }): Promise<string | null> => {
      const name = workingViewName(userName, views)
      const camera = viewer?.camera3dState() ?? undefined
      return submit(
        {
          type: 'create_3d_view',
          viewId: newId('view'),
          name,
          workingFor: userId,
          ...(camera ? { camera } : {}),
          ...(fit?.box ? { cropBox: fit.box } : fit?.elementIds || fit?.region ? { fit: { ...(fit.elementIds ? { elementIds: [...fit.elementIds] } : {}), ...(fit.region ? { region: fit.region } : {}) } } : { extent: await extent() }),
          cropView: change.enabled ?? true,
          showCropBox: change.show ?? true,
        },
        'turn on your 3D crop box',
      )
    },
    [userName, views, viewer, submit, userId, extent],
  )

  const set = useCallback(
    (change: { readonly enabled?: boolean; readonly show?: boolean }) => {
      if (!active) return
      if (!canEdit) {
        const base = box ?? null
        if (!base) {
          void extent().then((e) => {
            if (!e) return notify('There is nothing loaded to crop yet.', 'info')
            setLocal({ key: localKey, box: boxAroundAabb(e, model ? workingAngleOf(model, view) : 0), on: change.enabled ?? true, shown: change.show ?? true })
          })
        } else setLocal({ key: localKey, box: base, on: change.enabled ?? on, shown: change.show ?? shown })
        notify(`Cropping here only, in this tab. ${blockedReason}`, 'info')
        return
      }
      if (!view) {
        void createWorking(null, change).then((refusal) => refusal && notify(refusal, 'error'))
        return
      }
      const refusal = submit({ type: 'set_3d_crop_box', viewId: view.id, ...(change.enabled !== undefined ? { enabled: change.enabled } : {}), ...(change.show !== undefined ? { show: change.show } : {}) }, change.enabled === undefined ? (change.show ? 'show the 3D crop box' : 'hide the 3D crop box') : change.enabled ? 'crop to the 3D box' : 'stop cropping')
      if (refusal) notify(refusal, 'error')
    },
    [active, canEdit, view, box, extent, localKey, on, shown, notify, blockedReason, createWorking, submit, model],
  )

  const setBox = useCallback(
    (next: CropBox3d, label: string): string | null => {
      if (!canEdit || !view) {
        if (!localHere) notify(canEdit ? 'Cropping here only, in this tab. Turn on the 3D crop box to keep it.' : `Cropping here only, in this tab. ${blockedReason}`, 'info')
        setLocal({ key: localKey, box: next, on, shown })
        return null
      }
      return submit({ type: 'set_3d_crop_box', viewId: view.id, box: next }, label)
    },
    [canEdit, view, localHere, localKey, on, shown, submit, notify, blockedReason],
  )

  const selectionBlocked = !active
    ? 'Works in 3D: open the 3D model or a 3D view.'
    : !selection
      ? 'Select something first: a duct, a part, a run or a linked element.'
      : null

  /** What the selection covers: authored ids, or a linked element's box from the viewer. */
  const selectionTarget = useCallback(async (): Promise<{ elementIds?: readonly string[]; region?: Aabb3 } | null> => {
    const ids = selectedIds(selection)
    if (ids) return { elementIds: ids }
    const region = await viewer?.selectedBoxMm()
    return region ? { region } : null
  }, [selection, viewer])

  const toSelection = useCallback(async () => {
    if (selectionBlocked) return notify(selectionBlocked, 'info')
    const target = await selectionTarget()
    if (!target) return notify("That element's size couldn't be read, so the box can't be fitted to it. Drag the box's faces instead.", 'error')
    if (!canEdit) return notify(`Crop to selection saves the box on the view. ${blockedReason}`, 'info')
    if (!view) {
      const refusal = await createWorking(target, { enabled: true, show: true })
      if (refusal) notify(refusal, 'error')
      return
    }
    const refusal = submit(
      { type: 'set_3d_crop_box', viewId: view.id, fit: 'selection', ...(target.elementIds ? { elementIds: [...target.elementIds] } : {}), ...(target.region ? { region: target.region } : {}), enabled: true },
      'crop the 3D view to the selection',
    )
    if (refusal) notify(refusal, 'error')
  }, [selectionBlocked, selectionTarget, canEdit, view, createWorking, submit, notify, blockedReason])

  const reset = useCallback(async () => {
    if (!active) return
    const e = await extent()
    if (!canEdit || !view) {
      setLocal(null)
      if (!view && free3d && canEdit) {
        const refusal = await createWorking(null, { enabled: true, show: true })
        if (refusal) notify(refusal, 'error')
      }
      return
    }
    const refusal = submit({ type: 'set_3d_crop_box', viewId: view.id, fit: 'model', ...(e ? { extent: e } : {}) }, 'reset the 3D crop box')
    if (refusal) notify(refusal, 'error')
  }, [active, extent, canEdit, view, free3d, createWorking, submit, notify])

  const newViewOfSelection = useCallback(async () => {
    if (selectionBlocked) return notify(selectionBlocked, 'info')
    if (!canEdit) return notify(blockedReason, 'info')
    const target = await selectionTarget()
    if (!target) return notify("That element's size couldn't be read, so a view can't be framed on it. Select a duct or part instead.", 'error')
    const taken = new Set(views.map((v) => v.name.toLowerCase()))
    let name = '3D of selection'
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `3D of selection ${n}`
    const id = newId('view')
    const refusal = submit(
      {
        type: 'create_3d_view',
        viewId: id,
        name,
        fit: { ...(target.elementIds ? { elementIds: [...target.elementIds] } : {}), ...(target.region ? { region: target.region } : {}) },
      },
      `create ${name}`,
    )
    if (refusal) return notify(refusal, 'error')
    onOpenView(id)
    notify(`${name} created, cropped to the storey and grid bay around your selection. Rename it from its properties.`, 'info')
  }, [selectionBlocked, canEdit, blockedReason, selectionTarget, views, submit, onOpenView, notify])

  const workingAngleDeg = model ? workingAngleOf(model, view) : 0
  const alignBlocked = !active ? 'Works in 3D: open the 3D model or a 3D view.' : !box ? 'Turn on the 3D crop box first.' : null

  /** Turn the box: saved on the view with edit access, else kept in this tab. */
  const turnBox = useCallback(
    (angleDeg: number, align: 'working_angle' | { from: Vec2; to: Vec2 }, label: string): string | null => {
      if (alignBlocked || !box) return alignBlocked
      if (Math.abs(box.rotationDeg - angleDeg) < 1e-6) return align === 'working_angle' ? 'The crop box is already square to the working angle.' : 'The crop box is already square to that edge.'
      if (!canEdit || !view) {
        setLocal({ key: localKey, box: boxTurnedTo(box, angleDeg), on, shown })
        notify(canEdit ? 'Cropping here only, in this tab. Turn on the 3D crop box to keep it.' : `Cropping here only, in this tab. ${blockedReason}`, 'info')
        return null
      }
      return submit({ type: 'set_3d_crop_box', viewId: view.id, align }, label)
    },
    [alignBlocked, box, canEdit, view, localKey, on, shown, notify, blockedReason, submit],
  )
  const alignToWorkingAngle = useCallback(() => turnBox(workingAngleDeg, 'working_angle', 'align the 3D crop box to the working angle'), [turnBox, workingAngleDeg])
  const alignToEdge = useCallback(
    (from: Vec2, to: Vec2) => {
      const angle = workingAngleFromEdge(from, to)
      if (angle === null) return 'The two points are the same; pick a second point further along the edge.'
      return turnBox(angle, { from, to }, 'align the 3D crop box to an edge')
    },
    [turnBox],
  )

  return { active, view, box, on, shown, set, setBox, toSelection, reset, newViewOfSelection, selectionBlocked, workingAngleDeg, alignToWorkingAngle, alignToEdge, alignBlocked }
}
