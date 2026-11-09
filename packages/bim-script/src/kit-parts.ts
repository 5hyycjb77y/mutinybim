import {
  CLEARANCE_FACES,
  FormulaError,
  builtinPartTypes,
  PART_CATEGORIES,
  evaluateFormula,
  parseFormula,
  partConnectorWarnings,
  partDefinition,
  partTypeDefinitionSchema,
  partTypeIssues,
  planeFrame,
  resolveGeometry,
  localBounds,
  type ImportedBodyRef,
  type LibraryEntry,
  type PartConnector,
  type PartFeature2,
  type PartModel2,
  type PartProfile,
  type PartSymbol,
  type PartTypeDefinition,
  type PlaneAxis,
  type ReferencePlane,
  type Sketch,
} from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import type { ScriptContext } from "./context";
import { onWorking } from "./working";

/**
 * `parts`: the kit's part helpers. A script builds one size of a part and
 * gets the kernel's own part-type definition back, checked with the kernel's
 * own rules, so a refusal is in the kernel's words.
 *
 * Every body is a feature of the part's solid program (part model schema 2):
 * profiles (rectangles with filleted or chamfered corners, circles, any
 * polygon, with holes) extruded, revolved, swept along straights and bends,
 * lofted between sections, cut, patterned and mirrored, plus imported vendor
 * bodies. The same solid is what the 3D view, the sheets, clash and IFC
 * export read, and what the part's pictures are drawn from. `box`,
 * `cylinder` and `transition` are short forms of those operations.
 *
 * Lengths are measures from the shared unit library (`units.in(24)`) or a
 * parameter's dimension (`p.param(...)`); the kit stores millimetres, as the
 * kernel does. Nothing here names a trade or a vendor.
 */

type Dim = ReferencePlane["offset"];
type ParamDef = PartTypeDefinition["typeParams"][number];
type ParamValue = PartTypeDefinition["typeValues"][string];
type DetailLevel = "coarse" | "medium" | "fine";
type Point = Sketch["points"][number];
type Entity = Sketch["entities"][number];
type Constraint = Sketch["constraints"][number];

/** A length: a measure (fixed) or a parameter's dimension (`p.param(...)`), which follows the parameter per size. */
export type Length = Measure | Dim;

export const FACES = ["top", "bottom", "front", "back", "left", "right"] as const;
export type Face = (typeof FACES)[number];

/** The drawing planes a profile is drawn on: plan (x right, y up, pushed up z), front (y right, z up, pushed along x toward the front), side (x right, z up, pushed along y to the left). */
export const VIEWS = ["plan", "front", "side"] as const;
export type View = (typeof VIEWS)[number];

const VIEW_AXIS: Readonly<Record<View, PlaneAxis>> = { plan: "z", front: "x", side: "y" };
const BUILTIN_PLANE: Readonly<Record<PlaneAxis, string>> = { x: "center_lr", y: "center_fb", z: "base" };

export class PartBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartBuildError";
  }
}

function isMeasure(v: Length): v is Measure {
  return typeof v === "object" && "kind" in v && "value" in v;
}

function mm(v: Length, what: string): Dim {
  if (!isMeasure(v)) return v;
  if (v.kind !== "length") throw new PartBuildError(`${what} is a length; the value given is a ${v.kind}.`);
  return Math.round(measureIn(v, "mm") * 1000) / 1000;
}

/** A fixed length in millimetres; a parameter's dimension is refused in words (paths and polygon corners are fixed per size). */
function fixed(v: Length, what: string): number {
  const d = mm(v, what);
  if (typeof d !== "number") throw new PartBuildError(`${what} must be a fixed length (units.in(…)), not a parameter: it is worked out once per size.`);
  return d;
}

function scaled(d: Dim, by: number): Dim {
  if (typeof d === "number") return Math.round(d * by * 1000) / 1000;
  if ("param" in d) return { param: d.param, scale: (d.scale ?? 1) * by, ...(d.add !== undefined ? { add: d.add * by } : {}) };
  return { formula: `(${d.formula}) * ${by}` };
}

function term(d: Dim): string {
  if (typeof d === "number") return String(d);
  if ("param" in d) return `(${d.param} * ${d.scale ?? 1} + ${d.add ?? 0})`;
  return `(${d.formula})`;
}

function sum(a: Dim, b: Dim): Dim {
  if (typeof a === "number" && typeof b === "number") return Math.round((a + b) * 1000) / 1000;
  if (typeof b === "number" && typeof a === "object" && "param" in a) return { ...a, add: (a.add ?? 0) + b };
  if (typeof a === "number" && typeof b === "object" && "param" in b) return { ...b, add: (b.add ?? 0) + a };
  return { formula: `${term(a)} + ${term(b)}` };
}

const neg = (d: Dim): Dim => scaled(d, -1);
const isZero = (d: Dim): boolean => typeof d === "number" && Math.abs(d) < 1e-9;

// ------------------------------------------------------------------ profiles

type Corner = { readonly kind: "fillet" | "chamfer"; readonly size: Dim };
type Shape =
  | { readonly kind: "rect"; readonly w: Dim; readonly h: Dim; readonly cx: Dim; readonly cy: Dim; readonly corner?: Corner }
  | { readonly kind: "circle"; readonly r: Dim; readonly cx: Dim; readonly cy: Dim }
  | { readonly kind: "polygon"; readonly pts: readonly (readonly [number, number])[]; readonly corner?: { readonly kind: "fillet" | "chamfer"; readonly size: number } };

/**
 * A closed 2D outline with any holes, drawn in a view's own coordinates and
 * used by any body operation. Build one with `parts.rect`, `parts.circle` or
 * `parts.polygon`; `hole` cuts another outline through it; `at` moves it.
 */
export class Profile {
  constructor(
    readonly outline: Shape,
    readonly holes: readonly Shape[] = [],
  ) {}

  /** This profile with `inner`'s outline cut through it. */
  hole(inner: Profile): Profile {
    if (inner.holes.length > 0) throw new PartBuildError("A hole can't have holes of its own; cut them as separate holes.");
    return new Profile(this.outline, [...this.holes, inner.outline]);
  }

