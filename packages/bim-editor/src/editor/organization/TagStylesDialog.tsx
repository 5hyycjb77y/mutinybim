'use client'

import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  fieldPaths,
  TAG_FIELDS,
  TAG_LEADER_ENDS,
  TAG_STYLE_BOXES,
  TAG_STYLE_CATEGORIES,
  TAG_STYLE_UNITS,
  createTagStyleFromPreset,
  documentIndex,
  organizationOf,
  renderTagStyleLines,
  tagFieldNames,
  tagStyleCategoryOf,
  tagStylePreset,
  tagStylePresets,
  type BimElement,
  type ModelState,
  type TagStyleCategory,
  type TagStyleEntry,
  elementValues,
} from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Textarea } from '../../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { newId, type SubmitCommand } from '../views-sheets/types'

/**
 * Tag styles: named looks for tags. Each line says what a tag prints, with
 * fields in braces read from the tagged element ({size}, {insulation}, a
 * part's own parameters). A tag that uses a style follows it, so changing a
 * style here changes every tag that uses it. A style can be the default for
 * a kind of element: new tags on it (one at a time or Tag all) take it.
 */

export const TAG_STYLE_KIND_LABEL: Record<TagStyleCategory, string> = {
  duct: 'Duct',
  pipe: 'Pipe',
  air_terminal: 'Air terminals',
  equipment: 'Equipment',
  fixture: 'Plumbing fixtures',
  part: 'Other parts',
  room: 'Rooms',
  space: 'Spaces',
}

const SHAPE_LABEL: Record<(typeof TAG_STYLE_BOXES)[number], string> = {
  none: 'No outline',
  box: 'Box',
  rounded: 'Rounded box',
  circle: 'Circle',
  hexagon: 'Hexagon',
  diamond: 'Diamond',
}

const UNITS_LABEL: Record<(typeof TAG_STYLE_UNITS)[number], string> = {
  ft_in: `Feet and inches (12'-6")`,
  ft: `Decimal feet (12.5')`,
  in: 'Inches (150")',
  mm: 'Millimetres (3810)',
  m: 'Metres (3.81)',
}

const LEADER_END_LABEL: Record<(typeof TAG_LEADER_ENDS)[number], string> = {
  dot: 'Dot',
  arrow: 'Arrow',
  tick: 'Tick',
  none: 'Nothing',
}

/** "Start from" value for a blank style. */
const BLANK = 'blank'

/** Cap heights a tag can print at, mm, with how they read on paper. */
export const TAG_TEXT_SIZES: ReadonlyArray<{ readonly mm: number; readonly label: string }> = [
  { mm: 1.6, label: '1/16" (small)' },
  { mm: 2.4, label: '3/32" (standard)' },
  { mm: 3.2, label: '1/8"' },
  { mm: 4.8, label: '3/16" (large)' },
]

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** Start on this style (e.g. "Edit style" from a selected tag). */
  readonly initialStyleId?: string | null
  /** An element to preview the words on (the selected tag's). */
  readonly sampleElementId?: string | null
}

