'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  TEXT_STYLE_BACKGROUNDS,
  TEXT_STYLE_ROLES,
  organizationOf,
  type ModelState,
  type TextStyleBackground,
  type TextStyleEntry,
  type TextStyleRole,
} from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { newId, type SubmitCommand } from '../views-sheets/types'

const ROLE_LABEL: Record<TextStyleRole, string> = {
  part_mark: 'Device & equipment marks (F2-1, GFCI-1)',
  link_label: 'Home runs & switch-leg letters',
  tag: 'Tags (when style inherits default)',
  dimension: 'Dimensions',
  note: 'General notes & callouts',
  space_label: 'Room & space titles',
}

const FONT_CHOICES = [
  { value: '__default__', label: 'Standard sheet font (Helvetica)' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Courier New', label: 'Courier New (monospace)' },
  { value: 'Times New Roman', label: 'Times New Roman' },
] as const

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
}

/**
 * Model-wide Text Types (Revit Text Type / CAD Text Style equivalent):
 * edit paper height, font family, bold/italic/uppercase, Opaque vs Transparent
 * background mask, and which drawing roles inherit each type. Changes update
 * every mark, home-run label, tag and room title across the model immediately.
 */
export function TextStylesDialog({ model, canEdit, blockedReason, submit, onClose }: Props) {
  const org = organizationOf(model)
  const styles = org.textStyles
  const [selectedId, setSelectedId] = useState<string>(styles[0]?.id ?? '')
  const current = styles.find((s) => s.id === selectedId) ?? styles[0]
  const [error, setError] = useState<string | null>(null)
  const [draftName, setDraftName] = useState<string>(current?.entry.name ?? '')
  const [draftSize, setDraftSize] = useState<string>(String(current?.entry.textSizeMm ?? 2.4))

  const selectStyle = (id: string) => {
    setSelectedId(id)
    setError(null)
    const next = styles.find((s) => s.id === id)
    if (next) {
      setDraftName(next.entry.name)
      setDraftSize(String(next.entry.textSizeMm))
    }
  }

  const updateCurrent = (
    changes: Partial<Pick<TextStyleEntry, 'name' | 'textSizeMm' | 'fontFamily' | 'bold' | 'italic' | 'uppercase' | 'background' | 'defaultFor'>>,
    label: string,
  ) => {
    if (!current || !canEdit) return
    const refusal = submit({ type: 'update_text_style', styleId: current.id, ...changes }, label)
    setError(refusal)
  }

  const createNew = () => {
    if (!canEdit) return
    const styleId = newId('txt')
    const name = `Text type ${styles.length + 1}`
    const refusal = submit(
      {
        type: 'create_text_style',
        styleId,
        name,
        textSizeMm: 2.4,
        background: 'opaque',
        defaultFor: [],
      },
      `create text type ${name}`,
    )
    setError(refusal)
    if (!refusal) {
      setSelectedId(styleId)
      setDraftName(name)
      setDraftSize('2.4')
    }
  }

  const removeCurrent = () => {
    if (!current || !canEdit) return
    const refusal = submit({ type: 'delete_text_style', styleId: current.id }, `delete text type ${current.entry.name}`)
    setError(refusal)
    if (!refusal) {
      const next = styles.find((s) => s.id !== current.id)
      if (next) selectStyle(next.id)
    }
  }

  const e = current?.entry

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="text-styles-dialog">
        <DialogHeader>
          <DialogTitle>Text types</DialogTitle>
          <DialogDescription>
            One central place for drawing fonts, paper sizes, and opaque white backgrounds so text stays crisp over wires, walls and grid lines.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr]">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase">Types</span>
              <Button variant="outline" size="sm" onClick={createNew} disabled={!canEdit} title={canEdit ? 'Add a new text type' : blockedReason}>
                <Plus className="size-3.5" />
                New
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {styles.map((s) => (
                <Button
                  key={s.id}
                  type="button"
                  variant="ghost"
                  onClick={() => selectStyle(s.id)}
                  className={`flex h-auto w-full flex-col items-start justify-start gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs font-normal transition-colors ${
                    current?.id === s.id ? 'border-primary bg-primary/10 text-foreground hover:bg-primary/15' : 'border-border hover:bg-muted/60 text-muted-foreground'
                  }`}
                >
                  <span className="font-medium text-foreground">{s.entry.name}</span>
                  <span>
                    {s.entry.textSizeMm} mm · {s.entry.background === 'opaque' ? 'Opaque' : 'Transparent'}
                  </span>
                </Button>
              ))}
            </div>
          </div>

          {current && e && (
            <div className="flex flex-col gap-3">
              {/* Live sample over a crossing line so the user sees the opaque halo immediately. */}
              <div className="relative flex h-12 items-center justify-center overflow-hidden rounded-md border bg-background">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-foreground/70" />
                <span
                  className="relative px-1.5"
                  style={{
                    fontFamily: e.fontFamily ? `${e.fontFamily}, Helvetica, Arial, sans-serif` : 'Helvetica, Arial, sans-serif',
                    fontSize: `${Math.max(10, Math.min(26, e.textSizeMm * 5.2))}px`,
                    fontWeight: e.bold ? 700 : 400,
                    fontStyle: e.italic ? 'italic' : 'normal',
                    backgroundColor: e.background === 'opaque' ? '#ffffff' : 'transparent',
                    color: '#111111',
                  }}
                >
                  {e.uppercase ? 'LP-1-1 / GFCI-1' : 'LP-1-1 / GFCI-1'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="ts-name">Name</FieldLabel>
                  <Input
                    id="ts-name"
                    value={draftName}
                    disabled={!canEdit}
                    onChange={(ev) => setDraftName(ev.target.value)}
                    onBlur={() => {
                      const trimmed = draftName.trim()
                      if (trimmed && trimmed !== e.name) updateCurrent({ name: trimmed }, `rename text type to ${trimmed}`)
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="ts-size">Paper height (mm)</FieldLabel>
                  <Input
                    id="ts-size"
                    type="number"
                    min={1.2}
                    max={20}
                    step={0.1}
                    value={draftSize}
                    disabled={!canEdit}
                    onChange={(ev) => setDraftSize(ev.target.value)}
                    onBlur={() => {
                      const n = Number(draftSize)
                      if (Number.isFinite(n) && n >= 1.2 && n <= 20 && n !== e.textSizeMm) {
                        updateCurrent({ textSizeMm: Math.round(n * 10) / 10 }, `set ${e.name} height to ${n} mm`)
                      } else {
                        setDraftSize(String(e.textSizeMm))
                      }
                    }}
                  />
                  <FieldDescription className="text-xs">2.4 mm ≈ 3/32&quot; · 3.2 mm ≈ 1/8&quot;</FieldDescription>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="ts-font">Font</FieldLabel>
                  <Select
                    value={e.fontFamily ?? '__default__'}
                    disabled={!canEdit}
                    onValueChange={(v) => updateCurrent({ fontFamily: v === '__default__' ? '' : v }, `change ${e.name} font`)}
                  >
                    <SelectTrigger id="ts-font" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {FONT_CHOICES.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field>
                  <FieldLabel>Background</FieldLabel>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    value={e.background}
                    disabled={!canEdit}
                    onValueChange={(v) => {
                      if (v && (TEXT_STYLE_BACKGROUNDS as readonly string[]).includes(v)) {
                        updateCurrent({ background: v as TextStyleBackground }, `set ${e.name} background to ${v}`)
                      }
                    }}
                  >
                    <ToggleGroupItem value="opaque">Opaque (masked)</ToggleGroupItem>
                    <ToggleGroupItem value="transparent">Transparent</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-5 pt-1">
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={Boolean(e.bold)} disabled={!canEdit} onCheckedChange={(v) => updateCurrent({ bold: v }, `toggle bold on ${e.name}`)} />
                  Bold
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={Boolean(e.italic)} disabled={!canEdit} onCheckedChange={(v) => updateCurrent({ italic: v }, `toggle italic on ${e.name}`)} />
                  Italic
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={Boolean(e.uppercase)} disabled={!canEdit} onCheckedChange={(v) => updateCurrent({ uppercase: v }, `toggle uppercase on ${e.name}`)} />
                  ALL CAPS
                </label>
              </div>

              <FieldSet>
                <FieldLegend variant="label">Default type for</FieldLegend>
                <FieldGroup className="gap-1.5">
                  {TEXT_STYLE_ROLES.map((role) => {
                    const checked = e.defaultFor.includes(role)
                    return (
                      <Field key={role} orientation="horizontal">
                        <Checkbox
                          id={`ts-role-${role}`}
                          checked={checked}
                          disabled={!canEdit}
                          onCheckedChange={(v) => {
                            const next = v === true ? [...new Set([...e.defaultFor, role])] : e.defaultFor.filter((r) => r !== role)
                            updateCurrent({ defaultFor: next }, `assign ${e.name} for ${role.replace(/_/g, ' ')}`)
                          }}
                        />
                        <FieldLabel htmlFor={`ts-role-${role}`} className="font-normal text-xs">
                          {ROLE_LABEL[role]}
                        </FieldLabel>
                      </Field>
                    )
                  })}
                </FieldGroup>
              </FieldSet>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="ghost" size="sm" onClick={removeCurrent} disabled={!canEdit || styles.length <= 1 || !current}>
            <Trash2 className="size-3.5" />
            Delete type
          </Button>
          <Button variant="default" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
