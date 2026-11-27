'use client'

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, EyeOff, RotateCcw, TriangleAlert } from 'lucide-react'
import { DIAGRAM_KIND_LABELS, elementsOfKind, evaluateDiagram, resolveField, type DiagramHints, type ModelState, type ViewElement } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Switch } from '../../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { SubmitCommand } from '../views-sheets/types'
import { hintsCommand, isPipingDiagram, reorderCommand, siblingsOf, movedCount } from './diagram-commands'
import { PipingDiagramProperties } from './PipingDiagramProperties'

interface Props {
  readonly model: ModelState
  readonly view: ViewElement
  readonly selectedIds: readonly string[]
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  /** Select a model element (a warning's equipment). */
  readonly onSelect: (elementId: string) => void
}

/**
 * A live diagram's own properties: what it draws now and its warnings, and
 * the engineer's layout choices (direction, look, detail, what it shows, the
 * order of what a source feeds). Each change is one undoable hint edit; the
 * drawing itself always comes from the model.
 */
export function DiagramProperties({ model, view, selectedIds, canEdit, blockedReason, submit, onSelect }: Props) {
  const [error, setError] = useState<string | null>(null)
  const def = view.props?.diagram
  const evaluation = useMemo(() => evaluateDiagram(model.elements, view), [model.elements, view])
  if (!def || !evaluation) return null
  const hints: DiagramHints = def.hints ?? {}
  const isOneLine = def.kind === 'one_line'
  const piping = isPipingDiagram(view)
  if (piping) return <PipingDiagramProperties model={model} view={view} selectedIds={selectedIds} canEdit={canEdit} blockedReason={blockedReason} submit={submit} />
  const disabledReason = canEdit ? null : blockedReason
  const set = (patch: Parameters<typeof hintsCommand>[1], label: string) => {
    const command = hintsCommand(view, patch)
    setError(command ? submit(command, label) : null)
  }
  const selectedId = selectedIds.length === 1 ? (selectedIds[0] ?? null) : null
  const selectedBox = selectedId ? evaluation.boxes.find((b) => b.elementId === selectedId) : undefined
  const siblings = selectedId && selectedBox ? siblingsOf(model, view, selectedId) : null
  const at = siblings && selectedId ? siblings.ids.indexOf(selectedId) : -1
  const pins = movedCount(view)
  const hidden = hints.hidden ?? []
  const reorder = (step: -1 | 1) => {
    if (!selectedId || !selectedBox) return
    const command = reorderCommand(model, view, selectedId, step)
    if (command) setError(submit(command, `move ${selectedBox.name} ${step < 0 ? 'earlier' : 'later'} on ${view.name}`))
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Diagram" data-testid="diagram-properties">
      <Separator />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{DIAGRAM_KIND_LABELS[def.kind]}</span>
        <p className="text-xs text-muted-foreground" data-testid="diagram-summary">
          Drawn from the model: {evaluation.equipment.length === 0 ? 'nothing to draw yet. Place and feed panels from the Electrical tab.' : `${evaluation.equipment.length} piece${evaluation.equipment.length === 1 ? '' : 's'} of equipment, redrawn whenever the model changes.`} Click equipment to select it; drag it to move it on this diagram.
        </p>
      </div>

      {evaluation.warnings.length > 0 && (
        <Alert data-testid="diagram-warnings">
          <TriangleAlert />
          <AlertTitle>{evaluation.warnings.length === 1 ? '1 thing to check' : `${evaluation.warnings.length} things to check`}</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {evaluation.warnings.map((w) => (
                <li key={`${w.kind}:${w.elementId}`} className="flex items-start justify-between gap-2">
                  <span data-testid="diagram-warning">{w.message}</span>
                  <Button variant="ghost" size="sm" onClick={() => onSelect(w.elementId)}>
                    Select
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {isOneLine && (
        <Field>
          <FieldLabel>Power flows</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={hints.orientation ?? 'vertical'}
            onValueChange={(v) => v && set({ orientation: v === 'horizontal' ? 'horizontal' : undefined }, v === 'horizontal' ? 'lay the diagram out left to right' : 'lay the diagram out top to bottom')}
            disabled={!canEdit}
            title={disabledReason ?? undefined}
            data-testid="diagram-orientation"
          >
            <ToggleGroupItem value="vertical">Top to bottom</ToggleGroupItem>
            <ToggleGroupItem value="horizontal">Left to right</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="diagram-style">Look</FieldLabel>
          <Select value={hints.style ?? 'flat'} onValueChange={(v) => set({ style: v === 'box3d' ? 'box3d' : undefined }, v === 'box3d' ? 'draw equipment as 3D boxes' : 'draw equipment flat')} disabled={!canEdit}>
            <SelectTrigger id="diagram-style" size="sm" data-testid="diagram-style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="flat">Flat</SelectItem>
                <SelectItem value="box3d">3D boxes</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="diagram-detail">Detail</FieldLabel>
          <Select value={hints.detail ?? 'full'} onValueChange={(v) => set({ detail: v === 'schematic' ? 'schematic' : undefined }, v === 'schematic' ? 'show the diagram schematic' : 'show every rating')} disabled={!canEdit}>
            <SelectTrigger id="diagram-detail" size="sm" data-testid="diagram-detail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="full">Every rating</SelectItem>
                <SelectItem value="schematic">Schematic</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {(
        [
          ...(isOneLine ? ([['utility', 'Utility source above each service', hints.utility !== false]] as const) : []),
          ['showWarnings', 'Warnings on the drawing', hints.showWarnings !== false],
          ...(def.kind !== 'plumbing_riser' ? ([['showLoads', 'Equipment loads (motors, units)', hints.showLoads === true]] as const) : []),
          ...(isOneLine ? ([['showLinkLoads', 'Feeder demand loads', hints.showLinkLoads === true]] as const) : []),
        ] as ReadonlyArray<readonly ['utility' | 'showWarnings' | 'showLoads' | 'showLinkLoads', string, boolean]>
      ).map(([key, label, on]) => (
        <Field key={key} orientation="horizontal">
          <Switch id={`diagram-${key}`} checked={on} disabled={!canEdit} onCheckedChange={(next) => set({ [key]: key === 'showLoads' || key === 'showLinkLoads' ? (next ? true : undefined) : next ? undefined : false }, `${next ? 'show' : 'hide'} ${label.toLowerCase()}`)} data-testid={`diagram-${key}`} />
          <FieldLabel htmlFor={`diagram-${key}`}>{label}</FieldLabel>
        </Field>
      ))}

      {isOneLine && (
        <div className="grid grid-cols-2 gap-2">
          <Field>
            <FieldLabel htmlFor="diagram-phase-scope">Scope</FieldLabel>
            <Select
              value={hints.phaseScope ?? 'all'}
              onValueChange={(v) => {
                const scope = v === 'new' || v === 'existing' || v === 'demolition' ? v : undefined
                set({ phaseScope: scope }, scope ? `show ${scope} equipment on ${view.name}` : `show all phases on ${view.name}`)
              }}
              disabled={!canEdit}
            >
              <SelectTrigger id="diagram-phase-scope" size="sm" data-testid="diagram-phase-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All phases</SelectItem>
                  <SelectItem value="new">New work</SelectItem>
                  <SelectItem value="existing">Existing</SelectItem>
                  <SelectItem value="demolition">Demolition</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {hints.showLoads && (
            <Field>
              <FieldLabel htmlFor="diagram-min-rating">Minimum load rating</FieldLabel>
              <Select
                value={String(hints.minLoadRatingA ?? 0)}
                onValueChange={(v) => {
                  const minRatingA = Number(v)
                  set({ minLoadRatingA: minRatingA > 0 ? minRatingA : undefined }, minRatingA > 0 ? `show loads ≥ ${minRatingA} A on ${view.name}` : `show all load ratings on ${view.name}`)
                }}
                disabled={!canEdit}
              >
                <SelectTrigger id="diagram-min-rating" size="sm" data-testid="diagram-min-rating">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="0">All ratings</SelectItem>
                    <SelectItem value="30">≥ 30 A</SelectItem>
                    <SelectItem value="60">≥ 60 A</SelectItem>
                    <SelectItem value="100">≥ 100 A</SelectItem>
                    <SelectItem value="200">≥ 200 A</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      )}

      {isOneLine && (() => {
        const included = hints.includeEquipmentIds ?? []
        const excluded = hints.excludeEquipmentIds ?? []
        const loadChoices = elementsOfKind(model.elements, 'part')
          .filter((el) => {
            const t = model.elements[el.typeId]
            return t?.kind === 'part_type' && t.definition.category.endsWith('_equipment') && !t.definition.category.startsWith('elec')
          })
          .map((el) => ({ id: el.id, name: el.mark || resolveField(model.elements, el.id, 'name').text || el.id }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (loadChoices.length === 0 && included.length === 0 && excluded.length === 0) return null
        return (
          <Field data-testid="diagram-equipment-overrides">
            <FieldLabel htmlFor="diagram-pin-equipment">Equipment load overrides</FieldLabel>
            <div className="flex flex-col gap-1.5">
              <Select
                value=""
                disabled={!canEdit}
                onValueChange={(id) => {
                  if (!id) return
                  const nextInc = [...new Set([...included, id])]
                  const nextExc = excluded.filter((x) => x !== id)
                  set({ includeEquipmentIds: nextInc, excludeEquipmentIds: nextExc.length > 0 ? nextExc : undefined }, `always show ${id} on ${view.name}`)
                }}
              >
                <SelectTrigger id="diagram-pin-equipment" size="sm">
                  <SelectValue placeholder="Always include equipment…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {loadChoices
                      .filter((c) => !included.includes(c.id))
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {included.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {included.map((id) => (
                    <Button
                      key={id}
                      variant="secondary"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={!canEdit}
                      onClick={() => {
                        const next = included.filter((x) => x !== id)
                        set({ includeEquipmentIds: next.length > 0 ? next : undefined }, `remove ${id} override on ${view.name}`)
                      }}
                    >
                      + {resolveField(model.elements, id, 'mark').text || resolveField(model.elements, id, 'name').text || id} ×
                    </Button>
                  ))}
                </div>
              )}
              {excluded.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {excluded.map((id) => (
                    <Button
                      key={id}
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={!canEdit}
                      onClick={() => {
                        const next = excluded.filter((x) => x !== id)
                        set({ excludeEquipmentIds: next.length > 0 ? next : undefined }, `re-allow ${id} on ${view.name}`)
                      }}
                    >
                      − {resolveField(model.elements, id, 'mark').text || resolveField(model.elements, id, 'name').text || id} ×
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <FieldDescription>Pin specific loads or equipment onto this one-line even if below the rating threshold.</FieldDescription>
          </Field>
        )
      })()}

      {selectedBox && selectedId && (
        <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="diagram-selected">
          <span className="text-xs font-medium">{selectedBox.name} on this diagram</span>
          <div className="flex flex-wrap gap-2">
            {siblings && siblings.ids.length > 1 && (
              <>
                <Button variant="outline" size="sm" onClick={() => reorder(-1)} disabled={!canEdit || at <= 0} title={at <= 0 ? 'Already first under what feeds it' : (disabledReason ?? undefined)} data-testid="diagram-earlier">
                  <ArrowUp data-icon="inline-start" />
                  Earlier
                </Button>
                <Button variant="outline" size="sm" onClick={() => reorder(1)} disabled={!canEdit || at < 0 || at >= siblings.ids.length - 1} title={at >= siblings.ids.length - 1 ? 'Already last under what feeds it' : (disabledReason ?? undefined)} data-testid="diagram-later">
                  <ArrowDown data-icon="inline-start" />
                  Later
                </Button>
              </>
            )}
            {isOneLine && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canEdit}
                onClick={() => set({ futureSpaces: { ...(hints.futureSpaces ?? {}), [selectedId]: Math.min(12, (hints.futureSpaces?.[selectedId] ?? 0) + 1) } }, `add a future space under ${selectedBox.name}`)}
                data-testid="diagram-future-add"
              >
                Add future space{hints.futureSpaces?.[selectedId] ? ` (${hints.futureSpaces[selectedId]})` : ''}
              </Button>
            )}
            {isOneLine && (hints.futureSpaces?.[selectedId] ?? 0) > 0 && (
              <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => set({ futureSpaces: { ...(hints.futureSpaces ?? {}), [selectedId]: 0 } }, `remove future spaces under ${selectedBox.name}`)}>
                Remove spaces
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => set({ hidden: [...hidden, selectedId] }, `leave ${selectedBox.name} off ${view.name}`)} data-testid="diagram-hide">
              <EyeOff data-icon="inline-start" />
              Leave off this diagram
            </Button>
          </div>
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

      <Button variant="outline" size="sm" className="self-start" disabled={!canEdit || pins === 0} title={pins === 0 ? 'Nothing has been moved on this diagram' : (disabledReason ?? undefined)} onClick={() => set({ pins: undefined, textOffsets: undefined }, `reset positions on ${view.name}`)} data-testid="diagram-reset-pins">
        <RotateCcw data-icon="inline-start" />
        Reset positions{pins > 0 ? ` (${pins} moved)` : ''}
      </Button>
      {error && <FieldDescription className="text-danger-600">{error}</FieldDescription>}
    </section>
  )
}
