import type { Vec3 } from "../parts";
import { hostHalfHeight, hostHalfWidth } from "../routing/geometry";
import type { RunPoint, RunSegment, RunSize } from "../routing/types";
import type { BimElement } from "../types";
import type { ConnectorFaceDef, ConnectorFaceRow } from "./connector-faces";

/**
 * The kernel's own connector face row (`kernel.connector_face` built-in): a
 * straight run of any section lists its faces from its own geometry, so a
 * branch can sit on any of them with every add-on off. Faces sit where the
 * run's branches leave (`hostedPoints`): a single-line run's on its
 * centreline.
 */

const v = (p: RunPoint): Vec3 => [p.x, p.y, p.z];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (o: Vec3, d: Vec3, k: number): Vec3 => [o[0] + d[0] * k, o[1] + d[1] * k, o[2] + d[2] * k];
const neg = (d: Vec3): Vec3 => [-d[0], -d[1], -d[2]];

/** Drawn width and height of a section (mm). */
function extents(size: RunSize): { w: number; h: number } {
  switch (size.shape) {
    case "rect":
    case "oval":
      return { w: size.width, h: size.height };
    case "round":
      return { w: size.diameter, h: size.diameter };
    case "pipe":
      return { w: size.nominalMm, h: size.nominalMm };
    default:
      return { w: size.tradeSizeMm, h: size.tradeSizeMm };
  }
}

/** A straight run's faces: its two ends always; on a level (or pitched) run also top, bottom and both sides. */
export function runSegmentFaces(seg: RunSegment): readonly ConnectorFaceDef[] {
  const start = v(seg.start);
  const end = v(seg.end);
  const d: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 1e-6) return [];
  const axis: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  const plan = Math.hypot(axis[0], axis[1]);
  const { w, h } = extents(seg.size);
  const mid = along(start, axis, length / 2);
  const left: Vec3 = plan < 1e-6 ? [1, 0, 0] : [-axis[1] / plan, axis[0] / plan, 0];
  const ends: ConnectorFaceDef[] = [
    { id: "end_start", label: "Start", center: start, normal: neg(axis), alongDir: left, alongMm: w, acrossMm: h },
    { id: "end_end", label: "End", center: end, normal: axis, alongDir: neg(left), alongMm: w, acrossMm: h },
  ];
  if (plan < 1e-6) return ends;
  const up = cross(axis, left);
  const halfW = hostHalfWidth(seg.size);
  const halfH = hostHalfHeight(seg.size);
  const face = (id: string, label: string, normal: Vec3, offset: number, acrossMm: number): ConnectorFaceDef => ({ id, label, center: along(mid, normal, offset), normal, alongDir: axis, alongMm: length, acrossMm });
  return [
    face("top", "Top", up, halfH, w),
    face("bottom", "Bottom", neg(up), halfH, w),
    face("side_left", "Left side", left, halfW, h),
    face("side_right", "Right side", neg(left), halfW, h),
    ...ends,
  ];
}

export const RUN_SEGMENT_FACE_ROW: ConnectorFaceRow = {
  kind: "run_segment",
  label: "Straight run",
  faces: (el: BimElement) => (el.kind === "run_segment" ? runSegmentFaces(el) : []),
};

export const KERNEL_CONNECTOR_FACE_ROWS: readonly ConnectorFaceRow[] = [RUN_SEGMENT_FACE_ROW];
