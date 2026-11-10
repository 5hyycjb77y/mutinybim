import { BOUNDING_ELEMENT_POINT, OPENING_SILL_KEY, asElementId, builtinPartType, planLevelSync, surfacesAt, type Command, type LevelSyncPlan, type SurfacesAtResult, type SyncStorey } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { measureIn, type Measure } from "@permitzip/bim-units";
import { ScriptRunError, type ScriptContext } from "./context";
import { levelOf } from "./levels";
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
export type WallTop = { readonly level: string; readonly offset?: Measure } | TopSurface | { readonly to: TopSurface; readonly offset?: Measure };

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
  } else if (top) out.topSurface = { to: SURFACE_TO[top.to], ...(top.offset ? { offsetMm: mm(top.offset, "Top offset") } : {}) };
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
    ...(spec.values ? { values: spec.values } : {}),
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

export interface OpeningSpec {
  /** The wall it sits in (its id). */
  readonly wall: string;
  /** Distance along the wall from its start to the opening's centre. */
  readonly along: Measure;
  readonly width?: Measure;
  readonly height?: Measure;
  /** How high its bottom sits above the floor of its wall (a window's sill); the kernel refuses one that puts its head above the wall. */
  readonly sill?: Measure;
  /** Which face it opens to: 1 or -1 (the wall's left or right, looking from its start). */
  readonly side?: 1 | -1;
  readonly typeId?: string;
  readonly mark?: string;
  readonly values?: Values;
  readonly id?: string;
}

function opening(ctx: ScriptContext, openingType: string, spec: OpeningSpec): string {
  const size = sizeMm({ width: spec.width, height: spec.height });
  const command: CreateHosted = {
    type: "create_hosted",
    elementId: spec.id ?? ctx.id(openingType),
    kind: "opening",
    openingType,
    hostId: spec.wall,
    s: mm(spec.along, "Distance along the wall"),
    side: spec.side ?? 1,
    ...(spec.typeId ? { typeId: spec.typeId } : {}),
    ...(spec.mark ? { mark: spec.mark } : {}),
    ...(spec.values || spec.sill ? { values: { ...(spec.values ?? {}), ...(spec.sill ? { [OPENING_SILL_KEY]: mm(spec.sill, "Sill height") } : {}) } } : {}),
    ...(size ? { size } : {}),
  };
  ctx.edit(command);
  return command.elementId;
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
  /** A ceiling type the model has (what it is made of: an acoustic tile, gypsum board). */
  readonly typeId?: string;
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

  /** A level at an elevation; returns its id. */
  level(ctx: ScriptContext, spec: LevelSpec): string {
    const command: CreateLevel = { type: "create_level", levelId: spec.id ?? ctx.id("level"), name: spec.name, elevationMm: mm(spec.elevation, "Elevation") };
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
  /** A floor slab with this outline; returns its id. */
  floor(ctx: ScriptContext, spec: Omit<ChainSpec, "closed" | "topLevel" | "topOffset" | "top" | "base">): string {
    const size = sizeMm({ thickness: spec.thickness });
    const command: CreateElement = {
      type: "create_element",
      elementId: spec.id ?? ctx.id("slab"),
      levelId: levelOf(ctx, spec.level),
      kind: "slab",
      placement: { kind: "area", outline: spec.points.map((p, i) => planMm(p, `Outline point ${i + 1}`)) },
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
      ...(size ? { size } : {}),
      ...(spec.values ? { values: spec.values } : {}),
      ...(spec.label ? { label: spec.label } : {}),
    };
    ctx.edit(command);
    return command.elementId;
  },
  /** Any kind the registry draws on a line (a beam, a grid line, a pack's own kind), by its id. */
  elements(ctx: ScriptContext, kind: string, spec: ChainSpec): ChainHandle {
    return chain(ctx, kind, spec);
  },
  /** A door in a wall; returns its id. */
  door(ctx: ScriptContext, spec: OpeningSpec): string {
    return opening(ctx, "door", spec);
  },
  /** A window in a wall; returns its id. */
  window(ctx: ScriptContext, spec: OpeningSpec): string {
    return opening(ctx, "window", spec);
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
  /** A ceiling at a height above its level, flat or sloped; returns its id. Its type (what it is made of) is a ceiling type the model has. */
  ceiling(ctx: ScriptContext, spec: CeilingSpec): string {
    const ceilingId = spec.id ?? ctx.id("ceiling");
    const ceiling: CreateCeiling["ceilings"][number] = {
      ceilingId,
      levelId: levelOf(ctx, spec.level),
      outline: spec.outline.map((p, i) => planMm(p, `Ceiling corner ${i + 1}`)),
      heightMm: mm(spec.height, "Ceiling height"),
      ...(spec.space ? { spaceId: spec.space } : {}),
      ...(spec.holes ? { holes: spec.holes.map((h, i) => h.map((p, j) => planMm(p, `Hole ${i + 1} corner ${j + 1}`))) } : {}),
      ...(spec.slope ? { slope: spec.slope } : {}),
      ...(spec.reference ? { reference: planMm(spec.reference, "Height reference") } : {}),
      ...(spec.typeId ? { typeId: spec.typeId } : {}),
    };
    ctx.edit({ type: "create_ceiling", ceilings: [ceiling] });
    return ceilingId;
  },
};

/** A placed part: its id, and a route end at one of its connectors (for `routes.along({ from })`). */
export interface PlacedPart {
  readonly id: string;
  connector(connectorId: string): { readonly kind: "part"; readonly partId: string; readonly connectorId: string };
  readonly command: PlacePart;
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
  readonly at: PlanPoint;
  /** Height of its base above the level (a unit on a roof curb, a heater on a stand). */
  readonly height?: Measure;
  readonly rotationDeg?: number;
  readonly mark?: string;
  readonly values?: NonNullable<PlacePart["values"]>;
  /** Stands on a slab or roof (its id): the part's base follows the slab's top. */
  readonly onSlab?: string;
  readonly zone?: string;
  readonly id?: string;
}

export const equipment = {
  /** Places one part (equipment, a fixture, a device) on a level; connect it with `routes.along({ from: placed.connector("supply") })`. */
  place(ctx: ScriptContext, spec: PlaceSpec): PlacedPart {
    // The working model when the script has one (it sees types outside the script's reads), else the slice.
    const known = onWorkingIfAny(ctx, (model) => model.elements[spec.type] !== undefined) ?? ctx.model.find(spec.type) !== undefined;
    const libraryDefinition = known ? undefined : (builtinPartType(spec.type)?.definition ?? ctx.model.libraryPart(spec.type));
    const command: PlacePart = {
      type: "place_part",
      partId: spec.id ?? ctx.id("part"),
      typeId: spec.type,
      ...(libraryDefinition ? { partType: libraryDefinition } : {}),
      levelId: levelOf(ctx, spec.level),
      position: planMm(spec.at, "Position"),
      ...(spec.height ? { offsetMm: mm(spec.height, "Height") } : {}),
      ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
      ...(spec.mark ? { mark: spec.mark } : {}),
      ...(spec.values ? { values: spec.values } : {}),
      ...(spec.onSlab ? { host: { kind: "slab", elementId: spec.onSlab } } : {}),
      ...(spec.zone ? { zone: spec.zone } : {}),
    };
    ctx.edit(command);
    const partId = command.partId;
    return { id: partId, connector: (connectorId) => ({ kind: "part", partId, connectorId }), command };
  },
};
