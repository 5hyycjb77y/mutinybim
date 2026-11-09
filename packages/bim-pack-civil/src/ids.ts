/**
 * Every id the civil pack stores or contributes. All are `civil.<name>`
 * (the pack contract's namespace rule); none is ever renamed once a model
 * stores it.
 */

export const CIVIL_PACK_ID = "civil";

export const CIVIL_CLASS = {
  stormInlet: "civil.storm_inlet",
  manhole: "civil.manhole",
  outfall: "civil.outfall",
  stormPipe: "civil.storm_pipe",
  stormSystem: "civil.storm_system",
  alignment: "civil.alignment",
  catchment: "civil.catchment",
} as const;
export type CivilClassId = (typeof CIVIL_CLASS)[keyof typeof CIVIL_CLASS];

/** Classes of the parts a storm network joins at (the network's nodes). */
export const STRUCTURE_CLASSES: readonly CivilClassId[] = [CIVIL_CLASS.stormInlet, CIVIL_CLASS.manhole, CIVIL_CLASS.outfall];

/** The storm service row: what a storm pipe system carries. */
export const CIVIL_STORM_SERVICE = "civil.storm";
/** The network adapter the storm service row names. */
export const CIVIL_STORM_ADAPTER = "civil.storm_network";
/** The quantity the storm network totals, m³/s per node. */
export const CIVIL_RUNOFF = "civil.runoff";
/** The pack's reinforced concrete pipe material (kernel tables treat it as `pe`). */
export const CIVIL_RCP = "civil.rcp";

/**
 * Pack parameters (`PARAMETER_SET_POINT`), stored in the element's `values`
 * in the unit `parameters.ts` names for each.
 */
export const CIVIL_PARAM = {
  /** Structures: top of the cover or grate, model elevation, mm. */
  rimElevation: "civil.rim_elevation",
  /** Structures: lowest flowline, model elevation, mm. */
  invertElevation: "civil.invert_elevation",
  /** Inlets: what the grate takes in, cfs. */
  inletCapacity: "civil.inlet_capacity",
  /** Catchment zones: surface type, a key of `RUNOFF_COEFFICIENTS`. */
  surface: "civil.surface",
  /** Catchment zones: rational-method C typed by the engineer; wins over `surface`. */
  runoffCoefficient: "civil.runoff_coefficient",
  /** Storm systems: the design rainfall intensity, in/h. */
  designIntensity: "civil.design_intensity",
  /** Storm systems: the least slope a pipe may run at, %. */
  minSlope: "civil.min_slope",
  /** Storm pipes: Manning's n typed for this pipe; wins over its material's. */
  manningN: "civil.manning_n",
} as const;
