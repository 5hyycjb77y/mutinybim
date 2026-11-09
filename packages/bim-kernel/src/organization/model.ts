import { GLOBAL_LEVEL, partitionMembers } from "../partition";
import { elementReader, slotReaderOf } from "../store";
import type { BimElement, ElementId, ModelState, Partition, Vec2, ViewElement } from "../types";
import type { DisciplineDef } from "../disciplines/types";
import type { PackDigest, PackTier } from "../packs/pin";

/**
 * Groups and phases: how a model is organised beyond levels and disciplines.
 *
 * A group is a named bucket every model element belongs to (General, New
 * work, Demolition…). Views show, hide or halftone a group, and a locked group
 * refuses edits. A phase is a step in time (Existing, New construction);
 * every element is created in one phase and may be demolished in a later one.
 * A view shows the model as of its phase through a phase filter, which says
 * how new, existing, demolished and temporary elements draw.
 *
 * The lists are model elements of kind `organization`, one per group, phase
 * or filter, plus one settings element (the active group and phase), so they
 * sync, conflict and undo like everything else. A model with none of them
 * uses the built-in defaults below; editing a default stores it under the
 * same id. Elements with no `groupId` are in General, and elements with no
 * `phaseCreated` are New construction, so models made before this existed
 * read correctly without rewriting a single element.
 */

export type GroupVisibility = "show" | "halftone" | "hide";
export const GROUP_VISIBILITIES = ["show", "halftone", "hide"] as const satisfies readonly GroupVisibility[];

/** Where an element stands in a view's phase. */
export type PhaseStatus = "new" | "existing" | "demolished" | "temporary";
export const PHASE_STATUSES = ["new", "existing", "demolished", "temporary"] as const satisfies readonly PhaseStatus[];

export type PhaseDisplay = "show" | "halftone" | "dashed" | "hide";
export const PHASE_DISPLAYS = ["show", "halftone", "dashed", "hide"] as const satisfies readonly PhaseDisplay[];

export interface GroupEntry {
  readonly type: "group";
  readonly name: string;
  /** #rrggbb, for swatches in lists and the status bar. */
  readonly color: string;
  readonly description: string;
  readonly locked: boolean;
  /** How views without their own setting show the group. */
  readonly defaultVisibility: GroupVisibility;
  /** Sort position; fractional so a move rewrites one record. */
  readonly order: number;
  /** The group is a typical unit or bay, drawn and counted once per copy (`organization/typicals.ts`). */
  readonly typical?: TypicalSpec;
}

/** One more instance of a typical: the original moved by `offset` after turning `rotationDeg` about the base point. */
export interface TypicalCopy {
  readonly id: string;
  /** What it is called on drawings ("002"); replaces the original's mark in names ("A001" reads "A002"). */
  readonly mark: string;
  readonly offset: Vec2;
  readonly rotationDeg: number;
  /**
   * Contract 1.10.0: the copy is a mirror image of the original, flipped
   * about the base point across the named axis before it turns and moves
   * (`x`: left for right; `y`: front for back). Absent: not mirrored, so
   * copies stored before 1.10.0 read unchanged. Written only when every peer
   * advertises `TYPICALS_MIRROR_FEATURE`.
   */
  readonly mirror?: { readonly axis: "x" | "y" };
}

/** Peers that draw and check mirrored typical copies. A mirrored copy is written only when every peer advertises it. */
export const TYPICALS_MIRROR_FEATURE = "typicals:mirror";

export interface TypicalSpec {
  /** What one is called ("Unit", "Bay"). */
  readonly label: string;
  /** The original's mark ("001"). */
  readonly mark: string;
  /** Copies turn about this point, model mm. */
  readonly basePoint: Vec2;
  readonly copies: readonly TypicalCopy[];
  /**
   * How copies land on a 3-phase source's phases: "rotate" spreads them (the
   * original's 2-pole feeder on A-B, copy 2 on B-C, copy 3 on C-A…), "same"
   * puts every copy on the original's phases. Absent: rotate where the
   * typical is fed through a feeder (unit panels off a house panel), same for
   * its devices circuited straight from outside.
   */
  readonly phaseRotation?: "rotate" | "same";
}

