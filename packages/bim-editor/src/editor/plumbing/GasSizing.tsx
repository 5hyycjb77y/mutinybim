'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { builtinCalcRegistry, type ProjectCodeAdoption } from '@permitzip/bim-calc'
import { fuelGasAdoptionFrom, type GasSystemSizing, IN_WC_PER_PSI, REGULATOR_PARAMS, regulatorSettings } from '@permitzip/bim-pack-plumbing'
import { type Command, type ModelState, type RunFitting } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

const registry = builtinCalcRegistry()
const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"
const SHOWN = 8

/** The project's fuel gas code from its Code Study (filed under any discipline), or why it couldn't be read. */
type CodeAdoptionPort = EditorDataHost['codeAdoption']

export function useFuelGasCodeFrom(port: CodeAdoptionPort, projectId: string | undefined): { adoption: ProjectCodeAdoption | null; problem: string | null; loading: boolean } {
  const [state, setState] = useState<{ adoption: ProjectCodeAdoption | null; problem: string | null; loading: boolean }>({ adoption: null, problem: null, loading: projectId !== undefined })
  useEffect(() => {
    if (!projectId || !port) return
    let cancelled = false
    port
      .read({ projectId })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) throw new Error("you can't read this project's Code Study")
        if (!res.ok) throw new Error(`Code Study answered HTTP ${res.status}`)
        const body: unknown = await res.json()
        const rows = typeof body === 'object' && body !== null && 'adopted_codes' in body && Array.isArray(body.adopted_codes) ? body.adopted_codes : []
        const typed = rows.flatMap((r: unknown) => {
          if (typeof r !== 'object' || r === null) return []
          const o = r as Record<string, unknown>
          return typeof o.code_name === 'string' && typeof o.edition === 'string' && typeof o.status === 'string' ? [{ code_name: o.code_name, edition: o.edition, status: o.status }] : []
        })
        if (!cancelled) setState({ adoption: fuelGasAdoptionFrom(typed), problem: null, loading: false })
      })
      .catch((err: unknown) => {
        console.error('[useFuelGasCode] reading the project Code Study failed', { projectId, err })
        if (!cancelled) setState({ adoption: null, problem: `The fuel gas code couldn't be read from the Code Study (${err instanceof Error ? err.message : String(err)}). Pick it here.`, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [port, projectId])
  if (projectId && !port) return { adoption: null, problem: `${unavailableWords("The project's Code Study")} Pick the fuel gas code here.`, loading: false }
  return state
}

interface Props {
  port: CodeAdoptionPort
  systemId: string
  model: ModelState
  projectId?: string
  canEdit: boolean
  onCommand: (command: Command) => string | null
}

/**
 * Gas sizing for the selected pipe's system: each regulator's pressure zone,
 * the size every pipe needs by the fuel gas code's tables, what is
 * undersized, the total input, and one "Size pipes" that applies it (one
 * undo). Nothing changes until the person sizes: the setting is check.
 */
export function GasSizingFrom({ port, systemId, model, projectId, canEdit, onCommand }: Props) {
  const code = useFuelGasCodeFrom(port, projectId)
  const [picked, setPicked] = useState<'2021' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const result = useMemo(() => {
    if (code.loading) return null
    return registry.run({ calc: 'plumbing.gas_system', inputs: { system_id: systemId }, model, ...(picked ? { fuelGasEdition: picked } : {}), projectAdoptions: { fuel_gas: code.adoption } })
  }, [systemId, model, picked, code.adoption, code.loading])
  if (code.loading || !result) return <FieldDescription data-testid="gas-sizing-loading">Reading the project&apos;s fuel gas code…</FieldDescription>
  const editionPicker = (
    <Field>
      <FieldLabel htmlFor="bm-gas-code">Fuel gas code</FieldLabel>
      <Select value={picked ?? undefined} onValueChange={(v) => setPicked(v === '2021' ? '2021' : null)}>
        <SelectTrigger id="bm-gas-code" data-testid="gas-code-pick">
          <SelectValue placeholder="Pick the edition" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="2021">2021 (IFGC; VFGC in Virginia)</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>{code.problem ?? 'The Code Study names no fuel gas code. Record it there to make this automatic; this pick is for this tab only.'}</FieldDescription>
    </Field>
  )
  if (!result.ok) {
    return (
      <div className="flex flex-col gap-2" data-testid="gas-sizing">
        <span className="text-sm font-medium">Gas sizing</span>
        {!code.adoption && !picked ? editionPicker : <FieldDescription role="status">{result.reason}</FieldDescription>}
      </div>
    )
  }
  const sizing = result.run.detail as GasSystemSizing | null
  if (!sizing) {
    return (
      <div className="flex flex-col gap-2" data-testid="gas-sizing">
        <span className="text-sm font-medium">Gas sizing</span>
        <FieldDescription role="status">{result.run.issues.map((i) => i.message).join(' ')}</FieldDescription>
      </div>
    )
  }
  const changes = sizing.proposals.filter((p) => p.change === 'up')
  const errors = sizing.findings.filter((f) => f.severity === 'error' && f.code !== 'undersized_gas_pipe')
  const tables = [...new Set(sizing.zones.map((z) => z.table).filter((t): t is string => t !== null))]
  const size = () => {
    const why = onCommand({ type: 'set_pipe_sizes', idPrefix: `size-${Date.now().toString(36)}`, systemId: sizing.systemId, label: `Sized ${changes.length} pipe${changes.length === 1 ? '' : 's'} on ${sizing.systemName} from ${tables.join(', ') || 'the 402.4 equation'}`.slice(0, 160), sizes: changes.map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn })) })
    setError(why)
    if (!why) toast.success(`Sized ${changes.length} pipe${changes.length === 1 ? '' : 's'} on ${sizing.systemName}. Undo puts them back.`)
  }
  const disabledWhy = !canEdit ? NOT_LIVE : changes.length === 0 ? 'Every pipe already carries its load at its zone pressure' : undefined
  return (
    <div className="flex flex-col gap-2" data-testid="gas-sizing">
      <span className="text-sm font-medium">Gas sizing</span>
      <FieldDescription className="text-xs">
        {sizing.gas === 'propane' ? 'Undiluted propane' : 'Natural gas'}, {sizing.method === 'branch_length' ? 'branch length' : 'longest length'} method, {tables.join(', ') || '402.4 equation'}. {code.adoption ? `Code Study: ${code.adoption.codeName}.` : 'Edition picked here.'} Total input {Math.round(sizing.totalMbh * 1000).toLocaleString()} Btu/h.
      </FieldDescription>
      <ItemGroup className="gap-1" data-testid="gas-zones">
        {sizing.zones.map((z) => (
          <Item key={z.id} size="sm" data-testid="gas-zone">
            <ItemContent>
              <ItemTitle className="text-xs">{z.label}</ItemTitle>
              <ItemDescription className="text-xs">
                {z.allowableDrop} drop, {z.totalMbh} MBH, longest {z.longestFt} ft
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      {changes.length > 0 ? (
        <ItemGroup className="gap-1" data-testid="gas-undersized">
          {changes.slice(0, SHOWN).map((p) => (
            <Item key={p.segmentId} size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">{p.label}</ItemDescription>
                <ItemTitle className="text-xs font-normal">
                  {p.current}&quot; → {p.proposed}&quot;
                </ItemTitle>
              </ItemContent>
            </Item>
          ))}
          {changes.length > SHOWN && <FieldDescription>{changes.length - SHOWN} more pipes need a larger size.</FieldDescription>}
        </ItemGroup>
      ) : (
        <Badge variant="secondary" className="w-fit" data-testid="gas-sized-ok">
          Every pipe is large enough
        </Badge>
      )}
      {errors.map((f) => (
        <FieldDescription key={`${f.code}:${f.elementId ?? ''}`} className="text-danger-600" role="alert" data-testid="gas-sizing-finding">
          {f.message}
        </FieldDescription>
      ))}
      <Button type="button" size="sm" onClick={size} disabled={disabledWhy !== undefined} title={disabledWhy} data-testid="gas-size-pipes">
        {changes.length > 0 ? `Size ${changes.length} pipe${changes.length === 1 ? '' : 's'}` : 'Size pipes'}
      </Button>
      <FieldDescription className="text-xs">Checks only until you size; one undo puts every pipe back. Reducers go where sizes change.</FieldDescription>
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="gas-sizing-error">
          {error}
        </FieldDescription>
      )}
    </div>
  )
}

