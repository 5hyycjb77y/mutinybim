import { add as kernelAdd, perp, scale as kernelScale, sub as kernelSub, unit as kernelUnit, type ElementBase, type ElementId, type Profile, type Vec2 } from "@permitzip/bim-kernel";

/**
 * The TypeScript shapes of the Mechanical add-on's kinds (unit, duct, tap,
 * elbow, air terminal), moved out of the kernel's `types.ts` in round 13
 * (K13 step 1.5). Stored records are unchanged; the kernel's union reaches
 * them through `AddOnElementTypes` (declared below), so code that narrows on
 * `kind` keeps working while Mechanical is in the build.
 */

const add = kernelAdd;
const scale = kernelScale;
const sub = kernelSub;
const unit = kernelUnit;

export interface Equipment extends ElementBase {
  readonly kind: "equipment";
  readonly mark: string;
  readonly typeName: string;
  /** Centre of the unit. Authored. */
  readonly position: Vec2;
  readonly size: Vec2;
  /** Supply port location relative to `position`. */
  readonly portOffset: Vec2;
  /** Stored form before contract 1.7.0. Read `airflowOf`. */
  readonly totalCfm?: number;
}

export interface DuctSegment extends ElementBase {
  readonly kind: "duct_segment";
  readonly start: Vec2;
  readonly end: Vec2;
  /** Authored. */
  readonly profile: Profile;
  /** Stored form before contract 1.7.0. Read `airflowOf`. */
  readonly flowCfm?: number;
}

export interface TapFitting extends ElementBase {
  readonly kind: "tap";
  readonly hostId: ElementId;
  /** Authored: distance along the host centreline from its start. */
  readonly s: number;
  /** Which side of the host the branch leaves from (+1 left of travel, -1 right). */
  readonly side: 1 | -1;
  readonly profile: Profile;
  /** Derived: world position of the branch connector on the host face. */
  readonly position: Vec2;
}

export interface Elbow extends ElementBase {
  readonly kind: "elbow";
  readonly position: Vec2;
  readonly profile: Profile;
}

export interface Terminal extends ElementBase {
  readonly kind: "terminal";
  readonly mark: string;
  readonly typeName: string;
  readonly position: Vec2;
  /** Anchored terminals never move to satisfy someone else's edit. */
  readonly anchored: boolean;
  /** Stored form before contract 1.7.0. Read `airflowOf`. */
  readonly cfm?: number;
}

/**
 * The five connected-network kinds stored models have held since round 1.
 * Their connector ends, where each end sits, where the element sits and their
 * stored shape are the owning add-on's kind rows (`ELEMENT_KIND_POINT`); the
 * network index, topology and `anchorOf` read those rows.
 */
export type NetworkElement = Equipment | DuctSegment | TapFitting | Elbow | Terminal;

declare module "@permitzip/bim-kernel/types" {
  interface AddOnElementTypes {
    equipment: Equipment;
    duct_segment: DuctSegment;
    tap: TapFitting;
    elbow: Elbow;
    terminal: Terminal;
  }
}

/** World position of a tap's branch connector given its host and `s`. */
export function tapPosition(host: DuctSegment, tap: Pick<TapFitting, "s" | "side">): Vec2 {
  const axis = unit(sub(host.end, host.start));
  const onCentre = add(host.start, scale(axis, tap.s));
  const halfWidth = hostHalfWidth(host);
  return add(onCentre, scale(perp(axis), halfWidth * tap.side));
}

function hostHalfWidth(host: DuctSegment): number {
  return host.profile.shape === "rect" ? host.profile.width / 2 : host.profile.diameter / 2;
}

export function segmentLength(seg: DuctSegment): number {
  return Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
}
