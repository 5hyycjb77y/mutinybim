import { spaceOf } from "@permitzip/bim-kernel/spaces";
import { roomOf, paramValue, resolveConnectors, elementsOfKind, type BimElement, type ModelState, type PartInstance, type PartTypeElement, linkServing, linksFedFrom, occupiedPositions, serviceLinkName, type ServiceLink, type ServiceRole, typicalMultiplier, organizationOf, phaseCreatedOf } from "@permitzip/bim-kernel";
import { electricalAdapter } from "./adapter";
import { distributionOf, electricalConnectorIds, electricalConnectorOf, electricalName, phaseOfSlot, voltageSystemLabel, PHASE_NAMES, type DistributionKind } from "./systems";

/**
 * Read model for the electrical workflow: the panel view (slots, circuits,
 * connected load per phase), what a device or panel is on, and the slot
 * choices a circuit can take. One source for the Building Model's panel view
 * and the agent's bim_read_panel, so both say the same thing.
 *
 * Slots and membership only: every load figure (connected, demand, per
 * phase, capacity) is the aggregation engine's (`ElectricalLoadEngine`,
 * CONNECTIONS.md "Aggregation API"), so the panel view and the agent's
 * bim_electrical_report never disagree.
 */

type Elements = Readonly<Record<string, BimElement>>;
export type PhaseName = (typeof PHASE_NAMES)[number];

export interface PanelCircuitMember {
  readonly elementId: string;
  readonly connector: string;
  readonly name: string;
  /** The member exists (planned, on the list) but nobody has drawn it yet. Absent: placed. */
  readonly notPlaced?: true;
}

export interface PanelCircuit {
  readonly linkId: string;
  /** As drawings name it: "L1-3", "L1-2,4,6", "T1 to L1". */
  readonly name: string;
  readonly role: ServiceRole;
  readonly positions: readonly number[];
  readonly poles: number;
  readonly phases: readonly PhaseName[];
  readonly ratingA: number | null;
  readonly description: string;
  readonly members: readonly PanelCircuitMember[];
  /** The fed equipment, for a feeder. */
  readonly feeds: { readonly elementId: string; readonly name: string } | null;
  /** A feeder to a typical unit counted this many times here (absent: once). */
  readonly typicalCount?: number;
  /** Existing on this renovation (made in an earlier phase than the one being designed): it keeps its panel and number. Absent: new. */
  readonly existing?: { readonly phase: string };
}

export interface PanelSlot {
  readonly slot: number;
  readonly phase: PhaseName;
  readonly circuit: PanelCircuit | null;
  /** The lowest slot of a multi-pole breaker (where its description prints). */
  readonly first: boolean;
}

export interface PanelFedBy {
  readonly linkId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly name: string;
  readonly positions: readonly number[];
  readonly ratingA: number | null;
}

export interface PanelSchedule {
  readonly id: string;
  readonly name: string;
  /** False until the engineer names it (circuits then read "<type name>-3"). */
  readonly named: boolean;
  readonly kind: DistributionKind;
  readonly system: string;
  /** What it must be fed with (a transformer's primary), when that differs from what it supplies. */
  readonly supply: string | null;
  readonly spaces: number | null;
  readonly busA: number | null;
  readonly mainA: number | null;
  readonly kva: number | null;
  readonly fedBy: PanelFedBy | null;
  readonly circuits: readonly PanelCircuit[];
  /** Every numbered slot, odd and even, with what is on it (empty for a source without positions). */
  readonly slots: readonly PanelSlot[];
  readonly freeSlots: number;
}

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

/** What one connector says it draws, VA, for a device not yet on a circuit; null when it says nothing. Once circuited, the engine's member load is the figure. */
export function connectorLoadVa(elements: Elements, part: PartInstance, connector: string): number | null {
  const type = typeOf(elements, part);
  if (!type) return null;
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connector);
  return typeof c?.flow === "number" && Number.isFinite(c.flow) && c.flow > 0 ? c.flow : null;
}

/** How a device or piece of equipment is named in circuit lists: its mark, else its family. */
export function memberName(elements: Elements, part: PartInstance): string {
  if (distributionOf(elements, part)) return electricalName(elements, part);
  const type = typeOf(elements, part);
  return part.mark || type?.definition.familyName || part.id;
}