const ROLE_LABEL: Readonly<Record<string, string>> = { line: 'Line regulator', service: 'Service regulator', appliance: 'Appliance regulator' }
const VENT_LABEL: Readonly<Record<string, string>> = { vent_limiter: 'Vent limiter', vent_to_outdoors: 'Vent to outdoors', none: 'None (outdoors)' }

/** A gas pressure regulator's settings: what kind, the pressure it holds downstream, the drop that zone may lose, its vent. */
export function RegulatorSettings({ fitting, model, canEdit, onCommand }: { fitting: RunFitting; model: ModelState; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const s = regulatorSettings(model.elements, fitting)
  const [unit, setUnit] = useState<'in_wc' | 'psi'>(s && s.outletInWc >= IN_WC_PER_PSI ? 'psi' : 'in_wc')
  const show = (inWc: number) => String(Math.round((unit === 'psi' ? inWc / IN_WC_PER_PSI : inWc) * 100) / 100)
  const [role, setRole] = useState(s?.role ?? 'line')
  const [vent, setVent] = useState(s?.vent ?? 'vent_limiter')
  const [outlet, setOutlet] = useState(s ? show(s.outletInWc) : '')
  const [drop, setDrop] = useState(s ? show(s.zoneDropInWc) : '')
  const [error, setError] = useState<string | null>(null)
  if (!s) return null
  const switchUnit = (next: string) => {
    if (next !== 'psi' && next !== 'in_wc') return
    const toWc = (v: string) => (unit === 'psi' ? Number(v) * IN_WC_PER_PSI : Number(v))
    const fromWc = (v: number) => String(Math.round((next === 'psi' ? v / IN_WC_PER_PSI : v) * 100) / 100)
    if (Number.isFinite(Number(outlet))) setOutlet(fromWc(toWc(outlet)))
    if (Number.isFinite(Number(drop))) setDrop(fromWc(toWc(drop)))
    setUnit(next)
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const factor = unit === 'psi' ? IN_WC_PER_PSI : 1
    const o = Number(outlet) * factor
    const d = Number(drop) * factor
    if (!(o > 0) || !(d > 0)) {
      setError('Enter the outlet pressure and the allowable drop downstream.')
      return
    }
    setError(onCommand({ type: 'swap_fitting', fittingId: fitting.id, family: 'pipe.gas.regulator', params: { role, vent, outlet_in_wc: Math.round(o * 1000) / 1000, zone_drop_in_wc: Math.round(d * 1000) / 1000 } }))
  }
  const roleOptions = REGULATOR_PARAMS.find((p) => p.key === 'role')
  const ventOptions = REGULATOR_PARAMS.find((p) => p.key === 'vent')
  return (
    <form onSubmit={save} className="flex flex-col gap-2" data-testid="gas-regulator">
      <span className="text-sm font-medium">Regulator</span>
      <Field>
        <FieldLabel htmlFor="bm-reg-role">Kind</FieldLabel>
        <Select value={role} onValueChange={(v) => setRole(v === 'service' || v === 'appliance' ? v : 'line')} disabled={!canEdit}>
          <SelectTrigger id="bm-reg-role" title={canEdit ? undefined : NOT_LIVE}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(roleOptions?.kind === 'choice' ? roleOptions.options : ['line']).map((o) => (
                <SelectItem key={o} value={o}>
                  {ROLE_LABEL[o] ?? o}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <ToggleGroup type="single" value={unit} onValueChange={switchUnit} variant="outline" size="sm" aria-label="Pressure unit">
        <ToggleGroupItem value="in_wc">in. w.c.</ToggleGroupItem>
        <ToggleGroupItem value="psi">psi</ToggleGroupItem>
      </ToggleGroup>
      <Field>
        <FieldLabel htmlFor="bm-reg-outlet">Outlet pressure ({unit === 'psi' ? 'psi' : 'in. w.c.'})</FieldLabel>
        <Input id="bm-reg-outlet" inputMode="decimal" value={outlet} onChange={(e) => setOutlet(e.target.value)} disabled={!canEdit} data-testid="gas-regulator-outlet" />
      </Field>
      <Field>
        <FieldLabel htmlFor="bm-reg-drop">Allowable drop downstream ({unit === 'psi' ? 'psi' : 'in. w.c.'})</FieldLabel>
        <Input id="bm-reg-drop" inputMode="decimal" value={drop} onChange={(e) => setDrop(e.target.value)} disabled={!canEdit} data-testid="gas-regulator-drop" />
        <FieldDescription>Everything downstream is a new pressure zone, sized at this pressure and drop.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="bm-reg-vent">Vent</FieldLabel>
        <Select value={vent} onValueChange={setVent} disabled={!canEdit}>
          <SelectTrigger id="bm-reg-vent" title={canEdit ? undefined : NOT_LIVE}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(ventOptions?.kind === 'choice' ? ventOptions.options : ['vent_limiter']).map((o) => (
                <SelectItem key={o} value={o}>
                  {VENT_LABEL[o] ?? o}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Button type="submit" size="sm" variant="outline" disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE} data-testid="gas-regulator-save">
        Save regulator
      </Button>
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </form>
  )
}
