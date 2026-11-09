/**
 * IFC -> plan background: cut and project a linked IFC at a storey's cut height
 * into ReferencePlan linework (host model frame, millimetres) with web-ifc on Node.
 *
 * Coordinate composition is derived from what the parser actually returns, not
 * assumed (MutinyBIM transform contract):
 *   - meshes: web-ifc bakes unit scale and its Z-up -> Y-up turn into each
 *     geometry's flatTransformation. deriveModelFrame() measures that matrix
 *     against the raw placements and inverts it exactly once.
 *   - 2D plan symbols (FootPrint curves): raw project units, placed by the
 *     element's raw world placement, then scaled by the file's length unit once.
 *   - link placement (IFC -> host IFC, metres) is applied once, last.
 * No recentering: models open with COORDINATE_TO_ORIGIN false and the
 * derivation refuses a translation in the mesh normalisation.
 */
import { createHash } from "node:crypto";
import * as WebIFC from "web-ifc";
import { linkedPlanPlacement, type LinkedPlanDisplay, type LinkedPlanRange, type ReferenceDiscipline, type ReferenceLabel, type ReferenceLayer, type ReferencePlan } from "@permitzip/bim-kernel";
import {
  apply,
  arcThrough,
  cutTriangle,
  invertAffine,
  mat4,
  maxAbsDiff,
  mergeCollinear,
  multiply,
  scaleMat,
  splitSharedBoundaries,
  uniformScale,
  upFacingOutline,
  type Mat4,
  type Vec3,
} from "./plan-geometry";
import { LinkedHiddenLines, closedLoops, facingOutline3d, normalZ, symbolDepth } from "./linked-hidden-lines";

export type IfcApi = WebIFC.IfcAPI;
export { fromRowMajor, IDENTITY4 } from "./plan-geometry";

/** Element types sampled to measure web-ifc's mesh normalisation (unmapped bodies first). */
const FRAME_SAMPLE_TYPES = [WebIFC.IFCWALL, WebIFC.IFCSLAB, WebIFC.IFCPIPESEGMENT, WebIFC.IFCDUCTSEGMENT, WebIFC.IFCCOLUMN];

export interface IfcModelFrame {
  /** Metres per project length unit, from IfcUnitAssignment. */
  readonly lengthUnitMetres: number;
  readonly lengthUnitName: string;
  /** web-ifc mesh world (metres, Y-up) -> IFC project space (metres, Z-up). */
  readonly meshToIfcMetres: Mat4;
  readonly derivation: {
    readonly samples: number;
    readonly agreeing: number;
    /** Extrusions whose authored origin was checked against their mapped-back mesh. */
    readonly originChecks: number;
    readonly originsContained: number;
    /** Uniform scale found in web-ifc's normalisation; must equal lengthUnitMetres. */
    readonly meshScale: number;
  };
}

export interface StoreyLevel {
  readonly name: string;
  /** Storey elevation in IFC project space, metres (from its placement). */
  readonly elevationMetres: number;
  /** IfcBuildingStorey.Elevation x length unit, metres (cross-check). */
  readonly attributeElevationMetres: number | null;
}

export interface PlanCutOptions {
  readonly id: string;
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly discipline: ReferenceDiscipline;
  /** IFC -> host IFC, column-major, metres, Z-up. Identity for the host model itself. */
  readonly ifcToHostMetres: Mat4;
  readonly storeyName: string;
  readonly cutAboveLevelMm: number;
  /** Max chord error when tessellating plan-symbol arcs, mm. */
  readonly chordErrorMm?: number;
  /** Remove linework hidden under nearer elements (a chair under a table). Default true. */
  readonly hiddenLines?: boolean;
  /** Leave out furniture, fixtures and other non-cut elements smaller than this across in plan, mm. Default 0 (keep all). */
  readonly minObjectMm?: number;
  /** The lowest height the view shows, mm above the level (its bottom less its depth). Default: 10 mm below the level. */
  readonly lowestAboveLevelMm?: number;
  /** The highest height the view shows, mm above the level (its top). Default: no limit. */
  readonly topAboveLevelMm?: number;
  /** How each IFC category shows in plan, from the add-ons (`linkedPlanDisplay`). A category with no rule is not drawn. */
  readonly display: LinkedPlanDisplay;
  /** A ceiling plan: looking up from the cut. */
  readonly lookingUp?: boolean;
  /** The view's detail level. Default medium. */
  readonly detail?: "coarse" | "medium" | "fine";
}

export interface PlanCutStats {
  readonly elementsWithGeometry: number;
  readonly cut: number;
  readonly beyond: number;
  readonly symbols: number;
  readonly above: number;
  readonly belowLevel: number;
  /** In the view range, but its category's rule doesn't draw it there (a slab the cut passes through, a door in a ceiling plan). */
  readonly notShownThere: number;
  readonly otherCategory: number;
  readonly symbolFallbacks: number;
  /** Elements left out as smaller than `minObjectMm`. */
  readonly small: number;
  /** Stretches of linework removed because a nearer element covers them. */
  readonly hiddenStretches: number;
  readonly occluders: number;
  readonly unsupportedCurves: Readonly<Record<string, number>>;
  readonly segmentsRaw: number;
  readonly segmentsMerged: number;
  readonly byLayer: Readonly<Record<string, number>>;
  readonly ms: { readonly frame: number; readonly stream: number; readonly symbols: number; readonly hidden: number; readonly merge: number; readonly total: number };
}

export interface PlanCutResult {
  readonly plan: ReferencePlan;
  readonly stats: PlanCutStats;
  readonly frame: IfcModelFrame;
  readonly level: StoreyLevel;
}

