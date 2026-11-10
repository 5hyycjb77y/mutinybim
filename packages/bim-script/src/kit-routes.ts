import { fittingFamilies, type Command, type FittingFamily, type PipeMaterial, type RunDomain, type RunSize } from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import { levelOf } from "./levels";
import { onWorking } from "./working";

/**
 * `routes`: the kit's route helpers. Each one builds the kernel's own
 * `route_run` command and sends it through `ctx.edit`, so the kernel routes
 * it (fittings, branches, rises and drops) and every refusal is the kernel's
 * sentence ("Step 2 (route_run) was refused: Leg 1 would be 120 mm; …").
 * Positions and sizes are measures from the shared unit library. System
 * kinds, sizes and connector ids are the script's: nothing here names a trade.
 */

type RouteRun = Extract<Command, { type: "route_run" }>;
type Endpoint = NonNullable<RouteRun["from"]>;

export interface RoutePoint {
  readonly x: Measure;
  readonly y: Measure;
  /** Change the run's centreline height here (a rise or drop), above the route's level. */
  readonly height?: Measure;
}

export interface RouteSpec {
  /** The level the route is drawn on (its id). */
  readonly level: string;
  readonly domain: RouteRun["domain"];
  readonly size: RunSize;
  /** The run's system; created with this kind and name when the model doesn't have it. */
  readonly system: RouteRun["system"];
  /** Centreline height above the level. Absent: the height of what the route starts or ends on. */
  readonly height?: Measure;
  readonly points: readonly RoutePoint[];
  readonly from?: Endpoint;
  readonly to?: Endpoint;
  readonly riseStyle?: RouteRun["riseStyle"];
  readonly capEnd?: boolean;
  readonly zone?: string;
  readonly fittings?: RouteRun["fittings"];
  /**
   * Gravity drains: the fall of level legs (`{ rise: units.in(0.25), per: units.ft(1) }` is 1/4 in per foot).
   * Absent: the system's minimum for the size (the kernel's slope rule).
   */
  readonly slope?: Slope;
  /** Gravity drains: which way the water runs. Absent: into the trunk for a branch, else from the first point to the last. */
  readonly flow?: RouteRun["flow"];
  /** New element ids start with this; absent: a fresh id from the run's seed (`ctx.id("run")`). */
  readonly id?: string;
}

/** A fall as a rise over a run, both lengths. */
export interface Slope {
  readonly rise: Measure;
  readonly per: Measure;
}

/** A slope in inches per foot, the kernel's stored form. */
export function slopeInPerFt(slope: Slope): number {
  const per = mm(slope.per, "Slope run");
  if (per <= 0) throw new Error("A slope's run (per) must be longer than zero.");
  return Math.round((mm(slope.rise, "Slope rise") / 25.4 / (per / 304.8)) * 1e6) / 1e6;
}

/** What a helper routed: its id prefix and the kernel's ids for its pieces. */
export interface RouteHandle {
  readonly prefix: string;
  /** The kernel names segments `<prefix>-s1`, `-s2`, …: the first one is the start of the run. */
  segment(n: number): string;
  /** The command as sent. */
  readonly command: RouteRun;
}

function mm(m: Measure, what: string): number {
  if (m.kind !== "length") throw new Error(`${what} is a length; the value given is a ${m.kind}.`);
  return Math.round(measureIn(m, "mm") * 1000) / 1000;
}

function command(ctx: ScriptContext, spec: RouteSpec, overrides: Partial<RouteRun> = {}): RouteRun {
  return {
    type: "route_run",
    idPrefix: spec.id ?? ctx.id("run"),
    levelId: levelOf(ctx, spec.level),
    domain: spec.domain,
    size: spec.size,
    system: spec.system,
    points: spec.points.map((p, i) => ({ x: mm(p.x, `Point ${i + 1} x`), y: mm(p.y, `Point ${i + 1} y`), ...(p.height ? { elevationMm: mm(p.height, `Point ${i + 1} height`) } : {}) })),
    ...(spec.height ? { elevationMm: mm(spec.height, "Height") } : {}),
    ...(spec.from ? { from: spec.from } : {}),
    ...(spec.to ? { to: spec.to } : {}),
    ...(spec.riseStyle ? { riseStyle: spec.riseStyle } : {}),
    ...(spec.capEnd ? { capEnd: true } : {}),
    ...(spec.zone ? { zone: spec.zone } : {}),
    ...(spec.fittings ? { fittings: spec.fittings } : {}),
    ...(spec.slope ? { slopeInPerFt: slopeInPerFt(spec.slope) } : {}),
    ...(spec.flow ? { flow: spec.flow } : {}),
    ...overrides,
  };
}

