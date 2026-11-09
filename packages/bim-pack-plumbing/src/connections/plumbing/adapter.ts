import { activeServiceRegistry, paramValue, resolveConnectors, systemKindsServedBy, systemKindsWithAdapter, runNeighbours } from "@permitzip/bim-kernel";
import type { BimElement, ElementId, PartInstance, MemberCandidate, ServiceRegistry, SourceInfo, TradeAdapter } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Plumbing and gas on the shared served-from model (connections/adapter.ts):
 * which parts are sources, so a load (or a fixture) can name its source before
 * any pipe is drawn: "this fixture is served by WH-1", "by the gas meter", "by
 * GI-1". Once piped, the drawn network is checked against the named source.
 *
 * A part is a plumbing source when its type says so (`plumbing_source`: a firm
 * type), or it is one of the starter types that are: a water heater (it has a
 * `heater_kind`), a water meter (MTR), a grease interceptor (GI) or a gas
 * pressure regulator (GR, the service regulator at the meter).
 */

export type PlumbingSourceRole = "water_heater" | "water_meter" | "gas_meter" | "grease_interceptor" | "sewer_connection" | "sewage_pump" | "backwater_valve";

const STARTER_ROLES: Readonly<Record<string, PlumbingSourceRole>> = { MTR: "water_meter", GI: "grease_interceptor", GR: "gas_meter" };
const ROLE_WORDS: Readonly<Record<PlumbingSourceRole, string>> = { water_heater: "water heater", water_meter: "water meter", gas_meter: "gas meter", grease_interceptor: "grease interceptor", sewer_connection: "sewer connection", sewage_pump: "sewage pump", backwater_valve: "backwater valve" };
const ROLE_SERVES_BY_REGISTRY = new WeakMap<ServiceRegistry, Readonly<Record<PlumbingSourceRole, readonly string[]>>>();

/** What a source role serves, from the registry in force's `sourceRoles` (a grease interceptor: sanitary and grease waste). Read when asked: the rows arrive with the add-ons, after this module loads. */
function roleServes(role: PlumbingSourceRole): readonly string[] {
  const registry = activeServiceRegistry();
  let table = ROLE_SERVES_BY_REGISTRY.get(registry);
  if (!table) {
    table = {
      water_heater: systemKindsServedBy("water_heater", registry),
      water_meter: systemKindsServedBy("water_meter", registry),
      gas_meter: systemKindsServedBy("gas_meter", registry),
      grease_interceptor: systemKindsServedBy("grease_interceptor", registry),
      sewer_connection: systemKindsServedBy("sewer_connection", registry),
      sewage_pump: systemKindsServedBy("sewage_pump", registry),
      backwater_valve: systemKindsServedBy("backwater_valve", registry),
    };
    ROLE_SERVES_BY_REGISTRY.set(registry, table);
  }
  return table[role];
}
/** The piped services this adapter serves: every system row registered to the plumbing adapter. */
const PIPED_SETS = new WeakMap<readonly string[], ReadonlySet<string>>();

/** The piped kinds of the registry in force (read when asked: the rows arrive with the add-ons, after this module loads). */
function pipedKinds(): ReadonlySet<string> {
  const kinds = systemKindsWithAdapter("plumbing");
  let set = PIPED_SETS.get(kinds);
  if (!set) PIPED_SETS.set(kinds, (set = new Set(kinds)));
  return set;
}

function typeOf(elements: Elements, part: PartInstance) {
  const type = elements[part.typeId];
  return type?.kind === "part_type" ? type.definition : null;
}

export function plumbingSourceRole(elements: Elements, part: PartInstance): PlumbingSourceRole | null {
  const def = typeOf(elements, part);
  if (!def) return null;
  const explicit = paramValue(def, part.values, "plumbing_source");
  if (explicit === "water_heater" || explicit === "water_meter" || explicit === "gas_meter" || explicit === "grease_interceptor") return explicit;
  const drainage = paramValue(def, part.values, "drainage_role");
  if (drainage === "sewer_connection" || drainage === "sewage_pump" || drainage === "backwater_valve") return drainage;
  const heater = paramValue(def, part.values, "heater_kind");
  if (typeof heater === "string" && heater.trim() !== "") return "water_heater";
  const starter = def.typeValues.default_connection_type;
  return typeof starter === "string" ? (STARTER_ROLES[starter.trim().toUpperCase()] ?? null) : null;
}

function pipeConnectors(elements: Elements, part: PartInstance): Array<{ id: string; systemKind: string | null }> {
  const def = typeOf(elements, part);
  if (!def) return [];
  return resolveConnectors(def, part.values)
    .filter((c) => c.systemKind !== undefined && c.systemKind !== null && pipedKinds().has(c.systemKind))
    .map((c) => ({ id: c.id, systemKind: c.systemKind ?? null }));
}