// ---------------------------------------------------------------------------
// Typed access to web-ifc lines (GetLine returns untyped objects).

function field(line: unknown, key: string): unknown {
  if (typeof line !== "object" || line === null || !(key in line)) return undefined;
  return Reflect.get(line, key);
}

function refOf(value: unknown): number | undefined {
  const v = field(value, "value");
  return field(value, "type") === 5 && typeof v === "number" ? v : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  const v = field(value, "value");
  if (typeof v === "number") return v;
  const rep = field(value, "_representationValue");
  if (typeof rep === "number") return rep;
  const internal = field(value, "_internalValue");
  if (typeof internal === "string") {
    const n = Number(internal);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  const v = field(value, "value");
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function line(api: IfcApi, modelId: number, id: number): unknown {
  const l: unknown = api.GetLine(modelId, id);
  return l;
}

function typeName(api: IfcApi, modelId: number, id: number): string {
  return api.GetNameFromTypeCode(api.GetLineType(modelId, id)).toUpperCase();
}

// ---------------------------------------------------------------------------
// Units and frame derivation.

const SI_PREFIX: Record<string, number> = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 };

export function lengthUnit(api: IfcApi, modelId: number): { metres: number; name: string } {
  const assignments = api.GetLineIDsWithType(modelId, WebIFC.IFCUNITASSIGNMENT);
  if (assignments.size() !== 1) throw new Error(`Expected one IfcUnitAssignment, found ${assignments.size()}`);
  const ua = line(api, modelId, assignments.get(0));
  for (const u of listOf(field(ua, "Units"))) {
    const id = refOf(u);
    if (id === undefined) continue;
    const unit = line(api, modelId, id);
    if (field(field(unit, "UnitType"), "value") !== "LENGTHUNIT") continue;
    const t = typeName(api, modelId, id);
    if (t === "IFCSIUNIT") return { metres: siFactor(unit), name: `${String(field(field(unit, "Prefix"), "value") ?? "")}METRE` };
    if (t === "IFCCONVERSIONBASEDUNIT") {
      const mwuId = refOf(field(unit, "ConversionFactor"));
      if (mwuId === undefined) throw new Error("Conversion-based length unit has no factor");
      const mwu = line(api, modelId, mwuId);
      const value = numberOf(field(mwu, "ValueComponent"));
      const baseId = refOf(field(mwu, "UnitComponent"));
      if (value === undefined || baseId === undefined) throw new Error("Conversion-based length unit is incomplete");
      return { metres: value * siFactor(line(api, modelId, baseId)), name: stringOf(field(unit, "Name")) ?? "conversion-based" };
    }
    throw new Error(`Unsupported length unit entity ${t}`);
  }
  throw new Error("IFC declares no length unit");
}

function siFactor(unit: unknown): number {
  if (field(field(unit, "Name"), "value") !== "METRE") throw new Error("SI length unit is not METRE");
  const prefix = field(field(unit, "Prefix"), "value");
  return typeof prefix === "string" ? (SI_PREFIX[prefix] ?? Number.NaN) : 1;
}

/**
 * Measure web-ifc's mesh normalisation N (raw IFC units, Z-up -> metres, Y-up).
 *
 * flatTransformation = N x object placement x item placement x an internal
 * per-mesh re-centring offset (pure translation, not in the IFC). So the
 * linear part of flatTransformation x inverse(authored placement) is N's linear
 * part for every body: require most bodies to agree, and its uniform scale to
 * equal the file's length unit. N's translation is then proven zero: each
 * extrusion's authored origin must land inside its own mesh, mapped back.
 */
export function deriveModelFrame(api: IfcApi, modelId: number): IfcModelFrame {
  const unit = lengthUnit(api, modelId);
  interface Sample {
    readonly linear: Mat4;
    readonly flat: Mat4;
    readonly geometryId: number;
    /** Authored extrusion origin, raw units, IFC space; null for other bodies. */
    readonly origin: Vec3 | null;
  }
  const samples: Sample[] = [];
  for (const type of FRAME_SAMPLE_TYPES) {
    const ids = api.GetLineIDsWithType(modelId, type);
    for (let i = 0; i < ids.size() && samples.length < 60; i++) {
      const id = ids.get(i);
      const placement = refOf(field(line(api, modelId, id), "ObjectPlacement"));
      if (placement === undefined) continue;
      const world = mat4(api.GetWorldTransformMatrix(modelId, placement));
      const mesh = api.GetFlatMesh(modelId, id);
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const pg = mesh.geometries.get(g);
        const item = pg.geometryExpressID;
        const isExtrusion = typeName(api, modelId, item) === "IFCEXTRUDEDAREASOLID";
        const authored = isExtrusion ? multiply(world, placement3d(api, modelId, refOf(field(line(api, modelId, item), "Position")))) : world;
        const flat = mat4(pg.flatTransformation);
        const k = multiply(flat, invertAffine(authored));
        samples.push({ linear: [...k.slice(0, 12), 0, 0, 0, 1], flat, geometryId: item, origin: isExtrusion ? apply(authored, 0, 0, 0) : null });
      }
    }
  }
  if (!samples.length) throw new Error("No placed element geometry to derive the mesh frame from");
  let best: Mat4 = samples[0]?.linear ?? [];
  let bestCount = 0;
  for (const s of samples) {
    const count = samples.filter((o) => maxAbsDiff(o.linear, s.linear) < 1e-9).length;
    if (count > bestCount) {
      best = s.linear;
      bestCount = count;
    }
  }
  if (bestCount < Math.ceil(samples.length * 0.8)) {
    throw new Error(`Mesh normalisation is not consistent: ${bestCount}/${samples.length} body geometries agree`);
  }
  const meshScale = uniformScale(best);
  if (meshScale === null) throw new Error("web-ifc mesh normalisation is not a uniform scale + rotation");
  if (Math.abs(meshScale - unit.metres) > 1e-9 * unit.metres) {
    throw new Error(`web-ifc scaled meshes by ${meshScale}, but the file's length unit is ${unit.metres} m (${unit.name})`);
  }
  const meshToIfcMetres = multiply(scaleMat(unit.metres), invertAffine(best));

  // Zero translation: authored extrusion origins sit inside their own mapped-back meshes.
  const withOrigin = samples.filter((s) => s.origin !== null && maxAbsDiff(s.linear, best) < 1e-9);
  let contained = 0;
  for (const s of withOrigin) {
    const geom = api.GetGeometry(modelId, s.geometryId);
    const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const m = multiply(meshToIfcMetres, s.flat);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 5 < v.length; i += 6) {
      const p = apply(m, v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a] ?? 0, p[a] ?? 0);
        hi[a] = Math.max(hi[a] ?? 0, p[a] ?? 0);
      }
    }
    geom.delete();
    const o = s.origin ?? [0, 0, 0];
    const tol = 0.005;
    if ([0, 1, 2].every((a) => (o[a] ?? 0) * unit.metres >= (lo[a] ?? 0) - tol && (o[a] ?? 0) * unit.metres <= (hi[a] ?? 0) + tol)) contained += 1;
  }
  if (!withOrigin.length || contained < Math.ceil(withOrigin.length * 0.8)) {
    throw new Error(`Mesh positions do not match authored placements (${contained}/${withOrigin.length} extrusion origins inside their meshes): a recentering or unit is being applied`);
  }
  return {
    lengthUnitMetres: unit.metres,
    lengthUnitName: unit.name,
    meshToIfcMetres,
    derivation: { samples: samples.length, agreeing: bestCount, originChecks: withOrigin.length, originsContained: contained, meshScale },
  };
}