export function describeCircuit(elements: Elements, link: ServiceLink): PanelCircuit {
  const source = partOf(elements, link.source.elementId);
  const system = source ? distributionOf(elements, source)?.system ?? null : null;
  const positions = [...link.source.positions].sort((a, b) => a - b);
  const members: PanelCircuitMember[] = link.members.map((m) => {
    const part = partOf(elements, m.elementId);
    return { elementId: m.elementId, connector: m.connector, name: part ? memberName(elements, part) : m.elementId, ...(part?.planned !== undefined ? { notPlaced: true as const } : {}) };
  });
  const fed = link.role === "feeder" ? members[0] : undefined;
  const typical = fed ? typicalMultiplier(elements, elements[fed.elementId], source ?? undefined).count : 1;
  return {
    linkId: link.id,
    name: serviceLinkName(elements, link),
    role: link.role,
    positions,
    poles: circuitPoles(elements, link, positions),
    phases: system ? positions.map((s) => PHASE_NAMES[phaseOfSlot(s, system)] ?? "A") : [],
    ratingA: link.electrical?.ratingA ?? null,
    description: link.description,
    members,
    feeds: fed ? { elementId: fed.elementId, name: fed.name } : null,
    ...(typical > 1 ? { typicalCount: typical } : {}),
    ...existingField(elements, link),
  };
}

function existingField(elements: Elements, link: ServiceLink): { existing?: { phase: string } } {
  const phase = existingPhaseOf(elements, link);
  return phase === null ? {} : { existing: { phase } };
}

const NO_CONNECTIONS: ModelState["connections"] = [];

/**
 * The phase an element was made in when that is earlier than the phase being
 * designed (the active phase: New construction by default), i.e. it is
 * existing on this renovation; null when it is new. Elements that name no
 * phase are New construction (organization/model.ts), so models made before
 * phases existed read as all new.
 */
export function existingPhaseOf(elements: Elements, el: BimElement): string | null {
  if (el.phaseCreated === undefined) return null;
  const org = organizationOf({ elements, connections: NO_CONNECTIONS });
  const created = org.phaseIndex.get(phaseCreatedOf(org, el));
  const designing = org.phaseIndex.get(org.activePhaseId);
  if (created === undefined || designing === undefined || created >= designing) return null;
  return org.phases[created]?.entry.name ?? null;
}

/**
 * Why an existing circuit can't be moved to another panel or renumbered, or
 * null when it can (it is new, or nothing about its panel or number changes).
 * Rebalance, auto-circuit proposals and the circuit commands all ask this.
 */
export function existingCircuitRefusal(elements: Elements, link: ServiceLink, change: { readonly sourceId?: string; readonly positions?: readonly number[] }): string | null {
  const phase = existingPhaseOf(elements, link);
  if (phase === null) return null;
  const moving = change.sourceId !== undefined && change.sourceId !== link.source.elementId;
  const now = [...link.source.positions].sort((a, b) => a - b);
  const next = change.positions ? [...change.positions].sort((a, b) => a - b) : now;
  const renumbering = next.length !== now.length || next.some((p, i) => p !== now[i]);
  if (!moving && !renumbering) return null;
  return `${serviceLinkName(elements, link)} is an existing circuit (made in ${phase}), so it keeps its panel and circuit number on this renovation. To ${moving ? "move" : "renumber"} it, set its phase to the one you are designing first.`;
}

/** Breaker poles: the slots it takes, else (a transformer's secondary, an empty spare) what its first member needs. */
function circuitPoles(elements: Elements, link: ServiceLink, positions: readonly number[]): number {
  if (positions.length > 0) return positions.length;
  const first = link.members[0];
  const part = first ? partOf(elements, first.elementId) : null;
  if (!first || !part) return 0;
  return electricalAdapter.positionsNeeded(elements, { part, connector: first.connector }, link.role) ?? 0;
}

/** Poles a set of loads needs on one circuit, or null when they disagree or have no power connector. */
export function polesForMembers(elements: Elements, members: readonly { readonly elementId: string; readonly connector?: string }[]): number | null {
  let poles: number | null = null;
  for (const m of members) {
    const part = partOf(elements, m.elementId);
    if (!part) return null;
    const connector = m.connector ?? electricalConnectorIds(elements, part)[0];
    const need = connector ? electricalConnectorOf(elements, part, connector)?.poles ?? null : null;
    if (need === null || (poles !== null && need !== poles)) return null;
    poles = need;
  }
  return poles;
}

/** The feeder that feeds a piece of distribution equipment, if any. */
export function feederOf(elements: Elements, part: PartInstance): ServiceLink | null {
  const d = distributionOf(elements, part);
  return d?.input ? linkServing(elements, part.id, d.input) : null;
}

