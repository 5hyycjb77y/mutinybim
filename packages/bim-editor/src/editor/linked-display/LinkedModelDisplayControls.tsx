'use client'

import { ChevronDown } from 'lucide-react'
import { LINE_WEIGHTS, REFERENCE_DISPLAY_PRESETS, REFERENCE_PRESET_LABEL, MAX_REFERENCE_TRANSPARENCY_PCT, type LineWeight, type ReferenceCategoryDisplay, type ReferenceDisplayPreset } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Slider } from '../../ui/slider'
import type { LinkedDisplay } from './use-linked-display'
import { LinkedDisplayBeforeAfter, LinkedDisplayPreview } from './LinkedDisplayPreview'

/**
 * Controls for how a linked model draws: a one-click choice (Normal,
 * Halftone, See-through, Underlay, Hidden) on each linked model card, and in
 * View properties the same choice plus how see-through it is in 3D and
 * per-category exceptions.
 */

const PRESET_HINT: Record<ReferenceDisplayPreset | 'custom', string> = {
  normal: 'Full colour and linework, as the architect drew it.',
  halftone: 'Lighter grey linework; slightly see-through in 3D.',
  transparent: 'Grey and well see-through in 3D, so your work shows behind it.',
  underlay: 'Faint, and your work draws over it: lighter than halftone on paper, mostly see-through in 3D.',
  hidden: 'Not drawn, printed or pickable in this view. The link stays; pick another look to bring it back.',
  custom: 'Set by hand below (see-through amount or categories).',
}

const PEN_LABEL: Record<LineWeight, string> = { thin: 'Thin', medium: 'Medium', wide: 'Wide', heavy: 'Heavy' }

function isPreset(value: string): value is ReferenceDisplayPreset {
  return (REFERENCE_DISPLAY_PRESETS as readonly string[]).includes(value)
}

interface SelectProps {
  readonly display: LinkedDisplay
  readonly referenceId: string
  readonly label: string
  /** Why it can't change (shown, and the control stays usable for this tab only when the hook allows it). */
  readonly disabledReason?: string | null
}