export function storeyLevel(api: IfcApi, modelId: number, frame: IfcModelFrame, name: string): StoreyLevel {
  const ids = api.GetLineIDsWithType(modelId, WebIFC.IFCBUILDINGSTOREY);
  const names: string[] = [];
  for (let i = 0; i < ids.size(); i++) {
    const s = line(api, modelId, ids.get(i));
    const storeyName = stringOf(field(s, "Name")) ?? "";
    names.push(storeyName);
    if (storeyName !== name) continue;
    const placement = refOf(field(s, "ObjectPlacement"));
    if (placement === undefined) throw new Error(`Storey ${name} has no placement`);
    const world = mat4(api.GetWorldTransformMatrix(modelId, placement));
    const attr = numberOf(field(s, "Elevation"));
    return {
      name,
      elevationMetres: (world[14] ?? 0) * frame.lengthUnitMetres,
      attributeElevationMetres: attr === undefined ? null : attr * frame.lengthUnitMetres,
    };
  }
  throw new Error(`No storey named "${name}"; the file has ${names.map((n) => `"${n}"`).join(", ")}`);
}

/** Host transform must keep Z vertical (plan cuts are horizontal). */
function assertLevelPlacement(m: Mat4): void {
  const tilt = Math.hypot(m[2] ?? 0, m[6] ?? 0, m[8] ?? 0, m[9] ?? 0);
  if (tilt > 1e-9 || Math.abs((m[10] ?? 0) - 1) > 1e-9) throw new Error("Link placement tilts the model; a horizontal plan cut is not defined");
}

// ---------------------------------------------------------------------------
// Plan symbols (FootPrint representation curves).

interface SymbolContext {
  readonly api: IfcApi;
  readonly modelId: number;
  /** IfcIndexedPolyCurve id -> segment kinds in order ("arc" | "line"), read from the STEP text. */
  readonly polyCurveSegments: ReadonlyMap<number, readonly ("arc" | "line")[]>;
  readonly chordError: number;
  readonly unsupported: Map<string, number>;
}

/** web-ifc does not tell IfcArcIndex from IfcLineIndex; the STEP text does. */
export function indexPolyCurveSegments(bytes: Uint8Array): Map<number, ("arc" | "line")[]> {
  const text = new TextDecoder("latin1").decode(bytes);
  const out = new Map<number, ("arc" | "line")[]>();
  const re = /^#(\d+)\s*=\s*IFCINDEXEDPOLYCURVE\((.*)\);\s*$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[2] ?? "";
    const kinds: ("arc" | "line")[] = [];
    for (const k of body.matchAll(/IFC(ARC|LINE)INDEX\(/g)) kinds.push(k[1] === "ARC" ? "arc" : "line");
    out.set(Number(m[1]), kinds);
  }
  return out;
}

function placement3d(api: IfcApi, modelId: number, id: number | undefined): Mat4 {
  if (id === undefined) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const p = line(api, modelId, id);
  const loc = point(api, modelId, refOf(field(p, "Location")));
  const z = direction(api, modelId, refOf(field(p, "Axis"))) ?? [0, 0, 1];
  const xRaw = direction(api, modelId, refOf(field(p, "RefDirection"))) ?? [1, 0, 0];
  return basis(loc, xRaw, z);
}