/** The panel view of a panelboard, switchboard or transformer; null when the part isn't one. */
export function panelSchedule(elements: Elements, panelId: string): PanelSchedule | null {
  const part = partOf(elements, panelId);
  if (!part) return null;
  const d = distributionOf(elements, part);
  if (!d) return null;
  const type = typeOf(elements, part);
  const named = type ? typeof paramValue(type.definition, part.values, "panel_name") === "string" && String(paramValue(type.definition, part.values, "panel_name")).trim() !== "" : false;
  const circuits = linksFedFrom(elements, panelId).map((l) => describeCircuit(elements, l));
  const bySlot = new Map<number, PanelCircuit>();
  for (const c of circuits) for (const s of c.positions) bySlot.set(s, c);
  const slots: PanelSlot[] = [];
  if (d.spaces !== null) {
    for (let s = 1; s <= d.spaces; s++) {
      const c = bySlot.get(s) ?? null;
      slots.push({ slot: s, phase: PHASE_NAMES[phaseOfSlot(s, d.system)] ?? "A", circuit: c, first: c ? c.positions[0] === s : false });
    }
  }
  const feeder = feederOf(elements, part);
  const fedSource = feeder ? partOf(elements, feeder.source.elementId) : null;
  const used = new Set(circuits.flatMap((c) => c.positions));
  return {
    id: part.id,
    name: d.name,
    named,
    kind: d.kind,
    system: voltageSystemLabel(d.system),
    supply: d.kind === "transformer" ? voltageSystemLabel(d.supply) : null,
    spaces: d.spaces,
    busA: d.busA,
    mainA: d.mainA,
    kva: d.kva,
    fedBy: feeder
      ? { linkId: feeder.id, sourceId: feeder.source.elementId, sourceName: fedSource ? electricalName(elements, fedSource) : feeder.source.elementId, name: serviceLinkName(elements, feeder), positions: [...feeder.source.positions].sort((a, b) => a - b), ratingA: feeder.electrical?.ratingA ?? null }
      : null,
    circuits,
    slots,
    freeSlots: d.spaces === null ? 0 : d.spaces - used.size,
  };
}

export interface DistributionSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: DistributionKind;
  readonly system: string;
  readonly spaces: number | null;
}

