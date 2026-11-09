'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Circle, Cable, Eye, ListChecks, FlaskConical, Layers, Library, Maximize, PenLine, Plus, Redo2, Ruler, RotateCw, Save, Slash, Spline, Square, Trash2, Undo2, X } from 'lucide-react'
import {
  PART_CATEGORIES,
  PART_CATEGORY_LABELS,
  SYSTEM_KINDS,
  allPlanes,
  connectorEndTypeTable,
  partTypeImportReport,
  partMesh,
  partTypeIssues,
  partViewLinework,
  resolveDim,
  resolvePartModel,
  type Dim,
  type ParamDef,
  type PartCategory,
  type PartTypeDefinition,
  type PartViewLinework,
  type ResolvedPartModel,
  type SystemKind,
} from '@permitzip/bim-kernel'
import type { TriangleMesh } from '@permitzip/bim-geometry'
import { initPartGeometry } from '../../contracts/bim/part-geometry'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { ElectricalConnectorFields } from './ElectricalConnectorFields'
import { ConnectorReport } from './ConnectorReport'
import { ClearancesPanel } from './ClearancesPanel'
import { DimField } from './DimField'
import { AXIS_VIEW, PartCanvas, VIEW_AXIS, type DrawTool, type FlatView } from './PartCanvas'
import { PartView3D } from './PartView3D'
import { PublishPartDialog } from './PublishPartDialog'
import {
  FACE_FRAMES,
  MM_PER_IN,
  addAxisLine,
  addCircle,
  addConnector,
  addExtrude,
  addParameter,
  addPolyline,
  addRectangle,
  addReferencePlane,
  addRevolve,
  addSketch,
  addStarterBox,
  addType,
  bindDimension,
  blankDraft,
  dimLength,
  draftDefinition,
  draftFromDefinition,
  editorModel,
  paramKey,
  planeDimensions,
  planeLines,
  planes3d,
  removeConnector,
  setConnectorEndType,
  removeFeature,
  removeSketch,
  removeType,
  renameType,
  setDimensionLength,
  setTypeValue,
  sizedDefinition,
  unbindDimension,
  updateConnector,
  updateFeature,
  updateReferencePlane,
  type Draft,
  type EditorView,
  type Face,
  type PlaneDim,
} from './draft'

/** Whether the firm library (every project's shared parts) can take this part. */
export interface FirmLibraryAccess {
  readonly canWrite: boolean
  /** Why not, in plain words, when it can't. */
  readonly reason?: string
  /** Save to the firm library; resolves to the refusal in plain words, or null. */
  readonly save: (definition: PartTypeDefinition) => Promise<string | null>
}

interface Props {
  /** The definition to edit, or null for a new part. */
  initial: PartTypeDefinition | null
  canEdit: boolean
  /** Save to the project library; returns the refusal in plain words, or null. */
  onSave: (definition: PartTypeDefinition) => string | null
  /** The firm library; absent where there is none (the standalone harness without it). */
  firmLibrary?: FirmLibraryAccess
  onClose: () => void
  /** Model in place: the first save also places the part here (in words, "the spot you clicked on Level 1"). */
  placesAt?: string | null
  /** What a new part starts as (Model in place starts generic). */
  newCategory?: PartCategory
}

const DIM_PREFIX = 'dim:'

type Panel = 'create' | 'parameters' | 'connectors' | 'clearances' | 'test'
type EngineState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

/**
 * The part editor: its own full-window workspace over the Building Model.
 * Reference planes, sketches on them, extrudes and revolves (solid or void),
 * parameters and sizes, connectors, plan / front / side / 3D views, and a Test
 * tab that flexes every size. Save writes every size to the project library.
 */
