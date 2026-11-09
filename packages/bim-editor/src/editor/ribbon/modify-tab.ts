import {
  AlignHorizontalJustifyCenter,
  ArrowRightLeft,
  CircleDot,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  CornerDownRight,
  CornerRightUp,
  FlipHorizontal2,
  Grid3x3,
  ListEnd,
  MoreHorizontal,
  Move,
  Pin,
  PinOff,
  RotateCw,
  Ruler,
  Scaling,
  Scissors,
  SeparatorVertical,
  SquareRoundCorner,
  Trash2,
  X,
} from 'lucide-react'
import type { RibbonCommand, RibbonGroup, RibbonTab } from './types'
import { MODIFY_LABEL, PICK_ELEMENT_OPS, type ModifyOpName } from '../views-sheets/draft/draft-input'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'
import { TOOL_SHORTCUTS } from './tool-shortcuts'

/**
 * Modify: one set of edit verbs for model elements and drawn items. Each verb
 * works on what is selected where you are: drawn lines and notes on a sheet,
 * a detail view or a view's drawing; parts and runs in the model. A verb that
 * does not work on the model yet says so and says where it does work.
 *
 * The same Modify, Geometry and Edit groups sit on the Modify tab and on the
 * "Modify · Drawn items" tab that opens when drawn items are selected.
 */

const MODIFY_ICON: Record<ModifyOpName, RibbonCommand['icon']> = {
  move: Move,
  copy: CopyPlus,
  rotate: RotateCw,
  mirror: FlipHorizontal2,
  scale: Scaling,
  array: Grid3x3,
  polar_array: CircleDot,
  align: AlignHorizontalJustifyCenter,
  offset: ArrowRightLeft,
  trim_extend_corner: CornerRightUp,
  trim_extend_single: CornerDownRight,
  trim_extend_multiple: ListEnd,
  split: Scissors,
  split_gap: SeparatorVertical,
  fillet_arc: SquareRoundCorner,
  pin: Pin,
  unpin: PinOff,
}
const MODIFY_WHAT: Record<ModifyOpName, string> = {
  move: 'Move what is selected from a base point to a new one',
  copy: 'Copy what is selected from a base point to a new one',
  rotate: 'Turn what is selected about a point by the angle you type',
  mirror: 'Flip what is selected across a line you click (or keep the original)',
  scale: 'Grow or shrink what is selected about a point',
  array: 'Copies in a row: click the base point and where the next one goes',
  polar_array: 'Copies around a centre',
  align: 'Line a point on the selection up with a line',
  offset: 'A parallel line, arc or circle a typed distance away (or two clicks apart); a joined chain offsets as one. Uncheck Copy to move the original',
  trim_extend_corner: 'Click two lines or arcs on the parts to keep: they meet in a sharp corner',
  trim_extend_single: 'Click a boundary, then a line or arc to cut or lengthen to it',
  trim_extend_multiple: 'Click a boundary, then each line or arc to cut or lengthen to it',
  split: 'Click a line or arc to cut it in two there (or twice, deleting the piece between)',
  split_gap: 'Click a line or arc to cut a gap of a typed length into it',
  fillet_arc: 'Click two lines: an arc of the radius you type rounds the corner, and the lines trim to it',
  pin: 'Pin what is selected so Move, trims, splits and Delete leave it alone',
  unpin: 'Unpin what is selected so it can be changed again',
}

/** Where the Modify verbs act right now. */
type Target = 'drawn' | 'model'

function target(ctx: BuildingModelRibbonContext): Target {
  if (!ctx.drawingOpen) return 'model'
  // On a sheet or a detail view only drawn items can be picked. On a plan's drawing, drawn items win when some are picked; otherwise the model tools swap to its live model.
  if ((ctx.draft?.selectedIds.length ?? 0) > 0 || !ctx.liveViewOnDrawing) return 'drawn'
  return 'model'
}

function drawnReason(ctx: BuildingModelRibbonContext, op: ModifyOpName): string | null {
  if (!ctx.draft) return 'Drawing edits load with the drawing. Open a sheet, a detail view, a plan or a section.'
  if (ctx.editBlocked) return ctx.editBlocked
  // Trim/Extend, Split and Fillet Arc start with nothing selected: you click the lines.
  if (PICK_ELEMENT_OPS.has(op)) return null
  const selected = ctx.draft.selectedIds.length
  if (selected === 0) return 'Select drawn items first (Shift+click adds more).'
  return null
}

/** Verbs that work on drawn items only today. */
function notOnModelYet(op: ModifyOpName): string {
  return `${MODIFY_LABEL[op]} works on drawn lines and notes today. Open a sheet, a detail view or a plan's drawing and select what to change. Parts and runs move, turn and split from here.`
}

