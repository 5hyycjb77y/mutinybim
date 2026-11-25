'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { diagramSelectionIndex, evaluateDiagram, type DiagramNodeBox, type DiagramTextBox, type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import type { SubmitCommand } from '../views-sheets/types'
import { pinCommand, textOffsetCommand } from './diagram-commands'

const PRIMARY = 'var(--mutiny-selection)'
/** A press that travels less than this (paper mm) is a click. */
const CLICK_MM = 1

interface Props {
  readonly model: ModelState
  readonly view: ViewElement
  /** Drawing mm (y up) to paper mm (y down) for the open view, and back. */
  readonly toPaper: (p: Vec2) => Vec2
  readonly toDrawing: (p: Vec2) => Vec2
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly selectedIds: readonly string[]
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  /** Select a model element (null clears), as a click in a plan or the 3D view does. */
  readonly onSelect: (elementId: string | null) => void
  readonly hint: (message: string) => void
}

/** A press on a target: equipment can be dragged to a new place; a piece of pipe only selects; a block of text moves on its own. */
type Drag = { readonly id: string; readonly name: string; readonly pipe: boolean; readonly from: Vec2; readonly to: Vec2; readonly root: SVGSVGElement; readonly textKey?: string }

/** Paper mm under a screen point on the overlay (its viewBox is the paper). */
function paperAt(root: SVGSVGElement, clientX: number, clientY: number): Vec2 | null {
  const r = root.getBoundingClientRect()
  const vb = root.viewBox?.baseVal
  if (!r.width || !r.height || !vb || !vb.width) return null
  return { x: vb.x + ((clientX - r.left) / r.width) * vb.width, y: vb.y + ((clientY - r.top) / r.height) * vb.height }
}

function rectOf(b: Pick<DiagramNodeBox, 'min' | 'max'>, toPaper: (p: Vec2) => Vec2): { x: number; y: number; w: number; h: number } {
  const a = toPaper(b.min)
  const c = toPaper(b.max)
  return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) }
}

/**
 * Picking and arranging on a live diagram: each piece of equipment is a
 * target over its drawn symbol and text, and each drawn run (between two
 * pieces of equipment or branches) is one too. Click selects it in the model (the properties panel
 * shows it; the same selection shows in plans and 3D); what is selected in
 * the model is outlined here, and a selected run lights every drawn run it is
 * part of, read through the kernel's selection map (`diagramSelectionIndex`)
 * for any add-on's diagram. Dragging a piece of equipment moves it and
 * everything it feeds, saved as a pin hint on the view, never as line work.
 * Text moves on its own: once a piece of equipment (or a pipe) is selected,
 * each block of its text is a target of its own; titles, level names and
 * section labels always are. Dragging one saves a text offset hint, so the
 * words still come from the model and a leader goes back when it is moved
 * well away. Esc cancels a drag.
 */
