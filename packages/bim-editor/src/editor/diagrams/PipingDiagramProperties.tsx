'use client'

import { useMemo, useState } from 'react'
import { EyeOff, RotateCcw } from 'lucide-react'
import { DIAGRAM_KIND_LABELS, diagramNodes, evaluateDiagram, resolveField, type ModelState, type PipeLabel, type ViewElement } from '@permitzip/bim-kernel'
import { defaultPipeLabels, plumbingDiagramGraph } from '@permitzip/bim-pack-plumbing'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Switch } from '../../ui/switch'
import type { SubmitCommand } from '../views-sheets/types'
import { hintsCommand, PIPE_LABEL_CHOICES, PIPING_SYSTEM_PRESETS, pipingPresetOf, type PipingSystemPreset, movedCount } from './diagram-commands'

interface Props {
  readonly model: ModelState
  readonly view: ViewElement
  readonly selectedIds: readonly string[]
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
}

/**
 * A plumbing riser's or isometric's own properties: what it draws now, which
 * systems (the sanitary riser, the water riser, the gas riser, or all), what
 * each pipe prints, and fixtures left off. Each change is one undoable hint
 * edit; the drawing always comes from the model.
 */
export function PipingDiagramProperties({ model, view, selectedIds, canEdit, blockedReason, submit }: Props) {
  const [error, setError] = useState<string | null>(null)
  const def = view.props?.diagram
  const evaluation = useMemo(() => evaluateDiagram(model.elements, view), [model.elements, view])
  const graph = useMemo(() => (def ? plumbingDiagramGraph(model.elements, def.hints) : null), [model.elements, def])
  if (!def || !evaluation || !graph) return null
  const hints = def.hints ?? {}
  const nodes = diagramNodes(graph)
  const fixtures = nodes.filter((n) => n.role === 'terminal' && n.name !== 'OPEN END' && n.name !== 'CAP').length
  const systems = new Set(nodes.map((n) => n.service)).size
  const set = (patch: Parameters<typeof hintsCommand>[1], label: string) => {
    const command = hintsCommand(view, patch)
    setError(command ? submit(command, label) : null)
  }
  const preset = pipingPresetOf(view)
  // What the pipes print now: the view's own choice, else every drawn system's defaults together.
  const shown = new Set<PipeLabel>(hints.pipeLabels ?? [...new Set(nodes.map((n) => n.service))].flatMap((k) => [...defaultPipeLabels(k)]))
  const toggle = (id: PipeLabel, on: boolean, label: string) => {
    const next = new Set(shown)
    if (on) next.add(id)
    else next.delete(id)
    // Sizes always print; the rest in the order they read.
    set({ pipeLabels: ['size', ...PIPE_LABEL_CHOICES.map((c) => c.id).filter((c) => next.has(c))] }, `${on ? 'show' : 'hide'} ${label.toLowerCase()} on ${view.name}`)
  }
  const selectedId = selectedIds.length === 1 ? (selectedIds[0] ?? null) : null
  const station = selectedId ? nodes.find((n) => n.elementId === selectedId && (n.role === 'terminal' || n.role === 'device')) : undefined
  const hidden = hints.hidden ?? []
  const pins = movedCount(view)
  const disabledReason = canEdit ? undefined : blockedReason

  return (
    <section className="flex flex-col gap-3" aria-label="Diagram" data-testid="diagram-properties">
      <Separator />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{DIAGRAM_KIND_LABELS[def.kind]}</span>
        <p className="text-xs text-muted-foreground" data-testid="diagram-summary">
          {fixtures === 0
            ? 'Drawn from the model: nothing to draw yet. Route pipe with Route and connect fixtures to it; the riser draws itself.'
            : `Drawn from the model: ${fixtures} fixture${fixtures === 1 ? '' : 's'} on ${systems} system${systems === 1 ? '' : 's'}, redrawn whenever the model changes.`}{' '}
          Click a pipe or fixture to select it in the model; whatever is selected in the model lights up here.
        </p>
      </div>

      <Field>
        <FieldLabel htmlFor="diagram-systems">Systems</FieldLabel>
        <Select
          value={preset}
          onValueChange={(v) => {
            const p = PIPING_SYSTEM_PRESETS.find((x) => x.id === (v as PipingSystemPreset))
            if (p) set({ systemKinds: p.kinds ? [...p.kinds] : undefined }, `draw ${p.label.toLowerCase()} on ${view.name}`)
          }}
          disabled={!canEdit}
        >
          <SelectTrigger id="diagram-systems" size="sm" data-testid="diagram-systems" title={disabledReason}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PIPING_SYSTEM_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
              {preset === 'custom' && <SelectItem value="custom">As set by an agent: {(hints.systemKinds ?? []).join(', ').replace(/_/g, ' ')}</SelectItem>}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {PIPE_LABEL_CHOICES.map((c) => (
        <Field key={c.id} orientation="horizontal">
          <Switch id={`diagram-label-${c.id}`} checked={shown.has(c.id)} disabled={!canEdit} onCheckedChange={(on) => toggle(c.id, on, c.label)} data-testid={`diagram-label-${c.id}`} />
          <FieldLabel htmlFor={`diagram-label-${c.id}`}>{c.label}</FieldLabel>
        </Field>
      ))}

      {station && selectedId && (
        <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="diagram-selected">
          <span className="text-xs font-medium">{station.name} on this diagram</span>
          <Button variant="ghost" size="sm" className="self-start" disabled={!canEdit} title={disabledReason} onClick={() => set({ hidden: [...hidden, station.id] }, `leave ${station.name} off ${view.name}`)} data-testid="diagram-hide">
            <EyeOff data-icon="inline-start" />
            Leave off this diagram
          </Button>
        </div>
      )}

      {hidden.length > 0 && (
        <Field>
          <FieldLabel>Left off this diagram</FieldLabel>
          <div className="flex flex-wrap gap-1">
            {hidden.map((id) => (
              <Button key={id} variant="outline" size="sm" disabled={!canEdit} onClick={() => set({ hidden: hidden.filter((h) => h !== id) }, `show ${id} on ${view.name} again`)}>
                Show {resolveField(model.elements, id, 'name').text || id} again
              </Button>
            ))}
          </div>
        </Field>
      )}

      <Button variant="outline" size="sm" className="self-start" disabled={!canEdit || pins === 0} title={pins === 0 ? 'Nothing has been moved on this diagram' : disabledReason} onClick={() => set({ pins: undefined, textOffsets: undefined }, `reset positions on ${view.name}`)} data-testid="diagram-reset-pins">
        <RotateCcw data-icon="inline-start" />
        Reset positions{pins > 0 ? ` (${pins} moved)` : ''}
      </Button>
      {error && <FieldDescription className="text-danger-600">{error}</FieldDescription>}
    </section>
  )
}
