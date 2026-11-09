import { defineExtensionPoint } from "../packs/contract";
import type { AllocationPolicy, DensityRate } from "../requirements/types";
import type { AuthoredRevisions, ElementId, Partition, ValuedCore, Vec2 } from "../types";

/**
 * Spaces, zones and drawing underlays (KERNEL-REQUIREMENTS-MODEL §3.2, ROADMAP
 * F3; product decision, Oct 27, decision 3).
 *
 * The architect's `room` stays as-is. A `space` is the engineers' own: one room,
 * part of one, or a whole apartment, carrying use, occupants, heights and the
 * loads anchored to it. A `zone` groups spaces for a purpose and may name the
 * equipment that serves it (RTU-2 serves Zone 2 Kitchen).
 *
 * Most jobs have no linked BIM model, only a PDF or CAD file. So a space is
 * usually traced over a `drawing_underlay`: a calibrated, scaled page placed on
 * a level. `origin` records how each outline was made, so automatic detection
 * from drawings later is one more origin, not a new shape.
 */

interface SpatialElementBase {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
}

/** Area always comes from geometry (outline, or the rooms' areas), never typed. */
export type SpaceBounds =
  | { readonly kind: "outline"; readonly outline: readonly Vec2[] }
  | { readonly kind: "rooms"; readonly roomIds: readonly ElementId[] }
  /** Typed into a table first; no area until drawn. */
  | { readonly kind: "none" }
  /**
   * Contract 1.11.0 (`spaces:bounded`): found from the bounding elements
   * around `seed` (where the person clicked). `outline` and `boundary` are
   * derived and stored, so a bare or older reader still shows the area.
   */
  | { readonly kind: "bounded"; readonly levelId: ElementId; readonly seed: Vec2; readonly outline: readonly Vec2[]; readonly boundary: readonly BoundaryRef[]; readonly open?: BoundedOpen };

/**
 * Set when an edit left the seed in no closed region: the space keeps its
 * last outline, and this says where it opened. Cleared when the walls close
 * around the seed again.
 */
export interface BoundedOpen {
  /** Model mm: the loose end nearest the seed, else the middle of the element that changed. */
  readonly near: Vec2;
  /** The bounding element that changed or left the gap. */
  readonly elementId?: ElementId;
}

/** One edge of a bounded space: the element that bounds it there and the segment's ends (model mm). */
export interface BoundaryRef {
  readonly elementId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
}

/** How the outline was made. */
export type SpaceOrigin =
  | { readonly kind: "typed" }
  | { readonly kind: "drawn" }
  | { readonly kind: "traced"; readonly underlayId: ElementId }
  | { readonly kind: "from_room"; readonly roomId: ElementId }
  /** A room in a linked model: the link's id and the room's stable id inside it. */
  | { readonly kind: "from_linked_room"; readonly linkId: string; readonly roomRef: string }
  /** Proposed by a detector (later); the engineer accepts it. */
  | { readonly kind: "detected"; readonly detector: string; readonly confidence: number; readonly underlayId?: ElementId; readonly accepted: boolean };

/**
 * A space use from the library (bim-library): one row with rates for several
 * codes, extended by the firm. Setting the use pins the row's name, default
 * density and canonical rates here (space-use.ts), so the model keeps what it
 * was designed with when the library changes. Records written before Oct 2026
 * carry the bare reference.
 */
export interface SpaceUseRef {
  readonly libraryId: string;
  readonly useId: string;
  readonly name?: string;
  readonly revision?: number;
  /** Default occupants per m² of floor. */
  readonly occupantsPerM2?: number;
  /** Quantity-bag unit per m² or per occupant. */
  readonly rates?: readonly DensityRate[];
}

export interface Space extends SpatialElementBase, ValuedCore {
  readonly kind: "space";
  readonly number: string;
  readonly name: string;
  /** Absent: typed into a table, not on a level yet. */
  readonly levelId?: ElementId;
  readonly bounds: SpaceBounds;
  readonly origin: SpaceOrigin;
  readonly use?: SpaceUseRef;
  /** Absent: from the use's default density. */
  readonly occupants?: number;
  /** mm. */
  readonly ceilingHeightMm?: number;
  readonly slabToSlabMm?: number;
  /** One space per dwelling unit (block load) or room by room. Absent: per the firm default. */
  readonly block?: boolean;
  readonly note?: string;
  /**
   * How the estimates on this space count once devices are placed in it
   * (requirements/policy.ts `scopePolicyOf`). Absent: the model's policy
   * (default: the estimate until the devices exceed it).
   */
  readonly estimateCounting?: AllocationPolicy;
  /**
   * Contract 1.11.0 (`spaces:nested`): the space this one sits inside (a
   * sub-room of an open office, a room of a suite or apartment). Read
   * through `spaces/nesting.ts`; absent: a top-level space.
   */
  readonly parentId?: ElementId;
}

export type ZonePurpose =
  | KnownZonePurpose
  | `firm:${string}`
  /** A pack's purpose (`struct.tributary_area`), a row of `ZONE_PURPOSE_POINT`. */
  | `${string}.${string}`;