function basis(origin: Vec3, xRaw: Vec3, zRaw: Vec3, scale = 1): Mat4 {
  const zl = Math.hypot(...zRaw);
  const z: Vec3 = [zRaw[0] / zl, zRaw[1] / zl, zRaw[2] / zl];
  const d = xRaw[0] * z[0] + xRaw[1] * z[1] + xRaw[2] * z[2];
  const xo: Vec3 = [xRaw[0] - d * z[0], xRaw[1] - d * z[1], xRaw[2] - d * z[2]];
  const xl = Math.hypot(...xo);
  const x: Vec3 = [xo[0] / xl, xo[1] / xl, xo[2] / xl];
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0] * scale, x[1] * scale, x[2] * scale, 0, y[0] * scale, y[1] * scale, y[2] * scale, 0, z[0] * scale, z[1] * scale, z[2] * scale, 0, origin[0], origin[1], origin[2], 1];
}

function transformOperator(api: IfcApi, modelId: number, id: number | undefined): Mat4 {
  if (id === undefined) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const t = line(api, modelId, id);
  if (field(t, "Scale2") !== undefined && field(t, "Scale2") !== null) throw new Error("Non-uniform mapping transforms are not supported");
  const origin = point(api, modelId, refOf(field(t, "LocalOrigin")));
  const x = direction(api, modelId, refOf(field(t, "Axis1"))) ?? [1, 0, 0];
  const z = direction(api, modelId, refOf(field(t, "Axis3"))) ?? [0, 0, 1];
  return basis(origin, x, z, numberOf(field(t, "Scale")) ?? 1);
}

