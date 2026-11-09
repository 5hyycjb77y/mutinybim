'use client'

import { useCallback, useState } from 'react'

/**
 * The ribbon tab a person picked, kept only while what they picked it for stays
 * (`context`: what is open, the tool, and which items are selected, by id).
 * Selecting a different item opens the tab that fits it; so does selecting the
 * same item again after something else was selected in between, because the
 * pick is forgotten as soon as the context moves on (product decision, Nov 5 2026). Before,
 * a pick came back whenever its context did, so a tab picked while a new item
 * was selected kept winning over that item's own tab.
 */
export function useRibbonTabMemory(context: string): { readonly picked: string | null; readonly pick: (tab: string) => void } {
  const [memo, setMemo] = useState<{ readonly context: string; readonly tab: string } | null>(null)
  // Adjust during render when the context moves on (React's "state from a prop" pattern): the pick is gone before anything reads it.
  const [seen, setSeen] = useState(context)
  if (seen !== context) {
    setSeen(context)
    if (memo !== null) setMemo(null)
  }
  const pick = useCallback((tab: string) => setMemo({ context, tab }), [context])
  return { picked: memo && memo.context === context ? memo.tab : null, pick }
}

/** What the ribbon's memory keys on: the open item, the drawing, the selected ids (model or drawn), the route tool, a drawing tool other than Select. */
export function ribbonContextKey(parts: { readonly openKey: string; readonly drawingOpen: string | null; readonly selectedIds: readonly string[]; readonly drawnIds: readonly string[]; readonly routing: boolean; readonly drawingTool?: string | null }): string {
  const drawing = parts.drawingOpen !== null && parts.drawingTool && parts.drawingTool !== 'select' ? `tool:${parts.drawingTool}` : ''
  return [parts.openKey, parts.drawingOpen ?? 'model', parts.selectedIds.join(','), parts.routing ? 'route' : '', parts.drawnIds.length > 0 ? `drawn:${parts.drawnIds.join(',')}` : '', drawing].join('|')
}

/**
 * The tab the ribbon opens when the person has not picked one for this context.
 * A tool in use keeps its own tab: Route, and on a drawing every drawing tool
 * (they all live on Annotate). A finished shape is selected while its tool
 * stays on, so without this the ribbon left Annotate after every line drawn.
 */
export function autoRibbonTab(parts: {
  readonly routing: boolean
  readonly drawingOpen: 'sheet' | 'detail' | null
  readonly drawingTool: string
  readonly drawnSelected: boolean
  readonly modelSelected: boolean
  readonly selectionTab: string | null
  readonly scheduleOpen: boolean
}): string {
  // Route has its own tab wherever it runs, a printed plan included: there it used to land on Annotate,
  // where Route isn't, so the tool just picked vanished from the ribbon.
  if (parts.routing) return 'route'
  if (parts.drawingOpen && parts.drawingTool !== 'select') return 'annotate'
  if (parts.drawnSelected) return 'drawn-items'
  if (parts.modelSelected) return parts.selectionTab ?? 'selection'
  if (parts.drawingOpen === 'sheet') return 'sheets'
  if (parts.drawingOpen === 'detail') return parts.scheduleOpen ? 'views' : 'annotate'
  return 'model'
}
