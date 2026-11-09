import type { Vec2 } from "../types";

/**
 * Placement proposers (WS-G, "propose, engineer validates"). A proposer reads
 * room geometry and code-spacing rules and returns where an engineer-chosen
 * device type would go. It never picks the device type, never picks
 * equipment and never makes a circuit (US 11,087,054 design rules,
 * internal design note). Nothing is placed until the engineer
 * accepts all or some of a proposal, which is one ordinary edit.
 *
 * All lengths are millimetres in plan coordinates, as everywhere in the kernel.
 */

/** A stretch of a room's perimeter, by distance along it from the outline's first point (mm). */
export interface PerimeterSpan {
  readonly from: number;
  readonly to: number;
}

/** A gap in the wall: a door breaks wall space, a window does not (a proposer's rule decides what each kind means). */
export interface RoomOpening extends PerimeterSpan {
  readonly kind: "door" | "window" | "opening";
  readonly label: string;
}

/** A countertop or work surface footprint (plan, mm). */
export interface RoomCounter {
  readonly id: string;
  readonly label: string;
  /** Footprint corners in order; any winding. */
  readonly outline: readonly Vec2[];
}

export type FixtureKind = "basin" | "sink" | "range" | "washer" | "dryer" | "refrigerator" | "other";

/** Something in the room a proposer's rules may care about: a basin, a sink or range that splits a countertop, a washer. */
export interface RoomFixture {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly label: string;
  readonly outline: readonly Vec2[];
}

/**
 * A device already in the room that the proposer's add-on recognises as one
 * of its own (`RoomGeometryOptions.isExistingDevice`). `appliance`: it serves
 * one appliance, so spacing rules don't count it.
 */
export interface ExistingDevice {
  readonly id: string;
  readonly position: Vec2;
  readonly appliance: boolean;
  readonly label: string;
}

/** What a proposer needs to know about one room, wherever it came from (`roomGeometriesFromModel`). */
export interface RoomGeometry {
  /** Our room's element id, or `linked:<model>:<GlobalId>` for a linked model's space. */
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly source: "model" | "linked" | "outline";
  /** Counter-clockwise outline at the wall faces (the floor line). */
  readonly outline: readonly Vec2[];
  readonly openings: readonly RoomOpening[];
  readonly counters: readonly RoomCounter[];
  readonly fixtures: readonly RoomFixture[];
  readonly existing: readonly ExistingDevice[];
}