function point(api: IfcApi, modelId: number, id: number | undefined): Vec3 {
  if (id === undefined) return [0, 0, 0];
  const c = listOf(field(line(api, modelId, id), "Coordinates")).map((v) => numberOf(v) ?? 0);
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

function direction(api: IfcApi, modelId: number, id: number | undefined): Vec3 | undefined {
  if (id === undefined) return undefined;
  const c = listOf(field(line(api, modelId, id), "DirectionRatios")).map((v) => numberOf(v) ?? 0);
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

/** Polylines (raw local units) for one curve; unknown curve types are counted, never silently dropped. */
function curvePolylines(ctx: SymbolContext, id: number): [number, number][][] {
  const t = typeName(ctx.api, ctx.modelId, id);
  const l = line(ctx.api, ctx.modelId, id);
  if (t === "IFCINDEXEDPOLYCURVE") {
    const ptsId = refOf(field(l, "Points"));
    if (ptsId === undefined) return [];
    const coords = listOf(field(line(ctx.api, ctx.modelId, ptsId), "CoordList")).map((row): [number, number] => {
      const r = listOf(row).map((v) => numberOf(v) ?? 0);
      return [r[0] ?? 0, r[1] ?? 0];
    });
    const segs = listOf(field(l, "Segments"));
    if (!segs.length) return [coords];
    const kinds = ctx.polyCurveSegments.get(id);
    if (!kinds || kinds.length !== segs.length) {
      ctx.unsupported.set("IFCINDEXEDPOLYCURVE(segment kinds unreadable)", (ctx.unsupported.get("IFCINDEXEDPOLYCURVE(segment kinds unreadable)") ?? 0) + 1);
      return [];
    }
    const out: [number, number][] = [];
    segs.forEach((s, k) => {
      const idx = listOf(field(s, "value")).map((v) => (numberOf(v) ?? 1) - 1);
      const p = idx.map((i) => coords[i]).filter((v): v is [number, number] => v !== undefined);
      if (kinds[k] === "arc" && p.length === 3 && p[0] && p[1] && p[2]) out.push(...arcThrough(p[0], p[1], p[2], ctx.chordError));
      else out.push(...p);
    });
    return [out];
  }
  if (t === "IFCPOLYLINE") {
    return [
      listOf(field(l, "Points")).map((r): [number, number] => {
        const p = point(ctx.api, ctx.modelId, refOf(r));
        return [p[0], p[1]];
      }),
    ];
  }
  if (t === "IFCCOMPOSITECURVE") {
    const out: [number, number][][] = [];
    for (const s of listOf(field(l, "Segments"))) {
      const segId = refOf(s);
      const parent = segId === undefined ? undefined : refOf(field(line(ctx.api, ctx.modelId, segId), "ParentCurve"));
      if (parent !== undefined) out.push(...curvePolylines(ctx, parent));
    }
    return out;
  }
  ctx.unsupported.set(t, (ctx.unsupported.get(t) ?? 0) + 1);
  return [];
}

/** FootPrint curves of one element, as flat raw-unit segments in the element's object frame. */
function footprintSegments(ctx: SymbolContext, elementId: number): { segments: number[]; found: boolean } {
  const productShape = refOf(field(line(ctx.api, ctx.modelId, elementId), "Representation"));
  if (productShape === undefined) return { segments: [], found: false };
  const segments: number[] = [];
  let found = false;
  const walkItems = (items: unknown[], m: Mat4) => {
    for (const it of items) {
      const id = refOf(it);
      if (id === undefined) continue;
      const t = typeName(ctx.api, ctx.modelId, id);
      const l = line(ctx.api, ctx.modelId, id);
      if (t === "IFCMAPPEDITEM") {
        const mapId = refOf(field(l, "MappingSource"));
        if (mapId === undefined) continue;
        const map = line(ctx.api, ctx.modelId, mapId);
        const origin = placement3d(ctx.api, ctx.modelId, refOf(field(map, "MappingOrigin")));
        const target = transformOperator(ctx.api, ctx.modelId, refOf(field(l, "MappingTarget")));
        const repId = refOf(field(map, "MappedRepresentation"));
        if (repId === undefined) continue;
        walkItems(listOf(field(line(ctx.api, ctx.modelId, repId), "Items")), multiply(m, multiply(target, origin)));
      } else if (t === "IFCGEOMETRICSET" || t === "IFCGEOMETRICCURVESET") {
        walkItems(listOf(field(l, "Elements")), m);
      } else {
        for (const poly of curvePolylines(ctx, id)) {
          for (let k = 0; k + 1 < poly.length; k++) {
            const a = poly[k];
            const b = poly[k + 1];
            if (!a || !b) continue;
            const pa = apply(m, a[0], a[1], 0);
            const pb = apply(m, b[0], b[1], 0);
            segments.push(pa[0], pa[1], pb[0], pb[1]);
          }
        }
      }
    }
  };
  for (const r of listOf(field(line(ctx.api, ctx.modelId, productShape), "Representations"))) {
    const repId = refOf(r);
    if (repId === undefined) continue;
    const rep = line(ctx.api, ctx.modelId, repId);
    if (stringOf(field(rep, "RepresentationIdentifier")) !== "FootPrint") continue;
    found = true;
    walkItems(listOf(field(rep, "Items")), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  return { segments, found };
}

// ---------------------------------------------------------------------------
// The cut.

interface Tri {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  /** Representation item index within the element (compound-wall layers are separate items). */
  readonly part: number;
}

/** Layer-joint linework of a cut element is drawn on its own category: `${category}${LAYER_JOINT}`. */
export const LAYER_JOINT = ":LAYER_JOINT";

export function cutIfcPlan(api: IfcApi, modelId: number, opts: PlanCutOptions): PlanCutResult {
  const t0 = performance.now();
  const frame = deriveModelFrame(api, modelId);
  const level = storeyLevel(api, modelId, frame, opts.storeyName);
  if (level.attributeElevationMetres !== null && Math.abs(level.attributeElevationMetres - level.elevationMetres) > 0.001) {
    throw new Error(`Storey ${level.name}: placement elevation ${level.elevationMetres} m disagrees with its Elevation attribute ${level.attributeElevationMetres} m`);
  }
  assertLevelPlacement(opts.ifcToHostMetres);
  const tFrame = performance.now();

  // Host plan millimetres from web-ifc mesh world, and from raw object frames.
  const meshToHostMm = multiply(scaleMat(1000), multiply(opts.ifcToHostMetres, frame.meshToIfcMetres));
  const rawToHostMm = multiply(scaleMat(1000), multiply(opts.ifcToHostMetres, scaleMat(frame.lengthUnitMetres)));
  const levelZ = apply(multiply(scaleMat(1000), opts.ifcToHostMetres), 0, 0, level.elevationMetres)[2];
  const cutZ = levelZ + opts.cutAboveLevelMm;

  const layers = new Map<string, { kind: "cut" | "projection"; category: string; segments: number[] }>();
  const push = (kind: "cut" | "projection", category: string, segs: readonly number[]) => {
    if (!segs.length) return;
    const key = `${kind}:${category}`;
    const layer = layers.get(key) ?? { kind, category, segments: [] };
    for (const v of segs) layer.segments.push(v);
    layers.set(key, layer);
  };

  let elementsWithGeometry = 0;
  let cut = 0;
  let beyond = 0;
  let above = 0;
  let belowLevel = 0;
  let notShownThere = 0;
  let otherCategory = 0;
  let small = 0;
  const deferred = new Map<number, { category: string; tris: Tri[]; minZ: number; maxZ: number }>();
  // Looking up, nearer is lower: the hidden-line engine looks down, so a ceiling plan draws outlines as they are.
  const useHidden = opts.hiddenLines !== false && opts.lookingUp !== true;
  const hidden = new LinkedHiddenLines();
  /** Projection linework held for hidden-line removal: the element's category, by express id. */
  const heldCategory = new Map<number, string>();
  const lowestZ = levelZ + (opts.lowestAboveLevelMm ?? -10);
  const minObject = opts.minObjectMm ?? 0;
  const range: LinkedPlanRange = {
    cutMm: cutZ,
    lowMm: lowestZ,
    highMm: opts.topAboveLevelMm === undefined ? Infinity : levelZ + opts.topAboveLevelMm,
    lookingUp: opts.lookingUp === true,
    detail: opts.detail ?? "medium",
  };

  /** Faces turned up, wholly below the cut: what can cover linework beneath them. */
  const addOccluders = (id: number, tris: readonly Tri[]): void => {
    if (!useHidden) return;
    for (const t of tris) {
      if (t.a[2] > cutZ || t.b[2] > cutZ || t.c[2] > cutZ) continue;
      if (normalZ(t.a, t.b, t.c) < 0.2) continue;
      hidden.addTriangle(id, t.a, t.b, t.c);
    }
  };

  const drawFromMesh = (id: number, category: string, tris: readonly Tri[], minZ: number, maxZ: number): void => {
    if (minZ < cutZ && maxZ > cutZ) {
      const parts: number[][] = [];
      for (const t of tris) {
        const s = cutTriangle(t.a, t.b, t.c, cutZ, 0.5);
        if (!s) continue;
        const part = (parts[t.part] ??= []);
        part.push(...s);
      }
      const { outline, shared } = splitSharedBoundaries(parts.filter((p) => p.length > 0), 1);
      push("cut", category, outline);
      push("cut", `${category}${LAYER_JOINT}`, shared);
      cut += 1;
    } else if (useHidden) {
      heldCategory.set(id, category);
      for (const [a, b] of facingOutline3d(tris.map((t) => [t.a, t.b, t.c] as const), 0.5)) hidden.addEdge({ owner: id, a, b, ignoreOwn: false });
      beyond += 1;
    } else {
      push("projection", category, upFacingOutline(tris.map((t) => [t.a, t.b, t.c] as const), 0.5));
      beyond += 1;
    }
  };

  api.StreamAllMeshes(modelId, (mesh) => {
    elementsWithGeometry += 1;
    const category = typeName(api, modelId, mesh.expressID);
    const rule = opts.display.rules[category];
    if (!rule) {
      otherCategory += 1;
      return;
    }
    const tris: Tri[] = [];
    let minZ = Infinity;
    let maxZ = -Infinity;
    let elMinX = Infinity;
    let elMinY = Infinity;
    let elMaxX = -Infinity;
    let elMaxY = -Infinity;
    const geoms = mesh.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modelId, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = multiply(meshToHostMm, mat4(pg.flatTransformation));
      const pts: Vec3[] = [];
      for (let i = 0; i + 5 < v.length; i += 6) {
        const p = apply(m, v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0);
        pts.push(p);
        if (p[2] < minZ) minZ = p[2];
        if (p[2] > maxZ) maxZ = p[2];
        if (p[0] < elMinX) elMinX = p[0];
        if (p[0] > elMaxX) elMaxX = p[0];
        if (p[1] < elMinY) elMinY = p[1];
        if (p[1] > elMaxY) elMaxY = p[1];
      }
      for (let k = 0; k + 2 < idx.length; k += 3) {
        const a = pts[idx[k] ?? 0];
        const b = pts[idx[k + 1] ?? 0];
        const c = pts[idx[k + 2] ?? 0];
        if (a && b && c) tris.push({ a, b, c, part: g });
      }
      geom.delete();
    }
    const placement = linkedPlanPlacement(rule, minZ, maxZ, range);
    if (placement === "skip") {
      if (minZ >= range.highMm || (minZ >= cutZ && !rule.above)) above += 1;
      else if (maxZ < lowestZ) belowLevel += 1;
      else notShownThere += 1;
      return;
    }
    // What is cut through stays whole (a wall); symbols, what is never cut and what is seen above may be left out as small.
    const mayBeSmall = rule.drawAs === "symbol" || !rule.cut || placement === "above";
    if (mayBeSmall && minObject > 0 && Math.max(elMaxX - elMinX, elMaxY - elMinY) < minObject) {
      small += 1;
      return;
    }
    // What everything stands on (slabs) doesn't occlude: it would hide door swings drawn at the floor.
    if (rule.occludes) addOccluders(mesh.expressID, tris);
    if (rule.drawAs === "symbol") {
      deferred.set(mesh.expressID, { category, tris, minZ, maxZ });
      return;
    }
    drawFromMesh(mesh.expressID, category, tris, minZ, maxZ);
  });
  const tStream = performance.now();

  const ctx: SymbolContext = {
    api,
    modelId,
    polyCurveSegments: indexPolyCurveSegments(opts.bytes),
    chordError: (opts.chordErrorMm ?? 5) / 1000 / frame.lengthUnitMetres,
    unsupported: new Map(),
  };
  let symbols = 0;
  let symbolFallbacks = 0;
  for (const [id, d] of deferred) {
    const { segments, found } = footprintSegments(ctx, id);
    if (!found || !segments.length) {
      symbolFallbacks += 1;
      drawFromMesh(id, d.category, d.tris, d.minZ, d.maxZ);
      continue;
    }
    const placement = refOf(field(line(api, modelId, id), "ObjectPlacement"));
    const world = placement === undefined ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : mat4(api.GetWorldTransformMatrix(modelId, placement));
    const m = multiply(rawToHostMm, world);
    // A symbol is flat: it sits at the height of the element's main top (a chair's seat), so a table top above it covers it.
    const depth = symbolDepth(d.tris.map((t) => [t.a, t.b, t.c] as const)) ?? d.maxZ;
    const host: number[] = [];
    for (let i = 0; i + 3 < segments.length; i += 4) {
      const a = apply(m, segments[i] ?? 0, segments[i + 1] ?? 0, 0);
      const b = apply(m, segments[i + 2] ?? 0, segments[i + 3] ?? 0, 0);
      if (useHidden) hidden.addEdge({ owner: id, a: [a[0], a[1], depth], b: [b[0], b[1], depth], ignoreOwn: true });
      else host.push(a[0], a[1], b[0], b[1]);
    }
    if (useHidden) heldCategory.set(id, d.category);
    else push("projection", d.category, host);
    symbols += 1;
  }
  const tSymbols = performance.now();

  let hiddenStretches = 0;
  if (useHidden) {
    const resolved = hidden.resolve();
    hiddenStretches = resolved.hiddenStretches;
    for (const [owner, segs] of resolved.visible) {
      const category = heldCategory.get(owner);
      if (category) push("projection", category, segs);
    }
  }
  const tHidden = performance.now();

  let segmentsRaw = 0;
  let segmentsMerged = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const byLayer: Record<string, number> = {};
  const out: ReferenceLayer[] = [...layers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, l]) => {
      segmentsRaw += l.segments.length / 4;
      const merged = mergeCollinear(l.segments, 1).map((n) => Math.round(n * 10) / 10);
      segmentsMerged += merged.length / 4;
      byLayer[key] = merged.length / 4;
      for (let i = 0; i + 1 < merged.length; i += 2) {
        const x = merged[i] ?? 0;
        const y = merged[i + 1] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { id: `${opts.id}:${key.toLowerCase()}`, discipline: opts.discipline, kind: l.kind, category: l.category, segments: merged };
    });
  const tMerge = performance.now();

  const plan: ReferencePlan = {
    id: opts.id,
    source: { file: opts.file, sha256: createHash("sha256").update(opts.bytes).digest("hex") },
    level: { name: level.name, elevationMm: Math.round(levelZ * 10) / 10 },
    cutHeightMm: opts.cutAboveLevelMm,
    bounds: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } },
    layers: out,
    labels: [],
  };
  const r = (n: number) => Math.round(n);
  return {
    plan,
    frame,
    level,
    stats: {
      elementsWithGeometry,
      cut,
      beyond,
      symbols,
      above,
      belowLevel,
      notShownThere,
      otherCategory,
      symbolFallbacks,
      small,
      hiddenStretches,
      occluders: hidden.occluderCount,
      unsupportedCurves: Object.fromEntries(ctx.unsupported),
      segmentsRaw,
      segmentsMerged,
      byLayer,
      ms: { frame: r(tFrame - t0), stream: r(tStream - tFrame), symbols: r(tSymbols - tStream), hidden: r(tHidden - tSymbols), merge: r(tMerge - tHidden), total: r(tMerge - t0) },
    },
  };
}

