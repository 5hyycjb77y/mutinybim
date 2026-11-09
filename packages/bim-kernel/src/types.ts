import type { DrawingItem, SheetProps, ViewProps, ViewType, Viewport } from "./documents";
import { readStoredPackPins } from "./packs/pin";

/**
 * MutinyBIM domain model. All lengths are millimetres in plan coordinates
 * (x east, y north). Identity is stable and never derived from geometry.
 */
import type { PartTypeDefinition } from "./parts";
import type { ClearanceOverrides } from "./part-model/clearance";
import type { PartHost } from "./spatial";
import type { PortRef, RunElement } from "./routing/types";
import type { OrganizationElementRecord } from "./organization/model";
import type { SiteElement } from "./site";
import type { ServiceLink } from "./connections/types";
import type { ServiceCatalogElement } from "./catalog/types";
import type { LoadPointElement } from "./load-points/types";
import type { Question } from "./questions/types";
import type { PartMount } from "./part-mount";
import type { IntakeChoice } from "./part-model/intake-hood";
import type { MountingPlane } from "./mounting-plane";
import type { PlannedPlacement } from "./placement/types";
import type { GeometricPlacement } from "./placement/geometric";
import type { DrawingUnderlay, Space, SpaceSeparator, Zone } from "./spaces/types";
import type { PackPin } from "./packs/set";
import type { GraphElement } from "./graph/types";
import type { RequirementsSourcePin } from "./graph/source";
import type { Ceiling } from "./ceilings/types";
import type { ClassificationAssignment, ConstructionStageElement } from "./qto/types";
import type { ValueBasis } from "./basis/types";
import type { ReferencePlane } from "./datums/reference-plane";

export type * from "./routing/types";

export type ElementId = string & { readonly __brand: "ElementId" };
export type ConnectionId = string & { readonly __brand: "ConnectionId" };
export type Revision = number & { readonly __brand: "Revision" };
export type ActorId = string & { readonly __brand: "ActorId" };

export const asElementId = (value: string): ElementId => value as ElementId;
export const asConnectionId = (value: string): ConnectionId => value as ConnectionId;
export const asRevision = (value: number): Revision => value as Revision;
export const asActorId = (value: string): ActorId => value as ActorId;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type SystemClass = "supply" | "return" | "exhaust";

export interface RectProfile {
  readonly shape: "rect";
  readonly width: number;
  readonly height: number;
}

export interface RoundProfile {
  readonly shape: "round";
  readonly diameter: number;
}

export type Profile = RectProfile | RoundProfile;

/** Revision at which each authored field was last explicitly set. */
export type AuthoredRevisions = Readonly<Record<string, number>>;

/** The six disciplines every peer has stored since round 1 (frozen ids). */
export type KnownDiscipline = "architecture" | "structure" | "mechanical" | "plumbing" | "electrical" | "fire_protection";
/**
 * A stored discipline: the six, the four class disciplines (written when the
 * peers advertise `partition:class_disciplines`), or any id the discipline
 * registry knows (`fire_alarm`, `vt.elevators`, `firm:site_work`; written
 * when the peers advertise `disciplines:registry`). Readers keep any
 * registry-shaped id and label it from the registry (`disciplineLabel`).
 */
export type Discipline = KnownDiscipline | "civil" | "general_contracting" | "documentation" | "general" | (string & {});

/**
 * Where an element lives for area-based loading: a level, a spatial zone on
 * that level, and the discipline that owns it. Elements without one (the
 * original duct-only models) belong to DEFAULT_PARTITION.
 */
export interface Partition {
  readonly level: string;
  readonly zone: string;
  readonly discipline: Discipline;
}

/** What a connected network carries. Absent means air (the original duct models). Open: a pack's network names its own (`vt.hoistway`); readers keep it. */
export type NetworkService = "air" | "water" | "sprinkler" | "power" | (string & {});

export interface ModelElementBase {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
  /** Group it belongs to (organization/model.ts). Absent: General. */
  readonly groupId?: string;
  /** Phase it is created in. Absent: New construction. */
  readonly phaseCreated?: string;
  /** Phase it is demolished in. Absent: not demolished. */
  readonly phaseDemolished?: string;
}