function draftOp(ctx: BuildingModelRibbonContext, op: ModifyOpName): RibbonCommand {
  const draft = ctx.draft
  const where = target(ctx)
  return {
    id: `draft-${op}`,
    label: MODIFY_LABEL[op],
    icon: MODIFY_ICON[op],
    description: MODIFY_WHAT[op],
    keywords: ['modify', 'edit', op.replace('_', ' ')],
    disabledReason: where === 'drawn' ? drawnReason(ctx, op) : notOnModelYet(op),
    pressed: draft?.pending?.kind === 'modify' && draft.pending.op === op,
    run: () => {
      if (!draft) return
      ctx.setDrawingTool('select')
      draft.setPending(draft.pending?.kind === 'modify' && draft.pending.op === op ? null : { kind: 'modify', op })
    },
    testId: `ribbon-draft-${op}`,
  }
}

function modelReason(ctx: BuildingModelRibbonContext): string | null {
  return ctx.editBlocked
}

function move(ctx: BuildingModelRibbonContext): RibbonCommand {
  if (target(ctx) === 'drawn') return draftOp(ctx, 'move')
  const group = ctx.selection?.kind === 'group' ? ctx.selection : null
  return {
    id: 'draft-move',
    label: 'Move',
    icon: Move,
    description: group ? 'Move the selection by a distance (connected runs follow; fixed parts refuse)' : 'Drag a part to a new spot (on a drawing: from a base point to a new one)',
    shortcut: TOOL_SHORTCUTS.move,
    keywords: ['modify', 'drag', 'relocate'],
    disabledReason: modelReason(ctx) ?? (group && group.movable === 0 ? 'Nothing in this selection moves on its own.' : null),
    pressed: ctx.tool === 'move',
    run: group ? ctx.moveSelected : () => ctx.chooseTool(ctx.tool === 'move' ? 'select' : 'move'),
    testId: 'ribbon-draft-move',
  }
}

function rotate(ctx: BuildingModelRibbonContext): RibbonCommand {
  if (target(ctx) === 'drawn') return draftOp(ctx, 'rotate')
  const part = ctx.selection?.kind === 'part'
  return {
    id: 'draft-rotate',
    label: 'Rotate',
    icon: RotateCw,
    description: 'Turn the selected part a quarter turn clockwise (typed angles work on drawn lines and notes)',
    keywords: ['modify', 'turn', 'spin'],
    disabledReason: modelReason(ctx) ?? (part ? null : 'Select a part to turn it a quarter turn. Typed angles work on drawn lines and notes.'),
    run: () => ctx.rotateSelected(90),
    testId: 'ribbon-draft-rotate',
  }
}

function split(ctx: BuildingModelRibbonContext): RibbonCommand {
  if (target(ctx) === 'drawn') {
    const face = draftOp(ctx, 'split')
    return { ...face, id: 'modify-split', split: true, children: [face, draftOp(ctx, 'split_gap')], testId: 'ribbon-modify-split' }
  }
  const sel = ctx.selection
  const straightRun = target(ctx) === 'model' && sel?.kind === 'run' && !sel.fitting
  return {
    id: 'modify-split',
    label: 'Split',
    icon: Scissors,
    description: 'Click along the selected duct or pipe run to split it there',
    shortcut: TOOL_SHORTCUTS.split,
    keywords: ['cut', 'break', 'divide'],
    pressed: ctx.tool === 'split',
    disabledReason: modelReason(ctx) ?? (straightRun ? null : 'Select a straight duct or pipe run, then click where to split it. Drawn lines split from a sheet or a detail view.'),
    run: ctx.splitSelected,
    testId: 'ribbon-modify-split',
  }
}

function deleteCommand(ctx: BuildingModelRibbonContext): RibbonCommand {
  if (target(ctx) === 'drawn') {
    const n = ctx.draft?.selectedIds.length ?? 0
    return {
      id: 'modify-delete',
      label: 'Delete',
      icon: Trash2,
      description: `Delete the ${n === 1 ? 'selected drawn item' : `${n} selected drawn items`} (undo brings ${n === 1 ? 'it' : 'them'} back)`,
      shortcut: 'Del',
      keywords: ['remove', 'erase'],
      disabledReason: ctx.editBlocked ?? (n > 0 ? null : 'Select drawn items to delete them.'),
      run: () => ctx.draft?.sendRequest('delete'),
      testId: 'ribbon-modify-delete',
    }
  }
  return {
    id: 'modify-delete',
    label: 'Delete…',
    icon: Trash2,
    description: 'Delete what is selected (asks first; undo brings it back)',
    shortcut: 'Del',
    keywords: ['remove', 'erase'],
    disabledReason: modelReason(ctx) ?? (ctx.selection ? null : 'Select something to delete it.'),
    run: ctx.deleteSelected,
    testId: 'ribbon-modify-delete',
  }
}

