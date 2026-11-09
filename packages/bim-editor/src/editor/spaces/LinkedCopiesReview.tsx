'use client'

import { useMemo, useState } from 'react'
import { linkedCopiesOf, linkedCopyReview, type Command, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { keepMineCommand, updateFromLinkCommand } from '../linked-reference/linked-copies-for-loads'
import { linkedReferenceWords } from '../linked-reference/linked-reference-store'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'
import { newElementId } from '../placement'

/**
 * Spaces › Copies from the linked model: the walls and openings copied from
 * the link whose source moved, changed or left it since they were copied.
 * Each is settled on its own: "Update from the link" (one undo) or "Keep
 * mine". Shown only when the model has copies.
 */
export function LinkedCopiesReview({ model, submit, editReason }: { readonly model: ModelState; readonly submit: (command: Command, undoLabel: string) => string | null; readonly editReason: string | null }) {
  const linked = useLinkedReferenceState()
  const [refusal, setRefusal] = useState<string | null>(null)
  const count = useMemo(() => linkedCopiesOf(model.elements).length, [model])
  const review = useMemo(() => (linked.status === 'ready' && count > 0 ? linkedCopyReview(model.elements, linked.index) : null), [linked, model, count])
  if (count === 0) return null

  const send = (command: Command | string, label: string) => {
    if (typeof command === 'string') {
      setRefusal(command)
      return
    }
    setRefusal(submit(command, label))
  }

  return (
    <section className="flex flex-col gap-2 border-t pt-2" aria-label="Copies from the linked model" data-testid="linked-copies-review">
      <h3 className="text-xs font-medium text-muted-foreground">Copies from the linked model</h3>
      {!review ? (
        <p className="text-xs text-muted-foreground">{linkedReferenceWords(linked) ?? `${count} copies; the linked model isn't loaded, so whether they still match it can't be checked yet.`}</p>
      ) : review.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="linked-copies-current">
          All {review.current} copies match the linked model{review.notLoaded > 0 ? ` (${review.notLoaded} from a linked model not loaded here)` : ''}.
        </p>
      ) : (
        <ItemGroup>
          {review.rows.map((row) => (
            <Item key={row.elementId} size="sm" variant="outline" data-testid="linked-copy-row" data-status={row.status}>
              <ItemContent>
                <ItemTitle>{row.status === 'gone' ? `${row.kind} whose source is gone` : `${row.kind} whose source changed`}</ItemTitle>
                <ItemDescription>{row.words}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" disabled={editReason !== null} title={editReason ?? (row.status === 'gone' ? 'Removes this copy, as the linked model no longer has it' : "Makes this copy match the linked model's new version")} onClick={() => linked.status === 'ready' && send(updateFromLinkCommand(model, linked.index, row, newElementId), `Update ${row.kind} from the linked model`)} data-testid="linked-copy-update">
                  Update from the link
                </Button>
                <Button size="sm" variant="outline" disabled={editReason !== null} title={editReason ?? (row.status === 'gone' ? 'Keeps this copy and stops following the linked model for it' : 'Keeps this copy as it is and marks this change as seen')} onClick={() => linked.status === 'ready' && send(keepMineCommand(linked.index, row), `Keep my ${row.kind}`)} data-testid="linked-copy-keep">
                  Keep mine
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {refusal ? (
        <Alert variant="destructive" data-testid="linked-copies-refused">
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
