'use client'

import { useState } from 'react'
import { formScheduleKindLabel, type FormScheduleDefinition, type ModelState, type ViewElement } from '@permitzip/bim-kernel'
import { distributionEquipment } from '@permitzip/bim-pack-electrical'
import { Button } from '../../../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { Separator } from '../../../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import type { SubmitCommand } from '../../views-sheets/types'
import { RULE_CHOICES, boundKindFor, isBoundKind, ruleChoiceOf, withRules } from './schedule-plan'
import type { ScheduleTemplates } from './use-schedule-templates'

const TEXT_SIZES_MM = [1.5, 2, 2.5, 3] as const

/** Why Save as firm default can't run, or null. */
export function saveDefaultBlocked(templates: Pick<ScheduleTemplates, 'status' | 'canWrite' | 'problem'>, editBlocked: string | null): string | null {
  if (templates.status === 'loading' || templates.status === 'idle') return 'Checking whether you can save to the firm library…'
  if (templates.status === 'error') return templates.problem ?? "Your firm's templates couldn't load."
  if (!templates.canWrite) return 'Only people who can add to the firm library can save firm templates. Ask a project lead.'
  return editBlocked
}

/**
 * A form schedule's own properties, under the view's (open by itself, or
 * selected on a sheet): which panel it is the schedule of, the code its
 * demand follows, its template and text size. Each change saves and undoes
 * on its own.
 */
export function ScheduleProperties({
  model,
  view,
  def,
  canEdit,
  blockedReason,
  submit,
  templates,
  onEditTemplate,
}: {
  readonly model: ModelState
  readonly view: ViewElement
  readonly def: FormScheduleDefinition
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly templates: ScheduleTemplates
  readonly onEditTemplate: () => void
}) {
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const editBlocked = canEdit ? null : blockedReason
  const kindLabel = formScheduleKindLabel(def.kind)
  const equipment = distributionEquipment(model.elements).filter((e) => boundKindFor(e) === def.kind)
  const bound = def.elementId ? (equipment.find((e) => e.id === def.elementId) ?? null) : null
  const firmDefault = templates.firmDefault(def.kind)
  const send = (next: FormScheduleDefinition, label: string) => {
    const refused = submit({ type: 'set_view_properties', viewId: view.id, props: { formSchedule: next } }, label)
    setMessage(refused ? { kind: 'error', text: refused } : null)
  }
  const saveBlocked = saveDefaultBlocked(templates, editBlocked)
  const useDefaultBlocked = editBlocked ?? (templates.status === 'error' ? templates.problem : firmDefault ? null : `Your firm has no default ${kindLabel.toLowerCase()} template yet. Save one with Save as firm default.`)

  const saveAsDefault = async () => {
    if (saveBlocked) return
    setSaving(true)
    const refused = await templates.save({ kind: def.kind, name: def.template.name, template: def.template, makeDefault: true })
    setSaving(false)
    setMessage(refused ? { kind: 'error', text: refused } : { kind: 'ok', text: `Saved “${def.template.name}” as your firm’s default ${kindLabel.toLowerCase()}. New schedules start from it; sheets already drawn keep theirs.` })
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Schedule" data-testid="schedule-properties">
      <Separator />
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{kindLabel}</span>
      <FieldGroup className="gap-3">
        {isBoundKind(def.kind) && (
          <Field>
            <FieldLabel htmlFor="sp-panel">{def.kind === 'panel' ? 'Panel' : 'Switchboard or transformer'}</FieldLabel>
            <Select value={bound?.id ?? ''} disabled={!canEdit || equipment.length === 0} onValueChange={(id) => send({ ...def, elementId: id }, `show ${equipment.find((e) => e.id === id)?.name ?? 'another panel'} in ${view.name}`)}>
              <SelectTrigger id="sp-panel" size="sm" data-testid="schedule-props-panel">
                <SelectValue placeholder="No longer in the model: choose one" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {equipment.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name} · {e.system}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {editBlocked && <FieldDescription>{editBlocked}</FieldDescription>}
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="sp-rules">Demand figures</FieldLabel>
          <Select value={ruleChoiceOf(def.rules)} disabled={!canEdit} onValueChange={(v) => send(withRules(def, RULE_CHOICES.find((r) => r.value === v)?.value ?? 'none'), `${view.name}: ${RULE_CHOICES.find((r) => r.value === v)?.label ?? 'connected loads only'}`)}>
            <SelectTrigger id="sp-rules" size="sm" data-testid="schedule-props-rules">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RULE_CHOICES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">The printed schedule names the code it used.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="sp-text">Text size on paper</FieldLabel>
          <Select value={String(def.textSizeMm ?? 2)} disabled={!canEdit} onValueChange={(v) => send({ ...def, textSizeMm: Number(v) }, `resize ${view.name} text`)}>
            <SelectTrigger id="sp-text" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TEXT_SIZES_MM.map((mm) => (
                  <SelectItem key={mm} value={String(mm)}>
                    {mm} mm
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Template</FieldLabel>
          <span className="text-sm" data-testid="schedule-props-template">
            {def.template.name}
          </span>
          {def.templateSource && (
            <FieldDescription className="text-xs">
              From the firm template “{def.templateSource.name}”, revision {def.templateSource.revision}.
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <Button variant="outline" size="sm" disabled={!canEdit} onClick={onEditTemplate} title={editBlocked ?? undefined} data-testid="schedule-props-edit-template">
        Edit template…
      </Button>
      <div className="flex gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex-1">
              <Button variant="outline" size="sm" className="w-full" disabled={saveBlocked !== null || saving} onClick={() => void saveAsDefault()} data-testid="schedule-props-save-default">
                {saving ? 'Saving…' : 'Save as firm default'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{saveBlocked ?? 'Every new schedule of this kind starts from this template.'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex-1">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={useDefaultBlocked !== null}
                onClick={() => firmDefault && send({ ...def, template: firmDefault.template, templateSource: { name: firmDefault.name, revision: firmDefault.revision } }, `use the firm template ${firmDefault.name} in ${view.name}`)}
                data-testid="schedule-props-use-default"
              >
                Use firm default
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{useDefaultBlocked ?? `Replace this schedule’s template with “${firmDefault?.name ?? ''}”.`}</TooltipContent>
        </Tooltip>
      </div>
      {saveBlocked && (templates.status === 'ready' || templates.status === 'error') && <p className="text-xs text-muted-foreground" data-testid="schedule-props-save-why">{saveBlocked}</p>}
      {message && (
        <p className={`text-xs ${message.kind === 'error' ? 'text-danger-600' : 'text-success-700'}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="schedule-props-message">
          {message.text}
        </p>
      )}
    </section>
  )
}
