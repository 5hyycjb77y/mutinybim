'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { builtinCalcRegistry } from '@permitzip/bim-calc'
import { hunterChart, type PipeSystemSizing } from '@permitzip/bim-pack-plumbing'
import type { Command, ModelState } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { HunterCurveChart } from './HunterCurveChart'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useProjectPlumbingCodesFrom } from './use-auto-size'

const registry = builtinCalcRegistry()
const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"
const SHOWN = 8

/** What a sizing rests on, for the undo label: "Sized 3 pipes on Storm from Tables 1106.2(1) and 1106.3". */
export function sizingBasis(sizing: PipeSystemSizing): string {
  if (sizing.service === 'water') return sizing.curve?.label ?? 'the demand curve'
  if (sizing.service === 'vent') return 'Table 906.1 and 906.2'
  if (sizing.service === 'storm') return 'Tables 1106.2(1) and 1106.3'
  return 'the DFU tables'
}

function summary(sizing: PipeSystemSizing): string {
  switch (sizing.service) {
    case 'water':
      return `${sizing.totalLoad} WSFU${sizing.designPoint ? `, ${sizing.designPoint.gpm} gpm on ${sizing.curve?.label}` : ''}. ${sizing.allowablePsiPer100Ft !== null ? `Friction within ${sizing.allowablePsiPer100Ft} psi/100 ft (${sizing.availablePsi} psi over ${sizing.developedLengthFt} ft + fittings), ` : ''}velocity within ${sizing.maxVelocityFps} ft/s.`
    case 'vent':
      return `${sizing.totalLoad} DFU vented${sizing.developedLengthFt !== null ? `, longest developed length ${sizing.developedLengthFt} ft` : ''}. Vent stacks by Table 906.1 on the stack they serve; other vents half the drain they vent, 1-1/4" least, a size up over 40 ft.`
    case 'storm':
      return sizing.rainfallInPerHr === undefined ? 'Storm pipe sizes on roof area at the design rainfall rate.' : `${sizing.totalLoad} sq ft of roof at ${sizing.rainfallInPerHr} in/h. Leaders by Table 1106.2(1), horizontal drains by Table 1106.3 at their fall, never smaller downstream.`
    default:
      return `${sizing.totalLoad} DFU at the outfall. Building drain by Table 710.1(1) at its fall, branches and stacks by Table 710.1(2), never smaller downstream.`
  }
}

