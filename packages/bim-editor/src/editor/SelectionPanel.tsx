'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useState } from 'react'
import { headlineKindValue, type BimElement, type ParamValue, type PartTypeDefinition, type RunFitting, type RunSegment } from '@permitzip/bim-kernel'
import { Button } from '../ui/button'
import { Field, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item'
import { Separator } from '../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { linkedSupplyOf } from './electrical/linked-supply'
import type { EquipmentParameter } from './equipment-list/parameters'
import { LinkedElementProperties } from './LinkedElementProperties'
import type { ModelSession, Selection } from './model-session'
import type { ModelStore } from './model-store'
import { MountingPlaneProperties } from './MountingPlaneDialog'
import { AddonComponent, useContributionsVersion } from './contributions/AddonComponent'
import { componentContributions } from './contributions/registry'
import { PART_SECTION } from './contributions/slots'
import type { PartSectionProps } from './contributions/types'
import { PartProperties, type SaveLabel } from './PartProperties'
import { PartSpaceProperties } from './PartSpaceProperties'
import { PipeLoadRow } from './schedules/PipeLoadRow'
import { useInspectorModel } from './state/use-inspector-model'

const ClassificationSection = dynamic(() => import('./construction/ClassificationSection').then((m) => m.ClassificationSection), { ssr: false })
const WhySection = dynamic(() => import('./graph/WhySection').then((m) => m.WhySection), { ssr: false })
const SpaceBoundaryProperties = dynamic(() => import('./spaces/SpaceBoundaryProperties').then((m) => m.SpaceBoundaryProperties), { ssr: false })
// Only when a run is selected: its sizing and hydraulics stay out of the page's first load.
const RunProperties = dynamic(() => import('./RunProperties').then((m) => m.RunProperties), { ssr: false })
// Reads the firm library only when a placed part is selected.
const PartUpdateReview = dynamic(() => import('./part-editor/PartUpdateReview').then((m) => m.PartUpdateReview), { ssr: false })

const INSPECTOR_BLOCKED = "Live editing isn't connected, so changes can't be saved"

const MM_PER_INCH = 25.4

/** The kind's headline value with the label and unit its add-on gives it; `prefix` for a root kind's total. */
function headlineRow(el: BimElement, prefix = ''): [string, string] {
  const h = headlineKindValue(el)
  const label = h ? h.spec.label : 'Value'
  return [prefix ? `${prefix}${label.toLowerCase()}` : label, h ? `${Math.round(h.value)} ${h.spec.unit}` : '—']
}

function describe(el: BimElement): { title: string; rows: [string, string][] } {
  switch (el.kind) {
    case 'duct_segment': {
      const size = el.profile.shape === 'rect' ? `${Math.round(el.profile.width / MM_PER_INCH)}" × ${Math.round(el.profile.height / MM_PER_INCH)}"` : `${Math.round(el.profile.diameter / MM_PER_INCH)}" round`
      const length = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) / 304.8
      return { title: 'Supply duct', rows: [['Size', size], ['Length', `${length.toFixed(1)} ft`], headlineRow(el), ['Element', el.id]] }
    }
    case 'tap':
      return { title: 'Branch takeoff', rows: [['Position on trunk', `${(el.s / 304.8).toFixed(1)} ft from start`], ['Element', el.id]] }
    case 'elbow':
      return { title: 'Elbow', rows: [['Element', el.id]] }
    case 'terminal':
      return { title: `Diffuser ${el.mark}`, rows: [['Type', el.typeName], headlineRow(el), ['Element', el.id]] }
    case 'equipment':
      return { title: `${el.mark} — ${el.typeName}`, rows: [headlineRow(el, 'Total '), ['Element', el.id]] }
    default:
      return { title: el.kind, rows: [['Element', el.id]] }
  }
}

/**
 * The Inspector for one selected element. Reads the session's committed view
 * (no drag preview) from `viewStore` while rendering, so it re-renders when
 * that view changes whether or not the surface does; `session` is only for
 * edits and the kernel's formatting.
 */
