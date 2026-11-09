import { paramValue, resolveConnectors, serviceLabel, systemKindsWithAdapter, type BimElement, type MemberCandidate, type PartInstance, type SourceInfo, type TradeAdapter } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Air on the shared served-from model (connections/adapter.ts), beside
 * electrical and plumbing: which parts are air sources, so a diffuser, a
 * grille or a piece of equipment can name what serves it before any duct is
 * drawn ("S-1 is served by RTU-1", "the hood's exhaust by EF-2").
 *
 * The services it carries are the service registry's rows registered to the
 * mechanical adapter (supply, return, exhaust and outside air); nothing here
 * names one. A part is an air source when its type says so (`air_source`), or
 * it is mechanical equipment with a duct connection on one of those services
 * (an air handler, rooftop unit, fan or ERV). A source serves the services
 * its own duct connections carry: an exhaust fan serves exhaust, not supply.
 */

export const AIR_SOURCE_ROLES = ["air_handler", "rooftop_unit", "fan", "erv"] as const;
export type AirSourceRole = (typeof AIR_SOURCE_ROLES)[number];

const ROLE_WORDS: Readonly<Record<AirSourceRole, string>> = { air_handler: "air handler", rooftop_unit: "rooftop unit", fan: "fan", erv: "energy recovery unit" };

function airServices(): ReadonlySet<string> {
  return new Set(systemKindsWithAdapter("mechanical"));
}

function typeOf(elements: Elements, part: PartInstance) {
  const type = elements[part.typeId];
  return type?.kind === "part_type" ? type.definition : null;
}

interface AirConnector {
  readonly id: string;
  readonly systemKind: string;
  readonly out: boolean;
}

function airConnectors(elements: Elements, part: PartInstance): AirConnector[] {
  const def = typeOf(elements, part);
  if (!def) return [];
  const air = airServices();
  return resolveConnectors(def, part.values)
    .filter((c) => c.domain === "duct" && air.has(c.systemKind))
    .map((c) => ({ id: c.id, systemKind: c.systemKind, out: def.connectors.find((d) => d.id === c.id)?.flowDirection === "out" }));
}

function isRole(v: unknown): v is AirSourceRole {
  return typeof v === "string" && (AIR_SOURCE_ROLES as readonly string[]).includes(v);
}

/** The part's air source role, or null when it serves no air. Explicit `air_source` first, then mechanical equipment with an air duct connection. */
export function airSourceRole(elements: Elements, part: PartInstance): AirSourceRole | "equipment" | null {
  const def = typeOf(elements, part);
  if (!def) return null;
  const explicit = paramValue(def, part.values, "air_source");
  if (isRole(explicit)) return explicit;
  if (def.category !== "mechanical_equipment") return null;
  return airConnectors(elements, part).length > 0 ? "equipment" : null;
}

function name(part: PartInstance): string {
  return part.mark || part.id;
}

export const mechanicalAdapter: TradeAdapter = {
  trade: "mechanical",

  source(elements, part): SourceInfo | null {
    if (!airSourceRole(elements, part)) return null;
    const connectors = airConnectors(elements, part);
    const out = connectors.find((c) => c.out) ?? connectors[0];
    return { name: name(part), port: out?.id ?? "out", spaces: "none", input: null };
  },

  connectors(elements, part) {
    return airConnectors(elements, part).map((c) => c.id);
  },

  positionsNeeded() {
    return null;
  },

  refusal(elements, source, _positions, member: MemberCandidate) {
    const role = airSourceRole(elements, source);
    if (!role) return `${name(source)} is not an air handler, rooftop unit, fan or energy recovery unit, so no air can be served from it`;
    const kind = airConnectors(elements, member.part).find((c) => c.id === member.connector)?.systemKind ?? null;
    if (kind === null) return null;
    const offers = new Set(airConnectors(elements, source).map((c) => c.systemKind));
    if (offers.has(kind)) return null;
    const what = role === "equipment" ? name(source) : `${name(source)} (${ROLE_WORDS[role]})`;
    return `${what} has no ${serviceLabel(kind).toLowerCase()} connection, so it can't serve ${name(member.part)}'s ${member.connector}`;
  },

  positionsRefusal(_elements, source, positions) {
    return positions.length > 0 ? `${name(source)} has no numbered positions; what it serves takes none` : null;
  },
};