export default function PartEditorWindow({ initial, canEdit, onSave, firmLibrary, onClose, placesAt = null, newCategory }: Props) {
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftFromDefinition(initial) : blankDraft(undefined, newCategory)))
  const [past, setPast] = useState<Draft[]>([])
  const [future, setFuture] = useState<Draft[]>([])
  const [saved, setSaved] = useState<Draft | null>(initial ? draft : null)
  const [view, setView] = useState<EditorView>('3d')
  const [tool, setTool] = useState<DrawTool>('select')
  const [panel, setPanel] = useState<Panel>('create')
  const [activeSketch, setActiveSketch] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [operation, setOperation] = useState<'join' | 'cut'>('join')
  const [engine, setEngine] = useState<EngineState>({ status: 'loading' })
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [fitKey, setFitKey] = useState(0)

  useEffect(() => {
    let live = true
    initPartGeometry().then(
      () => live && setEngine({ status: 'ready' }),
      (err: unknown) => live && setEngine({ status: 'failed', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [])

  // The latest draft, so edits made in one event build on each other and return ids at once.
  const current = useRef(draft)
  const show = useCallback((d: Draft) => {
    current.current = d
    setDraft(d)
  }, [])
  const edit = useCallback(
    (next: Draft | ((d: Draft) => Draft)): Draft => {
      const d = current.current
      const n = typeof next === 'function' ? next(d) : next
      if (n === d) return d
      setPast((p) => [...p.slice(-99), d])
      setFuture([])
      setSaveMessage(null)
      show(n)
      return n
    },
    [show],
  )
  const undo = () => {
    const prev = past[past.length - 1]
    if (!prev) return
    setPast(past.slice(0, -1))
    setFuture([current.current, ...future])
    show(prev)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setFuture(future.slice(1))
    setPast([...past, current.current])
    show(next)
  }

  const model = editorModel(draft.definition)
  // Keyed on the definition and size shown only: typing the part's name must not rebuild the solid.
  const { definition: draftDef, typeName } = draft
  const sized = useMemo(() => sizedDefinition({ groupName: '', definition: draftDef, typeName }), [draftDef, typeName])
  const params: readonly ParamDef[] = useMemo(() => [...draft.definition.typeParams, ...draft.definition.instanceParams], [draft.definition])
  const resolved: ResolvedPartModel | null = useMemo(() => (model ? resolvePartModel(model, (d) => resolveDim(sized, {}, d)) : null), [model, sized])
  const allIssues = useMemo(() => partTypeIssues(draftDefinition(draft)), [draft])
  const shownPlanes = useMemo(() => planes3d({ groupName: '', definition: draftDef, typeName }), [draftDef, typeName])
  const paramLabels = useMemo(() => new Map(params.map((p) => [p.name, p.label])), [params])
  const sizeIssues = resolved?.issues ?? []
  const drawable = engine.status === 'ready' && !!model && model.features.length > 0 && sizeIssues.length === 0

  const geometry = useMemo((): { linework: Partial<Record<FlatView, PartViewLinework>>; mesh: TriangleMesh | null; error: string | null } => {
    if (!drawable) return { linework: {}, mesh: null, error: null }
    try {
      return {
        linework: { plan: partViewLinework(sized, 'plan'), front: partViewLinework(sized, 'front'), side: partViewLinework(sized, 'side') },
        mesh: partMesh(sized),
        error: null,
      }
    } catch (err) {
      console.error('[part-editor] the part could not be built', err)
      return { linework: {}, mesh: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [drawable, sized])

  const planes = model ? allPlanes(model) : []
  const activeSketchRow = model?.sketches.find((s) => s.id === activeSketch) ?? null
  const activePlane = activeSketchRow ? planes.find((p) => p.id === activeSketchRow.plane) : undefined
  const flatView: FlatView = view === '3d' ? 'plan' : view
  const viewPlanes = planeLines(draft, VIEW_AXIS[flatView])
  const viewDims = planeDimensions(draft, VIEW_AXIS[flatView])
  const selectedDim = selected?.startsWith(DIM_PREFIX) ? selected.slice(DIM_PREFIX.length) : null
  const viewSketches = resolved
    ? [...resolved.sketches.values()].filter((rs) => planes.find((p) => p.id === rs.sketch.plane)?.axis === VIEW_AXIS[flatView])
    : []
  const dirty = saved === null || saved.definition !== draft.definition || saved.groupName !== draft.groupName

  const startSketch = (planeId: string) => {
    const plane = planes.find((p) => p.id === planeId)
    if (!plane) return
    const r = addSketch(current.current, planeId, `Sketch on ${plane.name}`)
    edit(r.draft)
    setActiveSketch(r.id)
    setSelected(r.id)
    setView(AXIS_VIEW[plane.axis])
    setTool('rectangle')
  }

  const startBox = () => {
    const r = addStarterBox(current.current)
    edit(r.draft)
    setSelected(r.featureId)
    setActiveSketch(null)
    setTool('select')
    setView('3d')
    setFitKey((k) => k + 1)
  }

  const connectorProblems = useMemo(() => {
    try {
      return partTypeImportReport(draftDefinition(draft)).problems.length
    } catch (err) {
      console.error('[part-editor] the connector report could not be built', err)
      return 0
    }
  }, [draft])
  const reportNote = connectorProblems === 0 ? '' : ` ${connectorProblems === 1 ? '1 connector problem goes' : `${connectorProblems} connector problems go`} with it (Connectors › Check connectors).`
  const sizeCount = Math.max(1, model?.types.length ?? 1)
  const sizesText = `${sizeCount} size${sizeCount === 1 ? '' : 's'}`
  const save = () => {
    const issue = allIssues[0]
    if (issue) {
      setSaveMessage({ ok: false, text: `Not saved: ${issue.message}` })
      return
    }
    const refused = onSave(draftDefinition(draft))
    if (refused) setSaveMessage({ ok: false, text: refused })
    else {
      setSaved(draft)
      setSaveMessage({ ok: true, text: placesAt ? `Saved to the project library (${sizesText}) and placed at ${placesAt}. Undo removes both.${reportNote}` : `Saved to the project library (${sizesText}). Placed parts update.${reportNote}` })
    }
  }
  const [publishing, setPublishing] = useState(false)
  const openPublish = () => {
    const issue = allIssues[0]
    if (issue) {
      setSaveMessage({ ok: false, text: `Not published: ${issue.message}` })
      return
    }
    setSaveMessage(null)
    setPublishing(true)
  }
  const requestClose = () => (dirty && canEdit ? setConfirmClose(true) : onClose())

  const saveBlocked = !canEdit ? 'You can view this part but not change the project library' : allIssues[0] ? `Fix first: ${allIssues[0].message}` : !dirty ? 'No unsaved changes' : null
  const firmBlocked = !firmLibrary ? null : !firmLibrary.canWrite ? (firmLibrary.reason ?? 'You can’t add parts to the firm library') : allIssues[0] ? `Fix first: ${allIssues[0].message}` : publishing ? 'Publishing…' : null
  const noFeatures = (model?.features.length ?? 0) === 0
  const drawBlocked = activeSketch ? null : 'Choose Sketch on plane first'
  const sketchesWithProfile = model?.sketches.filter((s) => s.entities.some((e) => e.kind !== 'line' || !e.construction)) ?? []

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="flex h-[96vh] max-h-none w-[98vw] max-w-none flex-col gap-0 p-0 sm:max-w-none" data-testid="part-editor" onEscapeKeyDown={(e) => {
        if (tool !== 'select') {
          e.preventDefault()
          setTool('select')
        }
      }}>
        <DialogTitle className="sr-only">Part editor</DialogTitle>
        <DialogDescription className="sr-only">Draw, size and connect a part, then save it to the project library.</DialogDescription>
        <header className="flex flex-wrap items-end gap-3 border-b p-3 pr-12">
          <Field className="w-64">
            <FieldLabel htmlFor="pe-name">Part name</FieldLabel>
            <Input id="pe-name" value={draft.groupName} disabled={!canEdit} onChange={(e) => edit((d) => ({ ...d, groupName: e.target.value }))} />
          </Field>
          <Field className="w-56">
            <FieldLabel htmlFor="pe-category">Category</FieldLabel>
            <Select value={draft.definition.category} onValueChange={(v) => edit((d) => ({ ...d, definition: { ...d.definition, category: v as PartCategory } }))} disabled={!canEdit}>
              <SelectTrigger id="pe-category" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PART_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {PART_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="w-48">
            <FieldLabel htmlFor="pe-size">Size shown</FieldLabel>
            <Select value={draft.typeName} onValueChange={(v) => show({ ...current.current, typeName: v })}>
              <SelectTrigger id="pe-size" size="sm" data-testid="pe-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(model?.types.length ? model.types.map((t) => t.name) : [draft.definition.typeName]).map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={past.length === 0} onClick={undo}>
              <Undo2 />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={future.length === 0} onClick={redo}>
              <Redo2 />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button onClick={save} disabled={saveBlocked !== null} data-testid="pe-save">
                    <Save data-icon="inline-start" />
                    Save to project library
                  </Button>
                </span>
              </TooltipTrigger>
              {saveBlocked && <TooltipContent>{saveBlocked}</TooltipContent>}
            </Tooltip>
            {firmLibrary && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" onClick={openPublish} disabled={firmBlocked !== null} data-testid="pe-save-firm">
                      <Library data-icon="inline-start" />
                      Publish…
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{firmBlocked ?? 'Publish a new revision to the firm library: every project can place it, and placed copies are offered the update'}</TooltipContent>
              </Tooltip>
            )}
            <Button variant="outline" onClick={requestClose}>
              <X data-icon="inline-start" />
              Close
            </Button>
          </div>
          {placesAt && (
            <p className="basis-full text-sm text-muted-foreground" data-testid="pe-places-at">
              Model in place: Save adds this part to the project and places it at {placesAt}. Publish… also makes it a reusable part in the firm library.
            </p>
          )}
        </header>
        {firmLibrary && publishing && (
          <PublishPartDialog
            open
            onOpenChange={setPublishing}
            definition={draftDefinition(draft)}
            partName={draft.groupName || 'this part'}
            sizesText={sizesText}
            alsoSaveForPlacePart={firmLibrary.save}
            onDone={(m) => setSaveMessage({ ok: m.ok, text: `${m.text}${m.ok ? reportNote : ''}` })}
          />
        )}

        <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)} className="gap-0 border-b px-3 pt-2">
          <TabsList>
            <TabsTrigger value="create">Create</TabsTrigger>
            <TabsTrigger value="parameters">Parameters</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
            <TabsTrigger value="clearances">Clearances</TabsTrigger>
            <TabsTrigger value="test">Test sizes</TabsTrigger>
          </TabsList>
          <TabsContent value="create" className="flex flex-wrap items-center gap-2 py-2">
            <Button size="sm" variant="outline" disabled={!canEdit || !noFeatures} title={noFeatures ? 'A box on the Base plane, locked to Front, Back, Left and Right, as tall as Height' : 'Only for a part with nothing drawn yet'} onClick={startBox} data-testid="pe-start-box">
              <Box data-icon="inline-start" />
              Start with a box
            </Button>
            <NewPlane params={params} disabled={!canEdit} onAdd={(name, axis, offset) => edit((d) => addReferencePlane(d, name, axis, offset).draft)} />
            <Separator orientation="vertical" className="h-6" />
            <Select value="" onValueChange={startSketch} disabled={!canEdit}>
              <SelectTrigger size="sm" className="w-48" aria-label="Sketch on plane" data-testid="pe-sketch-on">
                <PenLine data-icon="inline-start" />
                <SelectValue placeholder="Sketch on plane…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {planes.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <ToggleGroup type="single" variant="outline" size="sm" value={tool} onValueChange={(v) => v && setTool(v as DrawTool)} disabled={!!drawBlocked || !canEdit} aria-label="Drawing tool">
              <ToggleGroupItem value="rectangle" aria-label="Rectangle" title={drawBlocked ?? 'Rectangle: drag; corners near a reference plane lock to it'} data-testid="pe-tool-rectangle">
                <Square />
              </ToggleGroupItem>
              <ToggleGroupItem value="circle" aria-label="Circle" title={drawBlocked ?? 'Circle: drag from the centre'}>
                <Circle />
              </ToggleGroupItem>
              <ToggleGroupItem value="polyline" aria-label="Polyline" title={drawBlocked ?? 'Polyline: click points, click the first to close'}>
                <Spline />
              </ToggleGroupItem>
              <ToggleGroupItem value="axis" aria-label="Axis line" title={drawBlocked ?? 'Axis line for a revolve'}>
                <Slash />
              </ToggleGroupItem>
            </ToggleGroup>
            <Separator orientation="vertical" className="h-6" />
            <ToggleGroup type="single" variant="outline" size="sm" value={operation} onValueChange={(v) => v && setOperation(v as 'join' | 'cut')} aria-label="Solid or void">
              <ToggleGroupItem value="join">Solid</ToggleGroupItem>
              <ToggleGroupItem value="cut">Void</ToggleGroupItem>
            </ToggleGroup>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !activeSketchRow}
              title={activeSketchRow ? undefined : 'Draw a closed shape in a sketch first'}
              data-testid="pe-extrude"
              onClick={() => {
                if (!activeSketchRow) return
                const r = addExtrude(current.current, activeSketchRow.id, operation, 0, params.some((p) => p.name === 'height') ? { param: 'height' } : 12 * MM_PER_IN)
                edit(r.draft)
                setSelected(r.id)
                setActiveSketch(null)
                setTool('select')
                setView('3d')
              }}
            >
              <Box data-icon="inline-start" />
              Extrude
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !activeSketchRow?.entities.some((e) => e.kind === 'line' && e.construction)}
              title="Draw an axis line in the sketch first"
              onClick={() => {
                const axis = activeSketchRow?.entities.find((e) => e.kind === 'line' && e.construction)
                if (!activeSketchRow || !axis) return
                const r = addRevolve(current.current, activeSketchRow.id, axis.id, operation)
                edit(r.draft)
                setSelected(r.id)
                setActiveSketch(null)
                setTool('select')
                setView('3d')
              }}
            >
              <RotateCw data-icon="inline-start" />
              Revolve
            </Button>
          </TabsContent>
          <TabsContent value="parameters" className="py-2 text-xs text-muted-foreground">
            A parameter is a size or value you can change per size row: Length, Width, Height, a curb height, the airflow. The table on the right has one row per size. Click a dimension in Plan, Front or Side to link it to a parameter; then changing the parameter moves those planes and everything locked to them.
          </TabsContent>
          <TabsContent value="connectors" className="py-2 text-xs text-muted-foreground">
            Add duct, pipe and power connections on a face of the part; their positions and sizes can follow parameters.
          </TabsContent>
          <TabsContent value="clearances" className="py-2 text-xs text-muted-foreground">
            Space every placed part of this type keeps clear: service access, combustibles, economizer access, working space. Drawn dashed in plans, never solid; coordination flags anything inside one.
          </TabsContent>
          <TabsContent value="test" className="py-2 text-xs text-muted-foreground">
            Every size is built and checked. Pick one to see it in the views.
          </TabsContent>
        </Tabs>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-r p-3" aria-label="Part contents">
            <span className="text-xs font-medium text-muted-foreground">Features</span>
            <ItemGroup className="gap-1">
              {model?.features.map((f) => (
                <Item key={f.id} size="sm" variant={selected === f.id ? 'outline' : 'default'} asChild>
                  <Button variant="ghost" className="h-auto justify-start text-left" onClick={() => setSelected(f.id)} data-testid={`pe-feature-${f.id}`}>
                    <ItemContent>
                      <ItemTitle className="text-xs">{f.name}</ItemTitle>
                      <ItemDescription className="text-xs">
                        {f.kind === 'extrude' ? 'Extrusion' : 'Revolve'} · {f.operation === 'join' ? 'solid' : f.operation === 'cut' ? 'void' : 'intersect'} · from {model.sketches.find((s) => s.id === f.sketch)?.name ?? f.sketch}. Click to change or delete.
                      </ItemDescription>
                    </ItemContent>
                  </Button>
                </Item>
              ))}
            </ItemGroup>
            {noFeatures && <p className="text-xs text-muted-foreground">Nothing yet. Start with a box, or choose Sketch on plane, draw a closed shape, then Extrude.</p>}
            <Separator />
            <span className="text-xs font-medium text-muted-foreground">Sketches</span>
            <ItemGroup className="gap-1">
              {model?.sketches.map((s) => (
                <Item key={s.id} size="sm" variant={activeSketch === s.id ? 'outline' : 'default'} asChild>
                  <Button
                    variant="ghost"
                    className="h-auto justify-start text-left"
                    onClick={() => {
                      setActiveSketch(s.id)
                      setSelected(s.id)
                      const axis = planes.find((p) => p.id === s.plane)?.axis
                      if (axis) setView(AXIS_VIEW[axis])
                    }}
                  >
                    <ItemContent>
                      <ItemTitle className="text-xs">{s.name}</ItemTitle>
                      <ItemDescription className="text-xs">{sketchState(resolved, s.id)}</ItemDescription>
                    </ItemContent>
                  </Button>
                </Item>
              ))}
            </ItemGroup>
            <Separator />
            <span className="text-xs font-medium text-muted-foreground">Reference planes</span>
            <ItemGroup className="gap-1">
              {planes.map((p) => (
                <Item key={p.id} size="sm" variant={selected === p.id ? 'outline' : 'default'} asChild>
                  <Button variant="ghost" className="h-auto justify-start text-left" onClick={() => setSelected(p.id)}>
                    <ItemContent>
                      <ItemTitle className="text-xs">{p.name}</ItemTitle>
                    </ItemContent>
                  </Button>
                </Item>
              ))}
            </ItemGroup>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ToggleGroup type="single" size="sm" value={view} onValueChange={(v) => v && setView(v as EditorView)} aria-label="View">
                <ToggleGroupItem value="plan" data-testid="pe-view-plan">Plan</ToggleGroupItem>
                <ToggleGroupItem value="front" data-testid="pe-view-front">Front</ToggleGroupItem>
                <ToggleGroupItem value="side" data-testid="pe-view-side">Side</ToggleGroupItem>
                <ToggleGroupItem value="3d" data-testid="pe-view-3d">3D</ToggleGroupItem>
              </ToggleGroup>
              {activeSketchRow && (
                <Badge variant="outline" className="ml-2">
                  Drawing on {activePlane?.name ?? activeSketchRow.plane} ({AXIS_VIEW[activePlane?.axis ?? 'z']} view)
                </Badge>
              )}
              {activeSketchRow && (
                <Button size="sm" variant="ghost" onClick={() => { setActiveSketch(null); setTool('select') }}>
                  Finish sketch
                </Button>
              )}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFitKey((k) => k + 1)} data-testid="pe-fit">
                <Maximize data-icon="inline-start" />
                Fit
              </Button>
            </div>
            <div className="relative min-h-0 flex-1 bg-muted/30">
              {engine.status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Loading the geometry engine…
                </div>
              )}
              {engine.status === 'failed' && (
                <Empty className="absolute inset-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Layers />
                    </EmptyMedia>
                    <EmptyTitle>The geometry engine didn&apos;t load</EmptyTitle>
                    <EmptyDescription>{engine.message}. Reload the page to try again; your unsaved part is lost on reload.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {engine.status === 'ready' && <PartView3D mesh={geometry.mesh} planes={shownPlanes} selectedPlane={selected} visible={view === '3d'} fitKey={fitKey} />}
              {engine.status === 'ready' && view !== '3d' && (
                <PartCanvas
                  view={view}
                  linework={geometry.linework[view] ?? null}
                  planes={viewPlanes}
                  dims={viewDims}
                  paramLabels={paramLabels}
                  selectedDim={selectedDim}
                  onDim={(id) => {
                    setSelected(`${DIM_PREFIX}${id}`)
                    setPanel('create')
                  }}
                  sketches={viewSketches}
                  activeSketchId={activePlane && AXIS_VIEW[activePlane.axis] === view ? activeSketch : null}
                  tool={tool}
                  fitKey={fitKey}
                  onRectangle={(a, b, tol) => activeSketch && edit((d) => addRectangle(d, activeSketch, a, b, tol))}
                  onCircle={(c, r) => activeSketch && edit((d) => addCircle(d, activeSketch, c, Math.round(r * 10) / 10))}
                  onPolyline={(pts) => activeSketch && edit((d) => addPolyline(d, activeSketch, pts))}
                  onAxis={(a, b) => activeSketch && edit((d) => addAxisLine(d, activeSketch, a, b).draft)}
                />
              )}
              {engine.status === 'ready' && view === '3d' && noFeatures && (
                <Item variant="outline" className="absolute top-3 left-3 max-w-md flex-col items-start gap-2 bg-background/95 shadow-sm" data-testid="pe-start-card">
                  <ItemContent>
                    <ItemTitle>An empty part</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      The dashed sheets are its reference planes: Front, Back, Left, Right and Top sit on the Length, Width and Height parameters; Base is where it is inserted. Start with a box between them, or sketch your own shape on any plane.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button size="sm" onClick={startBox} disabled={!canEdit} data-testid="pe-start-box-card">
                      <Box data-icon="inline-start" />
                      Start with a box
                    </Button>
                    <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => startSketch('base')}>
                      <PenLine data-icon="inline-start" />
                      Sketch on Base
                    </Button>
                  </ItemActions>
                </Item>
              )}
              {engine.status === 'ready' && view === '3d' && !noFeatures && !geometry.mesh && (
                <Empty className="pointer-events-none absolute inset-x-0 top-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Box />
                    </EmptyMedia>
                    <EmptyTitle>This size can’t be built yet</EmptyTitle>
                    <EmptyDescription>{geometry.error ?? sizeIssues[0]?.message ?? 'Fix the problem shown below, or pick another size.'}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
            <footer className="flex flex-wrap items-center gap-3 border-t px-3 py-1.5 text-xs" role="status" data-testid="pe-status">
              {sizeIssues.length > 0 ? (
                <span className="text-danger-600">{sizeIssues.length} problem{sizeIssues.length === 1 ? '' : 's'} in {draft.typeName}: {sizeIssues[0]?.message}</span>
              ) : allIssues.length > 0 ? (
                <span className="text-warning-700">Another size has a problem: {allIssues[0]?.message}</span>
              ) : (
                <span className="text-success-700">Every size builds</span>
              )}
              {resolved?.notes[0] && <span className="text-muted-foreground">{resolved.notes[0]}</span>}
              {saveMessage && <span className={saveMessage.ok ? 'text-success-700' : 'text-danger-600'} role={saveMessage.ok ? undefined : 'alert'}>{saveMessage.text}</span>}
              {!saveMessage && dirty && canEdit && <span className="text-muted-foreground">Unsaved changes</span>}
            </footer>
          </main>

          <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3" aria-label="Properties">
            {panel === 'create' && selectedDim !== null && (
              <DimensionProperties key={`${selectedDim}-${draft.typeName}`} dim={viewDims.find((d) => d.id === selectedDim) ?? null} draft={draft} canEdit={canEdit} edit={edit} onGone={() => setSelected(null)} />
            )}
            {panel === 'create' && selectedDim === null && <FeatureProperties draft={draft} selected={selected} params={params} canEdit={canEdit} edit={edit} onRemoved={() => setSelected(null)} sketchesWithProfile={sketchesWithProfile.map((s) => s.id)} />}
            {panel === 'parameters' && <ParametersPanel draft={draft} canEdit={canEdit} edit={edit} setShown={(name) => show({ ...current.current, typeName: name })} />}
            {panel === 'connectors' && <ConnectorsPanel draft={draft} params={params} canEdit={canEdit} edit={edit} />}
            {panel === 'clearances' && <ClearancesPanel draft={draft} canEdit={canEdit} edit={edit} />}
            {panel === 'test' && <TestPanel draft={draft} engineReady={engine.status === 'ready'} onShow={(name) => show({ ...current.current, typeName: name })} />}
          </aside>
        </div>

        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close without saving?</AlertDialogTitle>
              <AlertDialogDescription>Your changes to {draft.groupName} aren’t in the project library yet. Closing throws them away.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>Close and discard</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

function sketchState(resolved: ResolvedPartModel | null, id: string): string {
  const rs = resolved?.sketches.get(id)
  if (!rs) return 'Has a problem'
  if (rs.sketch.entities.length === 0) return 'Empty: draw a shape'
  if (rs.solution.status === 'failed') return 'Constraints disagree'
  return rs.solution.freeDirections === 0 ? 'Fully defined' : `${rs.solution.freeDirections} directions free`
}

function NewPlane({ params, disabled, onAdd }: { params: readonly ParamDef[]; disabled: boolean; onAdd: (name: string, axis: 'x' | 'y' | 'z', offset: Dim) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('z')
  const [offset, setOffset] = useState<Dim>(0)
  if (!open)
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)} data-testid="pe-new-plane">
        <Plus data-icon="inline-start" />
        Reference plane
      </Button>
    )
  return (
    <div className="flex items-end gap-2 rounded-md border p-2">
      <Field className="w-36">
        <FieldLabel htmlFor="pe-plane-name">Name</FieldLabel>
        <Input id="pe-plane-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Curb top" />
      </Field>
      <Field className="w-36">
        <FieldLabel htmlFor="pe-plane-axis">Square to</FieldLabel>
        <Select value={axis} onValueChange={(v) => setAxis(v as 'x' | 'y' | 'z')}>
          <SelectTrigger id="pe-plane-axis" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="x">Front–back (x)</SelectItem>
              <SelectItem value="y">Left–right (y)</SelectItem>
              <SelectItem value="z">Up (a level, z)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <div className="w-48">
        <DimField id="pe-plane-offset" label="Offset" value={offset} params={params} onChange={setOffset} />
      </div>
      <Button size="sm" disabled={name.trim() === ''} title={name.trim() === '' ? 'Give the plane a name' : undefined} onClick={() => { onAdd(name.trim(), axis, offset); setOpen(false); setName('') }}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  )
}

interface PanelProps {
  draft: Draft
  canEdit: boolean
  edit: (next: Draft | ((d: Draft) => Draft)) => void
}

function FeatureProperties({ draft, selected, params, canEdit, edit, onRemoved, sketchesWithProfile }: PanelProps & { selected: string | null; params: readonly ParamDef[]; onRemoved: () => void; sketchesWithProfile: readonly string[] }) {
  const model = editorModel(draft.definition)
  const feature = model?.features.find((f) => f.id === selected)
  const plane = model?.referencePlanes.find((p) => p.id === selected)
  const sketch = model?.sketches.find((s) => s.id === selected)
  if (feature) {
    return (
      <FieldGroup className="gap-3">
        <span className="text-sm font-medium">{feature.name}</span>
        <Field>
          <FieldLabel htmlFor="pe-f-name">Name</FieldLabel>
          <Input id="pe-f-name" value={feature.name} disabled={!canEdit} onChange={(e) => edit((d) => updateFeature(d, feature.id, (f) => ({ ...f, name: e.target.value || f.name })))} />
        </Field>
        <Field>
          <FieldLabel>Makes</FieldLabel>
          <ToggleGroup type="single" variant="outline" size="sm" value={feature.operation} onValueChange={(v) => v && edit((d) => updateFeature(d, feature.id, (f) => ({ ...f, operation: v as typeof f.operation })))} disabled={!canEdit}>
            <ToggleGroupItem value="join">Solid</ToggleGroupItem>
            <ToggleGroupItem value="cut">Void</ToggleGroupItem>
            <ToggleGroupItem value="intersect">Overlap only</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {feature.kind === 'extrude' ? (
          <>
            <DimField id="pe-f-start" label="Starts at (along the sketch's normal)" value={feature.start} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateFeature(d, feature.id, (f) => (f.kind === 'extrude' ? { ...f, start: dim } : f)))} />
            <DimField id="pe-f-end" label="Ends at" value={feature.end} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateFeature(d, feature.id, (f) => (f.kind === 'extrude' ? { ...f, end: dim } : f)))} />
          </>
        ) : (
          <>
            <DimField id="pe-f-a0" label="From angle" unit="deg" value={feature.startAngle} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateFeature(d, feature.id, (f) => (f.kind === 'revolve' ? { ...f, startAngle: dim } : f)))} />
            <DimField id="pe-f-a1" label="To angle" unit="deg" value={feature.endAngle} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateFeature(d, feature.id, (f) => (f.kind === 'revolve' ? { ...f, endAngle: dim } : f)))} />
          </>
        )}
        <Field>
          <FieldLabel>Shows at detail</FieldLabel>
          <ToggleGroup type="multiple" variant="outline" size="sm" value={feature.visibility ?? ['coarse', 'medium', 'fine']} onValueChange={(v) => v.length > 0 && edit((d) => updateFeature(d, feature.id, (f) => ({ ...f, visibility: v.length === 3 ? undefined : (v as Array<'coarse' | 'medium' | 'fine'>) })))} disabled={!canEdit}>
            <ToggleGroupItem value="coarse">Coarse</ToggleGroupItem>
            <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
            <ToggleGroupItem value="fine">Fine</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => { edit((d) => removeFeature(d, feature.id)); onRemoved() }}>
          <Trash2 data-icon="inline-start" />
          Delete feature
        </Button>
      </FieldGroup>
    )
  }
  if (plane) {
    return (
      <FieldGroup className="gap-3">
        <span className="text-sm font-medium">{plane.name}</span>
        <DimField id="pe-p-offset" label="Offset from the insertion point" value={plane.offset} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateReferencePlane(d, plane.id, { offset: dim }))} />
        <FieldDescription>Sketch corners locked to this plane follow it when the offset or its parameter changes.</FieldDescription>
      </FieldGroup>
    )
  }
  if (sketch) {
    return (
      <FieldGroup className="gap-3">
        <span className="text-sm font-medium">{sketch.name}</span>
        <FieldDescription>{sketch.entities.length} shape{sketch.entities.length === 1 ? '' : 's'}, {sketch.constraints.length} constraint{sketch.constraints.length === 1 ? '' : 's'}. {sketchesWithProfile.includes(sketch.id) ? 'Extrude or Revolve it from the Create tab.' : 'Draw a closed shape.'}</FieldDescription>
        <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => { edit((d) => removeSketch(d, sketch.id)); onRemoved() }}>
          <Trash2 data-icon="inline-start" />
          Delete sketch and its features
        </Button>
      </FieldGroup>
    )
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Eye />
        </EmptyMedia>
        <EmptyTitle>Nothing selected</EmptyTitle>
        <EmptyDescription>Pick a feature, sketch or reference plane on the left to change it.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

