import { faceOfSide, pointOnFace, type BimElement, type ConnectorFaceDef, type ConnectorFaceRow, type Vec2, type Vec3 } from "@permitzip/bim-kernel";
import type { DuctSegment, TapFitting } from "../types";

/**
 * Mechanical's connector face rows (`kernel.connector_face`): a round-1 duct
 * segment (plan-only, its centreline at height 0) lists top, bottom, both
 * sides and both ends from its profile, so a tap's place reads as a face of
 * its host like any other branch's. A stored `{ s, side }` tap reads as
 * `side_left` / `side_right`; its point is the one `tapPosition` gave.
 */

const neg = (d: Vec3): Vec3 => [-d[0], -d[1], -d[2]];
const at = (o: Vec3, d: Vec3, k: number): Vec3 => [o[0] + d[0] * k, o[1] + d[1] * k, o[2] + d[2] * k];

export function ductSegmentFaces(seg: DuctSegment): readonly ConnectorFaceDef[] {
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return [];
  const axis: Vec3 = [dx / length, dy / length, 0];
  const left: Vec3 = [-axis[1], axis[0], 0];
  const up: Vec3 = [0, 0, 1];
  const w = seg.profile.shape === "rect" ? seg.profile.width : seg.profile.diameter;
  const h = seg.profile.shape === "rect" ? seg.profile.height : seg.profile.diameter;
  const start: Vec3 = [seg.start.x, seg.start.y, 0];
  const mid = at(start, axis, length / 2);
  const face = (id: string, label: string, normal: Vec3, offset: number, acrossMm: number): ConnectorFaceDef => ({ id, label, center: at(mid, normal, offset), normal, alongDir: axis, alongMm: length, acrossMm });
  return [
    face("top", "Top", up, h / 2, w),
    face("bottom", "Bottom", neg(up), h / 2, w),
    face("side_left", "Left side", left, w / 2, h),
    face("side_right", "Right side", neg(left), w / 2, h),
    { id: "end_start", label: "Start", center: start, normal: neg(axis), alongDir: left, alongMm: w, acrossMm: h },
    { id: "end_end", label: "End", center: [seg.end.x, seg.end.y, 0], normal: axis, alongDir: neg(left), alongMm: w, acrossMm: h },
  ];
}

export const DUCT_SEGMENT_FACE_ROW: ConnectorFaceRow = {
  kind: "duct_segment",
  label: "Duct segment",
  faces: (el: BimElement) => (el.kind === "duct_segment" ? ductSegmentFaces(el) : []),
};

export const MECHANICAL_CONNECTOR_FACE_ROWS: readonly ConnectorFaceRow[] = [DUCT_SEGMENT_FACE_ROW];

/** The face a stored tap sits on: its side's (round-1 taps only ever take a side). */
export function tapFaceOf(tap: Pick<TapFitting, "side">): string {
  return faceOfSide(tap.side);
}

/** Where a tap's branch connector sits on `face` of its host, `s` along and `t` across (model mm; `t` 0 is the face's centre line). Null off the face. */
export function tapPointOnFace(host: DuctSegment, face: string, s: number, t = 0): Vec3 | null {
  const def = ductSegmentFaces(host).find((f) => f.id === face);
  return def ? pointOnFace(def, s, t) : null;
}

/** `tapPosition` read through the faces: the same plan point for a side tap. */
export function tapPlanPosition(host: DuctSegment, tap: Pick<TapFitting, "s" | "side">): Vec2 | null {
  const p = tapPointOnFace(host, tapFaceOf(tap), tap.s);
  return p ? { x: p[0], y: p[1] } : null;
}

/**
 * Mechanical's tap by face: a branch off a duct's top rises from it, one off
 * its bottom drops (to a diffuser or a lower run), a side tap stays level.
 * The fitting keeps its family (conical, straight, shoe); the face adds which
 * way the branch leaves and the word for it.
 */
export interface TapFaceRule {
  readonly face: string;
  /** +1 the branch leaves upward, -1 downward. */
  readonly direction: 1 | -1;
  /** As printed after the fitting's name ("Conical tap, rise from the top"). */
  readonly words: string;
}

export const MECHANICAL_TAP_FACE_RULES: readonly TapFaceRule[] = [
  { face: "top", direction: 1, words: "rise from the top" },
  { face: "bottom", direction: -1, words: "drop from the bottom" },
];

/** The rule for a face; null on a side or an end (a level tap). */
export function tapFaceRule(face: string | undefined, rules: readonly TapFaceRule[] = MECHANICAL_TAP_FACE_RULES): TapFaceRule | null {
  return face === undefined ? null : (rules.find((r) => r.face === face) ?? null);
}

/** A tap's name with its face: "Conical tap, rise from the top"; a side tap keeps its name. */
export function tapLabelOnFace(label: string, face: string | undefined, rules: readonly TapFaceRule[] = MECHANICAL_TAP_FACE_RULES): string {
  const rule = tapFaceRule(face, rules);
  return rule ? `${label}, ${rule.words}` : label;
}
