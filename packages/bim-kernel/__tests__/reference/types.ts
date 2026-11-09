// Frozen copy of src/types.ts before full-BIM kinds were added: the reference kernel keeps the
// duct-only element union it was written against.
/**
 * MutinyBIM domain model. All lengths are millimetres in plan coordinates
 * (x east, y north). Identity is stable and never derived from geometry.
 */

export type ElementId = string & { readonly __brand: "ElementId" };
export type ConnectionId = string & { readonly __brand: "ConnectionId" };
export type Revision = number & { readonly __brand: "Revision" };
export type ActorId = string & { readonly __brand: "ActorId" };

export const asElementId = (value: string): ElementId => value as ElementId;
export const asConnectionId = (value: string): ConnectionId => value as ConnectionId;
export const asRevision = (value: number): Revision => value as Revision;
export const asActorId = (value: string): ActorId => value as ActorId;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type SystemClass = "supply" | "return" | "exhaust";

export interface RectProfile {
  readonly shape: "rect";
  readonly width: number;
  readonly height: number;
}

export interface RoundProfile {
  readonly shape: "round";
  readonly diameter: number;
}

export type Profile = RectProfile | RoundProfile;

/** Revision at which each authored field was last explicitly set. */
export type AuthoredRevisions = Readonly<Record<string, number>>;

interface ElementBase {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly systemClass: SystemClass;
}

export interface Equipment extends ElementBase {
  readonly kind: "equipment";
  readonly mark: string;
  readonly typeName: string;
  /** Centre of the unit. Authored. */
  readonly position: Vec2;
  readonly size: Vec2;
  /** Supply port location relative to `position`. */
  readonly portOffset: Vec2;
  /** Derived: total airflow served. */
  readonly totalCfm: number;
}

export interface DuctSegment extends ElementBase {
  readonly kind: "duct_segment";
  readonly start: Vec2;
  readonly end: Vec2;
  /** Authored. */
  readonly profile: Profile;
  /** Derived: airflow carried. */
  readonly flowCfm: number;
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
  /** Authored design airflow. */
  readonly cfm: number;
  /** Anchored terminals never move to satisfy someone else's edit. */
  readonly anchored: boolean;
}

export type BimElement = Equipment | DuctSegment | TapFitting | Elbow | Terminal;
export type ElementKind = BimElement["kind"];

/** Named connector ends per element kind. */
export type ConnectorEnd = "start" | "end" | "in" | "out" | "host" | "branch";

export interface ConnectorRef {
  readonly elementId: ElementId;
  readonly end: ConnectorEnd;
}

export interface Connection {
  readonly id: ConnectionId;
  readonly a: ConnectorRef;
  readonly b: ConnectorRef;
}

export interface ModelState {
  readonly modelId: string;
  readonly revision: Revision;
  readonly elements: Readonly<Record<string, BimElement>>;
  readonly connections: readonly Connection[];
  readonly settings: ModelSettings;
}

export interface ModelSettings {
  /** Minimum straight length of any duct segment. */
  readonly minStraightMm: number;
  /** Clearance from a host end to a tap centreline. */
  readonly tapEndClearanceMm: number;
  /** Minimum centre-to-centre spacing of taps on one host. */
  readonly minTapSpacingMm: number;
  /** Connector coincidence tolerance. */
  readonly connectorToleranceMm: number;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  minStraightMm: 150,
  tapEndClearanceMm: 300,
  minTapSpacingMm: 600,
  connectorToleranceMm: 0.5,
};
