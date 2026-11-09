'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Scan, Undo2 } from 'lucide-react'
import {
  DEFAULT_CUT_HEIGHT_MM,
  STANDARD_SCALES,
  VIEW_CATEGORY_LABELS,
  builtinCategoryRegistry,
  firstPartyServiceRegistry,
  isViewCategory,
  VISUAL_STYLES,
  VIEW_PROJECTIONS,
  type Command,
  type CutPattern,
  type DetailLevel,
  type Rect,
  type ViewCategory,
  type ViewElement,
  type ViewPropsPatch,
  DRAFTING_CATEGORIES,
  type DraftingCategory,
  type VisualStyle,
  referenceSurfaceOf,
  withReferenceDisplay,
  type LinkedModelDiscipline,
  disciplineLabel,
  listDisciplines,
} from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Spinner } from '../../ui/spinner'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { VIEW_TYPE_LABEL, type SubmitCommand } from './types'
import type { BackgroundNote, BackgroundState } from './view-backgrounds'
import { Crop3dFields, type Crop3dControls } from './Crop3dFields'
import { CircuitGraphicsFields } from './CircuitGraphicsFields'
import { LinkedModelDisplayFields } from '../linked-display/LinkedModelDisplayControls'
import { makeLinkedDisplay } from '../linked-display/use-linked-display'
import { CategoryGraphicsTable } from '../graphics/CategoryGraphicsTable'

const FT = 304.8

/** Category labels come from the category registry (one vocabulary with Visibility/Graphics and the agent). */
const CATEGORY_LABEL: Readonly<Record<ViewCategory, string>> = VIEW_CATEGORY_LABELS

/**
 * Disciplines a view can be drawn for, from the registry (the model's add-ons and firm rows included); documentation and general draw nothing of their own.
 * A discipline the view already carries that this registry doesn't know (an add-on turned off since) stays listed, in its own words, so the field never reads blank.
 */
function viewDisciplineChoices(current?: string | null): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  const rows = [{ value: 'all', label: 'All in ink' }, ...listDisciplines().filter((d) => d.id !== 'documentation' && d.id !== 'general').map((d) => ({ value: d.id, label: d.parent ? `${disciplineLabel(d.parent)} › ${d.label}` : d.label }))]
  return current && !rows.some((r) => r.value === current) ? [...rows, { value: current, label: `${disciplineLabel(current)} (not in this model's add-ons)` }] : rows
}

const DETAIL_LEVELS: readonly DetailLevel[] = ['coarse', 'medium', 'fine']

const VISUAL_STYLE_LABEL: Record<VisualStyle, { label: string; hint: string }> = {
  wireframe: { label: 'Wireframe', hint: 'Every edge, nothing hides anything.' },
  hidden_line: { label: 'Hidden line', hint: 'Edges behind nearer elements are hidden.' },
  shaded: { label: 'Shaded', hint: 'Surfaces filled grey, no edges.' },
  shaded_edges: { label: 'Shaded with edges', hint: 'Surfaces filled grey with their edges.' },
}

const DETAIL_HINT: Record<DetailLevel, string> = {
  coarse: 'Duct and pipe as single lines; fittings as their centrelines.',
  medium: 'Duct double-line with fitting outlines.',
  fine: 'Adds turning vanes and fitting joints.',
}

const CUT_PATTERN_LABEL: Record<CutPattern, string> = { cross: 'Cross', solid: 'Solid', hatch: 'Hatch' }

/** View categories with bodies (their hidden edges can draw dashed): the registry's view categories less annotation and room labels. */
const NO_HIDDEN_EDGES: ReadonlySet<ViewCategory> = new Set<ViewCategory>(['tags', 'dimensions', 'rooms', 'grids', 'doors_windows'])
const DASH_CATEGORIES: readonly ViewCategory[] = builtinCategoryRegistry()
  .list()
  .flatMap((c) => (isViewCategory(c.id) && !NO_HIDDEN_EDGES.has(c.id) ? [c.id] : []))

/** Size below which linked objects can be left out of drawings, inches across in plan. */
const SMALL_OBJECT_CHOICES_IN = [0, 3, 6, 12, 18] as const

export type ViewDisplay = 'model' | 'drawing'

interface Props {
  readonly view: ViewElement
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly references: ReadonlyArray<{ readonly id: string; readonly label: string; readonly discipline?: LinkedModelDiscipline }>
  readonly display: ViewDisplay
  readonly onDisplay: (display: ViewDisplay) => void
  readonly onRename: () => void
  /** The linked models cut for this view's drawing, when it has been drawn. */
  readonly background?: BackgroundState
  /** The model level this view stands on, where a linked level choice is kept; null when its level is only a name. */
  readonly hostLevelId?: string | null
  /** The level's name, also for a view that stored its level's id; absent: the view's level as stored. */
  readonly levelName?: string | null
  /** The view's Phase and Phase filter (organization/ViewPhaseFields). */
  readonly phaseFields?: ReactNode
  /** 3D views: their 3D crop box and camera. */
  readonly crop3d?: Crop3dControls
  /** Form schedules (panel, feeder…): their panel, code rules and template (electrical/schedules/ScheduleProperties). */
  readonly schedule?: ReactNode
  /** Live diagrams: their own properties (diagrams/DiagramProperties). */
  readonly diagram?: ReactNode
}

