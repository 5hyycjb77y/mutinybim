'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, Layers, ListOrdered, Save, Trash2 } from 'lucide-react'
import { type ModelState } from '@permitzip/bim-kernel'
import { checksCommand, draftOf, inchText, nameAllStacksCommand, saveStackCommand, stackBaseClearanceDiameters, stackSummary, stacksOf, type StackDraft, type StackView } from '@permitzip/bim-pack-plumbing'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { newId, type SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly model: ModelState
  /** Null when this person may edit; otherwise why not, in words. */
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
}

/**
 * Systems › Stacks (ROADMAP P6): every sanitary, vent and storm
 * stack drawn in the model, read from the pipe (floors, size, running DFU,
 * offsets, rooms served), with the number and name a person gives it and the
 * tag it prints (`4"//S/K/L//19`). Also where the base-of-stack check is turned
 * on (STATUS decision 10: off until confirmed as code).
 */
export function StacksDialog({ open, onOpenChange, model, editBlocked, submit }: Props) {
  const list = useMemo(() => stacksOf(model.elements), [model])
  const checkOn = stackBaseClearanceDiameters(model.elements) !== null
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = list.stacks.find((s) => s.key === selectedKey) ?? list.stacks[0] ?? null
  const [draft, setDraft] = useState<{ readonly key: string; readonly value: StackDraft } | null>(null)
  const fields = selected ? (draft?.key === selected.key ? draft.value : draftOf(selected)) : null
  const [notice, setNotice] = useState<{ readonly kind: 'error' | 'info'; readonly text: string } | null>(null)
  const unnamed = list.stacks.filter((s) => !s.record).length

  const send = (command: Parameters<SubmitCommand>[0], label: string, done: string): boolean => {
    const refused = submit(command, label)
    if (refused) {
      console.error('[StacksDialog] the model refused the edit', { label, refused })
      setNotice({ kind: 'error', text: refused })
      return false
    }
    setNotice({ kind: 'info', text: done })
    return true
  }

  const nameAll = () => {
    const command = nameAllStacksCommand(model, list.stacks, newId)
    if (command) send(command, `number ${unnamed} stack${unnamed === 1 ? '' : 's'}`, `Numbered ${unnamed} stack${unnamed === 1 ? '' : 's'}. Undo takes it back.`)
  }

  const save = (s: StackView) => {
    if (!fields) return
    const r = saveStackCommand(s, fields, newId)
    if ('refused' in r) {
      setNotice({ kind: 'error', text: r.refused })
      return
    }
    if (send(r.command, s.record ? `change stack ${s.number}` : 'name a stack', 'Saved.')) setDraft(null)
  }

  const removeName = (s: StackView) => {
    if (!s.record) return
    send({ type: 'delete_stacks', stackIds: [s.record.id] }, `remove the name of stack ${s.number}`, `Stack ${s.number} has no number now; its pipe is unchanged.`)
  }

  const setField = (key: keyof StackDraft, value: string) => {
    if (!selected || !fields) return
    setDraft({ key: selected.key, value: { ...fields, [key]: value } })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl" data-testid="stacks-dialog">
        <DialogHeader>
          <DialogTitle>Stacks</DialogTitle>
          <DialogDescription>Sanitary, vent and storm stacks drawn in the model. Floors, sizes, fixture units, offsets and rooms are read from the pipe; you give each stack its number. The tag prints size // system / rooms // number.</DialogDescription>
        </DialogHeader>
        {editBlocked && (
          <Alert data-testid="stacks-denied">
            <CircleAlert />
            <AlertTitle>You can read the stacks but not change them</AlertTitle>
            <AlertDescription>{editBlocked}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch id="bm-stack-base-check" checked={checkOn} disabled={editBlocked !== null} title={editBlocked ?? undefined} onCheckedChange={(on) => send(checksCommand(on), on ? 'turn the base-of-stack check on' : 'turn the base-of-stack check off', on ? 'Branches within 3 pipe diameters of a stack’s base or offset bend now show in Coordination.' : 'The base-of-stack check is off.')} data-testid="stacks-base-check" />
          <div className="flex flex-col gap-1">
            <Label htmlFor="bm-stack-base-check">Check branches near a stack’s base bend</Label>
            <p className="text-xs text-muted-foreground">No branch within 3 pipe diameters of the bend where a stack turns into the main or an offset. A firm rule, not a code section, so it is off until you turn it on.</p>
          </div>
        </div>
        {list.lost.map((l) => (
          <Alert key={l.record.id} variant="destructive" data-testid="stacks-lost">
            <CircleAlert />
            <AlertTitle>Stack {l.record.number} has lost its pipe</AlertTitle>
            <AlertDescription>{l.reason}</AlertDescription>
          </Alert>
        ))}
        {list.stacks.length === 0 ? (
          <Empty className="border" data-testid="stacks-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Layers />
              </EmptyMedia>
              <EmptyTitle>No stacks drawn yet</EmptyTitle>
              <EmptyDescription>Draw sanitary, vent or storm pipe that runs up through a floor (Plumbing › Route pipe), and it shows here as a stack to number.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
            <Table data-testid="stacks-table">
              <TableCaption className="sr-only">Stacks in the model</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Rooms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.stacks.map((s) => (
                  <TableRow key={s.key} data-testid="stacks-row" data-state={s.key === selected?.key ? 'selected' : undefined} className="cursor-pointer" onClick={() => setSelectedKey(s.key)}>
                    <TableCell>
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setSelectedKey(s.key)} aria-label={`Show stack ${s.number ?? 'without a number'}`}>
                        {s.number ?? <Badge variant="outline">No number</Badge>}
                      </Button>
                    </TableCell>
                    <TableCell className="font-mono text-xs" data-testid="stacks-tag">
                      {s.tag}
                    </TableCell>
                    <TableCell>{s.systemName}</TableCell>
                    <TableCell className="text-xs">{stackSummary(s)}</TableCell>
                    <TableCell className="text-xs">{s.rooms.length > 0 ? s.rooms.join(', ') : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {selected && fields && (
              <section className="flex flex-col gap-3" data-testid="stacks-detail" aria-label={`Stack ${selected.number ?? ''}`}>
                <div className="grid grid-cols-2 gap-2">
                  <Field>
                    <FieldLabel htmlFor="bm-stack-number">Number</FieldLabel>
                    <Input id="bm-stack-number" value={fields.number} placeholder="19" onChange={(e) => setField('number', e.target.value)} disabled={editBlocked !== null} data-testid="stacks-number" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bm-stack-name">Name</FieldLabel>
                    <Input id="bm-stack-name" value={fields.name} placeholder="Kitchen stack" onChange={(e) => setField('name', e.target.value)} disabled={editBlocked !== null} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bm-stack-system">System letter</FieldLabel>
                    <Input id="bm-stack-system" value={fields.systemCode} placeholder={selected.systemCodeTyped ? '' : selected.systemCode} onChange={(e) => setField('systemCode', e.target.value)} disabled={editBlocked !== null} />
                    <FieldDescription>Blank: {selected.systemCodeTyped ? 'back to the pipe system’s' : `${selected.systemCode || 'none'}, from the pipe system`}.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bm-stack-serves">Rooms code</FieldLabel>
                    <Input id="bm-stack-serves" value={fields.serves} placeholder={selected.servesTyped ? '' : selected.servesCode} onChange={(e) => setField('serves', e.target.value)} disabled={editBlocked !== null} data-testid="stacks-serves" />
                    <FieldDescription>Blank: {selected.servesTyped ? 'back to the rooms its branches reach' : selected.servesCode ? `${selected.servesCode}, from the rooms its branches reach` : 'no rooms found on its branches'}.</FieldDescription>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => save(selected)} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="stacks-save">
                    <Save data-icon="inline-start" />
                    {selected.record ? 'Save' : 'Name this stack'}
                  </Button>
                  {selected.record && (
                    <Button size="sm" variant="outline" onClick={() => removeName(selected)} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="stacks-remove-name">
                      <Trash2 data-icon="inline-start" />
                      Remove name
                    </Button>
                  )}
                </div>
                <Table data-testid="stacks-floors">
                  <TableCaption>Floor by floor, bottom up</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Floor</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">DFU</TableHead>
                      <TableHead>Offsets</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.floors.map((f) => (
                      <TableRow key={f.levelId}>
                        <TableCell>{f.levelName || '—'}</TableCell>
                        <TableCell className="text-right">{f.sizeIn !== null ? inchText(f.sizeIn) : '—'}</TableCell>
                        <TableCell className="text-right">{f.dfu ?? '—'}</TableCell>
                        <TableCell className="text-xs">{f.offsets.length > 0 ? f.offsets.map((o) => o.text).join('; ') : 'None'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            )}
          </div>
        )}
        {notice && (
          <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} data-testid="stacks-notice">
            <CircleAlert />
            <AlertTitle>{notice.kind === 'error' ? 'Nothing was changed' : 'Done'}</AlertTitle>
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="stacks-close">
            Close
          </Button>
          <Button onClick={nameAll} disabled={editBlocked !== null || unnamed === 0} title={editBlocked ?? (unnamed === 0 ? 'Every stack has a number.' : undefined)} data-testid="stacks-name-all">
            <ListOrdered data-icon="inline-start" />
            {unnamed > 0 ? `Number ${unnamed} stack${unnamed === 1 ? '' : 's'}` : 'Every stack has a number'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
