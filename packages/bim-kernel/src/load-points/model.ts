import { catalogKey, connectionTypeOf } from "../catalog/model";
import type { ConnectionTypeEntry } from "../catalog/types";
import type { SystemKind } from "../parts";
import { mergeBags, totalsOf, type QuantityBag, type QuantityKey, type QuantityTotals } from "../quantities";
import type { RunPoint } from "../routing/types";
import { devicePartOf, legacyLoadId, runEndOf, type LoadRecord } from "../requirements/anchor";
import { loadIndexOf } from "../requirements/load-index";
import { elementValues } from "../store";
import type { BimElement, ElementId } from "../types";
import type { LoadPointElement } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The id a load point placed on this end before Oct 2026 has, and the id
 * `create_load_point` still gives a point it puts on a free end. It is an id,
 * not an address: a load can move and keep it. Find a load by place with
 * `loadPointAt`.
 */
export function loadPointId(hostId: string, port: string): ElementId {
  return legacyLoadId(hostId, port);
}

/** The load on a run end or port, if any (at most one: the commands keep that rule). */
export function loadPointAt(elements: Elements, hostId: string, port: string): LoadPointElement | null {
  const legacy = elements[legacyLoadId(hostId, port)];
  if (legacy?.kind === "load_point" && isOnRunEnd(legacy, hostId, port)) return legacy;
  const id = loadIndexOf(elements).atRunEnd(hostId, port);
  const el = id ? elements[id] : undefined;
  return el?.kind === "load_point" && isOnRunEnd(el, hostId, port) ? el : null;
}

function isOnRunEnd(lp: LoadRecord, hostId: string, port: string): boolean {
  const at = runEndOf(lp);
  return at !== null && at.elementId === hostId && at.port === port;
}

/** The ends or ports of a run element a load point could sit on. */
export function hostPorts(el: BimElement | undefined): readonly string[] {
  if (el?.kind === "run_segment") return ["start", "end"];
  if (el?.kind === "run_fitting") return el.ports.map((p) => p.id);
  return [];
}

/** Load points on a run element's ends or ports, in port order. Reads only those ids. */
export function loadPointsOnHost(elements: Elements, hostId: string): LoadPointElement[] {
  const out: LoadPointElement[] = [];
  for (const port of hostPorts(elements[hostId])) {
    const lp = loadPointAt(elements, hostId, port);
    if (lp) out.push(lp);
  }
  return out;
}

export function connectionTypeOfLoadPoint(elements: Elements, lp: Pick<LoadRecord, "connectionType">): ConnectionTypeEntry | null {
  return lp.connectionType ? connectionTypeOf(elements, lp.connectionType) : null;
}

/** What the point carries: its connection type's quantities, with its own values on top. */
export function loadPointQuantities(elements: Elements, lp: Pick<LoadRecord, "connectionType" | "values">): QuantityBag {
  const ct = connectionTypeOfLoadPoint(elements, lp);
  return mergeBags(ct?.quantities, lp.values);
}

export function loadPointTotals(elements: Elements, lp: Pick<LoadRecord, "connectionType" | "values">): QuantityTotals {
  return totalsOf(loadPointQuantities(elements, lp));
}

export type LoadPointHostState = "ok" | "lost" | "continued";

/**
 * "ok": on an open end or port. "lost": the host was deleted (it counts
 * nowhere; re-place or delete it). "continued": the pipe now runs on past it
 * (it still counts where it is; move it to the new end).
 */
export function loadPointHostState(elements: Elements, lp: LoadRecord): LoadPointHostState {
  const at = runEndOf(lp);
  // Only a load on a run end has a pipe to lose; an estimate, a row or a device load is where its anchor says.
  if (!at) return "ok";
  const host = elements[at.elementId];
  if (host?.kind === "run_segment") {
    if (at.port !== "start" && at.port !== "end") return "lost";
    return host.links[at.port] ? "continued" : "ok";
  }
  if (host?.kind === "run_fitting") {
    const port = host.ports.find((p) => p.id === at.port);
    if (!port) return "lost";
    return port.link ? "continued" : "ok";
  }
  return "lost";
}

/** Where it is drawn on a pipe: its host's end or port. Null when the host is gone or the load is not on a run end. */
export function loadPointPosition(elements: Elements, lp: LoadRecord): { readonly point: RunPoint; readonly direction: RunPoint; readonly levelId: ElementId; readonly systemId: ElementId } | null {
  const at = runEndOf(lp);
  if (!at) return null;
  const host = elements[at.elementId];
  if (host?.kind === "run_segment" && (at.port === "start" || at.port === "end")) {
    const a = at.port === "end" ? host.end : host.start;
    const b = at.port === "end" ? host.start : host.end;
    const len = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) || 1;
    return { point: a, direction: { x: (a.x - b.x) / len, y: (a.y - b.y) / len, z: (a.z - b.z) / len }, levelId: host.levelId, systemId: host.systemId };
  }
  if (host?.kind === "run_fitting") {
    const port = host.ports.find((p) => p.id === at.port);
    if (port) return { point: port.position, direction: port.direction, levelId: host.levelId, systemId: host.systemId };
  }
  return null;
}

/** The system kind of the host's system, or null (also for a load not on a run end). */
export function loadPointSystemKind(elements: Elements, lp: LoadRecord): SystemKind | null {
  const at = runEndOf(lp);
  if (!at) return joinedSystemKind(elements, lp);
  const host = elements[at.elementId];
  if (host?.kind !== "run_segment" && host?.kind !== "run_fitting") return null;
  const system = elements[host.systemId];
  return system?.kind === "mep_system" ? system.systemKind : null;
}

