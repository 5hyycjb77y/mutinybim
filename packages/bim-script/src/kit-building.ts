import {
  BOUNDING_ELEMENT_POINT,
  MATERIAL_ID_KEY,
  OPENING_SILL_KEY,
  TILE_2FT_MM,
  TILE_4FT_MM,
  allMaterials,
  asElementId,
  assemblyThermalSummary,
  builtinPartType,
  ceilingGrid,
  ceilingGridCellCenter,
  isCoreElement,
  nearestWallFace,
  planLevelSync,
  surfacesAt,
  wallFaceFrame,
  wallFaceSideToward,
  wallStationOf,
  type AssemblyThermalSummary,
  type Ceiling,
  type CeilingGrid,
  type Command,
  type LevelSyncPlan,
  type MaterialLayer,
  type PartHost,
  type SurfacesAtResult,
  type SyncStorey,
  type Wall,
} from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { measure, measureIn, type Measure } from "@permitzip/bim-units";
import { ScriptRunError, type ScriptContext } from "./context";
import { existingLevel, levelOf } from "./levels";
import { ScriptReadError } from "./slice";
import { onWorking, onWorkingIfAny } from "./working";

/**
 * `building` and `equipment`: the kit's helpers for the building and what
 * sits in it. Each builds one of the kernel's own commands and sends it
 * through `ctx.edit`, so the kernel (and the model's add-ons) decide it and
 * every refusal is the kernel's sentence. Kinds are the registry's ids
 * ("wall", "door", "slab"); nothing here names a trade.
 */

type CreateElements = Extract<Command, { type: "create_elements" }>;
type CreateHosted = Extract<Command, { type: "create_hosted" }>;
type CreateSpace = Extract<Command, { type: "create_space" }>;
type CreateElement = Extract<Command, { type: "create_element" }>;
type PlacePart = Extract<Command, { type: "place_part" }>;
type CreateLevel = Extract<Command, { type: "create_level" }>;
type SpaceInWalls = Extract<Command, { type: "place_space_in_walls" }>;
type CreateCeiling = Extract<Command, { type: "create_ceiling" }>;
type ElementSize = NonNullable<CreateElements["size"]>;
type Values = NonNullable<CreateElements["values"]>;

/** A plan point, as lengths. */
export interface PlanPoint {
  readonly x: Measure;
  readonly y: Measure;
}

function mm(m: Measure, what: string): number {
  if (m.kind !== "length") throw new Error(`${what} is a length; the value given is a ${m.kind}.`);
  return Math.round(measureIn(m, "mm") * 1000) / 1000;
}

function ksi(m: Measure, what: string): number {
  if (m.kind !== "stress") throw new Error(`${what} is a stress; the value given is a ${m.kind}.`);
  const v = measureIn(m, "ksi");
  if (!(Number.isFinite(v) && v > 0)) throw new Error(`${what} must be a finite number greater than zero.`);
  return Math.round(v * 1000) / 1000;
}

function planMm(p: PlanPoint, what: string): { x: number; y: number } {
  return { x: mm(p.x, `${what} x`), y: mm(p.y, `${what} y`) };
}

function sizeMm(size: { readonly thickness?: Measure; readonly height?: Measure; readonly width?: Measure; readonly depth?: Measure } | undefined): ElementSize | undefined {
  if (!size) return undefined;
  const out: { thicknessMm?: number; heightMm?: number; widthMm?: number; depthMm?: number } = {};
  if (size.thickness) out.thicknessMm = mm(size.thickness, "Thickness");
  if (size.height) out.heightMm = mm(size.height, "Height");
  if (size.width) out.widthMm = mm(size.width, "Width");
  if (size.depth) out.depthMm = mm(size.depth, "Depth");
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A chain of elements the kernel drew: `<prefix>-1`, `<prefix>-2`, … one per leg. */
export interface ChainHandle {
  readonly prefix: string;
  /** The n-th element of the chain (from 1). */
  element(n: number): string;
  readonly command: CreateElements;
}

/** A surface a wall's top runs to, as a script says it. */
export type TopSurface = "structure above" | "ceiling" | "roof";

/**
 * Where a wall's top is: up to a level (and an offset above it, negative
 * below), or to a surface over it (the underside of the slab above, a
 * ceiling, a roof, sloped with it), optionally offset. Its height then
 * follows it.
 */
export type WallTop = { readonly level: string; readonly offset?: Measure } | TopSurface | { readonly to: TopSurface; readonly elementId?: string; readonly offset?: Measure };

/** Where a wall's base is: on its level raised by an offset, or on the top of the slab under it ("slab below"), optionally offset. */
export type WallBase = { readonly offset: Measure } | "slab below" | { readonly to: "slab below"; readonly offset?: Measure };

export interface ChainSpec {
  readonly level: string;
  readonly points: readonly PlanPoint[];
  /** Back to the first point (a closed outline: four walls of a room, a slab's edge). */
  readonly closed?: boolean;
  /** A type the model or the firm library has (its id); absent: the kind's default type. */
  readonly typeId?: string;
  readonly thickness?: Measure;
  /** A fixed height. Leave it out with `top` or `topLevel`. */
  readonly height?: Measure;
  /** Walls: where the top runs to (a level, the structure above, a ceiling, a roof). Absent: `topLevel`, else `height`. */
  readonly top?: WallTop;
  /** Walls: where the base stands. Absent: on `level`. */
  readonly base?: WallBase;
  /** The level the top runs up to (its id), the same as `top: { level }`: the height follows that level and the base level when either moves. Not with `height`. */
  readonly topLevel?: string;
  /** With `topLevel`: how far above (negative: below) that level the top stops. */
  readonly topOffset?: Measure;
  /** Optional registered material id (from `building.materials()`), stored as `values["material.id"]`. */
  readonly material?: string;
  readonly values?: Values;
  readonly label?: string;
  /** Ids start with this; absent: a fresh id from the run's seed. */
  readonly id?: string;
}

const SURFACE_TO = { "structure above": "structure", ceiling: "ceiling", roof: "roof" } as const;

/** A chain's top and base as the kernel's command fields. */
function boundsOf(ctx: ScriptContext, spec: ChainSpec): Pick<CreateElements, "topLevelId" | "topOffsetMm" | "topSurface" | "baseSurface" | "baseOffsetMm"> {
  const out: { topLevelId?: string; topOffsetMm?: number; topSurface?: NonNullable<CreateElements["topSurface"]>; baseSurface?: NonNullable<CreateElements["baseSurface"]>; baseOffsetMm?: number } = {};
  const top = spec.top ?? (spec.topLevel ? { level: spec.topLevel, ...(spec.topOffset ? { offset: spec.topOffset } : {}) } : undefined);
  if (typeof top === "string") out.topSurface = { to: SURFACE_TO[top] };
  else if (top && "level" in top) {
    out.topLevelId = levelOf(ctx, top.level, "The top level");
    if (top.offset) out.topOffsetMm = mm(top.offset, "Top offset");
  } else if (top) {
    out.topSurface = {
      to: SURFACE_TO[top.to],
      ...(top.elementId ? { elementId: top.elementId } : {}),
      ...(top.offset ? { offsetMm: mm(top.offset, "Top offset") } : {}),
    };
  }
  const base = spec.base;
  if (base === "slab below") out.baseSurface = { to: "floor" };
  else if (base && "to" in base) out.baseSurface = { to: "floor", ...(base.offset ? { offsetMm: mm(base.offset, "Base offset") } : {}) };
  else if (base) out.baseOffsetMm = mm(base.offset, "Base offset");
  return out;
}

function chain(ctx: ScriptContext, kind: string, spec: ChainSpec): ChainHandle {
  if (spec.topOffset && !spec.topLevel) throw new Error("A top offset needs the level the top runs up to; give topLevel too.");
  if (spec.top !== undefined && spec.topLevel !== undefined) throw new Error("Give a wall either top or topLevel, not both.");
  if ((spec.top !== undefined || spec.topLevel !== undefined) && spec.height !== undefined) throw new Error("Give a wall either a height or a top, not both.");
  const size = sizeMm({ thickness: spec.thickness, height: spec.height });
  const mergedValues = spec.material || spec.values ? { ...(spec.values ?? {}), ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}) } : undefined;
  const command: CreateElements = {
    type: "create_elements",
    idPrefix: spec.id ?? ctx.id(kind),
    levelId: levelOf(ctx, spec.level),
    kind,
    points: spec.points.map((p, i) => planMm(p, `Point ${i + 1}`)),
    ...(spec.closed ? { closed: true } : {}),
    ...(spec.typeId ? { typeId: spec.typeId } : {}),
    ...(size ? { size } : {}),
    ...boundsOf(ctx, spec),
    ...(mergedValues ? { values: mergedValues } : {}),
    ...(spec.label ? { label: spec.label } : {}),
  };
  ctx.edit(command);
  return { prefix: command.idPrefix, element: (n) => `${command.idPrefix}-${n}`, command };
}

/** One wall from `from` to `to`, its top and base as `building.walls` takes them. */
export interface WallSpec extends Omit<ChainSpec, "points" | "closed"> {
  readonly from: PlanPoint;
  readonly to: PlanPoint;
}

