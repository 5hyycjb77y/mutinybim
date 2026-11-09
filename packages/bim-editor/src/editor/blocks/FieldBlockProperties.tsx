'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'
import { Textarea } from '../../ui/textarea'

/** A field the block can print (the kernel's blockFieldChoices). */
export interface BlockFieldOption {
  /** The token without braces: "service.connected_kva". */
  readonly path: string
  readonly label: string
  readonly group: string
  /** What it prints right now, "" when nothing. */
  readonly example: string
}

/** An element the block can read: a service's main panel, a space, a zone. */
export interface BlockSubjectOption {
  readonly id: string
  readonly label: string
}

export interface FieldBlockDraft {
  readonly template: string
  readonly title: string | null
  /** Null: the first service in the model. */
  readonly subjectId: string | null
}

export interface FieldBlockPropertiesProps {
  readonly value: FieldBlockDraft
  readonly subjects: readonly BlockSubjectOption[]
  readonly fieldsFor: (subjectId: string | null) => readonly BlockFieldOption[]
  /** The block as it would print now with this draft (the kernel's renderFieldBlock). */
  readonly preview: (draft: FieldBlockDraft) => { readonly text: string; readonly unresolved: readonly string[] }
  /** Why a template can't be saved, in words, or null (the kernel's fieldBlockTemplateProblem). */
  readonly templateProblem: (template: string) => string | null
  /** The standard load summary, for "Use the standard summary". */
  readonly defaultTemplate: string
  readonly canEdit: boolean
  readonly blockedReason: string
  /** One edit, one undo. False when the edit wasn't sent (the surface says why). */
  readonly onSave: (next: FieldBlockDraft, label: string) => boolean
  readonly onDelete: () => void
  /** The freshness chip for this block. */
  readonly freshness?: ReactNode
}

const FIRST_SERVICE = '__first_service'

/**
 * Properties of a live load summary on a sheet: what it reads, its title,
 * and its text with {field} tokens that fill from the model. The preview is
 * what the sheet prints now; tokens that read nothing print "—" and are named.
 */
