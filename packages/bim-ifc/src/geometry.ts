import type { Vec2 } from "@permitzip/bim-kernel";
import { $, bool, en, int, list, real, str, type StepGraph, type StepRef, type StepValue } from "./step";

/**
 * Placements and simple bodies. Coordinates are millimetres (the project
 * length unit), plan x east, y north, z up, so kernel numbers cross as they
 * are. Bodies are extrusions (a box, a plan outline pushed up, a profile
 * swept along a run) or, for a modeled part or a library fitting, its real
 * shape as a triangulated face set. Anything without a size the kernel states gets a
 * placement and no body.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A swept profile's section: a rectangle (width, height) or a circle (diameter), mm. */
export type Section = { readonly width: number; readonly height: number } | { readonly diameter: number };

const EPS = 1e-9;

function unit(v: Vec3): Vec3 | null {
  const n = Math.hypot(v.x, v.y, v.z);
  return n < EPS ? null : { x: v.x / n, y: v.y / n, z: v.z / n };
}

export class GeometryWriter {
  constructor(
    private readonly g: StepGraph,
    private readonly body: StepRef,
  ) {}

  point(p: Vec3): StepRef {
    return this.g.add("IFCCARTESIANPOINT", [list([real(p.x), real(p.y), real(p.z)])]);
  }

  point2(p: Vec2): StepRef {
    return this.g.add("IFCCARTESIANPOINT", [list([real(p.x), real(p.y)])]);
  }

  direction(v: Vec3): StepRef {
    return this.g.add("IFCDIRECTION", [list([real(v.x), real(v.y), real(v.z)])]);
  }

  direction2(v: Vec2): StepRef {
    return this.g.add("IFCDIRECTION", [list([real(v.x), real(v.y)])]);
  }

  /** A frame at `origin`; `axis` is local z, `ref` local x. Absent: the parent's. */
  axis(origin: Vec3, axis?: Vec3, ref?: Vec3): StepRef {
    return this.g.add("IFCAXIS2PLACEMENT3D", [this.point(origin), axis ? this.direction(axis) : $, ref ? this.direction(ref) : $]);
  }

  /** A frame turned `deg` counter-clockwise about z. */
  turned(origin: Vec3, deg: number): StepRef {
    if (Math.abs(deg % 360) < EPS) return this.axis(origin);
    const a = (deg * Math.PI) / 180;
    return this.axis(origin, { x: 0, y: 0, z: 1 }, { x: Math.cos(a), y: Math.sin(a), z: 0 });
  }

  placement(relTo: StepRef | null, axis: StepRef): StepRef {
    return this.g.add("IFCLOCALPLACEMENT", [relTo ?? $, axis]);
  }

  private shape(...solids: StepRef[]): StepRef {
    const rep = this.g.add("IFCSHAPEREPRESENTATION", [this.body, str("Body"), str("SweptSolid"), list(solids)]);
    return this.g.add("IFCPRODUCTDEFINITIONSHAPE", [$, $, list([rep])]);
  }

  /**
   * A triangle mesh (a modeled part's solid, local millimetres) as a closed
   * `IfcTriangulatedFaceSet` in a Tessellation body. Corners round to 0.01 mm.
   */
  mesh(positions: ArrayLike<number>, indices: ArrayLike<number>, closed: boolean): StepRef | null {
    if (indices.length < 3 || positions.length < 9) return null;
    const r = (n: number) => real(Math.round(n * 100) / 100);
    const coords: StepValue[] = [];
    for (let i = 0; i + 2 < positions.length; i += 3) coords.push(list([r(positions[i] ?? 0), r(positions[i + 1] ?? 0), r(positions[i + 2] ?? 0)]));
    const tris: StepValue[] = [];
    for (let t = 0; t + 2 < indices.length; t += 3) tris.push(list([int((indices[t] ?? 0) + 1), int((indices[t + 1] ?? 0) + 1), int((indices[t + 2] ?? 0) + 1)]));
    const pts = this.g.add("IFCCARTESIANPOINTLIST3D", [list(coords), $]);
    const faces = this.g.add("IFCTRIANGULATEDFACESET", [pts, bool(closed), $, list(tris), $]);
    const rep = this.g.add("IFCSHAPEREPRESENTATION", [this.body, str("Body"), str("Tessellation"), list([faces])]);
    return this.g.add("IFCPRODUCTDEFINITIONSHAPE", [$, $, list([rep])]);
  }

  private extrude(profile: StepRef, position: StepRef, depth: number): StepRef {
    return this.g.add("IFCEXTRUDEDAREASOLID", [profile, position, this.direction({ x: 0, y: 0, z: 1 }), real(depth)]);
  }

  private rectangle(w: number, h: number, centre: Vec2 = { x: 0, y: 0 }): StepRef {
    const pos = this.g.add("IFCAXIS2PLACEMENT2D", [this.point2(centre), $]);
    return this.g.add("IFCRECTANGLEPROFILEDEF", [en("AREA"), $, pos, real(w), real(h)]);
  }

