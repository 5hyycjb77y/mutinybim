'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SyncScheduleConnection, type ActorRef, type ScheduleTarget } from '@permitzip/bim-sync'
import { ScheduleColumnsSheet, ScheduleBuilder, ScheduleGrid, type BuilderSection, type ScheduleColumnStep, type ScheduleConnection as GridScheduleConnection, type ScheduleTarget as GridScheduleTarget } from '@permitzip/bim-schedules-ui'
import { formulaEngine } from '@permitzip/bim-formula'
import { scheduleStepsBetween } from '@permitzip/bim-kernel/schedules'
import { toast } from 'sonner'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { libraryPortFrom } from '../../contracts/bim/library/http-library-port'
import type { SubmitCommand } from '../views-sheets/types'
import { registryCatalog } from './registry-catalog'
import { viewScheduleDefinition } from './schedule-planner'
import { documentIndex, type Command, type ModelState, type ScheduleDefinitionV2, type ViewElement } from '@permitzip/bim-kernel'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Button } from '../../ui/button'
import { FileText } from 'lucide-react'
import { Spinner } from '../../ui/spinner'
import type { ModelSession } from '../model-session'
import { KernelCellPlanner } from './schedule-planner'
import { useSchedulePrefsFrom } from './use-schedule-prefs'
import { isTakeoffSchedule, PriceWith } from './PriceWith'
import { ShowMainBeside } from '../branches/ShowMainBeside'
import type { BranchChannel } from '../branches/useBranches'

const PRESENCE_COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'] as const

/** A steady colour per person, so the same colleague's outline looks the same every time. */
export function presenceColor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0]
}

interface Props {
  readonly projectId: string
  readonly session: ModelSession | null
  /** True once the model server has welcomed this tab (the grid subscribes then). */
  readonly connected: boolean
  readonly view: ViewElement
  readonly actor: { readonly id: string; readonly name: string }
  /** The model as this person sees it (their unsaved edits included). */
  readonly model: ModelState | null
  /** Leave the grid and select these in the live 3D model. */
  readonly onShowInModel: (elementIds: readonly string[]) => void
  readonly onUndo: () => void
  readonly onRedo: () => void
  /** Saves a view edit as one undo step; returns why it was refused, or null. */
  readonly submit: SubmitCommand
  /** Null when this person may change the schedule; otherwise why not. */
  readonly editBlocked: string | null
  /** The model socket for branch reads: on a branch, Show Main beside compares this schedule with Main. */
  readonly branchChannel?: BranchChannel | null
  /** Open a sheet (a form schedule is read and edited where it is drawn). */
  readonly onOpenSheet?: (sheetId: string) => void
}

/**
 * A Building Model schedule view as a live spreadsheet (SCHEDULES-PLAN §6–§7).
 * Rows come from the model server for the whole building; a cell edit goes
 * through the kernel's field writer and saves as one undoable change.
 */