  /** The same profile moved by (du, dv) in its view's coordinates. */
  at(du: Length, dv: Length): Profile {
    const u = mm(du, "Move");
    const v = mm(dv, "Move");
    const move = (s: Shape): Shape => {
      if (s.kind === "polygon") {
        const fu = fixed(du, "Moving a polygon");
        const fv = fixed(dv, "Moving a polygon");
        return { ...s, pts: s.pts.map(([a, b]) => [a + fu, b + fv] as const) };
      }
      return { ...s, cx: sum(s.cx, u), cy: sum(s.cy, v) };
    };
    return new Profile(move(this.outline), this.holes.map(move));
  }
}

/** Only the body options of a wider spec (a box's `at` also carries its position). */
function bodyOpts(o: BodyOptions | undefined): BodyOptions {
  return { ...(o?.cut ? { cut: true } : {}), ...(o?.show ? { show: o.show } : {}), ...(o?.material ? { material: o.material } : {}), ...(o?.id ? { id: o.id } : {}) };
}

function centerOf(c: readonly [Length, Length] | undefined): [Dim, Dim] {
  return c ? [mm(c[0], "Centre"), mm(c[1], "Centre")] : [0, 0];
}

function rectProfile(width: Length, height: Length, opts: { readonly center?: readonly [Length, Length]; readonly fillet?: Length; readonly chamfer?: Length } = {}): Profile {
  if (opts.fillet !== undefined && opts.chamfer !== undefined) throw new PartBuildError("A rectangle's corners are filleted or chamfered, not both.");
  const [cx, cy] = centerOf(opts.center);
  const corner: Corner | undefined = opts.fillet !== undefined ? { kind: "fillet", size: mm(opts.fillet, "Fillet") } : opts.chamfer !== undefined ? { kind: "chamfer", size: mm(opts.chamfer, "Chamfer") } : undefined;
  return new Profile({ kind: "rect", w: mm(width, "Width"), h: mm(height, "Height"), cx, cy, ...(corner && !isZero(corner.size) ? { corner } : {}) });
}

function circleProfile(diameter: Length, opts: { readonly center?: readonly [Length, Length] } = {}): Profile {
  const [cx, cy] = centerOf(opts.center);
  return new Profile({ kind: "circle", r: scaled(mm(diameter, "Diameter"), 0.5), cx, cy });
}

function polygonProfile(points: readonly (readonly [Length, Length])[], opts: { readonly fillet?: Length; readonly chamfer?: Length } = {}): Profile {
  if (points.length < 3) throw new PartBuildError("A polygon needs three or more corners.");
  if (points.length > 120) throw new PartBuildError("A polygon has at most 120 corners.");
  if (opts.fillet !== undefined && opts.chamfer !== undefined) throw new PartBuildError("A polygon's corners are filleted or chamfered, not both.");
  let pts = points.map(([u, v], i) => [fixed(u, `Corner ${i + 1}`), fixed(v, `Corner ${i + 1}`)] as const);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as readonly [number, number];
    const b = pts[(i + 1) % pts.length] as readonly [number, number];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1e-6) throw new PartBuildError("The polygon encloses no area.");
  if (area < 0) pts = [...pts].reverse();
  const corner = opts.fillet !== undefined ? { kind: "fillet" as const, size: fixed(opts.fillet, "Fillet") } : opts.chamfer !== undefined ? { kind: "chamfer" as const, size: fixed(opts.chamfer, "Chamfer") } : undefined;
  return new Profile({ kind: "polygon", pts, ...(corner && corner.size > 0 ? { corner } : {}) });
}

// ------------------------------------------------------------------ the builder

export interface PartStart {
  /** The size's name (the type name people see: "24x12"). */
  readonly type: string;
  /** One of the kernel's part categories. */
  readonly category: (typeof PART_CATEGORIES)[number];
  readonly description?: string;
  /** What a tag shows, in order: parameter names, or "mark" / "type_name". */
  readonly tagFields?: readonly string[];
}

export interface ConnectorOnFace {
  readonly id: string;
  readonly label: string;
  /** A connector domain the registry knows (duct, pipe, electrical, …). */
  readonly domain: PartConnector["domain"];
  /** A system kind the registry knows. */
  readonly systemKind: PartConnector["systemKind"];
  /** `rect` takes width and height, `round` a diameter, `none` neither (a power point). */
  readonly shape: "rect" | "round" | "none";
  readonly width?: Length;
  readonly height?: Length;
  readonly diameter?: Length;
  /** Offset on the face from its centre: along the face's first and second axes (top/bottom: x, y; front/back: y, z from mid-height; left/right: x, z from mid-height). */
  readonly offset?: readonly [Length, Length];
  readonly flow?: number | Dim;
  readonly flowDirection?: "in" | "out" | "bidirectional";
  /** How the opening joins the next piece: an end type an add-on declares (`<pack>.<name>`). */
  readonly endType?: string;
  /** Electrical: voltage and poles of the supply or circuit. */
  readonly voltage?: number;
  readonly poles?: 1 | 2 | 3;
}

/** Common options of every body operation. */
export interface BodyOptions {
  /** Removes material instead of adding it. */
  readonly cut?: boolean;
  /** Detail levels it shows at (absent: all). */
  readonly show?: readonly DetailLevel[];
  readonly material?: string;
  /** Its id, to pattern or mirror it later (absent: f1, f2, …). */
  readonly id?: string;
}

export type PathSegment = { readonly straight: Length } | { readonly bend: { readonly radius: Length; readonly angle: number; readonly turn: "left" | "right" } };

export interface SweepPath {
  /** The view the path is drawn in, and how far along its axis (plan: height; front: x; side: y). */
  readonly on: View;
  readonly at?: Length;
  /** Where it starts, in the view's coordinates. */
  readonly start: readonly [Length, Length];
  /** Which way it starts, as drawn in the view. */
  readonly heading: "right" | "left" | "up" | "down";
  readonly segments: readonly PathSegment[];
}

const NORMALS: Readonly<Record<Face, readonly [number, number, number]>> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [1, 0, 0],
  back: [-1, 0, 0],
  left: [0, 1, 0],
  right: [0, -1, 0],
};

/** The connector frame's width direction: across the face, square to the normal. */
const WIDTH_AXIS: Readonly<Record<Face, readonly [number, number, number]>> = {
  top: [0, 1, 0],
  bottom: [0, 1, 0],
  front: [0, 1, 0],
  back: [0, 1, 0],
  left: [1, 0, 0],
  right: [1, 0, 0],
};

