import type { ComponentType, ReactNode } from 'react'
import type { Command, ElementId, IntakeChoice, ModelState, PartInstance, PartMount, PartTypeDefinition, RunFitting, RunSegment, RunSize, Sheet, StoredDiagramKind, Vec2, ViewElement } from '@permitzip/bim-kernel'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'
import type { ClickHandler, ProposalGhost } from '../model-session'
import type { RibbonCommand, RibbonGroup, RibbonTab } from '../ribbon/types'
import type { ExistingSystem, RouteChoices } from '../RoutePanel'
import type { SubmitCommand } from '../views-sheets/types'

/**
 * What an add-on brings to the Building Model's screens (MODULARITY §7):
 * ribbon tabs, contextual tabs, commands in an existing ribbon group,
 * Inspector sections, rail sections, dialogs and an always-mounted workflow.
 * The screens stay in the host app (closed source) but each is registered under
 * the add-on it belongs to, described by the add-on's own UI data (its
 * package's `ADDON_UI`), and shows only for a model whose add-on set has it.
 * A contribution is data plus a loader (`() => import(...)`), so an add-on's
 * screen code is not in the surface's first load. The host iterates these
 * rows; it never names an add-on. Types only: the slot values live in
 * `slots.ts`, so none of this is in the surface's first load.
 */

/** An add-on's id as models pin it (any pack's manifest id). */
export type AddonId = string

interface ContributionBase {
  readonly addon: AddonId
  /** Unique within its kind: a tab id, a command id, a section id. */
  readonly id: string
  /** What a person sees while it loads or when it can't (the tab's label, the command's label). */
  readonly label: string
}

/** The loaded half of a tab contribution. Null: nothing to show for this context (a contextual tab with nothing selected for it). */
export interface RibbonTabModule {
  readonly build: (ctx: BuildingModelRibbonContext, select: RibbonGroup) => RibbonTab | null
}

/**
 * A ribbon tab. `ribbon-tab` tabs sit after Model in registration order;
 * `contextual-tab` tabs after the selection tab, while they apply.
 */
export interface RibbonTabContribution extends ContributionBase {
  readonly kind: 'ribbon-tab' | 'contextual-tab'
  /** Whether the surface offers this tab now (its inputs are wired); checked before anything loads. */
  readonly applies: (ctx: BuildingModelRibbonContext) => boolean
  readonly load: () => Promise<RibbonTabModule>
  /** The trade the tab's Plan group lists for (`AddonUiManifest` tabs). */
  readonly plan?: string
  /** What New schedule… starts on from this tab. */
  readonly scheduleStart?: string
}

/** Existing ribbon groups an add-on can add a command to. */
export type RibbonCommandTarget =
  /** Sheets › Figures › Live table (beside Load summary). */
  | 'sheet-live-table'
  /** Model › Plan (after Spaces). */
  | 'model-plan'
  /** The add-on's own trade tab › Analyze (its tab › Analyze › one of its studies). */
  | 'trade-analyze'

export interface RibbonCommandModule {
  readonly command: (ctx: BuildingModelRibbonContext) => RibbonCommand
}

export interface RibbonCommandContribution extends ContributionBase {
  readonly kind: 'ribbon-command'
  readonly target: RibbonCommandTarget
  /** Place in the target's menu (lower first; ties keep registration order). */
  readonly order: number
  /** Shown while the command's code loads, with the label. */
  readonly icon: ComponentType
  /** The loaded command's test id, kept while it loads so a locator finds the same control. */
  readonly testId: string
  readonly applies?: (ctx: BuildingModelRibbonContext) => boolean
  readonly load: () => Promise<RibbonCommandModule>
}