/** Every panelboard, switchboard and transformer in the model, by name. */
export function distributionEquipment(elements: Elements): DistributionSummary[] {
  const out: DistributionSummary[] = [];
  // distributionOf answers null for any part whose type isn't electrical equipment; skip those without a store read each.
  const equipmentTypes = new Set<string>();
  for (const el of elementsOfKind(elements, "part_type")) if (el.definition.category === "electrical_equipment") equipmentTypes.add(el.id);
  for (const el of elementsOfKind(elements, "part")) {
    if (!equipmentTypes.has(el.typeId)) continue;
    const d = distributionOf(elements, el);
    if (d) out.push({ id: el.id, name: d.name, kind: d.kind, system: voltageSystemLabel(d.system), spaces: d.spaces });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

export interface ElectricalConnection {
  readonly connector: string;
  /** "load" for a device's power connector, "input" for distribution equipment's feeder connector. */
  readonly role: "load" | "input";
  readonly voltage: number | null;
  readonly poles: number | null;
  readonly loadVa: number | null;
  readonly circuit: { readonly linkId: string; readonly name: string; readonly sourceId: string; readonly sourceName: string } | null;
}

/** A part's electrical connectors and what each is on. Empty for parts with none. */
export function electricalConnections(elements: Elements, partId: string): ElectricalConnection[] {
  const part = partOf(elements, partId);
  if (!part) return [];
  const d = distributionOf(elements, part);
  const ids = d ? (d.input ? [d.input] : []) : electricalConnectorIds(elements, part);
  return ids.map((connector) => {
    const demand = electricalConnectorOf(elements, part, connector);
    const link = linkServing(elements, part.id, connector);
    const src = link ? partOf(elements, link.source.elementId) : null;
    return {
      connector,
      role: d ? "input" : "load",
      voltage: demand?.voltage ?? null,
      poles: demand?.poles ?? null,
      loadVa: d ? null : connectorLoadVa(elements, part, connector),
      circuit: link ? { linkId: link.id, name: serviceLinkName(elements, link), sourceId: link.source.elementId, sourceName: src ? electricalName(elements, src) : link.source.elementId } : null,
    };
  });
}

/** Parts that can go on a branch circuit (devices and equipment with a power connector, not distribution equipment). */
export function isCircuitableLoad(elements: Elements, part: PartInstance): boolean {
  return !distributionOf(elements, part) && electricalConnectorIds(elements, part).length > 0;
}

/** Every slot group a breaker of `poles` poles could take on a panel now, lowest first. `except` frees a circuit's own slots (moving it). */
export function slotChoices(elements: Elements, panelId: string, poles: number, except?: string): number[][] {
  const part = partOf(elements, panelId);
  const d = part ? distributionOf(elements, part) : null;
  if (!part || !d || d.spaces === null || poles < 1) return [];
  const taken = new Set(occupiedPositions(elements, panelId, except).keys());
  const out: number[][] = [];
  for (let s = 1; s <= d.spaces; s++) {
    const group = Array.from({ length: poles }, (_, i) => s + 2 * i);
    if (group.some((g) => taken.has(g) || g > (d.spaces ?? 0))) continue;
    if (electricalAdapter.positionsRefusal(elements, part, group) === null) out.push(group);
  }
  return out;
}

/** Plain-words label for a slot group: "3 (phase B)", "2,4,6 (A, B, C)". */
export function slotChoiceLabel(elements: Elements, panelId: string, group: readonly number[]): string {
  const part = partOf(elements, panelId);
  const d = part ? distributionOf(elements, part) : null;
  if (!d) return group.join(",");
  const phases = group.map((s) => PHASE_NAMES[phaseOfSlot(s, d.system)] ?? "A");
  return `${group.join(",")} (${group.length === 1 ? `phase ${phases[0]}` : phases.join(", ")})`;
}

/** The firm's pattern for a new circuit's name when its devices are in a room: `{use}` (RECEPT, LTG…) and `{room}` (OFFICE 104). */
export const DEFAULT_CIRCUIT_NAME_PATTERN = "{use} {room}";

/** The words a circuit name uses for what is on it. */
function useWordOf(elements: Elements, part: PartInstance): string {
  const def = typeOf(elements, part)?.definition;
  if (!def) return "LOADS";
  if (def.category === "lighting_fixture") return "LTG";
  if (/receptacle/i.test(def.familyName)) return "RECEPT";
  if (/switch/i.test(def.familyName)) return "SW";
  if (/junction/i.test(def.familyName)) return "JB";
  return def.familyName.toUpperCase();
}

/** "OFFICE 104": the space (else the drawn room) a part stands in, as a circuit name prints it. */
function roomWordOf(elements: Elements, part: PartInstance): string | null {
  const space = spaceOf(elements, part.id);
  const room = space ?? roomOf(elements, part);
  if (!room) return null;
  const words = [room.name.trim(), room.number.trim()].filter((w) => w.length > 0).join(" ");
  return words.length > 0 ? words.toUpperCase() : null;
}

/**
 * A new circuit's name from the room its devices are in and what they are
 * ("RECEPT OFFICE 104"), by the firm's pattern. Null when the devices are in
 * no room (or in more than one), or when the circuit serves one piece of
 * equipment, which is named for itself.
 */
export function circuitNameFromRoom(elements: Elements, memberIds: readonly string[], pattern = DEFAULT_CIRCUIT_NAME_PATTERN): string | null {
  const parts = memberIds.map((id) => partOf(elements, id)).filter((p): p is PartInstance => p !== null);
  if (parts.length === 0) return null;
  const rooms = new Set(parts.map((p) => roomWordOf(elements, p)));
  if (rooms.size !== 1 || rooms.has(null)) return null;
  const [room] = [...rooms];
  if (!room) return null;
  const uses = [...new Set(parts.map((p) => useWordOf(elements, p)))].join("/");
  return pattern.replace("{use}", uses).replace("{room}", room).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A short description for a new circuit from what is on it: "RECEPT OFFICE 104" from its room, else "Receptacles", "Lighting", "MAU-1". */
export function defaultCircuitDescription(elements: Elements, memberIds: readonly string[], pattern = DEFAULT_CIRCUIT_NAME_PATTERN): string {
  const parts = memberIds.map((id) => partOf(elements, id)).filter((p): p is PartInstance => p !== null);
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    const only = parts[0] as PartInstance;
    const type = typeOf(elements, only);
    if (type && (type.definition.category === "mechanical_equipment" || type.definition.category === "electrical_equipment")) return memberName(elements, only);
  }
  const fromRoom = circuitNameFromRoom(elements, memberIds, pattern);
  if (fromRoom) return fromRoom;
  const words = new Set(
    parts.map((p) => {
      const def = typeOf(elements, p)?.definition;
      if (!def) return "Loads";
      if (def.category === "lighting_fixture") return "Lighting";
      if (/receptacle/i.test(def.familyName)) return "Receptacles";
      if (/switch/i.test(def.familyName)) return "Switches";
      if (/junction/i.test(def.familyName)) return "Junction boxes";
      return def.familyName;
    }),
  );
  return [...words].join(", ").slice(0, 120);
}

/** Breaker poles a feeder to this panel or transformer takes (one per hot conductor of what it needs); null when it isn't distribution equipment. */
export function feederPolesFor(elements: Elements, partId: string): number | null {
  const part = partOf(elements, partId);
  const d = part ? distributionOf(elements, part) : null;
  if (!part || !d?.input) return null;
  return electricalAdapter.positionsNeeded(elements, { part, connector: d.input }, "feeder");
}