export function SelectionPanel({
  projectId,
  equipmentParameters,
  selection,
  session,
  viewStore,
  editTypeRequest,
  onResize,
  canEdit,
  saveLabel,
  saveMessage,
  onDelete,
  onEditDefinition,
  onRouteLike,
}: {
  projectId: string
  /** Library fields the part Inspector shows (baseline, firm, project). */
  equipmentParameters: readonly EquipmentParameter[]
  selection: Exclude<Selection, { kind: 'group' }>
  session: ModelSession | null
  /** The session's committed view, published beside the shown model on every change. */
  viewStore: ModelStore
  onResize: (segmentId: string, widthMm: number, heightMm: number) => string | null
  canEdit: boolean
  saveLabel: SaveLabel
  saveMessage: string | null
  onDelete: (id: string) => void
  editTypeRequest: number
  onEditDefinition: (definition: PartTypeDefinition) => void
  onRouteLike: (el: RunSegment | RunFitting) => void
}) {
  const view = useInspectorModel(viewStore)
  if (selection.kind === 'reference') {
    return (
      <LinkedElementProperties
        referenceLabel={selection.referenceLabel}
        properties={selection.properties}
        problem={selection.problem}
        revit={selection.revit}
        unplaced={selection.unplaced}
      />
    )
  }
  const el = selection.element
  if ((el.kind === 'run_segment' || el.kind === 'run_fitting') && session) {
    if (view)
      return (
        <>
          <RunProperties key={`${el.id}:${el.version}`} element={el} model={view} canEdit={canEdit} onResize={(id, size) => session.resizeGroup([id], size)} onDelete={onDelete} onCommand={(c) => session.submitCommand(c)} actorName={session.actorName()} onRouteLike={() => onRouteLike(el)} projectId={projectId} />
          <PipeLoadRow key={`pipe-load-row:${el.id}:${el.version}`} model={view} element={el} canEdit={canEdit} onCommand={(c) => session.submitCommand(c)} />
          <WhySection model={view} elementId={el.id} canEdit={canEdit} blockedReason={INSPECTOR_BLOCKED} actorName={session.actorName()} submit={(c) => session.submitCommand(c)} />
        </>
      )
  }
  if (el.kind === 'mounting_plane' && session) {
    const level = view?.elements[el.levelId] ?? null
    return (
      <MountingPlaneProperties
        key={`${el.id}:${el.version}`}
        plane={el}
        levelName={level?.kind === 'level' ? level.name : 'No level'}
        partsOnIt={session.partsOnPlane(el.id)}
        canEdit={canEdit}
        onSave={(change) => session.setMountingPlane(el.id, change)}
        onDelete={() => onDelete(el.id)}
      />
    )
  }
  if (el.kind === 'part' && session) {
    const type = view?.elements[el.typeId] ?? null
    const level = view?.elements[el.levelId] ?? null
    const definition = type?.kind === 'part_type' ? type.definition : null
    const submitInstance = (values: Record<string, ParamValue | null>, mark: string | undefined, dzMm: number): string | null => {
      if (Object.keys(values).length > 0 || mark !== undefined) {
        const refused = session.setPartValues(el.id, 'instance', values, mark)
        if (refused) return refused
      }
      return dzMm !== 0 ? session.movePartBy(el.id, { x: 0, y: 0 }, dzMm) : null
    }
    return (
      <PartProperties
        key={`${el.id}:${el.version}:${type?.version ?? 0}`}
        part={el}
        type={definition}
        typeId={el.typeId}
        levelName={level?.kind === 'level' ? level.name : 'No level'}
        canEdit={canEdit}
        saving={saveLabel}
        saveMessage={saveMessage}
        formatValue={(def, value) => session.formatValue(def, value)}
        partsOfType={() => session.partsOfType(el.typeId)}
        onInstance={submitInstance}
        onType={(values) => session.setPartValues(el.id, 'type', values)}
        onRotate={(deg) => session.rotatePart(el.id, deg)}
        onDelete={() => onDelete(el.id)}
        editTypeRequest={editTypeRequest}
        onEditDefinition={definition ? () => onEditDefinition(definition) : undefined}
        spatial={
          view ? (
            <>
              {definition && (
                <PartUpdateReview
                  modelTypes={[{ typeId: el.typeId, definition }]}
                  placedCopies={{ [el.typeId]: session.partsOfType(el.typeId) }}
                  canEdit={canEdit}
                  editBlockedReason={INSPECTOR_BLOCKED}
                  onApply={async (command) => session.submitCommand(command, command.label)}
                />
              )}
              <PartSpaceProperties projectId={projectId} model={view} part={el} type={definition} canEdit={canEdit} onCommand={(c) => session.submitCommand(c)} />
              <WhySection model={view} elementId={el.id} canEdit={canEdit} blockedReason={INSPECTOR_BLOCKED} actorName={session.actorName()} submit={(c) => session.submitCommand(c)} />
            </>
          ) : undefined
        }
        airSide={
          definition ? (
            <PartSections
              part={el}
              type={definition}
              canEdit={canEdit}
              onMount={(mount) => session.setPartMount(el.id, mount)}
              onIntake={(connectorId, choice) => session.setPartIntake(el.id, connectorId, choice)}
              flexCandidates={() => session.flexCandidates(el.id)}
              onFlex={(from, connectorId) => session.routeFlex({ elementId: from.elementId, port: from.port }, { partId: el.id, connectorId })}
            />
          ) : undefined
        }
        linkedSupply={linkedSupplyOf(view, el.id)}
        library={equipmentParameters}
        onCommand={(c) => session.submitCommand(c)}
      />
    )
  }
  const info = describe(selection.element)
  return (
    <>
      <span className="text-sm font-medium">{info.title}</span>
      <ItemGroup className="gap-1">
        {info.rows.map(([k, v]) => (
          <Item key={k} size="sm">
            <ItemContent>
              <ItemDescription className="text-xs">{k}</ItemDescription>
              <ItemTitle className="text-xs font-normal">{v}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      {view && session && (
        <ClassificationSection
          key={`classification:${el.id}:${el.version}`}
          model={view}
          elementId={el.id}
          canEdit={canEdit}
          blockedReason={INSPECTOR_BLOCKED}
          submit={(c) => session.submitCommand(c)}
        />
      )}
      {view && session && <WhySection model={view} elementId={el.id} canEdit={canEdit} blockedReason={INSPECTOR_BLOCKED} actorName={session.actorName()} submit={(c) => session.submitCommand(c)} />}
      {view && el.kind === 'space' ? <SpaceBoundaryProperties model={view} spaceId={el.id} onSelectElement={session ? (id) => void session.selectElement(id).catch((err: unknown) => console.error('[SelectionPanel] selecting a wall of the space failed', { id, err })) : undefined} /> : null}
      {selection.element.kind === 'tap' && <p className="text-xs text-muted-foreground">Drag it in the view to slide the branch along the trunk.</p>}
      {selection.element.kind === 'duct_segment' && selection.element.profile.shape === 'rect' && (
        <ResizeForm key={selection.element.id + selection.element.version} element={selection.element} onResize={onResize} canEdit={canEdit} />
      )}
    </>
  )
}

function ResizeForm({
  element,
  onResize,
  canEdit,
}: {
  element: Extract<BimElement, { kind: 'duct_segment' }>
  onResize: (segmentId: string, widthMm: number, heightMm: number) => string | null
  canEdit: boolean
}) {
  const profile = element.profile.shape === 'rect' ? element.profile : null
  const [width, setWidth] = useState(profile ? String(Math.round(profile.width / MM_PER_INCH)) : '')
  const [height, setHeight] = useState(profile ? String(Math.round(profile.height / MM_PER_INCH)) : '')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const w = Number(width)
    const h = Number(height)
    if (!(w > 0 && h > 0)) {
      setError('Enter a width and height in inches.')
      return
    }
    const refusal = onResize(element.id, w * MM_PER_INCH, h * MM_PER_INCH)
    setError(refusal)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Separator />
      <FieldGroup className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="bm-w">Width (in)</FieldLabel>
          <Input id="bm-w" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} disabled={!canEdit} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-h">Height (in)</FieldLabel>
          <Input id="bm-h" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} disabled={!canEdit} />
        </Field>
      </FieldGroup>
      {error && <p className="text-xs text-danger-600" role="alert">{error}</p>}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button type="submit" size="sm" disabled={!canEdit} className="w-full">
              Resize run
            </Button>
          </span>
        </TooltipTrigger>
        {!canEdit && <TooltipContent>Live editing isn&apos;t connected, so changes can&apos;t be saved</TooltipContent>}
      </Tooltip>
    </form>
  )
}

/** Every add-on's sections of a part's Inspector (`part-section`), each behind `import()` with its loading line, or its error and Retry. */
function PartSections(props: PartSectionProps) {
  useContributionsVersion()
  return (
    <>
      {componentContributions(PART_SECTION).map((c) => (
        <AddonComponent key={c.id} contribution={c} props={props} />
      ))}
    </>
  )
}