export function FieldBlockProperties({ value, subjects, fieldsFor, preview, templateProblem, defaultTemplate, canEdit, blockedReason, onSave, onDelete, freshness }: FieldBlockPropertiesProps) {
  const [draft, setDraft] = useState(value.template)
  const [notSaved, setNotSaved] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const fields = useMemo(() => fieldsFor(value.subjectId), [fieldsFor, value.subjectId])
  const groups = useMemo(() => {
    const out = new Map<string, BlockFieldOption[]>()
    for (const f of fields) out.set(f.group, [...(out.get(f.group) ?? []), f])
    return [...out]
  }, [fields])
  const problem = templateProblem(draft)
  const shown = useMemo(() => preview({ ...value, template: draft }), [preview, value, draft])
  const dirty = draft !== value.template

  const save = (next: FieldBlockDraft, label: string) => {
    const sent = onSave(next, label)
    setNotSaved(sent ? null : 'Not saved. Check the message above the sheet, then try again.')
    return sent
  }
  const insert = (path: string) => {
    const el = area.current
    const token = `{${path}}`
    const at = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? at
    setDraft(draft.slice(0, at) + token + draft.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const saveReason = !canEdit ? blockedReason : problem ? problem : !dirty ? 'No change to save.' : undefined
  const pickerReason = !canEdit ? blockedReason : fields.length === 0 ? 'Nothing to read yet: draw a panel and its feeders, or pick what this block reads.' : undefined

  return (
    <div className="flex flex-col gap-3" data-testid="field-block-properties">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Load summary</span>
        {freshness}
      </div>

      <Field>
        <FieldLabel htmlFor="field-block-title">Title</FieldLabel>
        <Input
          key={value.title ?? ''}
          id="field-block-title"
          defaultValue={value.title ?? ''}
          placeholder="Printed above the text (optional)"
          maxLength={120}
          disabled={!canEdit}
          title={canEdit ? undefined : blockedReason}
          onBlur={(e) => {
            const title = e.target.value.trim()
            if (title === (value.title ?? '')) return
            save({ ...value, title: title || null }, 'retitle the load summary')
          }}
          data-testid="field-block-title"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="field-block-subject">Reads</FieldLabel>
        <Select
          value={value.subjectId ?? FIRST_SERVICE}
          disabled={!canEdit}
          onValueChange={(v) => {
            const subjectId = v === FIRST_SERVICE ? null : v
            if (subjectId !== value.subjectId) save({ ...value, subjectId }, 'change what the load summary reads')
          }}
        >
          <SelectTrigger id="field-block-subject" title={canEdit ? undefined : blockedReason} data-testid="field-block-subject">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FIRST_SERVICE}>The first service in the model</SelectItem>
            {subjects.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Pick a panel to summarise the service it is on.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="field-block-template">Text</FieldLabel>
        <Textarea
          ref={area}
          id="field-block-template"
          value={draft}
          rows={5}
          className="font-mono text-xs"
          disabled={!canEdit}
          title={canEdit ? undefined : blockedReason}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && dirty) {
              e.stopPropagation()
              setDraft(value.template)
            }
          }}
          aria-invalid={problem ? true : undefined}
          data-testid="field-block-template"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value="" disabled={Boolean(pickerReason)} onValueChange={insert}>
            <SelectTrigger className="w-56" title={pickerReason} data-testid="field-block-insert">
              <SelectValue placeholder="Insert a field…" />
            </SelectTrigger>
            <SelectContent>
              {groups.map(([group, items]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {items.map((f) => (
                    <SelectItem key={f.path} value={f.path}>
                      {f.label}
                      {f.example ? ` (${f.example})` : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="sm" disabled={!canEdit || draft === defaultTemplate} title={!canEdit ? blockedReason : draft === defaultTemplate ? 'Already the standard summary.' : undefined} onClick={() => setDraft(defaultTemplate)}>
            Use the standard summary
          </Button>
        </div>
        {pickerReason && canEdit && <FieldDescription>{pickerReason}</FieldDescription>}
        {problem ? (
          <FieldDescription className="text-danger-600" role="alert" data-testid="field-block-problem">
            {problem}
          </FieldDescription>
        ) : (
          <FieldDescription>Fields in braces fill from the model, like {'{service.demand_kva}'}. Esc puts the text back.</FieldDescription>
        )}
      </Field>

      <Field>
        <FieldLabel>Prints now</FieldLabel>
        <pre className="rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap" data-testid="field-block-preview">
          {shown.text || 'Nothing yet: type some text or insert a field.'}
        </pre>
        {shown.unresolved.length > 0 && (
          <FieldDescription className="text-warning-700" data-testid="field-block-unresolved">
            {shown.unresolved.map((t) => `{${t}}`).join(', ')} {shown.unresolved.length === 1 ? 'reads' : 'read'} nothing here and print{shown.unresolved.length === 1 ? 's' : ''} “—”. Check the spelling, or pick what this block reads.
          </FieldDescription>
        )}
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={Boolean(saveReason)} title={saveReason} onClick={() => save({ ...value, template: draft }, 'edit the load summary')} data-testid="field-block-save">
          Save text
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={!dirty} title={dirty ? undefined : 'No change to put back.'} onClick={() => setDraft(value.template)}>
          <RotateCcw data-icon="inline-start" />
          Put back
        </Button>
      </div>
      {notSaved && (
        <FieldDescription className="text-danger-600" role="alert">
          {notSaved}
        </FieldDescription>
      )}

      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={!canEdit} title={canEdit ? undefined : blockedReason} onClick={onDelete} data-testid="field-block-delete">
        <Trash2 data-icon="inline-start" />
        Remove from the sheet
      </Button>
    </div>
  )
}
