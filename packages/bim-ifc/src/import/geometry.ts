import type { ImportExtrusion, ImportPoint } from "@permitzip/bim-kernel";
import type { ReadEntity, StepFile, StepToken } from "../read";

/**
 * Placements and the solids the importer reads exactly (round 9 I9): local
 * placements, extruded area solids of rectangle, circle and polyline
 * profiles (and the bounding rectangle of a standard steel section), mapped
 * items, bounding boxes, and the bounds of meshes. Everything else is
 * reported in words and kept on the linked model.
 */

export interface Frame {
  readonly o: ImportPoint;
  readonly x: ImportPoint;
  readonly y: ImportPoint;
  readonly z: ImportPoint;
}

export const IDENTITY: Frame = { o: { x: 0, y: 0, z: 0 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };

const add = (a: ImportPoint, b: ImportPoint): ImportPoint => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: ImportPoint, k: number): ImportPoint => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: ImportPoint, b: ImportPoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: ImportPoint, b: ImportPoint): ImportPoint => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: ImportPoint): ImportPoint => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? mul(a, 1 / l) : a;
};

/** A vector through a frame's axes (no translation). */
export function rotate(f: Frame, v: ImportPoint): ImportPoint {
  return add(add(mul(f.x, v.x), mul(f.y, v.y)), mul(f.z, v.z));
}

export function apply(f: Frame, p: ImportPoint): ImportPoint {
  return add(f.o, rotate(f, p));
}

/** `outer` then `inner`: a point in `inner`'s frame, placed by `outer`. */
export function compose(outer: Frame, inner: Frame): Frame {
  return { o: apply(outer, inner.o), x: rotate(outer, inner.x), y: rotate(outer, inner.y), z: rotate(outer, inner.z) };
}

/** The host's turn about z and offset, applied after units. */
export function hostFrame(placement: { readonly dx: number; readonly dy: number; readonly dz: number; readonly rotationDeg: number } | undefined): Frame {
  if (!placement) return IDENTITY;
  const a = (placement.rotationDeg * Math.PI) / 180;
  return { o: { x: placement.dx, y: placement.dy, z: placement.dz }, x: { x: Math.cos(a), y: Math.sin(a), z: 0 }, y: { x: -Math.sin(a), y: Math.cos(a), z: 0 }, z: { x: 0, y: 0, z: 1 } };
}

export interface ShapeReading {
  readonly extrusions: ImportExtrusion[];
  readonly points: ImportPoint[];
  unread: string | null;
}

/** Reads entity graph geometry in file units times `scale` (mm per file unit). */
export class GeometryReader {
  private readonly placements = new Map<number, Frame>();

  constructor(
    private readonly file: StepFile,
    private readonly scale: number,
  ) {}

  entity(t: StepToken | undefined): ReadEntity | null {
    return t?.kind === "ref" ? (this.file.entities.get(t.id) ?? null) : null;
  }

  num(t: StepToken | undefined): number | null {
    if (!t) return null;
    if (t.kind === "number") return t.value;
    if (t.kind === "typed") return this.num(t.value);
    return null;
  }

  point(t: StepToken | undefined): ImportPoint | null {
    const e = this.entity(t);
    if (!e || e.type !== "IFCCARTESIANPOINT") return null;
    const c = e.args[0];
    if (c?.kind !== "list") return null;
    const [x, y, z] = c.items.map((i) => this.num(i) ?? 0);
    return { x: (x ?? 0) * this.scale, y: (y ?? 0) * this.scale, z: (z ?? 0) * this.scale };
  }

  direction(t: StepToken | undefined, fallback: ImportPoint): ImportPoint {
    const e = this.entity(t);
    if (!e || e.type !== "IFCDIRECTION") return fallback;
    const c = e.args[0];
    if (c?.kind !== "list") return fallback;
    const [x, y, z] = c.items.map((i) => this.num(i) ?? 0);
    return norm({ x: x ?? 0, y: y ?? 0, z: z ?? 0 });
  }

