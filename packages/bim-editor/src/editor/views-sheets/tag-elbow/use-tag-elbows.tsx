'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Command, DrawingItem, ModelState, Vec2, ViewElement } from '@permitzip/bim-kernel'
import { TagElbowGrip } from './TagElbowGrip'
import { planSpreadTags, spreadBlocked, straightenBlocked, straightenLeaderCommand, tagMoveCommand, type TagCommand } from './tag-elbow-commands'

export interface TagMenuAction {
  readonly blocked: string | null
  readonly run: () => void
}

/** The Tags group of the drawing's right-click menu (SelectionContextMenu `tags`). */
export interface TagMenuActions {
  readonly spread: TagMenuAction
  /** Shown when one tag is selected. */
  readonly straighten: TagMenuAction | null
}

export interface TagElbowsInput {
  readonly model: ModelState
  /** The view the drawing annotates (plan or section, or the view opened on the sheet); null on a sheet itself. */
  readonly view: ViewElement | null
  /** The drawing items of that view. */
  readonly items: readonly DrawingItem[]
  /** Selected drawing items, the primary one first. */
  readonly selectedIds: readonly string[]
  readonly editBlocked: string | null
  /** The canvas's send: (command, undo label) → accepted. */
  readonly send: (command: Command, label: string) => boolean
  /** Select these drawing items (the tags that need a hand after Spread tags). */
  readonly select: (itemIds: readonly string[]) => void
  readonly toPaper: (p: Vec2) => Vec2
  readonly toStored: (p: Vec2) => Vec2
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly paperMmPerPx: number
}

export interface TagElbows {
  /** The elbow grip on the selected tag; render inside the drawing's SVG overlay, above the items. */
  readonly grip: ReactNode
  /** The right-click menu's Tags group. */
  readonly menu: TagMenuActions
  /** The command for a tag head dropped at `head` (stored model mm): pulled away, it gets an elbow leader. */
  readonly moveCommand: (item: DrawingItem, head: Vec2) => TagCommand
}

/**
 * Tag elbow leaders on a drawing (U9), in one hook so the canvas mounts it in
 * three lines: the grip, the right-click Tags group (Spread tags, Straighten
 * leader) and the command a dropped tag sends.
 */
export function useTagElbows(input: TagElbowsInput): TagElbows {
  const { model, view, items, selectedIds, editBlocked, send, select, toPaper, toStored, paperOf, paperMmPerPx } = input
  const primary = useMemo(() => items.find((i) => i.id === selectedIds[0]) ?? null, [items, selectedIds])
  const sendTag = useCallback((c: TagCommand) => send(c.command, c.label), [send])

  const spreadWhy = spreadBlocked(view, items, selectedIds, editBlocked)
  const spread = useCallback(() => {
    if (!view || spreadWhy) return
    const plan = planSpreadTags(model, view.id, selectedIds)
    if (!plan.command) {
      toast.info(plan.message, plan.detail ? { description: plan.detail } : {})
      return
    }
    if (!send(plan.command, 'spread tags')) return
    if (plan.needHand.length > 0) {
      select(plan.needHand)
      toast.warning(plan.message, { description: [plan.needHand.length === 1 ? 'It is selected: drag it where it reads best.' : 'They are selected: drag each where it reads best.', plan.detail].filter(Boolean).join(' ') })
    } else toast.success(plan.message, plan.detail ? { description: plan.detail } : {})
  }, [model, view, selectedIds, spreadWhy, send, select])

  const straightenWhy = straightenBlocked(primary, editBlocked)
  const straighten = useCallback(() => {
    const c = primary ? straightenLeaderCommand(primary) : null
    if (c) sendTag(c)
  }, [primary, sendTag])

  const moveCommand = useCallback((item: DrawingItem, head: Vec2) => tagMoveCommand(model, view, item, head), [model, view])

  const grip = view && primary?.tag && selectedIds.length === 1 ? <TagElbowGrip model={model} view={view} item={primary} toPaper={toPaper} toStored={toStored} paperOf={paperOf} paperMmPerPx={paperMmPerPx} editBlocked={editBlocked} send={sendTag} /> : null

  return {
    grip,
    menu: { spread: { blocked: spreadWhy, run: spread }, straighten: primary?.tag && selectedIds.length === 1 ? { blocked: straightenWhy, run: straighten } : null },
    moveCommand,
  }
}