export interface PhaseEntry {
  readonly type: "phase";
  readonly name: string;
  /** Time order: lower comes first. Fractional so inserting rewrites one record. */
  readonly order: number;
}

export interface PhaseFilterEntry {
  readonly type: "phase_filter";
  readonly name: string;
  readonly statuses: Readonly<Record<PhaseStatus, PhaseDisplay>>;
  readonly order: number;
}

export interface OrganizationSettingsEntry {
  readonly type: "settings";
  /** New elements go in this group. */
  readonly activeGroupId: string;
  /** New elements are created in this phase. */
  readonly activePhaseId: string;
  /** How many typical types the contract covers (STATUS decision 15). Absent: `DEFAULT_TYPICAL_CAP`. More than this is a warning, never a refusal. */
  readonly typicalCap?: number;
  /** Sheets print black only (a black-only plotter): colours print black, halftone and fills stay grey. Absent: colour. */
  readonly printBlackOnly?: boolean;
}

/** Peers that store the project's black-only printing choice (`set_print_black_only`). */
export const DOCUMENTS_PRINT_BLACK_ONLY_FEATURE = "documents:print_black_only";

/** The contract's default cap on typical types (STATUS decision 15: warn above 10). */
export const DEFAULT_TYPICAL_CAP = 10;

/** What a tag style can be the default for: new tags on that kind of element take it. */
export const TAG_STYLE_CATEGORIES = ["duct", "pipe", "air_terminal", "equipment", "fixture", "part", "room", "space"] as const;
/**
 * Peers that store a tag's opaque background (`mask`), its own leader choice
 * over its style's (`leaderOverride`), the `name_number` template and room and
 * space tag styles (batch 16-B). An older peer's strict schema refuses them,
 * so a writer asks first.
 */
export const TAGS_MASK_LEADER_FEATURE = "annotation:tag_mask_leader";
/** Kinds only peers advertising `TAGS_MASK_LEADER_FEATURE` store on a tag style. */
export const TAG_STYLE_CATEGORIES_B16: readonly TagStyleCategory[] = ["room", "space"];
export type TagStyleCategory = (typeof TAG_STYLE_CATEGORIES)[number];

/** The outline drawn round a tag's words. `box` is the square-cornered box every older style has. */
export const TAG_STYLE_BOXES = ["box", "none", "rounded", "circle", "hexagon", "diamond"] as const;
export type TagStyleBox = (typeof TAG_STYLE_BOXES)[number];

/** horizontal: words read across the sheet. along: they turn with the element (a duct's run), never upside down or reading downward. */
export const TAG_STYLE_ORIENTATIONS = ["horizontal", "along"] as const;
export type TagStyleOrientation = (typeof TAG_STYLE_ORIENTATIONS)[number];

/** How lengths and heights print in a tag ({length}, {elevation}). */
export const TAG_STYLE_UNITS = ["ft_in", "ft", "in", "mm", "m"] as const;
export type TagStyleUnits = (typeof TAG_STYLE_UNITS)[number];

export const TAG_LEADER_ENDS = ["dot", "arrow", "tick", "none"] as const;
export type TagLeaderEnd = (typeof TAG_LEADER_ENDS)[number];

/**
 * An arrow a tag draws beside its words, along the run it labels: towards the
 * run's lower end (`down_slope`) or its higher end (`up_slope`), as the run
 * reads on that view's paper (a turned plan turns the arrow with it). A level
 * run, or one seen end-on, draws none.
 */
export const TAG_STYLE_ARROWS = ["down_slope", "up_slope"] as const;
export type TagStyleArrow = (typeof TAG_STYLE_ARROWS)[number];
/** Peers that store a tag style's `arrow`. An older peer's strict schema refuses it, so a writer asks first. */
export const TAGS_SLOPE_ARROW_FEATURE = "annotation:tag_slope_arrow";