  /** IfcAxis2Placement3D / 2D as a frame (absent: identity). */
  axis2(t: StepToken | undefined): Frame {
    const e = this.entity(t);
    if (!e) return IDENTITY;
    const o = this.point(e.args[0]) ?? { x: 0, y: 0, z: 0 };
    if (e.type === "IFCAXIS2PLACEMENT2D") {
      const x = this.direction(e.args[1], { x: 1, y: 0, z: 0 });
      return { o, x, y: { x: -x.y, y: x.x, z: 0 }, z: { x: 0, y: 0, z: 1 } };
    }
    const z = this.direction(e.args[1], { x: 0, y: 0, z: 1 });
    const ref = this.direction(e.args[2], Math.abs(z.x) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 });
    const x = norm(add(ref, mul(z, -dot(ref, z))));
    return { o, x, y: cross(z, x), z };
  }

  /** An object placement in the file's world frame. Grid and linear placements read as identity (noted by the caller). */
  placement(t: StepToken | undefined): Frame {
    const e = this.entity(t);
    if (!e || e.type !== "IFCLOCALPLACEMENT") return IDENTITY;
    const memo = this.placements.get(e.id);
    if (memo) return memo;
    const rel = this.entity(e.args[0]) ? this.placement(e.args[0]) : IDENTITY;
    const world = compose(rel, this.axis2(e.args[1]));
    this.placements.set(e.id, world);
    return world;
  }

  /** Read a product's (or a type's) representation items under `frame`. */
  readShape(representation: StepToken | undefined, frame: Frame): ShapeReading {
    const out: ShapeReading = { extrusions: [], points: [], unread: null };
    const shape = this.entity(representation);
    if (!shape) return out;
    const reps = shape.args[2]?.kind === "list" ? shape.args[2].items : [];
    for (const rep of this.bodyFirst(reps)) this.readRepresentation(rep, frame, out);
    return out;
  }

  /** One IfcShapeRepresentation's items under `frame`, into `out`. */
  readRepresentation(rep: StepToken | undefined, frame: Frame, out: ShapeReading): void {
    const r = this.entity(rep);
    const items = r?.args[3]?.kind === "list" ? r.args[3].items : [];
    for (const item of items) this.item(item, frame, out, 0);
  }

  /** Representations to read: the Body ones (else Box, else every one). */
  bodyFirst(reps: readonly StepToken[]): readonly StepToken[] {
    const id = (rep: StepToken) => {
      const r = this.entity(rep);
      const v = r?.args[1];
      return v?.kind === "string" ? v.value.toLowerCase() : "";
    };
    const body = reps.filter((r) => id(r) === "body");
    if (body.length > 0) return body;
    const box = reps.filter((r) => id(r) === "box");
    return box.length > 0 ? box : reps.filter((r) => !["axis", "footprint", "annotation", "plan"].includes(id(r)));
  }

  private item(t: StepToken, frame: Frame, out: ShapeReading, depth: number): void {
    const e = this.entity(t);
    if (!e || depth > 8) return;
    switch (e.type) {
      case "IFCEXTRUDEDAREASOLID": {
        const local = compose(frame, this.axis2(e.args[1]));
        const dir = this.direction(e.args[2], { x: 0, y: 0, z: 1 });
        const length = (this.num(e.args[3]) ?? 0) * this.scale;
        const profile = this.profile(e.args[0]);
        if (!profile) {
          out.unread ??= "a section that couldn't be read";
          return;
        }
        if (profile.unread) out.unread ??= profile.unread;
        const base = profile.points.map((p) => apply(local, { x: p.x, y: p.y, z: 0 }));
        const along = rotate(local, mul(dir, length));
        const extrusion: ImportExtrusion = {
          base,
          along,
          ...(profile.circle ? { circle: { centre: apply(local, { x: profile.circle.cx, y: profile.circle.cy, z: 0 }), radius: profile.circle.r } } : {}),
          ...(profile.rectangle ? { rectangle: profile.rectangle } : {}),
        };
        out.extrusions.push(extrusion);
        for (const p of base) out.points.push(p, add(p, along));
        return;
      }
      case "IFCBOOLEANCLIPPINGRESULT":
      case "IFCBOOLEANRESULT": {
        this.item(e.args[1] ?? { kind: "null" }, frame, out, depth + 1);
        out.unread ??= "cut by another shape";
        return;
      }
      case "IFCMAPPEDITEM": {
        const map = this.entity(e.args[0]);
        if (!map) return;
        const target = this.operator(e.args[1]);
        const origin = this.axis2(map.args[0]);
        const placed = compose(compose(frame, target), origin);
        const rep = this.entity(map.args[1]);
        const items = rep?.args[3]?.kind === "list" ? rep.args[3].items : [];
        for (const item of items) this.item(item, placed, out, depth + 1);
        return;
      }
      case "IFCBOUNDINGBOX": {
        const c = this.point(e.args[0]) ?? { x: 0, y: 0, z: 0 };
        const [dx, dy, dz] = [1, 2, 3].map((i) => (this.num(e.args[i]) ?? 0) * this.scale);
        for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) out.points.push(apply(frame, { x: c.x + sx * (dx ?? 0), y: c.y + sy * (dy ?? 0), z: c.z + sz * (dz ?? 0) }));
        out.unread ??= "a box only";
        return;
      }
      case "IFCTRIANGULATEDFACESET":
      case "IFCPOLYGONALFACESET": {
        const list = this.entity(e.args[0]);
        const coords = list?.args[0]?.kind === "list" ? list.args[0].items : [];
        for (const c of coords) {
          if (c.kind !== "list") continue;
          const [x, y, z] = c.items.map((i) => (this.num(i) ?? 0) * this.scale);
          out.points.push(apply(frame, { x: x ?? 0, y: y ?? 0, z: z ?? 0 }));
        }
        out.unread ??= "a mesh";
        return;
      }
      case "IFCFACETEDBREP": {
        this.brepPoints(e.args[0], frame, out);
        out.unread ??= "a mesh";
        return;
      }
      default:
        out.unread ??= `a ${e.type.replace(/^IFC/, "").toLowerCase()} shape`;
    }
  }

  private brepPoints(shellRef: StepToken | undefined, frame: Frame, out: ShapeReading): void {
    const shell = this.entity(shellRef);
    const faces = shell?.args[0]?.kind === "list" ? shell.args[0].items : [];
    for (const f of faces) {
      const face = this.entity(f);
      const bounds = face?.args[0]?.kind === "list" ? face.args[0].items : [];
      for (const b of bounds) {
        const loop = this.entity(this.entity(b)?.args[0]);
        const pts = loop?.args[0]?.kind === "list" ? loop.args[0].items : [];
        for (const p of pts) {
          const q = this.point(p);
          if (q) out.points.push(apply(frame, q));
        }
      }
    }
  }

  /** IfcCartesianTransformationOperator3D (uniform scale) as a frame. */
  private operator(t: StepToken | undefined): Frame {
    const e = this.entity(t);
    if (!e) return IDENTITY;
    const o = this.point(e.args[2]) ?? { x: 0, y: 0, z: 0 };
    const k = this.num(e.args[3]) ?? 1;
    const x = this.direction(e.args[0], { x: 1, y: 0, z: 0 });
    const zGiven = this.direction(e.args[4], { x: 0, y: 0, z: 1 });
    const y = this.direction(e.args[1], cross(zGiven, x));
    const z = e.args[4] && e.args[4].kind !== "null" ? zGiven : cross(x, y);
    return { o, x: mul(x, k), y: mul(y, k), z: mul(z, k) };
  }

  /** A profile in its own plane: points (closed, in order), and whether it is a rectangle or a circle. */
  profile(t: StepToken | undefined): { points: { x: number; y: number }[]; rectangle?: { x: number; y: number }; circle?: { cx: number; cy: number; r: number }; unread?: string } | null {
    const e = this.entity(t);
    if (!e) return null;
    const pos = this.axis2(e.args[2]);
    const at = (x: number, y: number) => {
      const p = apply(pos, { x, y, z: 0 });
      return { x: p.x, y: p.y };
    };
    const rect = (xd: number, yd: number) => ({ points: [at(-xd / 2, -yd / 2), at(xd / 2, -yd / 2), at(xd / 2, yd / 2), at(-xd / 2, yd / 2)], rectangle: { x: xd, y: yd } });
    switch (e.type) {
      case "IFCRECTANGLEPROFILEDEF":
      case "IFCRECTANGLEHOLLOWPROFILEDEF":
      case "IFCROUNDEDRECTANGLEPROFILEDEF":
      case "IFCISHAPEPROFILEDEF":
      case "IFCLSHAPEPROFILEDEF":
      case "IFCTSHAPEPROFILEDEF":
      case "IFCUSHAPEPROFILEDEF":
      case "IFCCSHAPEPROFILEDEF":
      case "IFCZSHAPEPROFILEDEF": {
        const a = (this.num(e.args[3]) ?? 0) * this.scale;
        const b = (this.num(e.args[4]) ?? 0) * this.scale;
        return a > 0 && b > 0 ? rect(a, b) : null;
      }
      case "IFCCIRCLEPROFILEDEF":
      case "IFCCIRCLEHOLLOWPROFILEDEF": {
        const r = (this.num(e.args[3]) ?? 0) * this.scale;
        if (!(r > 0)) return null;
        const points = Array.from({ length: 16 }, (_, i) => at(r * Math.cos((i * Math.PI) / 8), r * Math.sin((i * Math.PI) / 8)));
        const c = at(0, 0);
        return { points, circle: { cx: c.x, cy: c.y, r } };
      }
      case "IFCARBITRARYCLOSEDPROFILEDEF":
      case "IFCARBITRARYPROFILEDEFWITHVOIDS": {
        const curve = this.entity(e.args[2]);
        const points = this.curvePoints(curve);
        if (!points) return { points: [], unread: "a curved outline" };
        return e.type === "IFCARBITRARYPROFILEDEFWITHVOIDS" ? { points, unread: "an outline with holes" } : { points };
      }
      default:
        return null;
    }
  }

  /** A straight-edged closed curve's points (2D), or null when it has arcs or isn't one this reads. */
  curvePoints(curve: ReadEntity | null): { x: number; y: number }[] | null {
    if (!curve) return null;
    if (curve.type === "IFCPOLYLINE") {
      const pts = curve.args[0]?.kind === "list" ? curve.args[0].items : [];
      const out = pts.map((p) => this.point(p)).filter((p): p is ImportPoint => p !== null).map((p) => ({ x: p.x, y: p.y }));
      return out.length >= 3 ? out : null;
    }
    if (curve.type === "IFCINDEXEDPOLYCURVE") {
      if (curve.args[1] && curve.args[1].kind === "list" && curve.args[1].items.some((s) => s.kind === "typed" && s.type === "IFCARCINDEX")) return null;
      const list = this.entity(curve.args[0]);
      const coords = list?.args[0]?.kind === "list" ? list.args[0].items : [];
      const out = coords.flatMap((c) => {
        if (c.kind !== "list") return [];
        const [x, y] = c.items.map((i) => (this.num(i) ?? 0) * this.scale);
        return [{ x: x ?? 0, y: y ?? 0 }];
      });
      return out.length >= 3 ? out : null;
    }
    return null;
  }
}

export function boundsOf(points: readonly ImportPoint[]): { min: ImportPoint; max: ImportPoint } | null {
  if (points.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}