interface SketchDraft {
  readonly id: string;
  readonly name: string;
  readonly plane: string;
  readonly points: Point[];
  readonly entities: Entity[];
  readonly constraints: Constraint[];
}

const slug = (s: string) => {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(out) ? out : `p_${out}`.slice(0, 40);
};

export class PartBuilder {
  private readonly typeParams: ParamDef[] = [];
  private readonly instanceParams: ParamDef[] = [];
  private readonly typeValues: Record<string, ParamValue> = {};
  private readonly connectors: PartConnector[] = [];
  private readonly planes: ReferencePlane[] = [];
  private readonly sketches: SketchDraft[] = [];
  private readonly profiles: PartProfile[] = [];
  private readonly features: PartFeature2[] = [];
  private readonly symbols: PartSymbol[] = [];
  private readonly clearances: NonNullable<PartTypeDefinition["clearances"]> = [];
  private envelope: { readonly length: Dim; readonly width: Dim; readonly height: Dim; readonly x: Dim; readonly y: Dim; readonly base: Dim } | null = null;
  private counter = 0;
  private lastIds: string[] = [];

  constructor(
    private readonly name: string,
    private readonly start: PartStart,
  ) {}

  /**
   * A type parameter, returning its dimension: pass it to a body or a
   * connector and that dimension follows the parameter on every size. A
   * measure becomes a length parameter in millimetres; a number keeps its unit.
   */
  param(name: string, spec: { readonly label: string; readonly value: Measure } | { readonly label: string; readonly value: number; readonly unit?: ParamDef["unit"] } | { readonly label: string; readonly value: string | boolean }): Dim {
    if (this.typeParams.some((p) => p.name === name) || this.instanceParams.some((p) => p.name === name)) throw new PartBuildError(`Parameter ${name} is declared twice.`);
    const v = spec.value;
    if (typeof v === "object") {
      this.typeParams.push({ name, label: spec.label, kind: "length", unit: "mm" });
      this.typeValues[name] = mm(v, spec.label) as number;
    } else if (typeof v === "number") {
      const unit = "unit" in spec ? spec.unit : undefined;
      this.typeParams.push({ name, label: spec.label, kind: "number", ...(unit ? { unit } : {}) });
      this.typeValues[name] = v;
    } else {
      this.typeParams.push({ name, label: spec.label, kind: typeof v === "boolean" ? "boolean" : "text" });
      this.typeValues[name] = v;
    }
    return { param: name };
  }

  /**
   * A value each placed copy carries for itself (a panel's name, its mains,
   * an RTU's mark-up note), with an optional default; it shows in the
   * properties and schedules, not in the shape.
   */
  instanceParam(name: string, spec: { readonly label: string; readonly kind: "text" | "number" | "boolean" | "choice"; readonly default?: string | number | boolean; readonly unit?: ParamDef["unit"]; readonly choices?: readonly string[] }): this {
    if (this.typeParams.some((p) => p.name === name) || this.instanceParams.some((p) => p.name === name)) throw new PartBuildError(`Parameter ${name} is declared twice.`);
    if (spec.kind === "choice" && (!spec.choices || spec.choices.length === 0)) throw new PartBuildError(`${spec.label} is a choice: give its choices.`);
    this.instanceParams.push({ name, label: spec.label, kind: spec.kind, ...(spec.unit ? { unit: spec.unit } : {}), ...(spec.choices ? { choices: [...spec.choices] } : {}), ...(spec.default !== undefined ? { default: spec.default } : {}) });
    return this;
  }

  // -------------------------------------------------------------- internals

  /** A dimension's number at this size (drawn positions; sizes stay parametric in the stored constraints). */
  private readonly num = (d: Dim): number => {
    if (typeof d === "number") return d;
    const value = (n: string): number => {
      const v = this.typeValues[n];
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      throw new PartBuildError(`Parameter ${n} has no number value.`);
    };
    if ("param" in d) return value(d.param) * (d.scale ?? 1) + (d.add ?? 0);
    return evaluateFormula(parseFormula(d.formula), value);
  };

  /** Where a point is drawn (the solver's start). A dimension that can't be worked out yet is drawn at 0; the kernel's check names it at build. */
  private readonly drawn = (d: Dim): number => {
    try {
      return this.num(d);
    } catch (err) {
      if (err instanceof PartBuildError || err instanceof FormulaError) return 0;
      throw err;
    }
  };

  private readonly nextId = (prefix: string): string => {
    this.counter++;
    return `${prefix}${this.counter}`;
  };

  private readonly plane = (axis: PlaneAxis, offset: Dim): string => {
    if (isZero(offset)) return BUILTIN_PLANE[axis];
    const key = JSON.stringify(offset);
    const found = this.planes.find((p) => p.axis === axis && JSON.stringify(p.offset) === key);
    if (found) return found.id;
    if (this.planes.length >= 100) throw new PartBuildError("The part uses more than 100 drawing planes; share positions between bodies.");
    const id = this.nextId("pl");
    this.planes.push({ id, name: `${axis} = ${Math.round(this.drawn(offset))} mm`, axis, offset });
    return id;
  };

  private readonly sketchOn = (planeId: string, name: string): SketchDraft => {
    if (this.sketches.length >= 200) throw new PartBuildError("The part has more than 200 sketches; combine profiles or use pattern.");
    const s: SketchDraft = { id: this.nextId("sk"), name, plane: planeId, points: [], entities: [], constraints: [] };
    this.sketches.push(s);
    return s;
  };

  private readonly point = (s: SketchDraft, u: Dim, v: Dim): string => {
    const id = `${s.id}p${s.points.length + 1}`;
    s.points.push({ id, u: this.drawn(u), v: this.drawn(v) });
    s.constraints.push({ kind: "fix", point: id, u, v });
    return id;
  };

  private readonly line = (s: SketchDraft, a: string, b: string, construction = false): string => {
    const id = `${s.id}e${s.entities.length + 1}`;
    s.entities.push({ kind: "line", id, a, b, ...(construction ? { construction: true } : {}) });
    return id;
  };

  private readonly arc = (s: SketchDraft, center: string, from: string, to: string): string => {
    const id = `${s.id}e${s.entities.length + 1}`;
    s.entities.push({ kind: "arc", id, center, start: from, end: to });
    return id;
  };