/** IFC4 door operation enums plus friendly lowercase aliases accepted by `building.door`. */
export type DoorOperation =
  | "SINGLE_SWING_LEFT"
  | "SINGLE_SWING_RIGHT"
  | "DOUBLE_DOOR_SINGLE_SWING"
  | "DOUBLE_SWING_LEFT"
  | "DOUBLE_SWING_RIGHT"
  | "DOUBLE_DOOR_DOUBLE_SWING"
  | "SLIDING_TO_LEFT"
  | "SLIDING_TO_RIGHT"
  | "DOUBLE_DOOR_SLIDING"
  | "FOLDING_TO_LEFT"
  | "FOLDING_TO_RIGHT"
  | "DOUBLE_DOOR_FOLDING"
  | "REVOLVING"
  | "ROLLINGUP"
  | "SWING_FIXED_LEFT"
  | "SWING_FIXED_RIGHT"
  | "USERDEFINED"
  | "NOTDEFINED"
  | "single_left"
  | "single_right"
  | "double"
  | "double_swing"
  | "double_acting_left"
  | "double_acting_right"
  | "double_acting_pair"
  | "sliding_left"
  | "sliding_right"
  | "sliding_double"
  | "folding_left"
  | "folding_right"
  | "folding_double"
  | "bifold_left"
  | "bifold_right"
  | "bifold_double"
  | "overhead"
  | "rolling"
  | "revolving"
  | "swing_fixed_left"
  | "swing_fixed_right";

export type DoorSwing = "inward" | "outward" | "INWARD" | "OUTWARD";
export type DoorHanding = "LH" | "RH" | "LHR" | "RHR";

/** IFC4 window partitioning enums plus friendly lowercase aliases accepted by `building.window`. */
export type WindowPartitioning =
  | "SINGLE_PANEL"
  | "DOUBLE_PANEL_VERTICAL"
  | "DOUBLE_PANEL_HORIZONTAL"
  | "TRIPLE_PANEL_VERTICAL"
  | "TRIPLE_PANEL_HORIZONTAL"
  | "TRIPLE_PANEL_BOTTOM"
  | "TRIPLE_PANEL_TOP"
  | "TRIPLE_PANEL_LEFT"
  | "TRIPLE_PANEL_RIGHT"
  | "USERDEFINED"
  | "NOTDEFINED"
  | "single"
  | "double_vertical"
  | "double_hung"
  | "double_horizontal"
  | "triple_vertical"
  | "triple_horizontal"
  | "triple_bottom"
  | "triple_top"
  | "triple_left"
  | "triple_right";

const DOOR_OPERATION_MAP: Readonly<Record<string, string>> = {
  SINGLE_SWING_LEFT: "SINGLE_SWING_LEFT",
  SINGLE_SWING_RIGHT: "SINGLE_SWING_RIGHT",
  DOUBLE_DOOR_SINGLE_SWING: "DOUBLE_DOOR_SINGLE_SWING",
  DOUBLE_SWING_LEFT: "DOUBLE_SWING_LEFT",
  DOUBLE_SWING_RIGHT: "DOUBLE_SWING_RIGHT",
  DOUBLE_DOOR_DOUBLE_SWING: "DOUBLE_DOOR_DOUBLE_SWING",
  SLIDING_TO_LEFT: "SLIDING_TO_LEFT",
  SLIDING_TO_RIGHT: "SLIDING_TO_RIGHT",
  DOUBLE_DOOR_SLIDING: "DOUBLE_DOOR_SLIDING",
  FOLDING_TO_LEFT: "FOLDING_TO_LEFT",
  FOLDING_TO_RIGHT: "FOLDING_TO_RIGHT",
  DOUBLE_DOOR_FOLDING: "DOUBLE_DOOR_FOLDING",
  REVOLVING: "REVOLVING",
  ROLLINGUP: "ROLLINGUP",
  SWING_FIXED_LEFT: "SWING_FIXED_LEFT",
  SWING_FIXED_RIGHT: "SWING_FIXED_RIGHT",
  USERDEFINED: "USERDEFINED",
  NOTDEFINED: "NOTDEFINED",
  single_left: "SINGLE_SWING_LEFT",
  single_right: "SINGLE_SWING_RIGHT",
  double: "DOUBLE_DOOR_SINGLE_SWING",
  double_swing: "DOUBLE_DOOR_SINGLE_SWING",
  double_acting_left: "DOUBLE_SWING_LEFT",
  double_acting_right: "DOUBLE_SWING_RIGHT",
  double_acting_pair: "DOUBLE_DOOR_DOUBLE_SWING",
  sliding_left: "SLIDING_TO_LEFT",
  sliding_right: "SLIDING_TO_RIGHT",
  sliding_double: "DOUBLE_DOOR_SLIDING",
  folding_left: "FOLDING_TO_LEFT",
  folding_right: "FOLDING_TO_RIGHT",
  folding_double: "DOUBLE_DOOR_FOLDING",
  bifold_left: "FOLDING_TO_LEFT",
  bifold_right: "FOLDING_TO_RIGHT",
  bifold_double: "DOUBLE_DOOR_FOLDING",
  overhead: "ROLLINGUP",
  rolling: "ROLLINGUP",
  revolving: "REVOLVING",
  swing_fixed_left: "SWING_FIXED_LEFT",
  swing_fixed_right: "SWING_FIXED_RIGHT",
};

const WINDOW_PARTITIONING_MAP: Readonly<Record<string, string>> = {
  SINGLE_PANEL: "SINGLE_PANEL",
  DOUBLE_PANEL_VERTICAL: "DOUBLE_PANEL_VERTICAL",
  DOUBLE_PANEL_HORIZONTAL: "DOUBLE_PANEL_HORIZONTAL",
  TRIPLE_PANEL_VERTICAL: "TRIPLE_PANEL_VERTICAL",
  TRIPLE_PANEL_HORIZONTAL: "TRIPLE_PANEL_HORIZONTAL",
  TRIPLE_PANEL_BOTTOM: "TRIPLE_PANEL_BOTTOM",
  TRIPLE_PANEL_TOP: "TRIPLE_PANEL_TOP",
  TRIPLE_PANEL_LEFT: "TRIPLE_PANEL_LEFT",
  TRIPLE_PANEL_RIGHT: "TRIPLE_PANEL_RIGHT",
  USERDEFINED: "USERDEFINED",
  NOTDEFINED: "NOTDEFINED",
  single: "SINGLE_PANEL",
  double_vertical: "DOUBLE_PANEL_VERTICAL",
  double_hung: "DOUBLE_PANEL_HORIZONTAL",
  double_horizontal: "DOUBLE_PANEL_HORIZONTAL",
  triple_vertical: "TRIPLE_PANEL_VERTICAL",
  triple_horizontal: "TRIPLE_PANEL_HORIZONTAL",
  triple_bottom: "TRIPLE_PANEL_BOTTOM",
  triple_top: "TRIPLE_PANEL_TOP",
  triple_left: "TRIPLE_PANEL_LEFT",
  triple_right: "TRIPLE_PANEL_RIGHT",
};

const HANDED_DOOR_FLIP: Readonly<Record<string, string>> = {
  SINGLE_SWING_LEFT: "SINGLE_SWING_RIGHT",
  SINGLE_SWING_RIGHT: "SINGLE_SWING_LEFT",
  DOUBLE_SWING_LEFT: "DOUBLE_SWING_RIGHT",
  DOUBLE_SWING_RIGHT: "DOUBLE_SWING_LEFT",
  SWING_FIXED_LEFT: "SWING_FIXED_RIGHT",
  SWING_FIXED_RIGHT: "SWING_FIXED_LEFT",
  SLIDING_TO_LEFT: "SLIDING_TO_RIGHT",
  SLIDING_TO_RIGHT: "SLIDING_TO_LEFT",
  FOLDING_TO_LEFT: "FOLDING_TO_RIGHT",
  FOLDING_TO_RIGHT: "FOLDING_TO_LEFT",
};

function normalizeDoorOperation(op: string): string {
  const mapped = DOOR_OPERATION_MAP[op] ?? DOOR_OPERATION_MAP[op.toUpperCase()] ?? DOOR_OPERATION_MAP[op.toLowerCase()];
  if (!mapped) throw new Error(`Unknown door operation "${op}". Use an IFC4 operation (e.g. SINGLE_SWING_LEFT, SINGLE_SWING_RIGHT, DOUBLE_DOOR_SINGLE_SWING, DOUBLE_SWING_LEFT, SLIDING_TO_LEFT, DOUBLE_DOOR_SLIDING, FOLDING_TO_LEFT, DOUBLE_DOOR_FOLDING, ROLLINGUP, REVOLVING, SWING_FIXED_LEFT) or alias (single_left, single_right, double, sliding_left, overhead, revolving).`);
  return mapped;
}

function normalizeWindowPartitioning(part: string): string {
  const mapped = WINDOW_PARTITIONING_MAP[part] ?? WINDOW_PARTITIONING_MAP[part.toUpperCase()] ?? WINDOW_PARTITIONING_MAP[part.toLowerCase()];
  if (!mapped) throw new Error(`Unknown window partitioning "${part}". Use SINGLE_PANEL, DOUBLE_PANEL_VERTICAL, DOUBLE_PANEL_HORIZONTAL, TRIPLE_PANEL_VERTICAL, etc. (or aliases single, double_vertical, double_hung, triple_vertical).`);
  return mapped;
}

