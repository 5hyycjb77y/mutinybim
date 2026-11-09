/** The Site add-on's namespace: every id it contributes is `site.<name>`. Stored forever. */
export const SITE_PACK_ID = "site";

/** Its record kinds (intent: values, no geometry). */
export const SITE_KIND = {
  constraint: "site.constraint",
  parcel: "site.parcel",
} as const;

/** The values its records keep, by parameter key. */
export const SITE_VALUE = {
  /** What the constraint is (`SITE_CONSTRAINT_TYPES`). Text. */
  constraintType: "site.constraint_type",
  /** The parcel it binds (a `site.parcel` id). Text. */
  parcelId: "site.parcel_id",
  /** A setback, easement width or buffer distance, metres. */
  distance: "site.distance",
  /** Which side of the parcel a setback is measured from (`front`, `side`, `rear`). Text. */
  side: "site.side",
  /** A flood zone's design flood elevation or a height limit, metres. */
  elevation: "site.elevation",
  /** A utility's available capacity, in the unit named by `capacityUnit`. */
  capacity: "site.capacity",
  capacityUnit: "site.capacity_unit",
  /** An environmental finding's reference (a report and its finding number). Text. */
  findingRef: "site.finding_ref",
  /** A parcel's area, square metres. */
  area: "site.area",
  /** A parcel's identifier as the land record names it. Text. */
  parcelNumber: "site.parcel_number",
  /** The zoning district, as the jurisdiction names it. Text. */
  zoning: "site.zoning",
} as const;

/** The constraint types this release names. Open: a stored type it doesn't know is kept and shown as written. */
export const SITE_CONSTRAINT_TYPES = ["setback", "easement", "flood_zone", "environmental_finding", "utility_capacity", "height_limit"] as const;
