'use client'

import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { elementsOfKind, type Command, type ElementTypeElement, type ModelState, type ParamValue } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { newId, type SubmitCommand } from '../views-sheets/types'
import { changedValues, draftOf, newTypeFields, typeFields, typeUsers, usedByWords, type DraftValue, type TypeField } from './type-fields'
import { TypeFieldControl } from './TypeFieldControl'

/** Make a type in the model for one selected element, blank or as a copy of its type, and give it to that element. */
export interface NewTypeRequest {
  /** The kind the type is for (`wall`, `opening`). */
  readonly kind: string
  /** What a person calls one ("wall", "door"). */
  readonly noun: string
  /** Duplicate type…: the type copied. Null: New type…. */
  readonly from: ElementTypeElement | null
  /** The selected element that takes the new type on Save. */
  readonly assignTo: string
}

type CreateTypeCommand = Extract<Command, { type: 'create_element_type' }>

interface Props {
  readonly model: ModelState
  /** Edit type…: the type edited. Absent with `create`. */
  readonly type?: ElementTypeElement
  /** New type… / Duplicate type…. */
  readonly create?: NewTypeRequest
  readonly submit: SubmitCommand
  /** Null when editing is allowed; otherwise why not, in the operator's words. */
  readonly editBlocked: string | null
  readonly onClose: () => void
}

/** The values a new type is made with: the copied type's, with the dialog's changes over them (an emptied field drops the value). */
function newTypeValues(from: ElementTypeElement | null, changes: Readonly<Record<string, ParamValue | null>>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...(from?.values ?? {}) }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/**
 * Edit type… (Architecture tab › Types): the selection's type, its
 * parameters from the add-ons' parameter sets, and how many elements it
 * changes. New type… and Duplicate type… (the selected element's Type menu)
 * use the same fields to make a type in this model, named, and give it to the
 * selected element. Save writes one undo step; Cancel or Esc writes nothing.
 */
export function EditTypeDialog({ model, type, create, submit, editBlocked, onClose }: Props): ReactNode {
  const from = create?.from ?? null
  const base = type ?? from
  const fields: TypeField[] = useMemo(() => (type ? typeFields(model, type) : create ? newTypeFields(model, create.kind, create.from) : []), [model, type, create])
  const users = useMemo(() => (type ? typeUsers(model, type) : []), [model, type])
  const [draft, setDraft] = useState<Readonly<Record<string, DraftValue>>>(() => Object.fromEntries(fields.map((f) => [f.key, draftOf(base ?? {}, f)])))
  const [name, setName] = useState(() => (from ? `${from.name} copy` : ''))
  const [refusal, setRefusal] = useState<string | null>(null)
  const change = changedValues(base ?? {}, fields, draft)
  const changes = 'values' in change ? Object.keys(change.values).length : 0
  const trimmed = name.trim()
  const taken = create ? elementsOfKind(model.elements, 'element_type').some((t) => t.name.trim().toLowerCase() === trimmed.toLowerCase() && (!t.forKinds || t.forKinds.includes(create.kind))) : false
  const nameWhy = !create ? null : trimmed === '' ? `Name the ${create.noun} type.` : taken ? `A ${create.noun} type named ${trimmed} is already in this model; pick another name.` : null
  const why = editBlocked ?? ('refusal' in change ? change.refusal : nameWhy ?? (!create && changes === 0 ? 'Nothing has changed yet.' : null))
  const groups = [...new Set(fields.map((f) => f.group))]

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (why || !('values' in change)) return
    let command: Command
    let label: string
    if (create) {
      const typeId = newId('type')
      const values = newTypeValues(from, change.values)
      const kinds = from?.forKinds ?? [create.kind]
      command = {
        type: 'batch_edits',
        label: `New ${create.noun} type ${trimmed}`,
        commands: [
          { type: 'create_element_type', typeId, name: trimmed, forKinds: kinds as NonNullable<CreateTypeCommand['forKinds']>, ...(from?.classId ? { classId: from.classId } : {}), ...(Object.keys(values).length > 0 ? { values } : {}) },
          { type: 'set_element_type', elementIds: [create.assignTo], typeId },
        ],
      }
      label = `New ${create.noun} type ${trimmed}`
    } else if (type) {
      command = { type: 'set_element_values', elementIds: [type.id], values: change.values }
      label = `Edit the type ${type.name}`
    } else return
    const refused = submit(command, label)
    if (refused) {
      console.error('[EditTypeDialog] the type change was refused', { typeId: type?.id ?? null, create: create ? { kind: create.kind, from: from?.id ?? null } : null, refused })
      setRefusal(refused)
      return
    }
    onClose()
  }

  const title = type ? `Edit type · ${type.name}` : from ? `Duplicate type · ${from.name}` : `New ${create?.noun ?? ''} type`
  const description = type
    ? "Every element of this type changes with it. An element's own value still wins. You can undo this."
    : `A type is what the ${create?.noun ?? 'element'} is built as: its fire rating, smoke barrier and the rest. Save makes it in this model and gives it to the selected ${create?.noun ?? 'element'}. You can undo this.`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="edit-type-dialog">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {create ? (
            <Field>
              <FieldLabel htmlFor="edit-type-name">Type name</FieldLabel>
              <Input id="edit-type-name" data-testid="edit-type-name" value={name} disabled={editBlocked !== null} autoFocus onChange={(e) => setName(e.target.value)} placeholder={`1-hour ${create.noun}`} />
            </Field>
          ) : null}
          {fields.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing to edit on this type</EmptyTitle>
                <EmptyDescription>None of the model&apos;s add-ons gives this kind of type any parameters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <FieldGroup>
              {groups.map((g) => (
                <FieldSet key={g}>
                  <FieldLegend variant="label">{g}</FieldLegend>
                  <FieldGroup>
                    {fields
                      .filter((f) => f.group === g)
                      .map((f) => (
                        <TypeFieldControl key={f.key} idPrefix="edit-type" field={f} value={draft[f.key] ?? draftOf(base ?? {}, f)} disabled={editBlocked !== null} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
                      ))}
                  </FieldGroup>
                </FieldSet>
              ))}
            </FieldGroup>
          )}
          {type ? (
            <p className="text-sm text-muted-foreground" data-testid="edit-type-used-by">
              {usedByWords(users)}
              {users.length > 0 && changes > 0 ? `: Save changes ${users.length === 1 ? 'it' : 'all of them'}.` : '.'}
            </p>
          ) : null}
          {refusal && (
            <Alert variant="destructive" data-testid="edit-type-refusal">
              <AlertDescription>The type wasn&apos;t {type ? 'changed' : 'made'}: {refusal}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={why !== null} title={why ?? undefined} data-testid="edit-type-save">
              {create ? 'Make type' : 'Save'}
            </Button>
          </DialogFooter>
          {why && why !== 'Nothing has changed yet.' ? <FieldDescription data-testid="edit-type-why">{why}</FieldDescription> : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}
