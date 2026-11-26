'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { asElementId, drawDetailItem, modifyCommand, resolveNote, type DrawingItem, type Primitive, type Vec2 } from '@permitzip/bim-kernel'
import { newId, type SubmitCommand } from '../types'
import type { GraphicsSnapIndex, SnapPoint } from '../annotation-tools'
import {
  PICK_ELEMENT_OPS,
  clickDimension,
  clicksFor,
  constrainPoint,
  dimensionCommand,
  isDraftShape,
  keepsSelection,
  listeningPoint,
  modifyPicks,
  modifyPrompt,
  modifyRequest,
  parseLength,
  pickNeedsItem,
  shapeCommand,
  shapePrompt,
  type Constrained,
  type DraftPending,
  type DraftSettings,
  type ModifyParams,
} from './draft-input'

export interface DraftInputContext {
  readonly tool: string
  readonly settings: DraftSettings
  readonly params: ModifyParams
  readonly pending: DraftPending
  readonly setPending: (next: DraftPending) => void
  readonly items: readonly DrawingItem[]
  readonly selectedIds: readonly string[]
  readonly ownerId: string
  readonly toPaper: (p: Vec2) => Vec2
  readonly toStored: (p: Vec2) => Vec2
  /** Stored units per paper mm (the view scale; 1 on a sheet). */
  readonly storedPerPaperMm: number
  readonly reachMm: number
  /** The working angle on paper, degrees counter-clockwise: ortho and polar steps start from it. Absent: 0. */
  readonly trackBaseDeg?: number
  /** Points a dimension and detail lines follow (model ends and edges, or detail linework corners). */
  readonly anchors: readonly SnapPoint[]
  /** Real rendered model graphics index (wall corners/faces, grid lines/intersections). */
  readonly graphicsIndex?: GraphicsSnapIndex | null
  readonly send: (command: Parameters<SubmitCommand>[0], label: string) => boolean
  readonly onSaved: (selectId: string | null) => void
  readonly onRefused: (reason: string) => void
}

export interface DraftInput {
  /** True when a Draft tool, a click-drawn dimension, or a modify / leader pick is in hand. */
  readonly active: boolean
  readonly prompt: string | null
  readonly preview: {
    readonly tool: string | null
    readonly prims: Primitive[]
    readonly rubber: readonly Vec2[]
    readonly marker: Constrained | null
    readonly typedLength: string
    readonly storedPerPaperMm: number
  }
  readonly down: (at: Vec2) => void
  readonly move: (at: Vec2) => void
  /** Pointer release: finishes a 2-point shape (`line`/`rect`) when dragged from press to release, while leaving a stationary click open for click-click drafting. */
  readonly up: (at: Vec2) => void
  /** Listening dimension key input while drawing (digits, ', ", -, /, ., m, Backspace, Enter). True if handled. */
  readonly handleKey: (key: string) => boolean
  /** Enter or double-click: finish an open shape. */
  readonly finish: () => boolean
  /** Esc: drop the clicks in progress, then the pending operation. True when it had something to drop. */
  readonly cancel: () => boolean
  /** Run the modify operation on its typed values (fillet; or after editing a value). */
  readonly apply: () => void
  /** A snapped point for the drag tools (line, rectangle, single dimension). */
  readonly constrain: (at: Vec2, from: Vec2 | null) => Constrained
}

