'use client'

import { boxToPaper, textBlockCorners, type TextBlock, type Vec2 } from '@permitzip/bim-kernel'

export type NoteEdge = 'left' | 'right' | 'bottom'

const PRIMARY = 'var(--mutiny-selection)'
const EDGE_LABEL: Record<NoteEdge, string> = { left: 'left edge (width)', right: 'right edge (width)', bottom: 'bottom edge (fixed height)' }

/** A note on the canvas: its hit area, its box and width/height grips when selected, and who else is editing it. */
export function NoteHandles({
  block,
  selected,
  editing,
  lockedBy,
  canEdit,
  interactive,
  blockedReason,
  onBodyDown,
  onEdit,
  onGrab,
}: {
  block: TextBlock
  selected: boolean
  editing: boolean
  lockedBy: string | null
  canEdit: boolean
  interactive: boolean
  blockedReason: string
  onBodyDown: (e: React.PointerEvent<SVGPolygonElement>) => void
  onEdit: () => void
  onGrab: (edge: NoteEdge, e: React.PointerEvent<SVGRectElement>) => void
}) {
  const corners = textBlockCorners(block)
  const points = corners.map((c) => `${c.x.toFixed(3)},${c.y.toFixed(3)}`).join(' ')
  const { width, height } = block.layout
  const grips: ReadonlyArray<{ edge: NoteEdge; at: Vec2; cursor: string }> = [
    { edge: 'left', at: boxToPaper(block, { x: 0, y: height / 2 }), cursor: 'cursor-ew-resize' },
    { edge: 'right', at: boxToPaper(block, { x: width, y: height / 2 }), cursor: 'cursor-ew-resize' },
    { edge: 'bottom', at: boxToPaper(block, { x: width / 2, y: height }), cursor: 'cursor-ns-resize' },
  ]
  const showBox = selected || editing || lockedBy !== null
  const top = corners[0]
  return (
    <g data-testid={`note-${block.itemId}`} data-note-box={`${top.x.toFixed(2)},${top.y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)}`} data-locked-by={lockedBy ?? undefined}>
      <polygon
        points={points}
        fill="transparent"
        stroke={showBox ? (lockedBy ? 'hsl(var(--warning-600))' : PRIMARY) : 'transparent'}
        strokeDasharray={editing ? undefined : '2 1.5'}
        strokeWidth={0.4}
        className={interactive && !editing ? (selected ? 'cursor-move' : 'cursor-pointer') : 'pointer-events-none'}
        onPointerDown={onBodyDown}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        data-testid={`note-hit-${block.itemId}`}
      >
        <title>{lockedBy ? `${lockedBy}. You can edit it when they finish.` : canEdit ? 'Note. Click to select, click again or double-click to edit the text. Drag to move.' : blockedReason}</title>
      </polygon>
      {(selected || editing) &&
        canEdit &&
        !lockedBy &&
        grips.map((g) => (
          <rect
            key={g.edge}
            x={g.at.x - 1.3}
            y={g.at.y - 1.3}
            width={2.6}
            height={2.6}
            fill="var(--mutiny-panel)"
            stroke={PRIMARY}
            strokeWidth={0.4}
            className={g.cursor}
            onPointerDown={(e) => onGrab(g.edge, e)}
            data-testid={`note-grip-${g.edge}`}
          >
            <title>{`Drag the ${EDGE_LABEL[g.edge]}; the text re-wraps as you drag`}</title>
          </rect>
        ))}
      {lockedBy && (
        <g pointerEvents="none" className="select-none" data-testid="note-lock-badge" role="status">
          <rect x={top.x} y={top.y - 5.2} width={Math.max(28, lockedBy.length * 1.45 + 4)} height={4.2} rx={0.8} fill="hsl(var(--warning-50))" stroke="hsl(var(--warning-600))" strokeWidth={0.25} />
          <text x={top.x + 1.5} y={top.y - 2.2} fontSize={2.6} fill="hsl(var(--warning-800))">
            {lockedBy}
          </text>
        </g>
      )}
    </g>
  )
}