  /** Writes one outline into a sketch, shifted by (du, dv); returns its edge ids, in order. */
  private readonly shape = (s: SketchDraft, shape: Shape, du: Dim, dv: Dim): string[] => {
    const P = (u: Dim, v: Dim) => this.point(s, sum(u, du), sum(v, dv));
    if (shape.kind === "circle") {
      const c = P(shape.cx, shape.cy);
      const id = `${s.id}e${s.entities.length + 1}`;
      s.entities.push({ kind: "circle", id, center: c, radius: shape.r });
      return [id];
    }
    if (shape.kind === "rect") {
      const x0 = sum(shape.cx, scaled(shape.w, -0.5));
      const x1 = sum(shape.cx, scaled(shape.w, 0.5));
      const y0 = sum(shape.cy, scaled(shape.h, -0.5));
      const y1 = sum(shape.cy, scaled(shape.h, 0.5));
      if (!shape.corner) {
        const ps = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
        return ps.map((p, i) => this.line(s, p, ps[(i + 1) % 4] as string));
      }
      const r = shape.corner.size;
      const w = this.num(shape.w);
      const h = this.num(shape.h);
      if (!(this.num(r) * 2 < Math.min(w, h))) throw new PartBuildError(`A ${shape.corner.kind} of ${Math.round(this.num(r))} mm doesn't fit a ${Math.round(w)} x ${Math.round(h)} mm rectangle.`);
      const rn = neg(r);
      // Counter-clockwise from the bottom edge: side, corner, side, corner, ...
      const b0 = P(sum(x0, r), y0);
      const b1 = P(sum(x1, rn), y0);
      const r0 = P(x1, sum(y0, r));
      const r1 = P(x1, sum(y1, rn));
      const t0 = P(sum(x1, rn), y1);
      const t1 = P(sum(x0, r), y1);
      const l0 = P(x0, sum(y1, rn));
      const l1 = P(x0, sum(y0, r));
      const corner = (from: string, to: string, cu: Dim, cv: Dim) => (shape.corner?.kind === "fillet" ? this.arc(s, P(cu, cv), from, to) : this.line(s, from, to));
      return [
        this.line(s, b0, b1),
        corner(b1, r0, sum(x1, rn), sum(y0, r)),
        this.line(s, r0, r1),
        corner(r1, t0, sum(x1, rn), sum(y1, rn)),
        this.line(s, t0, t1),
        corner(t1, l0, sum(x0, r), sum(y1, rn)),
        this.line(s, l0, l1),
        corner(l1, b0, sum(x0, r), sum(y0, r)),
      ];
    }
    const pts = shape.pts;
    const n = pts.length;
    if (!shape.corner) {
      const ids = pts.map(([u, v]) => P(u, v));
      return ids.map((p, i) => this.line(s, p, ids[(i + 1) % n] as string));
    }
    // Each corner trimmed back by its fillet's tangent length (or the chamfer), joined by an arc or a line.
    const size = shape.corner.size;
    const cut: Array<{ a: readonly [number, number]; b: readonly [number, number]; c?: readonly [number, number]; left: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i] as readonly [number, number];
      const prev = pts[(i + n - 1) % n] as readonly [number, number];
      const next = pts[(i + 1) % n] as readonly [number, number];
      const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      const l2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const d1 = [(p[0] - prev[0]) / l1, (p[1] - prev[1]) / l1] as const;
      const d2 = [(next[0] - p[0]) / l2, (next[1] - p[1]) / l2] as const;
      const crossZ = d1[0] * d2[1] - d1[1] * d2[0];
      const turn = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      const t = shape.corner.kind === "fillet" ? size * Math.tan(turn / 2) : size;
      if (t > Math.min(l1, l2) / 2 + 1e-6) throw new PartBuildError(`Corner ${i + 1}'s ${shape.corner.kind} of ${size} mm doesn't fit its sides.`);
      const a = [p[0] - d1[0] * t, p[1] - d1[1] * t] as const;
      const b = [p[0] + d2[0] * t, p[1] + d2[1] * t] as const;
      const left = crossZ > 0;
      const nrm = left ? ([-d1[1], d1[0]] as const) : ([d1[1], -d1[0]] as const);
      cut.push({ a, b, ...(shape.corner.kind === "fillet" && Math.abs(crossZ) > 1e-9 ? { c: [a[0] + nrm[0] * size, a[1] + nrm[1] * size] as const } : {}), left });
    }
    const edges: string[] = [];
    const starts = cut.map((k) => P(k.a[0], k.a[1]));
    const ends = cut.map((k) => P(k.b[0], k.b[1]));
    for (let i = 0; i < n; i++) {
      const k = cut[i] as (typeof cut)[number];
      const a = starts[i] as string;
      const b = ends[i] as string;
      if (k.c) edges.push(k.left ? this.arc(s, P(k.c[0], k.c[1]), a, b) : this.arc(s, P(k.c[0], k.c[1]), b, a));
      else edges.push(this.line(s, a, b));
      edges.push(this.line(s, b, starts[(i + 1) % n] as string));
    }
    return edges;
  };

  /** A profile drawn on a plane square to `axis` at `offset`, shifted by (du, dv); returns its id. */
  private readonly profileOn = (profile: Profile, axis: PlaneAxis, offset: Dim, label: string, du: Dim = 0, dv: Dim = 0): string => {
    const s = this.sketchOn(this.plane(axis, offset), label);
    const outer = this.shape(s, profile.outline, du, dv);
    const holes = profile.holes.map((h) => ({ edges: this.shape(s, h, du, dv) }));
    const id = this.nextId("pr");
    this.profiles.push({ id, name: label, sketch: s.id, outer: { edges: outer }, ...(holes.length > 0 ? { holes } : {}) });
    return id;
  };

  private readonly body = (feature: PartFeature2): void => {
    if (this.features.some((f) => f.id === feature.id)) throw new PartBuildError(`A body named ${feature.id} already exists.`);
    if (this.features.length >= 400) throw new PartBuildError("The part has more than 400 features; use pattern for repeats.");
    this.features.push(feature);
    this.lastIds = [feature.id];
  };

  private readonly base = (o: BodyOptions, fallbackName: string) => {
    const id = o.id ?? this.nextId("f");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(id)) throw new PartBuildError(`Body id ${id}: start with a letter; letters, digits, - and _.`);
    return { id, name: fallbackName, operation: o.cut ? ("cut" as const) : ("join" as const), ...(o.show ? { visibility: [...o.show] } : {}), ...(o.material ? { material: o.material } : {}) };
  };

  private readonly setEnvelope = (e: NonNullable<PartBuilder["envelope"]>): void => {
    this.envelope ??= e;
  };

  // -------------------------------------------------------------- bodies

  /**
   * Push a profile straight out of its view: plan profiles go up, front ones
   * toward the front (+x), side ones to the left (+y). `at` is where the
   * drawing plane sits along that direction; `from` and `to` are measured from it.
   */
  extrude(profile: Profile, spec: { readonly on?: View; readonly at?: Length; readonly from?: Length; readonly to: Length } & BodyOptions): this {
    const on = spec.on ?? "plan";
    const axis = VIEW_AXIS[on];
    const at = spec.at === undefined ? 0 : mm(spec.at, "Plane position");
    const from = spec.from === undefined ? 0 : mm(spec.from, "From");
    const to = mm(spec.to, "To");
    // The side plane's normal points right (-y); "to the left" is negative along it.
    const [start, end] = on === "side" ? [neg(to), neg(from)] : [from, to];
    const base = this.base(spec, `Extrude (${on})`);
    const pr = this.profileOn(profile, axis, at, `${base.name} profile`);
    this.body({ kind: "extrude", ...base, profile: pr, start, end });
    return this;
  }

  /** `extrude` that removes material: openings, recesses, holes through a casing. */
  cut(profile: Profile, spec: { readonly on?: View; readonly at?: Length; readonly from?: Length; readonly to: Length } & Omit<BodyOptions, "cut">): this {
    return this.extrude(profile, { ...spec, cut: true });
  }

  /** Turn a profile about a line in the same view (`axis` from one point to another): round bodies, domes, bells, nozzles. */
  revolve(profile: Profile, spec: { readonly on?: View; readonly at?: Length; readonly axis: readonly [readonly [Length, Length], readonly [Length, Length]]; readonly angle?: number; readonly startAngle?: number } & BodyOptions): this {
    const on = spec.on ?? "front";
    const at = spec.at === undefined ? 0 : mm(spec.at, "Plane position");
    const base = this.base(spec, `Revolve (${on})`);
    const pr = this.profileOn(profile, VIEW_AXIS[on], at, `${base.name} profile`);
    const sketch = this.sketches[this.sketches.length - 1] as SketchDraft;
    const a = this.point(sketch, mm(spec.axis[0][0], "Axis"), mm(spec.axis[0][1], "Axis"));
    const b = this.point(sketch, mm(spec.axis[1][0], "Axis"), mm(spec.axis[1][1], "Axis"));
    const axisLine = this.line(sketch, a, b, true);
    const startAngle = spec.startAngle ?? 0;
    this.body({ kind: "revolve", ...base, profile: pr, axis: axisLine, startAngle, endAngle: startAngle + (spec.angle ?? 360) });
    return this;
  }

  /**
   * Carry a profile along a path of straights and bends (an elbow, an offset,
   * a coil return). The profile is drawn across the path where it starts, in
   * the coordinates of the plane square to that heading (plan +x heading: y
   * right, z up), centred on the path.
   */
  sweep(profile: Profile, path: SweepPath, opts: BodyOptions = {}): this {
    if (path.segments.length === 0) throw new PartBuildError("A sweep path needs at least one straight or bend.");
    const axis = VIEW_AXIS[path.on];
    const at = path.at === undefined ? 0 : fixed(path.at, "Path plane position");
    const frame = planeFrame(axis, at);
    const base = this.base(opts, `Sweep (${path.on})`);
    const s = this.sketchOn(this.plane(axis, at), `${base.name} path`);
    let u = fixed(path.start[0], "Path start");
    let v = fixed(path.start[1], "Path start");
    let dir: [number, number] = path.heading === "right" ? [1, 0] : path.heading === "left" ? [-1, 0] : path.heading === "up" ? [0, 1] : [0, -1];
    const startHeading = dir;
    let cur = this.point(s, u, v);
    const edges: string[] = [];
    for (const [i, seg] of path.segments.entries()) {
      if ("straight" in seg) {
        const L = fixed(seg.straight, `Path straight ${i + 1}`);
        if (!(L > 0)) throw new PartBuildError(`Path straight ${i + 1} has no length.`);
        u += dir[0] * L;
        v += dir[1] * L;
        const next = this.point(s, u, v);
        edges.push(this.line(s, cur, next));
        cur = next;
      } else {
        const r = fixed(seg.bend.radius, `Path bend ${i + 1} radius`);
        const ang = seg.bend.angle;
        if (!(r > 0) || !(ang > 0) || ang > 180) throw new PartBuildError(`Path bend ${i + 1} needs a radius and an angle between 0 and 180 degrees.`);
        const left = seg.bend.turn === "left";
        const n: [number, number] = left ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
        const cu = u + n[0] * r;
        const cv = v + n[1] * r;
        const rad = ((left ? 1 : -1) * ang * Math.PI) / 180;
        const ru = u - cu;
        const rv = v - cv;
        u = cu + ru * Math.cos(rad) - rv * Math.sin(rad);
        v = cv + ru * Math.sin(rad) + rv * Math.cos(rad);
        dir = [dir[0] * Math.cos(rad) - dir[1] * Math.sin(rad), dir[0] * Math.sin(rad) + dir[1] * Math.cos(rad)];
        const next = this.point(s, u, v);
        const c = this.point(s, cu, cv);
        // Arcs run counter-clockwise from start to end as drawn; a right turn is drawn end to start.
        edges.push(left ? this.arc(s, c, cur, next) : this.arc(s, c, next, cur));
        cur = next;
      }
    }
    // The profile on the plane square to the start heading, through the start point.
    const p0 = fixedPoint(frame, fixed(path.start[0], "Path start"), fixed(path.start[1], "Path start"));
    const t = [frame.uAxis[0] * startHeading[0] + frame.vAxis[0] * startHeading[1], frame.uAxis[1] * startHeading[0] + frame.vAxis[1] * startHeading[1], frame.uAxis[2] * startHeading[0] + frame.vAxis[2] * startHeading[1]] as const;
    const profAxis: PlaneAxis = Math.abs(t[0]) > 0.5 ? "x" : Math.abs(t[1]) > 0.5 ? "y" : "z";
    const k = profAxis === "x" ? 0 : profAxis === "y" ? 1 : 2;
    const pf = planeFrame(profAxis, p0[k] ?? 0);
    const du = p0[0] * pf.uAxis[0] + p0[1] * pf.uAxis[1] + p0[2] * pf.uAxis[2];
    const dv = p0[0] * pf.vAxis[0] + p0[1] * pf.vAxis[1] + p0[2] * pf.vAxis[2];
    const pr = this.profileOn(profile, profAxis, Math.round((p0[k] ?? 0) * 1000) / 1000, `${base.name} profile`, Math.round(du * 1000) / 1000, Math.round(dv * 1000) / 1000);
    this.body({ kind: "sweep", ...base, profile: pr, path: { sketch: s.id, edges } });
    return this;
  }

  /** A solid through two or more sections (a rectangle-to-round transition, a hood, a cone): each section a profile on its own plane, in order. */
  loft(sections: readonly { readonly profile: Profile; readonly on?: View; readonly at: Length }[], opts: BodyOptions = {}): this {
    if (sections.length < 2) throw new PartBuildError("A loft needs two or more sections.");
    const base = this.base(opts, "Loft");
    const ids = sections.map((sec, i) => {
      if (sec.profile.holes.length > 0) throw new PartBuildError(`Loft section ${i + 1} has holes; a section is one outline (cut the hole after).`);
      return this.profileOn(sec.profile, VIEW_AXIS[sec.on ?? "plan"], mm(sec.at, `Section ${i + 1} position`), `${base.name} section ${i + 1}`);
    });
    this.body({ kind: "loft", ...base, profiles: ids });
    return this;
  }

  /** A box standing on the base, centred on the insertion point unless `at` (its centre on plan, and its base height) says otherwise. The first box is the part's envelope: faces for connectors are its faces. */
  box(size: { readonly length: Length; readonly width: Length; readonly height: Length }, at?: { readonly x?: Length; readonly y?: Length; readonly base?: Length } & BodyOptions): this {
    const L = mm(size.length, "Length");
    const W = mm(size.width, "Width");
    const H = mm(size.height, "Height");
    const base = at?.base === undefined ? 0 : mm(at.base, "Base");
    const x = at?.x === undefined ? 0 : mm(at.x, "x");
    const y = at?.y === undefined ? 0 : mm(at.y, "y");
    this.extrude(rectProfile(L, W, { center: [x, y] }), { ...bodyOpts(at), on: "plan", from: base, to: sum(base, H) });
    this.setEnvelope({ length: L, width: W, height: H, x, y, base });
    return this;
  }

  /** A cylinder along `axis` (z: standing on the base). */
  cylinder(spec: { readonly diameter: Length; readonly length: Length; readonly axis: "x" | "y" | "z" }, at?: { readonly x?: Length; readonly y?: Length; readonly z?: Length } & BodyOptions): this {
    const D = mm(spec.diameter, "Diameter");
    const L = mm(spec.length, "Length");
    const zc = at?.z === undefined ? (spec.axis === "z" ? scaled(L, 0.5) : scaled(D, 0.5)) : mm(at.z, "z");
    const x = at?.x === undefined ? 0 : mm(at.x, "x");
    const y = at?.y === undefined ? 0 : mm(at.y, "y");
    const half = scaled(L, 0.5);
    const opts = bodyOpts(at);
    if (spec.axis === "z") this.extrude(circleProfile(D, { center: [x, y] }), { ...opts, on: "plan", from: sum(zc, neg(half)), to: sum(zc, half) });
    else if (spec.axis === "x") this.extrude(circleProfile(D, { center: [y, zc] }), { ...opts, on: "front", from: sum(x, neg(half)), to: sum(x, half) });
    else this.extrude(circleProfile(D, { center: [x, zc] }), { ...opts, on: "side", from: sum(y, neg(half)), to: sum(y, half) });
    const zBase = sum(zc, neg(spec.axis === "z" ? half : scaled(D, 0.5)));
    this.setEnvelope(spec.axis === "z" ? { length: D, width: D, height: L, x, y, base: zBase } : spec.axis === "x" ? { length: L, width: D, height: D, x, y, base: zBase } : { length: D, width: L, height: D, x, y, base: zBase });
    return this;
  }

  /**
   * A taper along x between two rectangular openings (both width and height
   * change), centred on one axis unless `offset` moves the outlet (y, z): the
   * body between two openings of different sizes.
   */
  transition(spec: { readonly length: Length; readonly fromWidth: Length; readonly toWidth: Length; readonly height?: Length; readonly fromHeight?: Length; readonly toHeight?: Length; readonly offset?: readonly [Length, Length] } & BodyOptions): this {
    const L = mm(spec.length, "Length");
    const W1 = mm(spec.fromWidth, "From width");
    const W2 = mm(spec.toWidth, "To width");
    const shared = spec.height === undefined ? undefined : mm(spec.height, "Height");
    const H1 = spec.fromHeight === undefined ? shared : mm(spec.fromHeight, "From height");
    const H2 = spec.toHeight === undefined ? shared : mm(spec.toHeight, "To height");
    if (H1 === undefined || H2 === undefined) throw new PartBuildError("A transition needs a height, or a from height and a to height.");
    const dy = spec.offset ? mm(spec.offset[0], "Outlet offset") : 0;
    const dz = spec.offset ? mm(spec.offset[1], "Outlet offset") : 0;
    const both = (a: Dim, b: Dim, f: (x: number, y: number) => number, formula: string): Dim => (typeof a === "number" && typeof b === "number" ? f(a, b) : { formula: `${formula}(${term(a)}, ${term(b)})` });
    const Hmax = both(H1, H2, Math.max, "max");
    const mid = scaled(Hmax, 0.5);
    const half = scaled(L, 0.5);
    this.loft(
      [
        { profile: rectProfile(W1, H1, { center: [0, mid] }), on: "front", at: neg(half) },
        { profile: rectProfile(W2, H2, { center: [dy, sum(mid, dz)] }), on: "front", at: half },
      ],
      bodyOpts(spec),
    );
    this.setEnvelope({ length: L, width: both(W1, W2, Math.max, "max"), height: Hmax, x: 0, y: 0, base: 0 });
    return this;
  }

  /** Repeat earlier bodies (by id, or "last") in a line or around an axis: fins, louvre blades, bolt circles, fan blades. */
  pattern(ids: readonly string[] | "last", spec: { readonly along: "x" | "y" | "z"; readonly count: number; readonly spacing: Length } | { readonly around: "x" | "y" | "z"; readonly count: number; readonly angle?: number; readonly center?: readonly [Length, Length, Length] }, opts: { readonly id?: string } = {}): this {
    const features = this.refs(ids);
    const id = opts.id ?? this.nextId("f");
    if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 200) throw new PartBuildError("A pattern's count is a whole number from 1 to 200.");
    const arrangement: Extract<PartFeature2, { kind: "pattern" }>["arrangement"] =
      "along" in spec
        ? { kind: "linear", axis: spec.along, count: spec.count, spacing: mm(spec.spacing, "Spacing") }
        : { kind: "circular", axis: spec.around, count: spec.count, angle: spec.angle ?? 360, center: { x: spec.center ? mm(spec.center[0], "Centre") : 0, y: spec.center ? mm(spec.center[1], "Centre") : 0, z: spec.center ? mm(spec.center[2], "Centre") : 0 } };
    this.body({ kind: "pattern", id, name: "Pattern", features, arrangement });
    return this;
  }

  /** A mirrored copy of earlier bodies across the plane square to an axis (`at` along it; default the centre). */
  mirror(ids: readonly string[] | "last", spec: { readonly across: "x" | "y" | "z"; readonly at?: Length }, opts: { readonly id?: string } = {}): this {
    const features = this.refs(ids);
    const id = opts.id ?? this.nextId("f");
    this.body({ kind: "mirror", id, name: "Mirror", features, plane: this.plane(spec.across, spec.at === undefined ? 0 : mm(spec.at, "Mirror plane")) });
    return this;
  }

  private readonly refs = (ids: readonly string[] | "last"): string[] => {
    const list = ids === "last" ? this.lastIds : [...ids];
    if (list.length === 0) throw new PartBuildError("Name the bodies to repeat (their ids), or draw one first and say \"last\".");
    for (const r of list) if (!this.features.some((f) => f.id === r)) throw new PartBuildError(`There is no body ${r} to repeat.`);
    return list;
  };

  /**
   * A body from a vendor's glTF or OBJ file, pinned by its content hash: the
   * library file the host reads (sanitized and size-capped) and draws. `at`
   * is where the file's origin goes; `turn` turns it about z, degrees.
   */
  importBody(body: ImportedBodyRef, at: { readonly x?: Length; readonly y?: Length; readonly z?: Length; readonly turn?: number } = {}, opts: BodyOptions = {}): this {
    const base = this.base(opts, `Imported ${body.format} body`);
    this.body({ kind: "imported", ...base, body, at: { x: at.x === undefined ? 0 : mm(at.x, "x"), y: at.y === undefined ? 0 : mm(at.y, "y"), z: at.z === undefined ? 0 : mm(at.z, "z") }, ...(at.turn !== undefined ? { rotationDeg: at.turn } : {}) });
    return this;
  }

  /**
   * Lines drawings use instead of the solid at some detail levels: a coarse
   * plan rectangle with an X, a fine outline with its sections. At a level
   * with no symbol for the view, drawings show the solid seen from that side.
   */
  symbol(levels: DetailLevel | readonly DetailLevel[], draw: { readonly shapes?: readonly Profile[]; readonly lines?: readonly (readonly [readonly [Length, Length], readonly [Length, Length]])[] }, view: "plan" | "below" = "plan"): this {
    const s = this.sketchOn("base", `${view} symbol`);
    for (const p of draw.shapes ?? []) {
      this.shape(s, p.outline, 0, 0);
      for (const h of p.holes) this.shape(s, h, 0, 0);
    }
    for (const [a, b] of draw.lines ?? []) this.line(s, this.point(s, mm(a[0], "Line"), mm(a[1], "Line")), this.point(s, mm(b[0], "Line"), mm(b[1], "Line")));
    if (s.entities.length === 0) throw new PartBuildError("A symbol needs shapes or lines.");
    this.symbols.push({ id: this.nextId("sy"), name: `${view} symbol`, view, detailLevels: typeof levels === "string" ? [levels] : [...levels], sketch: s.id });
    return this;
  }

  /** Space kept clear in front of a face (service access, combustibles, working space); never solid. */
  clearance(zone: { readonly id: string; readonly name: string; readonly purpose: string; readonly face: Face; readonly depth: Length; readonly width?: Length; readonly height?: Length; readonly fromFloor?: boolean }): this {
    if (!(CLEARANCE_FACES as readonly string[]).includes(zone.face)) throw new PartBuildError(`A clearance goes on a face: ${CLEARANCE_FACES.join(", ")}.`);
    this.clearances.push({
      id: zone.id,
      name: zone.name,
      purpose: zone.purpose,
      face: zone.face,
      depth: mm(zone.depth, `${zone.name} depth`),
      ...(zone.width !== undefined ? { width: mm(zone.width, `${zone.name} width`) } : {}),
      ...(zone.height !== undefined ? { height: mm(zone.height, `${zone.name} height`) } : {}),
      ...(zone.fromFloor ? { fromFloor: true } : {}),
    });
    return this;
  }

  // -------------------------------------------------------------- connectors

  /**
   * A connector on a face, pointing out of it. `of: "envelope"` (default):
   * the first box, cylinder or transition; `of: "body"`: the box around
   * everything built so far.
   */
  connector(face: Face, c: ConnectorOnFace, of: "envelope" | "body" = "envelope"): this {
    const env = of === "body" ? this.bodyBox() : this.envelope;
    if (!env) throw new PartBuildError(of === "body" ? `Connector ${c.id} goes on a face of the part: draw a body first.` : `Connector ${c.id} goes on a face of the part: draw a box, cylinder or transition first.`);
    const [u, v] = c.offset ? [mm(c.offset[0], `${c.label} offset`), mm(c.offset[1], `${c.label} offset`)] : [0, 0];
    const midZ = sum(env.base, scaled(env.height, 0.5));
    const top = sum(env.base, env.height);
    const position: [Dim, Dim, Dim] =
      face === "top" ? [sum(env.x, u), sum(env.y, v), top]
      : face === "bottom" ? [sum(env.x, u), sum(env.y, v), env.base]
      : face === "front" ? [sum(env.x, scaled(env.length, 0.5)), sum(env.y, u), sum(midZ, v)]
      : face === "back" ? [sum(env.x, scaled(env.length, -0.5)), sum(env.y, u), sum(midZ, v)]
      : face === "left" ? [sum(env.x, u), sum(env.y, scaled(env.width, 0.5)), sum(midZ, v)]
      : [sum(env.x, u), sum(env.y, scaled(env.width, -0.5)), sum(midZ, v)];
    this.addConnector(c, position, NORMALS[face], WIDTH_AXIS[face]);
    return this;
  }

  /** A connector at an exact point of the part (its local frame: x to the front, y to the left, z up), facing out of `facing`. */
  connectorAt(c: Omit<ConnectorOnFace, "offset"> & { readonly at: readonly [Length, Length, Length]; readonly facing: Face }): this {
    this.addConnector(c, [mm(c.at[0], `${c.label} x`), mm(c.at[1], `${c.label} y`), mm(c.at[2], `${c.label} z`)], NORMALS[c.facing], WIDTH_AXIS[c.facing]);
    return this;
  }

  private readonly addConnector = (c: Omit<ConnectorOnFace, "offset">, position: [Dim, Dim, Dim], normal: readonly [number, number, number], widthAxis: readonly [number, number, number]): void => {
    const sized = (l: Length | undefined, what: string) => (l === undefined ? undefined : mm(l, `${c.label} ${what}`));
    const width = sized(c.width, "width");
    const height = sized(c.height, "height");
    const diameter = sized(c.diameter, "diameter");
    this.connectors.push({
      id: c.id,
      label: c.label,
      domain: c.domain,
      systemKind: c.systemKind,
      position,
      direction: [...normal],
      shape: c.shape,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(diameter !== undefined ? { diameter } : {}),
      ...(c.flow !== undefined ? { flow: c.flow } : {}),
      ...(c.voltage !== undefined ? { voltage: c.voltage } : {}),
      ...(c.poles !== undefined ? { poles: c.poles } : {}),
      ...(c.flowDirection ? { flowDirection: c.flowDirection } : {}),
      ...(c.shape === "rect" ? { widthAxis: [...widthAxis] } : {}),
      ...(c.endType ? { endType: c.endType } : {}),
    });
  };

  /** The box around every body built so far, at this size (numbers). */
  private readonly bodyBox = (): NonNullable<PartBuilder["envelope"]> | null => {
    if (this.features.length === 0) return null;
    const b = localBounds(resolveGeometry(this.draftWith([])));
    if (!Number.isFinite(b.min[0])) return null;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return { length: r(b.max[0] - b.min[0]), width: r(b.max[1] - b.min[1]), height: r(b.max[2] - b.min[2]), x: r((b.min[0] + b.max[0]) / 2), y: r((b.min[1] + b.max[1]) / 2), base: r(b.min[2]) };
  };

  // -------------------------------------------------------------- finish

  /**
   * The kernel's part-type definition, checked with the kernel's schema and
   * part rules (the words a save would refuse with). Connector placement
   * warnings come back beside it, as the part editor shows them.
   */
  build(): PartTypeDefinition {
    return this.check().definition;
  }

  /** `build` plus the kernel's connector placement warnings (a part that has them still saves). */
  check(): { readonly definition: PartTypeDefinition; readonly warnings: readonly string[] } {
    const raw = this.draft();
    const parsed = partTypeDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new PartBuildError(`${this.name} ${this.start.type}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).slice(0, 3).join("; ")}.`);
    const issue = partTypeIssues(parsed.data)[0];
    if (issue) throw new PartBuildError(`${this.name} ${this.start.type}: ${issue.message}`);
    return { definition: parsed.data, warnings: partConnectorWarnings(parsed.data) };
  }

  /** The definition as built so far, unchecked (what `check` hands the kernel). */
  draft(): PartTypeDefinition {
    return this.draftWith(this.connectors);
  }

  private readonly draftWith = (connectors: readonly PartConnector[]): PartTypeDefinition => {
    const model: PartModel2 = {
      schema: 2,
      id: slug(this.name),
      referencePlanes: [...this.planes],
      sketches: this.sketches.map((s) => ({ id: s.id, name: s.name, plane: s.plane, points: [...s.points], entities: [...s.entities], constraints: [...s.constraints] })),
      profiles: [...this.profiles],
      features: [...this.features],
      symbols: [...this.symbols],
      planDisplay: this.symbols.some((s) => s.view === "plan") ? "symbol" : "model",
      types: [],
    };
    return partDefinition(this.name, {
      typeName: this.start.type,
      category: this.start.category,
      ...(this.start.description ? { description: this.start.description } : {}),
      typeParams: this.typeParams,
      typeValues: this.typeValues,
      instanceParams: [...this.instanceParams],
      connectors: [...connectors],
      geometry: [],
      symbol: [],
      tagFields: [...(this.start.tagFields ?? ["mark", "type_name"])],
      source: { kind: "script" },
      ...(this.features.length > 0 ? { model } : {}),
      ...(this.clearances.length > 0 ? { clearances: [...this.clearances] } : {}),
    });
  };
}