export function useDraftInput(ctx: DraftInputContext): DraftInput {
  const [clicks, setClicksState] = useState<Constrained[]>([])
  const clicksRef = useRef<Constrained[]>([])
  const dragStartRef = useRef<Vec2 | null>(null)
  const setClicks = useCallback((next: Constrained[]) => {
    clicksRef.current = next
    setClicksState(next)
  }, [])
  const [hover, setHover] = useState<Constrained | null>(null)
  const [typedLength, setTypedLength] = useState('')
  const { tool, settings, pending } = ctx
  const shapeTool = isDraftShape(tool) ? tool : tool === 'dimension' && clickDimension(settings) ? ('dimension' as const) : null
  const active = pending !== null || shapeTool !== null

  const constrain = useCallback(
    (
      at: Vec2,
      from: Vec2 | null,
      opts: { nearest?: boolean; anchors?: boolean; preferAnchors?: boolean; pickElement?: boolean; chainPoints?: readonly Vec2[]; allowCloseLoop?: boolean } = {},
    ) =>
      constrainPoint({
        at,
        from,
        items: ctx.items,
        toPaper: ctx.toPaper,
        settings: ctx.settings,
        reachMm: ctx.reachMm,
        trackBaseDeg: ctx.trackBaseDeg ?? 0,
        ...(opts.anchors !== false ? { anchors: ctx.anchors, graphicsIndex: ctx.graphicsIndex ?? null } : {}),
        ...(opts.preferAnchors ? { preferAnchors: true } : {}),
        ...(opts.chainPoints && opts.chainPoints.length > 0 ? { chainPoints: opts.chainPoints } : {}),
        ...(opts.allowCloseLoop ? { allowCloseLoop: true } : {}),
        ...(opts.nearest ? { nearest: true } : {}),
        ...(opts.pickElement ? { pickElement: true } : {}),
      }),
    [ctx.items, ctx.toPaper, ctx.settings, ctx.reachMm, ctx.anchors, ctx.graphicsIndex, ctx.trackBaseDeg],
  )

  const reset = useCallback(() => {
    dragStartRef.current = null
    setClicks([])
    setHover(null)
    setTypedLength('')
  }, [setClicks])

  const commitShape = useCallback(
    (pts: readonly Constrained[]) => {
      if (!shapeTool) return
      const itemId = newId(shapeTool === 'dimension' ? 'dim' : 'item')
      const command =
        shapeTool === 'dimension'
          ? dimensionCommand({ paper: pts, settings: ctx.settings, toStored: ctx.toStored, items: ctx.items, ownerId: ctx.ownerId, itemId })
          : shapeCommand({ tool: shapeTool, paper: pts.map((c) => c.at), settings: ctx.settings, toStored: ctx.toStored, storedPerPaperMm: ctx.storedPerPaperMm, ownerId: ctx.ownerId, itemId })
      reset()
      if (typeof command === 'string') {
        ctx.onRefused(command)
        return
      }
      if (ctx.send(command, `draw a ${shapeTool === 'dimension' ? 'dimension' : shapeTool === 'polyline' ? 'chain of lines' : shapeTool}`)) ctx.onSaved(command.type === 'batch_documents' ? `${itemId}-0` : itemId)
    },
    [shapeTool, ctx, reset],
  )

  const runModify = useCallback(
    (picks: readonly Constrained[]) => {
      if (pending?.kind !== 'modify') return
      const op = pending.op
      // Pick-the-element tools stay in hand until Esc; Trim/Extend Multiple keeps its boundary.
      const stays = PICK_ELEMENT_OPS.has(op)
      const again = () => {
        reset()
        if ((op === 'trim_extend_multiple' || op === 'match_type') && picks[0]) setClicks([picks[0]])
      }
      const req = modifyRequest(op, picks, ctx.params, ctx.toStored, ctx.selectedIds, ctx.items)
      if (typeof req === 'string') {
        again()
        if (!stays && modifyPicks(op, ctx.params).length === 0) ctx.setPending(null)
        ctx.onRefused(req)
        return
      }
      const made = modifyCommand(ctx.items, req.ids, req.operation, ctx.ownerId, newId('mod'))
      again()
      if (!made.ok) {
        if (!stays && modifyPicks(op, ctx.params).length === 0) ctx.setPending(null)
        ctx.onRefused(made.reason)
        return
      }
      if (ctx.send(made.command, made.summary.toLowerCase())) {
        if (!stays) {
          ctx.setPending(null)
          if (!keepsSelection(req.operation, ctx.items, req.ids)) ctx.onSaved(null)
        }
      } else if (!stays && modifyPicks(op, ctx.params).length === 0) ctx.setPending(null)
    },
    [pending, ctx, reset, setClicks],
  )

  // Pin and Unpin take no clicks: they act on the selection as soon as they are picked.
  const instantOp = pending?.kind === 'modify' && modifyPicks(pending.op, ctx.params).length === 0 ? pending.op : null
  useEffect(() => {
    if (instantOp) runModify([])
    // Only when an instant operation is picked; runModify changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instantOp])

  const addLeader = useCallback(
    (picks: readonly Constrained[]) => {
      if (pending?.kind !== 'leader') return
      const note = ctx.items.find((i) => i.id === pending.noteId)
      const resolved = note ? resolveNote(note) : null
      reset()
      ctx.setPending(null)
      if (!note || !resolved) {
        ctx.onRefused('That note is gone.')
        return
      }
      const existing = [...(note.note?.leader ? [note.note.leader] : []), ...(note.note?.leaders ?? [])]
      if (existing.length >= 9) {
        ctx.onRefused('A note takes up to 9 leaders. Remove one first.')
        return
      }
      const [first, second] = picks.map((c) => ctx.toStored(c.at))
      const leader =
        pending.elbow && second && first
          ? { to: second, elbow: first, arrow: 'filled_arrow' as const }
          : first
            ? { to: first, arrow: 'filled_arrow' as const }
            : null
      if (!leader) return
      ctx.send({ type: 'move_text_note', itemId: note.id, leaders: [...existing, leader] }, 'add a leader')
    },
    [pending, ctx, reset],
  )

  const picksNeeded = pending?.kind === 'modify' ? modifyPicks(pending.op, ctx.params).length : pending?.kind === 'leader' ? (pending.elbow ? 2 : 1) : 0

  const down = useCallback(
    (raw: Vec2) => {
      const last = clicks[clicks.length - 1]?.at ?? null
      if (pending?.kind === 'modify') {
        if (ctx.selectedIds.length === 0 && !PICK_ELEMENT_OPS.has(pending.op)) {
          ctx.onRefused(modifyPrompt(pending.op, 0, 0, ctx.params))
          return
        }
        const needsItem = pickNeedsItem(pending.op, clicks.length)
        const c = constrain(raw, last, { pickElement: needsItem })
        if (needsItem && !c.itemId) {
          ctx.onRefused('Click right on a drawn line, arc or circle.')
          return
        }
        const next = [...clicks, c]
        if (next.length >= picksNeeded) runModify(next)
        else setClicks(next)
        return
      }
      if (pending?.kind === 'leader') {
        const next = [...clicks, constrain(raw, last)]
        if (next.length >= picksNeeded) addLeader(next)
        else setClicks(next)
        return
      }
      if (!shapeTool) return
      const curClicks = clicksRef.current
      const chainPoints = curClicks.map((pt) => pt.at)
      const allowCloseLoop = (shapeTool === 'polyline' || shapeTool === 'region') && curClicks.length >= 3
      const trackOrigin = shapeTool === 'rect' ? null : (curClicks[curClicks.length - 1]?.at ?? null)
      const c = constrain(raw, trackOrigin, {
        anchors: true,
        preferAnchors: shapeTool === 'dimension',
        chainPoints: shapeTool === 'rect' ? [] : chainPoints,
        allowCloseLoop,
        nearest: shapeTool === 'dimension' && curClicks.length === 0 && (settings.dimKind === 'radial' || settings.dimKind === 'diameter'),
      })
      const next = [...curClicks, c]
      const need = clicksFor(shapeTool, settings)
      if ('fixed' in need && next.length >= need.fixed) {
        dragStartRef.current = null
        commitShape(next)
      } else if (allowCloseLoop && (c.closeLoop || (curClicks[0] && Math.hypot(c.at.x - curClicks[0].at.x, c.at.y - curClicks[0].at.y) < 0.35))) {
        dragStartRef.current = null
        commitShape(shapeTool === 'region' ? curClicks : next)
      } else {
        dragStartRef.current = (shapeTool === 'line' || shapeTool === 'rect') && next.length === 1 ? c.at : null
        setClicks(next)
      }
    },
    [clicks, pending, ctx, constrain, picksNeeded, runModify, addLeader, shapeTool, settings, commitShape, setClicks],
  )

  const up = useCallback(
    (raw: Vec2) => {
      const started = dragStartRef.current
      dragStartRef.current = null
      if (!started || (shapeTool !== 'line' && shapeTool !== 'rect')) return
      const curClicks = clicksRef.current
      if (curClicks.length !== 1) return
      if (Math.hypot(raw.x - started.x, raw.y - started.y) < 2) return
      const endC = constrain(raw, shapeTool === 'rect' ? null : curClicks[0]!.at, {
        anchors: true,
        chainPoints: shapeTool === 'rect' ? [] : [curClicks[0]!.at],
      })
      commitShape([curClicks[0]!, endC])
    },
    [shapeTool, constrain, commitShape],
  )

  const move = useCallback(
    (raw: Vec2) => {
      if (!active) {
        if (hover) setHover(null)
        return
      }
      const last = shapeTool === 'rect' ? null : (clicks[clicks.length - 1]?.at ?? null)
      const needsItem = pending?.kind === 'modify' && pickNeedsItem(pending.op, clicks.length)
      const chainPoints = shapeTool === 'rect' ? [] : clicks.map((pt) => pt.at)
      const allowCloseLoop = (shapeTool === 'polyline' || shapeTool === 'region') && clicks.length >= 3
      setHover(constrain(raw, last, { anchors: !needsItem, preferAnchors: shapeTool === 'dimension', chainPoints, allowCloseLoop, pickElement: needsItem }))
    },
    [active, hover, clicks, pending, constrain, shapeTool],
  )

  const finish = useCallback(() => {
    if (!shapeTool) return false
    const need = clicksFor(shapeTool, settings)
    if (!('min' in need)) return false
    // A double-click lands two clicks on the same spot; keep one.
    const pts = clicks.filter((c, i) => i === 0 || Math.hypot(c.at.x - (clicks[i - 1]?.at.x ?? 0), c.at.y - (clicks[i - 1]?.at.y ?? 0)) > 0.2)
    if (pts.length < need.min) {
      ctx.onRefused(`Click at least ${need.min} points, then Enter.`)
      return true
    }
    commitShape(pts)
    return true
  }, [shapeTool, settings, clicks, ctx, commitShape])

  const handleKey = useCallback(
    (key: string): boolean => {
      if (!shapeTool || shapeTool === 'dimension' || clicks.length === 0) return false
      if (key === 'Backspace' && typedLength.length > 0) {
        setTypedLength((s) => s.slice(0, -1))
        return true
      }
      if (key === 'Enter' && typedLength.length > 0) {
        const storedMm = parseLength(typedLength)
        setTypedLength('')
        if (storedMm === null || storedMm <= 0) {
          ctx.onRefused(`"${typedLength}" isn't a valid length (try 14", 3'-6", or 150mm).`)
          return true
        }
        const last = clicks[clicks.length - 1]?.at
        if (!last) return true
        const paperMm = storedMm / Math.max(ctx.storedPerPaperMm, 1e-6)
        const target = listeningPoint(last, hover?.at ?? { x: last.x + 10, y: last.y }, paperMm)
        if (!target) return true
        const nextPt: Constrained = { at: target, snapLabel: null, snapKind: null, snapRef: null, tracking: hover?.tracking ?? null, itemId: null }
        const next = [...clicks, nextPt]
        const need = clicksFor(shapeTool, settings)
        if ('fixed' in need && next.length >= need.fixed) commitShape(next)
        else setClicks(next)
        return true
      }
      if (key.length === 1 && /^[0-9.'"\-/ m]$/.test(key)) {
        if (key === ' ' && typedLength.length === 0) return false
        setTypedLength((s) => s + key)
        return true
      }
      return false
    },
    [shapeTool, clicks, typedLength, ctx, hover, settings, commitShape, setClicks],
  )

  const cancel = useCallback(() => {
    if (typedLength.length > 0) {
      setTypedLength('')
      return true
    }
    if (clicks.length > 0) {
      reset()
      return true
    }
    if (pending) {
      ctx.setPending(null)
      reset()
      return true
    }
    return false
  }, [typedLength.length, clicks.length, pending, ctx, reset])

  const apply = useCallback(() => runModify(clicks), [runModify, clicks])

  const prompt = useMemo(() => {
    if (pending?.kind === 'modify') return modifyPrompt(pending.op, clicks.length, ctx.selectedIds.length, ctx.params)
    if (pending?.kind === 'leader') return `${pending.elbow && clicks.length === 0 ? 'Click where the leader bends' : 'Click what the leader points at'}. Esc cancels.`
    if (shapeTool) return `${shapePrompt(shapeTool, settings, clicks.length)}${typedLength ? `  Length: ${typedLength} (Enter)` : hover?.snapLabel ? `  Snapped to the ${hover.snapLabel}.` : hover?.tracking ? `  Tracking ${Math.round(hover.tracking.angleDeg)}°.` : ''}`
    return null
  }, [pending, clicks.length, ctx.selectedIds.length, ctx.params, shapeTool, settings, hover, typedLength])

  const preview = useMemo(() => {
    const prims: Primitive[] = []
    const pts = [...clicks.map((c) => c.at), ...(hover ? [hover.at] : [])]
    if (shapeTool && shapeTool !== 'dimension' && pts.length > 0) {
      const draft = shapeCommand({ tool: shapeTool, paper: pts, settings, toStored: ctx.toStored, storedPerPaperMm: ctx.storedPerPaperMm, ownerId: ctx.ownerId, itemId: 'draft-preview' })
      const need = clicksFor(shapeTool, settings)
      const enough = 'fixed' in need ? pts.length >= need.fixed : pts.length >= need.min
      const adds = typeof draft === 'string' || !enough ? [] : draft.type === 'batch_documents' ? draft.commands : [draft]
      for (const add of adds) {
        if (add.type !== 'add_drawing_item') continue
        const { type: _type, itemId, ownerId, ...fields } = add
        const item: DrawingItem = { ...fields, id: asElementId(itemId), ownerId: asElementId(ownerId), kind: 'drawing_item', version: 0, authoredRev: {} }
        drawDetailItem({ toPaper: ctx.toPaper, scale: ctx.storedPerPaperMm, prims }, item)
      }
    }
    return { tool: shapeTool, prims, rubber: active ? pts : [], marker: hover && (hover.snapLabel || hover.tracking || hover.guideLine || hover.closeLoop) ? hover : null, typedLength, storedPerPaperMm: ctx.storedPerPaperMm }
  }, [clicks, hover, shapeTool, settings, ctx.toStored, ctx.toPaper, ctx.storedPerPaperMm, ctx.ownerId, active, typedLength])

  const constrainDrag = useCallback((at: Vec2, from: Vec2 | null) => constrain(at, from), [constrain])

  return { active, prompt, preview, down, move, up, handleKey, finish, cancel, apply, constrain: constrainDrag }
}