export function ModelSchedulePane({ projectId, session, connected, view, actor, model, onShowInModel, onUndo, onRedo, submit, editBlocked, branchChannel = null, onOpenSheet }: Props) {
  const client = connected ? session?.scheduleClient() ?? null : null
  const modelRef = useLatest(model)
  const undoRef = useLatest({ onUndo, onRedo })
  const [connection, setConnection] = useState<SyncScheduleConnection | null>(null)

  useEffect(() => {
    if (!client) return
    const actorRef: ActorRef = { id: actor.id, name: actor.name, color: presenceColor(actor.id) }
    const planner = new KernelCellPlanner({ model: () => modelRef.current })
    const next = new SyncScheduleConnection(client, actorRef, { planner, onUndo: () => undoRef.current.onUndo(), onRedo: () => undoRef.current.onRedo() })
    setConnection(next)
    return () => {
      next.dispose()
      setConnection(null)
    }
  }, [client, actor.id, actor.name, modelRef, undoRef])

  const gridConnection = useMemo(() => (connection ? toGridConnection(connection) : null), [connection])
  const target = useMemo<GridScheduleTarget>(() => ({ viewId: view.id }), [view.id])
  const data = useEditorHost().data
  const prefs = useSchedulePrefsFrom(data.schedulePrefs, projectId, view.id)
  // The builder edits the schedule as it was when opened: later model updates don't reset what the person is changing.
  const [builder, setBuilder] = useState<{ section: BuilderSection; definition: ScheduleDefinitionV2 } | null>(null)
  const catalog = useMemo(() => registryCatalog(undefined, model), [model])
  const firmLibrary = data.firmLibrary
  const library = useMemo(() => libraryPortFrom(firmLibrary), [firmLibrary])
  const definition = useMemo(() => (model ? viewScheduleDefinition(model, view.id) : null), [model, view.id])
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnFields = useMemo(() => (definition?.source.kind === 'classes' ? catalog.fieldsFor(definition.source.classes) : []), [catalog, definition])
  // Every column change is the kernel's edit_schedule: the same step the agent and scripts send, one undo each.
  const sendSteps = (steps: readonly ScheduleColumnStep[], label: string): string | null => submit(editScheduleCommand(view.id, steps), label)

  if (!gridConnection) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="model-schedule-connecting">
        <Spinner />
        Connecting to the model server to load {view.name}…
      </div>
    )
  }
  if (!view.props?.schedule && !view.props?.scheduleV2) return <FormScheduleOpens view={view} model={model} onOpenSheet={onOpenSheet} />
  return (
    <div className="h-full overflow-auto p-3" data-testid="model-schedule-grid">
      {isTakeoffSchedule(definition) && <PriceWith projectId={projectId} model={model} />}
      <ShowMainBeside channel={branchChannel} model={model} viewId={view.id} onShowInModel={onShowInModel} />
      {prefs.loaded ? (
        <ScheduleGrid
          key={view.id}
          connection={gridConnection}
          target={target}
          title={view.name}
          height={640}
          onShowInModel={onShowInModel}
          onOpenBuilder={editBlocked || !definition ? undefined : (section) => setBuilder({ section, definition })}
          onOpenColumns={definition ? () => setColumnsOpen(true) : undefined}
          onGoToSource={(_column, _cell, elementId) => {
            if (elementId) onShowInModel([elementId])
          }}
          columnWidths={prefs.columnWidths}
          onColumnWidthsChange={prefs.saveColumnWidths}
        />
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Loading {view.name}…
        </div>
      )}
      {builder && (
        <ScheduleBuilder
          open
          onOpenChange={(open) => !open && setBuilder(null)}
          catalog={catalog}
          formulaEngine={formulaEngine}
          library={library}
          initial={builder.definition}
          section={builder.section}
          onSave={(next) => {
            // Column, filter, sort, group and total changes are the same steps the Columns sheet sends; a new source or name saves whole.
            const steps = scheduleStepsBetween(builder.definition, next)
            if (steps && steps.length === 0) {
              setBuilder(null)
              return
            }
            const refused = steps ? sendSteps(steps, `change ${view.name}`) : submit({ type: 'set_view_properties', viewId: view.id, props: { scheduleV2: next } }, `change ${view.name}`)
            if (refused) {
              toast.error(`${view.name} wasn't changed: ${refused}`)
              return
            }
            setBuilder(null)
          }}
        />
      )}
      {columnsOpen && definition && (
        <ScheduleColumnsSheet
          open
          onOpenChange={setColumnsOpen}
          definition={definition}
          fields={columnFields}
          blocked={editBlocked}
          onStep={(step, label) => sendSteps([step], `${label} in ${view.name}`)}
          onMore={
            editBlocked
              ? undefined
              : () => {
                  setColumnsOpen(false)
                  setBuilder({ section: 'fields', definition })
                }
          }
        />
      )}
    </div>
  )
}

type EditStep = Extract<Command, { type: 'edit_schedule' }>['steps'][number]

/** The grid's step as the command carries it (the same shape; the command's lists are its own copies). */
function commandStep(step: ScheduleColumnStep): EditStep {
  switch (step.op) {
    case 'filter':
      return { op: 'filter', filters: [...step.filters] }
    case 'sort':
      return { op: 'sort', sort: [...step.sort] }
    case 'group':
      return { op: 'group', groups: [...step.groups] }
    default:
      return step
  }
}

/**
 * A form schedule (slots, rows laid out by its template) is read and changed
 * where it is drawn: its sheet. This says so and opens that sheet, or says
 * how to place it, instead of a dead end.
 */
export function FormScheduleOpens({ view, model, onOpenSheet }: { readonly view: ViewElement; readonly model: ModelState | null; readonly onOpenSheet?: (sheetId: string) => void }) {
  const viewport = model ? documentIndex(model).viewportByView.get(view.id) : undefined
  const sheet = viewport && model ? documentIndex(model).sheets.find((s) => s.id === viewport.sheetId) : undefined
  return (
    <Empty data-testid="model-schedule-form-only">
      <EmptyHeader>
        <EmptyTitle>{view.name} is laid out by its form</EmptyTitle>
        <EmptyDescription>
          {sheet ? `It is drawn on ${sheet.number} · ${sheet.title}; open that sheet to read it and change it (its template and rules are in its properties).` : 'Put it on a sheet from its properties (Place on sheet), then open that sheet to read it.'}
        </EmptyDescription>
      </EmptyHeader>
      {sheet && onOpenSheet && (
        <EmptyContent>
          <Button onClick={() => onOpenSheet(sheet.id)} data-testid="model-schedule-open-sheet">
            <FileText data-icon="inline-start" />
            Open {sheet.number}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

/** One `edit_schedule` command: one undo step, however many steps it carries. */
export function editScheduleCommand(viewId: string, steps: readonly ScheduleColumnStep[]): Command {
  return { type: 'edit_schedule', viewId, steps: steps.map(commandStep) }
}

/**
 * The grid's connection over the live-sync one. The two packages describe an
 * ad hoc definition differently on the wire (the grid's typed definition,
 * the protocol's plain JSON object); a saved view is the same id on both.
 */
export function toGridConnection(connection: SyncScheduleConnection): GridScheduleConnection {
  return {
    actor: connection.actor,
    open: (target, listener) => {
      const wire: ScheduleTarget = 'viewId' in target ? { viewId: target.viewId } : { definition: Object.fromEntries(Object.entries(target.definition)) }
      return connection.open(wire, listener)
    },
  }
}

function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