/**
 * A named, reusable tag look. Each line is a template: words plus `{field}`
 * placeholders read from the tagged element (`{size}`, `{insulation}`,
 * `{cfm}`, a part's own parameter names…). Tags that name the style draw from
 * it, so editing the style changes every one of them.
 */
export interface TagStyleEntry {
  readonly type: "tag_style";
  readonly name: string;
  readonly lines: readonly string[];
  /** Cap height on paper, mm. */
  readonly textSizeMm: number;
  readonly leader: boolean;
  readonly box: TagStyleBox;
  /** Kinds of element whose new tags use this style. A kind is the default of one style at most. */
  readonly defaultFor: readonly TagStyleCategory[];
  readonly order: number;
  /** Printed before the first line and after the last (`(E) `, ` TYP.`). */
  readonly prefix?: string;
  readonly suffix?: string;
  /** Absent: horizontal. */
  readonly orientation?: TagStyleOrientation;
  /** Absent: feet and inches. */
  readonly units?: TagStyleUnits;
  /** The leader's end at the element. Absent: a dot. */
  readonly leaderEnd?: TagLeaderEnd;
  /** Kinds of element the style is offered for and may label. Absent or empty: any. */
  readonly appliesTo?: readonly TagStyleCategory[];
  /** An arrow along the labelled run, towards its lower or higher end. Absent: none. */
  readonly arrow?: TagStyleArrow;
}

/**
 * Model setup (round 8): an add-on this model uses or has switched off,
 * beyond `ModelSettings.packs`. One record per add-on id, so a switch, its
 * undo and an agent's switch are ordinary edits. Written only to peers that
 * advertise `organization:setup`; older readers skip the entry type.
 */
export interface AddonSetupEntry {
  readonly type: "addon";
  readonly packId: string;
  /** The exact version the model opens with while it is on. */
  readonly version: string;
  /** Off: the add-on's rows are hidden on this model; nothing it wrote is deleted. */
  readonly on: boolean;
  /**
   * An outside add-on's reviewed build and trust tier (round 11, `packs:outside_pins`), carried
   * into the model's pins so a switch never loses which build it pinned. Absent on entries written
   * before round 11 and for the host's own add-ons. Read as stored (a reader never guesses one).
   */
  readonly digest?: PackDigest;
  readonly tier?: PackTier;
}

/**
 * A firm discipline pinned to this model (round 8): a copy of the firm
 * library's row taken when it was pinned, so it travels with the model and
 * the model server never reads the library. Same gate as `AddonSetupEntry`.
 */
export interface DisciplineSetupEntry {
  readonly type: "discipline";
  readonly discipline: DisciplineDef;
}

/**
 * One project parameter's value (`project-parameters.ts`): stated once for the
 * project, printed on every sheet. A parameter outside the standard list
 * carries its own definition. Written only to peers that advertise
 * `organization:project_parameters`; older readers skip the entry type.
 */
export interface ProjectParameterEntry {
  readonly type: "project_parameter";
  readonly key: string;
  /** Stored form: dates YYYY-MM-DD, a choice as listed. */
  readonly value: string;
  readonly def?: { readonly label: string; readonly valueType: "text" | "date" | "choice"; readonly choices?: readonly string[] };
}

export type OrganizationEntry = GroupEntry | PhaseEntry | PhaseFilterEntry | OrganizationSettingsEntry | TagStyleEntry | AddonSetupEntry | DisciplineSetupEntry | ProjectParameterEntry;

/** Model-wide: every area loads these, like levels and part types. */
export const ORGANIZATION_ZONE = "organization";
export const ORGANIZATION_PARTITION: Partition = { level: GLOBAL_LEVEL, zone: ORGANIZATION_ZONE, discipline: "architecture" };

export const DEFAULT_GROUP_ID = "grp-general";
export const DEFAULT_PHASE_ID = "phase-new";
export const DEFAULT_PHASE_FILTER_ID = "pf-all";
export const ORGANIZATION_SETTINGS_ID = "organization-settings";