const NO_PARAM = '__none__'
const NEW_PARAM = '__new__'

/**
 * A clicked dimension: type its length, or link it to a length parameter so
 * the planes it measures (and what is locked to them) follow that parameter
 * for every size. A link is only what the person picks here.
 */
function DimensionProperties({ dim, draft, canEdit, edit, onGone }: PanelProps & { dim: PlaneDim | null; onGone: () => void }) {
  const lengthParams = draft.definition.typeParams.filter((p) => p.kind === 'length' && !p.formula)
  const inches = dim ? Math.round((dimLength(dim) / MM_PER_IN) * 1000) / 1000 : 0
  const [text, setText] = useState(String(inches))
  const [lastShown, setLastShown] = useState(inches)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (lastShown !== inches) {
    setLastShown(inches)
    setText(String(inches))
  }
  if (!dim) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Ruler />
          </EmptyMedia>
          <EmptyTitle>That dimension isn’t in this view</EmptyTitle>
          <EmptyDescription>Its planes changed or you switched views. Click a dimension in this view.</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={onGone}>
          Done
        </Button>
      </Empty>
    )
  }
  const label = dim.param ? (lengthParams.find((p) => p.name === dim.param)?.label ?? dim.param) : null
  const commitLength = () => {
    const n = Number(text)
    if (!Number.isFinite(n) || n <= 0) {
      setError('Give a length in inches greater than zero')
      return
    }
    setError(null)
    if (Math.abs(n - inches) < 1e-6) return
    edit((d) => setDimensionLength(d, dim, n * MM_PER_IN))
  }
  const link = (value: string) => {
    setError(null)
    if (value === NEW_PARAM) {
      setCreating(true)
      return
    }
    setCreating(false)
    if (value === NO_PARAM) edit((d) => unbindDimension(d, dim))
    else edit((d) => bindDimension(d, dim, value))
  }
  const createAndLink = () => {
    const key = paramKey(newName)
    if (!key) return setError('Start with a letter; letters, digits and spaces only')
    if ([...draft.definition.typeParams, ...draft.definition.instanceParams].some((p) => p.name === key)) return setError(`There is already a parameter ${key}; pick it from the list`)
    const length = Math.round(dimLength(dim) * 1000) / 1000
    edit((d) => bindDimension(addParameter(d, { name: key, label: newName.trim(), kind: 'length', unit: 'mm', min: 0 }, length), dim, key))
    setCreating(false)
    setNewName('')
  }
  return (
    <FieldGroup className="gap-3" data-testid="pe-dim-properties">
      <span className="text-sm font-medium">Dimension: {dim.names}</span>
      <FieldDescription>
        {dim.formula
          ? `A formula places this plane (${dim.formula}). Change the formula on the plane itself.`
          : label
            ? `Follows ${label}. Changing the length here changes ${label} for ${draft.typeName}; the planes and everything locked to them move.`
            : 'A fixed distance. Link it to a parameter to make it change per size.'}
      </FieldDescription>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="pe-dim-length">Length (inches){label ? ` · ${label} for ${draft.typeName}` : ''}</FieldLabel>
        <Input
          id="pe-dim-length"
          value={text}
          disabled={!canEdit || dim.formula !== null}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitLength}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLength()
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="pe-dim-param">Linked to parameter</FieldLabel>
        <Select value={creating ? NEW_PARAM : (dim.param ?? NO_PARAM)} onValueChange={link} disabled={!canEdit || dim.formula !== null}>
          <SelectTrigger id="pe-dim-param" size="sm" data-testid="pe-dim-param">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NO_PARAM}>Nothing (a fixed distance)</SelectItem>
              {lengthParams.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value={NEW_PARAM}>New parameter…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>A parameter is a size you can change per size row (Parameters tab). Linking makes this distance follow it.</FieldDescription>
      </Field>
      {creating && (
        <div className="flex items-end gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor="pe-dim-new-param">New parameter name</FieldLabel>
            <Input id="pe-dim-new-param" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Curb height" />
          </Field>
          <Button size="sm" disabled={newName.trim() === ''} title={newName.trim() === '' ? 'Name the parameter' : undefined} onClick={createAndLink} data-testid="pe-dim-new-param-add">
            Add and link
          </Button>
        </div>
      )}
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
    </FieldGroup>
  )
}