export function DiagramLayer({ model, view, toPaper, toDrawing, paperOf, selectedIds, canEdit, blockedReason, submit, onSelect, hint }: Props) {
  const evaluation = useMemo(() => evaluateDiagram(model.elements, view), [model.elements, view])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [hoverText, setHoverText] = useState<string | null>(null)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const index = useMemo(() => (evaluation ? diagramSelectionIndex(evaluation) : null), [evaluation])
  const lit = useMemo(() => new Set(index ? index.entriesFor(selectedIds).flatMap((e) => e.boxes) : []), [index, selectedIds])

  const finish = (d: Drag) => {
    const moved = Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) >= CLICK_MM
    setDrag(null)
    if (!moved || (d.pipe && !d.textKey)) {
      if (!d.id) {
        hint(`Drag "${d.name}" to move it on this diagram.`)
        return
      }
      onSelect(d.id)
      if (d.textKey) hint(`Selected what "${d.name}" describes. Drag the text to move just the text.`)
      else hint(d.pipe ? `${d.name} selected in the model. Its size, slope and what it carries are on the right; drag its label to move just the label.` : `${d.name} selected. Its properties are on the right; drag it to move it and what it feeds, or drag its text to move just the text.`)
      return
    }
    if (!canEdit) {
      toast.error(blockedReason)
      return
    }
    const a = toDrawing(d.from)
    const b = toDrawing(d.to)
    if (d.textKey) {
      const command = textOffsetCommand(view, d.textKey, { x: b.x - a.x, y: b.y - a.y })
      if (!command) return
      const refusal = submit(command, `move the text "${d.name}" on ${view.name}`)
      if (refusal) toast.error(refusal)
      return
    }
    const command = pinCommand(view, d.id, { x: b.x - a.x, y: b.y - a.y })
    if (!command) return
    const refusal = submit(command, `move ${d.name} on ${view.name}`)
    if (refusal) toast.error(refusal)
  }

  // While a press is held the window follows the pointer, so a drag that leaves the box keeps going.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      const at = paperAt(drag.root, e.clientX, e.clientY)
      if (at) setDrag((d) => (d ? { ...d, to: at } : d))
    }
    const onUp = (e: PointerEvent) => {
      const at = paperAt(drag.root, e.clientX, e.clientY)
      finish(at ? { ...drag, to: at } : drag)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDrag(null)
      hint('Move cancelled; nothing changed.')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  if (!evaluation) return null
  // Bigger boxes first, so a node's own target sits over the bus of what feeds it (and a run over the floor it crosses).
  const boxes = evaluation.boxes.map((b, i) => ({ b, i })).sort((x, y) => (y.b.max.x - y.b.min.x) * (y.b.max.y - y.b.min.y) - (x.b.max.x - x.b.min.x) * (x.b.max.y - x.b.min.y) || x.i - y.i)
  const paperRects = boxes.map(({ b }) => rectOf(b, toPaper))
  const warned = new Set(evaluation.warnings.map((w) => w.elementId))
  // Keep every node, standalone, moved, and selected-owner label directly draggable in one gesture, while letting an unselected run take clicks before its own unmoved callout label.
  const isUnselectedOwnRunCallout = (t: DiagramTextBox) => {
    if (t.elementId === null || t.moved) return false
    const ownerId = t.elementId
    const tr = rectOf(t, toPaper)
    return boxes.some(({ b, i }, idx) => {
      if (!b.pipe || lit.has(i)) return false
      if (b.elementId !== ownerId && !b.pipe.elementIds.includes(ownerId)) return false
      const br = paperRects[idx]!
      const cx = br.x + br.w / 2
      const cy = br.y + br.h / 2
      return cx >= tr.x - 0.5 && cx <= tr.x + tr.w + 0.5 && cy >= tr.y - 0.5 && cy <= tr.y + tr.h + 0.5
    })
  }
  const movableTexts = evaluation.texts.filter((t) => t.text.trim() !== '' && !isUnselectedOwnRunCallout(t))
  const startDrag = (e: React.PointerEvent<SVGRectElement>, d: Omit<Drag, 'from' | 'to' | 'root'>) => {
    // Left button only (a right-click opens the menu).
    if (e.button > 0) return
    e.stopPropagation()
    const root = e.currentTarget.ownerSVGElement
    const at = paperOf(e)
    if (!at || !root) return
    setDrag({ ...d, from: at, to: at, root })
  }
  const textRect = (t: DiagramTextBox) => {
    const r = rectOf(t, toPaper)
    const live = drag?.textKey === t.key
    const isHovered = hoverText === t.key
    const isOwnerSelected = t.elementId !== null && (selected.has(t.elementId) || evaluation.boxes.some((b, i) => b.pipe && b.elementId === t.elementId && lit.has(i)))
    const offset = live && drag ? { x: drag.to.x - drag.from.x, y: drag.to.y - drag.from.y } : { x: 0, y: 0 }
    return (
      <rect
        key={`text:${t.key}`}
        x={r.x - 0.5 + offset.x}
        y={r.y - 0.5 + offset.y}
        width={r.w + 1}
        height={r.h + 1}
        rx={0.4}
        fill={PRIMARY}
        fillOpacity={live ? 0.12 : isHovered ? 0.08 : 0}
        stroke={PRIMARY}
        strokeWidth={0.35}
        strokeDasharray="1.2 0.8"
        strokeOpacity={live || isHovered ? 0.95 : t.moved || isOwnerSelected ? 0.55 : 0}
        style={{ cursor: canEdit ? 'move' : 'default' }}
        data-testid="diagram-text"
        data-text-key={t.key}
        data-moved={t.moved ? 'true' : 'false'}
        onPointerEnter={() => setHoverText(t.key)}
        onPointerLeave={() => setHoverText((cur) => (cur === t.key ? null : cur))}
        onPointerDown={(e) => startDrag(e, { id: t.elementId ?? '', name: t.text, pipe: true, textKey: t.key })}
      >
        <title>{`${t.text}: drag to reposition this label on the diagram (stays live to the model)`}</title>
      </rect>
    )
  }

  return (
    <g data-testid="diagram-layer" data-diagram-kind={evaluation.kind}>
      {boxes.map(({ b, i }, idx) => {
        const r = paperRects[idx]!
        const pipe = b.pipe !== undefined
        // Clamp the 1 mm click halo against adjacent sibling nodes so stacked targets never overlap each other.
        let padL = pipe ? 0 : 1
        let padR = pipe ? 0 : 1
        let padT = pipe ? 0 : 1
        let padB = pipe ? 0 : 1
        if (!pipe) {
          for (let j = 0; j < boxes.length; j++) {
            if (j === idx || boxes[j]!.b.pipe !== undefined) continue
            const o = paperRects[j]!
            if (o.x < r.x + r.w && r.x < o.x + o.w) {
              if (o.y + o.h <= r.y) padT = Math.min(padT, Math.max(0, (r.y - (o.y + o.h)) / 2))
              if (r.y + r.h <= o.y) padB = Math.min(padB, Math.max(0, (o.y - (r.y + r.h)) / 2))
            }
            if (o.y < r.y + r.h && r.y < o.y + o.h) {
              if (o.x + o.w <= r.x) padL = Math.min(padL, Math.max(0, (r.x - (o.x + o.w)) / 2))
              if (r.x + r.w <= o.x) padR = Math.min(padR, Math.max(0, (o.x - (r.x + r.w)) / 2))
            }
          }
        }
        // The shared selection highlight, never a colour of its own per run.
        const isSelected = lit.has(i)
        const hovered = hover === i
        const offset = !pipe && !drag?.textKey && drag?.id === b.elementId ? { x: drag.to.x - drag.from.x, y: drag.to.y - drag.from.y } : { x: 0, y: 0 }
        return (
          <rect
            key={`${b.elementId}:${i}`}
            x={r.x - padL + offset.x}
            y={r.y - padT + offset.y}
            width={r.w + padL + padR}
            height={r.h + padT + padB}
            rx={pipe ? 0.6 : 1}
            fill={isSelected || hovered ? PRIMARY : 'transparent'}
            fillOpacity={isSelected ? (pipe ? 0.3 : 0.12) : hovered ? 0.08 : 0}
            stroke={isSelected || hovered ? PRIMARY : 'none'}
            strokeWidth={isSelected ? 0.6 : 0.35}
            strokeDasharray={!pipe && !drag?.textKey && drag?.id === b.elementId ? '1.5 1' : undefined}
            style={{ cursor: canEdit && !pipe ? 'move' : 'pointer' }}
            data-testid={pipe ? `diagram-pipe-${b.elementId}` : `diagram-node-${b.elementId}`}
            data-element-id={b.elementId}
            data-entry-id={index?.entryOfBox(i)?.id}
            data-element-ids={pipe ? b.pipe?.elementIds.join(' ') : undefined}
            data-selected={isSelected ? 'true' : 'false'}
            data-warning={warned.has(b.elementId) ? 'true' : 'false'}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover((h) => (h === i ? null : h))}
            onPointerDown={(e) => startDrag(e, { id: b.elementId, name: b.name, pipe })}
          >
            <title>{pipe ? `${b.name}: click to select it in the model` : `${b.name}: click to select, drag to move it on this diagram`}</title>
          </rect>
        )
      })}
      {movableTexts.map(textRect)}
    </g>
  )
}
