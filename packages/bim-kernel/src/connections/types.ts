import type { ServiceAdapterId } from "../services/types";
import type { ElementId, ModelElementBase } from "../types";

/**
 * Served-from links: who is fed from what, independent of anything drawn.
 *
 * A link has one source (an element, a port on it and, for sources with
 * numbered positions such as panel slots, the positions it occupies) and the
 * member connectors it serves. Both ends hold the link: the source lists it in
 * `feeds`, each member names it in `served` against its connector, so an edit
 * reads and writes only what it touches. A drawn run may realise a link
 * (`realizedBy`), but the link is the truth.
 *
 * Electrical is the first trade: a branch circuit is a link from panel slots to
 * device connectors, a feeder is a link from a breaker to another piece of
 * distribution equipment. Plumbing and mechanical use the same shape
 * (CONNECTIONS.md).
 */

export const SERVICE_TRADES = ["electrical", "plumbing", "mechanical"] as const;
export type ServiceTrade = (typeof SERVICE_TRADES)[number];

/** branch: serves loads. feeder: serves another source (a panel, a transformer). */
export const SERVICE_ROLES = ["branch", "feeder"] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

export interface ServiceEnd {
  readonly elementId: ElementId;
  /** The member's connector the link serves. */
  readonly connector: string;
}

export interface ServiceSource {
  readonly elementId: ElementId;
  /** Which output of the source: "bus" for a panel or switchboard, "secondary" for a transformer. */
  readonly port: string;
  /** Numbered positions occupied (panel slots, one per pole). Empty when the source has none. */
  readonly positions: readonly number[];
}

export const CONDUCTOR_MATERIALS = ["cu", "al"] as const;
export type ConductorMaterial = (typeof CONDUCTOR_MATERIALS)[number];

/** A conductor set chosen by the engineer: sizes as written on drawings ("12", "1/0", "250"). */
export interface ConductorSet {
  readonly sets: number;
  readonly phaseSize: string;
  readonly neutralSize?: string;
  readonly groundSize?: string;
  readonly material: ConductorMaterial;
}

/** Electrical design fields of a branch circuit or feeder. Loads come from the members, never from here. */
export interface ElectricalLinkDesign {
  /** Overcurrent device trip rating, amps. Absent: no device (a transformer secondary to its panel's main). */
  readonly ratingA?: number;
  readonly frameA?: number;
  /** Load class for every member, overriding what the members say. */
  readonly loadClass?: string;
  /** Conductors chosen for this link (voltage-drop upsizing, parallel sets), instead of the default for the rating. */
  readonly conductors?: ConductorSet;
  /** One-way length for voltage drop. */
  readonly lengthFt?: number;
  /** Feeder type mark from the feeder catalog ("F225"). */
  readonly feederType?: string;
}

export interface ServiceLink extends ModelElementBase {
  readonly kind: "service_link";
  readonly trade: ServiceTrade;
  readonly role: ServiceRole;
  readonly source: ServiceSource;
  /** In the order the engineer added them. Feeders have exactly one. */
  readonly members: readonly ServiceEnd[];
  readonly description: string;
  /** Drawn runs (conduit, pipe) that realise this link, if any. */
  readonly realizedBy?: readonly ElementId[];
  /** Legacy home of the electrical design; read through `linkDesign(link, "electrical")`, which also finds `design.electrical`. */
  readonly electrical?: ElectricalLinkDesign;
  /**
   * The service registry's adapter id this link belongs to (`electrical`,
   * `plumbing`, a pack's `fa`). Absent: `trade`, the legacy alias. Readers use
   * `linkAdapterId`. Written only to peers advertising `links:design`.
   */
  readonly adapter?: ServiceAdapterId;
  /**
   * Design data keyed by adapter id (`design.electrical`, `design.plumbing`),
   * each validated by its adapter. New link design goes here, never into new
   * top-level fields. Written only to peers advertising `links:design`.
   */
  readonly design?: Readonly<Record<string, unknown>>;
}

/*
 * Readers of a stored link tolerate any trade, adapter and role string: a
 * newer peer's or a pack's link (`adapter: "fa"`, `role: "slc_loop"`) loads,
 * round-trips and is simply not walked by an adapter this release lacks.
 */

/** The adapter a stored link belongs to: `adapter`, else its legacy `trade`. */
export function linkAdapterId(link: Pick<ServiceLink, "trade" | "adapter">): ServiceAdapterId {
  return link.adapter ?? link.trade;
}

/** A link's design for one adapter: `design[adapterId]`, and for electrical the legacy top-level `electrical` too (design wins). */
export function linkDesign(link: Pick<ServiceLink, "design" | "electrical">, adapterId: ServiceAdapterId): unknown {
  const inDesign = link.design?.[adapterId];
  if (inDesign !== undefined) return inDesign;
  return adapterId === "electrical" ? link.electrical : undefined;
}

/** Whether a stored role is one this release's writers use. Readers keep any other role as stored. */
export function isKnownServiceRole(role: string): role is ServiceRole {
  return (SERVICE_ROLES as readonly string[]).includes(role);
}

/** Whether a stored trade is one this release's writers use. */
export function isKnownServiceTrade(trade: string): trade is ServiceTrade {
  return (SERVICE_TRADES as readonly string[]).includes(trade);
}

/**
 * The link as a peer without `links:design` stores it: no `adapter`, the
 * electrical design back at top level. A string when it can't be said in the
 * old shape (a pack adapter, or design for another adapter), in plain words.
 */
export function legacyLinkShape(link: ServiceLink): ServiceLink | string {
  if (link.adapter === undefined && link.design === undefined) return link;
  const adapter = linkAdapterId(link);
  if (adapter !== link.trade) return `This ${link.role.replace(/_/g, " ")} belongs to ${adapter}, which the model server this model is open on can't store yet; try again once the server is updated`;
  const others = Object.keys(link.design ?? {}).filter((k) => k !== "electrical");
  if (others.length > 0) return `This link's ${others.join(", ")} design can't be saved yet: the model server this model is open on is an older version; try again once the server is updated`;
  const { adapter: _a, design, ...rest } = link;
  const electrical = design?.electrical;
  if (electrical === undefined) return rest;
  if (!isElectricalLinkDesign(electrical)) return "This link's electrical design isn't in a shape the model server can store";
  return { ...rest, electrical };
}

function isElectricalLinkDesign(v: unknown): v is ElectricalLinkDesign {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