export function TagStylesDialog({ model, canEdit, blockedReason, submit, onClose, initialStyleId = null, sampleElementId = null }: Props) {
  const org = organizationOf(model)
  const [selectedId, setSelectedId] = useState<string | null>(initialStyleId ?? org.tagStyles[0]?.id ?? null)
  const [error, setError] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [startFrom, setStartFrom] = useState<string>(BLANK)
  const presets = tagStylePresets()
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const selected = org.tagStyles.find((s) => s.id === selectedId) ?? null
  const run = (refusal: string | null) => {
    setError(refusal)
    return refusal
  }
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const items of documentIndex(model).itemsByOwner.values()) {
      for (const it of items) if (!it.deleted && it.tag?.styleId) counts.set(it.tag.styleId, (counts.get(it.tag.styleId) ?? 0) + 1)
    }
    return counts
  }, [model])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="tag-styles-dialog">
        <DialogHeader>
          <DialogTitle>Tag styles</DialogTitle>
          <DialogDescription>What a tag says, how big, with or without a box and leader. Every tag that uses a style changes when you change it here.</DialogDescription>
        </DialogHeader>
        {!canEdit && (
          <Alert>
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <div className="flex flex-col gap-3">
            <ItemGroup className="gap-1" aria-label="Tag styles">
              {org.tagStyles.map((s) => (
                <Item key={s.id} asChild size="sm" variant={s.id === selectedId ? 'muted' : 'outline'}>
                  <Button variant="ghost" className="h-auto justify-start text-left whitespace-normal" onClick={() => setSelectedId(s.id)} data-testid={`tag-style-${s.id}`} aria-pressed={s.id === selectedId}>
                    <ItemContent>
                      <ItemTitle>{s.entry.name}</ItemTitle>
                      <ItemDescription>
                        {usage.get(s.id) ? `${usage.get(s.id)} tag${usage.get(s.id) === 1 ? '' : 's'}` : 'Not used yet'}
                        {s.entry.defaultFor.length > 0 ? ` · default for ${s.entry.defaultFor.map((k) => TAG_STYLE_KIND_LABEL[k].toLowerCase()).join(', ')}` : ''}
                      </ItemDescription>
                    </ItemContent>
                  </Button>
                </Item>
              ))}
            </ItemGroup>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const name = draftName.trim()
                const preset = startFrom === BLANK ? null : tagStylePreset(startFrom)
                if (!name && !preset) return
                const styleId = newId('tst')
                const command = preset
                  ? { ...createTagStyleFromPreset(preset, styleId, org.tagStyles.map((t) => t.entry.name)), ...(name ? { name } : {}) }
                  : { type: 'create_tag_style' as const, styleId, name, lines: ['{size}'] }
                const refusal = run(submit(command, `add tag style ${command.name}`))
                if (!refusal) {
                  setDraftName('')
                  setStartFrom(BLANK)
                  setSelectedId(styleId)
                }
              }}
            >
              <Field>
                <FieldLabel htmlFor="new-tag-style-from">Start from</FieldLabel>
                <Select value={startFrom} disabled={!canEdit} onValueChange={setStartFrom}>
                  <SelectTrigger id="new-tag-style-from" size="sm" data-testid="tag-style-start-from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={BLANK}>A blank style</SelectItem>
                      {presets.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {startFrom !== BLANK && <FieldDescription className="text-xs">{tagStylePreset(startFrom)?.description}</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor="new-tag-style-name">New style name</FieldLabel>
                <Input id="new-tag-style-name" value={draftName} placeholder={startFrom === BLANK ? 'e.g. Duct size + CFM' : (tagStylePreset(startFrom)?.name ?? '')} disabled={!canEdit} onChange={(e) => setDraftName(e.target.value)} />
              </Field>
              <Button type="submit" size="sm" disabled={!canEdit || (draftName.trim() === '' && startFrom === BLANK)} title={!canEdit ? blockedReason : draftName.trim() === '' && startFrom === BLANK ? 'Name the style, or start from a ready-made one' : undefined} data-testid="tag-style-add">
                <Plus data-icon="inline-start" />
                Add style
              </Button>
            </form>
          </div>
          {selected ? (
            <StyleEditor
              key={selected.id}
              model={model}
              styleId={selected.id}
              entry={selected.entry}
              canEdit={canEdit}
              run={run}
              submit={submit}
              sampleElementId={sampleElementId}
              onDelete={() => setConfirmDelete({ id: selected.id, name: selected.entry.name })}
              usedBy={usage.get(selected.id) ?? 0}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Add a style to start.</p>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the tag style &quot;{confirmDelete?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>Tags that use it must be given another style first. Ctrl+Z brings it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmDelete) return
                const refusal = run(submit({ type: 'delete_tag_style', styleId: confirmDelete.id }, `delete tag style ${confirmDelete.name}`))
                if (!refusal) setSelectedId(org.tagStyles.find((s) => s.id !== confirmDelete.id)?.id ?? null)
                setConfirmDelete(null)
              }}
            >
              Delete style
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function sampleFor(model: ModelState, entry: TagStyleEntry, sampleElementId: string | null): BimElement | null {
  const chosen = sampleElementId ? model.elements[sampleElementId] : undefined
  if (chosen && !('deleted' in chosen && chosen.deleted)) return chosen
  const kinds = new Set(entry.defaultFor.length > 0 ? entry.defaultFor : entry.appliesTo?.length ? entry.appliesTo : TAG_STYLE_CATEGORIES)
  for (const el of elementValues(model.elements)) {
    if ('deleted' in el && el.deleted) continue
    const kind = tagStyleCategoryOf(model, el)
    if (kind && kinds.has(kind)) return el
  }
  return null
}

function StyleEditor({
  model,
  styleId,
  entry,
  canEdit,
  run,
  submit,
  sampleElementId,
  onDelete,
  usedBy,
}: {
  model: ModelState
  styleId: string
  entry: TagStyleEntry
  canEdit: boolean
  run: (refusal: string | null) => string | null
  submit: SubmitCommand
  sampleElementId: string | null
  onDelete: () => void
  usedBy: number
}) {
  const [linesText, setLinesText] = useState(entry.lines.join('\n'))
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const fields = useMemo(() => tagFieldNames(model), [model])
  const labelOf = (name: string) => TAG_FIELDS.find((f) => f.name === name)?.label ?? fieldPaths().find((f) => f.path === name)?.label ?? name
  const sample = sampleFor(model, entry, sampleElementId)
  const draftLines = linesText.split('\n').map((l) => l.trim()).filter(Boolean)
  const preview = sample ? renderTagStyleLines(model, sample, draftLines, { units: entry.units, prefix: entry.prefix, suffix: entry.suffix }) : []
  const update = (patch: Partial<Omit<TagStyleEntry, 'type' | 'order' | 'arrow'>> & { readonly arrow?: TagStyleEntry['arrow'] | 'none' }, label: string) => run(submit({ type: 'update_tag_style', styleId, ...patch }, label))
  const saveLines = () => {
    if (draftLines.length === 0) {
      run('A tag style needs at least one line. Type what it should say, like {size}.')
      return
    }
    if (draftLines.join('\n') !== entry.lines.join('\n')) update({ lines: draftLines }, `change what "${entry.name}" says`)
  }
  const insert = (name: string) => {
    const el = textRef.current
    const token = `{${name}}`
    if (!el) {
      setLinesText((t) => `${t}${token}`)
      return
    }
    const start = el.selectionStart ?? linesText.length
    const end = el.selectionEnd ?? linesText.length
    setLinesText(`${linesText.slice(0, start)}${token}${linesText.slice(end)}`)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const kinds = new Set(entry.defaultFor)
  const applies = new Set(entry.appliesTo ?? [])

  return (
    <FieldGroup className="gap-3" data-testid="tag-style-editor">
      <Field>
        <FieldLabel htmlFor="tag-style-name">Name</FieldLabel>
        <Input
          key={entry.name}
          id="tag-style-name"
          defaultValue={entry.name}
          disabled={!canEdit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (name && name !== entry.name) update({ name }, `rename tag style ${entry.name} to ${name}`)
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="tag-style-lines">What it says (one line per row)</FieldLabel>
        <Textarea id="tag-style-lines" ref={textRef} rows={3} value={linesText} disabled={!canEdit} onChange={(e) => setLinesText(e.target.value)} onBlur={saveLines} className="font-mono text-xs" data-testid="tag-style-lines" />
        <FieldDescription className="text-xs">Words print as typed; a field in braces prints the element&apos;s value. A row whose fields are all empty is left out.</FieldDescription>
        <div className="flex flex-wrap gap-1" aria-label="Insert a field">
          {fields.map((name) => (
            <Button key={name} type="button" size="xs" variant="outline" disabled={!canEdit} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(name)} title={`Insert {${name}}`}>
              {labelOf(name)}
            </Button>
          ))}
        </div>
      </Field>
      <div className="rounded-md border bg-muted/40 p-2 text-center font-mono text-xs" data-testid="tag-style-preview">
        {sample ? (preview.length > 0 ? preview.map((l, i) => <div key={i}>{l}</div>) : <span className="text-muted-foreground">Nothing to print on this element</span>) : <span className="text-muted-foreground">Place or select something to preview</span>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="tag-style-size">Text size on paper</FieldLabel>
          <Select value={String(entry.textSizeMm)} disabled={!canEdit} onValueChange={(v) => {
              const mm = Number(v)
              if (Number.isFinite(mm) && mm !== entry.textSizeMm) update({ textSizeMm: mm }, `resize "${entry.name}" text`)
            }}>
            <SelectTrigger id="tag-style-size" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[...TAG_TEXT_SIZES, ...(TAG_TEXT_SIZES.some((s) => s.mm === entry.textSizeMm) ? [] : [{ mm: entry.textSizeMm, label: `${entry.textSizeMm} mm` }])].map((s) => (
                  <SelectItem key={s.mm} value={String(s.mm)}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="tag-style-shape">Outline</FieldLabel>
          <Select value={entry.box} disabled={!canEdit} onValueChange={(v) => {
              const shape = TAG_STYLE_BOXES.find((b) => b === v)
              if (shape && shape !== entry.box) update({ box: shape }, `give "${entry.name}" a ${SHAPE_LABEL[shape].toLowerCase()}`)
            }}>
            <SelectTrigger id="tag-style-shape" size="sm" data-testid="tag-style-shape">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TAG_STYLE_BOXES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {SHAPE_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel>Words read</FieldLabel>
        <ToggleGroup type="single" size="sm" variant="outline" value={entry.orientation ?? 'horizontal'} disabled={!canEdit} aria-label="Which way the words read" data-testid="tag-style-orientation" onValueChange={(v) => (v === 'horizontal' || v === 'along') && v !== (entry.orientation ?? 'horizontal') && update({ orientation: v }, v === 'along' ? `turn "${entry.name}" along what it labels` : `keep "${entry.name}" level`)}>
          <ToggleGroupItem value="horizontal">Level on the sheet</ToggleGroupItem>
          <ToggleGroupItem value="along">Along the duct or pipe</ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription className="text-xs">Along turns the words with the run, never upside down.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Arrow along the run</FieldLabel>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={entry.arrow ?? 'none'}
          disabled={!canEdit}
          aria-label="Arrow along the run"
          data-testid="tag-style-arrow"
          onValueChange={(v) => {
            if (v !== 'none' && v !== 'down_slope' && v !== 'up_slope') return
            if (v === (entry.arrow ?? 'none')) return
            update({ arrow: v }, v === 'none' ? `take the arrow off "${entry.name}"` : `point "${entry.name}" ${v === 'down_slope' ? 'downhill' : 'uphill'}`)
          }}
        >
          <ToggleGroupItem value="none">None</ToggleGroupItem>
          <ToggleGroupItem value="down_slope">Downhill</ToggleGroupItem>
          <ToggleGroupItem value="up_slope">Uphill</ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription className="text-xs">An arrow under the words points to the run&apos;s lower (or higher) end, the right way on a turned plan. Level runs show none.</FieldDescription>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field>
          <FieldLabel htmlFor="tag-style-prefix">Before</FieldLabel>
          <Input key={`p:${entry.prefix ?? ''}`} id="tag-style-prefix" defaultValue={entry.prefix ?? ''} placeholder="(N) " maxLength={20} disabled={!canEdit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => e.target.value !== (entry.prefix ?? '') && update({ prefix: e.target.value }, `change what "${entry.name}" starts with`)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="tag-style-suffix">After</FieldLabel>
          <Input key={`s:${entry.suffix ?? ''}`} id="tag-style-suffix" defaultValue={entry.suffix ?? ''} placeholder=" TYP." maxLength={20} disabled={!canEdit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => e.target.value !== (entry.suffix ?? '') && update({ suffix: e.target.value }, `change what "${entry.name}" ends with`)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="tag-style-units">Lengths and heights</FieldLabel>
          <Select value={entry.units ?? 'ft_in'} disabled={!canEdit} onValueChange={(v) => {
              const units = TAG_STYLE_UNITS.find((u) => u === v)
              if (units && units !== (entry.units ?? 'ft_in')) update({ units }, `print "${entry.name}" lengths in ${UNITS_LABEL[units].toLowerCase()}`)
            }}>
            <SelectTrigger id="tag-style-units" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TAG_STYLE_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {UNITS_LABEL[u]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field orientation="horizontal" className="w-auto">
          <Switch id="tag-style-leader" checked={entry.leader} disabled={!canEdit} onCheckedChange={(checked) => update({ leader: checked }, checked ? `add leaders to "${entry.name}"` : `remove leaders from "${entry.name}"`)} />
          <FieldLabel htmlFor="tag-style-leader">Leader to the element</FieldLabel>
        </Field>
        {entry.leader && (
          <Field className="w-40">
            <FieldLabel htmlFor="tag-style-leader-end">Leader ends in</FieldLabel>
            <Select value={entry.leaderEnd ?? 'dot'} disabled={!canEdit} onValueChange={(v) => {
                const end = TAG_LEADER_ENDS.find((x) => x === v)
                if (end && end !== (entry.leaderEnd ?? 'dot')) update({ leaderEnd: end }, `end "${entry.name}" leaders in ${LEADER_END_LABEL[end].toLowerCase()}`)
              }}>
              <SelectTrigger id="tag-style-leader-end" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TAG_LEADER_ENDS.map((x) => (
                    <SelectItem key={x} value={x}>
                      {LEADER_END_LABEL[x]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <FieldSet>
        <FieldLegend variant="label">It labels</FieldLegend>
        <FieldGroup className="grid grid-cols-2 gap-1.5">
          {TAG_STYLE_CATEGORIES.map((k) => (
            <Field key={k} orientation="horizontal">
              <Checkbox
                id={`tag-style-applies-${k}`}
                checked={applies.size === 0 || applies.has(k)}
                disabled={!canEdit || (kinds.has(k) && applies.size > 0)}
                data-testid={`tag-style-applies-${k}`}
                onCheckedChange={(v) => {
                  const all = applies.size === 0 ? new Set(TAG_STYLE_CATEGORIES) : new Set(applies)
                  if (v === true) all.add(k)
                  else all.delete(k)
                  if (all.size === 0) {
                    run('A tag style has to label something. Tick at least one kind.')
                    return
                  }
                  const next = all.size === TAG_STYLE_CATEGORIES.length ? [] : TAG_STYLE_CATEGORIES.filter((x) => all.has(x))
                  update({ appliesTo: next }, v === true ? `let "${entry.name}" label ${TAG_STYLE_KIND_LABEL[k].toLowerCase()}` : `stop "${entry.name}" labelling ${TAG_STYLE_KIND_LABEL[k].toLowerCase()}`)
                }}
              />
              <FieldContent>
                <FieldLabel htmlFor={`tag-style-applies-${k}`} className="font-normal">
                  {TAG_STYLE_KIND_LABEL[k]}
                </FieldLabel>
              </FieldContent>
            </Field>
          ))}
        </FieldGroup>
        <FieldDescription className="text-xs">Only these kinds can take it. A kind it is the default for stays ticked; untick the default first.</FieldDescription>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">New tags on these use it</FieldLegend>
        <FieldGroup className="grid grid-cols-2 gap-1.5">
          {TAG_STYLE_CATEGORIES.map((k) => (
            <Field key={k} orientation="horizontal">
              <Checkbox
                id={`tag-style-default-${k}`}
                checked={kinds.has(k)}
                disabled={!canEdit}
                data-testid={`tag-style-default-${k}`}
                onCheckedChange={(v) => {
                  const next = TAG_STYLE_CATEGORIES.filter((x) => (x === k ? v === true : kinds.has(x)))
                  update({ defaultFor: next }, v === true ? `make "${entry.name}" the default for ${TAG_STYLE_KIND_LABEL[k].toLowerCase()}` : `stop "${entry.name}" being the default for ${TAG_STYLE_KIND_LABEL[k].toLowerCase()}`)
                }}
              />
              <FieldContent>
                <FieldLabel htmlFor={`tag-style-default-${k}`} className="font-normal">
                  {TAG_STYLE_KIND_LABEL[k]}
                </FieldLabel>
              </FieldContent>
            </Field>
          ))}
        </FieldGroup>
        <FieldDescription className="text-xs">Tag and Tag all use it for these. Another style that was the default for one of them stops being it.</FieldDescription>
      </FieldSet>
      <Button variant="outline" size="sm" className="w-fit text-danger-600" disabled={!canEdit || usedBy > 0} onClick={onDelete} title={usedBy > 0 ? `${usedBy} tag${usedBy === 1 ? '' : 's'} use this style; give them another style first` : undefined}>
        <Trash2 data-icon="inline-start" />
        Delete style
      </Button>
      {usedBy > 0 && <FieldDescription className="text-xs">Used by {usedBy} tag{usedBy === 1 ? '' : 's'}, so it can&apos;t be deleted until they use another style.</FieldDescription>}
    </FieldGroup>
  )
}
