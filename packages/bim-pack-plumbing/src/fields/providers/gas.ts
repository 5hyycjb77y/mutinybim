import { gasConnectionRowsOf, type GasConnectionRow } from "../../routing/pipe/gas-connections";
import type { GasNetwork } from "../../routing/pipe/gas-zones";
import type { FieldProvider, BimElement, ElementId, ServesRuleDef } from "@permitzip/bim-kernel";
import { elementsOfKind, finite, locked, resolvedNumber, resolvedText, typeParam, type ProviderField } from "@permitzip/bim-kernel";
import { gasNetworkOf, gasPipeQuantities } from "../gas";

/**
 * Gas fields: the gas segment tag values on a pipe, and on every gas outlet
 * (an appliance or a load point on a pipe end) its input and the `source.*`
 * path values: developed length from the source, the pressure zone and its
 * inlet pressure. All of it is the Gas agent's walk (`gasNetwork` →
 * `gasConnectionRowsOf`), read once per model state; nothing here walks pipe.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface GasIndex {
  readonly networks: readonly GasNetwork[];
  /** One row per gas outlet, by outlet element id. */
  readonly rows: ReadonlyMap<ElementId, GasConnectionRow>;
  /** The network an element is the source of, or a regulator in. */
  readonly networkOf: ReadonlyMap<ElementId, GasNetwork>;
}

const indexes = new WeakMap<Elements, GasIndex>();

/** Every gas system's walk and outlet rows, once per model state. */
export function gasIndex(elements: Elements): GasIndex {
  const cached = indexes.get(elements);
  if (cached) return cached;
  const networks: GasNetwork[] = [];
  const rows = new Map<ElementId, GasConnectionRow>();
  const networkOf = new Map<ElementId, GasNetwork>();
  for (const system of elementsOfKind(elements, "mep_system")) {
    if (system.systemKind !== "natural_gas") continue;
    const net = gasNetworkOf(elements, system.id);
    if (!net) continue;
    networks.push(net);
    for (const row of gasConnectionRowsOf(net)) if (!rows.has(row.elementId)) rows.set(row.elementId, row);
    if (net.sourceId) networkOf.set(net.sourceId, net);
    for (const reg of net.regulators) networkOf.set(reg.elementId, net);
  }
  const index: GasIndex = { networks, rows, networkOf };
  indexes.set(elements, index);
  return index;
}

/** The outlets a gas source or regulator supplies: every appliance downstream, through the zones below it. */
export function gasOutletsServedBy(elements: Elements, id: ElementId): readonly ElementId[] {
  const net = gasIndex(elements).networkOf.get(id);
  if (!net) return [];
  if (net.sourceId === id) return net.appliances.map((a) => a.elementId);
  const out: ElementId[] = [];
  const zonesByRegulator = new Map(net.zones.filter((z) => z.regulatorId !== null).map((z) => [z.regulatorId as ElementId, z]));
  const stack = [id];
  const seen = new Set<ElementId>();
  while (stack.length > 0) {
    const reg = stack.pop() as ElementId;
    if (seen.has(reg)) continue;
    seen.add(reg);
    const zone = zonesByRegulator.get(reg);
    if (!zone) continue;
    out.push(...zone.applianceIds);
    stack.push(...zone.regulatorIds);
  }
  return out;
}

/** Gas outlets: equipment and fixtures that burn gas, and load points on gas pipe ends. */
const OUTLETS = ["mep.equipment", "mep.plumbing_fixture", "mep.load_point"];
const PIPE = ["mep.pipe", "mep.run_fitting"];
const WALK = "Measured along the routed gas pipe from the source.";

const row = (el: BimElement, elements: Elements): GasConnectionRow | undefined => gasIndex(elements).rows.get(el.id);

