'use client'

import { useRef, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/** Lists up to this long render every row, as before; longer ones render only what is on screen. */
export const WINDOW_AFTER_ROWS = 100
/** Height of a windowed list's own scroll area. */
export const WINDOW_VIEWPORT_PX = 448
const OVERSCAN = 8

export interface WindowedRows {
  /** True once the list is long enough to window; the caller then gives its scroll box a fixed height. */
  readonly windowed: boolean
  readonly scrollRef: RefObject<HTMLDivElement | null>
  /** Row indexes to render, in order. */
  readonly indexes: readonly number[]
  /** Space above and below the rendered rows, px. */
  readonly padTop: number
  readonly padBottom: number
  /** Put on each rendered row (with `data-index`) so real heights replace the estimate. */
  readonly measure: (el: Element | null) => void
}

const NO_MEASURE = (): void => undefined

/** The rows `useWindowedRows` says to render, with their index for `data-index`. */
export function windowSlice<T>(items: readonly T[], rows: WindowedRows): { readonly item: T; readonly index: number }[] {
  const out: { item: T; index: number }[] = []
  for (const index of rows.indexes) {
    const item = items[index]
    if (item !== undefined) out.push({ item, index })
  }
  return out
}

/** Inline style for a windowed list's scroll box (undefined when the list is short). */
export function windowBoxStyle(rows: WindowedRows): { maxHeight: number } | undefined {
  return rows.windowed ? { maxHeight: WINDOW_VIEWPORT_PX } : undefined
}

/**
 * Window a long list or table body over its own scroll box: a 2,000-row list
 * renders a screenful plus a few rows, not 2,000. Short lists are unchanged.
 */
export function useWindowedRows(count: number, estimateRowPx: number): WindowedRows {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const windowed = count > WINDOW_AFTER_ROWS
  const virtualizer = useVirtualizer({
    count: windowed ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowPx,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: WINDOW_VIEWPORT_PX },
  })
  if (!windowed) return { windowed, scrollRef, indexes: Array.from({ length: count }, (_, i) => i), padTop: 0, padBottom: 0, measure: NO_MEASURE }
  const items = virtualizer.getVirtualItems()
  const first = items[0]
  const last = items[items.length - 1]
  return {
    windowed,
    scrollRef,
    indexes: items.map((item) => item.index),
    padTop: first ? first.start : 0,
    padBottom: last ? Math.max(0, virtualizer.getTotalSize() - last.end) : 0,
    measure: virtualizer.measureElement,
  }
}