function handle(cmd: RouteRun): RouteHandle {
  return { prefix: cmd.idPrefix, segment: (n) => `${cmd.idPrefix}-s${n}`, command: cmd };
}

function send(ctx: ScriptContext, cmd: RouteRun): RouteHandle {
  ctx.edit(cmd);
  return handle(cmd);
}

function levelHeightMm(ctx: ScriptContext, levelId: string): number {
  const level = ctx.model.get(levelOf(ctx, levelId));
  const h = level.kind === "level" ? Reflect.get(level, "elevationMm") : undefined;
  if (typeof h !== "number") throw new Error(`${levelId} isn't a level, so a route can't drop to it.`);
  return h;
}

export const routes = {
  /**
   * The fitting library routing places (the model's add-ons' families
   * included): each family's id, what it fits, its shapes and parameters, and
   * for pipe its services, joints and take-out. Use the id in `swap_fitting`
   * or a system's design.
   */
  fittingTypes(ctx: ScriptContext, filter: { readonly domain?: RunDomain; readonly service?: "water" | "drainage" | "vent" | "gas" } = {}): readonly FittingFamily[] {
    return onWorking(ctx, "routes.fittingTypes", () => fittingFamilies().filter((f) => (!filter.domain || f.domain === filter.domain) && (!filter.service || (f.pipe?.services ?? []).includes(filter.service))));
  },
  /** Sizes as the kernel stores them. */
  rect: (width: Measure, height: Measure): RunSize => ({ shape: "rect", width: mm(width, "Width"), height: mm(height, "Height") }),
  round: (diameter: Measure): RunSize => ({ shape: "round", diameter: mm(diameter, "Diameter") }),
  oval: (width: Measure, height: Measure): RunSize => ({ shape: "oval", width: mm(width, "Width"), height: mm(height, "Height") }),
  pipe: (nominal: Measure, material: PipeMaterial): RunSize => ({ shape: "pipe", nominalMm: mm(nominal, "Nominal size"), material }),

  /** Route ends. */
  atConnector: (partId: string, connectorId: string): Endpoint => ({ kind: "part", partId, connectorId }),
  atRunEnd: (elementId: string, port: "start" | "end" | string): Endpoint => ({ kind: "run_end", elementId, port }),

  /** A run through the points in order (the kernel puts elbows at the turns); `slope` makes a drain fall along it. */
  along(ctx: ScriptContext, spec: RouteSpec): RouteHandle {
    return send(ctx, command(ctx, spec));
  },

  /**
   * A branch off a trunk: its first point is on the trunk's centreline, and
   * the kernel places the tap, tee or wye there. `face` top or bottom leaves
   * a level trunk straight up or down; absent, it leaves from the side the
   * next point is on.
   */
  branch(ctx: ScriptContext, spec: RouteSpec & { readonly trunk: string; readonly face?: "top" | "bottom" }): RouteHandle {
    return send(ctx, command(ctx, spec, { from: { kind: "run_branch", segmentId: spec.trunk, ...(spec.face ? { face: spec.face } : {}) } }));
  },

  /**
   * Connects open ends (fixture connectors, run ends) into a run: `into` a
   * segment's id, or "nearest". The kernel picks the fittings from the
   * system's preferences and slopes drains by its rule.
   */
  connectInto(ctx: ScriptContext, spec: { readonly from: readonly { readonly elementId: string; readonly port: string }[]; readonly into: string; readonly id?: string }): string {
    const idPrefix = spec.id ?? ctx.id("into");
    ctx.edit({ type: "connect_into", from: spec.from.map((f) => ({ elementId: f.elementId, port: f.port })), into: spec.into, idPrefix });
    return idPrefix;
  },

  /**
   * The route, then straight down (or up) at its last point to `heightAbove`
   * the other level: the kernel cuts the riser where it passes each floor.
   * Needs the levels in the script's reads.
   */
  drop(ctx: ScriptContext, spec: RouteSpec & { readonly toLevel: string; readonly heightAbove: Measure }): RouteHandle {
    const last = spec.points[spec.points.length - 1];
    if (!last) throw new Error("A drop needs at least one point to drop from.");
    const shift = levelHeightMm(ctx, spec.toLevel) - levelHeightMm(ctx, spec.level);
    const bottom: Measure = { kind: "length", value: (shift + mm(spec.heightAbove, "Height above the level")) / 1000 };
    return send(ctx, command(ctx, { ...spec, points: [...spec.points.slice(0, -1), { ...last, height: bottom }] }));
  },
};
