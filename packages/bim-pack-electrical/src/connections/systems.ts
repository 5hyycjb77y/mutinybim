import { paramValue, resolveConnectors, type ResolvedConnector, type BimElement, type PartInstance, type PartTypeElement, connectionTypeOf, partConnectionTypeName, type ConnectionTypeEntry } from "@permitzip/bim-kernel";
import { electricalFieldsOf } from "../catalog/connection-fields";

/**
 * Voltage systems and what may be served from what. Nominal voltages only;
 * nameplate (utilization) voltages map onto them (460 V equipment runs on a
 * 480 V system). Compatibility is not equality: a 277/480 V single-phase panel
 * may be fed from a three-phase 480 V board with a two-pole breaker.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface VoltageSystem {
  /** Line-to-line volts (for a two-wire 120 V system, the one voltage it has). */
  readonly lineToLine: number;
  /** Line-to-neutral volts; null for a delta or two-wire system with no neutral to a hot. */
  readonly lineToNeutral: number | null;
  readonly phases: 1 | 3;
  readonly wires: 2 | 3 | 4;
}

export function voltageSystemLabel(s: VoltageSystem): string {
  const volts = s.lineToNeutral !== null && s.lineToNeutral !== s.lineToLine ? `${s.lineToNeutral}/${s.lineToLine} V` : `${s.lineToLine} V`;
  return `${volts} ${s.phases === 3 ? "3-phase" : "1-phase"} ${s.wires}-wire`;
}

/** The nominal system voltage a nameplate voltage runs on, or null when it matches none. */
export function nominalVoltage(v: number): number | null {
  const bands: ReadonlyArray<readonly [number, number, number]> = [
    [110, 127, 120],
    [190, 215, 208],
    [216, 250, 240],
    [254, 290, 277],
    [340, 350, 347],
    [440, 500, 480],
    [550, 610, 600],
  ];
  for (const [lo, hi, nominal] of bands) if (v >= lo && v <= hi) return nominal;
  return null;
}

/** A system from its line-to-line voltage and phase count, the way panel types describe themselves. */
export function voltageSystemFrom(voltage: number, phases: 1 | 3, wires?: number): VoltageSystem | null {
  const ll = nominalVoltage(voltage);
  if (ll === null) return null;
  if (phases === 3) {
    if (wires === 3) return { lineToLine: ll, lineToNeutral: null, phases: 3, wires: 3 };
    const ln = ll === 208 ? 120 : ll === 480 ? 277 : ll === 600 ? 347 : null;
    return ln === null ? { lineToLine: ll, lineToNeutral: null, phases: 3, wires: 3 } : { lineToLine: ll, lineToNeutral: ln, phases: 3, wires: 4 };
  }
  if (ll === 120 || ll === 277 || ll === 347) return { lineToLine: ll, lineToNeutral: ll, phases: 1, wires: 2 };
  const ln = ll === 240 ? 120 : ll === 208 ? 120 : ll === 480 ? 277 : null;
  if (wires === 2 || ln === null) return { lineToLine: ll, lineToNeutral: null, phases: 1, wires: 2 };
  return { lineToLine: ll, lineToNeutral: ln, phases: 1, wires: 3 };
}

/** Hot conductors a system has: the most poles a device or breaker on it can use. */
export function hotConductors(s: VoltageSystem): number {
  if (s.phases === 3) return 3;
  return s.wires === 3 ? 2 : 1;
}

/** The phase (0 = A, 1 = B, 2 = C) of a panel slot: odd and even columns, rows A, B, C from the top. */
export function phaseOfSlot(slot: number, s: VoltageSystem): number {
  const row = Math.floor((slot - 1) / 2);
  return row % hotConductors(s);
}

export const PHASE_NAMES = ["A", "B", "C"] as const;

// ------------------------------------------------------------------ what a part is, electrically

export type DistributionKind = "panelboard" | "switchboard" | "transformer" | "generator" | "transfer_switch" | "disconnect" | "meter" | "tap_box";