/** A slot for a component an add-on brings, with the props the host passes it. */
export interface ComponentSlot<P> {
  /** `workflow-host`: an add-on's always-mounted workflow (dialogs, docked views) that reports its ribbon input, properties and auto tab to the surface through an outlet (`host-slots.tsx`). */
  readonly kind: 'inspector-section' | 'run-section' | 'part-section' | 'route-section' | 'space-loads-section' | 'rail' | 'dialog' | 'workflow-host'
  /** Phantom: ties a slot to its props. */
  readonly props?: (p: P) => void
}

export interface ComponentContribution<P> extends ContributionBase {
  readonly slot: ComponentSlot<P>
  readonly load: () => Promise<ComponentType<P>>
  /** Inspector sections: the element kind the section is for. */
  readonly elementKind?: string
  /** Run sections: where it sits among a run's Properties sections, smallest first; below 0, above the piece's details. */
  readonly order?: number
  /** Workflow hosts: the word in "The … tools are loading". */
  readonly subject?: string
}

/**
 * What a section of a routed run's Properties is given (`run-section`): the
 * run piece, and the run's own resize and command callbacks. A section shows
 * nothing (null) for a piece it isn't for.
 */
export interface RunSectionProps {
  readonly model: ModelState
  readonly element: RunSegment | RunFitting
  readonly canEdit: boolean
  readonly actorName: string
  readonly onCommand: (command: Command) => string | null
  readonly onResize: (segmentId: string, size: RunSize) => string | null
  /** For code lookups (the project's Code Study). */
  readonly projectId?: string
}

/** What a section of the Route tool's form is given (`route-section`): the choices so far, the size they describe (or why none), the model's systems and a patch callback. */
export interface RouteSectionProps {
  readonly choices: RouteChoices
  readonly size: RunSize | string
  readonly systems: readonly ExistingSystem[]
  readonly onChange: (patch: Partial<RouteChoices>) => void
}

/** An open run end a connection into a part could leave from, nearest first. */
export interface FlexCandidate {
  readonly elementId: string
  readonly port: string
  readonly label: string
}

/**
 * What a section of a placed part's Inspector is given (`part-section`): the
 * part and its type, and the part's session edits (how it is mounted, what
 * covers an opening, a flexible connection into a connector). A section shows
 * nothing (null) for a part it isn't for.
 */
export interface PartSectionProps {
  readonly part: PartInstance
  readonly type: PartTypeDefinition
  readonly canEdit: boolean
  readonly onMount: (mount: 'as_drawn' | PartMount) => string | null
  readonly onIntake: (connectorId: string, choice: IntakeChoice | null) => string | null
  readonly flexCandidates: () => readonly FlexCandidate[]
  readonly onFlex: (from: FlexCandidate, connectorId: string) => string | null
}

/** What an Inspector section is given for the selected element. */
export interface InspectorSectionProps {
  readonly model: ModelState
  readonly elementId: string
  readonly canEdit: boolean
  readonly onCommand: (command: Command) => string | null
}

/** What a left-rail section is given while it is open (Model › Plan opens it). */
export interface RailSectionProps {
  readonly model: ModelState | null
  readonly error: string | null
  /** The level the open plan shows; null: the whole model. */
  readonly levelId: ElementId | null
  readonly levelName: string | null
  readonly onSelectSpace: (spaceId: ElementId) => void
  readonly onOpenSpaces: () => void
  readonly onClose: () => void
  /** The host project, so a section reads the project's own library rows over the firm's. */
  readonly projectId?: string | null
}

/** What a section of a space's Properties › Loads is given (`space-loads-section`): the space; a section shows nothing (null) for a space it has nothing to say about. */
export interface SpaceLoadsSectionProps {
  readonly model: ModelState
  readonly spaceId: ElementId
  readonly projectId: string | null
}

/** Places a live table on the sheet: the add-on builds the block; the host gives the sheet, the undoable submit and the level in view. */
export type TablePlacer = (sheet: Sheet, submit: SubmitCommand, levelId: ElementId | null) => { readonly itemId: string } | { readonly refusal: string }

// ---- Workflow hosts

/**
 * What the surface offers every add-on's workflow. An add-on maps it to its
 * own workflow's input in its own folder; the surface builds it once.
 */
