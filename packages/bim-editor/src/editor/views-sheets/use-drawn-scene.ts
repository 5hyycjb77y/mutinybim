import { useMemo } from 'react'
import { buildSheetSceneFor, buildViewScene, withCategoryRegistry, type CategoryRegistry, type ModelState, type SheetScene, type ViewBackgrounds, type ViewFrame } from '@permitzip/bim-kernel'
import type { SheetTitle } from '../../contracts/building-model/sheet-title'

export type DrawingTarget = { readonly kind: 'sheet'; readonly sheetId: string } | { readonly kind: 'detail'; readonly viewId: string }

export interface DrawnScene {
  readonly scene: SheetScene | null
  readonly frame: ViewFrame | null
  readonly error: string | null
}

/**
 * The open sheet or view drawn as it prints. Keyed on the target's kind and id,
 * not the object: parents pass a fresh `target` literal on every render, and a
 * new scene each time restarts the printed PDF render before it can finish.
 * `categories` (the firm library's classes) lets Visibility/Graphics on a
 * firm class draw; absent, the built-in categories.
 */
export function useDrawnScene(model: ModelState, target: DrawingTarget, title: SheetTitle, backgrounds: ViewBackgrounds | undefined, categories?: CategoryRegistry): DrawnScene {
  const kind = target.kind
  const id = target.kind === 'sheet' ? target.sheetId : target.viewId
  return useMemo(() => {
    const draw = (): DrawnScene => {
      if (kind === 'sheet') {
        const scene = buildSheetSceneFor(model, id, { ...title, ...(backgrounds ? { backgrounds } : {}) })
        return { scene, frame: null, error: null }
      }
      const { scene, frame } = buildViewScene(model, id, backgrounds?.[id] ?? [])
      return { scene, frame, error: null }
    }
    try {
      return categories ? withCategoryRegistry(categories, draw) : draw()
    } catch (err) {
      console.error('[DrawingCanvas] drawing failed', { kind, id, err })
      return { scene: null, frame: null, error: kind === 'sheet' ? 'This sheet no longer exists.' : 'This view no longer exists.' }
    }
  }, [model, kind, id, title, backgrounds, categories])
}
