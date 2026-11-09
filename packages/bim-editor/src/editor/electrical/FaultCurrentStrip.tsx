'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Save, Zap } from 'lucide-react'
import { AVAILABLE_FAULT_PARAM, faultCurrentAt, faultCurrentSummary, IMPEDANCE_PARAM, type ModelFaultNode, distributionOf, feederOf } from '@permitzip/bim-pack-electrical'
import { type ModelState } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import type { SubmitCommand } from '../views-sheets/types'

/** The verdict a panel header shows for its fault current: OK, below, or not known (and why). */
export function faultVerdict(node: ModelFaultNode | null): { readonly tone: 'ok' | 'fail' | 'unknown'; readonly label: string } {
  if (!node || node.availableA === null) return { tone: 'unknown', label: 'Fault current not known' }
  if (node.passes === false) return { tone: 'fail', label: 'Rating below available' }
  if (node.passes === null) return { tone: 'unknown', label: 'No rating stated' }
  return { tone: 'ok', label: 'AIC OK' }
}

/**
 * Available fault current and the interrupting-rating check for one panel,
 * in its panel view header: the number, the verdict, the point-to-point steps
 * on request, and where the source figure is entered (on service equipment
 * nothing feeds) or a transformer's %Z (on a transformer).
 */
export function FaultCurrentStrip({ model, panelId, canEdit, editBlocked, submit }: { readonly model: ModelState; readonly panelId: string; readonly canEdit: boolean; readonly editBlocked: string | null; readonly submit: SubmitCommand }) {
  const els = model.elements
  const node = useMemo(() => faultCurrentAt(els, panelId), [els, panelId])
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const part = els[panelId]
  const info = part?.kind === 'part' ? distributionOf(els, part) : null
  if (!node || !info || part?.kind !== 'part') return null
  const verdict = faultVerdict(node)
  const isSource = !feederOf(els, part)
  const isTransformer = info.kind === 'transformer'
  const param = isTransformer ? IMPEDANCE_PARAM : AVAILABLE_FAULT_PARAM
  const showEntry = isSource || isTransformer || node.entered
  const n = Number(value)
  const bad = value.trim() !== '' && (!Number.isFinite(n) || n <= 0 || (isTransformer && n > 20))
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (bad || value.trim() === '') return
    const refusal = submit({ type: 'set_parameters', id: panelId, scope: 'instance', values: { [param]: n } }, isTransformer ? `set ${info.name}'s impedance to ${n}%` : `set the available fault current at ${info.name} to ${n} A`)
    setError(refusal)
    if (!refusal) setValue('')
  }
  const Icon = verdict.tone === 'ok' ? CircleCheck : verdict.tone === 'fail' ? CircleAlert : CircleHelp
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="panel-view-fault-current">
      <div className="flex flex-wrap items-center gap-2">
        <Zap className="size-3.5 text-muted-foreground" aria-hidden />
        <span data-testid="panel-view-fault-summary">{faultCurrentSummary(node)}</span>
        <Badge variant={verdict.tone === 'fail' ? 'destructive' : 'outline'} className={verdict.tone === 'ok' ? 'text-success-700' : undefined} data-testid="panel-view-fault-verdict">
          <Icon data-icon="inline-start" />
          {verdict.label}
        </Badge>
        {node.trail.length > 0 && (
          <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="panel-view-fault-trail-toggle">
            {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
            How it is worked out
          </Button>
        )}
      </div>
      {open && (
        <ol className="ml-5 list-decimal text-muted-foreground" data-testid="panel-view-fault-trail">
          {node.trail.map((t) => (
            <li key={t}>{t}</li>
          ))}
          <li className="list-none">Point-to-point method (Eaton Bussmann). Motor contribution is not included; a full short-circuit study governs. Checked against NEC 110.9.</li>
        </ol>
      )}
      {showEntry && (
        <form className="flex items-end gap-2" onSubmit={save}>
          <Field className="w-60">
            <FieldLabel htmlFor={`bm-fault-${panelId}`} className="text-xs">
              {isTransformer ? `${info.name} impedance (%Z, from its nameplate)` : `Available fault current at ${info.name} (A, from the utility)`}
            </FieldLabel>
            <Input id={`bm-fault-${panelId}`} inputMode="decimal" placeholder={isTransformer ? '5.75' : '22000'} value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit} aria-invalid={bad} data-testid="panel-view-fault-input" />
            {bad && <FieldDescription className="text-danger-600">{isTransformer ? 'Impedance is a percent above 0 and at most 20.' : 'Amps, a number above 0.'}</FieldDescription>}
          </Field>
          <Button type="submit" size="sm" variant="outline" disabled={!canEdit || bad || value.trim() === ''} title={canEdit ? undefined : (editBlocked ?? undefined)} data-testid="panel-view-fault-save">
            <Save data-icon="inline-start" />
            Save
          </Button>
        </form>
      )}
      {error && (
        <span className="text-danger-600" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
