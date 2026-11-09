import { linkConstruction } from "../catalog/feeder-types";
import { linkServing, serviceLinkName, type ConductorSet, type ServiceLink, formatParam, paramValue, type BimElement, type ElementId, type ParamValue, type PartInstance, type PartTypeElement, formatFieldTemplateAt, type FieldOptions, type FieldPathInfo, type FieldResolverDef, type FieldScalar, type ResolvedField } from "@permitzip/bim-kernel";
import { electricalLoadOf, loadClassLabel } from "../connections/loads";
import { connectorLoadVa, memberName } from "../connections/panel";
import {
  distributionOf,
  electricalConnectorIds,
  electricalConnectorOf,
  electricalName,
  hotConductors,
  phaseOfSlot,
  PHASE_NAMES,
  voltageSystemLabel,
  type DistributionInfo,
  type VoltageSystem,
} from "../connections/systems";
import { feederTypeByMark, type FeederTypeRow } from "./feeder-types";
import { electricalEngineFor } from "./rules-registry";

/**
 * Field paths: the one place that says what a value printed on a drawing reads
 * from the model (G7, relationship-aware text). Schedules, tags and diagrams
 * ask for `bus_rating`, `supply.breaker` or `circuit.number` here instead of
 * each reading part values their own way, so every printed copy of a value is
 * the same live value and a template ("{feeder.source.name}[ via
 * {feeder.breaker}]") never holds dummy text.
 *
 * A path is a dot path from one element (a part or a circuit / feeder link):
 *
 *   bus_rating, mains_text, voltage_system   its own fields
 *   param.<name>                             any parameter
 *   supply.breaker, supply.text              the feeder that serves it, as the one-line prints it
 *   circuit.number         3,5               device → its circuit
 *   panel.name             L1                device → circuit → panel
 *   feeder.source.name     MDP               panel → its feeder → the board feeding it
 *   feeder.type.conductors 4#4/0, #4 G       feeder type catalog (WS-C)
 *   supply_from            MDP via 225A/3P via F225   (firm-editable template)
 *   demand_kva, kva_a      under the code rules named in `opts.rules`
 *
 * Every number is read, never recomputed: loads from the aggregation engine
 * (`ElectricalLoadEngine`) under the rules named by `rules`, member loads from
 * `electricalLoadOf`, ratings and conductors from what the engineer set on the
 * link. Unknown paths, broken chains and missing values resolve to a null value
 * with empty text, so a template drops them instead of printing a placeholder.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const DEFAULT_SUPPLY_FROM_TEMPLATE = "{feeder.source.name}[ via {feeder.breaker}][ via {feeder.type}]";

/** The distribution field paths (schedules, tags, diagrams, pickers, agent tools). `param.<name>` reads any parameter. */
export const ELECTRICAL_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "name", label: "Name (panel name, else mark, else type)", on: "any", example: "H1" },
  { path: "mark", label: "Mark", on: "any", example: "RTU-1" },
  { path: "type_name", label: "Type name", on: "any", example: "225A panelboard" },
  { path: "enclosure", label: "Enclosure", on: "any", example: "NEMA 1" },
  { path: "service", label: "Service it belongs to (normal, fire pump, house)", on: "any", example: "normal" },
  { path: "circuit", label: "Circuit (panel and number)", on: "device", example: "HP1-43,45" },
  { path: "circuit.number", label: "Circuit number only", on: "device", example: "43,45" },
  { path: "circuit.breaker", label: "Breaker", on: "device", example: "20A/1P" },
  { path: "circuit.conductors", label: "Conductors", on: "device", example: "2#10, #10 G" },
  { path: "panel", label: "Panel name", on: "device", example: "L1" },
  { path: "load", label: "Load (VA)", on: "device", example: "1,320" },
  { path: "load_class", label: "Load class", on: "device", example: "Kitchen" },
  { path: "voltage_phase", label: "Voltage and phase", on: "device", example: "460 V 3PH" },
  { path: "supply_from", label: "Supply from (firm template)", on: "panel", example: "MDP via 225A/3P via F225" },
  { path: "supply.text", label: "Supply from as the one-line prints it", on: "panel", example: "MDP via 225A/3P breaker, F225" },
  { path: "feeder.source.name", label: "Fed from", on: "panel", example: "MDP" },
  { path: "supply.circuit", label: "Feeder circuit", on: "panel", example: "MDP-1,3,5" },
  { path: "feeder.breaker", label: "Feeding breaker", on: "panel", example: "225A/3P" },
  { path: "supply.breaker", label: "Feeding breaker with frame", on: "panel", example: "400AF/225AT/3P" },
  { path: "feeder.type", label: "Feeder type", on: "panel", example: "F225" },
  { path: "feeder.type.conductors", label: "Feeder conductors (feeder type)", on: "panel", example: "4#4/0, #4 G" },
  { path: "supply.conductors", label: "Feeder conductors as the one-line prints them", on: "panel", example: "4#4/0 CU, 1#4 G" },
  { path: "supply.length_ft", label: "Feeder length, feet", on: "panel", example: "85" },
  { path: "bus", label: "Bus rating", on: "panel", example: "225A" },
  { path: "bus_rating", label: "Bus rating, amps", on: "panel", example: "225" },
  { path: "mains", label: "Mains: MLO or MCB", on: "panel", example: "MLO" },
  { path: "mains_text", label: "Mains as printed", on: "panel", example: "225A MCB" },
  { path: "volts", label: "Voltage", on: "panel", example: "277/480 V" },
  { path: "voltage_system", label: "Voltage system", on: "panel", example: "480Y/277V" },
  { path: "phases_wires", label: "Phases and wires", on: "panel", example: "3PH 4W" },
  { path: "primary_system", label: "Transformer primary", on: "panel", example: "480V Δ" },
  { path: "secondary_system", label: "Transformer secondary", on: "panel", example: "208Y/120V" },
  { path: "kva", label: "Transformer rating, kVA", on: "panel", example: "75" },
  { path: "kaic", label: "Short-circuit rating", on: "panel", example: "22 kAIC" },
  { path: "mounting", label: "Mounting", on: "panel", example: "Surface" },
  { path: "spaces", label: "Circuits / spaces", on: "panel", example: "42" },
  { path: "connected_kva", label: "Connected load (kVA)", on: "panel", example: "48.20" },
  { path: "demand_kva", label: "Demand load (kVA)", on: "panel", example: "41.75" },
  { path: "capacity_a", label: "True capacity (A)", on: "panel", example: "225" },
];

