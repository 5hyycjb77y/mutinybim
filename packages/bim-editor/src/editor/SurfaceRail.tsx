'use client'

import { memo, useState, type ComponentProps, type ReactNode } from 'react'
import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { DOCUMENT_ZONE, ORGANIZATION_ZONE, organizationOf, type DisplayContext, type GroupVisibility, type ViewElement } from '@permitzip/bim-kernel'
import type { LoadedReference } from '@permitzip/bim-viewer-3d'
import { Checkbox } from '../ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { useLayoutPrefs } from './layout/LayoutPrefsProvider'
import { LayoutSection } from './layout/LayoutSection'
import { RailResizeHandle } from './layout/RailResizeHandle'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { canLinkFrom, linkSourcesOf } from './linked-api'
import { openModelPackSet } from './linked-display/open-model-disciplines'
import type { LinkedDisplay } from './linked-display/use-linked-display'
import type { UnplacedState } from './model-session'
import { GroupVisibilityList } from './organization/GroupVisibilityList'
import { ViewPhaseFields } from './organization/ViewPhaseFields'
import { RoutePanel } from './RoutePanel'
import { LoadingLine } from './LoadingLine'
import { selectModel, selectModelForZones, selectNothing, type ModelStore } from './model-store'
import { stablePropsEqual } from './stable-props'
import { useModelSelector } from './use-model-selector'
import { AddonComponent } from './contributions/AddonComponent'
import { componentContributions } from './contributions/registry'
import { RAIL_SECTION } from './contributions/slots'
import type { RailSectionProps } from './contributions/types'
import { NewViewOrSheetMenu, ViewsSheetsPanel } from './views-sheets/ViewsSheetsPanel'
import { ChecklistRailButton } from './checklist/ChecklistRailButton'

// Off the page's first download (`ui.first_chunk.kb`): the linked-models list (and its link, import and IFC dialogs) and the rooms list load on demand.
const LinkedModels = dynamic(() => import('./LinkedModelsPanel').then((m) => m.LinkedModelsPanel), { ssr: false, loading: () => <LoadingLine label="Loading linked models…" /> })
const RoomsAndSpaces = dynamic(() => import('./spaces/SpacesPanel').then((m) => m.SpacesPanel), { ssr: false, loading: () => <LoadingLine label="Loading rooms and spaces…" /> })
const NotPlacedYetPanel = dynamic(() => import('./planned/NotPlacedYetPanel').then((m) => m.NotPlacedYetPanel), { ssr: false, loading: () => <LoadingLine label="Loading not placed yet…" /> })
const PartsPanel = dynamic(() => import('./PartsPanel').then((m) => m.PartsPanel), { ssr: false, loading: () => <LoadingLine label="Loading parts…" /> })
const LinkedModelDisplaySelect = dynamic(() => import('./linked-display/LinkedModelDisplayControls').then((m) => m.LinkedModelDisplaySelect), { ssr: false, loading: () => <LoadingLine label="Loading display choices…" /> })

/** The rail's saved layout (`bim_ui_layout_prefs.surface`). */
export const RAIL_SURFACE = 'rail'
/** The rail's sections, top to bottom after any open side tool. Ids are saved with the person's layout: never rename one. */
export const RAIL_SECTIONS = { viewsSheets: 'views-sheets', show: 'show', linkedModels: 'linked-models' } as const
export const RAIL_DEFAULT_WIDTH_PX = 288

const DOCUMENT_ZONES: ReadonlySet<string> = new Set([DOCUMENT_ZONE])
const ORGANIZATION_ZONES: ReadonlySet<string> = new Set([ORGANIZATION_ZONE])

type ViewsSheetsProps = ComponentProps<typeof ViewsSheetsPanel>
type SpacesProps = ComponentProps<typeof RoomsAndSpaces>
type NotPlacedProps = ComponentProps<typeof NotPlacedYetPanel>
type LinkedModelsProps = ComponentProps<typeof LinkedModels>

/** A side tool's own props, given while it is open (null: closed). Rebuilt each render, so an open one re-renders as before. */
export type SpacesRailPanel = Omit<SpacesProps, 'model' | 'error' | 'canEdit' | 'blockedReason'>
/** An add-on's rail section, open: its id (`ADDON_UI` slots) and what the surface gives it. */
export interface AddonRailOpen {
  readonly id: string
  readonly props: Omit<RailSectionProps, 'model' | 'error'>
}
export type NotPlacedRailPanel = Omit<NotPlacedProps, 'model' | 'error' | 'canEdit' | 'blockedReason'>