/** A load served end to end by a part's connector (join_parts) carries what that connector carries. */
function joinedSystemKind(elements: Elements, lp: LoadRecord): SystemKind | null {
  const by = lp.joinedTo;
  const part = by ? elements[by.elementId] : undefined;
  const type = part?.kind === "part" ? elements[part.typeId] : undefined;
  if (!by || type?.kind !== "part_type") return null;
  return type.definition.connectors.find((c) => c.id === by.port)?.systemKind ?? null;
}

/**
 * The one number a load point adds to a run of this system kind: drainage
 * fixture units on sanitary, cold or hot water fixture units on water, gas
 * input on gas, airflow on duct, fixed flow on hydronic and condensate.
 * Null for systems that carry nothing to size (vent).
 */
export function primaryQuantity(kind: SystemKind | null): QuantityKey | null {
  switch (kind) {
    case "sanitary":
      return "dfu";
    case "domestic_cold_water":
      return "wsfu_cold";
    case "domestic_hot_water":
    case "domestic_hot_water_return":
      return "wsfu_hot";
    case "natural_gas":
      return "mbh";
    case "supply_air":
    case "return_air":
    case "exhaust_air":
    case "outside_air":
      return "cfm";
    case "storm":
    case "hydronic_supply":
    case "hydronic_return":
    case "condensate":
      return "gpm_fixed";
    case "power":
    case "lighting":
      return "va";
    case "grease_waste":
    case "indirect_waste":
      return "dfu";
    case "fire_protection_wet":
    case "fire_protection_dry":
    case "chilled_water_supply":
    case "chilled_water_return":
    case "heating_water_supply":
    case "heating_water_return":
      return "gpm_fixed";
    default:
      return null;
  }
}

/** What this point adds to the run it sits on (0 when lost). */
export function loadPointLoad(elements: Elements, lp: LoadRecord): number {
  const q = primaryQuantity(loadPointSystemKind(elements, lp));
  return q ? loadPointTotals(elements, lp)[q] : 0;
}

/** Which fixture a point belongs to, for pairing its cold and hot sides: the attached part, else its mark. */
export function fixtureKeyOf(lp: LoadRecord): string | null {
  if (lp.attachedPartId) return `part:${lp.attachedPartId}`;
  const mark = lp.mark?.trim();
  return mark ? `mark:${mark.toUpperCase()}` : null;
}

/** The loads a part stands for (attached: a fixture's cold, hot and waste points) or carries (anchored to its connector), attached first. From the load index. */
export function loadPointsOfPart(elements: Elements, partId: string): readonly LoadPointElement[] {
  const ids = loadIndexOf(elements).ofPart(partId);
  if (ids.length === 0) return [];
  const attached: LoadPointElement[] = [];
  const anchored: LoadPointElement[] = [];
  for (const id of ids) {
    const el = elements[id];
    if (el?.kind !== "load_point" || devicePartOf(el) !== partId) continue;
    (el.attachedPartId === partId ? attached : anchored).push(el);
  }
  return [...attached, ...anchored];
}

/** "Load point P01 (Water closet) at the end of the 4" sanitary pipe". */
export function loadPointLabel(elements: Elements, lp: Pick<LoadRecord, "connectionType" | "mark">): string {
  const ct = connectionTypeOfLoadPoint(elements, lp);
  const name = lp.mark || lp.connectionType || "with its own load";
  return `Load point ${name}${ct?.description ? ` (${ct.description})` : ""}`;
}

/** Load points naming a connection type (catalog renames and edits). Scans: catalog edits only. */
export function loadPointsNaming(elements: Elements, designator: string): LoadPointElement[] {
  const key = catalogKey(designator);
  const out: LoadPointElement[] = [];
  for (const el of elementValues(elements)) if (el.kind === "load_point" && catalogKey(el.connectionType) === key) out.push(el);
  return out;
}

/**
 * What a part's connector carries from the connection type the part names
 * (`values.connection_type`): the quantity its connector's system counts.
 * Null when it names none or the type has no such quantity, so the part's own
 * parameters apply. Electrical devices read the same record (connections/electrical).
 */
export function partConnectionTypeLoad(elements: Elements, part: { readonly typeId: string; readonly values: Readonly<Record<string, unknown>> }, connectorKind: SystemKind | null): number | null {
  const name = partConnectionTypeName(elements, part);
  if (name === null) return null;
  const q = primaryQuantity(connectorKind);
  const entry = q && q !== "va" ? connectionTypeOf(elements, name) : null;
  const v = entry?.quantities?.[q as QuantityKey];
  return typeof v === "number" ? v : null;
}

/** The connection type a part names: its own value, else its type's starter (`default_connection_type`) once the project catalog has it. */
export function partConnectionTypeName(elements: Elements, part: { readonly typeId: string; readonly values: Readonly<Record<string, unknown>> }): string | null {
  const own = part.values.connection_type;
  if (typeof own === "string" && own.trim() !== "") return own;
  const type = elements[part.typeId];
  const starter = type?.kind === "part_type" ? type.definition.typeValues.default_connection_type : undefined;
  return typeof starter === "string" && starter.trim() !== "" && connectionTypeOf(elements, starter) ? starter : null;
}