/** The one-click display choice for one linked model in whatever is open. */
export function LinkedModelDisplaySelect({ display, referenceId, label, disabledReason = null }: SelectProps) {
  const { preset } = display.entry(referenceId)
  const id = `linked-display-${referenceId}`
  return (
    <Field orientation="horizontal" className="gap-2" data-testid="linked-model-display">
      <FieldLabel htmlFor={id} className="shrink-0 text-xs font-normal text-muted-foreground">
        In {display.targetLabel}
      </FieldLabel>
      <Select
        value={preset}
        disabled={disabledReason !== null}
        onValueChange={(value) => {
          if (isPreset(value)) display.setPreset(referenceId, label, value)
        }}
      >
        <SelectTrigger id={id} size="sm" className="h-7 min-w-32 text-xs" aria-label={`How ${label} draws in ${display.targetLabel}`} title={disabledReason ?? PRESET_HINT[preset]}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {REFERENCE_DISPLAY_PRESETS.map((p) => (
              <SelectItem key={p} value={p} className="text-xs" title={PRESET_HINT[p]}>
                <LinkedDisplayPreview preset={p} className="h-5 w-8" />
                {REFERENCE_PRESET_LABEL[p]}
              </SelectItem>
            ))}
            {preset === 'custom' && (
              <SelectItem value="custom" disabled className="text-xs">
                {REFERENCE_PRESET_LABEL.custom}
              </SelectItem>
            )}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

/** Common categories of an architect's model a person turns down or off. */
export const LINKED_CATEGORY_CHOICES: readonly { readonly category: string; readonly label: string }[] = [
  { category: 'IFCWALL', label: 'Walls' },
  { category: 'IFCDOOR', label: 'Doors' },
  { category: 'IFCWINDOW', label: 'Windows' },
  { category: 'IFCSLAB', label: 'Floors' },
  { category: 'IFCROOF', label: 'Roofs' },
  { category: 'IFCCOVERING', label: 'Ceilings and finishes' },
  { category: 'IFCCOLUMN', label: 'Columns' },
  { category: 'IFCFURNISHINGELEMENT', label: 'Furniture' },
]

type CategoryChoice = 'follow' | 'halftone' | 'ink' | 'hidden'
const CATEGORY_CHOICES: readonly CategoryChoice[] = ['follow', 'halftone', 'ink', 'hidden']
const CATEGORY_CHOICE_LABEL: Record<CategoryChoice, string> = { follow: 'Like the model', halftone: 'Halftone', ink: 'Full colour', hidden: 'Hidden' }

function categoryChoice(c: ReferenceCategoryDisplay | undefined): CategoryChoice {
  if (!c) return 'follow'
  if (c.visible === false) return 'hidden'
  if (c.halftone === true) return 'halftone'
  if (c.halftone === false) return 'ink'
  return 'follow'
}

function categoryOverride(choice: CategoryChoice): ReferenceCategoryDisplay | null {
  switch (choice) {
    case 'follow':
      return null
    case 'hidden':
      return { visible: false }
    case 'halftone':
      return { halftone: true }
    case 'ink':
      return { halftone: false }
  }
}

function isCategoryChoice(value: string): value is CategoryChoice {
  return (CATEGORY_CHOICES as readonly string[]).includes(value)
}

interface FieldsProps {
  readonly display: LinkedDisplay
  readonly references: readonly { readonly id: string; readonly label: string }[]
  readonly canEdit: boolean
  readonly disabledHint: string | null
}

/** View properties › Linked models in this view. */
export function LinkedModelDisplayFields({ display, references, canEdit, disabledHint }: FieldsProps) {
  const reason = canEdit ? null : disabledHint
  return (
    <FieldGroup className="gap-3" data-testid="linked-model-display-fields">
      {references.map((r) => {
        const { stored, resolved, preset } = display.entry(r.id)
        const sliderId = `linked-transparency-${r.id}`
        return (
          <div key={r.id} className="flex flex-col gap-2" data-testid="linked-model-display-row" data-preset={preset}>
            <p className="text-xs font-medium">{r.label}</p>
            <LinkedModelDisplaySelect display={display} referenceId={r.id} label={r.label} disabledReason={reason} />
            <FieldDescription className="text-xs">{reason ?? PRESET_HINT[preset]}</FieldDescription>
            <LinkedDisplayBeforeAfter preset={preset} />
            {display.surface === 'drawing' && resolved.visible && (
              <div className="grid grid-cols-2 gap-2" data-testid="linked-model-pens">
                {(['cut', 'beyond'] as const).map((kind) => {
                  const current = kind === 'cut' ? stored?.cutPen : stored?.beyondPen
                  return (
                    <Field key={kind}>
                      <FieldLabel htmlFor={`linked-pen-${kind}-${r.id}`} className="text-xs font-normal">
                        {kind === 'cut' ? 'Cut lines (walls)' : 'Lines below the cut'}
                      </FieldLabel>
                      <Select
                        value={current ?? 'default'}
                        disabled={!canEdit}
                        onValueChange={(value) => {
                          const pen = LINE_WEIGHTS.find((w) => w === value) ?? null
                          if (pen !== (current ?? null)) display.setPen(r.id, r.label, kind, pen)
                        }}
                      >
                        <SelectTrigger id={`linked-pen-${kind}-${r.id}`} size="sm" className="h-7 text-xs" aria-label={`${r.label} ${kind === 'cut' ? 'cut' : 'below the cut'} line weight`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="default" className="text-xs">
                              {kind === 'cut' ? 'Default (wide)' : 'Default (thin)'}
                            </SelectItem>
                            {LINE_WEIGHTS.map((w) => (
                              <SelectItem key={w} value={w} className="text-xs">
                                {PEN_LABEL[w]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )
                })}
              </div>
            )}
            {display.surface === '3d' && resolved.visible && (
              <Field>
                <FieldLabel htmlFor={sliderId} className="text-xs font-normal">
                  See-through in 3D: {resolved.transparencyPct}%
                </FieldLabel>
                <Slider
                  id={sliderId}
                  min={0}
                  max={MAX_REFERENCE_TRANSPARENCY_PCT}
                  step={5}
                  value={[resolved.transparencyPct]}
                  disabled={!canEdit}
                  aria-label={`How see-through ${r.label} is in 3D`}
                  onValueCommit={([pct]) => {
                    if (pct !== undefined && pct !== resolved.transparencyPct) display.setTransparency(r.id, r.label, pct)
                  }}
                />
              </Field>
            )}
            {resolved.visible && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-fit px-1 text-xs">
                    <ChevronDown data-icon="inline-start" />
                    By category{Object.keys(resolved.categories).length > 0 ? ` (${Object.keys(resolved.categories).length} changed)` : ''}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <FieldGroup className="gap-1 pl-2">
                    {LINKED_CATEGORY_CHOICES.map((c) => {
                      const id = `linked-cat-${r.id}-${c.category}`
                      const choice = categoryChoice(stored?.categories?.[c.category])
                      return (
                        <Field key={c.category} orientation="horizontal" className="justify-between gap-2">
                          <FieldContent>
                            <FieldLabel htmlFor={id} className="text-xs font-normal">
                              {c.label}
                            </FieldLabel>
                          </FieldContent>
                          <Select
                            value={choice}
                            disabled={!canEdit}
                            onValueChange={(value) => {
                              if (isCategoryChoice(value) && value !== choice) display.setCategory(r.id, r.label, c.category, categoryOverride(value))
                            }}
                          >
                            <SelectTrigger id={id} size="sm" className="h-7 w-32 text-xs" aria-label={`${c.label} of ${r.label}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {CATEGORY_CHOICES.map((k) => (
                                  <SelectItem key={k} value={k} className="text-xs">
                                    {CATEGORY_CHOICE_LABEL[k]}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      )
                    })}
                  </FieldGroup>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )
      })}
    </FieldGroup>
  )
}