/** Kinds that pass power through without numbered breaker positions: what they feed takes no slot (service equipment such as a meter, CT cabinet or tap box among them). */
const NO_POSITIONS: ReadonlySet<DistributionKind> = new Set(["transformer", "generator", "transfer_switch", "disconnect", "meter", "tap_box"]);

export function hasPositions(kind: DistributionKind): boolean {
  return !NO_POSITIONS.has(kind);
}

/** A part that other things are fed from. */
export interface DistributionInfo {
  readonly kind: DistributionKind;
  readonly name: string;
  /** The system it supplies (a transformer's secondary). */
  readonly system: VoltageSystem;
  /** The system it must be fed with (a transformer's primary; else the same as `system`). */
  readonly supply: VoltageSystem;
  /** Numbered positions (panel circuits), or null when it has none to number (a transformer). */
  readonly spaces: number | null;
  readonly busA: number | null;
  /** Main breaker rating; null for main lugs only. */
  readonly mainA: number | null;
  readonly kva: number | null;
  /** The connector its feeder lands on (a transfer switch's normal side). */
  readonly input: string | null;
  /** A transfer switch's emergency (alternate) side: a second feeder lands here, from a generator. */
  readonly alternateInput: string | null;
  /** The output links leave from. */
  readonly port: "bus" | "secondary" | "load";
}

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function num(type: PartTypeElement, part: PartInstance, ...names: string[]): number | null {
  for (const n of names) {
    const v = paramValue(type.definition, part.values, n);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function str(type: PartTypeElement, part: PartInstance, ...names: string[]): string | null {
  for (const n of names) {
    const v = paramValue(type.definition, part.values, n);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function phasesOf(v: number | null): 1 | 3 | null {
  return v === 1 || v === 3 ? v : null;
}

/** "120/208Y 3PH 4W", "277/480 V 1Ø 3W", "480V 3PH 3W" written in a voltage-system parameter. */
export function parseVoltageSystem(text: string): VoltageSystem | null {
  const t = text.toUpperCase();
  const volts = [...t.matchAll(/\d{3}/g)].map((m) => Number(m[0]));
  const ll = volts.length > 0 ? Math.max(...volts) : null;
  if (ll === null) return null;
  const phases = /(^|[^0-9])1\s*(PH|Ø|PHASE)/.test(t) ? 1 : /(^|[^0-9])3\s*(PH|Ø|PHASE)|Y/.test(t) ? 3 : null;
  const wires = /([234])\s*W/.exec(t)?.[1];
  if (phases === null) return null;
  return voltageSystemFrom(ll, phases, wires === undefined ? undefined : Number(wires));
}

function partName(type: PartTypeElement, part: PartInstance): string {
  return str(type, part, "panel_name") ?? (part.mark || type.definition.typeName);
}

/** The display name of any part: its panel name, mark, or type (a load with no mark goes by its family: "Makeup air unit"). */
export function electricalName(elements: Elements, part: PartInstance): string {
  const type = typeOf(elements, part);
  if (!type) return part.mark || part.id;
  return type.definition.category === "electrical_equipment" ? partName(type, part) : part.mark || type.definition.familyName;
}

function kindOf(type: PartTypeElement, kva: number | null): DistributionKind {
  const words = `${type.definition.familyName} ${type.definition.typeName}`;
  if (/meter (center|stack|bank)|multi-?meter/i.test(words)) return "switchboard";
  if (/generator|genset/i.test(words)) return "generator";
  if (/transfer switch|\bats\b/i.test(words)) return "transfer_switch";
  if (/disconnect|safety switch/i.test(words)) return "disconnect";
  if (/\bmeter\b|ct cabinet|current transformer cabinet/i.test(words)) return "meter";
  if (/tap box|tap can|wireway|gutter|splice box/i.test(words)) return "tap_box";
  if (kva !== null || /transformer|xfmr/i.test(words)) return "transformer";
  if (/switchboard|swbd|switchgear|distribution panel|\bmdp\b/i.test(words)) return "switchboard";
  return "panelboard";
}

const ALTERNATE = /^(emergency|alternate|standby)$/i;
const OUTPUT = /^(output|load|secondary)$/i;

/** The input connector: an electrical connector named feeder / primary / input / normal, else the only one that isn't an output or an alternate side. */
function inputConnector(connectors: readonly ResolvedConnector[]): string | null {
  const electrical = connectors.filter((c) => c.domain === "electrical" && !ALTERNATE.test(c.id) && !OUTPUT.test(c.id));
  const named = electrical.find((c) => /^(feeder|primary|input|line|supply|normal)$/i.test(c.id));
  return (named ?? (electrical.length === 1 ? electrical[0] : undefined))?.id ?? null;
}

function alternateConnector(connectors: readonly ResolvedConnector[]): string | null {
  return connectors.find((c) => c.domain === "electrical" && ALTERNATE.test(c.id))?.id ?? null;
}

/**
 * What a part supplies, when it is distribution equipment: the electrical
 * equipment category with a readable voltage system. Reads, in order, a
 * `voltage_system` text, else `voltage` + `phases` (+ `wires`); transformers
 * read `primary_voltage` / `secondary_voltage` and `kva`.
 */
export function distributionOf(elements: Elements, part: PartInstance): DistributionInfo | null {
  const type = typeOf(elements, part);
  if (!type || type.definition.category !== "electrical_equipment") return null;
  const kva = num(type, part, "kva", "kva_rating");
  const kind = kindOf(type, kva);
  const phases = phasesOf(num(type, part, "phases"));
  const wires = num(type, part, "wires") ?? undefined;
  const connectors = resolveConnectors(type.definition, part.values);
  const input = kind === "generator" ? null : inputConnector(connectors);
  const alternateInput = kind === "transfer_switch" ? alternateConnector(connectors) : null;
  const busA = num(type, part, "bus_rating", "bus_a", "amps", "rating");
  const mains = str(type, part, "mains");
  const mainA = num(type, part, "main_rating", "main_a", "main_breaker", "fuse_rating", "fuse_a") ?? (mains && /MCB|MAIN BREAKER/i.test(mains) ? (Number(/(\d{1,32})\s{0,32}A/i.exec(mains)?.[1]) || busA) : null);
  const spaces = num(type, part, "circuits", "spaces", "poles");
  const name = partName(type, part);
  if (kind === "transformer") {
    const primaryText = str(type, part, "primary_system");
    const secondaryText = str(type, part, "secondary_system");
    const pv = num(type, part, "primary_voltage");
    const sv = num(type, part, "secondary_voltage", "voltage");
    const pph = phasesOf(num(type, part, "primary_phases")) ?? phases ?? 3;
    const sph = phasesOf(num(type, part, "secondary_phases")) ?? phases ?? 3;
    const supply = primaryText ? parseVoltageSystem(primaryText) : pv !== null ? voltageSystemFrom(pv, pph, 3) : null;
    const system = secondaryText ? parseVoltageSystem(secondaryText) : sv !== null ? voltageSystemFrom(sv, sph) : null;
    if (!supply || !system) return null;
    return { kind, name, system, supply, spaces: null, busA: null, mainA: null, kva, input, alternateInput: null, port: "secondary" };
  }
  const text = str(type, part, "voltage_system");
  const v = num(type, part, "voltage");
  const system = text ? parseVoltageSystem(text) : v !== null && phases !== null ? voltageSystemFrom(v, phases, wires) : null;
  if (!system) return null;
  if (!hasPositions(kind)) return { kind, name, system, supply: system, spaces: null, busA, mainA, kva, input, alternateInput, port: "load" };
  return { kind, name, system, supply: system, spaces: spaces !== null ? Math.floor(spaces) : null, busA, mainA, kva, input, alternateInput: null, port: "bus" };
}

/** What one electrical connector of a part needs from its source. */
export interface ElectricalDemand {
  readonly connector: string;
  readonly voltage: number;
  readonly poles: number;
}

interface PartConnectors {
  readonly type: PartTypeElement;
  readonly electrical: readonly ResolvedConnector[];
  /** `equipmentConnection`, filled on first ask; undefined until then. */
  equipment?: ElectricalDemand | null;
}

/**
 * Per elements record (a revision), per part object: its resolved electrical
 * connectors. A schedule row asks for them from every load column (circuit,
 * load, poles, voltage) and each ask used to resolve them and read up to a
 * dozen nameplate parameters again. Keyed on the part and checked against its
 * type, so a draft that replaces either reads fresh.
 */
const connectorsByRecord = new WeakMap<Elements, WeakMap<PartInstance, PartConnectors>>();

function partConnectors(elements: Elements, part: PartInstance, type: PartTypeElement): PartConnectors {
  let byPart = connectorsByRecord.get(elements);
  if (!byPart) {
    byPart = new WeakMap();
    connectorsByRecord.set(elements, byPart);
  }
  const known = byPart.get(part);
  if (known && known.type === type) return known;
  const entry: PartConnectors = { type, electrical: resolveConnectors(type.definition, part.values).filter((x) => x.domain === "electrical") };
  byPart.set(part, entry);
  return entry;
}

function equipmentConnectionOf(entry: PartConnectors, part: PartInstance): ElectricalDemand | null {
  if (entry.equipment === undefined) entry.equipment = equipmentConnection(entry.type, part);
  return entry.equipment;
}

export function electricalConnectorOf(elements: Elements, part: PartInstance, connector: string): ElectricalDemand | null {
  const type = typeOf(elements, part);
  if (!type) return null;
  const entry = partConnectors(elements, part, type);
  const connectors = entry.electrical;
  const c = connectors.find((x) => x.id === connector);
  if (!c) return connector === EQUIPMENT_CONNECTOR && connectors.length === 0 ? equipmentConnectionOf(entry, part) : null;
  // The device's connection type names its voltage and poles (on its first power connector).
  const ct = connectors[0]?.id === c.id ? connectionTypeOfPart(elements, part) : null;
  if (ct) return { connector: c.id, voltage: electricalFieldsOf(ct).voltage, poles: ct.poles };
  const voltage = c.voltage ?? num(type, part, "voltage");
  if (voltage === null) return null;
  return { connector: c.id, voltage, poles: c.poles ?? 1 };
}

/** The electrical connectors of a part, for choosing one when the sender didn't. Equipment with a nameplate voltage but no drawn connector has one: `power`. */
export function electricalConnectorIds(elements: Elements, part: PartInstance): string[] {
  const type = typeOf(elements, part);
  if (!type) return [];
  const entry = partConnectors(elements, part, type);
  const ids = entry.electrical.map((c) => c.id);
  if (ids.length === 0 && equipmentConnectionOf(entry, part)) return [EQUIPMENT_CONNECTOR];
  return ids;
}

/** The connector id equipment without a drawn electrical connector is circuited by. */
export const EQUIPMENT_CONNECTOR = "power";

const EQUIPMENT_CATEGORIES: ReadonlySet<string> = new Set(["mechanical_equipment", "air_terminal", "plumbing_fixture", "generic"]);

/**
 * Mechanical and other equipment that states a nameplate voltage and some
 * electrical rating (MCA, MOCP / MOP, FLA, a load) but has no drawn power
 * connector: it is circuited like a hardwired equipment connection. Poles
 * come from its phase parameter (3 for three-phase; one for a 120 / 277 V
 * single-phase unit, two otherwise).
 */
function equipmentConnection(type: PartTypeElement, part: PartInstance): ElectricalDemand | null {
  if (!EQUIPMENT_CATEGORIES.has(type.definition.category)) return null;
  const voltage = num(type, part, "voltage");
  if (voltage === null || voltage <= 0) return null;
  const rated = num(type, part, "mca", "mocp", "mop", "fla", "load_va", "load_w", "watts", "motor_hp", "hp", "heater_kw");
  if (rated === null) return null;
  const phase = num(type, part, "phases", "phase");
  const nominal = nominalVoltage(voltage);
  const poles = phase === 3 ? 3 : phase === 1 ? (nominal === 120 || nominal === 277 || nominal === 347 ? 1 : 2) : nominal !== null && nominal >= 440 ? 3 : nominal === 120 || nominal === 277 ? 1 : 2;
  return { connector: EQUIPMENT_CONNECTOR, voltage, poles };
}

/** The connection type a device names (`connection_type`, the same lookup fixtures and load points use: load-points/model.ts), when the catalog has it. */
export function connectionTypeOfPart(elements: Elements, part: PartInstance): ConnectionTypeEntry | null {
  const v = partConnectionTypeName(elements, part);
  return v !== null ? connectionTypeOf(elements, v) : null;
}

function needs(d: ElectricalDemand): string {
  const v = nominalVoltage(d.voltage) ?? d.voltage;
  return d.poles >= 3 ? `${v} V 3-phase` : d.poles === 2 ? `${v} V, 2 poles` : `${v} V, 1 pole`;
}

/**
 * Why `source` (supplying `system`) can't serve a load connector, in plain
 * words, or null when it can.
 */
export function loadRefusal(who: string, d: ElectricalDemand, sourceName: string, system: VoltageSystem): string | null {
  const v = nominalVoltage(d.voltage);
  const offered = `${sourceName} is ${voltageSystemLabel(system)}`;
  if (v === null) return `${who} is rated ${d.voltage} V, which is not a standard system voltage; correct its voltage before circuiting it`;
  if (d.poles > hotConductors(system)) return `${who} needs ${needs(d)}; ${offered}, so it can't serve it`;
  if (d.poles === 1) {
    if (system.lineToNeutral === null) return `${who} needs ${v} V line to neutral; ${offered} with no neutral, so it can't serve it`;
    if (system.lineToNeutral !== v) return `${who} needs ${needs(d)}; ${offered}, so it can't serve it`;
    return null;
  }
  if (system.lineToLine !== v) return `${who} needs ${needs(d)}; ${offered}, so it can't serve it`;
  return null;
}

/**
 * Why distribution equipment needing `supply` can't be fed from a source
 * supplying `system` through `poles` breaker poles, or null when it can.
 */
export function feederRefusal(who: string, supply: VoltageSystem, poles: number | null, sourceName: string, system: VoltageSystem): string | null {
  const offered = `${sourceName} is ${voltageSystemLabel(system)}`;
  if (supply.lineToLine !== system.lineToLine) return `${who} needs ${voltageSystemLabel(supply)}; ${offered}, so it can't feed it`;
  if (supply.phases > system.phases) return `${who} is ${supply.phases === 3 ? "3-phase" : "1-phase"}; ${offered}, so it can't feed it`;
  if (supply.wires === 4 && system.wires !== 4) return `${who} needs a neutral; ${offered}, so it can't feed it`;
  if (supply.lineToNeutral !== null && system.lineToNeutral !== null && supply.lineToNeutral !== system.lineToNeutral) return `${who} needs ${voltageSystemLabel(supply)}; ${offered}, so it can't feed it`;
  const hots = hotConductors(supply);
  if (poles !== null && poles !== hots) return `${who} has ${hots} hot conductor${hots === 1 ? "" : "s"}, so its feeder breaker needs ${hots} pole${hots === 1 ? "" : "s"}, not ${poles}`;
  return null;
}

/** Whether a pick that powers or feeds something can land on this part: distribution equipment, or a part with an electrical connection. */
export function powerPickable(elements: Elements, part: PartInstance): boolean {
  return distributionOf(elements, part) !== null || electricalConnectorIds(elements, part).length > 0;
}