/**
 * Room labels from IfcSpace (name + number) at plan positions, for spaces whose
 * height range contains the cut. Host frame, millimetres.
 */
export function ifcSpaceLabels(api: IfcApi, modelId: number, ifcToHostMetres: Mat4, cutZMm: number): ReferenceLabel[] {
  const frame = deriveModelFrame(api, modelId);
  const m = multiply(scaleMat(1000), multiply(ifcToHostMetres, frame.meshToIfcMetres));
  const labels: ReferenceLabel[] = [];
  api.StreamAllMeshesWithTypes(modelId, [WebIFC.IFCSPACE], (mesh) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const geoms = mesh.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modelId, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const pm = multiply(m, mat4(pg.flatTransformation));
      for (let i = 0; i + 5 < v.length; i += 6) {
        const [x, y, z] = apply(pm, v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      geom.delete();
    }
    if (!(minZ <= cutZMm && maxZ >= cutZMm)) return;
    const l = line(api, modelId, mesh.expressID);
    const number = stringOf(field(l, "Name"));
    const name = stringOf(field(l, "LongName"));
    const text = name && number && name !== number ? `${name} ${number}` : (name ?? number);
    if (text) labels.push({ text, at: { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) } });
  });
  return labels;
}

// ---------------------------------------------------------------------------
// Vertical sections and the storey list.