  /** An axis-aligned box in the element's own frame, from its lowest corner up. Null when any side is not positive. */
  box(min: Vec3, max: Vec3): StepRef | null {
    const sx = max.x - min.x;
    const sy = max.y - min.y;
    const sz = max.z - min.z;
    if (!(sx > EPS && sy > EPS && sz > EPS)) return null;
    const profile = this.rectangle(sx, sy);
    return this.shape(this.extrude(profile, this.axis({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z }), sz));
  }

  /** A plan outline's distinct corners, without a repeated closing point. Null for fewer than three. */
  private ring(outline: readonly Vec2[]): readonly Vec2[] | null {
    const pts = outline.filter((p, i) => i === 0 || Math.hypot(p.x - (outline[i - 1]?.x ?? 0), p.y - (outline[i - 1]?.y ?? 0)) > EPS);
    const closedAlready = pts.length > 1 && Math.hypot((pts[0]?.x ?? 0) - (pts[pts.length - 1]?.x ?? 0), (pts[0]?.y ?? 0) - (pts[pts.length - 1]?.y ?? 0)) <= EPS;
    const ring = closedAlready ? pts.slice(0, -1) : pts;
    return ring.length < 3 ? null : ring;
  }

  private closedPolyline(ring: readonly Vec2[]): StepRef {
    const points: StepValue[] = [...ring, ...ring.slice(0, 1)].map((p) => this.point2(p));
    return this.g.add("IFCPOLYLINE", [list(points)]);
  }

  /**
   * A plan outline pushed up from `z` by `depth`, less any `holes` cut through it.
   * Null for fewer than three points or no depth; a hole with fewer than three points is left out.
   */
  prism(outline: readonly Vec2[], z: number, depth: number, holes: readonly (readonly Vec2[])[] = []): StepRef | null {
    const ring = this.ring(outline);
    if (!ring || !(depth > EPS)) return null;
    const curve = this.closedPolyline(ring);
    const voids = holes.flatMap((h) => {
      const inner = this.ring(h);
      return inner ? [this.closedPolyline(inner)] : [];
    });
    const profile = voids.length > 0 ? this.g.add("IFCARBITRARYPROFILEDEFWITHVOIDS", [en("AREA"), $, curve, list(voids)]) : this.g.add("IFCARBITRARYCLOSEDPROFILEDEF", [en("AREA"), $, curve]);
    return this.shape(this.extrude(profile, this.axis({ x: 0, y: 0, z }), depth));
  }

  /** A wall-like slab of plan length `length` along local x, `thickness` across, `height` up. */
  strip(length: number, thickness: number, height: number): StepRef | null {
    if (!(length > EPS && thickness > EPS && height > EPS)) return null;
    return this.shape(this.extrude(this.rectangle(length, thickness, { x: length / 2, y: 0 }), this.axis({ x: 0, y: 0, z: 0 }), height));
  }

  /** One profile swept from `start` to `end`, as a solid. Null when it has no length or its section has no size. */
  private sweptSolid(start: Vec3, end: Vec3, section: Section): StepRef | null {
    const d = unit({ x: end.x - start.x, y: end.y - start.y, z: end.z - start.z });
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    if (!d || !(length > EPS)) return null;
    const up = Math.abs(d.z) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const ref = unit({ x: up.y * d.z - up.z * d.y, y: up.z * d.x - up.x * d.z, z: up.x * d.y - up.y * d.x });
    if (!ref) return null;
    let profile: StepRef;
    if ("diameter" in section) {
      if (!(section.diameter > EPS)) return null;
      const pos = this.g.add("IFCAXIS2PLACEMENT2D", [this.point2({ x: 0, y: 0 }), $]);
      profile = this.g.add("IFCCIRCLEPROFILEDEF", [en("AREA"), $, pos, real(section.diameter / 2)]);
    } else {
      if (!(section.width > EPS && section.height > EPS)) return null;
      profile = this.rectangle(section.width, section.height);
    }
    return this.extrude(profile, this.axis(start, d, ref), length);
  }

  /**
   * A profile swept from `start` to `end` (a duct or pipe run), in the parent frame.
   * `section` is a rectangle (width, height) or a circle (diameter). Null when the run has no length.
   */
  sweep(start: Vec3, end: Vec3, section: Section): StepRef | null {
    const solid = this.sweptSolid(start, end, section);
    return solid ? this.shape(solid) : null;
  }

  /**
   * Several swept profiles as one body (a fitting drawn as a leg to each of its ports).
   * A leg with no length or no section is left out; null when none is left.
   */
  legs(legs: readonly { readonly start: Vec3; readonly end: Vec3; readonly section: Section }[]): StepRef | null {
    const solids = legs.flatMap((l) => this.sweptSolid(l.start, l.end, l.section) ?? []);
    return solids.length > 0 ? this.shape(...solids) : null;
  }
}