export interface SurfaceRailProps {
  readonly store: ModelStore
  readonly projectId: string
  readonly userId: ViewsSheetsProps['userId']
  readonly loadError: string | null
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly open: ViewsSheetsProps['open']
  readonly onOpen: ViewsSheetsProps['onOpen']
  readonly onRequest: ViewsSheetsProps['onRequest']
  readonly spaces: SpacesRailPanel | null
  readonly addonRail: AddonRailOpen | null
  readonly notPlaced: NotPlacedRailPanel | null
  readonly parts: ComponentProps<typeof PartsPanel> | null
  readonly route: ComponentProps<typeof RoutePanel> | null
  readonly level: string
  readonly onLevel: (level: string) => void
  readonly referenceLevels: readonly string[]
  readonly openView: ViewElement | null
  readonly showDrawing: boolean
  readonly displayContext: DisplayContext
  readonly onGroupVisibility: (groupId: string, visibility: GroupVisibility) => string | null
  readonly freeDisplay: DisplayContext
  readonly onFreeDisplay: (change: Parameters<ComponentProps<typeof ViewPhaseFields>['onChange']>[0]) => void
  readonly onEditFilters: () => void
  readonly references: readonly (LoadedReference & { bytes: number })[]
  readonly linkedDisplay: LinkedDisplay
  readonly unplaced: ReadonlyMap<string, UnplacedState>
  readonly linkOpen: LinkedModelsProps['linkOpen']
  readonly onLinkOpenChange: LinkedModelsProps['onLinkOpenChange']
  readonly onViewChange: LinkedModelsProps['onViewChange']
  readonly onCanEditChange: LinkedModelsProps['onCanEditChange']
  readonly fixtureReferences: LinkedModelsProps['fixtureReferences']
  /** Rail › Checklist (what the code studies say still needs attention). */
  readonly onOpenChecklist?: () => void
}

/**
 * The surface's left rail: side tools, views and sheets, what shows, linked
 * models. Memoised over `useStableHandlers` props and reading the model
 * through selectors, so an edit outside the documents and organization zones
 * (moving a run) does not re-render it while no side tool is open.
 */
