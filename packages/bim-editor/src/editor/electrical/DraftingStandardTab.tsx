'use client'

import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { DRAFTING_STANDARD_NAME, TYP_LABEL_PRESETS, typLabelFrom, typLabelTemplateOf, typLabelTemplateProblem, type DraftingStandardEntry } from '@permitzip/bim-pack-electrical'
import { catalogEntryOf, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group'
import type { SubmitCommand } from '../views-sheets/types'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { loadFirmTypLabelFrom, type FirmTypLabel } from './firm-typ-label'

type Choice = { readonly kind: 'preset'; readonly presetId: string } | { readonly kind: 'firm' } | { readonly kind: 'project' }
type FirmState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly firm: FirmTypLabel | null } | { readonly status: 'error'; readonly message: string }

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
}

function choiceOf(entry: DraftingStandardEntry | null): Choice {
  if (!entry) return { kind: 'preset', presetId: TYP_LABEL_PRESETS[0].id }
  return entry.source.kind === 'preset' ? { kind: 'preset', presetId: entry.source.presetId } : { kind: entry.source.kind }
}

const keyOf = (c: Choice) => (c.kind === 'preset' ? `preset:${c.presetId}` : c.kind)

/** Electrical › Electrical types › Drafting: how a typical's repeated home run is labelled on this project's plans. */
export function DraftingStandardTab({ model, canEdit, editBlocked, submit }: Props) {
  const stored = catalogEntryOf(model.elements, 'electrical_drafting', DRAFTING_STANDARD_NAME) ?? null
  const [choice, setChoice] = useState<Choice>(() => choiceOf(stored))
  const [custom, setCustom] = useState(stored?.source.kind === 'project' ? stored.typLabelTemplate : '{circuit} ({count}) TYP.')
  const [firm, setFirm] = useState<FirmState>({ status: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const library = useEditorHost().data.firmLibrary

  useEffect(() => {
    let live = true
    loadFirmTypLabelFrom(library)
      .then((f) => live && setFirm({ status: 'ready', firm: f }))
      .catch((err: unknown) => {
        console.error('[DraftingStandardTab] firm standard failed to load', err)
        if (live) setFirm({ status: 'error', message: err instanceof Error ? err.message : 'the firm library did not answer' })
      })
    return () => {
      live = false
    }
  }, [library])

  const firmTemplate = firm.status === 'ready' ? firm.firm : null
  const template = choice.kind === 'preset' ? (TYP_LABEL_PRESETS.find((p) => p.id === choice.presetId)?.template ?? TYP_LABEL_PRESETS[0].template) : choice.kind === 'firm' ? (firmTemplate?.template ?? '') : custom
  const problem = choice.kind === 'firm' && !firmTemplate ? 'The firm has no typical-label standard to use.' : typLabelTemplateProblem(template)
  const inUse = typLabelTemplateOf(model)

  const save = () => {
    if (problem) return setError(problem)
    const source: DraftingStandardEntry['source'] =
      choice.kind === 'preset' ? { kind: 'preset', presetId: choice.presetId } : choice.kind === 'firm' && firmTemplate ? { kind: 'firm', itemId: firmTemplate.itemId, revision: firmTemplate.revision } : { kind: 'project' }
    const entry: DraftingStandardEntry = { type: 'electrical_drafting', name: DRAFTING_STANDARD_NAME, typLabelTemplate: template.trim(), source }
    setError(submit({ type: 'save_catalog_entry', entry }, `typical label "${template.trim()}"`))
  }

  return (
    <FieldGroup className="pt-3" data-testid="electrical-drafting-tab">
      <Field>
        <FieldLabel>Label for a typical’s repeated home run</FieldLabel>
        <FieldDescription>
          When units fed from one shared panel are drawn on all copies, the first copy’s home run carries this label and the others draw the arrow only. Now in use: “{typLabelFrom(inUse, 'P2-1', 3)}”.
        </FieldDescription>
        <RadioGroup value={keyOf(choice)} onValueChange={(v) => setChoice(v === 'firm' ? { kind: 'firm' } : v === 'project' ? { kind: 'project' } : { kind: 'preset', presetId: v.slice('preset:'.length) })} disabled={!canEdit}>
          {TYP_LABEL_PRESETS.map((p) => (
            <Field orientation="horizontal" key={p.id}>
              <RadioGroupItem value={`preset:${p.id}`} id={`typ-${p.id}`} data-testid={`typ-preset-${p.id}`} />
              <FieldLabel htmlFor={`typ-${p.id}`} className="font-normal">{p.label}</FieldLabel>
            </Field>
          ))}
          <Field orientation="horizontal">
            <RadioGroupItem value="firm" id="typ-firm" disabled={!firmTemplate} data-testid="typ-firm" />
            <FieldLabel htmlFor="typ-firm" className="font-normal">
              {firm.status === 'loading'
                ? 'The firm’s standard (loading…)'
                : firm.status === 'error'
                  ? `The firm’s standard (couldn’t load it: ${firm.message})`
                  : firmTemplate
                    ? `The firm’s standard (${typLabelFrom(firmTemplate.template, 'P2-1', 3)})`
                    : 'The firm’s standard (none published: add a tag type “electrical.typ_label” in Library)'}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="project" id="typ-project" data-testid="typ-project" />
            <FieldLabel htmlFor="typ-project" className="font-normal">This project’s own</FieldLabel>
          </Field>
        </RadioGroup>
      </Field>
      {choice.kind === 'project' && (
        <Field>
          <FieldLabel htmlFor="typ-custom">Label</FieldLabel>
          <Input id="typ-custom" value={custom} onChange={(e) => setCustom(e.target.value)} disabled={!canEdit} data-testid="typ-custom" />
          <FieldDescription>Use {'{circuit}'} for the home run’s tag and {'{count}'} for how many units carry it.</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldDescription data-testid="typ-preview">{problem ?? `Plans will read: “${typLabelFrom(template, 'P2-1', 3)}”.`}</FieldDescription>
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button onClick={save} disabled={!canEdit || problem !== null} title={!canEdit ? (editBlocked ?? undefined) : (problem ?? undefined)} data-testid="typ-save">
          <Save /> Save for this project
        </Button>
      </div>
    </FieldGroup>
  )
}