export interface OpeningSpec {
  /** The wall it sits in. */
  readonly wall: string;
  /** Distance along the wall from its start to the opening's centre. */
  readonly along: Measure;
  readonly width?: Measure;
  readonly height?: Measure;
  /** How high its bottom sits above the floor of its wall (a window's sill); the kernel refuses one that puts the head above the wall. */
  readonly sill?: Measure;
  /** Which face it opens to: 1 or -1 (the wall's left or right, looking from its start). */
  readonly side?: 1 | -1;
  readonly typeId?: string;
  readonly mark?: string;
  /** Optional registered material id (from `building.materials()`), stored as `values["material.id"]`. */
  readonly material?: string;
  /** Optional frame depth across the host wall (`architecture.frame_depth`); defaults to host wall thickness. */
  readonly frameDepth?: Measure;
  /** Whether the opening is in the exterior envelope (`architecture.is_external`). */
  readonly external?: boolean;
  readonly values?: Values;
  readonly id?: string;
}

export interface DoorSpec extends OpeningSpec {
  /** Door operation type (IFC4 enum or alias, e.g. `"SINGLE_SWING_RIGHT"`, `"DOUBLE_DOOR_SINGLE_SWING"`, `"SLIDING_TO_LEFT"`, `"ROLLINGUP"`, `"REVOLVING"`, `"SWING_FIXED_LEFT"`, or `"double"`, `"overhead"`). */
  readonly operation?: DoorOperation;
  /** Convenience hinge side (`"left"` or `"right"`): picks `SINGLE_SWING_LEFT` / `SINGLE_SWING_RIGHT` when `operation` is omitted, or swaps left/right on a handed operation. */
  readonly hinge?: "left" | "right";
  /** Swing direction (`"inward"` → side `1` / wall left face, `"outward"` → side `-1` / wall right face); explicit `side` wins if both are given. */
  readonly swing?: DoorSwing;
  /** Standard US hardware handing (`"LH"`, `"RH"`, `"LHR"`, `"RHR"`): sets `architecture.door_handing` and defaults hinge + swing side when `operation` / `side` are omitted. */
  readonly handing?: DoorHanding;
  /** Optional fire-protection rating (e.g. `"20 min"`, `"45 min"`, `"90 min"`), stored as `arch.fire_rating`. */
  readonly fireRating?: string;
}

export interface WindowSpec extends OpeningSpec {
  /** Window sash/panel partitioning (IFC4 enum or alias, e.g. `"DOUBLE_PANEL_HORIZONTAL"`, `"TRIPLE_PANEL_VERTICAL"`, or `"double_hung"`, `"double_vertical"`). */
  readonly partitioning?: WindowPartitioning;
}

function opening(ctx: ScriptContext, openingType: string, spec: OpeningSpec, extraValues?: Values, resolvedSide?: 1 | -1): string {
  const size = sizeMm({ width: spec.width, height: spec.height });
  const merged: Record<string, string | number | boolean> = {
    ...(spec.values ?? {}),
    ...(extraValues ?? {}),
    ...(spec.sill ? { [OPENING_SILL_KEY]: mm(spec.sill, "Sill height") } : {}),
    ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
    ...(spec.frameDepth ? { "architecture.frame_depth": mm(spec.frameDepth, "Frame depth") } : {}),
    ...(spec.external !== undefined ? { "architecture.is_external": spec.external } : {}),
  };
  const side = resolvedSide ?? spec.side ?? 1;
  const command: CreateHosted = {
    type: "create_hosted",
    elementId: spec.id ?? ctx.id(openingType),
    kind: "opening",
    openingType,
    hostId: spec.wall,
    s: mm(spec.along, "Distance along the wall"),
    side,
    ...(spec.typeId ? { typeId: spec.typeId } : {}),
    ...(spec.mark ? { mark: spec.mark } : {}),
    ...(Object.keys(merged).length > 0 ? { values: merged } : {}),
    ...(size ? { size } : {}),
  };
  ctx.edit(command);
  return command.elementId;
}

function resolveDoorSpecValues(spec: DoorSpec): { readonly values: Values; readonly side: 1 | -1 } {
  const extra: Record<string, string | number | boolean> = {};
  let op = spec.operation ? normalizeDoorOperation(spec.operation) : undefined;
  if (spec.hinge) {
    if (!op) op = spec.hinge === "right" ? "SINGLE_SWING_RIGHT" : "SINGLE_SWING_LEFT";
    else if (spec.hinge === "right" && op.endsWith("_LEFT") && HANDED_DOOR_FLIP[op]) op = HANDED_DOOR_FLIP[op];
    else if (spec.hinge === "left" && op.endsWith("_RIGHT") && HANDED_DOOR_FLIP[op]) op = HANDED_DOOR_FLIP[op];
  }
  const handing = spec.handing ? spec.handing.toUpperCase() as DoorHanding : undefined;
  if (handing) {
    extra["architecture.door_handing"] = handing;
    if (!op) op = handing === "RH" || handing === "RHR" ? "SINGLE_SWING_RIGHT" : "SINGLE_SWING_LEFT";
  }
  if (op) extra["architecture.door_operation"] = op;
  const swingUpper = spec.swing ? spec.swing.toUpperCase() : undefined;
  if (swingUpper === "INWARD" || swingUpper === "OUTWARD") extra["architecture.door_swing"] = swingUpper;
  if (spec.fireRating !== undefined) extra["arch.fire_rating"] = spec.fireRating;

  // Explicit `side` wins over `swing` and `handing`.
  const side: 1 | -1 =
    spec.side ??
    (swingUpper === "OUTWARD" ? -1 : swingUpper === "INWARD" ? 1 : handing === "LHR" || handing === "RHR" ? -1 : 1);
  if (spec.side !== undefined && (swingUpper !== undefined || handing !== undefined)) {
    extra["host.side"] = spec.side;
  }
  return { values: extra, side };
}

export interface SpaceSpec {
  readonly level: string;
  readonly number: string;
  readonly name: string;
  /** Its outline on plan; absent: the kernel finds the room the walls enclose at `origin`. */
  readonly outline?: readonly PlanPoint[];
  readonly ceilingHeight?: Measure;
  readonly occupants?: number;
  readonly id?: string;
}

export interface LevelSpec {
  readonly name: string;
  /** Its height above the project's zero. */
  readonly elevation: Measure;
  /** True for an occupied building story, false for a ceiling/roof/parapet datum reference. */
  readonly buildingStory?: boolean;
  readonly id?: string;
}

export interface SpaceInWallsSpec {
  readonly level: string;
  /** A point inside the room: the kernel traces the walls around it. */
  readonly inside: PlanPoint;
  readonly number?: string;
  readonly name?: string;
  readonly id?: string;
}

/** Where to look: an element (a part's base), or a point on a level. */
export type SurfacesTargetSpec =
  | { readonly element: string }
  | { readonly at: { readonly x: Measure; readonly y: Measure }; readonly level?: string; readonly elevation?: Measure };

/** A linked model's storeys (from the host, or the script's own values) to match the model's levels to. */
export interface LevelSyncSpec {
  /** The linked model's id. */
  readonly reference: string;
  readonly storeys: readonly { readonly storeyId: string; readonly name: string; readonly elevation: Measure; readonly levelId?: string }[];
}

function storeysOf(ctx: ScriptContext, spec: LevelSyncSpec): SyncStorey[] {
  return spec.storeys.map((s) => ({ storeyId: s.storeyId, name: s.name, elevationMm: mm(s.elevation, `Storey ${s.name} elevation`), levelId: s.levelId ?? ctx.id("level") }));
}

/** Real-scale ACT ceiling tile grid definition: exact 2'×4' / 2'×2' preset or custom tile dimensions, with anchor origin and rotation. */
export type CeilingGridSpec =
  | {
      /** Standard imperial tile pitch: `"2x4"` (48"×24" = 1219.2×609.6 mm) or `"2x2"` (24"×24" = 609.6×609.6 mm). */
      readonly preset: "2x4" | "2x2";
      readonly origin?: PlanPoint;
      readonly rotationDeg?: number;
    }
  | {
      readonly preset?: undefined;
      /** Tile pitch along local X (e.g. `units.ft(4)` for a 2'×4' tile or `units.ft(2)` for 2'×2'). */
      readonly spacingX: Measure;
      /** Tile pitch along local Y (e.g. `units.ft(2)`). */
      readonly spacingY: Measure;
      readonly origin?: PlanPoint;
      readonly rotationDeg?: number;
    };

function ceilingGridMm(spec: CeilingGridSpec): CeilingGrid {
  const spacingXMm = "preset" in spec && spec.preset ? (spec.preset === "2x4" ? TILE_4FT_MM : TILE_2FT_MM) : mm((spec as { spacingX: Measure }).spacingX, "Ceiling grid spacingX");
  const spacingYMm = "preset" in spec && spec.preset ? TILE_2FT_MM : mm((spec as { spacingY: Measure }).spacingY, "Ceiling grid spacingY");
  return {
    spacingXMm,
    spacingYMm,
    ...(spec.origin ? { origin: planMm(spec.origin, "Ceiling grid origin") } : {}),
    ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
  };
}