const outletFields: ProviderField[] = [
  {
    path: "own.mbh",
    label: "Gas input",
    classes: OUTLETS,
    valueType: "quantity",
    kind: "flow_gas_energy",
    unit: "MBH",
    writer: typeParam("input_mbh"),
    deps: { elementKinds: ["part", "part_type", "load_point", "service_catalog"] },
    group: "Own load",
    description: "What the item burns. Counts on its gas system; never on the systems it serves.",
    read: (el, ctx) => finite(row(el, ctx.elements)?.inputMbh),
  },
  {
    path: "source.developed_length",
    label: "Length from the gas source",
    classes: OUTLETS,
    valueType: "quantity",
    kind: "length",
    unit: "ft",
    aggregation: "max",
    writer: locked(WALK),
    deps: { connections: true },
    group: "Source",
    read: (el, ctx) => finite(row(el, ctx.elements)?.developedLengthFt),
  },
  {
    path: "source.zone_length",
    label: "Length from the start of its pressure zone",
    classes: OUTLETS,
    valueType: "quantity",
    kind: "length",
    unit: "ft",
    aggregation: "max",
    writer: locked(WALK),
    deps: { connections: true },
    group: "Source",
    read: (el, ctx) => finite(row(el, ctx.elements)?.zoneLengthFt),
  },
  {
    path: "source.pressure",
    label: "Inlet pressure of its zone",
    classes: OUTLETS,
    valueType: "quantity",
    kind: "pressure",
    unit: "in_wc",
    aggregation: "none",
    writer: locked("Set by the regulator that starts the zone."),
    deps: { connections: true },
    group: "Source",
    read: (el, ctx) => finite(row(el, ctx.elements)?.zoneInletInWc),
  },
  {
    path: "source.zone",
    label: "Pressure zone",
    classes: OUTLETS,
    valueType: "text",
    writer: locked("Set by the regulator that starts the zone."),
    deps: { connections: true },
    group: "Source",
    read: (el, ctx) => row(el, ctx.elements)?.zoneLabel || null,
  },
];

const pipeFields: ProviderField[] = [
  { path: "gas.length", label: "Gas pipe developed length", classes: PIPE, valueType: "quantity", kind: "length", unit: "ft", writer: locked("Measured from the drawn pipe."), group: "Gas", read: (el, ctx) => finite(gasPipeQuantities(ctx.elements, el.id)?.lengthFt) },
  { path: "gas.from_source", label: "Length from the gas source to the end of this pipe", classes: PIPE, valueType: "quantity", kind: "length", unit: "ft", aggregation: "max", writer: locked(WALK), deps: { connections: true }, group: "Gas", read: (el, ctx) => finite(gasPipeQuantities(ctx.elements, el.id)?.fromSourceFt) },
  { path: "gas.zone", label: "Gas pressure zone inlet", classes: PIPE, valueType: "quantity", kind: "pressure", unit: "in_wc", aggregation: "none", writer: locked("Set by the regulator that starts the zone."), deps: { connections: true }, group: "Gas", read: (el, ctx) => finite(gasPipeQuantities(ctx.elements, el.id)?.zoneInWc) },
  { path: "gas.zone_longest", label: "Longest developed length in this pipe's pressure zone", classes: PIPE, valueType: "quantity", kind: "length", unit: "ft", aggregation: "none", writer: locked(WALK), deps: { connections: true }, group: "Gas", read: resolvedNumber("gas.zone_longest") },
  { path: "gas.carries_cfh", label: "Gas flow this pipe carries", classes: PIPE, valueType: "quantity", kind: "flow_gas_volume", unit: "cfh", aggregation: "none", writer: locked(WALK), deps: { connections: true }, group: "Gas", read: resolvedNumber("gas.carries_cfh") },
  { path: "gas.heating_value", label: "Heating value of the gas", classes: PIPE, valueType: "text", writer: locked("Set on the gas system."), group: "Gas", read: resolvedText("gas.heating_value") },
  ...([["gas.tag", "Gas segment tag"], ["gas.size", "Gas pipe size"], ["gas.fuel", "Gas"]] as const).map(
    ([path, label]): ProviderField => ({ path, label, classes: PIPE, valueType: "text", writer: locked(path === "gas.fuel" ? "Set on the gas system." : "Measured from the drawn pipe."), group: "Gas", read: resolvedText(path) }),
  ),
];

export const GAS_FIELD_PROVIDER: FieldProvider = {
  id: "mep.gas",
  fields: [...outletFields, ...pipeFields],
};

/** Gas's `serves` walk (`SERVES_RULE_POINT`): meters and regulators serve the appliances of their zones; an outlet's source is its system's source. Before the piped walk, as before. */
export const GAS_SERVES_RULE: ServesRuleDef = {
  id: "gas",
  rank: 10,
  systemKinds: ["natural_gas"],
  served: (elements, id) => gasOutletsServedBy(elements, id),
  *sources(elements) {
    for (const net of gasIndex(elements).networks) if (net.sourceId) for (const a of net.appliances) yield [a.elementId, net.sourceId] as const;
  },
  servers: (elements) => gasIndex(elements).networkOf.keys(),
  sourceOf(elements, id) {
    const gas = gasIndex(elements);
    const row = gas.rows.get(id);
    if (!row) return null;
    return gas.networks.find((n) => n.systemId === row.systemId)?.sourceId ?? null;
  },
};