/** The fields every connected-network record keeps (an add-on's typed kinds extend it). */
export interface ElementBase extends ModelElementBase {
  readonly systemClass: SystemClass;
  readonly service?: NetworkService;
  /**
   * Values the add-on that owns the kind keeps, by parameter key
   * (`ELEMENT_KIND_POINT`, `kinds/`). Records written before contract 1.7.0
   * keep them in flat fields their add-on names instead; read either through
   * `kindValue`. Written only to peers advertising `kinds:addon_owned`.
   */
  readonly values?: Readonly<Record<string, ParamValue>>;
  /** Record schema version (`schema-version/`). Absent: 1. */
  readonly schemaVersion?: number;
}

/**
 * Kinds an add-on gives a TypeScript shape to, for code that narrows on them
 * by `kind`. Empty here; an add-on fills it by declaration merging:
 * `declare module "@permitzip/bim-kernel/types" { interface AddOnElementTypes { "<kind>": <Its interface> } }`.
 * Their stored shape, connector ends, placement and everything else they are
 * stay their add-on's kind rows (`ELEMENT_KIND_POINT`).
 */
export interface AddOnElementTypes {}

/** Any record of a kind an add-on in this build types (`AddOnElementTypes`); none in a bare kernel build. */
export type AddOnElement = AddOnElementTypes[keyof AddOnElementTypes];

/** Lock states commands know how to explain. Readers keep any other string a newer peer wrote. */
export const KNOWN_LOCK_STATES = ["existing", "issued"] as const;
export type KnownLockState = (typeof KNOWN_LOCK_STATES)[number];

/** A per-element lock (KERNEL-FOUNDATION §3.9): commands refuse to change the element, with `reason` in the refusal. */
export interface LockState {
  readonly state: KnownLockState | (string & {});
  /** Why, in the words of whoever locked it ("Surveyed as built, Oct 2026"). */
  readonly reason: string;
  /** Who locked it (the actor id). */
  readonly by?: string;
  /** When, ISO 8601. */
  readonly at?: string;
}

/** What a layer does in its assembly. Open: a pack adds its own (`fp.rated_board`). */
export const KNOWN_MATERIAL_LAYER_FUNCTIONS = ["structure", "substrate", "insulation", "membrane", "air_gap", "finish"] as const;
export type MaterialLayerFunction = (typeof KNOWN_MATERIAL_LAYER_FUNCTIONS)[number] | (string & {});

export interface MaterialLayer {
  readonly materialId: string;
  readonly thicknessMm: number;
  readonly function?: MaterialLayerFunction;
}

/** A wall, slab or roof build-up, exterior (or top) first. Referenced by id from a type's or an element's `values` (`elements/material-layers.ts`). */
export interface MaterialLayerSet {
  readonly id: string;
  readonly layers: readonly MaterialLayer[];
}

/**
 * The part of `ElementCore` every classified record can carry: zones,
 * spaces, systems, run segments and parts as well as the building kinds.
 * Parts keep their own `values` (their type's instance parameters), so for
 * them only `classId` and `provenance` apply. Written only to peers
 * advertising `elements:core`.
 */
/** Where a copy came from: the linked model (stable across its versions), the element's IFC GlobalId, the version copied and a fingerprint of the source's shape then. */
export interface LinkedCopyStamp {
  readonly linkId: string;
  readonly globalId: string;
  readonly version: string;
  readonly fingerprint: string;
}

export interface ClassifiedCore {
  /** The class it is (`arch.wall`, a pack's `zz.partition`). Absent: recognised from its kind and fields. An explicit class wins over recognition. */
  readonly classId?: string;
  readonly provenance?: {
    readonly ifcGlobalId?: string;
    readonly source?: string;
    readonly basis?: ValueBasis;
    /** Copied from a linked model's element and kept in step with it (`reference-geometry/linked-copies.ts`). */
    readonly linkedCopy?: LinkedCopyStamp;
  };
  /** How far along each value is, by parameter key (`basis/`, D4). Absent: "not recorded". */
  readonly valueBasis?: Readonly<Record<string, ValueBasis>>;
}

/** `ClassifiedCore` with instance values by parameter key (zones, spaces, systems, run segments). */
export interface ValuedCore extends ClassifiedCore {
  readonly values?: Readonly<Record<string, ParamValue>>;
}