/** A ceiling: its outline on plan and its height above the level. */
export interface CeilingSpec {
  /** The level it is on: its id, or the name of exactly one level the script read. */
  readonly level: string;
  /** Corners in order (either direction). */
  readonly outline: readonly PlanPoint[];
  /** Height above the level (where it is measured on a sloped one: `reference`, else the first corner). */
  readonly height: Measure;
  /** The space it is in (its id); absent: in none (a canopy, an open area). */
  readonly space?: string;
  /** Openings cut out of it, each an outline. */
  readonly holes?: readonly (readonly PlanPoint[])[];
  /** A sloped ceiling: the direction it rises toward (degrees counter-clockwise from east) and its rise over run (0.25 is 3 in 12). */
  readonly slope?: { readonly directionDeg: number; readonly pitch: number };
  /** Where `height` is measured on a sloped ceiling. */
  readonly reference?: PlanPoint;
  /** Ceiling form: flat (drop/ACT), sloped, floating acoustic cloud, soffit, or open_to_structure. */
  readonly form?: "flat" | "sloped" | "cloud" | "soffit" | "open_to_structure";
  /** Explicit real-scale ACT ceiling tile grid (`{ preset: "2x4" | "2x2" }` or custom `spacingX`/`spacingY`, `origin`, `rotationDeg`). */
  readonly grid?: CeilingGridSpec;
  /** A ceiling type the model has (what it is made of: an acoustic tile, gypsum board). */
  readonly typeId?: string;
  /** Registered material id (from `building.materials()`), e.g. `"architecture.act_ceiling"` or `"architecture.gypsum_partition"`. */
  readonly material?: string;
  readonly id?: string;
}

/** The kinds that bound rooms in the add-ons in force (walls, separation lines, an add-on's partitions) the script neither read nor drew, when nothing that bounds rooms is in its model; else null. */
function unreadBounding(ctx: ScriptContext): readonly { readonly kind: string; readonly label: string }[] | null {
  return (
    onWorkingIfAny(ctx, (model) => {
      const rows = activePackSet().items(BOUNDING_ELEMENT_POINT);
      const kinds = new Set(rows.map((r) => r.kind));
      for (const id in model.elements) if (kinds.has(model.elements[id]?.kind ?? "")) return null;
      const unread = rows.filter((r) => {
        try {
          ctx.model.ofKind(r.kind);
          return false;
        } catch (err) {
          if (err instanceof ScriptReadError) return true;
          throw err;
        }
      });
      return unread.length > 0 ? unread.map((r) => ({ kind: r.kind, label: r.label })) : null;
    }) ?? null
  );
}

export interface RoomSpec {
  readonly level: string;
  readonly number: string;
  readonly name: string;
  /** Corners in order (either direction), on wall centrelines or faces. */
  readonly outline: readonly PlanPoint[];
  readonly id?: string;
}