function fixedPoint(frame: ReturnType<typeof planeFrame>, u: number, v: number): [number, number, number] {
  return [frame.origin[0] + frame.uAxis[0] * u + frame.vAxis[0] * v, frame.origin[1] + frame.uAxis[1] * u + frame.vAxis[1] * v, frame.origin[2] + frame.uAxis[2] * u + frame.vAxis[2] * v];
}

export const parts = {
  /** The starter library's part types (every discipline), filtered by words in the family, type or id; place one by its id. */
  starterTypes(ctx: ScriptContext, words?: string): readonly LibraryEntry[] {
    const key = words?.trim().toLowerCase();
    return onWorking(ctx, "parts.starterTypes", () => builtinPartTypes().filter((e) => !key || `${e.id} ${e.definition.familyName} ${e.definition.typeName} ${e.definition.category}`.toLowerCase().includes(key)));
  },
  /** Start one size of a part: `parts.part("Plenum", { type: "24x12", category: "duct_accessory" })`. */
  part: (name: string, start: PartStart): PartBuilder => new PartBuilder(name, start),
  /** A rectangle (width along the view's first axis, height along its second), centred unless `center` moves it; corners filleted or chamfered. */
  rect: rectProfile,
  /** A circle of a diameter, centred unless `center` moves it. */
  circle: circleProfile,
  /** Any closed polygon of fixed corners, wound either way; corners filleted or chamfered. */
  polygon: polygonProfile,
  faces: FACES,
  views: VIEWS,
};