/** The open view's own properties. Each change saves on its own and can be undone. */
const DRAFTING_LABEL: Record<DraftingCategory, string> = { detail_lines: 'Detail lines', hatching: 'Hatching and fills', masking: 'Masking regions', components: 'Detail components', insulation: 'Insulation', text: 'Text and notes', dimensions: 'Dimensions', tags: 'Tags', clouds: 'Revision clouds' }

/** The on/off settings that tick at once: they show the new value before the view redraws. */
export type QuickProps = Partial<Pick<ViewPropsPatch, 'hiddenCategories' | 'hiddenDraftingCategories' | 'showHiddenLines' | 'hiddenLineCategories' | 'linkedHiddenLines' | 'cropView' | 'showCropBox' | 'annotationCrop'>>
type QuickKey = keyof QuickProps
type QuickSet = (patch: QuickProps, send: () => string | null) => void

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].map(String).sort().join('\u0000') === [...b].map(String).sort().join('\u0000')
  return (a ?? null) === (b ?? null)
}

/**
 * A checkbox ticks the moment it is clicked; the edit is sent on the next
 * task, after the tick has painted (a tick used to wait for the kernel's
 * prediction and the whole drawing's redraw, Electrical Demo 2 4:58). The
 * shown value is the view's own as soon as the view has caught up; a refusal
 * puts the box back and says why.
 */
export function useQuickViewProps(view: ViewElement, onRefused: (message: string) => void): { readonly view: ViewElement; readonly updating: boolean; readonly setQuick: QuickSet } {
  const [pending, setPending] = useState<QuickProps>({})
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const live = timers.current
    return () => {
      for (const t of live) clearTimeout(t)
    }
  }, [])
  // Drop a pending value once the view shows it (or another edit replaced it).
  useEffect(() => {
    setPending((prev) => {
      const keys = Object.keys(prev) as QuickKey[]
      const left = keys.filter((k) => !sameValue(view.props?.[k], prev[k]))
      if (left.length === keys.length) return prev
      const next: QuickProps = {}
      for (const k of left) Object.assign(next, { [k]: prev[k] })
      return next
    })
  }, [view])
  const setQuick = useCallback<QuickSet>(
    (patch, send) => {
      setPending((prev) => ({ ...prev, ...patch }))
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        const refusal = send()
        if (!refusal) return
        setPending((prev) => {
          const next: QuickProps = { ...prev }
          for (const k of Object.keys(patch) as QuickKey[]) delete next[k]
          return next
        })
        onRefused(refusal)
      }, 0)
      timers.current.add(timer)
    },
    [onRefused],
  )
  const shown = useMemo<ViewElement>(() => (Object.keys(pending).length === 0 ? view : { ...view, props: { ...(view.props ?? {}), ...pending } }), [view, pending])
  return { view: shown, updating: Object.keys(pending).length > 0, setQuick }
}

