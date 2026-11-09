'use client'

import { useMemo, useState } from 'react'
import { DIMENSION_UNITS, TAG_TEMPLATES, TERMINATORS, clearSpotForTag, dimensionLabels, documentIndex, organizationOf, styleOf, tagHasLeader, tagLines, tagSituation, tagStyleCategoryOf, tagStyleName, type DimSpec, type DrawingItem, type ModelState, type TagSpec, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import { CopyPlus } from 'lucide-react'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { withLeader } from './annotation-tools'

/**
 * Properties of a selected dimension or tag. Every change is one kernel
 * command (update_drawing_item), the same one agents send, so it saves, undoes
 * and conflicts like any other edit.
 */

const TEMPLATE_LABEL: Record<(typeof TAG_TEMPLATES)[number], string> = {
  auto: 'Automatic (by what it is)',
  duct_size: 'Duct size',
  duct_size_insulation: 'Duct size with insulation',
  pipe_size: 'Pipe size',
  pipe_size_insulation: 'Pipe size with insulation',
  mark: 'Mark',
  air_terminal: 'Air terminal: mark and CFM',
  equipment: 'Equipment mark',
  fixture: 'Fixture mark',
  fields: 'Chosen fields',
  gas_pipe: 'Gas pipe: size and length',
  name_number: 'Room or space: name and number',
}

const UNIT_LABEL: Record<(typeof DIMENSION_UNITS)[number], string> = { ft_in: "Feet and inches (1'-6\")", in: 'Inches (18")', mm: 'Millimetres', m: 'Metres' }

const KIND_LABEL: Record<DimSpec['kind'], string> = {
  linear: 'Linear dimension',
  aligned: 'Aligned dimension',
  angular: 'Angular dimension',
  radial: 'Radius',
  diameter: 'Diameter',
  arc_length: 'Arc length',
  spot_elevation: 'Spot elevation',
  spot_coordinate: 'Spot coordinate',
}

/** A text field that saves on Enter or when it loses focus, and only when the words changed. Keyed by its saved value, so a new value starts a fresh draft. */
function SavedInput(props: { id: string; value: string; placeholder: string; disabled: boolean; onSave: (v: string) => void }) {
  return <DraftInput key={props.value} {...props} />
}

function DraftInput({ id, value, placeholder, disabled, onSave }: { id: string; value: string; placeholder: string; disabled: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    if (draft !== value) onSave(draft)
  }
  return (
    <Input
      id={id}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

export function AnnotationProperties({
  item,
  model,
  view,
  canEdit,
  blockedReason,
  onDim,
  onTag,
  onMoveTag,
  onDelete,
  onTagsBatch,
  onOpenTagStyles,
  onCreateSimilar,
}: {
  item: DrawingItem
  model: ModelState
  view: ViewElement | null
  canEdit: boolean
  blockedReason: string
  onDim: (dim: DimSpec) => void
  onTag: (tag: TagSpec) => void
  /** Put the tag's head here (view frame), e.g. the first clear spot beside its element. */
  onMoveTag?: (at: Vec2) => void
  onDelete: () => void
  /** Many tags in one edit (giving tags a style). */
  onTagsBatch?: (updates: ReadonlyArray<{ readonly itemId: string; readonly tag: TagSpec }>, label: string) => void
  /** Open Tag styles, on this style when given. */
  onOpenTagStyles?: (styleId: string | null) => void
  /** Start the Tag tool set to tag the next element like this one (C S). */
  onCreateSimilar?: () => void
}) {
  const dim = item.dim
  const tag = item.tag
  if (!dim && !tag) return null
  return (
    <div className="flex flex-col gap-3" data-testid="annotation-properties">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{dim ? KIND_LABEL[dim.kind] : 'Tag'}</span>
      {!canEdit && <span className="text-xs text-muted-foreground">{blockedReason}</span>}
      {dim && <DimensionFields dim={dim} prints={dimensionLabels(model, view, item)} canEdit={canEdit} onDim={onDim} />}
      {tag && <TagFields item={item} model={model} tag={tag} prints={tagLines(model, tag)} canEdit={canEdit} onTag={onTag} onTagsBatch={onTagsBatch} onOpenTagStyles={onOpenTagStyles} />}
      {tag && <TagLook model={model} tag={tag} canEdit={canEdit} onTag={onTag} onCreateSimilar={onCreateSimilar} />}
      {tag && view && onMoveTag && <TagPlacement item={item} model={model} view={view} canEdit={canEdit} onMoveTag={onMoveTag} />}
      <Button variant="outline" size="sm" className="text-danger-600" disabled={!canEdit} onClick={onDelete} data-testid="annotation-delete">
        Delete
      </Button>
      <span className="text-xs text-muted-foreground">Delete key also removes it. Ctrl+Z brings it back.</span>
    </div>
  )
}

function DimensionFields({ dim, prints, canEdit, onDim }: { dim: DimSpec; prints: readonly string[]; canEdit: boolean; onDim: (dim: DimSpec) => void }) {
  const style = styleOf(dim)
  const follows = (dim.refs ?? []).filter((r) => r).length
  const set = (patch: Partial<DimSpec>) => onDim({ ...dim, ...patch })
  const without = (key: 'textOverride' | 'prefix' | 'suffix', value: string) => {
    const { [key]: _gone, ...rest } = dim
    return value.trim() ? { ...rest, [key]: value } : rest
  }
  return (
    <>
      <span className="text-sm" data-testid="dimension-prints">
        {prints.join('  ·  ') || '—'}
      </span>
      <span className="text-xs text-muted-foreground">
        {follows > 0 ? `Follows ${follows} point${follows === 1 ? '' : 's'} on the model: it updates when they move.` : 'Measures fixed points (it does not follow the model).'}
      </span>
      <Field>
        <FieldLabel htmlFor="dim-override">Text instead of the value</FieldLabel>
        <SavedInput id="dim-override" value={dim.textOverride ?? ''} placeholder="e.g. EQ or VERIFY" disabled={!canEdit} onSave={(v) => onDim(without('textOverride', v))} />
      </Field>
      <div className="flex gap-2">
        <Field>
          <FieldLabel htmlFor="dim-prefix">Before</FieldLabel>
          <SavedInput id="dim-prefix" value={dim.prefix ?? ''} placeholder="MIN. " disabled={!canEdit} onSave={(v) => onDim(without('prefix', v))} />
        </Field>
        <Field>
          <FieldLabel htmlFor="dim-suffix">After</FieldLabel>
          <SavedInput id="dim-suffix" value={dim.suffix ?? ''} placeholder=" CLR" disabled={!canEdit} onSave={(v) => onDim(without('suffix', v))} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="dim-units">Units</FieldLabel>
        <Select value={style.units} onValueChange={(v) => set({ style: { ...dim.style, units: DIMENSION_UNITS.find((u) => u === v) ?? style.units } })} disabled={!canEdit}>
          <SelectTrigger id="dim-units" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {DIMENSION_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {UNIT_LABEL[u]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel>Ends</FieldLabel>
        <ToggleGroup type="single" size="sm" variant="outline" value={style.terminator} disabled={!canEdit} onValueChange={(v) => v && set({ style: { ...dim.style, terminator: TERMINATORS.find((t) => t === v) ?? style.terminator } })}>
          {TERMINATORS.map((t) => (
            <ToggleGroupItem key={t} value={t} aria-label={`${t} ends`}>
              {t === 'tick' ? 'Tick' : t === 'arrow' ? 'Arrow' : 'Dot'}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>Text is {(style.textSizeMm / 25.4).toFixed(3)}&quot; tall on paper at any view scale.</FieldDescription>
      </Field>
    </>
  )
}

const NO_STYLE = 'none'

/** Where the tag sits: whether it runs into other annotations or lines, and a button that moves it to the first clear spot. */
function TagPlacement({ item, model, view, canEdit, onMoveTag }: { item: DrawingItem; model: ModelState; view: ViewElement; canEdit: boolean; onMoveTag: (at: Vec2) => void }) {
  const showsModel = view.viewType === 'floor_plan' || view.viewType === 'ceiling_plan' || view.viewType === 'section'
  const situation = useMemo(() => (showsModel ? tagSituation(model, view.id, item) : null), [model, view, item, showsModel])
  const spot = useMemo(() => (showsModel && situation && !situation.clear ? clearSpotForTag(model, view.id, item.id) : null), [model, view, item, showsModel, situation])
  if (!situation) return null
  const crowded = [situation.overlaps.length > 0 ? `overlaps ${situation.overlaps.length} other annotation${situation.overlaps.length === 1 ? '' : 's'}` : null, situation.crossesLines > 0 ? `crosses ${situation.crossesLines} line${situation.crossesLines === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')
  const why = !canEdit ? 'You can’t edit this view' : situation.clear ? 'It already sits clear of everything' : !spot ? 'No clear spot beside its element; drag it by hand or crop the view less tightly' : undefined
  return (
    <div className="flex flex-col gap-1.5" data-testid="tag-placement">
      <span className={situation.clear ? 'text-xs text-muted-foreground' : 'text-xs text-warning-700'} data-testid="tag-placement-state">
        {situation.clear ? 'Sits clear of other tags, notes and lines.' : `This tag ${crowded}.`}
      </span>
      <Button variant="outline" size="sm" className="self-start" disabled={why !== undefined} title={why} data-testid="tag-move-clear" onClick={() => spot && onMoveTag(spot.at)}>
        Move clear of others
      </Button>
      <span className="text-xs text-muted-foreground">Or drag its head; its words stay with the element. Ctrl+Z puts it back.</span>
    </div>
  )
}

/** Tags in the same view on the same kind of element as this one (what "use on all" reaches). */
function siblingTags(model: ModelState, item: DrawingItem): DrawingItem[] {
  const own = item.tag ? model.elements[item.tag.elementId] : undefined
  const kind = own ? tagStyleCategoryOf(model, own) : null
  if (!kind) return []
  return (documentIndex(model).itemsByOwner.get(item.ownerId) ?? []).filter((it) => {
    if (it.deleted || !it.tag) return false
    const el = model.elements[it.tag.elementId]
    return el !== undefined && tagStyleCategoryOf(model, el) === kind
  })
}

function TagFields({
  item,
  model,
  tag,
  prints,
  canEdit,
  onTag,
  onTagsBatch,
  onOpenTagStyles,
}: {
  item: DrawingItem
  model: ModelState
  tag: TagSpec
  prints: readonly string[] | null
  canEdit: boolean
  onTag: (tag: TagSpec) => void
  onTagsBatch?: (updates: ReadonlyArray<{ readonly itemId: string; readonly tag: TagSpec }>, label: string) => void
  onOpenTagStyles?: (styleId: string | null) => void
}) {
  const styles = organizationOf(model).tagStyles
  const styleName = tagStyleName(model, tag)
  const siblings = siblingTags(model, item)
  const kindEl = model.elements[tag.elementId]
  const kind = kindEl ? tagStyleCategoryOf(model, kindEl) : null
  const pending = tag.styleId ? siblings.filter((s) => s.tag?.styleId !== tag.styleId) : []
  return (
    <>
      <span className="text-sm" data-testid="tag-prints">
        {prints ? prints.join(' / ') : 'The element this tag labelled is gone.'}
      </span>
      <Field>
        <FieldLabel htmlFor="tag-style">Style</FieldLabel>
        <Select
          value={tag.styleId && styleName ? tag.styleId : NO_STYLE}
          disabled={!canEdit}
          onValueChange={(v) => {
            if (v === NO_STYLE) {
              const { styleId: _gone, ...rest } = tag
              onTag(rest)
            } else if (v !== tag.styleId) onTag({ ...tag, styleId: v })
          }}
        >
          <SelectTrigger id="tag-style" size="sm" data-testid="tag-style-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NO_STYLE}>No style (pick what it shows below)</SelectItem>
              {styles.filter((s) => !s.entry.appliesTo?.length || (kind !== null && s.entry.appliesTo.includes(kind)) || s.id === tag.styleId).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.entry.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{styleName ? `Its words, size, box and leader come from "${styleName}". Change the style to change every tag that uses it.` : 'A style is a named tag look you can reuse on many tags.'}</FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        {onOpenTagStyles && (
          <Button variant="outline" size="sm" onClick={() => onOpenTagStyles(tag.styleId ?? null)} data-testid="tag-edit-styles">
            {styleName ? 'Edit this style' : 'Tag styles…'}
          </Button>
        )}
        {onTagsBatch && tag.styleId && styleName && kind && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || pending.length === 0}
            data-testid="tag-style-apply-all"
            title={pending.length === 0 ? `Every ${kind.replace(/_/g, ' ')} tag in this view already uses "${styleName}"` : undefined}
            onClick={() => onTagsBatch(pending.flatMap((s) => (s.tag ? [{ itemId: s.id, tag: { ...s.tag, styleId: tag.styleId } }] : [])), `use "${styleName}" on ${pending.length} tag${pending.length === 1 ? '' : 's'}`)}
          >
            {pending.length === 0 ? 'All tags of this kind use it' : `Use on ${pending.length} more ${kind.replace(/_/g, ' ')} tag${pending.length === 1 ? '' : 's'} here`}
          </Button>
        )}
      </div>
      {!styleName && (
      <Field>
        <FieldLabel htmlFor="tag-template">Shows</FieldLabel>
        <Select value={tag.template} onValueChange={(v) => onTag({ ...tag, template: TAG_TEMPLATES.find((t) => t === v) ?? tag.template })} disabled={!canEdit}>
          <SelectTrigger id="tag-template" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {TAG_TEMPLATES.filter((t) => t !== 'fields').map((t) => (
                <SelectItem key={t} value={t}>
                  {TEMPLATE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>The words come from the element and change when it does.</FieldDescription>
      </Field>
      )}
    </>
  )
}

/** The tag's leader, its bend and its background, and Create similar: what a person reaches for on a single tag whatever its style. */
function TagLook({ model, tag, canEdit, onTag, onCreateSimilar }: { model: ModelState; tag: TagSpec; canEdit: boolean; onTag: (tag: TagSpec) => void; onCreateSimilar?: () => void }) {
  const leader = tagHasLeader(model, tag)
  const styled = tag.styleId !== undefined && tagStyleName(model, tag) !== null
  return (
    <div className="flex flex-col gap-2" data-testid="tag-look">
      <Field orientation="horizontal">
        <Switch id="tag-leader" checked={leader} disabled={!canEdit} onCheckedChange={(checked) => onTag(withLeader(model, tag, checked))} data-testid="tag-leader" />
        <FieldLabel htmlFor="tag-leader">Leader to the element</FieldLabel>
      </Field>
      {styled && tag.leaderOverride !== undefined && <FieldDescription>This tag {tag.leaderOverride ? 'shows' : 'hides'} its leader whatever its style says.</FieldDescription>}
      <Field orientation="horizontal">
        <Switch
          id="tag-elbow"
          checked={tag.elbow !== undefined}
          disabled={!canEdit || !leader}
          onCheckedChange={(checked) => {
            const { elbow: _bend, ...rest } = tag
            onTag(checked ? { ...rest, elbow: 'auto' } : rest)
          }}
          data-testid="tag-elbow"
        />
        <FieldLabel htmlFor="tag-elbow">Bend the leader (elbow)</FieldLabel>
      </Field>
      {!leader && <FieldDescription>Turn the leader on to bend it. Drag its bend on the drawing to move it.</FieldDescription>}
      <Field orientation="horizontal">
        <Switch
          id="tag-mask"
          checked={tag.mask === true}
          disabled={!canEdit}
          onCheckedChange={(checked) => {
            const { mask: _was, ...rest } = tag
            onTag(checked ? { ...rest, mask: true } : rest)
          }}
          data-testid="tag-mask"
        />
        <FieldLabel htmlFor="tag-mask">Opaque background</FieldLabel>
      </Field>
      <FieldDescription>Hides the lines behind the tag&apos;s words, on screen and in print.</FieldDescription>
      {onCreateSimilar && (
        <Button variant="outline" size="sm" className="self-start" disabled={!canEdit} onClick={onCreateSimilar} data-testid="tag-create-similar">
          <CopyPlus data-icon="inline-start" />
          Create similar (C S)
        </Button>
      )}
    </div>
  )
}
