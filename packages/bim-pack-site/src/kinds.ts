import type { ElementKindItem, ElementKindValue } from "@permitzip/bim-pack/runtime";
import { SITE_KIND, SITE_VALUE } from "./ids";

/**
 * The Site add-on's record kinds: what is known about the land before
 * anything is drawn (round 11, D3). Both are intent records (`nature:
 * "intent"`): values and no geometry, so no shape, no connector ends and no
 * plan position. Where a constraint is drawn later, it is a drawn element
 * that cites the constraint; the constraint itself stays a record.
 *
 * Distances are stored in metres and areas in square metres (bim-units
 * codes); screens show the reader's units.
 */

/** A value kept as words, with no unit. */
const text = (key: string, label: string): ElementKindValue => ({ key, label, unit: "", authored: true });

export const SITE_CONSTRAINT_ROW: ElementKindItem = {
  kind: SITE_KIND.constraint,
  label: "Site constraint",
  nature: "intent",
  values: [
    text(SITE_VALUE.constraintType, "Constraint"),
    text(SITE_VALUE.parcelId, "Parcel"),
    { key: SITE_VALUE.distance, label: "Distance", unit: "m", authored: true, min: 0 },
    text(SITE_VALUE.side, "Measured from"),
    { key: SITE_VALUE.elevation, label: "Elevation", unit: "m", authored: true },
    { key: SITE_VALUE.capacity, label: "Available capacity", unit: "", authored: true, min: 0 },
    text(SITE_VALUE.capacityUnit, "Capacity unit"),
    text(SITE_VALUE.findingRef, "Finding"),
  ],
  upgrade: { newForOlderPeers: true },
};

export const SITE_PARCEL_ROW: ElementKindItem = {
  kind: SITE_KIND.parcel,
  label: "Parcel",
  nature: "intent",
  values: [
    text(SITE_VALUE.parcelNumber, "Parcel number"),
    { key: SITE_VALUE.area, label: "Area", unit: "m2", authored: true, min: 0 },
    text(SITE_VALUE.zoning, "Zoning district"),
  ],
  upgrade: { newForOlderPeers: true },
};

export const SITE_KIND_ROWS: readonly ElementKindItem[] = [SITE_CONSTRAINT_ROW, SITE_PARCEL_ROW];