/** Elements a vertical section cuts (walls, floors, roofs, structure) and draws beyond. */
const SECTION_CATEGORIES = new Set([
  "IFCWALL",
  "IFCWALLSTANDARDCASE",
  "IFCCURTAINWALL",
  "IFCCOLUMN",
  "IFCMEMBER",
  "IFCPLATE",
  "IFCWINDOW",
  "IFCRAILING",
  "IFCSTAIR",
  "IFCSTAIRFLIGHT",
  "IFCSLAB",
  "IFCROOF",
  "IFCBEAM",
  "IFCCOVERING",
  "IFCDOOR",
  "IFCFOOTING",
]);

export interface SectionCutOptions {
  readonly id: string;
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly discipline: ReferenceDiscipline;
  /** IFC -> host IFC, column-major, metres, Z-up. */
  readonly ifcToHostMetres: Mat4;
  /** The cut line in host plan millimetres, which side it looks at, and how far. */
  readonly cut: { readonly start: { x: number; y: number }; readonly end: { x: number; y: number }; readonly direction: 1 | -1; readonly depthMm: number };
  /** Remove linework behind nearer elements and behind what the cut passes through. Default true. */
  readonly hiddenLines?: boolean;
  /** Leave out elements beyond the cut smaller than this across, mm. Default 0. */
  readonly minObjectMm?: number;
}

export interface SectionCutResult {
  /** Linework in the section's drawing frame: x = distance along the cut from its start, y = elevation (host mm). */
  readonly plan: ReferencePlan;
  readonly stats: { readonly elementsWithGeometry: number; readonly cut: number; readonly beyond: number; readonly skipped: number; readonly small: number; readonly hiddenStretches: number; readonly ms: number };
}

/**
 * A linked IFC cut by a vertical section, in the section's own frame. Cut
 * linework comes from intersecting each element's triangles with the cut
 * plane; elements beyond (up to the far clip) draw the outline of the faces
 * that look back at the viewer, with hidden lines removed by the kernel's
 * engine: faces turned toward the viewer, and the convex outlines of what
 * the cut passes through, cover what lies behind them.
 */