export const DEFAULT_GROUPS: ReadonlyArray<{ readonly id: string; readonly entry: GroupEntry }> = [
  { id: DEFAULT_GROUP_ID, entry: { type: "group", name: "General", color: "#64748b", description: "Everything not put in another group.", locked: false, defaultVisibility: "show", order: 0 } },
  { id: "grp-existing", entry: { type: "group", name: "Existing to remain", color: "#a16207", description: "Existing work that stays.", locked: false, defaultVisibility: "show", order: 1 } },
  { id: "grp-new", entry: { type: "group", name: "New work", color: "#2563eb", description: "Work this project adds.", locked: false, defaultVisibility: "show", order: 2 } },
  { id: "grp-demolition", entry: { type: "group", name: "Demolition", color: "#dc2626", description: "Work this project removes.", locked: false, defaultVisibility: "show", order: 3 } },
  { id: "grp-coordination", entry: { type: "group", name: "Coordination", color: "#7c3aed", description: "Clearance zones, markups and other coordination aids.", locked: false, defaultVisibility: "show", order: 4 } },
];

export const DEFAULT_PHASES: ReadonlyArray<{ readonly id: string; readonly entry: PhaseEntry }> = [
  { id: "phase-existing", entry: { type: "phase", name: "Existing", order: 0 } },
  { id: DEFAULT_PHASE_ID, entry: { type: "phase", name: "New construction", order: 1 } },
];

export const DEFAULT_PHASE_FILTERS: ReadonlyArray<{ readonly id: string; readonly entry: PhaseFilterEntry }> = [
  { id: DEFAULT_PHASE_FILTER_ID, entry: { type: "phase_filter", name: "Show all", statuses: { new: "show", existing: "halftone", demolished: "dashed", temporary: "show" }, order: 0 } },
  { id: "pf-new", entry: { type: "phase_filter", name: "Show new", statuses: { new: "show", existing: "hide", demolished: "hide", temporary: "show" }, order: 1 } },
  { id: "pf-existing-demo", entry: { type: "phase_filter", name: "Show existing + demo", statuses: { new: "hide", existing: "show", demolished: "dashed", temporary: "hide" }, order: 2 } },
  { id: "pf-complete", entry: { type: "phase_filter", name: "Show complete", statuses: { new: "show", existing: "show", demolished: "hide", temporary: "hide" }, order: 3 } },
];

/** Two starting styles; neither is anyone's default until a person makes it so. */
export const DEFAULT_TAG_STYLES: ReadonlyArray<{ readonly id: string; readonly entry: TagStyleEntry }> = [
  { id: "tst-duct-size-insulation", entry: { type: "tag_style", name: "Duct size and insulation", lines: ["{size_with_insulation}"], textSizeMm: 2.4, leader: false, box: "none", defaultFor: [], order: 0 } },
  { id: "tst-terminal-mark-cfm", entry: { type: "tag_style", name: "Air terminal mark and CFM", lines: ["{mark}", "{cfm} CFM"], textSizeMm: 2.4, leader: false, box: "box", defaultFor: [], order: 1 } },
];

const DEFAULT_SETTINGS: OrganizationSettingsEntry = { type: "settings", activeGroupId: DEFAULT_GROUP_ID, activePhaseId: DEFAULT_PHASE_ID };

export interface Resolved<E> {
  readonly id: string;
  readonly entry: E;
  /** True while it is still the built-in default (nothing stored for it). */
  readonly builtIn: boolean;
}

