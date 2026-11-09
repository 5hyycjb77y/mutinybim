import type { ClassDiscipline } from "../registry/types";

/**
 * The service registry contract (KERNEL-FOUNDATION §3.5): one list of what
 * flows (power, water, air, gas, waste, sprinkler water…). The connector
 * domains, the system kinds and the load services are views of it; their
 * strings are row ids and are never renamed (MIGRATION-PLAN §1.3).
 *
 * Every field here is plain data, so a firm or a later trade adds a service
 * as a library row with no code change. This file is the frozen shape;
 * additions are optional fields only.
 */

/** A service row id: today's system kind or load service string, or `firm:<slug>`. */
export type ServiceId = string;

/*
 * Medium, regime and connector are open: a later discipline (egress, open
 * channels, structural analysis links) adds a value as data. Readers treat a
 * value outside the KNOWN_* lists as "listed, not walked", like an absent
 * `adapter`.
 */
export const KNOWN_SERVICE_MEDIUMS = ["air", "liquid", "gas", "electric", "data", "signal", "structural", "none"] as const;
export type ServiceMedium = (typeof KNOWN_SERVICE_MEDIUMS)[number] | (string & {});

/** How the network solves it: pressure (water, air, gas), gravity (drains, storm), electric, structural load path, signal. */
export const KNOWN_SERVICE_REGIMES = ["pressure", "gravity", "electric", "structural", "signal"] as const;
export type ServiceRegime = (typeof KNOWN_SERVICE_REGIMES)[number] | (string & {});

/** What a port carrying it connects to. `duct`, `pipe` and `electrical` are today's connector domains. */
export const KNOWN_SERVICE_CONNECTORS = ["duct", "pipe", "electrical", "member", "none"] as const;
export type ServiceConnector = (typeof KNOWN_SERVICE_CONNECTORS)[number] | (string & {});

/**
 * The registered network adapter that aggregates, sizes and checks it
 * (connections/model.ts): one of this release's three, or a pack's
 * `<pack>.<name>`. Readers keep any stored string; a row naming an adapter
 * nobody registered is listed, not walked. (No bare word is reserved for a
 * trade nobody ships: fire protection, structure and civil come as packs.)
 */
export type ServiceAdapterId = "electrical" | "plumbing" | "mechanical" | (string & {});

export interface ServiceIfc {
  readonly system: "IfcDistributionSystem" | "IfcBuiltSystem" | "IfcStructuralAnalysisModel";
  /** `IfcDistributionSystemEnum` member, or USERDEFINED with `objectType`. */
  readonly predefinedType: string;
  readonly objectType?: string;
}

/** A service's default line look, read by system graphics and the category registry. Same vocabulary as `routing/system-graphics.ts`. */
export interface ServiceLineStyle {
  /** `#rrggbb`. */
  readonly colour: string;
  /** A `SystemLinePattern`. */
  readonly pattern: string;
  /** A `SystemLineWeight`; absent: the drawing's own pens. */
  readonly weight?: string;
}

export interface ServiceDef {
  readonly id: ServiceId;
  /** What a person reads in pickers and schedules ("Grease waste"). */
  readonly label: string;
  readonly discipline: ClassDiscipline;
  readonly medium: ServiceMedium;
  readonly regime: ServiceRegime;
  readonly connector: ServiceConnector;
  /** Absent: no network adapter yet (the service is listed, not walked). */
  readonly adapter?: ServiceAdapterId;
  /** Parameter keys that aggregate along it (`load.va`, `load.dfu`, `load.wsfu`, `load.cfm`, `load.mbh`). */
  readonly quantities: readonly string[];
  /** A drawn system (an `mep_system`, a connector) can carry it: it is in the system kind view. */
  readonly asSystem: boolean;
  /** A load record can need it: it is in the load service view. */
  readonly asLoad: boolean;
  /** A load-service row carried by a system row of another id (`cold_water` by `domestic_cold_water`). */
  readonly carriedBy?: ServiceId;
  readonly ifc: ServiceIfc;
  readonly graphics?: ServiceLineStyle;
  /**
   * The protocol feature a peer must advertise before a writer emits this
   * row (MIGRATION-PLAN §3). Absent: every peer reads it (today's rows).
   */
  readonly feature?: string;
  /** Source node roles that serve it ("water_heater" serves domestic hot water; a grease interceptor serves sanitary and grease waste). */
  readonly sourceRoles?: readonly string[];
  /**
   * The adapter's method id (`hunter`, `dfu`, `gas_longest_length`; later
   * `hazen_williams`). Open string; the adapter interprets it. The flow unit is
   * not stored: it is the unit of the parameter `quantities[0]` names.
   */
  readonly solver?: string;
}

/** The protocol feature for rows added by the service registry (grease and indirect waste, fire protection, chilled and heating water). */
export const SERVICES_REGISTRY_FEATURE = "services:registry";

/** Service links carry `adapter` and per-adapter `design` (connections/types.ts); writers emit them only to peers advertising this. */
export const LINKS_DESIGN_FEATURE = "links:design";

/** Part-type connectors carry `values` keyed by parameter keys (bowl dimensions, an air gap); writers emit them only to peers advertising this. */
export const PARTS_CONNECTOR_VALUES_FEATURE = "parts:connector_values";

/** Peers that store an end type on a part connector (round 9 J9). A writer adds or changes one only when the peers advertise it. */
export const CONNECTOR_END_TYPES_FEATURE = "parts:connector_end_types";