export function cutIfcSection(api: IfcApi, modelId: number, opts: SectionCutOptions): SectionCutResult {
  const t0 = performance.now();
  const frame = deriveModelFrame(api, modelId);
  const meshToHostMm = multiply(scaleMat(1000), multiply(opts.ifcToHostMetres, frame.meshToIfcMetres));
  const { start, end, direction, depthMm } = opts.cut;
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (!(len > 0)) throw new Error("The section cut line has no length");
  const ax = (end.x - start.x) / len;
  const ay = (end.y - start.y) / len;
  const lx = -ay * direction;
  const ly = ax * direction;
  // (u, v, -w): u along the cut, v up, w away from the viewer. A section that looks to the right mirrors the frame, so its triangles flip.
  const toSection = (p: Vec3): Vec3 => {
    const dx = p[0] - start.x;
    const dy = p[1] - start.y;
    return [dx * ax + dy * ay, p[2], -(dx * lx + dy * ly)];
  };
  const mirrored = direction === -1;
  const layers = new Map<string, { kind: "cut" | "projection"; category: string; segments: number[] }>();
  const push = (kind: "cut" | "projection", category: string, segs: readonly number[]) => {
    if (!segs.length) return;
    const key = `${kind}:${category}`;
    const layer = layers.get(key) ?? { kind, category, segments: [] };
    for (const v of segs) layer.segments.push(v);
    layers.set(key, layer);
  };
  let elementsWithGeometry = 0;
  let cut = 0;
  let beyond = 0;
  let skipped = 0;
  let small = 0;
  const useHidden = opts.hiddenLines !== false;
  const hidden = new LinkedHiddenLines();
  const heldCategory = new Map<number, string>();
  const minObject = opts.minObjectMm ?? 0;
  api.StreamAllMeshes(modelId, (mesh) => {
    elementsWithGeometry += 1;
    const category = typeName(api, modelId, mesh.expressID);
    if (!SECTION_CATEGORIES.has(category)) {
      skipped += 1;
      return;
    }
    const tris: Array<readonly [Vec3, Vec3, Vec3]> = [];
    let minW = Infinity;
    let maxW = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    const geoms = mesh.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modelId, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = multiply(meshToHostMm, mat4(pg.flatTransformation));
      const pts: Vec3[] = [];
      for (let i = 0; i + 5 < v.length; i += 6) {
        const p = toSection(apply(m, v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0));
        pts.push(p);
        // Stored as -w: w = -p[2].
        if (-p[2] < minW) minW = -p[2];
        if (-p[2] > maxW) maxW = -p[2];
        if (p[0] < minU) minU = p[0];
        if (p[0] > maxU) maxU = p[0];
        if (p[1] < minV) minV = p[1];
        if (p[1] > maxV) maxV = p[1];
      }
      for (let k = 0; k + 2 < idx.length; k += 3) {
        const a = pts[idx[k] ?? 0];
        const b = pts[idx[k + 1] ?? 0];
        const c = pts[idx[k + 2] ?? 0];
        if (a && b && c) tris.push(mirrored ? [a, c, b] : [a, b, c]);
      }
      geom.delete();
    }
    if (maxW < 0 || minW > depthMm) {
      skipped += 1;
      return;
    }
    const isCut = minW < 0 && maxW > 0;
    if (!isCut && minObject > 0 && Math.max(maxU - minU, maxV - minV, maxW - minW) < minObject) {
      small += 1;
      return;
    }
    if (isCut) {
      const segs: number[] = [];
      for (const [a, b, c] of tris) {
        const s = cutTriangle(a, b, c, 0, 0.5);
        if (s) segs.push(...s);
      }
      push("cut", category, segs);
      if (useHidden) for (const loop of closedLoops(segs, 1)) hidden.addConvexLoop(mesh.expressID, loop, 0);
      cut += 1;
    } else {
      beyond += 1;
    }
    // What lies beyond the cut plane (w >= 0, so -w <= 0) shows as the outline of the faces turned toward the viewer.
    const behind = tris.filter(([a, b, c]) => a[2] <= 0.5 && b[2] <= 0.5 && c[2] <= 0.5 && Math.max(-a[2], -b[2], -c[2]) <= depthMm);
    if (!useHidden) {
      push("projection", category, upFacingOutline(behind, 0.5));
      return;
    }
    heldCategory.set(mesh.expressID, category);
    for (const [a, b, c] of behind) if (normalZ(a, b, c) >= 0.2) hidden.addTriangle(mesh.expressID, a, b, c);
    for (const [a, b] of facingOutline3d(behind, 0.5)) hidden.addEdge({ owner: mesh.expressID, a, b, ignoreOwn: false });
  });
  let hiddenStretches = 0;
  if (useHidden) {
    const resolved = hidden.resolve();
    hiddenStretches = resolved.hiddenStretches;
    for (const [owner, segs] of resolved.visible) {
      const category = heldCategory.get(owner);
      if (category) push("projection", category, segs);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const out: ReferenceLayer[] = [...layers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, l]) => {
      const merged = mergeCollinear(l.segments, 1).map((n) => Math.round(n * 10) / 10);
      for (let i = 0; i + 1 < merged.length; i += 2) {
        const x = merged[i] ?? 0;
        const y = merged[i + 1] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { id: `${opts.id}:section:${key.toLowerCase()}`, discipline: opts.discipline, kind: l.kind, category: l.category, segments: merged };
    });
  const plan: ReferencePlan = {
    id: opts.id,
    source: { file: opts.file, sha256: createHash("sha256").update(opts.bytes).digest("hex") },
    level: { name: "section", elevationMm: 0 },
    cutHeightMm: 0,
    bounds: Number.isFinite(minX) ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } },
    layers: out,
    labels: [],
  };
  return { plan, stats: { elementsWithGeometry, cut, beyond, skipped, small, hiddenStretches, ms: Math.round(performance.now() - t0) } };
}

/** Every storey in the file with its elevation in the host frame (mm), for matching a view's level. */
export function listStoreys(api: IfcApi, modelId: number, ifcToHostMetres: Mat4): Array<{ name: string; elevationMm: number }> {
  const frame = deriveModelFrame(api, modelId);
  const ids = api.GetLineIDsWithType(modelId, WebIFC.IFCBUILDINGSTOREY);
  const out: Array<{ name: string; elevationMm: number }> = [];
  for (let i = 0; i < ids.size(); i++) {
    const s = line(api, modelId, ids.get(i));
    const name = stringOf(field(s, "Name"));
    const placement = refOf(field(s, "ObjectPlacement"));
    if (!name || placement === undefined) continue;
    const world = mat4(api.GetWorldTransformMatrix(modelId, placement));
    const z = apply(multiply(scaleMat(1000), ifcToHostMetres), 0, 0, (world[14] ?? 0) * frame.lengthUnitMetres)[2];
    out.push({ name, elevationMm: Math.round(z * 10) / 10 });
  }
  return out;
}