export const SurfaceRail = memo<(props: SurfaceRailProps) => ReactNode>(function SurfaceRail(props: SurfaceRailProps): ReactNode {
  const { store, canEdit, blockedReason, loadError, openView, showDrawing, displayContext, linkedDisplay } = props
  const liveNeeded = props.spaces !== null || props.addonRail !== null || props.notPlaced !== null
  const live = useModelSelector(store, liveNeeded ? selectModel : selectNothing)
  // One selector per rail: each remembers the last snapshot version it saw. The surface creates its store once and never replaces it.
  const [documentsSelector] = useState(() => selectModelForZones(DOCUMENT_ZONES))
  const [organizationSelector] = useState(() => selectModelForZones(ORGANIZATION_ZONES))
  const documents = useModelSelector(store, documentsSelector)
  const organization = useModelSelector(store, organizationSelector)
  const prefs = useLayoutPrefs()
  const linkSources = linkSourcesOf(useEditorHost().data.linkedModels)
  const canLink = canLinkFrom(linkSources) || linkSources.autodeskDocs
  const savedWidth = prefs.width(RAIL_SURFACE)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const width = dragWidth ?? savedWidth ?? RAIL_DEFAULT_WIDTH_PX
  return (
    <aside
      className="relative flex shrink-0 flex-col border-r"
      style={{ width }}
      aria-label="Views, sheets and model filters"
      data-testid="building-model-rail"
      data-layout={prefs.status}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {prefs.status === 'error' && (
          <Alert data-testid="rail-layout-load-error">
            <AlertDescription className="text-xs">
              Showing the default layout: {prefs.loadError}.{' '}
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={prefs.retryLoad}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {props.onOpenChecklist && <ChecklistRailButton store={store} onOpen={props.onOpenChecklist} />}
        {/* The side tool the ribbon opened (Spaces, Not placed yet, Parts, Route, an add-on's): first, with its own Close. */}
        {props.spaces && (
          <ToolPanel>
            <RoomsAndSpaces model={live} error={loadError} canEdit={canEdit} blockedReason={blockedReason} projectId={props.projectId} {...props.spaces} />
          </ToolPanel>
        )}
        {props.addonRail && (
          <ToolPanel>
            <AddonRail model={live} error={loadError} open={props.addonRail} />
          </ToolPanel>
        )}
        {props.notPlaced && (
          <ToolPanel>
            <NotPlacedYetPanel model={live} error={loadError} canEdit={canEdit} blockedReason={blockedReason} {...props.notPlaced} />
          </ToolPanel>
        )}
        {props.parts && (
          <ToolPanel>
            <PartsPanel {...props.parts} />
          </ToolPanel>
        )}
        {props.route && (
          <ToolPanel>
            <RoutePanel {...props.route} />
          </ToolPanel>
        )}
        <LayoutSection
          surface={RAIL_SURFACE}
          id={RAIL_SECTIONS.viewsSheets}
          title="Views and sheets"
          testId="views-sheets-panel"
          action={<NewViewOrSheetMenu onRequest={props.onRequest} canEdit={canEdit} blockedReason={blockedReason} />}
        >
          <ViewsSheetsPanel headerless model={documents} canEdit={canEdit} blockedReason={blockedReason} open={props.open} onOpen={props.onOpen} onRequest={props.onRequest} userId={props.userId} />
        </LayoutSection>
        <Separator />
        <LayoutSection surface={RAIL_SURFACE} id={RAIL_SECTIONS.show} title={`Show${openView ? ` in ${openView.name}` : ''}`}>
          <Field>
            <FieldLabel htmlFor="bm-level">Level (3D model)</FieldLabel>
            <Select value={props.level} onValueChange={props.onLevel} disabled={props.referenceLevels.length === 0}>
              <SelectTrigger id="bm-level" size="sm">
                <SelectValue placeholder="All levels" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All levels</SelectItem>
                  {props.referenceLevels.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Groups and phases</FieldLegend>
            {organization && (
              <GroupVisibilityList
                model={organization}
                scope={openView ? openView.name : 'the 3D model'}
                visibility={(id) => displayContext.groupDisplay?.[id] ?? organizationOf(organization).groupById.get(id)?.entry.defaultVisibility ?? 'show'}
                blockedReason={openView && !canEdit ? blockedReason : null}
                onChange={(id, visibility) => props.onGroupVisibility(id, visibility)}
              />
            )}
            {organization && !openView && !showDrawing && (
              <ViewPhaseFields
                idPrefix="free"
                model={organization}
                context={props.freeDisplay}
                disabledReason={null}
                onEditFilters={props.onEditFilters}
                onChange={(change) => {
                  props.onFreeDisplay(change)
                  return null
                }}
              />
            )}
          </FieldSet>
          <FieldSet>
            {/* The Linked models section manages the links; this set only shows or hides them. */}
            <FieldLegend variant="label">Linked models</FieldLegend>
            <FieldGroup className="gap-2">
              {props.references.length === 0 && (
                <p className="text-xs text-muted-foreground" data-testid="references-empty-hint">
                  {canLink ? <>None linked yet. You can model without one; Manage › Link a model brings in the architect&apos;s model when you have it.</> : 'None linked.'}
                </p>
              )}
              {props.references.map((ref) => (
                <Field key={ref.id} orientation="horizontal">
                  <Checkbox
                    id={`bm-ref-${ref.id}`}
                    checked={linkedDisplay.entry(ref.id).resolved.visible}
                    onCheckedChange={(v) => linkedDisplay.setVisible(ref.id, ref.label, v === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`bm-ref-${ref.id}`} className="font-normal">
                      {ref.label}
                    </FieldLabel>
                    <UnplacedNote state={props.unplaced.get(ref.id)} />
                  </FieldContent>
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
        </LayoutSection>
        <Separator />
        <LayoutSection surface={RAIL_SURFACE} id={RAIL_SECTIONS.linkedModels} title="Linked models" meta={props.references.length > 0 ? props.references.length : undefined}>
          <LinkedModels
            headerless
            projectId={props.projectId}
            linkOpen={props.linkOpen}
            onLinkOpenChange={props.onLinkOpenChange}
            onViewChange={props.onViewChange}
            onCanEditChange={props.onCanEditChange}
            fixtureReferences={props.fixtureReferences}
            displayControl={(ref) => <LinkedModelDisplaySelect display={linkedDisplay} referenceId={ref.id} label={ref.label} />}
            disciplineSet={() => openModelPackSet(props.store)}
          />
        </LayoutSection>
      </div>
      <RailResizeHandle edge="right" ariaLabel="Resize the left sidebar" width={width} defaultWidth={RAIL_DEFAULT_WIDTH_PX} onPreview={setDragWidth} onCommit={(px) => prefs.setWidth(RAIL_SURFACE, px)} />
    </aside>
  )
}, stablePropsEqual)

/** A side tool the ribbon opened: framed the same way whichever it is, above the rail's sections. */
function ToolPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-md border bg-card p-2" data-testid="rail-tool-panel">
      {children}
    </div>
  )
}

function UnplacedNote({ state }: { state: UnplacedState | undefined }) {
  if (state?.status === 'ready' && state.count > 0) {
    return (
      <FieldDescription className="text-xs">
        {state.count} device{state.count === 1 ? '' : 's'} with no 3D shape shown as symbols
      </FieldDescription>
    )
  }
  if (state?.status === 'error') {
    return (
      <FieldDescription className="text-xs text-danger-600" role="alert">
        {state.message}
      </FieldDescription>
    )
  }
  return null
}

/** An add-on's rail section (Model › Plan opens it): loading and a failed load show in the rail. */
function AddonRail({ model, error, open }: { model: RailSectionProps['model']; error: string | null; open: AddonRailOpen }) {
  const contribution = componentContributions(RAIL_SECTION).find((c) => c.id === open.id)
  if (!contribution) {
    console.error('[SurfaceRail] no rail section is registered under this id', { id: open.id })
    return null
  }
  return <AddonComponent contribution={contribution} props={{ model, error, ...open.props }} />
}
