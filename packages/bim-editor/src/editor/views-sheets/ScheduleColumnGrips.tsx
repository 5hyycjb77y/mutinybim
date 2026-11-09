'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { clampScheduleColumnWidth, type Rect, type ScheduleViewColumn, type Vec2 } from '@permitzip/bim-kernel'

/**
 * Drag a schedule's column edges where it sits on a sheet (product decision, Nov 6:
 * "should be able to adjust the size of these columns"). Each right edge of a
 * column a person can size gets a grip; letting go saves the column's paper
 * width in the schedule itself (one `edit_schedule` resize step), so every
 * sheet and print of it follows.
 */

export interface ColumnResize {
  readonly columnId: string
  readonly widthMm: number
}

/** The width a column gets when its right edge is dragged `dxMm` on paper. */
export function draggedColumnWidth(column: ScheduleViewColumn, dxMm: number): number {
  return clampScheduleColumnWidth(column.x1 - column.x0 + dxMm)
}

interface ColumnDrag {
  readonly index: number
  readonly fromX: number
  readonly dx: number
}

const PRIMARY = 'var(--mutiny-selection)'
const GRIP_MM = 1.6

export function ScheduleColumnGrips({
  name,
  rect,
  columns,
  canEdit,
  blockedReason,
  paperOf,
  onResize,
}: {
  name: string
  rect: Rect
  columns: readonly ScheduleViewColumn[]
  canEdit: boolean
  blockedReason: string
  paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  onResize: (resize: ColumnResize) => void
}) {
  const [drag, setDragState] = useState<ColumnDrag | null>(null)
  // The pointer handlers read the drag from here, not from the last render: on a busy page (the printed
  // sheet re-rendering) the press, the moves and the release arrive before React renders between them,
  // and a release that read the render's drag saw no drag and saved nothing.
  const dragRef = useRef<ColumnDrag | null>(null)
  const setDrag = useCallback((next: ColumnDrag | null) => {
    dragRef.current = next
    setDragState(next)
  }, [])
  const top = rect.min.y
  const height = rect.max.y - rect.min.y
  return (
    <g data-testid={`schedule-column-grips-${name}`}>
      {columns.map((column, index) => {
        if (!column.columnId) return null
        const live = drag?.index === index ? drag.dx : 0
        const x = rect.min.x + column.x0 + draggedColumnWidth(column, live)
        const label = `Drag to change the width of column ${index + 1}`
        return (
          <g key={`${column.columnId}-${index}`}>
            {drag?.index === index && <line x1={x} x2={x} y1={top} y2={top + height} stroke={PRIMARY} strokeWidth={0.4} pointerEvents="none" data-testid="schedule-column-guide" />}
            <rect
              x={x - GRIP_MM / 2}
              y={top}
              width={GRIP_MM}
              height={height}
              fill="transparent"
              className="cursor-col-resize hover:fill-(--mutiny-selection)/20"
              data-testid={`schedule-column-edge-${column.columnId}`}
              aria-label={label}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                if (!canEdit) {
                  toast.error(blockedReason)
                  return
                }
                const at = paperOf(e)
                if (!at) return
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({ index, fromX: at.x, dx: 0 })
              }}
              onPointerMove={(e) => {
                const current = dragRef.current
                if (current?.index !== index) return
                const at = paperOf(e)
                if (at) setDrag({ ...current, dx: at.x - current.fromX })
              }}
              onPointerUp={(e) => {
                const current = dragRef.current
                if (current?.index !== index) return
                e.stopPropagation()
                const at = paperOf(e)
                const dx = at ? at.x - current.fromX : current.dx
                setDrag(null)
                if (Math.abs(dx) < 0.2 || !column.columnId) return
                onResize({ columnId: column.columnId, widthMm: draggedColumnWidth(column, dx) })
              }}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <title>{label}. Its width saves in the schedule, so every print of it follows.</title>
            </rect>
          </g>
        )
      })}
    </g>
  )
}
