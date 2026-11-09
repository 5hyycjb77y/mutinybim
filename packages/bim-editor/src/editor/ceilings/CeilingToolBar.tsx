'use client'

import { X } from 'lucide-react'
import { Button } from '../../ui/button'
import { Field, FieldError, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../../ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { CEILING_TOOL_FORMS, formSlopes, type CeilingToolForm, type CeilingToolSettings, type ParsedCeilingSettings } from './ceiling-tool'

interface Props {
  readonly settings: CeilingToolSettings
  readonly parsed: ParsedCeilingSettings
  readonly onChange: (next: CeilingToolSettings) => void
  /** What the last click did, or why the model refused it. */
  readonly last: { readonly ok: boolean; readonly message: string } | null
  readonly onStop: () => void
}

function isForm(v: string): v is CeilingToolForm {
  return CEILING_TOOL_FORMS.some((f) => f.id === v)
}

/**
 * The Ceiling tool's bar on a ceiling plan: how to make it (draw an outline
 * or fill a space), its form, its height, and for a sloped or tilted one its
 * rise. Five controls at most; Stop (or Esc) leaves with nothing changed.
 */
export function CeilingToolBar({ settings, parsed, onChange, last, onStop }: Props) {
  const slopes = formSlopes(settings.form)
  const set = (patch: Partial<CeilingToolSettings>) => onChange({ ...settings, ...patch })
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-md" role="toolbar" aria-label="Ceiling tool" data-testid="ceiling-tool-bar">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel>Make it by</FieldLabel>
          <ToggleGroup type="single" variant="outline" size="sm" value={settings.how} onValueChange={(v) => (v === 'outline' || v === 'space') && set({ how: v })} aria-label="How to make the ceiling">
            <ToggleGroupItem value="outline">Draw outline</ToggleGroupItem>
            <ToggleGroupItem value="space">Fill a space</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="w-auto">
          <FieldLabel>Form</FieldLabel>
          <ToggleGroup type="single" variant="outline" size="sm" value={settings.form} onValueChange={(v) => isForm(v) && set({ form: v })} aria-label="Ceiling form">
            {CEILING_TOOL_FORMS.map((f) => (
              <ToggleGroupItem key={f.id} value={f.id}>
                {f.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field className="w-28">
          <FieldLabel htmlFor="bm-ceiling-height">{slopes ? 'Height at first corner' : 'Height above floor'}</FieldLabel>
          <Input id="bm-ceiling-height" inputMode="decimal" value={settings.height} onChange={(e) => set({ height: e.target.value })} aria-invalid={!parsed.ok} placeholder={`9'6"`} />
        </Field>
        {slopes ? (
          <Field className="w-52">
            <FieldLabel htmlFor="bm-ceiling-rise">Rises</FieldLabel>
            <InputGroup>
              <InputGroupInput id="bm-ceiling-rise" inputMode="decimal" value={settings.rise} onChange={(e) => set({ rise: e.target.value })} aria-label="Rise in inches per 12" />
              <InputGroupAddon align="inline-end">
                <InputGroupText>in 12 toward</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput inputMode="decimal" value={settings.towardDeg} onChange={(e) => set({ towardDeg: e.target.value })} aria-label="Direction it rises toward, degrees (0 east, 90 north)" className="w-12" />
              <InputGroupAddon align="inline-end">
                <InputGroupText>°</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        ) : null}
        <Button variant="outline" size="sm" onClick={onStop} data-testid="ceiling-tool-stop">
          <X data-icon="inline-start" />
          Stop
        </Button>
      </div>
      {!parsed.ok ? (
        <FieldError data-testid="ceiling-tool-error">{parsed.message}</FieldError>
      ) : last ? (
        <p role="status" className={last.ok ? 'text-xs text-muted-foreground' : 'text-xs text-danger-600'} data-testid="ceiling-tool-status">
          {last.message}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{settings.how === 'outline' ? 'Click corners on the plan; Enter closes the outline, Esc stops.' : 'Click a space on the plan to fill it; Esc stops.'}</p>
      )}
    </div>
  )
}