export function ViewPropertiesPanel({ view: saved, canEdit, blockedReason, submit, references, display, onDisplay, onRename, background, hostLevelId = null, levelName = null, phaseFields, crop3d, schedule, diagram }: Props) {
  const [error, setError] = useState<string | null>(null)
  const quick = useQuickViewProps(saved, setError)
  const view = quick.view
  const props = view.props ?? {}
  const send = (patch: ViewPropsPatch, label: string): string | null => submit({ type: 'set_view_properties', viewId: view.id, props: patch }, label)
  const set = (patch: ViewPropsPatch, label: string) => setError(send(patch, label))
  const disciplineChoices = useMemo(() => viewDisciplineChoices(props.discipline), [props.discipline])
  const setQuick = (patch: QuickProps, label: string) => {
    setError(null)
    quick.setQuick(patch, () => send(patch, label))
  }
  const setCrop = (change: Omit<Extract<Command, { type: 'set_view_crop' }>, 'type' | 'viewId'>, label: string) => {
    setError(submit({ type: 'set_view_crop', viewId: view.id, ...change }, label))
  }
  const setQuickCrop = (patch: QuickProps, change: Omit<Extract<Command, { type: 'set_view_crop' }>, 'type' | 'viewId'>, label: string) => {
    setError(null)
    quick.setQuick(patch, () => submit({ type: 'set_view_crop', viewId: view.id, ...change }, label))
  }
  /** The linked-model simplification before the last change here, for Undo when it left nothing. */
  const [simplifyBefore, setSimplifyBefore] = useState<{ readonly linkedMinObjectMm: number } | null>(null)
  const hiddenDrafting = new Set<DraftingCategory>(props.hiddenDraftingCategories ?? [])
  const isPlan = view.viewType === 'floor_plan' || view.viewType === 'ceiling_plan'
  const disabledHint = canEdit ? undefined : blockedReason

  return (
    <div className="flex flex-col gap-3" data-testid="view-properties">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{VIEW_TYPE_LABEL[view.viewType]}</span>
          <span className="truncate text-sm font-medium">{view.name}</span>
          {props.level && view.viewType !== 'detail' && <span className="text-xs text-muted-foreground" data-testid="view-properties-level">Level {levelName ?? props.level}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={onRename} disabled={!canEdit}>
          Rename
        </Button>
      </div>
      {quick.updating && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="view-updating">
          <Spinner className="size-3" />
          Updating the view…
        </p>
      )}

      {schedule}
      {diagram}
      {view.viewType === 'section' && <p className="text-xs text-muted-foreground">A section opens as its drawing: the cut at the line, what is beyond it, and its levels. Show the live model to edit in it.</p>}
      {view.viewType !== 'detail' && (
        <Field>
          <FieldLabel>Show</FieldLabel>
          <ToggleGroup type="single" size="sm" variant="outline" value={display} onValueChange={(v) => (v === 'model' || v === 'drawing') && onDisplay(v)} aria-label="Show the live model or the printed drawing" data-testid="view-display">
            <ToggleGroupItem value="model">{view.viewType === 'schedule' ? 'Spreadsheet' : 'Live model'}</ToggleGroupItem>
            <ToggleGroupItem value="drawing">Printed drawing</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription className="text-xs">This view opens this way for you next time, on any computer.</FieldDescription>
        </Field>
      )}

      {/* A schedule is a table: it has no scale, crop, discipline, linked models or lines to set. */}
      {view.viewType === 'schedule' ? (
        error && (
          <p className="text-xs text-danger-600" role="alert">
            {error}
          </p>
        )
      ) : (
      <>
      {phaseFields && view.viewType !== 'detail' && (
        <>
          <Separator />
          {phaseFields}
        </>
      )}
      <Separator />
      <FieldGroup className="gap-3">
        {props.diagram && <p className="text-xs text-muted-foreground">Scale: none. A live diagram prints at its own size on any sheet, like a schedule.</p>}
        {view.viewType !== 'three_d' && !props.diagram && (
          <Field>
            <FieldLabel htmlFor="vp-view-scale">Scale</FieldLabel>
            <Select value={String(props.scale ?? 48)} onValueChange={(v) => set({ scale: Number(v) }, 'change the scale')} disabled={!canEdit}>
              <SelectTrigger id="vp-view-scale" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {STANDARD_SCALES.map((s) => (
                    <SelectItem key={s.scale} value={String(s.scale)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{disabledHint ?? 'Used when this view is placed on a sheet.'}</FieldDescription>
          </Field>
        )}

        {view.viewType === 'three_d' && (
          <Field>
            <FieldLabel>Projection</FieldLabel>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={props.projection ?? 'perspective'}
              disabled={!canEdit}
              aria-label="Projection"
              data-testid="view-projection"
              onValueChange={(v) => {
                const picked = VIEW_PROJECTIONS.find((p) => p === v)
                if (picked) set({ projection: picked }, picked === 'orthographic' ? 'switch to orthographic' : 'switch to perspective')
              }}
            >
              <ToggleGroupItem value="perspective">Perspective</ToggleGroupItem>
              <ToggleGroupItem value="orthographic">Orthographic</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription className="text-xs">
              {disabledHint ??
                ((props.projection ?? 'perspective') === 'orthographic'
                  ? 'Parallel lines stay parallel: cube faces give true elevations and corners true isometrics. Prints the same way.'
                  : 'Farther things look smaller, like a photo. On a sheet a 3D view still prints orthographic (isometric).')}
            </FieldDescription>
          </Field>
        )}

        {isPlan && <HeightRangeFields view={view} canEdit={canEdit} set={set} />}

        {view.viewType === 'section' && props.section && (
          <>
            <NumberField
              key={`vp-depth:${props.section.depthMm}`}
              id="vp-depth"
              label="Far clip depth (ft)"
              value={props.section.depthMm / FT}
              disabled={!canEdit}
              description="How far past the cut line the section sees. Drag the depth grip on the plan, too."
              onCommit={(ft) => setCrop({ farClipMm: Math.max(1, ft) * FT }, 'change how far the section sees')}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={!canEdit}
                    onClick={() => props.section && set({ section: { ...props.section, direction: props.section.direction === 1 ? -1 : 1 } }, 'flip the section')}
                  >
                    <ArrowLeftRight data-icon="inline-start" />
                    Look the other way
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{disabledHint ?? 'Flip which side of the cut line the section shows'}</TooltipContent>
            </Tooltip>
          </>
        )}

        {view.viewType !== 'three_d' && (
          <FieldSet>
            <FieldLegend variant="label">Drafting shown</FieldLegend>
            <FieldGroup className="gap-1.5">
              {DRAFTING_CATEGORIES.map((c) => (
                <Field key={c} orientation="horizontal">
                  <Checkbox
                    id={`vp-draft-${c}`}
                    checked={!hiddenDrafting.has(c)}
                    disabled={!canEdit}
                    data-testid={`vp-draft-${c}`}
                    onCheckedChange={(v) => {
                      const next = new Set(hiddenDrafting)
                      if (v === true) next.delete(c)
                      else next.add(c)
                      setQuick({ hiddenDraftingCategories: [...next] }, `${v === true ? 'show' : 'hide'} ${DRAFTING_LABEL[c].toLowerCase()}`)
                    }}
                  />
                  <FieldLabel htmlFor={`vp-draft-${c}`} className="font-normal">
                    {DRAFTING_LABEL[c]}
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
            <FieldDescription>Hidden drafting stays in the view; it just doesn&apos;t show or print here.</FieldDescription>
          </FieldSet>
        )}

        {view.viewType !== 'detail' && (
          <>
            <Field>
              <FieldLabel htmlFor="vp-disc">Discipline</FieldLabel>
              <Select value={props.discipline ?? 'all'} onValueChange={(v) => {
                  const picked = disciplineChoices.find((d) => d.value === v)
                  if (picked) set({ discipline: picked.value === 'all' ? null : picked.value }, 'change the discipline')
                }} disabled={!canEdit}>
                <SelectTrigger id="vp-disc" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {disciplineChoices.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{props.discipline ? "Other disciplines print in halftone; plans leave out their runs." : 'Every discipline prints in ink.'}</FieldDescription>
            </Field>
            {isPlan && <CircuitGraphicsFields view={view} canEdit={canEdit} disabledHint={disabledHint} set={set} />}
            <LinesFields view={view} canEdit={canEdit} set={set} setQuick={setQuick}>
              {references.length > 0 && (
                <FieldSet data-testid="view-linked-models">
                  <FieldLegend variant="label">Linked models</FieldLegend>
                  <BackgroundStatus
                    background={background}
                    choice={{ canEdit, blockedReason, hostLevelId, submit }}
                    onUndo={
                      simplifyBefore && (props.linkedMinObjectMm ?? 0) !== simplifyBefore.linkedMinObjectMm
                        ? () => {
                            set({ linkedMinObjectMm: simplifyBefore.linkedMinObjectMm }, simplifyBefore.linkedMinObjectMm === 0 ? 'draw every linked object' : `leave out linked objects under ${Math.round(simplifyBefore.linkedMinObjectMm / 25.4)}"`)
                            setSimplifyBefore(null)
                          }
                        : null
                    }
                  />
                  {view.viewType !== 'three_d' && <LinkedSimplifyFields view={view} canEdit={canEdit} set={set} setQuick={setQuick} onChangeSmall={(previousMm) => setSimplifyBefore({ linkedMinObjectMm: previousMm })} />}
                  <LinkedModelDisplayFields
                    display={makeLinkedDisplay({
                      targetLabel: view.props?.workingFor ? 'your 3D view' : 'this view',
                      surface: referenceSurfaceOf(view),
                      stored: (id) => props.references?.[id],
                      discipline: (id) => references.find((r) => r.id === id)?.discipline ?? 'architecture',
                      save: (id, next, label) => set({ references: withReferenceDisplay(props.references, id, next) }, label),
                    })}
                    references={references}
                    canEdit={canEdit}
                    disabledHint={disabledHint ?? null}
                  />
                </FieldSet>
              )}
            </LinesFields>

            <CategoryGraphicsTable
              view={view}
              services={firstPartyServiceRegistry().rows}
              canEdit={canEdit}
              {...(disabledHint ? { disabledHint } : {})}
              onPatch={(patch, label) => {
                // Show/hide of a view category ticks at once, like every other checkbox here.
                if (patch.hiddenCategories && Object.keys(patch).length === 1) {
                  setQuick({ hiddenCategories: patch.hiddenCategories }, label)
                  return null
                }
                return send(patch, label)
              }}
            />
          </>
        )}
      </FieldGroup>
      <Separator />
      {view.viewType === 'three_d' && crop3d ? <Crop3dFields controls={crop3d} canEdit={canEdit} disabledHint={disabledHint} /> : <CropFields view={view} canEdit={canEdit} disabledHint={disabledHint} onCrop={setCrop} onQuickCrop={setQuickCrop} />}
      {error && (
        <p className="text-xs text-danger-600" role="alert">
          {error}
        </p>
      )}
      </>
      )}
    </div>
  )
}

interface LinkedLevelChoiceContext {
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly hostLevelId: string | null
  readonly submit: SubmitCommand
}

type ChoiceNote = BackgroundNote & { readonly levelChoice: NonNullable<BackgroundNote['levelChoice']> }

/** At most this many storeys as buttons; a linked model rarely has more near one level. */
const MAX_LEVEL_BUTTONS = 8

/**
 * "Which level of the architect's model is ROOF?": one button per linked
 * level, nearest first. The choice is kept on our level for that linked model,
 * so every plan of the level draws it; undo takes it back.
 */
function LinkedLevelChoice({ note, ctx }: { note: ChoiceNote; ctx: LinkedLevelChoiceContext }) {
  const [error, setError] = useState<string | null>(null)
  const why = !ctx.canEdit
    ? ctx.blockedReason
    : ctx.hostLevelId === null
      ? `${note.levelChoice.level} isn't one of this model's levels yet, so the choice has nowhere to be kept. Add it as a level first (Model › Add level), at its height.`
      : null
  const options = note.levelChoice.options.slice(0, MAX_LEVEL_BUTTONS)
  return (
    <div className="flex flex-col gap-1" data-testid="linked-level-choice" role="group" aria-label={`Which level of ${note.label} is ${note.levelChoice.level}`}>
      <FieldDescription className="text-xs text-warning-700">
        {note.label}: {note.reason}
      </FieldDescription>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <Button
              key={o}
              size="sm"
              variant="outline"
              disabled={why !== null}
              title={why ?? `Draw ${note.label}'s ${o} on ${note.levelChoice.level}`}
              onClick={() => {
                if (ctx.hostLevelId === null) return
                setError(ctx.submit({ type: 'set_level_linked_storey', levelId: ctx.hostLevelId, linkId: note.levelChoice.linkId, storeyName: o }, `${note.levelChoice.level} draws ${note.label}'s ${o}`))
              }}
            >
              {o}
            </Button>
          ))}
        </div>
      )}
      {why !== null && <FieldDescription className="text-xs">{why}</FieldDescription>}
      {error && (
        <p className="text-xs text-danger-600" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** What the linked models drew in this view's printed drawing, or why one drew nothing. */
function BackgroundStatus({ background, onUndo, choice }: { background: BackgroundState | undefined; onUndo: (() => void) | null; choice: LinkedLevelChoiceContext }) {
  if (!background) return null
  if (background.state === 'loading') {
    return <FieldDescription className="text-xs" data-testid="view-background-status">Cutting the linked models for this view…</FieldDescription>
  }
  if (background.state === 'updating') {
    return (
      <FieldDescription className="flex items-center gap-1.5 text-xs" data-testid="view-background-status" data-state="updating">
        <Spinner className="size-3" />
        Redrawing the linked models with the new settings. The old drawing stays until it&apos;s ready.
      </FieldDescription>
    )
  }
  if (background.state === 'ready' && background.leftNothing) {
    return (
      <Alert data-testid="view-background-left-nothing">
        <AlertTitle>Nothing of the linked models is left in this view</AlertTitle>
        <AlertDescription>
          <p>The last change leaves out every line they drew here. Undo it to bring them back.</p>
          {onUndo && (
            <Button size="sm" variant="outline" className="mt-2" onClick={onUndo} data-testid="view-background-undo">
              <Undo2 data-icon="inline-start" />
              Undo
            </Button>
          )}
        </AlertDescription>
      </Alert>
    )
  }
  if (background.state === 'error') {
    return (
      <FieldDescription className="text-xs text-danger-600" data-testid="view-background-status" role="alert">
        The linked models couldn&apos;t be cut for this drawing ({background.message}). It prints without them; reopen the view to try again.
      </FieldDescription>
    )
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid="view-background-status">
      {background.drawn.length > 0 && <FieldDescription className="text-xs">Drawn under this view: {background.drawn.join(', ')}.</FieldDescription>}
      {background.notes.map((n) =>
        n.levelChoice ? (
          <LinkedLevelChoice key={n.referenceId} note={{ ...n, levelChoice: n.levelChoice }} ctx={choice} />
        ) : (
          <FieldDescription key={n.referenceId} className="text-xs text-warning-700">
            {n.label}: {n.reason}
          </FieldDescription>
        ),
      )}
    </div>
  )
}

/**
 * Lines and colours: how the view draws (visual style, detail, hidden lines,
 * cut fill), the pen for each category where it is cut and where it is seen
 * beyond, and the linked models' look. Always open: it is where a person
 * looks for line weights.
 */
function LinesFields({ view, canEdit, set, setQuick, children }: { view: ViewElement; canEdit: boolean; set: (patch: ViewPropsPatch, label: string) => void; setQuick: (patch: QuickProps, label: string) => void; children?: ReactNode }) {
  const props = view.props ?? {}
  const style = props.visualStyle ?? 'hidden_line'
  const detail = props.detailLevel ?? 'medium'
  const dashedCategories = new Set(props.hiddenLineCategories ?? [])
  return (
    <FieldSet id="view-lines" data-testid="view-graphics" className="scroll-mt-4">
      <FieldLegend variant="label">Lines and colours</FieldLegend>
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="vp-style">Visual style</FieldLabel>
          <Select value={style} onValueChange={(v) => {
              const picked = VISUAL_STYLES.find((s) => s === v)
              if (picked) set({ visualStyle: picked }, 'change the visual style')
            }} disabled={!canEdit}>
            <SelectTrigger id="vp-style" size="sm" data-testid="view-visual-style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {VISUAL_STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {VISUAL_STYLE_LABEL[s].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">{VISUAL_STYLE_LABEL[style].hint} Applies to the drawing, the print and the 3D view.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Detail level</FieldLabel>
          <ToggleGroup type="single" size="sm" variant="outline" value={detail} disabled={!canEdit} aria-label="Detail level" data-testid="view-detail-level" onValueChange={(v) => {
              const level = DETAIL_LEVELS.find((d) => d === v)
              if (level) set({ detailLevel: level }, 'change the detail level')
            }}>
            <ToggleGroupItem value="coarse">Coarse</ToggleGroupItem>
            <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
            <ToggleGroupItem value="fine">Fine</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription className="text-xs">{DETAIL_HINT[detail]}</FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="vp-hidden-lines" checked={props.showHiddenLines === true} disabled={!canEdit || style === 'wireframe' || style === 'shaded'} onCheckedChange={(v) => setQuick({ showHiddenLines: v === true }, v === true ? 'show hidden lines' : 'remove hidden lines')} />
          <FieldContent>
            <FieldLabel htmlFor="vp-hidden-lines" className="font-normal">
              Show hidden lines
            </FieldLabel>
            <FieldDescription className="text-xs">
              {style === 'wireframe' ? 'Wireframe already draws every edge.' : style === 'shaded' ? 'Shaded draws no edges; pick Shaded with edges or Hidden line.' : 'Edges behind other elements draw dashed instead of disappearing.'}
            </FieldDescription>
          </FieldContent>
        </Field>
        {view.viewType === 'section' && (
          <Field>
            <FieldLabel>Cut duct and pipe</FieldLabel>
            <ToggleGroup type="single" size="sm" variant="outline" value={props.cutPattern ?? 'cross'} disabled={!canEdit} aria-label="How cut duct and pipe are filled" onValueChange={(v) => {
                const picked = (['cross', 'solid', 'hatch'] as const).find((c) => c === v)
                if (picked) set({ cutPattern: picked }, 'change the cut fill')
              }}>
              {(['cross', 'solid', 'hatch'] as const).map((c) => (
                <ToggleGroupItem key={c} value={c}>
                  {CUT_PATTERN_LABEL[c]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        )}
        <div className="flex flex-col gap-1" data-testid="view-line-weights">
          <span className="text-xs font-medium">Hidden lines by category</span>
          <FieldDescription className="text-xs">
            Pens, halftone and line patterns for each category are in{' '}
            <a href="#view-visibility-graphics" className="underline underline-offset-2">
              Visibility/Graphics
            </a>{' '}
            below.
          </FieldDescription>
          <Table className="text-xs">
            <TableCaption className="sr-only">Whether each category&apos;s hidden edges draw dashed</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="h-7 px-1">Category</TableHead>
                <TableHead className="h-7 px-1 text-center">Dash hidden</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DASH_CATEGORIES.map((c) => (
                <TableRow key={c}>
                  <TableCell className="px-1 py-1 font-medium">{CATEGORY_LABEL[c]}</TableCell>
                  <TableCell className="px-1 py-1 text-center">
                    <Checkbox
                      id={`vp-hidden-${c}`}
                      aria-label={`Dash hidden ${CATEGORY_LABEL[c].toLowerCase()}`}
                      checked={props.showHiddenLines === true || dashedCategories.has(c)}
                      disabled={!canEdit || props.showHiddenLines === true}
                      onCheckedChange={(v) => {
                        const next = new Set(dashedCategories)
                        if (v === true) next.add(c)
                        else next.delete(c)
                        setQuick({ hiddenLineCategories: [...next] }, `${v === true ? 'dash' : 'hide'} hidden ${CATEGORY_LABEL[c].toLowerCase()}`)
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {children}
      </FieldGroup>
    </FieldSet>
  )
}

/**
 * What a plan shows, top to bottom: the top of the view, where walls are cut,
 * the bottom, and how far below the bottom it still sees. Applies to our model
 * and to the linked models alike. Top and bottom are blank until set (no limit).
 */
function HeightRangeFields({ view, canEdit, set }: { view: ViewElement; canEdit: boolean; set: (patch: ViewPropsPatch, label: string) => void }) {
  const props = view.props ?? {}
  const cut = props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM
  return (
    <FieldSet id="view-range" data-testid="view-range" className="scroll-mt-4">
      <FieldLegend variant="label">What this view shows</FieldLegend>
      <FieldDescription className="text-xs">Heights above this level. Our model and the linked models both follow them.</FieldDescription>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          key={`vp-top:${props.viewTopMm ?? 'none'}`}
          id="vp-top"
          label="Top (ft)"
          value={props.viewTopMm === undefined ? null : props.viewTopMm / FT}
          disabled={!canEdit}
          optional
          placeholder="No limit"
          description="Above this, nothing shows."
          onCommit={(ft) => set({ viewTopMm: ft * FT }, 'change the top of the view')}
          onClear={() => set({ viewTopMm: null }, 'show everything above the cut')}
        />
        <NumberField
          key={`vp-cut:${cut}`}
          id="vp-cut"
          label="Cut height (ft)"
          value={cut / FT}
          disabled={!canEdit}
          description="Walls are cut here."
          onCommit={(ft) => set({ cutHeightMm: ft * FT }, 'change the cut height')}
        />
        <NumberField
          key={`vp-bottom:${props.viewBottomMm ?? 'none'}`}
          id="vp-bottom"
          label="Bottom (ft)"
          value={props.viewBottomMm === undefined ? null : props.viewBottomMm / FT}
          disabled={!canEdit}
          optional
          allowNegative
          placeholder="No limit"
          description="Below this, only what the depth reaches."
          onCommit={(ft) => set({ viewBottomMm: ft * FT }, 'change the bottom of the view')}
          onClear={() => set({ viewBottomMm: null }, 'show everything below the cut')}
        />
        <NumberField
          key={`vp-depth:${props.viewDepthMm ?? 0}`}
          id="vp-view-depth"
          label="Depth below bottom (ft)"
          value={(props.viewDepthMm ?? 0) / FT}
          disabled={!canEdit}
          description={props.viewBottomMm === undefined ? 'Sets the bottom at the level too.' : 'Seen past the bottom.'}
          onCommit={(ft) => set({ viewDepthMm: ft * FT, ...(props.viewBottomMm === undefined ? { viewBottomMm: 0 } : {}) }, 'change how far below the bottom the view sees')}
        />
      </div>
    </FieldSet>
  )
}

/** How a view simplifies its linked models on paper: hidden lines removed, and small things left out. */
function LinkedSimplifyFields({
  view,
  canEdit,
  set,
  setQuick,
  onChangeSmall,
}: {
  view: ViewElement
  canEdit: boolean
  set: (patch: ViewPropsPatch, label: string) => void
  setQuick: (patch: QuickProps, label: string) => void
  /** The size it was before this change, mm (for Undo if the change leaves nothing). */
  onChangeSmall: (previousMm: number) => void
}) {
  const props = view.props ?? {}
  const hidden = props.linkedHiddenLines !== false
  const minIn = (props.linkedMinObjectMm ?? 0) / 25.4
  return (
    <FieldGroup className="gap-2" data-testid="linked-simplify">
      <Field orientation="horizontal">
        <Checkbox id="vp-linked-hidden" checked={hidden} disabled={!canEdit} onCheckedChange={(v) => setQuick({ linkedHiddenLines: v === true }, v === true ? "hide linked lines under nearer things" : 'draw every linked line')} />
        <FieldContent>
          <FieldLabel htmlFor="vp-linked-hidden" className="font-normal">
            Hide what is underneath
          </FieldLabel>
          <FieldDescription className="text-xs">A chair under a table, a counter under a shelf: lines covered by something nearer are left out of the drawing.</FieldDescription>
        </FieldContent>
      </Field>
      <Field>
        <FieldLabel htmlFor="vp-linked-small">Leave out things smaller than</FieldLabel>
        <Select value={String(minIn)} disabled={!canEdit} onValueChange={(v) => {
            const inches = Number(v)
            if (!Number.isFinite(inches) || inches === minIn) return
            onChangeSmall(props.linkedMinObjectMm ?? 0)
            set({ linkedMinObjectMm: inches * 25.4 }, inches === 0 ? 'draw every linked object' : `leave out linked objects under ${inches}"`)
          }}>
          <SelectTrigger id="vp-linked-small" size="sm" data-testid="linked-min-object">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SMALL_OBJECT_CHOICES_IN.map((inches) => (
                <SelectItem key={inches} value={String(inches)}>
                  {inches === 0 ? 'Draw everything' : `${inches}" across`}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription className="text-xs">Simplifies a busy architect&apos;s model: cups, outlets, small accessories. Walls and anything the cut passes through are always drawn, and your selection stays.</FieldDescription>
      </Field>
    </FieldGroup>
  )
}

/** Crop box: on/off, whether editors see it, annotation crop, its edges in feet, and fit to content. */
function CropFields({
  view,
  canEdit,
  disabledHint,
  onCrop,
  onQuickCrop,
}: {
  view: ViewElement
  canEdit: boolean
  disabledHint: string | undefined
  onCrop: (change: Omit<Extract<Command, { type: 'set_view_crop' }>, 'type' | 'viewId'>, label: string) => void
  /** An on/off crop setting: ticks at once, saved right after. */
  onQuickCrop: (patch: QuickProps, change: Omit<Extract<Command, { type: 'set_view_crop' }>, 'type' | 'viewId'>, label: string) => void
}) {
  const props = view.props ?? {}
  const cropOn = props.cropView !== false
  const crop: Rect = { min: view.cropMin, max: view.cropMax }
  const section = view.viewType === 'section'
  const edge = (key: 'minX' | 'maxX' | 'minY' | 'maxY', ft: number) => {
    const mm = Math.round(ft * FT)
    const next: Rect = {
      min: { x: key === 'minX' ? mm : crop.min.x, y: key === 'minY' ? mm : crop.min.y },
      max: { x: key === 'maxX' ? mm : crop.max.x, y: key === 'maxY' ? mm : crop.max.y },
    }
    onCrop({ crop: next }, 'change the crop box')
  }
  const labels = section
    ? { minX: 'Start along cut (ft)', maxX: 'End along cut (ft)', minY: 'Bottom elevation (ft)', maxY: 'Top elevation (ft)' }
    : { minX: 'Left edge (ft)', maxX: 'Right edge (ft)', minY: 'Bottom edge (ft)', maxY: 'Top edge (ft)' }
  const fields: ReadonlyArray<{ key: 'minX' | 'maxX' | 'minY' | 'maxY'; value: number }> = [
    { key: 'minX', value: crop.min.x },
    { key: 'maxX', value: crop.max.x },
    { key: 'minY', value: crop.min.y },
    { key: 'maxY', value: crop.max.y },
  ]
  return (
    <FieldSet data-testid="crop-properties">
      <FieldLegend variant="label">Crop box</FieldLegend>
      <FieldGroup className="gap-2">
        <Field orientation="horizontal">
          <Checkbox id="vp-crop-on" checked={cropOn} disabled={!canEdit} onCheckedChange={(v) => onQuickCrop({ cropView: v === true }, { cropView: v === true }, v === true ? 'crop the view' : 'stop cropping the view')} />
          <FieldContent>
            <FieldLabel htmlFor="vp-crop-on" className="font-normal">
              Crop view
            </FieldLabel>
            <FieldDescription className="text-xs">{cropOn ? 'Only what is inside the crop box draws and prints.' : 'Showing everything; the viewport on a sheet fits all of it.'}</FieldDescription>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="vp-crop-show" checked={props.showCropBox !== false} disabled={!canEdit} onCheckedChange={(v) => onQuickCrop({ showCropBox: v === true }, { showCropBox: v === true }, v === true ? 'show the crop box' : 'hide the crop box')} />
          <FieldContent>
            <FieldLabel htmlFor="vp-crop-show" className="font-normal">
              Show crop box
            </FieldLabel>
            <FieldDescription className="text-xs">Its boundary and grips show while editing. It never prints.</FieldDescription>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="vp-crop-notes" checked={props.annotationCrop === true} disabled={!canEdit} onCheckedChange={(v) => onQuickCrop({ annotationCrop: v === true }, { annotationCrop: v === true }, v === true ? 'let notes reach past the crop' : 'clip notes at the crop')} />
          <FieldContent>
            <FieldLabel htmlFor="vp-crop-notes" className="font-normal">
              Annotation crop
            </FieldLabel>
            <FieldDescription className="text-xs">Notes, tags and dimensions may reach 1/4&quot; past the crop box instead of being cut at it.</FieldDescription>
          </FieldContent>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          {fields.map((f) => (
            <NumberField
              key={`${f.key}:${f.value}`}
              id={`vp-crop-${f.key}`}
              label={labels[f.key]}
              value={f.value / FT}
              disabled={!canEdit}
              allowNegative
              description=""
              onCommit={(ft) => edge(f.key, ft)}
            />
          ))}
        </div>
        <FieldDescription className="text-xs">
          {disabledHint ?? `${((crop.max.x - crop.min.x) / FT).toFixed(1)} × ${((crop.max.y - crop.min.y) / FT).toFixed(1)} ft. Drag its edges or corners in the view, or the viewport's edges on a sheet.`}
        </FieldDescription>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button variant="outline" size="sm" className="w-full" disabled={!canEdit} onClick={() => onCrop({ fit: true }, 'fit the crop box')}>
                <Scan data-icon="inline-start" />
                {view.viewType === 'detail' ? 'Fit crop to the drawing' : 'Fit crop to content'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledHint ?? (view.viewType === 'detail' ? 'Size the crop box around the lines, text and dimensions drawn here' : 'Size the crop box around everything on this level')}</TooltipContent>
        </Tooltip>
      </FieldGroup>
    </FieldSet>
  )
}

function NumberField({
  id,
  label,
  value,
  disabled,
  description,
  allowNegative = false,
  optional = false,
  placeholder,
  onCommit,
  onClear,
}: {
  id: string
  label: string
  /** Null shows the field blank (optional fields: no value set). */
  value: number | null
  disabled: boolean
  description: string
  allowNegative?: boolean
  /** Blank is allowed and means "no value": `onClear` runs. */
  optional?: boolean
  placeholder?: string
  onCommit: (value: number) => void
  onClear?: () => void
}) {
  const [text, setText] = useState(value === null ? '' : value.toFixed(2).replace(/\.?0+$/, ''))
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    if (text.trim() === '' && optional) {
      setError(null)
      if (value !== null) onClear?.()
      return
    }
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n) || (!allowNegative && n < 0)) {
      setError(optional ? 'Enter a number of feet, like 4 or 4.5, or leave it blank for no limit.' : 'Enter a number of feet, like 4 or 4.5.')
      return
    }
    setError(null)
    if (value === null || Math.abs(n - value) > 1e-6) onCommit(n)
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        className="h-8"
      />
      {(error || description) && <FieldDescription className={error ? 'text-danger-600' : undefined}>{error ?? description}</FieldDescription>}
    </Field>
  )
}