function ParametersPanel({ draft, canEdit, edit, setShown }: PanelProps & { setShown: (name: string) => void }) {
  const model = editorModel(draft.definition)
  const rows = model?.types ?? []
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ParamDef['kind']>('length')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const params = draft.definition.typeParams
  const add = () => {
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) return setError('Start with a letter; letters, digits and spaces only')
    if ([...params, ...draft.definition.instanceParams].some((p) => p.name === key)) return setError(`There is already a parameter ${key}`)
    const n = Number(value)
    const v = kind === 'text' || kind === 'material' ? value : kind === 'boolean' ? value === 'yes' : Number.isFinite(n) ? (kind === 'length' ? n * MM_PER_IN : n) : undefined
    edit((d) => addParameter(d, { name: key, label: name.trim(), kind, ...(kind === 'length' ? { unit: 'mm' as const } : {}) }, v))
    setName('')
    setValue('')
    setError(null)
  }
  const cell = (row: { name: string; values: Record<string, unknown> }, p: ParamDef) => {
    const v = row.values[p.name] ?? draft.definition.typeValues[p.name]
    if (typeof v === 'number') return p.kind === 'length' ? String(Math.round((v / MM_PER_IN) * 100) / 100) : String(v)
    return v === undefined ? '' : String(v)
  }
  return (
    <FieldGroup className="gap-3">
      <span className="text-sm font-medium">Parameters and sizes</span>
      <Table>
        <TableCaption className="sr-only">Values of every parameter for every size (lengths in inches)</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Size</TableHead>
            {params.map((p) => (
              <TableHead key={p.name}>{p.label}{p.kind === 'length' ? ' (in)' : ''}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell>
                <Input aria-label={`Size name ${row.name}`} className="h-7 w-24" defaultValue={row.name} disabled={!canEdit} onBlur={(e) => e.target.value.trim() && e.target.value !== row.name && edit((d) => renameType(d, row.name, e.target.value.trim()))} />
              </TableCell>
              {params.map((p) => (
                <TableCell key={p.name}>
                  {p.formula ? (
                    <span className="text-xs text-muted-foreground" title={p.formula}>= {p.formula}</span>
                  ) : (
                    <Input
                      aria-label={`${p.label} for ${row.name}`}
                      data-testid={`pe-cell-${row.name}-${p.name}`}
                      className="h-7 w-20"
                      defaultValue={cell(row, p)}
                      key={`${row.name}-${p.name}-${cell(row, p)}`}
                      disabled={!canEdit}
                      onBlur={(e) => {
                        const t = e.target.value.trim()
                        const n = Number(t)
                        const v = p.kind === 'length' ? n * MM_PER_IN : p.kind === 'number' || p.kind === 'angle' ? n : p.kind === 'boolean' ? t === 'yes' : t
                        if ((p.kind === 'length' || p.kind === 'number' || p.kind === 'angle') && !Number.isFinite(n)) return
                        edit((d) => setTypeValue(d, row.name, p.name, v))
                        setShown(row.name)
                      }}
                    />
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!canEdit} data-testid="pe-add-size" onClick={() => {
          const base = draft.typeName
          let n = rows.length + 1
          while (rows.some((r) => r.name === `Size ${n}`)) n++
          edit((d) => addType(d, `Size ${n}`, base))
        }}>
          <Plus data-icon="inline-start" />
          Add size (copy of {draft.typeName})
        </Button>
        <Button size="sm" variant="ghost" disabled={!canEdit || rows.length <= 1} title={rows.length <= 1 ? 'A part keeps at least one size' : undefined} onClick={() => edit((d) => removeType(d, d.typeName))}>
          <Trash2 data-icon="inline-start" />
          Remove {draft.typeName}
        </Button>
      </div>
      <Separator />
      <span className="text-xs font-medium">Add a parameter</span>
      <FieldGroup className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="pe-param-name">Name</FieldLabel>
          <Input id="pe-param-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Curb height" />
        </Field>
        <Field>
          <FieldLabel htmlFor="pe-param-kind">Kind</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind(v as ParamDef['kind'])}>
            <SelectTrigger id="pe-param-kind" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="length">Length</SelectItem>
                <SelectItem value="angle">Angle</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="boolean">Yes / no</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="material">Material</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="col-span-2">
          <FieldLabel htmlFor="pe-param-value">Value for every size{kind === 'length' ? ' (inches)' : ''}</FieldLabel>
          <Input id="pe-param-value" value={value} onChange={(e) => setValue(e.target.value)} />
          {error && <FieldDescription className="text-danger-600" role="alert">{error}</FieldDescription>}
        </Field>
      </FieldGroup>
      <Button size="sm" disabled={!canEdit || name.trim() === ''} onClick={add}>
        <Plus data-icon="inline-start" />
        Add parameter
      </Button>
    </FieldGroup>
  )
}

/** The end-type picker's "none" row (Select values can't be empty). */
const NO_END_TYPE = '__none__'

function ConnectorsPanel({ draft, params, canEdit, edit }: PanelProps & { params: readonly ParamDef[] }) {
  const [domain, setDomain] = useState<'duct' | 'pipe' | 'electrical'>('duct')
  const [face, setFace] = useState<Face>('bottom')
  const [system, setSystem] = useState<SystemKind>('supply_air')
  const has = (n: string) => params.some((p) => p.name === n)
  const add = () => {
    const frame = FACE_FRAMES[face]
    const half = (n: string, sign: number): Dim => (has(n) ? { param: n, scale: 0.5 * sign } : 0)
    const position: [Dim, Dim, Dim] =
      face === 'top' ? [0, 0, has('height') ? { param: 'height' } : 0] : face === 'bottom' ? [0, 0, 0] : face === 'front' ? [half('length', 1), 0, has('height') ? { param: 'height', scale: 0.5 } : 0] : face === 'back' ? [half('length', -1), 0, has('height') ? { param: 'height', scale: 0.5 } : 0] : face === 'left' ? [0, half('width', 1), has('height') ? { param: 'height', scale: 0.5 } : 0] : [0, half('width', -1), has('height') ? { param: 'height', scale: 0.5 } : 0]
    const label = domain === 'electrical' ? 'Power' : system.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    edit((d) =>
      addConnector(d, {
        label,
        domain,
        systemKind: domain === 'electrical' ? 'power' : system,
        position,
        direction: frame.direction,
        ...(domain === 'duct' ? { shape: 'rect' as const, width: 12 * MM_PER_IN, height: 8 * MM_PER_IN, widthAxis: frame.widthAxis } : domain === 'pipe' ? { shape: 'round' as const, diameter: 2 * MM_PER_IN } : { shape: 'none' as const, voltage: 208, poles: 3 as const }),
        flowDirection: domain === 'electrical' ? 'in' : 'bidirectional',
      }).draft,
    )
  }
  const [checking, setChecking] = useState(false)
  const endTypes = connectorEndTypeTable()
  const report = useMemo(() => (checking ? partTypeImportReport(draftDefinition(draft)) : null), [checking, draft])
  return (
    <FieldGroup className="gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Connectors</span>
        <Button size="sm" variant="outline" disabled={draft.definition.connectors.length === 0} title={draft.definition.connectors.length === 0 ? 'Add a connector first' : undefined} onClick={() => setChecking(true)} data-testid="pe-check-connectors">
          <ListChecks data-icon="inline-start" />
          Check connectors
        </Button>
      </div>
      <Dialog open={checking} onOpenChange={setChecking}>
        <DialogContent>
          <DialogTitle>Check connectors</DialogTitle>
          <DialogDescription>Size, direction, system and end type of every connector on {draft.definition.typeName}, before you save it.</DialogDescription>
          {report ? <ConnectorReport report={report} /> : null}
        </DialogContent>
      </Dialog>
      <ItemGroup className="gap-2">
        {draft.definition.connectors.map((c) => (
          <Item key={c.id} variant="outline" size="sm" className="flex-col items-stretch">
            <div className="flex items-center gap-2">
              <ItemContent>
                <ItemTitle className="text-xs">{c.label}</ItemTitle>
                <ItemDescription className="text-xs">{c.domain} · {c.systemKind.replace(/_/g, ' ')}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.label}`} disabled={!canEdit} onClick={() => edit((d) => removeConnector(d, c.id))}>
                  <Trash2 />
                </Button>
              </ItemActions>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(['x', 'y', 'z'] as const).map((axis, i) => (
                <DimField key={axis} id={`pe-c-${c.id}-${axis}`} label={['Forward', 'Left', 'Up'][i] ?? axis} value={c.position[i] ?? 0} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateConnector(d, c.id, { position: [i === 0 ? dim : c.position[0], i === 1 ? dim : c.position[1], i === 2 ? dim : c.position[2]] }))} />
              ))}
            </div>
            {c.shape === 'rect' && (
              <div className="grid grid-cols-2 gap-1">
                <DimField id={`pe-c-${c.id}-w`} label="Width" value={c.width ?? 0} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateConnector(d, c.id, { width: dim }))} />
                <DimField id={`pe-c-${c.id}-h`} label="Height" value={c.height ?? 0} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateConnector(d, c.id, { height: dim }))} />
              </div>
            )}
            {c.shape === 'round' && <DimField id={`pe-c-${c.id}-d`} label="Diameter" value={c.diameter ?? 0} params={params} disabled={!canEdit} onChange={(dim) => edit((d) => updateConnector(d, c.id, { diameter: dim }))} />}
            {c.domain === 'electrical' && <ElectricalConnectorFields connector={c} params={params} disabled={!canEdit} onChange={(patch) => edit((d) => updateConnector(d, c.id, patch))} />}
            {(endTypes.declaresDomain(c.domain) || c.endType !== undefined) && (
              <Field>
                <FieldLabel htmlFor={`pe-c-${c.id}-end`}>End type</FieldLabel>
                <Select value={c.endType ?? NO_END_TYPE} disabled={!canEdit} onValueChange={(v) => edit((d) => setConnectorEndType(d, c.id, v === NO_END_TYPE ? null : v))}>
                  <SelectTrigger id={`pe-c-${c.id}-end`} size="sm" data-testid={`pe-c-${c.id}-end`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NO_END_TYPE}>Not set</SelectItem>
                      {endTypes.forDomain(c.domain).map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.label}
                        </SelectItem>
                      ))}
                      {c.endType !== undefined && !endTypes.row(c.endType) ? <SelectItem value={c.endType}>{c.endType} (no add-on here declares it)</SelectItem> : null}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </Item>
        ))}
      </ItemGroup>
      {draft.definition.connectors.length === 0 && <p className="text-xs text-muted-foreground">No connections yet. Ducts, pipes and power route to these.</p>}
      <Separator />
      <FieldGroup className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="pe-c-domain">Kind</FieldLabel>
          <Select value={domain} onValueChange={(v) => setDomain(v as typeof domain)}>
            <SelectTrigger id="pe-c-domain" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="duct">Duct</SelectItem>
                <SelectItem value="pipe">Pipe</SelectItem>
                <SelectItem value="electrical">Power</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="pe-c-face">On face</FieldLabel>
          <Select value={face} onValueChange={(v) => setFace(v as Face)}>
            <SelectTrigger id="pe-c-face" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(['top', 'bottom', 'front', 'back', 'left', 'right'] as const).map((f) => (
                  <SelectItem key={f} value={f}>
                    {f[0]?.toUpperCase()}{f.slice(1)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {domain !== 'electrical' && (
          <Field className="col-span-2">
            <FieldLabel htmlFor="pe-c-system">System</FieldLabel>
            <Select value={system} onValueChange={(v) => setSystem(v as SystemKind)}>
              <SelectTrigger id="pe-c-system" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SYSTEM_KINDS.filter((k) => k !== 'power' && k !== 'lighting' && k !== 'data' && k !== 'fire_alarm').map((k) => (
                    <SelectItem key={k} value={k}>
                      {k.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </FieldGroup>
      <Button size="sm" disabled={!canEdit} onClick={add} data-testid="pe-add-connector">
        <Cable data-icon="inline-start" />
        Add connector
      </Button>
    </FieldGroup>
  )
}

function TestPanel({ draft, engineReady, onShow }: { draft: Draft; engineReady: boolean; onShow: (name: string) => void }) {
  const results = useMemo(
    () =>
      (draft.definition.model?.types ?? []).map((row) => {
        const def = { ...draft.definition, typeName: row.name, typeValues: { ...draft.definition.typeValues, ...row.values } }
        const r = def.model ? resolvePartModel(def.model, (d) => resolveDim(def, {}, d)) : null
        let triangles = 0
        let problem = r?.issues[0]?.message ?? null
        if (!problem && engineReady && def.model && def.model.features.length > 0) {
          try {
            triangles = partMesh(def).triangleCount
          } catch (err) {
            console.error('[part-editor] size failed to build', row.name, err)
            problem = err instanceof Error ? err.message : String(err)
          }
        }
        const extent = [0, 1, 2].map((k) => {
          const lo = Math.min(...(r?.featureBounds.map((b) => b.min[k] ?? 0) ?? []))
          const hi = Math.max(...(r?.featureBounds.map((b) => b.max[k] ?? 0) ?? []))
          return Number.isFinite(lo) && Number.isFinite(hi) ? Math.round(((hi - lo) / MM_PER_IN) * 10) / 10 : null
        })
        const size = extent.every((e) => e !== null) ? extent.join(' × ') : '–'
        return { name: row.name, problem, triangles, size }
      }),
    [draft.definition, engineReady],
  )
  return (
    <FieldGroup className="gap-3">
      <span className="text-sm font-medium">Test sizes</span>
      <ItemGroup className="gap-1">
        {results.map((r) => (
          <Item key={r.name} size="sm" variant={r.name === draft.typeName ? 'outline' : 'default'} asChild>
            <Button variant="ghost" className="h-auto justify-start text-left whitespace-normal" onClick={() => onShow(r.name)} data-testid={`pe-test-${r.name}`}>
              <ItemContent>
                <ItemTitle className="text-xs">
                  <FlaskConical data-icon="inline-start" />
                  {r.name}
                </ItemTitle>
                <ItemDescription className={r.problem ? 'text-xs text-danger-600' : 'text-xs'}>{r.problem ?? `Builds · ${r.size} in · ${r.triangles} triangles`}</ItemDescription>
              </ItemContent>
            </Button>
          </Item>
        ))}
      </ItemGroup>
    </FieldGroup>
  )
}
