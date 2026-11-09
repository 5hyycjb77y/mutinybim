'use client'

import { useSyncExternalStore } from 'react'
import type { ViewerStats } from '@permitzip/bim-viewer-3d'

/**
 * The 3D viewer's stats, reported twice a second. Held outside React state so
 * only the readout re-renders, and only while it is on screen; the surface
 * (and an open drawing's printed PDF) is left alone.
 */
export class ViewerStatsFeed {
  private latest: ViewerStats | null = null
  private readonly listeners = new Set<() => void>()

  publish = (stats: ViewerStats): void => {
    this.latest = stats
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current = (): ViewerStats | null => this.latest
}

const NO_STATS = (): null => null

export function ViewerStatsReadout({ feed }: { feed: ViewerStatsFeed }) {
  const stats = useSyncExternalStore(feed.subscribe, feed.current, NO_STATS)
  if (!stats) return null
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border bg-background/90 px-2 py-1 font-mono text-xs text-muted-foreground">
      {stats.fps} fps · {stats.drawCalls} draws · {(stats.triangles / 1000).toFixed(0)}k tris
    </div>
  )
}