/**
 * What every typed element can carry (KERNEL-FOUNDATION §3.1), all optional
 * so every stored record reads as it did. The kind's own flat fields (a
 * wall's `start` / `end`, a slab's `outline`) stay authoritative for older
 * readers; commands that set `placement` mirror it into them. Written only to
 * peers advertising `elements:core` (`elements/feature.ts`).
 */
export interface ElementCore extends ClassifiedCore {
  /** A type element it takes type values from (a section, a wall type, an inlet structure). */
  readonly typeId?: ElementId;
  /** Instance values by parameter key. */
  readonly values?: Readonly<Record<string, ParamValue>>;
  /** Where it sits beyond the flat fields: justification, a path with stations, an area with holes. */
  readonly placement?: GeometricPlacement;
  readonly locked?: LockState;
  /**
   * `recognised`: `classId` was filled by the upgrade on edit from recognition,
   * so it follows the fields recognition reads (a door turned into a window);
   * absent with a `classId`: set explicitly, never changed by recognition.
   */
  readonly classSource?: "recognised";
  /** Record schema version (`schema-version/`). Absent: 1. */
  readonly schemaVersion?: number;
  /** Codes from registered classification systems (cost codes first); an instance's code for a system wins over its type's. Written only to peers advertising `qto:classification`. */
  readonly classification?: readonly ClassificationAssignment[];
  /** The construction stage it is built in (`construction_stage` record id). Written only to peers advertising `construction:stages`. */
  readonly constructionStageId?: string;
}

export const KNOWN_OPENING_TYPES = ["door", "window"] as const;
export type OpeningType = (typeof KNOWN_OPENING_TYPES)[number] | (string & {});

export const KNOWN_COMPONENT_CATEGORIES = ["furniture", "casework", "ceiling", "floor_finish", "curtain_panel", "mullion", "footing"] as const;
export type ComponentCategory = (typeof KNOWN_COMPONENT_CATEGORIES)[number] | (string & {});

export const KNOWN_COLUMN_MATERIALS = ["concrete", "steel"] as const;
export type ColumnMaterial = (typeof KNOWN_COLUMN_MATERIALS)[number] | (string & {});

export interface Wall extends ModelElementBase, ElementCore {
  readonly kind: "wall";
  /** Authored. */
  readonly start: Vec2;
  /** Authored. */
  readonly end: Vec2;
  readonly thickness: number;
  readonly height: number;
  readonly wallType: string;
  /**
   * Derived, when a surface its top or base is bound to isn't level along it
   * (a sloped roof over it, two slabs of different depth): its base and top
   * above its level at stations from its start. Absent: flat. `height` is then
   * the tallest stretch.
   */
  readonly bodyProfile?: readonly WallBodyPoint[];
}

/** One station of a wall's body profile, mm: distance from its start, its base and top above its level. */
export interface WallBodyPoint {
  readonly atMm: number;
  readonly baseMm: number;
  readonly topMm: number;
}

export interface Slab extends ModelElementBase, ElementCore {
  readonly kind: "slab";
  readonly outline: readonly Vec2[];
  readonly thickness: number;
}

/** A door or window hosted in a wall, placed by distance along the wall from its start. */
export interface Opening extends ModelElementBase, ElementCore {
  readonly kind: "opening";
  /** Writers send a known type; a newer peer's (`louver`, `skylight`) is kept. */
  readonly openingType: OpeningType;
  readonly mark: string;
  readonly hostId: ElementId;
  /** Authored: centre distance from the host wall's start. */
  readonly offset: number;
  readonly width: number;
  readonly height: number;
  /** Derived: world position of the centre on the host wall. */
  readonly position: Vec2;
}

export interface Room extends ModelElementBase, ElementCore {
  readonly kind: "room";
  readonly number: string;
  readonly name: string;
  readonly outline: readonly Vec2[];
  readonly areaSqM: number;
}

