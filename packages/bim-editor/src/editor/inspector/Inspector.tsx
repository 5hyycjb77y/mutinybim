'use client'

import { useMemo, type ReactNode } from 'react'
import type { Command, ModelState, PartTypeDefinition, RunSize } from '@permitzip/bim-kernel'
import { selectElement, type ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'
import { AddonComponent } from '../contributions/AddonComponent'
import { componentContributions } from '../contributions/registry'
import { INSPECTOR_SECTION } from '../contributions/slots'
import { RunProperties } from '../RunProperties'
import { PartInspector, type PartInspectorProps } from './PartInspector'

/**
 * One Inspector for whatever is selected (NEXT-BATCH 5b-2). A part reads as
 * its parameter definitions in facet sections (`PartInspector`); a run (no
 * parameters of its own: system, size, flow, ends) and an element an add-on
 * has a section for host those sections, unchanged, so every control they
 * had is still one click away. Each subscribes to the model store for the one
 * element (and its type) it shows, so an edit elsewhere doesn't redraw it.
 */

type PartCallbacks = Omit<PartInspectorProps, 'part' | 'type' | 'typeId'>

/**
 * The Inspector for one part, read from the model store: it redraws when that
 * part or its type changes, never for an edit anywhere else in the model.
 */
export function ConnectedPartInspector({ store, partId, ...rest }: PartCallbacks & { readonly store: ModelStore; readonly partId: string }) {
  const partSelector = useMemo(() => selectElement(partId), [partId])
  const part = useModelSelector(store, partSelector)
  const typeId = part?.kind === 'part' ? part.typeId : null
  const typeSelector = useMemo(() => selectElement(typeId), [typeId])
  const typeEl = useModelSelector(store, typeSelector)
  if (part?.kind !== 'part') return null
  const type: PartTypeDefinition | null = typeEl?.kind === 'part_type' ? typeEl.definition : null
  return <PartInspector key={`${part.id}:${part.version}:${typeEl?.version ?? 0}`} {...rest} part={part} type={type} typeId={part.typeId} />
}

export interface ElementInspectorProps {
  readonly model: ModelState
  readonly elementId: string
  readonly canEdit: boolean
  readonly onCommand: (command: Command) => string | null
  /** A part's Inspector callbacks (save, rotate, delete, Edit type…). */
  readonly part?: Omit<PartCallbacks, 'canEdit' | 'onCommand'>
  /** A run's own callbacks (resize, delete, route another like this). */
  readonly run?: { readonly onResize: (segmentId: string, size: RunSize) => string | null; readonly onDelete: (id: string) => void; readonly actorName: string; readonly onRouteLike?: () => void; readonly projectId?: string }
  /** Sections an add-on adds below the selection's own. */
  readonly children?: ReactNode
}

/** The Inspector for any selected element, by what it is; null for an element it has nothing to show for. */
export function ElementInspector({ model, elementId, canEdit, onCommand, part, run, children }: ElementInspectorProps) {
  const el = model.elements[elementId]
  if (!el) return null
  if (el.kind === 'part' && part) {
    const typeEl = model.elements[el.typeId]
    const type: PartTypeDefinition | null = typeEl?.kind === 'part_type' ? typeEl.definition : null
    return (
      <PartInspector key={`${el.id}:${el.version}:${typeEl?.version ?? 0}`} {...part} part={el} type={type} typeId={el.typeId} canEdit={canEdit} onCommand={onCommand}>
        {children}
      </PartInspector>
    )
  }
  if ((el.kind === 'run_segment' || el.kind === 'run_fitting') && run) {
    return (
      <div className="flex flex-col gap-3" data-testid="inspector-run">
        <RunProperties key={`${el.id}:${el.version}`} element={el} model={model} canEdit={canEdit} onResize={run.onResize} onDelete={run.onDelete} onCommand={onCommand} actorName={run.actorName} {...(run.onRouteLike ? { onRouteLike: run.onRouteLike } : {})} {...(run.projectId ? { projectId: run.projectId } : {})} />
        {children}
      </div>
    )
  }
  const sections = componentContributions(INSPECTOR_SECTION).filter((c) => c.elementKind === el.kind)
  if (sections.length > 0) {
    return (
      <div className="flex flex-col gap-3" data-testid={`inspector-${el.kind.replace(/_/g, '-')}`}>
        {sections.map((c) => (
          <AddonComponent key={`${c.id}:${el.id}:${el.version}`} contribution={c} props={{ model, elementId, canEdit, onCommand }} />
        ))}
        {children}
      </div>
    )
  }
  return children ? <div className="flex flex-col gap-3">{children}</div> : null
}