export interface WorkflowServices {
  /** The host project (its Code Study). */
  readonly projectId: string
  readonly model: ModelState | null
  readonly selectedIds: readonly string[]
  /** Null when editing is allowed; otherwise why not, in the operator's words. */
  readonly editBlocked: string | null
  /** A sheet or detail drawing is in front, so model tools can't run where the person is. */
  readonly modelToolsOff: boolean
  readonly submit: SubmitCommand
  /** Arm Place part with this type; returns why it can't, or null. */
  readonly placeType: (typeId: string) => string | null
  /** Open Place part on the catalog. */
  readonly choosePlace: () => void
  /** Start the Route tool on this run domain. */
  readonly routeAs: NonNullable<BuildingModelRibbonContext['routeAs']>
  /** The ribbon tab showing. */
  readonly activeTab: string
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  /** The open sheet; null when none is open. */
  readonly openSheetId: string | null
  readonly onOpenSheet: (sheetId: string) => void
  /** Views and sheets › New schedule… asked for the schedule dialog. */
  readonly newScheduleRequested: boolean
  readonly onNewScheduleClosed: () => void
  /** Open the one New schedule window on a pick (`form:<kind>`, `builtin:equipment`): a trade's Documents › schedule button. */
  readonly openNewSchedule?: (pick: string) => void
  /** Open (or make) a live diagram view; returns why it can't, or null. */
  readonly openDiagram: (kind: StoredDiagramKind) => string | null
  /** Show proposed parts as ghosts in the plan (null clears). */
  readonly previewParts: (ghosts: readonly ProposalGhost[] | null) => void
  /** Hear what the pointer is over in the plan or 3D view (ids, null when nothing); returns the unsubscribe. */
  readonly subscribeHover?: (listener: (ids: readonly string[] | null) => void) => () => void
  /** Take plan and 3D clicks before selection (a proposal accepting the room under the pointer); returns the unregister. */
  readonly setClickHandler?: (handler: ClickHandler) => () => void
  /** Frame these plan points. */
  readonly framePlan: (points: readonly Vec2[]) => void
  /** The level the open plan shows. */
  readonly levelId: string | null
  /** Select these elements in the model. */
  readonly select: (ids: readonly string[]) => void
  /** The placed part under a screen point in the plan or 3D view. */
  readonly pickPartAt: (clientX: number, clientY: number) => string | null
  /** The plan point (mm, on the open level) under a screen point; null off the plan. */
  readonly pickPlanPointAt: (clientX: number, clientY: number) => Vec2 | null
  /** Where a plan point on the open level is on screen, in pixels from the canvas's top-left; null when no live model is drawn or it is behind the camera. */
  readonly planPointOnScreen?: (p: Vec2) => { readonly x: number; readonly y: number } | null
  /** Why plan tools (an add-on's Wall, Floor) can't take points on what is open now, in words; null or absent when they can (a sheet with a plan opened on it takes them through its paper). */
  readonly planPointsOff?: string | null
  /** A plan or section is showing its printed drawing: switch it to its live model so a model tool can take clicks. Absent when the live model already shows. */
  readonly showLiveModel?: () => void
  /** Properties cover the canvas's right edge (status lines sit clear of them). */
  readonly propertiesOpen?: boolean
  /** Open the surface's Add level dialog (Architecture › Datums › Level). */
  readonly requestLevel?: () => void
  /** What the model server this model is open on advertised; undefined when no server is attached (an edit gated on a feature stays on). */
  readonly serverFeatures?: readonly string[]
}

/** Values one add-on's workflow lends to shared screens (sizing rules a shared dialog reads). Typed where they are read. */
export type WorkflowShared = Readonly<Record<string, unknown>>

/** What a workflow host reports that the surface draws itself. */
export interface WorkflowData {
  /** The add-on's ribbon tabs' input (`addonInput`). */
  readonly ribbon: unknown
  /** The tab a fresh selection should open; null: the surface decides. */
  readonly autoTab: string | null
  readonly shared: WorkflowShared
}

