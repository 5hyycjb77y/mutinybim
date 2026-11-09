'use client'

import { LampCeiling } from 'lucide-react'
import { toast } from 'sonner'
import { ceilingsOfSpace, makeCeilingFromHeightRefusal, spaceLabel, type Command, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'

interface Props {
  readonly model: ModelState | null
  readonly spaceId: ElementId
  readonly label: string
  /** Why the person can't edit, in words; null when they can. */
  readonly editReason: string | null
  readonly submit: (command: Command, undoLabel: string) => string | null
}

/** Why the action is off for this space, in words; null when it can run. */
export function makeCeilingReason(model: ModelState | null, spaceId: ElementId, editReason: string | null): string | null {
  if (editReason) return editReason
  const space = model?.elements[spaceId]
  if (!model || space?.kind !== 'space') return 'The model is still loading.'
  if (ceilingsOfSpace(model.elements, spaceId).length > 0) return `${spaceLabel(space)} already has a ceiling; change it on a ceiling plan.`
  return makeCeilingFromHeightRefusal(model.elements, space)
}

/**
 * Spaces › a space's row › Make a ceiling from this height: the
 * space's stated ceiling height becomes a flat ceiling over its outline, in
 * one undoable step. Off (with the reason) when the space has no height,
 * outline or level, or already has a ceiling.
 */
export function MakeCeilingFromHeightButton({ model, spaceId, label, editReason, submit }: Props) {
  const reason = makeCeilingReason(model, spaceId, editReason)
  const name = `Make a ceiling from ${label}’s height`
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={reason ? `${name} (off: ${reason})` : name}
      title={reason ?? 'Make a ceiling from this height: a flat ceiling over the space at its stated height'}
      disabled={reason !== null}
      data-testid="spaces-make-ceiling"
      onClick={(e) => {
        e.stopPropagation()
        const refused = submit({ type: 'make_ceiling_from_space_height', spaceId }, 'Make a ceiling from this height')
        if (refused) toast.error(refused)
        else toast.success(`Made a ceiling over ${label} at its stated height. Undo takes it back.`)
      }}
    >
      <LampCeiling />
    </Button>
  )
}
