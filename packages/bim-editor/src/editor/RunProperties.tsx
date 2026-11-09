'use client'

import { useMemo, useState } from 'react'
import { CopyPlus, Trash2 } from 'lucide-react'
import { systemRules, runLabel, sizeLabel, type Command, type ModelState, type RunFitting, type RunSegment, type RunSize } from '@permitzip/bim-kernel'
import { PipeHydraulicsEngine, pipeCarriesLine } from '@permitzip/bim-pack-plumbing'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item'
import { Separator } from '../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { MM_PER_IN, feetInches } from './placement'
import { RunPipeInsulation } from './plumbing/RunPipeInsulation'
import { RunMoveForm, RunTopHeightForm } from './RunMoveForm'
import { RunLoadPoints } from './plumbing/RunLoadPoints'
import { AddonComponent, useContributionsVersion } from './contributions/AddonComponent'
import { componentContributions } from './contributions/registry'
import { RUN_SECTION } from './contributions/slots'
import type { RunSectionProps } from './contributions/types'

interface Props {
  element: RunSegment | RunFitting
  model: ModelState
  canEdit: boolean
  onResize: (segmentId: string, size: RunSize) => string | null
  onDelete: (id: string) => void
  /** Any command (fitting type, coefficient); null when accepted, else the reason. */
  onCommand: (command: Command) => string | null
  actorName: string
  /** Route tool with this piece's size, insulation, system and height ("Route another like this"); absent when editing is off. */
  onRouteLike?: () => void
  /** For code lookups in the hydraulics (the project's Code Study). */
  projectId?: string
}

function connectedTo(model: ModelState, id: string | undefined): string {
  if (!id) return 'Open'
  const el = model.elements[id]
  if (!el) return 'Connected'
  if (el.kind === 'part') return `Connected to ${el.mark || 'a part'}`
  if (el.kind === 'run_segment' || el.kind === 'run_fitting') return `Connected to the ${runLabel(model.elements, el)}`
  return 'Connected'
}

