'use client'

import { cn } from '../ui/cn'

const LABEL = { segment: 'Move', corner: 'Corner', end: 'Stretch' } as const

/**
 * The handle a press would grab on a routed run: a dot in the middle of a
 * straight piece (moves it whole), a diamond at an elbow or a piece's end
 * where an elbow is (moves the corner), a square at an open end (stretches).
 * Drawn over the canvas; the pointer passes through it.
 */
export function RunGrabHandle({ handle }: { handle: { x: number; y: number; kind: 'segment' | 'corner' | 'end'; hint: string } }) {
  return (
    <div className="pointer-events-none absolute" style={{ left: handle.x, top: handle.y }} data-testid="run-grab-handle" data-kind={handle.kind} title={handle.hint}>
      <span
        className={cn(
          'absolute -translate-x-1/2 -translate-y-1/2 border-2 border-primary bg-background shadow-sm',
          handle.kind === 'segment' && 'size-3 rounded-full',
          handle.kind === 'corner' && 'size-3 rotate-45',
          handle.kind === 'end' && 'size-3',
        )}
      />
      <span className="absolute left-2.5 top-2 rounded-sm border bg-background/95 px-1 text-[10px] leading-4 text-muted-foreground shadow-sm">{LABEL[handle.kind]}</span>
      <span className="sr-only">{handle.hint}</span>
    </div>
  )
}