/** What a workflow host renders where the surface puts it, following every host render. */
export interface WorkflowView {
  readonly data: WorkflowData
  /** Below the selection's properties. */
  readonly properties?: ReactNode
  /** A section of a view's properties (null: nothing for this view). */
  readonly viewProperties?: (view: ViewElement) => ReactNode
}

export interface WorkflowHostProps {
  readonly services: WorkflowServices
  /** Where the host reports each render (`usePublishWorkflow`). */
  readonly outlet: { readonly publish: (view: WorkflowView | null) => void }
}

/**
 * The ribbon input of one add-on, as its tabs read it: what its workflow
 * reported, or why it can't yet (still loading, or failed).
 */
export type AddonInput<T> = { readonly ready: T } | { readonly waiting: string }

// ---- Registration

export type RibbonContribution = RibbonTabContribution | RibbonCommandContribution

/** Everything one add-on's registration module lists. */
export interface AddonContributions {
  readonly ribbon: readonly RibbonContribution[]
  /** Component contributions of any slot; read back typed through `componentContributions(slot)`. */
  readonly components: readonly ComponentContribution<never>[]
}

/** Which add-ons the open model has, as the screens need it. */
export interface AddonAvailability {
  /** In the model's active set (first-party add-ons always are). */
  readonly active: ReadonlySet<AddonId>
  /** Pinned by the model but not on this server: the model has their content, the screens say so. Id → name. */
  readonly notLoaded: ReadonlyMap<AddonId, string>
}

/**
 * An add-on's UI data (`ADDON_UI` in its package): plain rows the host turns
 * into contributions with the add-on's loader map (`contributionsFrom`).
 */
export interface AddonUiManifest {
  readonly addon: AddonId
  readonly name: string
  readonly tabs: readonly {
    readonly id: string
    readonly label: string
    readonly placement: 'ribbon' | 'contextual'
    /** The trade the tab's Plan group lists for (Equipment list, Not placed yet). */
    readonly plan?: string
    /** What New schedule… starts on from this tab. */
    readonly scheduleStart?: string
  }[]
  readonly commands: readonly {
    readonly id: string
    readonly order: number
    readonly label: string
    /** Resolved by the add-on's loader map (`icons`). */
    readonly icon: string
    readonly testId: string
    readonly target: RibbonCommandTarget
  }[]
  readonly slots: readonly {
    readonly slot: ComponentSlot<never>['kind']
    readonly id: string
    readonly label: string
    readonly elementKind?: string
    readonly subject?: string
    readonly order?: number
  }[]
  /**
   * The schedule templates its library rows bring, named for New schedule…
   * while the add-on is off (when it is on, the rows themselves list them).
   */
  readonly scheduleTemplates?: readonly { readonly key: string; readonly name: string }[]
  /**
   * Schedules the add-on docks beside the plan, one record at a time (round
   * 12): its word for the records in the address (`?tab=<kind>:<id>`), the
   * tab's title, what the tab says when the record is gone or editing is off,
   * and the ribbon's per-record entry. Every word is the add-on's; the host's
   * docked tab (`schedule-tab/`) names no trade. Absent: none.
   */
  readonly docks?: readonly DockDeclaration[]
}

export interface DockDeclaration {
  /** The address word (lower case, `[a-z][a-z0-9_]*`). Frozen once links are shared. */
  readonly kind: string
  /** The tab's title ("<Thing> schedule"); the record's name is added after a "·". */
  readonly title: string
  /** Shown when the address names a record the model doesn't have. */
  readonly missing: { readonly title: string; readonly description: string }
  /** What can't be done while editing is off ("you can't edit … on this model."). */
  readonly readOnly: string
  /** The ribbon's per-record entry description; `{name}` is the record's name. */
  readonly openOne: string
}
