'use client'

import { useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Command, ModelState, ViewElement } from '@permitzip/bim-kernel'
import type { ModelEditBridge } from '../../view-input/bridge'
import { DrawingContextMenu } from './DrawingContextMenu'
import { drawingMenuItems, hideInViewPatch, likeThisIds, menuElementOf, type DrawingMenu, type DrawingMenuAction, type DrawingMenuTarget } from './drawing-menu-items'

export interface DrawingContextMenuOptions {
  readonly model: ModelState
  readonly onSheet: boolean
  /** The plan or section drawn here (the open view, or the one being edited on the sheet); null on bare sheet paper. */
  readonly view: ViewElement | null
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly modelEdit: ModelEditBridge | null | undefined
  /** The canvas's submit: shows the refusal itself and says whether it ran. */
  readonly send: (command: Command, label: string) => boolean
  readonly onOpenView: (viewId: string) => void
  readonly zoomFit: () => void
  /** The placed view behind a viewport id on this sheet. */
  readonly viewportView: (viewportId: string) => ViewElement | null
  /** The model element nearest a screen point in this drawing, when nothing is pre-highlighted. */
  readonly elementNear: (clientX: number, clientY: number) => string | null
  readonly onCreateSimilar?: (elementId: string) => void
  readonly onAddView?: () => void
}

interface Open {
  readonly at: { readonly x: number; readonly y: number }
  readonly menu: DrawingMenu
}

/** What the right-click landed on: a viewport frame, a model element (what the pointer pre-highlights first), or bare paper. */
function targetOf(e: MouseEvent<HTMLElement>, opts: DrawingContextMenuOptions): DrawingMenuTarget {
  const hit = e.target instanceof Element ? e.target : null
  const fromDom = hit?.closest('[data-element-id]')?.getAttribute('data-element-id')
  const near = opts.view ? opts.elementNear(e.clientX, e.clientY) : null
  const ids = [fromDom, ...(opts.modelEdit?.highlighted() ?? []), near].filter((id): id is string => typeof id === 'string')
  const el = menuElementOf(opts.model, ids)
  if (el) return { kind: 'element', elementId: el.id }
  const viewportId = hit?.closest('[data-viewport-id]')?.getAttribute('data-viewport-id')
  const view = viewportId ? opts.viewportView(viewportId) : null
  if (viewportId && view) return { kind: 'viewport', viewportId, view }
  return { kind: 'paper' }
}

/**
 * Right-click menus for the drawing canvas (printed plans and sections, and
 * sheets). `open` takes the canvas's contextmenu event and always stops the
 * browser's own menu; `element` is the menu to render inside the canvas.
 */
export function useDrawingContextMenu(opts: DrawingContextMenuOptions): { open: (e: MouseEvent<HTMLElement>) => void; element: ReactNode } {
  const [shown, setShown] = useState<Open | null>(null)
  // What the last menu was opened on: an item that asks first runs after the menu has closed.
  const lastTarget = useRef<DrawingMenuTarget | null>(null)

  const open = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const target = targetOf(e, opts)
    const menu = drawingMenuItems(target, {
      model: opts.model,
      view: opts.view,
      onSheet: opts.onSheet,
      canEdit: opts.canEdit,
      blockedReason: opts.blockedReason,
      canSelect: Boolean(opts.modelEdit),
      canCreateSimilar: Boolean(opts.onCreateSimilar && opts.modelEdit),
      canAddView: Boolean(opts.onAddView),
    })
    lastTarget.current = target
    setShown({ at: { x: e.clientX - r.left, y: e.clientY - r.top }, menu })
  }

  const run = (action: DrawingMenuAction) => {
    const target = lastTarget.current
    setShown(null)
    if (!target) return
    const { model, view, modelEdit } = opts
    if (action === 'zoom_fit') return opts.zoomFit()
    if (action === 'add_view') return opts.onAddView?.()
    if (target.kind === 'viewport') {
      if (action === 'open_view') opts.onOpenView(target.view.id)
      else if (action === 'remove_from_sheet') opts.send({ type: 'remove_viewport', viewportId: target.viewportId }, 'take the view off the sheet')
      return
    }
    if (target.kind !== 'element') return
    const el = model.elements[target.elementId]
    if (!el) {
      console.error('[DrawingContextMenu] the element is gone from the model', { elementId: target.elementId, action })
      toast.error("That element isn't in the model any more. Right-click it again.")
      return
    }
    if (action === 'properties') return modelEdit?.select(el.id)
    if (action === 'select_like') {
      const ids = likeThisIds(model, view, el)
      const said = modelEdit?.selectBox(ids, 'window')
      if (said) modelEdit?.hint(said)
      return
    }
    if (action === 'create_similar') {
      modelEdit?.select(el.id)
      return opts.onCreateSimilar?.(el.id)
    }
    if (action === 'hide_in_view' && view) {
      const patch = hideInViewPatch(model, view, el)
      if (!patch) return
      const command: Command = { type: 'set_view_properties', viewId: view.id, props: { hiddenCategories: [...patch.hiddenCategories] } }
      const label = `hide ${patch.label} in ${view.name}`
      if (modelEdit) {
        const refusal = modelEdit.submit(command, label)
        if (refusal) {
          console.error('[DrawingContextMenu] Hide in view was refused', { viewId: view.id, refusal })
          toast.error(refusal)
        }
      } else opts.send(command, label)
    }
  }

  return { open, element: <DrawingContextMenu at={shown?.at ?? null} menu={shown?.menu ?? null} onClose={() => setShown(null)} onRun={run} /> }
}
