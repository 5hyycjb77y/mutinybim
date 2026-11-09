'use client'

import { Box, ClipboardCopy, ClipboardPaste, Focus, PencilRuler, Spline, Tags } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '../../ui/dropdown-menu'

interface Props {
  /** Canvas pixels from its top-left where the right-click landed; null when closed. */
  readonly at: { readonly x: number; readonly y: number } | null
  readonly onClose: () => void
  /** What is selected, in words ("Supply duct 12 × 8"); null when nothing is. */
  readonly selectionLabel: string | null
  /** Why the 3D actions can't run (null when they can). */
  readonly blocked?: string | null
  /** 3D only: absent on a drawing, which hides the 3D group. */
  readonly onCrop?: () => void
  readonly onNewView?: () => void
  /** A placed part is selected: open its type in the part editor (blocked says why not); null for anything else. */
  readonly editDefinition?: { readonly blocked: string | null; readonly run: () => void } | null
  /** Copy the selected parts (Ctrl+C); `blocked` says why not. */
  readonly copy?: { readonly blocked: string | null; readonly run: () => void } | null
  /** Paste what was copied (Ctrl+V); `blocked` says why not. */
  readonly paste?: { readonly blocked: string | null; readonly run: () => void } | null
  /** Drawings: Spread tags (2+ tags), and Straighten leader for one tag with a hand-bent leader (`use-tag-elbows`). */
  readonly tags?: {
    readonly spread: { readonly blocked: string | null; readonly run: () => void }
    readonly straighten: { readonly blocked: string | null; readonly run: () => void } | null
  } | null
}

/** Right-click (without dragging) on the 3D canvas or a drawing: what you can do with the selection. Esc or a click away closes it. */
export function SelectionContextMenu({ at, onClose, selectionLabel, blocked = null, onCrop, onNewView, editDefinition, copy, paste, tags }: Props) {
  const clipboardWhy = copy?.blocked ?? paste?.blocked ?? null
  return (
    <DropdownMenu open={at !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} data-testid="selection-context-menu">
        <DropdownMenuLabel className="max-w-64 truncate text-xs text-muted-foreground">{selectionLabel ?? 'Nothing selected'}</DropdownMenuLabel>
        {onCrop && onNewView && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={blocked !== null} onSelect={onCrop} data-testid="context-crop-3d-to-selection">
                <Focus />
                Crop 3D view to selection
              </DropdownMenuItem>
              <DropdownMenuItem disabled={blocked !== null} onSelect={onNewView} data-testid="context-new-3d-view-of-selection">
                <Box />
                New 3D view of selection
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {blocked && <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground">{blocked}</DropdownMenuLabel>}
          </>
        )}
        {tags && (
          <>
            {onCrop && onNewView && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={tags.spread.blocked !== null} onSelect={tags.spread.run} title={tags.spread.blocked ?? undefined} data-testid="context-spread-tags">
                <Tags />
                Spread tags
              </DropdownMenuItem>
              {tags.straighten && (
                <DropdownMenuItem disabled={tags.straighten.blocked !== null} onSelect={tags.straighten.run} title={tags.straighten.blocked ?? undefined} data-testid="context-straighten-leader">
                  <Spline />
                  Straighten leader
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {(tags.spread.blocked ?? tags.straighten?.blocked) && (
              <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground" data-testid="context-tags-why">
                {[tags.spread.blocked, tags.straighten?.blocked].filter(Boolean).join(' · ')}
              </DropdownMenuLabel>
            )}
          </>
        )}
        {editDefinition && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={editDefinition.blocked !== null} onSelect={editDefinition.run} data-testid="context-edit-part-definition">
                <PencilRuler />
                Edit definition
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {editDefinition.blocked && <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground">{editDefinition.blocked}</DropdownMenuLabel>}
          </>
        )}
        {(copy || paste) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {copy && (
                <DropdownMenuItem disabled={copy.blocked !== null} onSelect={copy.run} data-testid="context-copy-parts">
                  <ClipboardCopy />
                  Copy
                  <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {paste && (
                <DropdownMenuItem disabled={paste.blocked !== null} onSelect={paste.run} data-testid="context-paste-parts">
                  <ClipboardPaste />
                  Paste
                  <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {clipboardWhy && <DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground" data-testid="context-clipboard-why">{clipboardWhy}</DropdownMenuLabel>}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