/** Properties of a routed segment or fitting: what it is, its system, size, flow and what each end meets; resize and delete. */
export function RunProperties({ element: el, model, canEdit, onResize, onDelete, onCommand, actorName, onRouteLike, projectId }: Props) {
  const system = model.elements[el.systemId]
  const rules = system?.kind === 'mep_system' ? systemRules(system.systemKind) : null
  // "Carries 12 DFU · 18.4 gpm": the pipe report's own walk (load points and fixtures), so it agrees with the report.
  const hydraulics = useMemo(() => new PipeHydraulicsEngine(), [])
  const carries = el.kind === 'run_segment' ? pipeCarriesLine(hydraulics, model, el.id) : null
  const rows: [string, string][] = [['System', system?.kind === 'mep_system' ? system.name : el.systemId]]
  if (el.kind === 'run_segment') {
    const len = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z)
    const vertical = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 0.01
    rows.push(['Size', sizeLabel(el.size)], ['Length', feetInches(len)], [vertical ? 'From height' : 'Height', feetInches(el.start.z)])
    if (vertical) rows.push(['To height', feetInches(el.end.z)])
    rows.push(['Carries', carries ? carries.replace(/^Carries /, '') : rules?.flowUnit ? `${Math.round(el.flow * 100) / 100} ${rules.flowUnit}` : String(el.flow)])
    rows.push(['Start', connectedTo(model, el.links.start?.elementId)], ['End', connectedTo(model, el.links.end?.elementId)])
    if (el.branches.length > 0) rows.push(['Branches', String(el.branches.length)])
  } else {
    rows.push(['Height', feetInches(el.position.z)])
    for (const p of el.ports) rows.push([`${p.id === 'branch' ? 'Branch' : `Opening ${p.id}`} (${sizeLabel(p.size)})`, connectedTo(model, p.link?.elementId)])
    if (el.host) rows.push(['Along the trunk', feetInches(el.host.s)])
  }
  const sectionProps: RunSectionProps = { model, element: el, canEdit, actorName, onCommand, onResize, ...(projectId ? { projectId } : {}) }
  return (
    <div className="flex flex-col gap-3" data-testid="run-properties">
      <span className="text-sm font-medium">{runLabel(model.elements, el).replace(/^./, (c) => c.toUpperCase())}</span>
      {onRouteLike && el.domain !== 'conduit' && (
        <Button size="sm" variant="outline" onClick={onRouteLike} disabled={!canEdit} title={canEdit ? 'Same size, insulation, system and height (A)' : "Live editing isn't connected, so nothing can be routed"} data-testid="route-like">
          <CopyPlus data-icon="inline-start" />
          Route another like this
          <kbd className="ml-auto text-xs text-muted-foreground">A</kbd>
        </Button>
      )}
      <RunSections props={sectionProps} own={[]} leading />
      <ItemGroup className="gap-1">
        {rows.map(([k, v]) => (
          <Item key={k} size="sm">
            <ItemContent>
              <ItemDescription className="text-xs">{k}</ItemDescription>
              <ItemTitle className="text-xs font-normal">{v}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      <RunLoadPoints model={model} element={el} canEdit={canEdit} onCommand={onCommand} />
      {el.kind === 'run_fitting' && el.host && <FieldDescription>Drag it in the view to slide the branch along the trunk. The trunk stays one piece.</FieldDescription>}
      {el.kind === 'run_segment' && <RunResizeForm key={`${el.id}:${el.version}`} segment={el} canEdit={canEdit} onResize={onResize} />}
      {el.kind === 'run_segment' && Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 0.01 && <RunTopHeightForm key={`top:${el.id}:${el.version}`} element={el} canEdit={canEdit} onCommand={onCommand} />}
      {(el.kind === 'run_segment' ? Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) >= 0.01 : !el.host && el.ports.length === 2) && (
        <RunMoveForm key={`move:${el.id}:${el.version}`} element={el} canEdit={canEdit} onCommand={onCommand} />
      )}
      <RunSections props={sectionProps} own={[{ order: 30, node: <RunPipeInsulation key="insulation" element={el} model={model} canEdit={canEdit} onCommand={onCommand} /> }]} />
      <Separator />
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="outline" size="sm" className="w-full" disabled={!canEdit} onClick={() => onDelete(el.id)} data-testid="run-delete">
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canEdit ? 'Asks first, and says what happens to connected pieces' : "Live editing isn't connected, so changes can't be saved"}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** The run's own sections and every add-on's run sections (`run-section`), in one order: an add-on's arrive with `import()` and show a loading line, or the error and Retry. */
function RunSections({ props, own, leading = false }: { readonly props: RunSectionProps; readonly own: readonly { readonly order: number; readonly node: React.ReactNode }[]; readonly leading?: boolean }) {
  useContributionsVersion()
  // Leading sections (order below 0) sit above the piece's details; the rest after its own forms.
  const added = componentContributions(RUN_SECTION)
    .filter((c) => (c.order ?? 100) < 0 === leading)
    .map((c) => ({ order: c.order ?? 100, node: <AddonComponent key={c.id} contribution={c} props={props} /> }))
  return <>{[...own, ...added].sort((a, b) => a.order - b.order).map((s) => s.node)}</>
}

function inches(mm: number): string {
  return String(Math.round((mm / MM_PER_IN) * 100) / 100)
}

function RunResizeForm({ segment, canEdit, onResize }: { segment: RunSegment; canEdit: boolean; onResize: (segmentId: string, size: RunSize) => string | null }) {
  const size = segment.size
  const [a, setA] = useState(size.shape === 'rect' || size.shape === 'oval' ? inches(size.width) : size.shape === 'round' ? inches(size.diameter) : size.shape === 'pipe' ? inches(size.nominalMm) : inches(size.tradeSizeMm))
  const [b, setB] = useState(size.shape === 'rect' || size.shape === 'oval' ? inches(size.height) : '')
  const [error, setError] = useState<string | null>(null)
  const twoDims = size.shape === 'rect' || size.shape === 'oval'
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const x = Number(a)
    const y = Number(b)
    const mm = (v: number) => Math.round(v * MM_PER_IN * 1000) / 1000
    if (!(x > 0) || (twoDims && !(y > 0))) {
      setError(twoDims ? 'Enter a width and height in inches.' : 'Enter a size in inches.')
      return
    }
    const next: RunSize =
      size.shape === 'rect' || size.shape === 'oval'
        ? { shape: size.shape, width: mm(x), height: mm(y) }
        : size.shape === 'round'
          ? { shape: 'round', diameter: mm(x) }
          : size.shape === 'pipe'
            ? { shape: 'pipe', nominalMm: mm(x), material: size.material, ...(size.spec ? { spec: size.spec } : {}) }
            : { shape: 'conduit', tradeSizeMm: mm(x), conduitType: size.conduitType }
    setError(onResize(segment.id, next))
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="run-resize">
      <Separator />
      <FieldGroup className={twoDims ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-2'}>
        <Field>
          <FieldLabel htmlFor="bm-run-a">{twoDims ? 'Width (in)' : size.shape === 'round' ? 'Diameter (in)' : 'Size (in)'}</FieldLabel>
          <Input id="bm-run-a" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} disabled={!canEdit} />
        </Field>
        {twoDims && (
          <Field>
            <FieldLabel htmlFor="bm-run-b">Height (in)</FieldLabel>
            <Input id="bm-run-b" inputMode="decimal" value={b} onChange={(e) => setB(e.target.value)} disabled={!canEdit} />
          </Field>
        )}
      </FieldGroup>
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="run-resize-error">
          {error}
        </FieldDescription>
      )}
      <Button type="submit" size="sm" disabled={!canEdit} title={canEdit ? undefined : "Live editing isn't connected, so changes can't be saved"}>
        Resize this piece
      </Button>
      <FieldDescription>
        Only this piece changes. Where a neighbour keeps its size a {segment.domain === 'pipe' ? 'reducer' : 'transition'} goes in, and a size that doesn&apos;t fit is refused with the reason. To resize more, hover it and press Tab to select the stretch or run.
      </FieldDescription>
    </form>
  )
}