/** Storm: the design rainfall rate the code library can't give (Figure 1106.1 is a map image), set on the system. */
function RainfallRate({ systemId, systemName, canEdit, onCommand }: { systemId: string; systemName: string; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const [rate, setRate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const value = Number(rate)
  const valid = rate.trim() !== '' && Number.isFinite(value) && value > 0 && value <= 20
  const save = () => {
    if (!valid) return
    const why = onCommand({ type: 'set_system_design', systemId, design: { pipe: { rainfallInPerHr: value } } })
    setError(why)
    if (!why) toast.success(`${systemName} sizes at ${value} in/h. Undo puts it back.`)
  }
  return (
    <Field data-testid="pipe-sizing-rainfall">
      <FieldLabel htmlFor={`bm-rainfall-${systemId}`}>Design rainfall (in/h)</FieldLabel>
      <div className="flex gap-2">
        <Input id={`bm-rainfall-${systemId}`} inputMode="decimal" placeholder="3.2" className="h-8 w-24" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!canEdit} data-testid="pipe-sizing-rainfall-input" />
        <Button type="button" size="sm" onClick={save} disabled={!canEdit || !valid} title={!canEdit ? NOT_LIVE : !valid ? 'Type the 100-year, 1-hour rate in inches per hour (0 to 20)' : undefined} data-testid="pipe-sizing-rainfall-save">
          Save rate
        </Button>
      </div>
      <FieldDescription>The 100-year, 1-hour rate for the site from approved local weather data (VPC 1106.1). It is saved on {systemName}.</FieldDescription>
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </Field>
  )
}

interface Props {
  systemId: string
  model: ModelState
  projectId?: string
  canEdit: boolean
  onCommand: (command: Command) => string | null
}

/**
 * Water, sanitary, vent or storm sizing for the selected pipe's system: what each pipe
 * carries, the size the plumbing code needs against the size drawn, what's
 * undersized, and one "Size pipes" (one undo). With auto-sizing on for the
 * system, sizes already follow as you model; this shows what they rest on.
 */
export function PipeSizing({ systemId, model, projectId, canEdit, onCommand }: Props) {
  const code = useProjectPlumbingCodesFrom(useEditorHost().data.codeAdoption, projectId)
  const [picked, setPicked] = useState<'2021' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const result = useMemo(() => {
    if (code.loading) return null
    return registry.run({ calc: 'plumbing.size_system', inputs: { system_id: systemId }, model, ...(picked ? { plumbingEdition: picked } : {}), projectAdoptions: { plumbing: code.plumbing } })
  }, [systemId, model, picked, code.plumbing, code.loading])
  const chart = useMemo(() => hunterChart(model), [model])
  if (code.loading || !result) return <FieldDescription data-testid="pipe-sizing-loading">Reading the project&apos;s plumbing code…</FieldDescription>
  if (!result.ok) {
    return (
      <div className="flex flex-col gap-2" data-testid="pipe-sizing">
        <span className="text-sm font-medium">Pipe sizing</span>
        {!code.plumbing && !picked ? (
          <Field>
            <FieldLabel htmlFor="bm-plumbing-code">Plumbing code</FieldLabel>
            <Select value={picked ?? undefined} onValueChange={(v) => setPicked(v === '2021' ? '2021' : null)}>
              <SelectTrigger id="bm-plumbing-code" data-testid="pipe-sizing-code-pick">
                <SelectValue placeholder="Pick the edition" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="2021">2021 (IPC; VPC in Virginia)</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{code.problem ?? 'The Code Study names no plumbing code. Record it there to size (and auto-size) without asking; this pick is for this panel only.'}</FieldDescription>
          </Field>
        ) : (
          <FieldDescription role="status">{result.reason}</FieldDescription>
        )}
      </div>
    )
  }
  const sizing = result.run.detail as PipeSystemSizing | null
  if (!sizing) return <FieldDescription role="status">{result.run.issues.map((i) => i.message).join(' ')}</FieldDescription>
  const up = sizing.proposals.filter((p) => p.change === 'up')
  const down = sizing.proposals.filter((p) => p.change === 'down')
  const problems = sizing.findings.filter((f) => f.code !== 'undersized_pipe' && f.code !== 'oversized_pipe' && f.code !== 'walk' && f.severity !== 'info')
  const auto = sizing.sizingMode === 'auto'
  const needsRainfall = sizing.findings.some((f) => f.code === 'no_rainfall_rate')
  const apply = (which: 'up' | 'all') => {
    const changes = which === 'up' ? up : [...up, ...down]
    const basis = sizingBasis(sizing)
    const why = onCommand({ type: 'set_pipe_sizes', idPrefix: `size-${sizing.systemId}-r${model.revision}`, systemId: sizing.systemId, label: `Sized ${changes.length} pipe${changes.length === 1 ? '' : 's'} on ${sizing.systemName} from ${basis}`.slice(0, 160), sizes: changes.map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn })) })
    setError(why)
    if (!why) toast.success(`Sized ${changes.length} pipe${changes.length === 1 ? '' : 's'} on ${sizing.systemName}. Undo puts them back.`)
  }
  const blocked = !canEdit ? NOT_LIVE : undefined
  return (
    <div className="flex flex-col gap-2" data-testid="pipe-sizing">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Pipe sizing</span>
        <Badge variant={auto ? 'default' : 'secondary'} data-testid="pipe-sizing-mode" title={sizing.sizingModeFrom === 'system' ? "This system's own setting (Plumbing › Systems)" : 'The project setting (Plumbing › Analyze › Auto-size)'}>
          {auto ? 'Auto-size on' : 'Check only'}
        </Badge>
      </div>
      <FieldDescription className="text-xs">
        {summary(sizing)}{' '}
        {auto ? 'Sizes follow as you model; each resize is its own undo.' : 'Nothing changes until you size.'}
      </FieldDescription>
      {sizing.service === 'water' && sizing.curve && <HunterCurveChart chart={chart} only={[sizing.curve.id]} className="h-[180px] w-full" />}
      {needsRainfall && <RainfallRate systemId={sizing.systemId} systemName={sizing.systemName} canEdit={canEdit} onCommand={onCommand} />}
      {needsRainfall ? null : up.length > 0 ? (
        <ItemGroup className="gap-1" data-testid="pipe-sizing-undersized">
          {up.slice(0, SHOWN).map((p) => (
            <Item key={p.segmentId} size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">
                  {p.label}: {p.carries}
                </ItemDescription>
                <ItemTitle className="text-xs font-normal">
                  {p.current}&quot; → {p.proposed}&quot; ({p.governs})
                </ItemTitle>
              </ItemContent>
            </Item>
          ))}
          {up.length > SHOWN && <FieldDescription>{up.length - SHOWN} more pipes need a larger size.</FieldDescription>}
        </ItemGroup>
      ) : (
        <Badge variant="secondary" className="w-fit" data-testid="pipe-sized-ok">
          Every pipe is large enough
        </Badge>
      )}
      {down.length > 0 && <FieldDescription className="text-xs">{down.length} pipe{down.length === 1 ? ' is' : 's are'} larger than needed.</FieldDescription>}
      {problems.map((f) => (
        <FieldDescription key={`${f.code}:${f.elementId ?? ''}:${f.message}`} className={f.severity === 'error' ? 'text-danger-600' : 'text-warning-700'} role={f.severity === 'error' ? 'alert' : 'status'} data-testid="pipe-sizing-finding">
          {f.message}
        </FieldDescription>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => apply('up')} disabled={blocked !== undefined || up.length === 0} title={blocked ?? (up.length === 0 ? 'Every pipe already carries its load' : undefined)} data-testid="pipe-size-pipes">
          {up.length > 0 ? `Size ${up.length} pipe${up.length === 1 ? '' : 's'}` : 'Size pipes'}
        </Button>
        {down.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={() => apply('all')} disabled={blocked !== undefined} title={blocked} data-testid="pipe-size-pipes-all">
            Also reduce {down.length}
          </Button>
        )}
      </div>
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="pipe-sizing-error">
          {error}
        </FieldDescription>
      )}
    </div>
  )
}
