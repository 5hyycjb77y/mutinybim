import { paramValue, resolveConnectors, type BimElement, type PartInstance, type PartTypeElement, connectionTypeOf, partConnectionTypeName, type ServiceLink, type ElectricalLoadClass } from "@permitzip/bim-kernel";
import { electricalFieldsOf } from "../catalog/connection-fields";
import { electricalConnectorOf } from "./systems";
import type { ElectricalRules } from "./rules";

type Elements = Readonly<Record<string, BimElement>>;

/** What a served member contributes, as connected (no demand factor yet), by load class (load-classes.ts). */

const LABELS: Readonly<Record<ElectricalLoadClass, string>> = {
  lighting: "Lighting",
  receptacle: "Receptacles",
  kitchen: "Kitchen equipment",
  motor: "Motors",
  hvac: "HVAC equipment",
  heating: "Heating",
  cooling: "Cooling",
  other: "Other",
};

export function loadClassLabel(c: ElectricalLoadClass): string {
  return LABELS[c];
}

/** Words people write in a load class field, onto the classes the code packs know. */
const ALIASES: Readonly<Record<string, ElectricalLoadClass>> = {
  light: "lighting",
  lights: "lighting",
  lighting: "lighting",
  receptacle: "receptacle",
  receptacles: "receptacle",
  outlet: "receptacle",
  power: "receptacle",
  kitchen: "kitchen",
  "220.56": "kitchen",
  "220.56_kitchen": "kitchen",
  kitchen_equipment: "kitchen",
  motor: "motor",
  motors: "motor",
  hvac: "hvac",
  mechanical: "hvac",
  heating: "heating",
  heat: "heating",
  cooling: "cooling",
  other: "other",
  continuous: "other",
  water_heating: "other",
  water_heater: "other",
};

/** A load class from what someone typed ("220.56 Kitchen", "HVAC"), or null when it names none. */
export function parseLoadClass(text: string): ElectricalLoadClass | null {
  const key = text.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[key] ?? null;
}

/** One member connector's connected load. */
export interface MemberLoad {
  readonly elementId: string;
  readonly connector: string;
  readonly name: string;
  readonly va: number;
  readonly loadClass: ElectricalLoadClass;
  /** Runs 3 hours or more: sized at 125%. From the connection type, connector or part when they say; else the rules' default for the class (lighting only without rules). */
  readonly continuous: boolean;
  /** Where the class came from, for the explanation trail. */
  readonly classFrom: "circuit" | "connection_type" | "connector" | "part" | "category";
  /** Where the VA came from: the device's connection type, the connector's design load, a load parameter, the motor tables, MCA or FLA x volts, or nothing found. */
  readonly from: "connection_type" | "connector" | "parameter" | "motor_table" | "mca" | "fla" | "none";
  /** The connection type the load came from ("E.05"), when it did. */
  readonly connectionType?: string;
  /** For a load from the motor tables: the basis and clauses. */
  readonly basis?: { readonly text: string; readonly cite: readonly string[] };
}