export interface Organization {
  /** Live groups, in order. */
  readonly groups: readonly Resolved<GroupEntry>[];
  readonly groupById: ReadonlyMap<string, Resolved<GroupEntry>>;
  /** Live phases, earliest first. */
  readonly phases: readonly Resolved<PhaseEntry>[];
  /** Position of each live phase in time. */
  readonly phaseIndex: ReadonlyMap<string, number>;
  readonly filters: readonly Resolved<PhaseFilterEntry>[];
  readonly filterById: ReadonlyMap<string, Resolved<PhaseFilterEntry>>;
  readonly tagStyles: readonly Resolved<TagStyleEntry>[];
  readonly tagStyleById: ReadonlyMap<string, Resolved<TagStyleEntry>>;
  /** Active group and phase, falling back to the defaults if theirs was removed. */
  readonly activeGroupId: string;
  readonly activePhaseId: string;
  /** How many typical types the contract covers (the setting, else `DEFAULT_TYPICAL_CAP`). */
  readonly typicalCap: number;
  /** Sheets print black only (the project's choice; false: colour). */
  readonly printBlackOnly: boolean;
  /** Add-on switches stored on this model (`organization/setup.ts` resolves them with `settings.packs`). */
  readonly addons: readonly Resolved<AddonSetupEntry>[];
  /** Firm disciplines pinned to this model. */
  readonly pinnedDisciplines: readonly Resolved<DisciplineSetupEntry>[];
  /** Project parameter values stored on this model (`project-parameters.ts` reads them with their definitions). */
  readonly projectParameters: readonly Resolved<ProjectParameterEntry>[];
  /** Every stored organization element, by id, deleted ones included (commands edit these). */
  readonly stored: ReadonlyMap<string, OrganizationElementRecord>;
}

/** The stored shape (kept here so the kernel's element union can import it type-only). */
export interface OrganizationElementRecord {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: Readonly<Record<string, number>>;
  readonly partition?: Partition;
  /** Shared element fields; organization records never use them (`isOrganized` is false). */
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
  readonly kind: "organization";
  readonly entry: OrganizationEntry;
  readonly deleted?: boolean;
}

const cache = new WeakMap<object, Organization>();

