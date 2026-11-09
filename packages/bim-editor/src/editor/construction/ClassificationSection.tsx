'use client'

import { useState } from 'react'
import { classificationSystems, classificationTypeOf, isCoreElement, readCode, storedClassification, type BimElement, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly model: ModelState
  readonly elementId: string
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
}

function classifiable(el: BimElement): boolean {
  return isCoreElement(el) || el.kind === 'ceiling' || el.kind === 'element_type'
}

function codeIn(el: BimElement | null, system: string): string {
  return el ? (storedClassification(el).find((c) => c.system === system)?.code ?? '') : ''
}

interface CodeRowProps {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly targetId: string
  readonly targetName: string
  readonly system: string
  readonly current: string
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly save: (targetId: string, targetName: string, code: string) => void
}

function CodeRow({ id, label, hint, targetId, targetName, system, current, canEdit, blockedReason, save }: CodeRowProps) {
  const warning = current ? readCode(system, current).warning : null
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        key={`${targetId}:${system}:${current}`}
        id={id}
        defaultValue={current}
        placeholder="No code"
        maxLength={64}
        disabled={!canEdit}
        title={canEdit ? undefined : blockedReason}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = current
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const next = e.target.value.trim()
          if (next !== current) save(targetId, targetName, next)
        }}
        data-testid={`${id}-input`}
      />
      <FieldDescription>{hint}</FieldDescription>
      {warning && (
        <FieldDescription className="text-warning-700" data-testid={`${id}-warning`}>
          {warning}
        </FieldDescription>
      )}
    </Field>
  )
}

/**
 * Inspector › Classification: the cost code of the selected element's type
 * (every element of the type takes it) and of this element alone (wins over
 * the type's). Codes are kept exactly as typed; a code the loaded list
 * doesn't know is named, not dropped. Quantities group by these codes in the
 * takeoff schedule.
 */
export function ClassificationSection({ model, elementId, canEdit, blockedReason, submit }: Props) {
  const systems = classificationSystems()
  const [system, setSystem] = useState(systems[0]?.id ?? 'firm:cost_codes')
  const [error, setError] = useState<string | null>(null)
  const el = model.elements[elementId]
  if (!el || !classifiable(el)) return null
  const type = el.kind === 'element_type' ? null : classificationTypeOf(model.elements, el)
  const systemLabel = systems.find((s) => s.id === system)?.label ?? system
  const typeCode = codeIn(type, system)
  const ownCode = codeIn(el, system)
  const save = (targetId: string, targetName: string, code: string) => {
    const refusal = code
      ? submit({ type: 'set_classification', elementIds: [targetId], system, code }, `set ${targetName}'s code to ${code}`)
      : submit({ type: 'clear_classification', elementIds: [targetId], system }, `clear ${targetName}'s code`)
    setError(refusal)
  }
  const ownHint = ownCode ? `Only this element. It wins over its type's code.` : typeCode ? `Uses its type's code, ${typeCode}. Type a code here to give this element its own.` : 'Only this element. Leave empty to use its type’s code.'
  return (
    <FieldSet data-testid="inspector-classification">
      <FieldLegend variant="label">Classification</FieldLegend>
      <FieldGroup className="gap-3">
        {systems.length > 1 && (
          <Field>
            <FieldLabel htmlFor="classification-system">Code list</FieldLabel>
            <Select value={system} onValueChange={setSystem}>
              <SelectTrigger id="classification-system" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {systems.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
        {type && (
          <CodeRow
            id="classification-type"
            label={`Type: ${type.name} (${systemLabel})`}
            hint="Every element of this type takes this code."
            targetId={type.id}
            targetName={type.name}
            system={system}
            current={typeCode}
            canEdit={canEdit}
            blockedReason={blockedReason}
            save={save}
          />
        )}
        <CodeRow
          id="classification-own"
          label={el.kind === 'element_type' ? `This type (${systemLabel})` : `This element (${systemLabel})`}
          hint={el.kind === 'element_type' ? 'Every element of this type takes this code.' : ownHint}
          targetId={el.id}
          targetName={el.kind === 'element_type' ? el.name : `this ${el.kind.replace(/_/g, ' ')}`}
          system={system}
          current={ownCode}
          canEdit={canEdit}
          blockedReason={blockedReason}
          save={save}
        />
        {!canEdit && <FieldDescription>{blockedReason}</FieldDescription>}
        {error && (
          <Alert variant="destructive" data-testid="classification-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </FieldSet>
  )
}