export const plumbingAdapter: TradeAdapter = {
  trade: "plumbing",

  source(elements, part): SourceInfo | null {
    const role = plumbingSourceRole(elements, part);
    if (!role) return null;
    const connectors = pipeConnectors(elements, part);
    const out = connectors.find((c) => c.systemKind !== null && roleServes(role).includes(c.systemKind)) ?? connectors[0];
    return { name: part.mark || part.id, port: out?.id ?? "out", spaces: "none", input: null };
  },

  connectors(elements, part) {
    return pipeConnectors(elements, part).map((c) => c.id);
  },

  positionsNeeded() {
    return null;
  },

  refusal(elements, source, _positions, member: MemberCandidate) {
    const role = plumbingSourceRole(elements, source);
    if (!role) return `${source.mark || source.id} is not a water heater, meter or interceptor, so nothing can be served from it`;
    const kind = pipeConnectors(elements, member.part).find((c) => c.id === member.connector)?.systemKind ?? null;
    if (kind !== null && !roleServes(role).includes(kind) && !(role === "water_heater" && kind === "domestic_cold_water")) {
      return `${source.mark || source.id} is a ${ROLE_WORDS[role]}; ${member.part.mark || member.part.id}'s ${member.connector} connection is not something it serves`;
    }
    return null;
  },

  positionsRefusal(_elements, source, positions) {
    return positions.length > 0 ? `${source.mark || source.id} has no numbered positions; what it serves takes none` : null;
  },
};

const drawnCache = new WeakMap<object, Map<string, ReadonlySet<ElementId>>>();

/**
 * The plumbing sources the drawn network at a run element reaches (WH-1's hot
 * outlet, the meter, the interceptor), walked once per pipe network and element
 * record, then cached for every load on it.
 */
export function drawnPlumbingSources(elements: Elements, runId: ElementId): ReadonlySet<ElementId> {
  let byRun = drawnCache.get(elements);
  if (!byRun) drawnCache.set(elements, (byRun = new Map()));
  const known = byRun.get(runId);
  if (known) return known;
  const seen = new Set<string>([runId]);
  const stack: string[] = [runId];
  const sources = new Set<ElementId>();
  const members: string[] = [];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    members.push(n);
    const hash = n.indexOf("#");
    if (hash >= 0) {
      const part = elements[n.slice(0, hash)];
      // A source ends the walk on its side: what is beyond a water heater's inlet is another network.
      if (part?.kind === "part" && plumbingSourceRole(elements, part)) {
        sources.add(part.id);
        continue;
      }
    }
    for (const m of runNeighbours(elements, n)) {
      if (seen.has(m) || (!m.includes("#") && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  for (const m of members) if (!m.includes("#")) byRun.set(m, sources);
  return sources;
}

/**
 * Where a drawn drain leads, by the side of each source it meets: a grease
 * interceptor reached at its inlet (the drain goes through it) or at its outlet
 * (the drain joins below it), and the sewer connections, pumps and valves it
 * reaches. Walked once per drain network and element record, like
 * `drawnPlumbingSources`, and cached for every load on it.
 */
export interface DrainOutletSides {
  readonly interceptorInlets: ReadonlySet<ElementId>;
  readonly interceptorOutlets: ReadonlySet<ElementId>;
  readonly sewer: ReadonlySet<ElementId>;
}

const sidesCache = new WeakMap<object, Map<string, DrainOutletSides>>();

function isInletConnector(elements: Elements, part: PartInstance, connector: string): boolean {
  const def = typeOf(elements, part);
  const c = def?.connectors.find((x) => x.id === connector);
  if (c?.flowDirection === "in") return true;
  if (c?.flowDirection === "out") return false;
  return connector === "in";
}

export function drainOutletSides(elements: Elements, startId: ElementId): DrainOutletSides {
  let byRun = sidesCache.get(elements);
  if (!byRun) sidesCache.set(elements, (byRun = new Map()));
  const known = byRun.get(startId);
  if (known) return known;
  const seen = new Set<string>([startId]);
  const stack: string[] = [startId];
  const out = { interceptorInlets: new Set<ElementId>(), interceptorOutlets: new Set<ElementId>(), sewer: new Set<ElementId>() };
  const members: string[] = [];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    members.push(n);
    const hash = n.indexOf("#");
    if (hash >= 0) {
      const part = elements[n.slice(0, hash)];
      const role = part?.kind === "part" ? plumbingSourceRole(elements, part) : null;
      if (part?.kind === "part" && role) {
        if (role === "grease_interceptor") (isInletConnector(elements, part, n.slice(hash + 1)) ? out.interceptorInlets : out.interceptorOutlets).add(part.id);
        else if (role === "sewer_connection" || role === "sewage_pump" || role === "backwater_valve") out.sewer.add(part.id);
        continue;
      }
    }
    for (const m of runNeighbours(elements, n)) {
      if (seen.has(m) || (!m.includes("#") && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  for (const m of members) if (!m.includes("#")) byRun.set(m, out);
  return out;
}

/** For load status: is a piped load fed from the source it names? Null when no source is drawn on its network yet. */
export function plumbingDrawnSource(elements: Elements, hostId: ElementId, sourceId: ElementId): boolean | null {
  const sources = drawnPlumbingSources(elements, hostId);
  if (sources.size === 0) return null;
  return sources.has(sourceId);
}