export const building = {
  /** A room (number, name, outline) on a level, as the architect's room: what receptacle spacing, room schedules and room templates read. Returns its id. */
  room(ctx: ScriptContext, spec: RoomSpec): string {
    const roomId = spec.id ?? ctx.id("room");
    ctx.edit({ type: "add_architecture", levelId: levelOf(ctx, spec.level), walls: [], openings: [], casework: [], rooms: [{ roomId, number: spec.number, name: spec.name, outline: spec.outline.map((p, i) => planMm(p, `Room corner ${i + 1}`)) }] });
    return roomId;
  },
  /**
   * The floor or roof under an element or point, the ceiling and roof over
   * it, and the structure above, each with its height (mm) and where it came
   * from. The model's own surfaces; a linked model's slabs are the host's.
   */
  surfacesAt(ctx: ScriptContext, target: SurfacesTargetSpec): Extract<SurfacesAtResult, { ok: true }> {
    const result = onWorking(ctx, "building.surfacesAt", (model) =>
      surfacesAt(model, "element" in target ? { elementId: asElementId(target.element) } : { point: planMm(target.at, "Point"), ...(target.level ? { levelId: asElementId(levelOf(ctx, target.level)) } : {}), ...(target.elevation ? { elevationMm: mm(target.elevation, "Elevation") } : {}) }),
    );
    if (!result.ok) throw new ScriptRunError(result.reason);
    return result;
  },
  /** What syncing levels to these storeys would do (add, update, match, unchanged), without changing anything. */
  levelSyncPlan(ctx: ScriptContext, spec: LevelSyncSpec): LevelSyncPlan {
    const storeys = storeysOf(ctx, spec);
    return onWorking(ctx, "building.levelSyncPlan", (model) => planLevelSync(model, spec.reference, storeys));
  },
  /** Makes the model's levels match the storeys, as one edit (levels are matched by name and height first). */
  syncLevels(ctx: ScriptContext, spec: LevelSyncSpec): void {
    ctx.edit({ type: "sync_levels", referenceId: spec.reference, storeys: storeysOf(ctx, spec) });
  },

  /** A level at an elevation; returns its id. A level the script read with this name at this elevation is used as it is (a new model starts with "Level 1"). */
  level(ctx: ScriptContext, spec: LevelSpec): string {
    const elevationMm = mm(spec.elevation, "Elevation");
    const existing = existingLevel(ctx, spec.name, elevationMm, spec.id);
    if (existing) return existing;
    const command: CreateLevel = {
      type: "create_level",
      levelId: spec.id ?? ctx.id("level"),
      name: spec.name,
      elevationMm,
      ...(spec.buildingStory !== undefined ? { buildingStory: spec.buildingStory } : {}),
    };
    ctx.edit(command);
    return command.levelId;
  },
  /** A room found from the walls around a point; the kernel refuses an open room in words. Returns the space's id. */
  spaceInWalls(ctx: ScriptContext, spec: SpaceInWallsSpec): string {
    const unread = unreadBounding(ctx);
    if (unread) {
      const [first] = unread;
      throw new ScriptRunError(
        `building.spaceInWalls traces what bounds the room around the point, but you didn't read ${unread.map((r) => `${r.label.toLowerCase()}s`).join(" or ")}, so this run has none. Add "${first?.kind ?? "wall"}" to reads.kinds${unread.length > 1 ? ` (and ${unread.slice(1).map((r) => `"${r.kind}"`).join(", ")} if those bound it)` : ""}, or draw the walls in the script first.`,
      );
    }
    const command: SpaceInWalls = {
      type: "place_space_in_walls",
      spaceId: spec.id ?? ctx.id("space"),
      levelId: levelOf(ctx, spec.level),
      seed: planMm(spec.inside, "Point inside the room"),
      ...(spec.number ? { number: spec.number } : {}),
      ...(spec.name ? { name: spec.name } : {}),
    };
    ctx.edit(command);
    return command.spaceId;
  },
  /** Walls along the points (one wall per leg). `closed` joins the last point to the first; `top` runs their tops to a level, the structure above, a ceiling or a roof, `base` stands them on the slab below. */
  walls(ctx: ScriptContext, spec: ChainSpec): ChainHandle {
    return chain(ctx, "wall", spec);
  },
  /** One wall from `from` to `to`; returns its id. `top` and `base` as for `walls`. */
  wall(ctx: ScriptContext, spec: WallSpec): string {
    const { from, to, ...rest } = spec;
    return chain(ctx, "wall", { ...rest, points: [from, to] }).element(1);
  },
  /** A floor or structural deck slab with this outline (and optional stairwell/atrium `holes`, one-way `spanDirectionDeg`, and live-load `occupancy`); returns its id. */
  floor(
    ctx: ScriptContext,
    spec: Omit<ChainSpec, "closed" | "topLevel" | "topOffset" | "top" | "base"> & {
      readonly holes?: readonly (readonly PlanPoint[])[];
      readonly spanDirectionDeg?: number;
      readonly baseOffset?: Measure;
      readonly classId?: string;
      readonly occupancy?: string;
      readonly mark?: string;
    },
  ): string {
    const size = sizeMm({ thickness: spec.thickness });
    const mergedValues =
      spec.material || spec.values || spec.occupancy || spec.mark
        ? {
            ...(spec.values ?? {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
            ...(spec.occupancy ? { "struct.occupancy": spec.occupancy } : {}),
            ...(spec.mark ? { mark: spec.mark } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("slab"),
      levelId: levelOf(ctx, spec.level),
      kind: "slab",
      placement: {
        kind: "area",
        outline: spec.points.map((p, i) => planMm(p, `Outline point ${i + 1}`)),
        ...(spec.holes ? { holes: spec.holes.map((h, i) => h.map((p, j) => planMm(p, `Slab hole ${i + 1} corner ${j + 1}`))) } : {}),
        ...(spec.spanDirectionDeg !== undefined ? { spanDirectionDeg: spec.spanDirectionDeg } : {}),
      },
      ...(spec.classId ? { classId: spec.classId } : {}),
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(spec.baseOffset ? { baseOffsetMm: mm(spec.baseOffset, "Slab offset") } : {}),
      ...(size ? { size } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
      ...(spec.label ? { label: spec.label } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A flat, single-slope shed, two-slope gable, or four-slope hip roof (`architecture.roof`); returns its id. */
  roof(
    ctx: ScriptContext,
    spec: Omit<ChainSpec, "closed" | "topLevel" | "topOffset" | "top" | "base"> & {
      readonly form?: "flat" | "shed" | "gable" | "hip";
      readonly slopeRise?: number;
      readonly slopeDirectionDeg?: number;
      readonly baseOffset?: Measure;
    },
  ): string {
    const size = sizeMm({ thickness: spec.thickness });
    const mergedValues =
      spec.material || spec.values || spec.form || spec.slopeRise !== undefined || spec.slopeDirectionDeg !== undefined || spec.baseOffset !== undefined
        ? {
            ...(spec.values ?? {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
            ...(spec.form ? { "architecture.roof_form": spec.form.toLowerCase() } : {}),
            ...(spec.slopeRise !== undefined ? { "architecture.slope_rise": spec.slopeRise } : {}),
            ...(spec.slopeDirectionDeg !== undefined ? { "architecture.slope_direction_deg": spec.slopeDirectionDeg } : {}),
            ...(spec.baseOffset !== undefined ? { "architecture.base_offset_mm": mm(spec.baseOffset, "Roof base offset") } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("roof"),
      levelId: levelOf(ctx, spec.level),
      kind: "architecture.roof",
      placement: { kind: "area", outline: spec.points.map((p, i) => planMm(p, `Outline point ${i + 1}`)) },
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(size ? { size } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
      ...(spec.label ? { label: spec.label } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A stair (`architecture.stair`) climbing from `from` to `to` — supports straight runs, 90° L-shape, and 180° U-shape switchbacks with landings; returns its id. */
  stair(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly from: PlanPoint;
      readonly to: PlanPoint;
      readonly width?: Measure;
      readonly topLevel?: string;
      readonly risers?: number;
      readonly form?: "straight" | "l_shape" | "u_shape";
      readonly turn?: "left" | "right";
      readonly landingDepth?: Measure;
      readonly wellGap?: Measure;
      readonly material?: string;
      readonly id?: string;
    },
  ): string {
    const size = sizeMm({ width: spec.width });
    const landingDepthMm = spec.landingDepth !== undefined ? mm(spec.landingDepth, "Stair landing depth") : undefined;
    const wellGapMm = spec.wellGap !== undefined ? mm(spec.wellGap, "Stair well gap") : undefined;
    const mergedValues =
      spec.topLevel || spec.risers !== undefined || spec.form || spec.turn || landingDepthMm !== undefined || wellGapMm !== undefined || spec.material
        ? {
            ...(spec.topLevel ? { "architecture.top_level": levelOf(ctx, spec.topLevel) } : {}),
            ...(spec.risers !== undefined ? { "architecture.risers": spec.risers } : {}),
            ...(spec.form ? { "architecture.stair_form": spec.form.toLowerCase() } : {}),
            ...(spec.turn ? { "architecture.stair_turn": spec.turn.toLowerCase() } : {}),
            ...(landingDepthMm !== undefined ? { "architecture.landing_depth_mm": landingDepthMm } : {}),
            ...(wellGapMm !== undefined ? { "architecture.well_gap_mm": wellGapMm } : {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("stair"),
      levelId: levelOf(ctx, spec.level),
      kind: "architecture.stair",
      placement: { kind: "line", start: planMm(spec.from, "Stair foot"), end: planMm(spec.to, "Stair top") },
      ...(size ? { size } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A guardrail or handrail (`architecture.railing` → `IfcRailing`) along a straight segment (`from` → `to`) or continuous polyline (`points`); defaults to 42" IBC commercial height; returns its id. */
  railing(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly from?: PlanPoint;
      readonly to?: PlanPoint;
      readonly points?: readonly PlanPoint[];
      readonly height?: Measure;
      readonly style?: "glass" | "picket" | "cable" | "horizontal_bar" | "solid";
      readonly postSpacing?: Measure;
      readonly balusterSpacing?: Measure;
      readonly handrail?: boolean;
      readonly baseOffset?: Measure;
      readonly material?: string;
      readonly id?: string;
    },
  ): string {
    const poly = spec.points && spec.points.length >= 2 ? spec.points.map((p, i) => planMm(p, `Railing point ${i + 1}`)) : null;
    const start = poly ? poly[0]! : spec.from ? planMm(spec.from, "Railing start") : null;
    const end = poly ? poly[poly.length - 1]! : spec.to ? planMm(spec.to, "Railing end") : null;
    if (!start || !end) {
      throw new Error("building.railing requires either { from, to } or { points } with at least 2 points");
    }
    const heightMm = spec.height !== undefined ? mm(spec.height, "Railing height") : undefined;
    const postSpacingMm = spec.postSpacing !== undefined ? mm(spec.postSpacing, "Railing post spacing") : undefined;
    const balusterSpacingMm = spec.balusterSpacing !== undefined ? mm(spec.balusterSpacing, "Railing baluster spacing") : undefined;
    const baseOffsetMm = spec.baseOffset !== undefined ? mm(spec.baseOffset, "Railing base offset") : undefined;
    const mergedValues = {
      ...(spec.style ? { "architecture.railing_style": spec.style } : {}),
      ...(heightMm !== undefined ? { "architecture.railing_height_mm": heightMm } : {}),
      ...(postSpacingMm !== undefined ? { "architecture.post_spacing_mm": postSpacingMm } : {}),
      ...(balusterSpacingMm !== undefined ? { "architecture.baluster_spacing_mm": balusterSpacingMm } : {}),
      ...(spec.handrail !== undefined ? { "architecture.rail_handrail": spec.handrail } : {}),
      ...(baseOffsetMm !== undefined ? { "architecture.base_offset_mm": baseOffsetMm } : {}),
      ...(poly && poly.length > 2 ? { "architecture.railing_path": poly.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(";") } : {}),
      ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
    };
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("railing"),
      levelId: levelOf(ctx, spec.level),
      kind: "architecture.railing",
      placement: { kind: "line", start, end },
      ...(heightMm !== undefined ? { size: { heightMm } } : {}),
      ...(Object.keys(mergedValues).length > 0 ? { values: mergedValues } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A structural column grid line (`grid`, e.g. `1`, `A`) shown as a vertical 3D datum across every plan, RCP, and building section; returns its id. */
  grid(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly from: PlanPoint;
      readonly to: PlanPoint;
      readonly label?: string;
      readonly id?: string;
    },
  ): string {
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("grid"),
      levelId: levelOf(ctx, spec.level),
      kind: "grid",
      placement: { kind: "line", start: planMm(spec.from, "Grid start"), end: planMm(spec.to, "Grid end") },
      ...(spec.label ? { label: spec.label } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A structural or architectural column at a plan point with fixed `height` or level-tied `topLevel`/`topOffset`; returns its id. */
  column(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly at: PlanPoint;
      readonly width?: Measure;
      readonly depth?: Measure;
      readonly height?: Measure;
      readonly topLevel?: string;
      readonly topOffset?: Measure;
      readonly baseOffset?: Measure;
      readonly rotationDeg?: number;
      readonly typeId?: string;
      readonly classId?: string;
      readonly section?: string;
      readonly grade?: string;
      readonly mark?: string;
      readonly columnMaterial?: string;
      readonly material?: string;
      readonly values?: Readonly<Record<string, number | string | boolean>>;
      readonly id?: string;
    },
  ): string {
    const size = sizeMm({ width: spec.width, depth: spec.depth, height: spec.height });
    const mergedValues =
      spec.material || spec.values || spec.section || spec.grade || spec.mark
        ? {
            ...(spec.values ?? {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
            ...(spec.section ? { "struct.section": spec.section } : {}),
            ...(spec.grade ? { "struct.grade": spec.grade } : {}),
            ...(spec.mark ? { mark: spec.mark } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("col"),
      levelId: levelOf(ctx, spec.level),
      kind: "column",
      placement: {
        kind: "point",
        position: planMm(spec.at, "Column point"),
        ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
      },
      ...(spec.classId ? { classId: spec.classId } : spec.section ? { classId: "struct.column_steel" } : {}),
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(spec.columnMaterial ? { material: spec.columnMaterial } : spec.section ? { material: "steel" } : {}),
      ...(size ? { size } : {}),
      ...(spec.topLevel ? { topLevelId: levelOf(ctx, spec.topLevel, "The top level") } : {}),
      ...(spec.topOffset ? { topOffsetMm: mm(spec.topOffset, "Top offset") } : {}),
      ...(spec.baseOffset ? { baseOffsetMm: mm(spec.baseOffset, "Base offset") } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A structural beam from `from` to `to` (top aligned to `level` + optional `baseOffset`), with optional AISC `section`, `grade`, `elasticModulus` (E), `camber`, and `mark`; returns its id. */
  beam(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly from: PlanPoint;
      readonly to: PlanPoint;
      readonly section?: string;
      readonly grade?: string;
      readonly elasticModulus?: Measure;
      readonly camber?: Measure;
      readonly mark?: string;
      readonly baseOffset?: Measure;
      readonly typeId?: string;
      readonly classId?: string;
      readonly material?: string;
      readonly values?: Readonly<Record<string, number | string | boolean>>;
      readonly id?: string;
    },
  ): string {
    const mergedValues =
      spec.material || spec.values || spec.section || spec.grade || spec.elasticModulus || spec.camber || spec.mark
        ? {
            ...(spec.values ?? {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
            ...(spec.section ? { "struct.section": spec.section } : {}),
            ...(spec.grade ? { "struct.grade": spec.grade } : {}),
            ...(spec.elasticModulus ? { "struct.elastic_modulus": ksi(spec.elasticModulus, "Elastic modulus (E)") } : {}),
            ...(spec.camber ? { "struct.camber": mm(spec.camber, "Beam camber") } : {}),
            ...(spec.mark ? { mark: spec.mark } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("beam"),
      levelId: levelOf(ctx, spec.level),
      kind: "beam",
      placement: { kind: "line", start: planMm(spec.from, "Beam start"), end: planMm(spec.to, "Beam end") },
      ...(spec.classId ? { classId: spec.classId } : spec.section ? { classId: "struct.beam_steel" } : {}),
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(spec.section ? { label: spec.section } : {}),
      ...(spec.baseOffset ? { baseOffsetMm: mm(spec.baseOffset, "Beam offset") } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A concrete pad footing (`struct.footing_pad`) centered at `at` below `level` (plus optional `baseOffset`); returns its id. */
  footing(
    ctx: ScriptContext,
    spec: {
      readonly level: string;
      readonly at: PlanPoint;
      readonly width: Measure;
      readonly depth?: Measure;
      readonly thickness?: Measure;
      readonly rotationDeg?: number;
      readonly baseOffset?: Measure;
      readonly mark?: string;
      readonly label?: string;
      readonly typeId?: string;
      readonly classId?: string;
      readonly material?: string;
      readonly values?: Readonly<Record<string, number | string | boolean>>;
      readonly id?: string;
    },
  ): string {
    const size = sizeMm({ width: spec.width, depth: spec.depth ?? spec.width });
    const mergedValues =
      spec.material || spec.values || spec.thickness || spec.mark
        ? {
            ...(spec.values ?? {}),
            ...(spec.material ? { [MATERIAL_ID_KEY]: spec.material } : {}),
            ...(spec.thickness ? { "struct.footing_thickness_mm": mm(spec.thickness, "Footing thickness") } : {}),
            ...(spec.mark ? { mark: spec.mark } : {}),
          }
        : undefined;
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("ftg"),
      levelId: levelOf(ctx, spec.level),
      kind: "component",
      category: "footing",
      classId: spec.classId ?? "struct.footing_pad",
      placement: {
        kind: "point",
        position: planMm(spec.at, "Footing point"),
        ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
      },
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.baseOffset ? { baseOffsetMm: mm(spec.baseOffset, "Footing offset") } : {}),
      ...(size ? { size } : {}),
      ...(mergedValues ? { values: mergedValues } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** A glazed architectural storefront / curtain wall from `from` to `to`; returns its id. */
  curtainWall(ctx: ScriptContext, spec: WallSpec & { readonly mullionMaterial?: string }): string {
    const { from, to, values, material, mullionMaterial, ...rest } = spec;
    return chain(ctx, "wall", {
      ...rest,
      points: [from, to],
      material: material ?? "architecture.curtain_wall_glass",
      values: {
        ...(values ?? {}),
        "architecture.wall_function": "CURTAIN",
        ...(mullionMaterial ? { "architecture.mullion_material": mullionMaterial } : {}),
      },
    }).element(1);
  },
  /** Move a wall by a plan delta, carrying joined walls and collinear slab/ceiling/roof edges unless `disjoin: true`. */
  moveWall(ctx: ScriptContext, wallId: string, delta: PlanPoint, opts?: { readonly disjoin?: boolean }): void {
    ctx.edit({ type: "move_wall", wallId, delta: planMm(delta, "Delta"), ...(opts?.disjoin ? { disjoin: true } : {}) });
  },
  /** Slide a hosted door or window along its host wall by a plan delta (without moving the host wall). */
  moveOpening(ctx: ScriptContext, openingId: string, delta: PlanPoint): void {
    ctx.edit({ type: "move_elements", ids: [openingId], delta: planMm(delta, "Opening delta") });
  },
  /** Stretch or move one end of a wall (or any joinable line) to `to`, carrying joined ends unless `disjoin: true`. */
  moveWallEnd(ctx: ScriptContext, wallId: string, end: "start" | "end", to: PlanPoint, opts?: { readonly disjoin?: boolean }): void {
    ctx.edit({ type: "move_line_end", elementId: wallId, end, to: planMm(to, "Wall end"), ...(opts?.disjoin ? { disjoin: true } : {}) });
  },
  /** Every material registered in the active add-ons (`kernel.material`), including visual and building-envelope thermal properties. */
  materials(): readonly {
    readonly id: string;
    readonly name: string;
    readonly category?: string;
    readonly color: string;
    readonly pattern?: string;
    readonly thermalConductivityWPerMK?: number;
    readonly densityKgPerM3?: number;
    readonly shgc?: number;
  }[] {
    return allMaterials().map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.category ? { category: m.category } : {}),
      color: m.color,
      ...(m.pattern ? { pattern: m.pattern } : {}),
      ...(m.thermalConductivityWPerMK !== undefined ? { thermalConductivityWPerMK: m.thermalConductivityWPerMK } : {}),
      ...(m.densityKgPerM3 !== undefined ? { densityKgPerM3: m.densityKgPerM3 } : {}),
      ...(m.shgc !== undefined ? { shgc: m.shgc } : {}),
    }));
  },
  /** Compute steady-state ISO 6946 / ASHRAE R-value and U-value of a layered wall/roof/floor assembly from registered materials. */
  assemblyThermal(layers: readonly { readonly materialId: string; readonly thickness: Measure }[], opts?: { readonly includeAirFilms?: boolean }): AssemblyThermalSummary {
    const parsed: MaterialLayer[] = layers.map((l, i) => ({ materialId: l.materialId, thicknessMm: mm(l.thickness, `Layer ${i + 1} thickness`) }));
    return assemblyThermalSummary({ id: "script-assembly", layers: parsed }, opts);
  },
  /** Assign a registered material id (`building.materials()`) to one or more elements. */
  setMaterial(ctx: ScriptContext, elementIds: string | readonly string[], materialId: string): void {
    const ids = typeof elementIds === "string" ? [elementIds] : [...elementIds];
    ctx.edit({ type: "set_element_values", elementIds: ids, values: { [MATERIAL_ID_KEY]: materialId } });
  },
  /** Pin / lock elements (building, structure, parts, or MEP runs) so edits leave them alone. */
  lock(ctx: ScriptContext, elementIds: string | readonly string[], reason = "Pinned by script"): void {
    const ids = typeof elementIds === "string" ? [elementIds] : [...elementIds];
    const coreIds = ids.filter((id) => isCoreElement(ctx.model.find(id)));
    const otherIds = ids.filter((id) => !isCoreElement(ctx.model.find(id)));
    if (coreIds.length > 0) ctx.edit({ type: "lock_elements", elementIds: coreIds, state: "existing", reason });
    if (otherIds.length > 0) ctx.edit({ type: "set_element_locks", ids: otherIds, locked: true });
  },
  /** Unpin / unlock previously locked elements (building, structure, parts, or MEP runs). */
  unlock(ctx: ScriptContext, elementIds: string | readonly string[]): void {
    const ids = typeof elementIds === "string" ? [elementIds] : [...elementIds];
    const coreIds = ids.filter((id) => isCoreElement(ctx.model.find(id)));
    const otherIds = ids.filter((id) => !isCoreElement(ctx.model.find(id)));
    if (coreIds.length > 0) ctx.edit({ type: "unlock_elements", elementIds: coreIds });
    if (otherIds.length > 0) ctx.edit({ type: "set_element_locks", ids: otherIds, locked: false });
  },
  /** Lock or unlock an entire view category across the model (e.g. "lighting_fixtures", "equipment"). */
  lockCategory(ctx: ScriptContext, category: string, locked = true): void {
    ctx.edit({ type: "lock_category", category, locked });
  },
  /** Any kind the registry draws on a line (a beam, a grid line, a pack's own kind), by its id. */
  elements(ctx: ScriptContext, kind: string, spec: ChainSpec): ChainHandle {
    return chain(ctx, kind, spec);
  },
  /** A door in a wall with full operation, swing direction, hinge side, handing, and fire rating support; returns its id. */
  door(ctx: ScriptContext, spec: DoorSpec): string {
    const { values, side } = resolveDoorSpecValues(spec);
    return opening(ctx, "door", spec, values, side);
  },
  /** Flip an existing door's hinge/hand (`"hinge"`), swing face (`"swing"`), or both (`"both"`). */
  flipDoor(ctx: ScriptContext, doorId: string, which: "hinge" | "swing" | "both" = "swing"): void {
    const el = ctx.model.get(doorId);
    if (el.kind !== "opening" || el.openingType !== "door") throw new Error(`${doorId} is not a door.`);
    const vals = el.values ?? {};
    const patch: Record<string, string | number | boolean | null> = {};
    if (which === "swing" || which === "both") {
      const curSide =
        vals["host.side"] === -1
          ? -1
          : vals["host.side"] === 1
            ? 1
            : String(vals["architecture.door_swing"] ?? "").toUpperCase() === "OUTWARD"
              ? -1
              : String(vals["architecture.door_handing"] ?? "").toUpperCase().endsWith("R")
                ? -1
                : 1;
      const nextSide: 1 | -1 = curSide === 1 ? -1 : 1;
      patch["host.side"] = nextSide;
      if (typeof vals["architecture.door_swing"] === "string") patch["architecture.door_swing"] = nextSide === -1 ? "OUTWARD" : "INWARD";
      if (typeof vals["architecture.door_handing"] === "string") {
        const h = vals["architecture.door_handing"].toUpperCase();
        const flipSwing: Readonly<Record<string, string>> = { LH: "LHR", LHR: "LH", RH: "RHR", RHR: "RH" };
        if (flipSwing[h]) patch["architecture.door_handing"] = flipSwing[h]!;
      }
    }
    if (which === "hinge" || which === "both") {
      const curOp = typeof vals["architecture.door_operation"] === "string" ? vals["architecture.door_operation"].toUpperCase() : "SINGLE_SWING_LEFT";
      const nextOp = HANDED_DOOR_FLIP[curOp];
      if (!nextOp) throw new Error(`Door ${doorId} (${curOp}) is symmetric and has no hinge side to flip.`);
      patch["architecture.door_operation"] = nextOp;
      const curH = typeof patch["architecture.door_handing"] === "string" ? patch["architecture.door_handing"] : typeof vals["architecture.door_handing"] === "string" ? vals["architecture.door_handing"].toUpperCase() : undefined;
      if (curH) {
        const flipHinge: Readonly<Record<string, string>> = { LH: "RH", RH: "LH", LHR: "RHR", RHR: "LHR" };
        if (flipHinge[curH]) patch["architecture.door_handing"] = flipHinge[curH]!;
      }
    }
    ctx.edit({ type: "set_element_values", elementIds: [doorId], values: patch });
  },
  /** A window in a wall with optional sill height, partitioning, frame depth, and external flag; returns its id. */
  window(ctx: ScriptContext, spec: WindowSpec): string {
    const extra: Record<string, string | number | boolean> = {};
    if (spec.partitioning) extra["architecture.window_partitioning"] = normalizeWindowPartitioning(spec.partitioning);
    return opening(ctx, "window", spec, extra);
  },
  /** A space (room) on a level, with its number and name; returns its id. */
  space(ctx: ScriptContext, spec: SpaceSpec): string {
    const spaceId = spec.id ?? ctx.id("space");
    const space: CreateSpace["spaces"][number] = {
      spaceId,
      number: spec.number,
      name: spec.name,
      levelId: levelOf(ctx, spec.level),
      ...(spec.outline ? { outline: spec.outline.map((p, i) => planMm(p, `Outline point ${i + 1}`)) } : {}),
      ...(spec.ceilingHeight ? { ceilingHeightMm: mm(spec.ceilingHeight, "Ceiling height") } : {}),
      ...(spec.occupants !== undefined ? { occupants: spec.occupants } : {}),
    };
    ctx.edit({ type: "create_space", spaces: [space] });
    return spaceId;
  },
  /** A ceiling at a height above its level, flat or sloped; returns its id. Pass `grid` for a real-scale configurable ACT tile grid (`2x4`, `2x2`, or custom pitch/origin/rotation). */
  ceiling(ctx: ScriptContext, spec: CeilingSpec): string {
    const ceilingId = spec.id ?? ctx.id("ceiling");
    const ceiling: CreateCeiling["ceilings"][number] = {
      ceilingId,
      levelId: levelOf(ctx, spec.level),
      outline: spec.outline.map((p, i) => planMm(p, `Ceiling corner ${i + 1}`)),
      heightMm: mm(spec.height, "Ceiling height"),
      ...(spec.space ? { spaceId: spec.space } : {}),
      ...(spec.form ? { form: spec.form } : {}),
      ...(spec.holes ? { holes: spec.holes.map((h, i) => h.map((p, j) => planMm(p, `Hole ${i + 1} corner ${j + 1}`))) } : {}),
      ...(spec.slope ? { slope: spec.slope } : {}),
      ...(spec.reference ? { reference: planMm(spec.reference, "Height reference") } : {}),
      ...(spec.grid ? { grid: ceilingGridMm(spec.grid) } : {}),
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
    };
    ctx.edit({ type: "create_ceiling", ceilings: [ceiling] });
    if (spec.material) {
      ctx.edit({ type: "set_element_values", elementIds: [ceilingId], values: { [MATERIAL_ID_KEY]: spec.material } });
    }
    return ceilingId;
  },
  /**
   * Snaps a plan point `near` to the exact center of the nearest real-scale ACT ceiling tile cell
   * so 2'×4' LED troffers (full cell) and 2'×2' HVAC diffusers/grilles (pass `{ deviceWidth: units.in(24), deviceDepth: units.in(24) }`)
   * seat cleanly inside T-bar grid tiles. Pass either a ceiling element id (already created or read) or a `CeilingGridSpec`.
   */
  ceilingTileCenter(
    ctx: ScriptContext,
    ceilingOrGrid: string | CeilingGridSpec,
    near: PlanPoint,
    opts?: { readonly deviceWidth?: Measure; readonly deviceDepth?: Measure },
  ): PlanPoint {
    let grid: CeilingGrid | null;
    if (typeof ceilingOrGrid === "string") {
      grid = onWorking(ctx, "building.ceilingTileCenter", (model) => {
        const el = model.elements[ceilingOrGrid];
        if (!el || el.kind !== "ceiling") throw new ScriptRunError(`No ceiling "${ceilingOrGrid}" in this run or what the script reads.`);
        return ceilingGrid(el as Ceiling);
      });
      if (!grid) throw new ScriptRunError(`Ceiling "${ceilingOrGrid}" has no explicit tile grid; pass grid: { preset: "2x4" } on building.ceiling or pass a CeilingGridSpec.`);
    } else {
      grid = ceilingGridMm(ceilingOrGrid);
    }
    const p = ceilingGridCellCenter(grid, planMm(near, "Ceiling tile target"), {
      ...(opts?.deviceWidth ? { deviceWidthMm: mm(opts.deviceWidth, "Device width") } : {}),
      ...(opts?.deviceDepth ? { deviceDepthMm: mm(opts.deviceDepth, "Device depth") } : {}),
    });
    return { x: measure("length", p.x, "mm"), y: measure("length", p.y, "mm") };
  },
};

/** A placed part: its id, and a route end at one of its connectors (for `routes.along({ from })`). */
export interface PlacedPart {
  readonly id: string;
  connector(connectorId: string): { readonly kind: "part"; readonly partId: string; readonly connectorId: string };
  readonly command: PlacePart;
}

/**
 * Mounts a part flush onto a wall's interior or exterior finish face (`wall_face` host).
 * Local `+Y` faces out of the wall into the room so wall-anchored symbols (receptacles,
 * switches, panels) touch the wall line cleanly without cutting into the wall thickness,
 * and follow automatically whenever the wall moves, stretches, or changes thickness.
 */
export interface WallMountSpec {
  /** Wall element id to mount on. */
  readonly wall: string;
  /** Distance along the wall from its start point toward its end. Omit when `at` or `toward` projects onto the wall. */
  readonly along?: Measure;
  /** Which finish face: `1` (left of wall start→end) or `-1` (right). Omit when `toward` or `at` chooses the room side. */
  readonly side?: 1 | -1;
  /** Any point inside the room the device should face (picks `side` automatically, and `along` if omitted and `at` is absent). */
  readonly toward?: PlanPoint;
  /** Extra standoff past the finish face into the room (default 0: flush on the finish face). */
  readonly offset?: Measure;
}

export interface PlaceSpec {
  readonly level: string;
  /**
   * The part type to place: one the model has, one this run saved, a
   * built-in library type (`builtin:water-closet-floor@1`, the kernel's and
   * the model's add-ons' part types), or one the host's library supplied for
   * the run (name it in `reads.partTypes`); the kit sends a library type's
   * definition with it.
   */
  readonly type: string;
  /** Plan position. Required unless `onWall` names a wall with `along` or `toward`. */
  readonly at?: PlanPoint;
  /** Height of its base above the level (a unit on a roof curb, a heater on a stand, a receptacle at 18" AFF). */
  readonly height?: Measure;
  readonly rotationDeg?: number;
  readonly mark?: string;
  readonly values?: NonNullable<PlacePart["values"]>;
  /** Stands on a slab or roof (its id): the part's base follows the slab's top. */
  readonly onSlab?: string;
  /**
   * Mounts flush on a wall finish face (`{ wall, along?, side?, toward?, offset? }`
   * or `"nearest"` to snap `at` to the closest wall on this level). Computes the exact
   * finish-face position and rotation and keeps the part following wall edits.
   */
  readonly onWall?: WallMountSpec | "nearest";
  readonly zone?: string;
  readonly id?: string;
}

function resolveWallMount(
  ctx: ScriptContext,
  levelId: string,
  onWall: WallMountSpec | "nearest",
  fallbackAt?: { x: number; y: number },
  maxDistanceMm = 1500,
): { readonly host: Extract<PartHost, { kind: "wall_face" }>; readonly position: { x: number; y: number }; readonly rotationDeg: number } {
  return onWorking(ctx, "equipment.onWall", (model) => {
    if (onWall === "nearest") {
      if (!fallbackAt) throw new ScriptRunError('onWall: "nearest" needs a position (`at`) to snap to a wall face.');
      const hit = nearestWallFace(model, levelId, fallbackAt, { maxDistanceMm });
      if (!hit) throw new ScriptRunError(`No wall found within ${Math.round(maxDistanceMm)} mm on level ${levelId} to mount on.`);
      const host: Extract<PartHost, { kind: "wall_face" }> = {
        kind: "wall_face",
        elementId: hit.wallId,
        stationMm: hit.stationMm,
        side: hit.side,
      };
      return { host, position: hit.position, rotationDeg: hit.rotationDeg };
    }
    const raw = model.elements[onWall.wall];
    if (raw?.kind !== "wall") throw new ScriptRunError(`Wall "${onWall.wall}" wasn't found in the model (add walls to \`reads.kinds\` or create the wall first).`);
    const wall: Wall = raw;
    const towardMm = onWall.toward ? planMm(onWall.toward, "Wall mount toward") : undefined;
    const stationRef = fallbackAt ?? towardMm;
    const sideRef = towardMm ?? fallbackAt;
    const stationMm =
      onWall.along !== undefined
        ? mm(onWall.along, "Distance along wall")
        : stationRef
          ? wallStationOf(wall, stationRef).stationMm
          : (() => {
              throw new ScriptRunError(`onWall for wall "${onWall.wall}" needs \`along\`, \`at\`, or \`toward\` to know where along the wall to mount.`);
            })();
    const side: 1 | -1 = onWall.side ?? (sideRef ? wallFaceSideToward(wall, sideRef) : 1);
    const faceOffsetMm = onWall.offset !== undefined ? mm(onWall.offset, "Wall face offset") : 0;
    const frame = wallFaceFrame(wall, stationMm, side, faceOffsetMm);
    const host: Extract<PartHost, { kind: "wall_face" }> = {
      kind: "wall_face",
      elementId: wall.id,
      stationMm: frame.clampedStationMm,
      side,
      ...(faceOffsetMm !== 0 ? { faceOffsetMm } : {}),
    };
    return { host, position: frame.position, rotationDeg: frame.rotationDeg };
  });
}

export const equipment = {
  /** Places one part (equipment, a fixture, a device) on a level; connect it with `routes.along({ from: placed.connector("supply") })`. */
  place(ctx: ScriptContext, spec: PlaceSpec): PlacedPart {
    const levelId = levelOf(ctx, spec.level);
    if (spec.onSlab && spec.onWall) throw new ScriptRunError("equipment.place takes either `onSlab` or `onWall`, not both.");
    const rawAt = spec.at ? planMm(spec.at, "Position") : undefined;
    const wallMount = spec.onWall ? resolveWallMount(ctx, levelId, spec.onWall, rawAt) : null;
    const position = wallMount ? wallMount.position : rawAt;
    if (!position) throw new ScriptRunError("equipment.place needs `at` unless `onWall` specifies a wall and station.");
    // The working model when the script has one (it sees types outside the script's reads), else the slice.
    const known = onWorkingIfAny(ctx, (model) => model.elements[spec.type] !== undefined) ?? ctx.model.find(spec.type) !== undefined;
    const libraryDefinition = known ? undefined : (builtinPartType(spec.type)?.definition ?? ctx.model.libraryPart(spec.type));
    const host: PartHost | undefined = wallMount ? wallMount.host : spec.onSlab ? { kind: "slab", elementId: spec.onSlab } : undefined;
    const rotationDeg = wallMount ? wallMount.rotationDeg : spec.rotationDeg;
    const command: PlacePart = {
      type: "place_part",
      partId: spec.id ?? ctx.id("part"),
      typeId: spec.type,
      ...(libraryDefinition ? { partType: libraryDefinition } : {}),
      levelId,
      position,
      ...(spec.height ? { offsetMm: mm(spec.height, "Height") } : {}),
      ...(rotationDeg !== undefined ? { rotationDeg } : {}),
      ...(spec.mark ? { mark: spec.mark } : {}),
      ...(spec.values ? { values: spec.values } : {}),
      ...(host ? { host } : {}),
      ...(spec.zone ? { zone: spec.zone } : {}),
    };
    ctx.edit(command);
    const partId = command.partId;
    return { id: partId, connector: (connectorId) => ({ kind: "part", partId, connectorId }), command };
  },

  /**
   * Re-hosts one or more existing placed parts flush onto a wall finish face
   * (`wall_face` host) via `set_part_host`, moving and orienting each part onto
   * the finish face so wall-anchored symbols clear the wall thickness and follow
   * future wall edits. Pass `"nearest"` to snap each part to its closest wall.
   */
  hostOnWall(
    ctx: ScriptContext,
    partIds: string | readonly string[],
    onWall: WallMountSpec | "nearest" = "nearest",
    opts: { readonly maxDistance?: Measure } = {},
  ): readonly { readonly partId: string; readonly wallId: string; readonly side: 1 | -1; readonly stationMm: number }[] {
    const ids = typeof partIds === "string" ? [partIds] : [...partIds];
    const maxDistMm = opts.maxDistance ? mm(opts.maxDistance, "Max snap distance") : 1500;
    const mounted: { readonly partId: string; readonly wallId: string; readonly side: 1 | -1; readonly stationMm: number }[] = [];
    for (const partId of ids) {
      const part = onWorking(ctx, "equipment.hostOnWall", (model) => {
        const el = model.elements[partId];
        if (el?.kind !== "part") throw new ScriptRunError(`Part "${partId}" wasn't found in the model.`);
        return el;
      });
      const resolved = resolveWallMount(ctx, part.levelId, onWall, part.position, maxDistMm);
      ctx.edit({ type: "set_part_host", ids: [partId], host: resolved.host, seat: true });
      mounted.push({ partId, wallId: resolved.host.elementId, side: resolved.host.side, stationMm: resolved.host.stationMm });
    }
    return mounted;
  },

  /**
   * Binds switching / lighting control devices (switches, 3-way/4-way pairs, 0-10V dimmers,
   * occupancy or daylight sensors) to the fixtures or controlled receptacles they govern under
   * one switch-leg designation (`"a"`, `"b"`, …) and control wiring protocol.
   */
  controlZone(
    ctx: ScriptContext,
    spec: {
      /** Switch-leg designation letter (`"a"`, `"b"`, `"c"`…). */
      readonly leg: string;
      /** One or more switches, dimmers, occupancy sensors or daylight sensors (multiple switches form 3-way/4-way travelers). */
      readonly controllers: readonly (string | PlacedPart)[];
      /** Fixtures or controlled receptacles governed by this control zone. */
      readonly loads: readonly (string | PlacedPart)[];
      /** Wiring protocol: `"line_voltage"` (default dashed switch leg), `"0-10v"` / `"dali"` / `"low_voltage"` (dash-dot control wiring), or `"wireless"`. */
      readonly protocol?: "line_voltage" | "0-10v" | "dali" | "low_voltage" | "wireless";
      /** Optional emergency lighting mode (`"none"`, `"unswitched"`, or `"switched"` for UL 924 shunt/relay) applied to loads in this zone. */
      readonly emergencyMode?: "none" | "unswitched" | "switched";
    },
  ): void {
    const leg = spec.leg.trim().toLowerCase();
    if (!leg) throw new ScriptRunError("equipment.controlZone needs a non-empty switch-leg designation (e.g. \"a\").");
    const idOf = (x: string | PlacedPart) => (typeof x === "string" ? x : x.id);
    const filterDeclared = (partId: string, candidate: Record<string, string | number | boolean>): Record<string, string | number | boolean> => {
      return (
        onWorkingIfAny(ctx, (m) => {
          const part = m.elements[partId];
          if (part?.kind !== "part") return candidate;
          const pt = m.elements[part.typeId];
          if (pt?.kind !== "part_type") return candidate;
          const allowed = new Set(pt.definition.instanceParams.map((p) => p.name));
          const out: Record<string, string | number | boolean> = {};
          for (const [k, v] of Object.entries(candidate)) if (allowed.has(k)) out[k] = v;
          return out;
        }) ?? candidate
      );
    };
    for (const c of spec.controllers) {
      const id = idOf(c);
      const values = filterDeclared(id, { switch_leg: leg, ...(spec.protocol ? { control_type: spec.protocol } : {}) });
      if (Object.keys(values).length > 0) ctx.edit({ type: "set_parameters", id, scope: "instance", values });
    }
    for (const l of spec.loads) {
      const id = idOf(l);
      const values = filterDeclared(id, {
        switch_leg: leg,
        ...(spec.protocol ? { control_type: spec.protocol } : {}),
        ...(spec.emergencyMode !== undefined ? { emergency: spec.emergencyMode !== "none", emergency_mode: spec.emergencyMode } : {}),
      });
      if (Object.keys(values).length > 0) ctx.edit({ type: "set_parameters", id, scope: "instance", values });
      if (spec.emergencyMode !== undefined) {
        const packState = onWorkingIfAny(ctx, (m) => {
          const part = m.elements[id];
          if (part?.kind !== "part") return null;
          const hasPackKeys =
            Object.prototype.hasOwnProperty.call(part.values, "electrical.emergency_mode") ||
            Object.prototype.hasOwnProperty.call(part.values, "electrical.egress_fixture");
          if (!hasPackKeys) return null;
          const pt = m.elements[part.typeId];
          const typeVals = pt?.kind === "part_type" ? pt.definition.typeValues : undefined;
          return { existing: part.values["electrical.emergency_mode"] ?? typeVals?.["electrical.emergency_mode"] };
        });
        if (packState) {
          const photMode =
            spec.emergencyMode === "none"
              ? "none"
              : packState.existing === "generator_circuit" || packState.existing === "inverter"
                ? packState.existing
                : "battery_pack";
          ctx.edit({
            type: "set_element_values",
            elementIds: [id],
            values: {
              "electrical.emergency_mode": photMode,
              "electrical.egress_fixture": spec.emergencyMode !== "none",
            },
          });
        }
      }
    }
  },
};
