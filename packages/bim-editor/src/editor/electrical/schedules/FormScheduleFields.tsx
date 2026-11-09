'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { builtinFormTemplate, type FormScheduleDefinition, type FormScheduleKind, type ModelState } from '@permitzip/bim-kernel'
import { distributionEquipment } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Field, FieldDescription, FieldLabel } from '../../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../../ui/select'
import type { NecRules } from '../use-nec-rules'
import type { FormScheduleReady, NewScheduleFormFieldsProps, NewScheduleFormSlot } from '../../schedules/new-schedule-plan'
import { RULE_CHOICES, boundKindFor, isBoundKind, nextScheduleSheetNumber, scheduleChoiceLabel, uniqueScheduleName, withRules, type RuleChoice } from './schedule-plan'
import type { ScheduleTemplates } from './use-schedule-templates'

const BUILTIN = 'builtin'
const PLACE_PANEL_FIRST = 'Place a panel first: Electrical › Panel, then name it in its properties.'

interface Lent {
  readonly nec: Pick<NecRules, 'label' | 'edition'>
  readonly templates: ScheduleTemplates
  /** The selected panel, or the panel of the selected device; null when nothing points at one. */
  readonly initialPanelId: string | null
}

/**
 * The Electrical add-on's part of the one New schedule window, for its form
 * kinds: which panel or switchboard it is for, the firm's or the built-in
 * template, and the demand figures. The window owns the kind, the name and
 * the sheet; this reports the form it would make, or why not yet.
 */
function FormScheduleFields({ model, kind, onReady, nec, templates, initialPanelId }: NewScheduleFormFieldsProps & Lent) {
  const equipment = useMemo(() => distributionEquipment(model.elements), [model])
  const [panelId, setPanelId] = useState<string>(() => initialPanelId ?? (equipment.length === 1 ? (equipment[0]?.id ?? '') : ''))
  const [templatePick, setTemplatePick] = useState<{ kind: FormScheduleKind; value: string } | null>(null)
  const [rule, setRule] = useState<RuleChoice>(nec.edition ? `nec-${nec.edition}` : 'none')

  const bound = isBoundKind(kind)
  const picked = bound ? (equipment.find((e) => e.id === panelId) ?? null) : null
  const formKind: FormScheduleKind = picked ? boundKindFor(picked) : kind
  const firmChoices = templates.firm.filter((t) => t.kind === formKind)
  const firmDefault = templates.firmDefault(formKind)
  const templateValue = templatePick && templatePick.kind === formKind && (templatePick.value === BUILTIN || firmChoices.some((t) => `firm:${t.name}` === templatePick.value)) ? templatePick.value : firmDefault ? `firm:${firmDefault.name}` : BUILTIN

  const firm = templates.firm
  const ready: FormScheduleReady = useMemo(() => {
    const chosen = bound ? (equipment.find((e) => e.id === panelId) ?? null) : null
    const formKindNow: FormScheduleKind = chosen ? boundKindFor(chosen) : kind
    const firmNow = templateValue === BUILTIN ? null : (firm.find((t) => t.kind === formKindNow && `firm:${t.name}` === templateValue) ?? null)
    const suggestedName = uniqueScheduleName(model, formKindNow, chosen?.name ?? null)
    if (bound && equipment.length === 0) return { ok: false, reason: PLACE_PANEL_FIRST, suggestedName }
    if (bound && !chosen) return { ok: false, reason: 'Choose the panel or switchboard this schedule is for.', suggestedName }
    const base: FormScheduleDefinition = { kind: formKindNow, ...(chosen ? { elementId: chosen.id } : {}), template: firmNow?.template ?? builtinFormTemplate(formKindNow), ...(firmNow ? { templateSource: { name: firmNow.name, revision: firmNow.revision } } : {}) }
    const subject = chosen ? `${scheduleChoiceLabel(formKindNow).toLowerCase()} ${chosen.name}` : scheduleChoiceLabel(formKindNow).toLowerCase()
    return { ok: true, form: withRules(base, rule), suggestedName, subject }
  }, [model, kind, bound, equipment, panelId, templateValue, firm, rule])

  useEffect(() => onReady(ready), [ready, onReady])

  return (
    <>
      {bound && (
        <Field>
          <FieldLabel htmlFor="bm-schedule-panel">Panel</FieldLabel>
          <Select value={panelId} onValueChange={setPanelId} disabled={equipment.length === 0}>
            <SelectTrigger id="bm-schedule-panel" data-testid="schedule-panel-select">
              <SelectValue placeholder={equipment.length === 0 ? 'No panels yet' : 'Choose a panel or switchboard'} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {equipment.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.system}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {picked && formKind !== kind && <FieldDescription>{picked.name} is a {picked.kind}, so this is a switchboard schedule (its feeders as rows).</FieldDescription>}
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="bm-schedule-template">Template</FieldLabel>
        <Select value={templateValue} onValueChange={(value) => setTemplatePick({ kind: formKind, value })}>
          <SelectTrigger id="bm-schedule-template" data-testid="schedule-template-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {firmChoices.length > 0 && (
              <SelectGroup>
                <SelectLabel>Your firm</SelectLabel>
                {[...firmChoices]
                  .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
                  .map((t) => (
                    <SelectItem key={t.name} value={`firm:${t.name}`}>
                      {t.name}
                      {t.isDefault ? ' (firm default)' : ''}
                    </SelectItem>
                  ))}
              </SelectGroup>
            )}
            <SelectGroup>
              <SelectLabel>Built in</SelectLabel>
              <SelectItem value={BUILTIN}>{builtinFormTemplate(formKind).name}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {templates.status === 'loading' && <FieldDescription>Loading your firm&apos;s templates…</FieldDescription>}
      </Field>
      {templates.problem && (
        <Alert data-testid="schedule-templates-problem">
          <CircleAlert />
          <AlertTitle>Firm templates unavailable</AlertTitle>
          <AlertDescription>{templates.problem}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor="bm-schedule-rules">Demand figures</FieldLabel>
        <Select value={rule} onValueChange={(v) => setRule(RULE_CHOICES.find((r) => r.value === v)?.value ?? 'none')}>
          <SelectTrigger id="bm-schedule-rules" data-testid="schedule-rules-select">
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
        <FieldDescription data-testid="schedule-nec-label">This project: {nec.label}</FieldDescription>
      </Field>
    </>
  )
}

/** What the Electrical workflow lends the New schedule window (shared `newScheduleForms`). */
export function electricalFormSlot(kinds: readonly string[], lent: Lent): NewScheduleFormSlot {
  return {
    kinds,
    renderFields: (props) => <FormScheduleFields key={props.kind} {...props} {...lent} />,
    newSheet: (model: ModelState) => ({ number: nextScheduleSheetNumber(model), name: 'Electrical schedules' }),
  }
}