function measure(ctx: BuildingModelRibbonContext, reason: string | null): RibbonCommand {
  return {
    id: 'measure',
    label: 'Measure',
    icon: Ruler,
    description: 'Click two points to measure between them',
    shortcut: TOOL_SHORTCUTS.measure,
    keywords: ['distance', 'tape'],
    pressed: ctx.tool === 'measure',
    disabledReason: reason,
    run: () => ctx.chooseTool(ctx.tool === 'measure' ? 'select' : 'measure'),
    testId: 'ribbon-measure',
  }
}

/** Trim/Extend ▾: the face runs Trim/Extend to Corner; the arrow lists Single and Multiple. */
function trimExtend(ctx: BuildingModelRibbonContext): RibbonCommand {
  const face = draftOp(ctx, 'trim_extend_corner')
  return { ...face, id: 'draft-trim-extend', split: true, children: [face, draftOp(ctx, 'trim_extend_single'), draftOp(ctx, 'trim_extend_multiple')], testId: 'ribbon-draft-trim-extend' }
}

/** Pin ▾: Pin, and Unpin in the menu. */
function pinCommand(ctx: BuildingModelRibbonContext): RibbonCommand {
  const face = draftOp(ctx, 'pin')
  return { ...face, id: 'draft-pin-menu', split: true, children: [face, draftOp(ctx, 'unpin')], testId: 'ribbon-draft-pin-menu' }
}

/** Copy (Ctrl+C) and Paste (Ctrl+V) of placed parts, in Modify › More so the group keeps five faces. */
function clipboardCommands(ctx: BuildingModelRibbonContext): RibbonCommand[] {
  const c = ctx.clipboard
  if (!c) return []
  return [
    { id: 'clipboard-copy', label: 'Copy parts', icon: ClipboardCopy, description: 'Remember the selected devices, fixtures and equipment to paste them elsewhere', shortcut: '⌘C', keywords: ['copy', 'clipboard', 'duplicate'], disabledReason: c.copyBlocked, run: c.copy, testId: 'ribbon-clipboard-copy' },
    { id: 'clipboard-paste', label: 'Paste parts', icon: ClipboardPaste, description: 'Put a copy of what you copied under the pointer: one edit, one undo, on no circuit and with no mark', shortcut: '⌘V', keywords: ['paste', 'clipboard'], disabledReason: c.pasteBlocked, run: c.paste, testId: 'ribbon-clipboard-paste' },
  ]
}

/** The Modify, Geometry and Edit groups (shared by the Modify tab and the drawn-items tab). `modelToolReason` is why model tools are off here, if they are. */
export function modifyGroups(ctx: BuildingModelRibbonContext, modelToolReason: string | null): RibbonGroup[] {
  return [
    {
      id: 'modify',
      label: 'Modify',
      shared: true,
      commands: [
        move(ctx),
        draftOp(ctx, 'copy'),
        rotate(ctx),
        draftOp(ctx, 'mirror'),
        { id: 'draft-modify-more', label: 'More', icon: MoreHorizontal, description: ctx.clipboard ? 'Copy and paste parts, scale, align and arrays' : 'Scale, align and arrays', children: [...clipboardCommands(ctx), draftOp(ctx, 'scale'), draftOp(ctx, 'align'), draftOp(ctx, 'array'), draftOp(ctx, 'polar_array')], testId: 'ribbon-draft-modify-more' },
      ],
    },
    { id: 'geometry', label: 'Geometry', shared: true, commands: [draftOp(ctx, 'offset'), trimExtend(ctx), split(ctx), draftOp(ctx, 'fillet_arc')] },
    { id: 'edit', label: 'Edit', shared: true, commands: [deleteCommand(ctx), pinCommand(ctx), measure(ctx, modelToolReason)] },
  ]
}

export function modifyTab(ctx: BuildingModelRibbonContext, leading: RibbonGroup, modelToolReason: string | null): RibbonTab {
  return { id: 'modify', label: 'Modify', groups: [leading, ...modifyGroups(ctx, modelToolReason)] }
}

/** "Modify · Drawn items": opens while drawn lines, notes or symbols are selected on the open drawing. */
export function drawnItemsTab(ctx: BuildingModelRibbonContext, leading: RibbonGroup, modelToolReason: string | null): RibbonTab | null {
  const n = ctx.draft?.selectedIds.length ?? 0
  if (!ctx.drawingOpen || n === 0) return null
  return {
    id: 'drawn-items',
    label: 'Modify · Drawn items',
    contextual: true,
    groups: [
      leading,
      ...modifyGroups(ctx, modelToolReason),
      { id: 'drawn-done', label: n === 1 ? '1 drawn item' : `${n} drawn items`, commands: [{ id: 'deselect-drawn', label: 'Deselect', icon: X, description: 'Clear the selection', shortcut: 'Esc', run: () => ctx.draft?.sendRequest('deselect'), testId: 'ribbon-deselect-drawn' }] },
    ],
  }
}