// ------------------------------------------------------------------ shared helpers

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

function raw(elements: Elements, part: PartInstance, name: string): ParamValue | undefined {
  const type = typeOf(elements, part);
  if (!type) return part.values[name];
  try {
    return paramValue(type.definition, part.values, name);
  } catch (err) {
    console.error("[fields] a parameter formula failed; the field reads empty", { partId: part.id, name, err });
    return undefined;
  }
}

function rawParam(elements: Elements, part: PartInstance, ...names: string[]): FieldScalar {
  for (const n of names) {
    const v = raw(elements, part, n);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "boolean") return v;
  }
  return null;
}

function rawText(elements: Elements, part: PartInstance, ...names: string[]): string | null {
  for (const n of names) {
    const v = raw(elements, part, n);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const kva = (va: number) => (Math.round(va / 10) / 100).toFixed(2);

/** "480Y/277V", "208Y/120V", "120/240V", "480V". */
export function voltageSystemText(s: VoltageSystem): string {
  if (s.lineToNeutral === null || s.lineToNeutral === s.lineToLine) return `${s.lineToLine}V`;
  if (s.phases === 3) return `${s.lineToLine}Y/${s.lineToNeutral}V`;
  return `${s.lineToNeutral}/${s.lineToLine}V`;
}

/** "3PH 4W". */
export function phasesWiresText(s: VoltageSystem): string {
  return `${s.phases}PH ${s.wires}W`;
}

/** "120/208 V" from a system. */
export function systemVolts(s: VoltageSystem): string {
  return s.lineToNeutral !== null && s.lineToNeutral !== s.lineToLine ? `${s.lineToNeutral}/${s.lineToLine} V` : `${s.lineToLine} V`;
}

/** "NEMA 1", "NEMA 3R": a bare rating gets the NEMA prefix. */
function enclosureText(v: FieldScalar): string {
  if (v === null || v === false) return "";
  const t = String(v).trim().toUpperCase();
  if (!t) return "";
  return /^NEMA/.test(t) ? t.replace(/^NEMA\s*/, "NEMA ") : `NEMA ${t.replace(/^TYPE\s*/, "")}`;
}

/** Conductors as a schedule writes them: "3#10, #10 G", "2 sets of 4#250, #2 G". Material prints in its own column. */
export function scheduleConductorText(c: ConductorSet, hots: number, neutral: boolean): string {
  const sets = Math.max(1, c.sets);
  const n = neutral ? (c.neutralSize ?? c.phaseSize) : c.neutralSize;
  const count = Math.max(1, hots) + (n && n === c.phaseSize ? 1 : 0);
  const parts = [`${count}#${c.phaseSize}`];
  if (n && n !== c.phaseSize) parts.push(`#${n} N`);
  if (c.groundSize) parts.push(`#${c.groundSize} G`);
  return `${sets > 1 ? `${sets} sets of ` : ""}${parts.join(", ")}`;
}

/** Conductors as one-lines print them: "4#4/0 AL, 1#4 AL G", "(2) SETS 4#350 CU, 1#1/0 G". `poles` is the breaker's poles (hot conductors). */
export function printedConductors(c: ConductorSet, poles: number): string {
  return oneLineConductorText(c, poles);
}

/** Conductors as the one-line writes them, material included: "4#4/0 CU, 1#4 G", "(2) SETS 4#250 AL…". */
export function oneLineConductorText(c: ConductorSet, hots: number): string {
  const phase = `${hots + (c.neutralSize ? 1 : 0)}#${c.phaseSize} ${c.material.toUpperCase()}`;
  const ground = c.groundSize ? `, 1#${c.groundSize} G` : "";
  return `${c.sets > 1 ? `(${c.sets}) SETS ` : ""}${phase}${c.neutralSize && c.neutralSize !== c.phaseSize ? ` (N #${c.neutralSize})` : ""}${ground}`;
}

// ------------------------------------------------------------------ supply.* (the feeder that serves a part, as the one-line prints it)

/** The feeder's own conductors, else its feeder type's (the catalog, CONNECTIONS.md "Electrical catalog"). */
function supplyConductorText(elements: Elements, link: ServiceLink): string {
  const built = linkConstruction(elements, link);
  if (!built.conductors) return "";
  return printedConductors(built.conductors, link.source.positions.length || built.feederType?.poles || 3);
}

interface Supply {
  readonly link: ServiceLink;
  readonly source: PartInstance;
  readonly sourceName: string;
}

/** The feeder that serves a part, through its input connector (else any served connector), and what is at the other end. */
export function supplyLinkOf(elements: Elements, part: PartInstance, info: DistributionInfo | null = distributionOf(elements, part)): Supply | null {
  const connector = info?.input ?? Object.keys(part.served ?? {}).sort()[0] ?? null;
  const link = connector ? linkServing(elements, part.id, connector) : null;
  const source = link ? elements[link.source.elementId] : undefined;
  if (!link || source?.kind !== "part") return null;
  return { link, source, sourceName: electricalName(elements, source) };
}

/** "225A/3P". `polesIfNoPositions`: a feed from equipment with no numbered positions (a tap box, meter, disconnect) still has the poles of what it feeds. */
function supplyBreakerText(link: ServiceLink, polesIfNoPositions: number | null): string {
  const e = link.electrical;
  if (e?.ratingA === undefined) return "";
  const poles = link.source.positions.length || polesIfNoPositions || 0;
  const frame = e.frameA !== undefined && e.frameA !== e.ratingA ? `${e.frameA}AF/${e.ratingA}AT` : `${e.ratingA}A`;
  return poles > 0 ? `${frame}/${poles}P` : frame;
}

function supplyField(elements: Elements, part: PartInstance, rest: string): FieldScalar {
  const s = supplyLinkOf(elements, part);
  if (!s) return null;
  const { link } = s;
  const e = link.electrical;
  const fedPoles = link.source.positions.length > 0 ? null : suppliedHots(elements, part);
  switch (rest) {
    case "source.name":
      return s.sourceName;
    case "circuit":
      return serviceLinkName(elements, link);
    case "positions":
      return link.source.positions.length > 0 ? [...link.source.positions].sort((a, b) => a - b).join(",") : null;
    case "breaker_a":
      return e?.ratingA ?? null;
    case "frame_a":
      return e?.frameA ?? null;
    case "poles":
      return link.source.positions.length > 0 ? link.source.positions.length : e?.ratingA !== undefined ? fedPoles : null;
    case "breaker":
      return supplyBreakerText(link, fedPoles) || null;
    case "feeder_type":
      return e?.feederType ?? null;
    case "conductors":
      return supplyConductorText(elements, link) || null;
    case "sets":
      return linkConstruction(elements, link).conductors?.sets ?? null;
    case "length_ft":
      return e?.lengthFt ?? null;
    case "text": {
      const breaker = supplyBreakerText(link, fedPoles);
      return `${s.sourceName}${breaker ? ` via ${breaker} breaker` : ""}${e?.feederType ? `, ${e.feederType}` : ""}`;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ a part's own fields

/** Own fields every client shares; a path here means the same thing on a schedule, a tag and the one-line. */
function ownDistributionField(elements: Elements, part: PartInstance, info: DistributionInfo | null, path: string): FieldScalar | undefined {
  switch (path) {
    case "bus_rating":
      return info?.busA ?? null;
    case "main_rating":
      return info?.mainA ?? null;
    case "mains":
      if (!info || info.kind === "transformer") return null;
      return info.mainA !== null ? "MCB" : "MLO";
    case "mains_text":
      if (!info || info.kind === "transformer") return null;
      return info.mainA !== null ? `${num(info.mainA)}A MCB` : "MLO";
    case "voltage_system":
      return info ? voltageSystemText(info.system) : null;
    case "voltage":
      return info ? info.system.lineToLine : null;
    case "phases":
      return info ? info.system.phases : null;
    case "wires":
      return info ? info.system.wires : null;
    case "phases_wires":
      return info ? phasesWiresText(info.system) : null;
    case "primary_system":
      return info?.kind === "transformer" ? `${voltageSystemText(info.supply)}${info.supply.lineToNeutral === null && info.supply.phases === 3 ? " Δ" : ""}` : null;
    case "secondary_system":
      return info?.kind === "transformer" ? voltageSystemText(info.system) : null;
    case "kva":
      return info?.kva ?? null;
    case "spaces":
      return info?.spaces ?? null;
    case "kaic": {
      const aic = rawParam(elements, part, "aic", "sccr", "kaic", "aic_rating");
      if (typeof aic !== "number") return typeof aic === "string" ? aic : null;
      // Ratings are entered in amps (22000) or, by some, in kA (22).
      return aic >= 1000 ? aic / 1000 : aic;
    }
    default:
      return undefined;
  }
}

/** A part's own field, or undefined when the path isn't one (the caller then tries computed and parameter fields). A null value is a known field with no value. */
function ownField(elements: Elements, part: PartInstance, path: string): ResolvedField | undefined {
  const out = (value: FieldScalar, text?: string): ResolvedField => ({ path, value, text: text ?? (value === null ? "" : typeof value === "number" ? num(value) : String(value)) });
  switch (path) {
    case "name":
      return out(electricalName(elements, part));
    case "mark":
      return out(part.mark || null);
    case "type_name":
      return out(typeOf(elements, part)?.definition.typeName ?? null);
    case "enclosure":
    case "nema": {
      const t = enclosureText(rawParam(elements, part, "enclosure", "nema", "nema_enclosure"));
      return out(t || null, t);
    }
    case "service": {
      const v = rawParam(elements, part, "service");
      return out(typeof v === "string" ? v.toLowerCase() : null);
    }
    case "kaic":
    case "aic": {
      const v = ownDistributionField(elements, part, distributionOf(elements, part), "kaic") ?? null;
      return out(v, typeof v === "number" ? `${num(v)} kAIC` : v === null ? "" : String(v));
    }
  }
  const info = distributionOf(elements, part);
  const d = ownDistributionField(elements, part, info, path);
  if (d === undefined) return undefined;
  // A distribution field on something that isn't distribution equipment reads its parameter of that name, if any.
  if (d === null && !info) return undefined;
  return out(d);
}

// ------------------------------------------------------------------ relationship hops

interface FieldValue {
  readonly text: string;
  readonly number?: number;
}

const EMPTY: FieldValue = { text: "" };
const numbered = (text: string, number: number): FieldValue => ({ text, number });

type Node = { readonly k: "part"; readonly part: PartInstance } | { readonly k: "link"; readonly link: ServiceLink } | { readonly k: "ftype"; readonly row: FeederTypeRow };

/** A parameter as schedules print it (with its unit), or empty. */
function paramField(elements: Elements, part: PartInstance, name: string): FieldValue {
  const type = typeOf(elements, part);
  const v = raw(elements, part, name);
  if (v === undefined || v === "") return EMPTY;
  const def = type ? [...type.definition.instanceParams, ...type.definition.typeParams].find((p) => p.name === name) : undefined;
  const text = def ? formatParam(def, v) : String(v);
  return typeof v === "number" ? { text, number: v } : { text };
}

function circuitOf(elements: Elements, part: PartInstance): ServiceLink | null {
  for (const connector of electricalConnectorIds(elements, part)) {
    const link = linkServing(elements, part.id, connector);
    if (link && link.role === "branch") return link;
  }
  return null;
}

function feederOfPart(elements: Elements, part: PartInstance, info: DistributionInfo | null): ServiceLink | null {
  const d = info ?? distributionOf(elements, part);
  return d?.input ? linkServing(elements, part.id, d.input) : null;
}

function hop(elements: Elements, node: Node, seg: string): Node | null {
  if (node.k === "part") {
    const info = distributionOf(elements, node.part);
    switch (seg) {
      case "circuit": {
        if (info) return null;
        const l = circuitOf(elements, node.part);
        return l ? { k: "link", link: l } : null;
      }
      case "feeder": {
        const l = feederOfPart(elements, node.part, info);
        return l ? { k: "link", link: l } : null;
      }
      case "panel":
      case "source": {
        const l = info ? feederOfPart(elements, node.part, info) : circuitOf(elements, node.part);
        const s = l ? partOf(elements, l.source.elementId) : null;
        return s ? { k: "part", part: s } : null;
      }
      default:
        return null;
    }
  }
  if (node.k === "link") {
    switch (seg) {
      case "source":
      case "panel": {
        const s = partOf(elements, node.link.source.elementId);
        return s ? { k: "part", part: s } : null;
      }
      case "fed":
      case "member": {
        const m = node.link.members[0];
        const p = m ? partOf(elements, m.elementId) : null;
        return p ? { k: "part", part: p } : null;
      }
      case "type": {
        const mark = node.link.electrical?.feederType;
        const row = mark ? feederTypeByMark(elements, mark) : null;
        return row ? { k: "ftype", row } : null;
      }
      default:
        return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ link fields (circuits and feeders)

function linkPoles(elements: Elements, link: ServiceLink): number {
  if (link.source.positions.length > 0) return link.source.positions.length;
  const m = link.members[0];
  const p = m ? partOf(elements, m.elementId) : null;
  if (!m || !p) return 0;
  if (link.role === "feeder") {
    const d = distributionOf(elements, p);
    return d ? hotConductors(d.supply) : 0;
  }
  return electricalConnectorOf(elements, p, m.connector)?.poles ?? 0;
}

function linkSystem(elements: Elements, link: ServiceLink): VoltageSystem | null {
  const s = partOf(elements, link.source.elementId);
  return s ? (distributionOf(elements, s)?.system ?? null) : null;
}

function linkLoadVa(elements: Elements, link: ServiceLink, opts: FieldOptions): number | null {
  const loads = electricalEngineFor(opts.rules).loads({ elements }, link.source.elementId);
  const l = loads?.links.find((x) => x.linkId === link.id);
  return l ? l.inventory.va : null;
}

/** The conductors a link prints: the engineer's set, else the rules' minimum for its breaker, else none. */
function linkConductors(link: ServiceLink, opts: FieldOptions): { readonly set: ConductorSet; readonly chosen: boolean } | null {
  const chosen = link.electrical?.conductors;
  if (chosen) return { set: chosen, chosen: true };
  const rating = link.electrical?.ratingA;
  const rules = electricalEngineFor(opts.rules).rules;
  if (rating === undefined || !rules.conductorsFor) return null;
  const min = rules.conductorsFor(rating, "cu");
  return min ? { set: { sets: 1, phaseSize: min.phaseSize, ...(min.groundSize ? { groundSize: min.groundSize } : {}), material: "cu" }, chosen: false } : null;
}

function linkField(elements: Elements, link: ServiceLink, field: string, opts: FieldOptions): FieldValue {
  const e = link.electrical;
  const positions = [...link.source.positions].sort((a, b) => a - b);
  switch (field) {
    case "name":
      return { text: serviceLinkName(elements, link) };
    case "number":
    case "positions":
      return positions.length > 0 ? { text: positions.join(","), number: positions[0] as number } : EMPTY;
    case "description":
      return { text: link.description };
    case "breaker": {
      const p = linkPoles(elements, link);
      return e?.ratingA !== undefined ? numbered(`${e.ratingA}A/${p}P`, e.ratingA) : EMPTY;
    }
    case "rating":
      return e?.ratingA !== undefined ? numbered(`${e.ratingA} A`, e.ratingA) : EMPTY;
    case "rating_a":
      return e?.ratingA !== undefined ? numbered(String(e.ratingA), e.ratingA) : EMPTY;
    case "frame":
      return e?.frameA !== undefined ? numbered(`${e.frameA}AF`, e.frameA) : EMPTY;
    case "poles": {
      const p = linkPoles(elements, link);
      return p > 0 ? numbered(String(p), p) : EMPTY;
    }
    case "phases": {
      const s = linkSystem(elements, link);
      return s && positions.length > 0 ? { text: positions.map((x) => PHASE_NAMES[phaseOfSlot(x, s)] ?? "A").join(",") } : EMPTY;
    }
    case "conductors":
    case "wire": {
      const c = linkConductors(link, opts);
      if (!c) return EMPTY;
      const p = linkPoles(elements, link);
      const s = linkSystem(elements, link);
      const neutral = s !== null && s.lineToNeutral !== null && (p === 1 || link.role === "feeder");
      return { text: scheduleConductorText(c.set, p, neutral) };
    }
    case "wire_size": {
      const c = linkConductors(link, opts);
      return c ? { text: `#${c.set.phaseSize}` } : EMPTY;
    }
    case "material": {
      const c = linkConductors(link, opts);
      return c ? { text: c.set.material.toUpperCase() } : EMPTY;
    }
    case "conductors_chosen":
      return { text: e?.conductors ? "yes" : "" };
    case "length":
      return e?.lengthFt !== undefined ? numbered(`${n0(e.lengthFt)}'`, e.lengthFt) : EMPTY;
    case "type":
    case "feeder_type":
      return e?.feederType ? { text: e.feederType } : EMPTY;
    case "load":
    case "load_va": {
      const va = linkLoadVa(elements, link, opts);
      return va !== null ? numbered(n0(va), va) : EMPTY;
    }
    case "load_kva": {
      const va = linkLoadVa(elements, link, opts);
      return va !== null ? numbered(kva(va), va / 1000) : EMPTY;
    }
    case "load_class": {
      if (e?.loadClass) return { text: e.loadClass };
      const m = link.members[0];
      const p = m ? partOf(elements, m.elementId) : null;
      return m && p ? { text: loadClassLabel(electricalLoadOf(elements, link, m, memberName(elements, p)).loadClass) } : EMPTY;
    }
    case "members":
      return numbered(String(link.members.length), link.members.length);
    default:
      return EMPTY;
  }
}

// ------------------------------------------------------------------ computed fields on parts

/** Distribution fields WS-D's schedules print in their own format, plus the engine's loads and demand. */
function computedDistributionField(elements: Elements, part: PartInstance, info: DistributionInfo, field: string, opts: FieldOptions, depth: number): FieldValue | null {
  switch (field) {
    case "kind":
      return { text: info.kind };
    case "bus":
      return info.busA !== null ? numbered(`${info.busA}A`, info.busA) : EMPTY;
    case "bus_a":
      return info.busA !== null ? numbered(String(info.busA), info.busA) : EMPTY;
    case "main_a":
      return info.mainA !== null ? numbered(String(info.mainA), info.mainA) : EMPTY;
    case "system":
      return { text: voltageSystemLabel(info.system) };
    case "volts":
      return { text: systemVolts(info.system) };
    case "mounting":
      return { text: rawText(elements, part, "mounting") ?? "" };
    case "supply_from":
    case "fed_from":
      if (depth > 3) return EMPTY;
      return { text: formatFieldTemplateAt(elements, part.id, opts.supplyFrom ?? DEFAULT_SUPPLY_FROM_TEMPLATE, opts, depth + 1).text };
    default:
      break;
  }
  const engine = electricalEngineFor(opts.rules);
  const report = engine.report({ elements }, part.id);
  if (!report) return null;
  switch (field) {
    case "connected_va":
      return numbered(n0(report.connectedVa), report.connectedVa);
    case "connected_kva":
      return numbered(kva(report.connectedVa), report.connectedVa / 1000);
    case "connected_a":
      return numbered(n0(report.connectedA), report.connectedA);
    case "demand_va":
      return numbered(n0(report.demand.demandVa), report.demand.demandVa);
    case "demand_kva":
      return numbered(kva(report.demand.demandVa), report.demand.demandVa / 1000);
    case "demand_a":
      return numbered(n0(report.demandA), report.demandA);
    case "capacity_a":
      return report.capacity.limitA !== null ? numbered(n0(report.capacity.limitA), report.capacity.limitA) : EMPTY;
    case "capacity":
      return { text: report.capacity.reason };
    case "rules":
      return { text: report.rules.label };
    case "kva_a":
    case "kva_b":
    case "kva_c":
    case "amps_a":
    case "amps_b":
    case "amps_c": {
      const phase = field.slice(-1).toUpperCase();
      const p = report.perPhase.find((x) => x.phase === phase);
      if (!p) return EMPTY;
      return field.startsWith("kva") ? numbered(kva(p.va), p.va / 1000) : numbered(n0(p.amps), p.amps);
    }
    default:
      return null;
  }
}

const LOAD_FIELDS = new Set(["load", "load_va", "load_kva", "load_class", "poles", "voltage_phase"]);

function loadField(elements: Elements, part: PartInstance, field: string): FieldValue | null {
  if (!LOAD_FIELDS.has(field)) return null;
  const connector = electricalConnectorIds(elements, part)[0];
  if (!connector) return null;
  const link = linkServing(elements, part.id, connector);
  const demand = electricalConnectorOf(elements, part, connector);
  switch (field) {
    case "load":
    case "load_va":
    case "load_kva":
    case "load_class": {
      const load = link ? electricalLoadOf(elements, link, { elementId: part.id, connector }, memberName(elements, part)) : null;
      if (field === "load_class") return load ? { text: loadClassLabel(load.loadClass) } : null;
      const va = load ? load.va : connectorLoadVa(elements, part, connector);
      if (va === null || !(va > 0)) return null;
      return field === "load_kva" ? numbered(kva(va), va / 1000) : numbered(n0(va), va);
    }
    case "poles":
      return demand ? numbered(String(demand.poles), demand.poles) : null;
    case "voltage_phase": {
      if (!demand) return null;
      return { text: `${n0(demand.voltage)} V ${demand.poles >= 3 ? "3PH" : "1PH"}` };
    }
    default:
      return null;
  }
}

function ftypeField(r: FeederTypeRow, field: string): FieldValue {
  switch (field) {
    case "mark":
    case "name":
      return { text: r.mark };
    case "description":
      return { text: r.description ?? "" };
    case "conductors":
      return r.conductors ? { text: scheduleConductorText(r.conductors, 3, Boolean(r.conductors.neutralSize)) } : EMPTY;
    case "material":
      return r.conductors ? { text: r.conductors.material.toUpperCase() } : EMPTY;
    case "sets":
      return r.conductors ? numbered(String(r.conductors.sets), r.conductors.sets) : EMPTY;
    case "ground":
      return r.conductors?.groundSize ? { text: `#${r.conductors.groundSize}` } : EMPTY;
    case "conduit_below_grade":
      return { text: r.conduitBelowGrade ?? "" };
    case "conduit_above_grade":
    case "conduit":
      return { text: r.conduitAboveGrade ?? r.conduitBelowGrade ?? "" };
    case "feeders":
      return numbered(String(r.feederIds.length), r.feederIds.length);
    default:
      return EMPTY;
  }
}

const fromScalar = (path: string, v: FieldValue): ResolvedField => ({ path, value: v.number ?? (v.text === "" ? null : v.text), text: v.text });

function terminal(elements: Elements, node: Node, path: string, field: string, opts: FieldOptions, depth: number): ResolvedField {
  if (node.k === "link") return fromScalar(path, linkField(elements, node.link, field, opts));
  if (node.k === "ftype") return fromScalar(path, ftypeField(node.row, field));
  const part = node.part;
  const own = ownField(elements, part, field);
  if (own) return { ...own, path };
  const info = distributionOf(elements, part);
  if (info) {
    const v = computedDistributionField(elements, part, info, field, opts, depth);
    if (v !== null) return fromScalar(path, v);
  } else {
    if (field === "circuit") {
      const l = circuitOf(elements, part);
      // Live circuit first; a circuit typed into a parameter before circuits existed still reads until it is linked.
      return fromScalar(path, l ? { text: serviceLinkName(elements, l) } : paramField(elements, part, "circuit"));
    }
    const v = loadField(elements, part, field);
    if (v !== null) return fromScalar(path, v);
  }
  if (field === "type") return fromScalar(path, { text: typeOf(elements, part)?.definition.typeName ?? "" });
  if (field === "level") {
    const level = elements[part.levelId];
    return fromScalar(path, level?.kind === "level" ? { text: level.name } : EMPTY);
  }
  return fromScalar(path, paramField(elements, part, field));
}

const HOP_NAMES = new Set(["circuit", "feeder", "panel", "source", "fed", "member", "type"]);

function nodeOf(elements: Elements, id: string): Node | null {
  const el = elements[id];
  if (el?.kind === "part") return { k: "part", part: el };
  if (el?.kind === "service_link") return { k: "link", link: el };
  return null;
}

const none = (path: string): ResolvedField => ({ path, value: null, text: "" });

function resolveDepth(elements: Elements, elementId: string, path: string, opts: FieldOptions, depth: number): ResolvedField {
  let node = nodeOf(elements, elementId);
  if (!node) return none(path);
  const segs = path.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return none(path);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    const rest = segs.slice(i + 1).join(".");
    if (node.k === "part" && seg === "param" && rest) {
      const v = rawParam(elements, node.part, rest);
      return { path, value: v, text: v === null ? "" : typeof v === "number" ? num(v) : String(v) };
    }
    if (node.k === "part" && seg === "supply" && rest) {
      const v = supplyField(elements, node.part, rest);
      return { path, value: v, text: v === null ? "" : typeof v === "number" ? num(v) : String(v) };
    }
    if (i === segs.length - 1) {
      // A path ending on a hop ("feeder.source", "panel", "circuit") prints what it reaches, by name.
      const reached = HOP_NAMES.has(seg) ? hop(elements, node, seg) : null;
      if (reached) return reached.k === "ftype" ? { path, value: reached.row.mark, text: reached.row.mark } : terminal(elements, reached, path, "name", opts, depth);
      return terminal(elements, node, path, seg, opts, depth);
    }
    const next: Node | null = hop(elements, node, seg);
    if (!next) return none(path);
    node = next;
  }
  return none(path);
}

/** A field of a feeder type by mark (the feeder schedule's rows): mark, conductors, material, ground, conduit_below_grade, conduit_above_grade, feeders. */
export function feederTypeField(elements: Elements, mark: string, field: string): ResolvedField {
  const row = feederTypeByMark(elements, mark);
  return row ? fromScalar(field, ftypeField(row, field)) : none(field);
}

/** The hot conductors of what a part supplies (the poles its feeder breaker needs), or null. */
export function suppliedHots(elements: Elements, part: PartInstance): number | null {
  const info = distributionOf(elements, part);
  return info ? hotConductors(info.supply) : null;
}

/** `param.<name>` / `supply.<field>`, or hops (circuit, feeder, panel…) ending on a field. */
function resolvableHere(path: string): boolean {
  const segs = path.split(".").map((s) => s.trim());
  if (segs.some((s) => s === "")) return false;
  if (segs.length >= 2 && (segs[0] === "param" || segs[0] === "supply")) return true;
  return segs.slice(0, -1).every((s) => HOP_NAMES.has(s));
}

const COMPUTED_BARE = new Set([
  "circuit", "panel", "feeder", "source", "supply_from", "fed_from", "load", "load_va", "load_kva", "load_class", "voltage_phase",
  "bus", "bus_rating", "main_rating", "mains", "mains_text", "volts", "voltage_system", "primary_system", "secondary_system",
  "kaic", "phases_wires", "connected_kva", "demand_kva", "connected_a", "demand_a", "capacity_a",
]);

// ------------------------------------------------------------------ the row

function supplyReads(elements: Elements, elementId: string): readonly ElementId[] {
  const el = elements[elementId];
  const supply = el?.kind === "part" ? supplyLinkOf(elements, el) : null;
  return supply ? [supply.link.id, supply.source.id] : [];
}

/** Distribution fields as a row of `FIELD_RESOLVER_POINT` (the Electrical pack's). Last in resolution order, first in the path list. */
export const ELECTRICAL_FIELD_RESOLVER: FieldResolverDef = {
  id: "electrical",
  resolveRank: 50,
  listRank: 10,
  paths: ELECTRICAL_FIELD_PATHS,
  resolve: (elements, elementId, path, opts, depth) => resolveDepth(elements, elementId, path, opts, depth),
  resolvable: resolvableHere,
  computedBare: COMPUTED_BARE,
  reads: supplyReads,
};
