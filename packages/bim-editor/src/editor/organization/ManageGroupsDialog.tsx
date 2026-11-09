'use client'

import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { DEFAULT_GROUP_ID, GROUP_VISIBILITIES, elementValues, groupIdOf, isOrganized, organizationOf, typicalCapStatus, type GroupVisibility, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemGroup } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { newId, type SubmitCommand } from '../views-sheets/types'
import { GROUP_VISIBILITY_LABEL } from './labels'
import { TypicalCapNotice } from './TypicalCapNotice'
import { TypicalDialog } from './TypicalDialog'

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
}

/** Elements per group; one pass, only while the dialog is open. */
function memberCounts(model: ModelState): ReadonlyMap<string, number> {
  const org = organizationOf(model)
  const counts = new Map<string, number>()
  for (const el of elementValues(model.elements)) {
    if (!isOrganized(el)) continue
    const id = groupIdOf(org, el)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Create, rename, colour, lock and delete the model's groups. */
export function ManageGroupsDialog({ model, canEdit, blockedReason, submit, onClose }: Props) {
  const org = organizationOf(model)
  const counts = useMemo(() => memberCounts(model), [model])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<{ id: string; name: string; count: number } | null>(null)
  const [moveTo, setMoveTo] = useState<string>(DEFAULT_GROUP_ID)
  const [typicalFor, setTypicalFor] = useState<string | null>(null)
  const typicalGroup = typicalFor ? org.groupById.get(typicalFor) : undefined
  const run = (refusal: string | null) => {
    setError(refusal)
    return refusal
  }
  const add = () => {
    const name = draft.trim()
    if (!name) return
    if (!run(submit({ type: 'create_group', groupId: newId('grp'), name }, `add group ${name}`))) setDraft('')
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="manage-groups-dialog">
        <DialogHeader>
          <DialogTitle>Groups</DialogTitle>
          <DialogDescription>Every duct, pipe and part is in one group. Views show, halftone or hide a group, and a locked group can&apos;t be changed by anyone, including agents.</DialogDescription>
        </DialogHeader>
        {!canEdit && (
          <Alert>
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        <TypicalCapNotice model={model} canEdit={canEdit} blockedReason={blockedReason} submit={(c, label) => run(submit(c, label))} />
        <ItemGroup className="max-h-[50vh] overflow-y-auto">
          {org.groups.map((g) => {
            const count = counts.get(g.id) ?? 0
            const active = org.activeGroupId === g.id
            return (
              <Item key={g.id} variant="outline" size="sm" data-testid={`manage-group-${g.id}`}>
                <Input
                  type="color"
                  aria-label={`${g.entry.name} colour`}
                  className="h-8 w-10 shrink-0 p-1"
                  defaultValue={g.entry.color}
                  disabled={!canEdit}
                  onBlur={(e) => e.target.value !== g.entry.color && run(submit({ type: 'update_group', groupId: g.id, color: e.target.value }, `recolour ${g.entry.name}`))}
                />
                <ItemContent className="min-w-0">
                  <Input
                    key={`${g.id}:${g.entry.name}`}
                    aria-label="Group name"
                    defaultValue={g.entry.name}
                    disabled={!canEdit}
                    className="h-8"
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const name = e.target.value.trim()
                      if (name && name !== g.entry.name) run(submit({ type: 'update_group', groupId: g.id, name }, `rename ${g.entry.name} to ${name}`))
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {count.toLocaleString()} element{count === 1 ? '' : 's'}
                    {active ? ' · new work goes here' : ''}
                    {g.entry.typical ? ` · typical ${g.entry.typical.label.toLowerCase()}, ${g.entry.typical.copies.length + 1} in all` : ''}
                  </span>
                </ItemContent>
                <ItemActions className="gap-2">
                  {g.id !== DEFAULT_GROUP_ID && (
                    <Button variant="ghost" size="sm" onClick={() => setTypicalFor(g.id)} data-testid={`typical-group-${g.id}`} title="Repeat this group (a typical unit or bay): copies draw on plans and count their loads">
                      {g.entry.typical ? `Typical ×${g.entry.typical.copies.length + 1}` : 'Typical…'}
                    </Button>
                  )}
                  {active ? (
                    <Badge variant="secondary">Active</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" disabled={!canEdit || g.entry.locked} onClick={() => run(submit({ type: 'set_active_group', groupId: g.id }, `make ${g.entry.name} active`))}>
                      Make active
                    </Button>
                  )}
                  <Select value={g.entry.defaultVisibility} disabled={!canEdit} onValueChange={(v) => {
                    const next = GROUP_VISIBILITIES.find((x) => x === v)
                    if (next) run(submit({ type: 'update_group', groupId: g.id, defaultVisibility: next }, `show ${g.entry.name} as ${GROUP_VISIBILITY_LABEL[next].toLowerCase()} by default`))
                  }}>
                    <SelectTrigger size="sm" className="w-28" aria-label={`${g.entry.name} in views that don't set it`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {GROUP_VISIBILITIES.map((v: GroupVisibility) => (
                          <SelectItem key={v} value={v}>
                            {GROUP_VISIBILITY_LABEL[v]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Field orientation="horizontal" className="w-auto">
                    <Switch
                      id={`lock-${g.id}`}
                      checked={g.entry.locked}
                      disabled={!canEdit}
                      data-testid={`lock-group-${g.id}`}
                      onCheckedChange={(locked) => run(submit({ type: 'lock_group', groupId: g.id, locked }, `${locked ? 'lock' : 'unlock'} ${g.entry.name}`))}
                    />
                    <FieldLabel htmlFor={`lock-${g.id}`} className="font-normal">
                      Locked
                    </FieldLabel>
                  </Field>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${g.entry.name}`}
                          disabled={!canEdit || g.id === DEFAULT_GROUP_ID || g.entry.locked}
                          onClick={() => {
                            setMoveTo(DEFAULT_GROUP_ID)
                            setDeleting({ id: g.id, name: g.entry.name, count })
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {g.id === DEFAULT_GROUP_ID ? 'General holds everything not in another group, so it stays. Rename it instead.' : g.entry.locked ? 'Unlock it before deleting it.' : `Delete ${g.entry.name}`}
                    </TooltipContent>
                  </Tooltip>
                </ItemActions>
              </Item>
            )
          })}
        </ItemGroup>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="new-group-name">New group</FieldLabel>
            <Input id="new-group-name" value={draft} placeholder="e.g. Phase 2 tenant fit-out" disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} data-testid="new-group-name" />
          </Field>
          <Button type="submit" disabled={!canEdit || draft.trim() === ''} data-testid="add-group">
            <Plus data-icon="inline-start" />
            Add group
          </Button>
        </form>
        {error && (
          <Alert variant="destructive" data-testid="manage-groups-error">
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
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3">
                {deleting && deleting.count > 0 ? (
                  <>
                    <p>
                      {deleting.count.toLocaleString()} element{deleting.count === 1 ? ' is' : 's are'} in it. They move to the group you pick. You can undo this.
                    </p>
                    <Select value={moveTo} onValueChange={setMoveTo}>
                      <SelectTrigger size="sm" aria-label="Move its elements to">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {org.groups
                            .filter((g) => g.id !== deleting.id && !g.entry.locked)
                            .map((g) => (
                              <SelectItem key={g.id} value={g.id}>
                                {g.entry.name}
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <p>Nothing is in it. You can undo this.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                run(submit({ type: 'delete_group', groupId: deleting.id, ...(deleting.count > 0 ? { moveTo } : {}) }, `delete group ${deleting.name}`))
                setDeleting(null)
              }}
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {typicalGroup && <TypicalDialog group={typicalGroup} elementCount={counts.get(typicalGroup.id) ?? 0} capStatus={typicalCapStatus(model)} canEdit={canEdit} blockedReason={blockedReason} submit={submit} onClose={() => setTypicalFor(null)} />}
    </Dialog>
  )
}