function merge<E extends OrganizationEntry>(defaults: ReadonlyArray<{ id: string; entry: E }>, stored: ReadonlyMap<string, OrganizationElementRecord>, type: E["type"]): Resolved<E>[] {
  const out: Resolved<E>[] = [];
  const seen = new Set<string>();
  for (const d of defaults) {
    seen.add(d.id);
    const s = stored.get(d.id);
    if (!s) out.push({ id: d.id, entry: d.entry, builtIn: true });
    else if (!s.deleted && s.entry.type === type) out.push({ id: d.id, entry: s.entry as E, builtIn: false });
  }
  for (const s of stored.values()) {
    if (seen.has(s.id) || s.deleted || s.entry.type !== type) continue;
    out.push({ id: s.id, entry: s.entry as E, builtIn: false });
  }
  return out.sort((a, b) => order(a.entry) - order(b.entry) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function order(entry: OrganizationEntry): number {
  return "order" in entry ? entry.order : 0;
}

/**
 * The model's groups, phases and filters with defaults applied. Reads only the
 * organization partition through the shared partition index; cached per
 * element record.
 */
export function organizationOf(model: Pick<ModelState, "elements" | "connections">): Organization {
  const cached = cache.get(model.elements);
  if (cached) return cached;
  const stored = new Map<string, OrganizationElementRecord>();
  for (const el of partitionMembers(model, (p) => p.zone === ORGANIZATION_ZONE)) {
    if (el.kind === "organization") stored.set(el.id, el);
  }
  const groups = merge(DEFAULT_GROUPS, stored, "group");
  const phases = merge(DEFAULT_PHASES, stored, "phase");
  const filters = merge(DEFAULT_PHASE_FILTERS, stored, "phase_filter");
  const tagStyles = merge(DEFAULT_TAG_STYLES, stored, "tag_style");
  const settingsRecord = stored.get(ORGANIZATION_SETTINGS_ID);
  const settings = settingsRecord?.entry.type === "settings" ? settingsRecord.entry : DEFAULT_SETTINGS;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const phaseIndex = new Map(phases.map((p, i) => [p.id, i]));
  const org: Organization = {
    groups,
    groupById,
    phases,
    phaseIndex,
    filters,
    filterById: new Map(filters.map((f) => [f.id, f])),
    tagStyles,
    tagStyleById: new Map(tagStyles.map((s) => [s.id, s])),
    activeGroupId: groupById.has(settings.activeGroupId) ? settings.activeGroupId : DEFAULT_GROUP_ID,
    activePhaseId: phaseIndex.has(settings.activePhaseId) ? settings.activePhaseId : (phases[phases.length - 1]?.id ?? DEFAULT_PHASE_ID),
    typicalCap: settings.typicalCap ?? DEFAULT_TYPICAL_CAP,
    printBlackOnly: settings.printBlackOnly === true,
    addons: merge<AddonSetupEntry>([], stored, "addon"),
    pinnedDisciplines: merge<DisciplineSetupEntry>([], stored, "discipline"),
    projectParameters: merge<ProjectParameterEntry>([], stored, "project_parameter"),
    stored,
  };
  cache.set(model.elements, org);
  return org;
}

/**
 * Carry a model's organization to a record produced from it by a command that
 * touched no organization element, so reading groups on the result never
 * re-indexes the whole model. O(touched).
 */
export function carryOrganization(from: Readonly<Record<string, BimElement>>, to: Readonly<Record<string, BimElement>>, touched: Iterable<string>): void {
  const org = cache.get(from);
  if (!org || from === to || cache.has(to)) return;
  for (const id of touched) {
    if (from[id]?.kind === "organization" || to[id]?.kind === "organization") return;
  }
  cache.set(to, org);
}

/** Kinds that are not model content: they belong to no group and no phase. */
const UNORGANIZED_KINDS: ReadonlySet<BimElement["kind"]> = new Set([
  "view",
  "sheet",
  "viewport",
  "drawing_item",
  "tag",
  "dimension",
  "level",
  "part_type",
  "element_type",
  "mep_system",
  "organization",
]);

/** Model content that carries a group and phases (ducts, pipes, parts, walls…). */
export function isOrganized(el: BimElement): boolean {
  return !UNORGANIZED_KINDS.has(el.kind);
}

/** The group an element is in (General when it names none or a removed one). */
export function groupIdOf(org: Organization, el: BimElement): string {
  const id = el.groupId;
  return id !== undefined && org.groupById.has(id) ? id : DEFAULT_GROUP_ID;
}

/** The element's group record. */
export function groupOf(org: Organization, el: BimElement): Resolved<GroupEntry> {
  return org.groupById.get(groupIdOf(org, el)) ?? org.groups[0] ?? { id: DEFAULT_GROUP_ID, entry: DEFAULT_GROUPS[0]!.entry, builtIn: true };
}

export function phaseCreatedOf(org: Organization, el: BimElement): string {
  return phaseCreatedOfIds(org, el.phaseCreated);
}

function phaseCreatedOfIds(org: Organization, id: string | undefined): string {
  if (id !== undefined && org.phaseIndex.has(id)) return id;
  return org.phaseIndex.has(DEFAULT_PHASE_ID) ? DEFAULT_PHASE_ID : (org.phases[org.phases.length - 1]?.id ?? DEFAULT_PHASE_ID);
}

export function phaseDemolishedOf(org: Organization, el: BimElement): string | null {
  const id = el.phaseDemolished;
  return id !== undefined && org.phaseIndex.has(id) ? id : null;
}

/**
 * Where an element stands as of phase index `at`: created later (future) or
 * demolished earlier (gone) never draw; otherwise new, existing, demolished
 * in this phase, or temporary (created and demolished in this phase).
 */
export function phaseStatusAt(org: Organization, el: BimElement, at: number): PhaseStatus | "future" | "gone" {
  const created = org.phaseIndex.get(phaseCreatedOf(org, el)) ?? at;
  const demolishedId = phaseDemolishedOf(org, el);
  return statusAt(created, demolishedId === null ? undefined : org.phaseIndex.get(demolishedId), at);
}

function statusAt(created: number, demolished: number | undefined, at: number): PhaseStatus | "future" | "gone" {
  if (created > at) return "future";
  if (demolished !== undefined && demolished < at) return "gone";
  if (demolished === at) return created === at ? "temporary" : "demolished";
  return created === at ? "new" : "existing";
}

/** How one element draws in one view. */
export interface ElementDisplay {
  readonly visible: boolean;
  readonly halftone: boolean;
  readonly dashed: boolean;
}

const SHOW: ElementDisplay = { visible: true, halftone: false, dashed: false };
const HIDE: ElementDisplay = { visible: false, halftone: false, dashed: false };
const HALFTONE: ElementDisplay = { visible: true, halftone: true, dashed: false };
const DASHED: ElementDisplay = { visible: true, halftone: false, dashed: true };
const DASHED_HALFTONE: ElementDisplay = { visible: true, halftone: true, dashed: true };

/** What a view (or the free model, with no saved view) asks for. */
export interface DisplayContext {
  readonly phaseId?: string;
  readonly phaseFilterId?: string;
  /** Per group: show, halftone or hide. Absent groups use their default visibility. */
  readonly groupDisplay?: Readonly<Record<string, GroupVisibility>>;
}

export function displayContextOf(view: ViewElement | null | undefined): DisplayContext {
  const props = view?.props;
  return {
    ...(props?.phaseId ? { phaseId: props.phaseId } : {}),
    ...(props?.phaseFilterId ? { phaseFilterId: props.phaseFilterId } : {}),
    ...(props?.groupDisplay ? { groupDisplay: props.groupDisplay } : {}),
  };
}

/** The phase a view shows: its own, else the latest phase. */
export function viewPhaseId(org: Organization, ctx: DisplayContext): string {
  if (ctx.phaseId && org.phaseIndex.has(ctx.phaseId)) return ctx.phaseId;
  return org.phases[org.phases.length - 1]?.id ?? DEFAULT_PHASE_ID;
}

export function viewPhaseFilterId(org: Organization, ctx: DisplayContext): string {
  if (ctx.phaseFilterId && org.filterById.has(ctx.phaseFilterId)) return ctx.phaseFilterId;
  return org.filterById.has(DEFAULT_PHASE_FILTER_ID) ? DEFAULT_PHASE_FILTER_ID : (org.filters[0]?.id ?? DEFAULT_PHASE_FILTER_ID);
}

const ALL_SHOW: Readonly<Record<PhaseStatus, PhaseDisplay>> = { new: "show", existing: "show", demolished: "show", temporary: "show" };

export type DisplayResolver = (el: BimElement) => ElementDisplay;

/**
 * A per-element display function for one view: group visibility combined with
 * the phase filter. Hide wins; dashed comes only from the phase filter;
 * halftone from either. Tags and dimensions follow what they annotate.
 * Constant work per element (a few map reads), so a million elements resolve
 * inside a frame budget.
 */
/**
 * Per slot table, each annotation's target slot (a dimension's two ends),
 * keyed by the annotation record. An id keeps its slot in a table and a
 * committed record never changes, so entries hold for every revision that
 * shares the table; a changed annotation is a new record and a new entry.
 */
const annotationTargets = new WeakMap<object, { readonly first: WeakMap<BimElement, number>; readonly second: WeakMap<BimElement, number> }>();

function annotationTargetsOf(table: object): { readonly first: WeakMap<BimElement, number>; readonly second: WeakMap<BimElement, number> } {
  let entry = annotationTargets.get(table);
  if (!entry) {
    entry = { first: new WeakMap(), second: new WeakMap() };
    annotationTargets.set(table, entry);
  }
  return entry;
}

export function displayResolver(model: Pick<ModelState, "elements" | "connections">, ctx: DisplayContext): DisplayResolver {
  const org = organizationOf(model);
  const at = org.phaseIndex.get(viewPhaseId(org, ctx)) ?? Math.max(0, org.phases.length - 1);
  const statuses = org.filterById.get(viewPhaseFilterId(org, ctx))?.entry.statuses ?? ALL_SHOW;
  const groupVisibility = new Map<string, GroupVisibility>();
  for (const g of org.groups) groupVisibility.set(g.id, ctx.groupDisplay?.[g.id] ?? g.entry.defaultVisibility);
  const defaultCreated = org.phaseIndex.get(phaseCreatedOfIds(org, undefined)) ?? at;
  const resolve = (groupId: string, created: number, demolished: number | undefined): ElementDisplay => {
    const group = groupVisibility.get(groupId) ?? "show";
    if (group === "hide") return HIDE;
    const status = statusAt(created, demolished, at);
    if (status === "future" || status === "gone") return HIDE;
    const phase = statuses[status];
    if (phase === "hide") return HIDE;
    const halftone = group === "halftone" || phase === "halftone";
    if (phase === "dashed") return halftone ? DASHED_HALFTONE : DASHED;
    return halftone ? HALFTONE : SHOW;
  };
  // Most elements name no group or phase: they all resolve the same way, worked out once.
  const plain = resolve(DEFAULT_GROUP_ID, defaultCreated, undefined);
  // Organized content only: the caller has already ruled out the unorganized kinds.
  const organized = (el: BimElement): ElementDisplay => {
    if (el.groupId === undefined && el.phaseCreated === undefined && el.phaseDemolished === undefined) return plain;
    const demolishedId = phaseDemolishedOf(org, el);
    return resolve(groupIdOf(org, el), org.phaseIndex.get(phaseCreatedOf(org, el)) ?? at, demolishedId === null ? undefined : org.phaseIndex.get(demolishedId));
  };
  const own = (el: BimElement): ElementDisplay => (UNORGANIZED_KINDS.has(el.kind) ? SHOW : organized(el));
  const read = elementReader(model.elements);
  const bySlot = slotReaderOf(model.elements);
  const targets = bySlot ? annotationTargetsOf(bySlot.table) : null;
  /** A tag's or dimension's end: by the slot its id has in the record's slot table, worked out once per annotation and slot table. */
  const end = (el: BimElement, id: ElementId, ends: WeakMap<BimElement, number> | undefined): BimElement | undefined => {
    if (!bySlot || !ends) return read(id);
    let slot = ends.get(el);
    if (slot === undefined) {
      slot = bySlot.table.slotOf.get(id) ?? -1;
      ends.set(el, slot);
    }
    return (slot >= 0 && slot < bySlot.size ? bySlot.at(slot) : undefined) ?? read(id);
  };
  // One read of the kind per element: most elements are organized content, which never matches the annotation kinds.
  return (el) => {
    const kind = el.kind;
    if (!UNORGANIZED_KINDS.has(kind)) {
      if (el.groupId === undefined && el.phaseCreated === undefined && el.phaseDemolished === undefined) return plain;
      return organized(el);
    }
    if (kind === "tag") {
      const target = end(el, el.targetId, targets?.first);
      return target ? own(target) : SHOW;
    }
    if (kind === "dimension") {
      const a = end(el, el.aId, targets?.first);
      const b = end(el, el.bId, targets?.second);
      const da = a ? own(a) : SHOW;
      const db = b ? own(b) : SHOW;
      return da.visible && db.visible ? (da.halftone && db.halftone ? HALFTONE : SHOW) : HIDE;
    }
    return SHOW;
  };
}

/** A view's phase, filter and group settings name things that exist; a plain reason otherwise. */
export function viewOrganizationProblem(model: Pick<ModelState, "elements" | "connections">, props: DisplayContext): string | null {
  const org = organizationOf(model);
  if (props.phaseId !== undefined && !org.phaseIndex.has(props.phaseId)) return `There is no phase "${props.phaseId}". Pick one from the view's Phase list.`;
  if (props.phaseFilterId !== undefined && !org.filterById.has(props.phaseFilterId)) return `There is no phase filter "${props.phaseFilterId}". Pick one from the view's Phase filter list.`;
  for (const id of Object.keys(props.groupDisplay ?? {})) {
    if (!org.groupById.has(id)) return `There is no group "${id}". It may have been deleted; reopen the view's Show list.`;
  }
  return null;
}