/**
 * The kernel's own purposes, in picker order. The same list as
 * `KNOWN_ZONE_PURPOSES` (zone-bounds.ts, which readers check against);
 * `c5p-extension-points` holds them equal.
 */
export const BUILTIN_ZONE_PURPOSES = ["thermal", "ventilation", "electrical_load_region", "fire_area", "smoke", "lighting_control", "sprinkler_hazard", "structural_load_area", "drainage_catchment", "code_clearance"] as const;
export type KnownZonePurpose = (typeof BUILTIN_ZONE_PURPOSES)[number];

/** A zone purpose a person picks from. */
export interface ZonePurposeDef {
  readonly id: string;
  readonly label: string;
  /** How zones of this purpose export to IFC 4.3 (the exporter reads it; absent: its built-in mapping, else IfcZone). */
  readonly ifc?: { readonly entity: "IfcZone" | "IfcSpatialZone"; readonly predefinedType?: string; readonly objectType?: string };
}

/** Zone purposes (v1). A pack's are `<pack>.<name>`; readers already show an id they don't know in words. */
export const ZONE_PURPOSE_POINT = defineExtensionPoint<ZonePurposeDef>({
  id: "kernel.zone_purpose",
  version: 1,
  label: "Zone purposes",
  idOf: (p) => p.id,
  builtins: () => BUILTIN_ZONE_PURPOSES.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " ") })),
});

/**
 * What a zone covers (KERNEL-FOUNDATION §3.4). `spaces` is the only v1 shape;
 * `outline` (a region drawn on a level that is not a room: a fire area across
 * a corridor, a catchment) and `derived` (computed from an element by a rule:
 * the NEC 110.26(E) space above a panel) are `zone@2` (zone-bounds.ts). A
 * derived zone stores only its host and rule, never geometry.
 */
export type ZoneBounds =
  | { readonly kind: "spaces"; readonly spaceIds: readonly ElementId[] }
  | {
      readonly kind: "outline";
      readonly levelId: ElementId;
      readonly outline: readonly Vec2[];
      /** mm above the level's floor. Absent: the level's height. */
      readonly top?: number;
      /** mm above the level's floor. Absent: the floor. */
      readonly bottom?: number;
    }
  | { readonly kind: "derived"; readonly hostId: ElementId; readonly rule: string };

export interface Zone extends SpatialElementBase, ValuedCore {
  readonly kind: "zone";
  readonly name: string;
  readonly purpose: ZonePurpose;
  /**
   * The member spaces. Kept beside `bounds` through the expand window so v1
   * readers keep working: equal to `bounds.spaceIds` for a spaces zone,
   * empty for an outlined or derived one. Read through `zoneSpaceIds`.
   */
  readonly spaceIds: readonly ElementId[];
  /** Absent: a v1 zone, read as `{ kind: "spaces", spaceIds }` (`zoneBoundsOf`). */
  readonly bounds?: ZoneBounds;
  /** The equipment that serves it (planned or placed). */
  readonly servedBy?: ElementId;
  /** Contract 1.11.0 (`spaces:nested`): the zone this one sits inside. Read through `spaces/nesting.ts`. */
  readonly parentId?: ElementId;
}

/**
 * A PDF page, image or CAD file placed on a level to trace over. The kernel
 * never reads the file: `source` is an opaque reference the host resolves
 * (in a host app, a project workspace file). Calibration maps the source's own
 * units (PDF points, pixels, CAD drawing units) to model millimetres.
 */
export interface UnderlaySource {
  readonly format: "pdf" | "image" | "dxf" | "dwg";
  readonly provider: string;
  readonly ref: string;
  /** PDF: 1-based page. */
  readonly page?: number;
  readonly name: string;
}

export interface UnderlayCalibration {
  /** A point in source units and where it lands in the model (mm). */
  readonly sourceOrigin: Vec2;
  readonly modelOrigin: Vec2;
  /** Model mm per source unit (from two picked points and a typed distance, or a stated scale). */
  readonly mmPerUnit: number;
  readonly rotationDeg: number;
  /** How it was set, for the properties panel ("1/8" = 1'-0"", "two points, 24'-0""). */
  readonly method: "two_points" | "stated_scale" | "cad_units";
}

export interface DrawingUnderlay extends SpatialElementBase {
  readonly kind: "drawing_underlay";
  readonly levelId: ElementId;
  readonly source: UnderlaySource;
  /** Absent: placed but not calibrated yet; tracing tools refuse it and say why. */
  readonly calibration?: UnderlayCalibration;
  /** 0–100, drawn beneath the model. Absent: 50. */
  readonly opacityPct?: number;
  readonly locked?: boolean;
  readonly hidden?: boolean;
}

/**
 * Contract 1.11.0 (`spaces:separators`): an imaginary line on a level that
 * always bounds spaces and is never built (splits an open office into
 * sub-rooms). Drawn dashed; exported as `IfcVirtualElement`.
 */
export interface SpaceSeparator extends SpatialElementBase {
  readonly kind: "space_separator";
  readonly levelId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly name?: string;
  /** The space this line splits into sub-rooms (`split_space`). A trace of that space, or of anything above it, ignores the line. */
  readonly splits?: ElementId;
}
