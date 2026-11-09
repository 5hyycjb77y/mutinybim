'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Layers3, Plus, Trash2 } from 'lucide-react'
import { constructionStages, stageMembersOf, type ConstructionStageElement, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from '../../ui/item'
import { newId, type SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** What is selected in the model when the dialog opened: each stage offers to put it in that stage. */
  readonly selectedIds?: readonly string[]
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function dates(s: ConstructionStageElement): string | null {
  const { plannedStart, plannedFinish } = s.stage
  if (plannedStart && plannedFinish) return `Planned ${plannedStart.slice(0, 10)} to ${plannedFinish.slice(0, 10)}`
  if (plannedStart) return `Starts ${plannedStart.slice(0, 10)}`
  if (plannedFinish) return `Finishes ${plannedFinish.slice(0, 10)}`
  return null
}

/**
 * Building Model › Manage › Construction stages: the model's stages in build
 * order. Add, rename, reorder and delete (with a confirm that says what
 * happens to the elements in it). A stage says when and where things are
 * built for takeoffs and sequencing; it never changes the design.
 */
export function ConstructionStagesDialog({ model, canEdit, blockedReason, submit, onClose, selectedIds = [] }: Props) {
  const selected = selectedIds.length
  const putReason = !canEdit ? blockedReason : selected === 0 ? 'Select elements in the model first, then open Construction stages again.' : null
  const stages = constructionStages(model.elements)
  const members = stageMembersOf(model.elements)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<{ readonly id: string; readonly name: string; readonly count: number } | null>(null)
  const run = (refusal: string | null) => {
    setError(refusal)
    return refusal
  }
  const move = (from: number, to: number) => {
    const ids = stages.map((s) => s.id)
    const [moved] = ids.splice(from, 1)
    if (moved === undefined) return
    ids.splice(to, 0, moved)
    const name = stages[from]?.stage.name ?? 'the stage'
    run(submit({ type: 'reorder_construction_stages', stageIds: ids }, `move ${name} ${to < from ? 'earlier' : 'later'}`))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="construction-stages-dialog">
        <DialogHeader>
          <DialogTitle>Construction stages</DialogTitle>
          <DialogDescription>The order the building goes up in, first stage first. Put elements in a stage to see their quantities by stage in the takeoff schedule. Stages never change the design.</DialogDescription>
        </DialogHeader>
        {!canEdit && (
          <Alert>
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        {stages.length === 0 ? (
          <Empty data-testid="construction-stages-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Layers3 />
              </EmptyMedia>
              <EmptyTitle>No construction stages yet</EmptyTitle>
              <EmptyDescription>Add the first stage below, for example &quot;Foundations&quot; or &quot;Level 2 fit-out&quot;. Then select elements in the model, open this list again and press Put selected here on their stage.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {stages.map((s, i) => {
              const count = members.byStage.get(s.id)?.size ?? 0
              const when = dates(s)
              return (
                <Item key={s.id} variant="outline" size="sm" data-testid={`construction-stage-${s.id}`}>
                  <span className="w-5 text-center text-xs text-muted-foreground">{i + 1}</span>
                  <ItemContent>
                    <Input
                      key={`${s.id}:${s.stage.name}`}
                      aria-label={`Name of stage ${i + 1}`}
                      defaultValue={s.stage.name}
                      disabled={!canEdit}
                      className="h-8"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') {
                          e.currentTarget.value = s.stage.name
                          e.currentTarget.blur()
                        }
                      }}
                      onBlur={(e) => {
                        const name = e.target.value.trim()
                        if (name && name !== s.stage.name) run(submit({ type: 'edit_construction_stage', stageId: s.id, name }, `rename ${s.stage.name} to ${name}`))
                        else if (!name) e.target.value = s.stage.name
                      }}
                    />
                    {when && <ItemDescription>{when}</ItemDescription>}
                  </ItemContent>
                  <ItemActions>
                    <Badge variant="secondary">{plural(count, 'element')}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      title={putReason ?? `Put the ${plural(selected, 'selected element')} in ${s.stage.name}`}
                      disabled={putReason !== null}
                      onClick={() => run(submit({ type: 'set_construction_stage', elementIds: [...selectedIds], stageId: s.id }, `put ${plural(selected, 'element')} in ${s.stage.name}`))}
                      data-testid={`construction-stage-put-${s.id}`}
                    >
                      Put {selected > 0 ? selected : ''} selected here
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.stage.name} earlier`} title={canEdit ? undefined : blockedReason} disabled={!canEdit || i === 0} onClick={() => move(i, i - 1)}>
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.stage.name} later`} title={canEdit ? undefined : blockedReason} disabled={!canEdit || i === stages.length - 1} onClick={() => move(i, i + 1)}>
                      <ArrowDown />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.stage.name}`} title={canEdit ? `Delete ${s.stage.name}` : blockedReason} disabled={!canEdit} onClick={() => setDeleting({ id: s.id, name: s.stage.name, count })}>
                      <Trash2 />
                    </Button>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const name = draft.trim()
            if (name && !run(submit({ type: 'add_construction_stage', stageId: newId('stage'), name }, `add stage ${name}`))) setDraft('')
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="new-construction-stage-name">New stage (added last)</FieldLabel>
            <Input id="new-construction-stage-name" value={draft} placeholder="e.g. Level 2 fit-out" maxLength={80} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} data-testid="construction-stage-new-name" />
          </Field>
          <Button type="submit" disabled={!canEdit || draft.trim() === ''} title={!canEdit ? blockedReason : draft.trim() === '' ? 'Type a name for the stage first.' : undefined} data-testid="construction-stage-add">
            <Plus data-icon="inline-start" />
            Add stage
          </Button>
        </form>
        {error && (
          <Alert variant="destructive" data-testid="construction-stages-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.count > 0 ? `${plural(deleting.count, 'element')} in it will be in no stage. Their design doesn't change.` : 'Nothing is in this stage.'} Ctrl+Z brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="construction-stage-delete-confirm"
              onClick={() => {
                if (!deleting) return
                run(submit({ type: 'delete_construction_stage', stageId: deleting.id }, `delete stage ${deleting.name}`))
                setDeleting(null)
              }}
            >
              Delete stage
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