export interface GridLine extends ModelElementBase, ElementCore {
  readonly kind: "grid";
  readonly label: string;
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface Column extends ModelElementBase, ElementCore {
  readonly kind: "column";
  /** Writers send a known material; a newer peer's (`timber`, `masonry`) is kept. */
  readonly material: ColumnMaterial;
  readonly position: Vec2;
  readonly size: Vec2;
}

export interface Beam extends ModelElementBase, ElementCore {
  readonly kind: "beam";
  readonly sectionName: string;
  readonly start: Vec2;
  readonly end: Vec2;
}

/** One level's piece of a vertical riser. All pieces sharing `riserId` are one riser through the building. */
export interface RiserSegment extends ModelElementBase {
  readonly kind: "riser_segment";
  readonly riserId: string;
  readonly service: NetworkService;
  readonly position: Vec2;
  /** Authored. */
  readonly profile: Profile;
}

export interface ViewElement extends ModelElementBase {
  readonly kind: "view";
  readonly name: string;
  readonly viewType: ViewType;
  readonly cropMin: Vec2;
  readonly cropMax: Vec2;
  readonly props?: ViewProps;
  /** Removed (kept so undo can bring it back). */
  readonly deleted?: boolean;
}

export interface Sheet extends ModelElementBase {
  readonly kind: "sheet";
  readonly number: string;
  readonly title: string;
  readonly viewIds: readonly ElementId[];
  readonly props?: SheetProps;
  readonly deleted?: boolean;
}

/** An annotation that follows its target: position = target anchor + offset. */
export interface Tag extends ModelElementBase {
  readonly kind: "tag";
  readonly targetId: ElementId;
  /** Authored. */
  readonly offset: Vec2;
  /** Authored. */
  readonly text: string;
  /** Derived. */
  readonly position: Vec2;
}

/** A dimension between two elements' anchors; the measured value always recomputes. */
export interface Dimension extends ModelElementBase {
  readonly kind: "dimension";
  readonly aId: ElementId;
  readonly bId: ElementId;
  readonly offset: number;
  /** Derived. */
  readonly valueMm: number;
}

/** A placed family instance with no connectors: furniture, casework, ceilings, finishes, curtain wall, footings. */
export interface Component extends ModelElementBase, ElementCore {
  readonly kind: "component";
  /** Writers send a known category; a newer peer's (`paving`, `curb`) is kept. */
  readonly category: ComponentCategory;
  readonly typeName: string;
  readonly position: Vec2;
  readonly size: Vec2;
  readonly rotationDeg: number;
}

/**
 * A storey: the datum parts are hosted to. Placed parts store their level id
 * and an offset above it, so moving a level's elevation moves its parts.
 */
export interface Level extends ModelElementBase {
  readonly kind: "level";
  readonly name: string;
  /** Floor elevation above project zero. */
  readonly elevationMm: number;
  /** The linked model storey it was made from or matched to; a re-sync updates the level from it. Absent: drawn by a person. */
  readonly source?: LevelSource;
  /** Per linked model (its link id), the storey a person said this level is, when the names and heights don't settle it (`set_level_linked_storey`). */
  readonly linkedStoreys?: Readonly<Record<string, string>>;
  /** Made by `ensure_starter_level` for an empty model and not yet renamed, moved or tied to a linked model. */
  readonly starter?: true;
}

export interface LevelSource {
  /** The linked model (reference id). */
  readonly referenceId: string;
  /** The storey's IFC GlobalId. */
  readonly storeyId: string;
  /** The storey's name when last synced. A level still called that is renamed when the architect renames the storey; one a person named keeps its name. */
  readonly storeyName: string;
}

/**
 * One family type pinned inside the model (see parts.ts for the shape of the
 * definition). Issue captures the model, so it captures every type it uses.
 */
export interface PartTypeElement extends ModelElementBase {
  readonly kind: "part_type";
  readonly definition: PartTypeDefinition;
}

/**
 * A shared type for building and structure elements (a W12x26 section, a
 * 2x6 exterior wall type, a 450 mm footing): a class, a name and type values.
 * Walls, beams, columns, slabs and the rest reference it through
 * `ElementCore.typeId`; an instance's own value wins over the type's
 * (`elements/types.ts` `elementTypeValue`). Parts keep `part_type`, which
 * carries geometry and connectors. Written only to peers advertising
 * `elements:types`.
 */
export interface ElementTypeElement extends ModelElementBase, ValuedCore {
  readonly kind: "element_type";
  /** Codes from registered classification systems, inherited by its instances (`qto:classification`). */
  readonly classification?: readonly ClassificationAssignment[];
  readonly name: string;
  /** Element kinds it may type (`["beam"]`). Absent: any building or structure kind. */
  readonly forKinds?: readonly string[];
}

/** A placed instance of a part type, hosted to a level. */
export interface PartInstance extends ModelElementBase, ClassifiedCore {
  readonly kind: "part";
  readonly typeId: ElementId;
  readonly levelId: ElementId;
  /** Insertion point in plan. Authored. */
  readonly position: Vec2;
  /** Insertion point height above the level. Authored. */
  readonly offsetMm: number;
  /** Rotation about the vertical axis, degrees counter-clockwise from east. Authored. */
  readonly rotationDeg: number;
  readonly mark: string;
  /** Instance parameter values, validated against the type's instance schema. */
  readonly values: Readonly<Record<string, ParamValue>>;
  /** Runs connected to this part, by connector id. The run holds the link back. */
  readonly links?: Readonly<Record<string, PortRef>>;
  /** Served-from links serving this part, by connector id (connections/). The link holds the link back. */
  readonly served?: Readonly<Record<string, ElementId>>;
  /** Served-from links this part is the source of, in the order they were made. */
  readonly feeds?: readonly ElementId[];
  /** The slab or roof it stands on (spatial.ts). Authored. */
  readonly host?: PartHost;
  /** Curb or rail height between its host and its base, mm. Authored. */
  readonly curbMm?: number;
  /** This part's changes to its type's clearance zones, by zone id (part-model/clearance.ts). Authored. */
  readonly clearances?: ClearanceOverrides;
  /** Authored: which of its type's named positions it is in (open, closed…; part-model/clearance.ts). Absent: the type's first. */
  readonly positionId?: string;
  /** Authored: turned over or on its side relative to how the type is drawn (part-mount.ts). Absent: as drawn. */
  readonly mount?: PartMount;
  /** Authored: hood, louver or screen per duct opening, over the type's (part-model/intake-hood.ts). */
  readonly intakes?: Readonly<Record<string, IntakeChoice>>;
  /** Authored: the mounting plane it was placed on; changing the plane's height moves it (mounting-plane.ts). */
  readonly planeId?: ElementId;
  /**
   * Authored: not placed yet (placement/types.ts). While set, levelId,
   * position, offsetMm and rotationDeg are placeholders; read placement only
   * through `placementOf` / `isPlaced`.
   */
  readonly planned?: PlannedPlacement;
}

export type ParamValue = number | string | boolean;

export type BuildingElement = Wall | Slab | Opening | Room | GridLine | Column | Beam | RiserSegment | Component | Ceiling;
export type DocumentElement = ViewElement | Sheet | Tag | Dimension | Viewport | DrawingItem;
export type PartElement = Level | PartTypeElement | PartInstance | MountingPlane | ElementTypeElement;

/** A group, phase, phase filter or the active-group/phase settings (organization/model.ts). */
export type OrganizationElement = OrganizationElementRecord;

/** The engineers' spaces, zones and the PDF / CAD pages they trace over (spaces/types.ts). */
export type SpatialDesignElement = Space | Zone | DrawingUnderlay | SpaceSeparator;

export type BimElement = AddOnElement | BuildingElement | DocumentElement | PartElement | RunElement | OrganizationElement | SiteElement | ServiceLink | ServiceCatalogElement | LoadPointElement | SpatialDesignElement | Question | GraphElement | ConstructionStageElement | ReferencePlane;
export type ElementKind = BimElement["kind"];

/** The connector end names stored models have used since round 1. */
export type KnownConnectorEnd = "start" | "end" | "in" | "out" | "host" | "branch";
/**
 * A named connector end. Which ends a kind has, which lead downstream and
 * where each sits are its kind row's (`ELEMENT_KIND_POINT` `connectorEnds`);
 * an add-on's kind names its own ends. Open: readers keep any name.
 */
export type ConnectorEnd = KnownConnectorEnd | (string & {});

/**
 * A stored record of a kind this build's union doesn't name (an add-on's
 * kind, a non-drawn record, a kind a newer peer wrote). Readers keep it as
 * stored and reach its fields by name; its kind row, when one is in force,
 * says what it is.
 */
export interface UnknownRecord extends ModelElementBase {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface ConnectorRef {
  readonly elementId: ElementId;
  readonly end: ConnectorEnd;
}

export interface Connection {
  readonly id: ConnectionId;
  readonly a: ConnectorRef;
  readonly b: ConnectorRef;
}

export interface ModelState {
  readonly modelId: string;
  readonly revision: Revision;
  readonly elements: Readonly<Record<string, BimElement>>;
  readonly connections: readonly Connection[];
  readonly settings: ModelSettings;
}

export interface ModelSettings {
  /** Minimum straight length of any duct segment. */
  readonly minStraightMm: number;
  /** Clearance from a host end to a tap centreline. */
  readonly tapEndClearanceMm: number;
  /** Minimum centre-to-centre spacing of taps on one host. */
  readonly minTapSpacingMm: number;
  /** Connector coincidence tolerance. */
  readonly connectorToleranceMm: number;
  /**
   * Add-on packs this model uses, beyond the built-in ones (`packs/set.ts`).
   * Written only to peers advertising `PACKS_PINS_FEATURE`; readers keep pins
   * for packs this release lacks and the host reports them as missing.
   */
  readonly packs?: readonly PackPin[];
  /**
   * Which requirements sources govern each discipline, highest first
   * (`graph/source.ts`, contract 1.4.0). Readers keep pins for sources this
   * host lacks; absent: bound host snapshots, then add-on sources, then the
   * model's own local rules.
   */
  readonly requirementsSources?: readonly RequirementsSourcePin[];
}

export const DEFAULT_PARTITION: Partition = { level: "L1", zone: "Z1", discipline: "mechanical" };

export const DEFAULT_SETTINGS: ModelSettings = {
  minStraightMm: 150,
  tapEndClearanceMm: 300,
  minTapSpacingMm: 600,
  connectorToleranceMm: 0.5,
};

const SETTING_KEYS = ["minStraightMm", "tapEndClearanceMm", "minTapSpacingMm", "connectorToleranceMm"] as const;

/**
 * Model settings as stored or sent. Models first opened before Oct 22 2026
 * hold them JSON-encoded a second time (a string); every comparison against
 * an undefined tolerance then fails, and each drag refused as "pulled back
 * past the elbow". Throws when the value isn't settings at all.
 */
export function readModelSettings(raw: unknown): ModelSettings {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err) {
      throw new Error(`Model settings are not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof value !== "object" || value === null) throw new Error(`Model settings must be an object, got ${value === null ? "null" : typeof value}`);
  const out: Record<(typeof SETTING_KEYS)[number], number> = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    const v: unknown = (value as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`Model setting ${key} must be a number of mm, got ${JSON.stringify(v)}`);
    out[key] = v;
  }
  const packs = readPackPins((value as Record<string, unknown>).packs);
  const requirementsSources = readRequirementsSourcePins((value as Record<string, unknown>).requirementsSources);
  return { ...out, ...(packs ? { packs } : {}), ...(requirementsSources ? { requirementsSources } : {}) };
}

/** Stored requirements-source pins, kept for sources this host lacks; a malformed list is reported and dropped, never half-read. */
function readRequirementsSourcePins(raw: unknown): readonly RequirementsSourcePin[] | undefined {
  if (raw === undefined) return undefined;
  const valid = Array.isArray(raw) && raw.every((p: unknown) => typeof p === "object" && p !== null && typeof (p as { discipline?: unknown }).discipline === "string" && Array.isArray((p as { sources?: unknown }).sources) && ((p as { sources: unknown[] }).sources).every((s) => typeof s === "string"));
  if (!valid) {
    console.error("[bim-kernel] model settings `requirementsSources` is not a list of { discipline, sources }; ignoring it", { requirementsSources: raw });
    return undefined;
  }
  return (raw as readonly { discipline: string; sources: readonly string[] }[]).map((p) => ({ discipline: p.discipline, sources: [...p.sources] }));
}

/** Stored pack pins, kept for packs this release lacks, with their digest and trust tier (round 11 A11); one unreadable pin is reported and left out. */
function readPackPins(raw: unknown): readonly PackPin[] | undefined {
  return readStoredPackPins(raw);
}