/** A motor's VA from the code tables (430.248 / 430.250), supplied by the rules; null when the table has no such motor. */
export type MotorLoad = (hp: number, volts: number, poles: number) => { readonly va: number; readonly text: string; readonly cite: readonly string[] } | null;

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function num(type: PartTypeElement, part: PartInstance, ...names: string[]): number | null {
  for (const n of names) {
    const v = paramValue(type.definition, part.values, n);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function classFromCategory(type: PartTypeElement, part: PartInstance): ElectricalLoadClass {
  const d = type.definition;
  const words = `${d.familyName} ${d.typeName}`;
  switch (d.category) {
    case "lighting_fixture":
      return "lighting";
    case "mechanical_equipment":
      if (/water heater/i.test(words)) return "other";
      return num(type, part, "motor_hp", "hp") !== null && !/rooftop|air handl|condens|heat pump|\bahu\b|\brtu\b|makeup|make-up|\bmau\b/i.test(words) ? "motor" : "hvac";
    case "electrical_device":
      return /receptacle|outlet/i.test(words) ? "receptacle" : "other";
    default:
      return "other";
  }
}

/** What the part says about running 3 hours or more; null when it says nothing, so the code rules decide by class. */
function continuousOf(type: PartTypeElement, part: PartInstance): boolean | null {
  const v = paramValue(type.definition, part.values, "continuous");
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim() !== "") return /^(y|yes|true|1|continuous)$/i.test(v.trim());
  return /water heater/i.test(type.definition.familyName) ? true : null;
}

/**
 * The connected load of one member connector. VA: the device's connection
 * type, else the connector's design load, else a `load_va` / `va` parameter,
 * else `load_w` / `watts` / `input_w` over the power factor, else a motor's
 * horsepower through the code tables, else MCA (or FLA) x volts (x √3 for
 * three poles) for equipment that gives only its nameplate amps. Class: the
 * circuit's override, else the connection type, else the connector's, else
 * the part's `load_class`, else its category. Continuous likewise.
 */
export function electricalLoadOf(elements: Elements, link: Pick<ServiceLink, "electrical">, member: { readonly elementId: string; readonly connector: string }, name: string, rules: Pick<ElectricalRules, "motorLoad" | "continuousByDefault"> = {}): MemberLoad {
  const motorLoad = rules.motorLoad;
  const base = { elementId: member.elementId, connector: member.connector, name };
  const part = elements[member.elementId];
  const type = part?.kind === "part" ? typeOf(elements, part) : null;
  if (part?.kind !== "part" || !type) return { ...base, va: 0, loadClass: "other", continuous: false, classFrom: "category", from: "none" };
  const connectors = resolveConnectors(type.definition, part.values).filter((c) => c.domain === "electrical");
  const connector = connectors.find((c) => c.id === member.connector);
  const ctValue = partConnectionTypeName(elements, part);
  const ct = ctValue !== null && (connectors.length === 0 || connectors[0]?.id === member.connector) ? connectionTypeOf(elements, ctValue) : null;
  const ef = ct ? electricalFieldsOf(ct) : null;
  const fromLink = link.electrical?.loadClass ? parseLoadClass(link.electrical.loadClass) : null;
  const fromConnector = connector?.loadClass ? parseLoadClass(connector.loadClass) : null;
  const own = paramValue(type.definition, part.values, "load_class");
  const fromPart = typeof own === "string" ? parseLoadClass(own) : null;
  const loadClass = fromLink ?? ef?.loadClass ?? fromConnector ?? fromPart ?? classFromCategory(type, part);
  const classFrom = fromLink ? ("circuit" as const) : ct ? ("connection_type" as const) : fromConnector ? ("connector" as const) : fromPart ? ("part" as const) : ("category" as const);
  const continuous = ct ? ct.continuous : (connector?.continuous ?? continuousOf(type, part) ?? (rules.continuousByDefault ? rules.continuousByDefault(loadClass) : loadClass === "lighting"));
  const cls = { loadClass, classFrom, continuous, ...(ct ? { connectionType: ct.designator } : {}) };
  // Equipment circuited by its nameplate (no drawn connector) reads its voltage and poles the way circuiting does.
  const equipment = !connector && connectors.length === 0 ? electricalConnectorOf(elements, part, member.connector) : null;
  const volts = ef?.voltage ?? connector?.voltage ?? equipment?.voltage ?? num(type, part, "voltage");
  const poles = ct?.poles ?? connector?.poles ?? equipment?.poles ?? 1;
  const motor = (hp: number | null | undefined): MemberLoad | null => {
    if (!motorLoad || !hp || hp <= 0 || volts === null) return null;
    const m = motorLoad(hp, volts, poles);
    return m ? { ...base, ...cls, va: m.va, from: "motor_table", basis: { text: m.text, cite: m.cite } } : null;
  };
  if (ct) {
    if (ef && ef.loadVa > 0) return { ...base, ...cls, va: ef.loadVa, from: "connection_type" };
    const fromHp = motor(ct.motorHp);
    if (fromHp) return fromHp;
  }
  if (connector?.flow !== undefined && connector.flow > 0) return { ...base, ...cls, va: connector.flow, from: "connector" };
  const va = num(type, part, "load_va", "va", "load");
  if (va !== null && va > 0) return { ...base, ...cls, va, from: "parameter" };
  const w = num(type, part, "load_w", "watts", "input_w");
  if (w !== null && w > 0) {
    const pf = num(type, part, "power_factor");
    return { ...base, ...cls, va: w / (pf !== null && pf > 0 && pf <= 1 ? pf : 1), from: "parameter" };
  }
  const fromHp = motor(connector?.motorHp ?? num(type, part, "motor_hp", "hp"));
  if (fromHp) return fromHp;
  const perAmp = volts !== null ? volts * (poles >= 3 ? Math.sqrt(3) : 1) : null;
  const mca = num(type, part, "mca");
  if (mca !== null && mca > 0 && perAmp !== null) return { ...base, ...cls, va: mca * perAmp, from: "mca" };
  const fla = num(type, part, "fla");
  if (fla !== null && fla > 0 && perAmp !== null) return { ...base, ...cls, va: fla * perAmp, from: "fla" };
  return { ...base, ...cls, va: 0, from: "none" };
}
