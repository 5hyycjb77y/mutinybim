import { connectionTypeSchema, type ConnectionFieldValue, type ConnectionTypeEntry, type ConnectionTypeInput } from "@permitzip/bim-kernel";
import type { Dim, ParamDef, PartCategory, PartConnector, PartTypeDefinition, SystemKind, LibraryEntry } from "@permitzip/bim-kernel";

/**
 * The starter plumbing library: fixtures, equipment and accessories, each
 * shipped with a starter connection type rather than loads of its own. The
 * part names the type (`default_connection_type`); a load point or a placed
 * fixture uses the type, and the project's catalog holds the values the
 * engineer adopts.
 *
 * The starter values are typical public-use figures for illustration and are
 * labelled "verify for permit work": the code tables (IPC 604.3 / E103.3,
 * 709.1, IFGC appliance inputs) come from the code packs (bim-calc) and the
 * firm's adopted tables, not from here. Generic, made-up types; no product is
 * named.
 */

const IN = 25.4;
const VERIFY = "Starter values, verify for permit work";

/** `fields`: another add-on's connection fields by stored key (Electrical's `loadVa`, `voltage`, `loadClass`), read and checked by that add-on's rows (`CONNECTION_FIELD_POINT`). */
const ct = (e: Omit<ConnectionTypeInput, "type" | "comments"> & { readonly comments?: string }, fields: Readonly<Record<string, ConnectionFieldValue>> = {}): ConnectionTypeEntry =>
  connectionTypeSchema.parse({ type: "connection_type", comments: VERIFY, ...e, ...fields });

/** Starter connection types, by designator. Added to a project's catalog the first time a load point or fixture names one. */
export const PLUMBING_STARTER_CONNECTION_TYPES: readonly ConnectionTypeEntry[] = [
  ct({ designator: "WC-FT", trade: "plumbing", description: "Water closet, flush tank", quantities: { wsfu_cold: 5, wsfu_total: 5, dfu: 4, sizes: { cw: '1/2"', w: '3"', v: '2"' } } }),
  ct({ designator: "WC-FV", trade: "plumbing", description: "Water closet, flushometer valve", quantities: { wsfu_cold: 10, wsfu_total: 10, dfu: 4, min_inlet_pressure: 25, sizes: { cw: '1"', w: '3"', v: '2"' } } }),
  ct({ designator: "UR", trade: "plumbing", description: "Urinal, flushometer valve", quantities: { wsfu_cold: 5, wsfu_total: 5, dfu: 4, min_inlet_pressure: 15, sizes: { cw: '3/4"', w: '2"', v: '1-1/2"' } } }),
  ct({ designator: "LAV", trade: "plumbing", description: "Lavatory", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 1, gph_demand: 4, sizes: { cw: '1/2"', hw: '1/2"', w: '1-1/4"', v: '1-1/4"' } } }),
  ct({ designator: "HS", trade: "plumbing", description: "Hand sink", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 1, gph_demand: 5, sizes: { cw: '1/2"', hw: '1/2"', w: '1-1/2"', v: '1-1/4"' } } }),
  ct({ designator: "SK1", trade: "plumbing", description: "Sink, one compartment", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 2, gph_demand: 10, sizes: { cw: '1/2"', hw: '1/2"', w: '1-1/2"', v: '1-1/2"' } } }),
  ct({ designator: "SK2", trade: "plumbing", description: "Sink, two compartment", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 3, gph_demand: 20, sizes: { cw: '1/2"', hw: '1/2"', w: '2"', v: '1-1/2"' } } }),
  ct({ designator: "SK3", trade: "plumbing", description: "Sink, three compartment", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 4, gph_demand: 30, sizes: { cw: '1/2"', hw: '1/2"', w: '2"', v: '1-1/2"' } } }),
  ct({ designator: "MS", trade: "plumbing", description: "Mop sink", quantities: { wsfu_cold: 2.25, wsfu_hot: 2.25, wsfu_total: 3, dfu: 3, gph_demand: 10, sizes: { cw: '1/2"', hw: '1/2"', w: '3"', v: '1-1/2"' } } }),
  ct({ designator: "FD", trade: "plumbing", description: "Floor drain", quantities: { dfu: 2, sizes: { w: '2"', v: '1-1/2"' } } }),
  ct({ designator: "FS", trade: "plumbing", description: "Floor sink", quantities: { dfu: 2, sizes: { w: '3"', v: '1-1/2"' } } }),
  ct({ designator: "TD", trade: "plumbing", description: "Trench drain", quantities: { dfu: 2, sizes: { w: '3"', v: '1-1/2"' } } }),
  ct({ designator: "HB", trade: "plumbing", description: "Hose bibb", quantities: { wsfu_cold: 2.5, wsfu_total: 2.5, sizes: { cw: '3/4"' } } }),
  ct({ designator: "DF", trade: "plumbing", description: "Drinking fountain", quantities: { wsfu_cold: 0.25, wsfu_total: 0.25, dfu: 0.5, sizes: { cw: '1/2"', w: '1-1/4"', v: '1-1/4"' } } }),
  ct({ designator: "IM", trade: "plumbing", description: "Ice maker", quantities: { wsfu_cold: 0.25, wsfu_total: 0.25, sizes: { cw: '1/2"' } } }),
  ct({ designator: "DW", trade: "plumbing", description: "Dishwasher, commercial", quantities: { wsfu_hot: 1.5, wsfu_total: 1.5, dfu: 2, gph_demand: 35, sizes: { hw: '3/4"', w: '1-1/2"' } } }),
  ct({ designator: "WH-T", trade: "gas", description: "Water heater, tank", quantities: { mbh: 199, min_inlet_pressure: 0.25, sizes: { cw: '1"', hw: '1"', g: '3/4"' } } }),
  ct({ designator: "WH-E", trade: "plumbing", description: "Water heater, electric tank", poles: 2, continuous: true, quantities: { sizes: { cw: '3/4"', hw: '3/4"' } } }, { loadVa: 4_500, voltage: 240, loadClass: "heating" }),
  ct({ designator: "WH-GT", trade: "gas", description: "Water heater, gas tankless", quantities: { mbh: 199, min_inlet_pressure: 0.25, sizes: { cw: '3/4"', hw: '3/4"', g: '3/4"' } } }),
  ct({ designator: "WH-ET", trade: "plumbing", description: "Water heater, electric tankless", poles: 2, continuous: true, quantities: { sizes: { cw: '1/2"', hw: '1/2"' } } }, { loadVa: 18_000, voltage: 240, loadClass: "heating" }),
  ct({ designator: "ET", trade: "plumbing", description: "Expansion tank", quantities: { sizes: { cw: '3/4"' } } }),
  ct({ designator: "RPZ", trade: "plumbing", description: "Backflow preventer, reduced pressure zone", quantities: { sizes: { cw: '2"', w: '2"' } } }),
  ct({ designator: "PRV", trade: "plumbing", description: "Pressure reducing valve", quantities: { sizes: { cw: '2"' } } }),
  ct({ designator: "MTR", trade: "plumbing", description: "Water meter", quantities: { sizes: { cw: '2"' } } }),
  ct({ designator: "RP", trade: "plumbing", description: "Recirculation pump", poles: 1, quantities: { gpm_fixed: 2, sizes: { hw: '3/4"' } } }, { loadVa: 85, voltage: 120, loadClass: "motor" }),
  ct({ designator: "GI", trade: "plumbing", description: "Grease interceptor", quantities: { sizes: { w: '4"', v: '2"' }, custom: [{ name: "Flow rate", unit: "gpm", value: 100 }] } }),
  ct({ designator: "FCO", trade: "plumbing", description: "Floor cleanout", quantities: { sizes: { w: '4"' } } }),
  ct({ designator: "WCO", trade: "plumbing", description: "Wall cleanout", quantities: { sizes: { w: '4"' } } }),
  ct({ designator: "CO", trade: "plumbing", description: "Cleanout", quantities: { sizes: { w: '4"' } } }),
  ct({ designator: "VTR", trade: "plumbing", description: "Vent through roof", quantities: { sizes: { v: '3"' } } }),
  ct({ designator: "GR", trade: "gas", description: "Gas pressure regulator", quantities: { sizes: { g: '1"' } } }),
  ct({ designator: "ST", trade: "gas", description: "Sediment trap", quantities: { sizes: { g: '3/4"' } } }),
  ct({ designator: "G-RANGE", trade: "gas", description: "Gas range, 36 in.", quantities: { mbh: 220, min_inlet_pressure: 0.25, sizes: { g: '3/4"' } } }),
  ct({ designator: "G-FRYER", trade: "gas", description: "Gas fryer", quantities: { mbh: 120, min_inlet_pressure: 0.25, sizes: { g: '3/4"' } } }),
  ct({ designator: "G-GRILL", trade: "gas", description: "Gas flat top grill, 36 in.", quantities: { mbh: 90, min_inlet_pressure: 0.25, sizes: { g: '1/2"' } } }),
];


// ------------------------------------------------------------------ parts

type Port = "cw" | "hw" | "hwr" | "w" | "v" | "g" | "in" | "out" | "power";

const PORTS: Readonly<Record<Port, { readonly label: string; readonly kind: SystemKind; readonly x: number; readonly z: number }>> = {
  cw: { label: "Cold water", kind: "domestic_cold_water", x: 100, z: 450 },
  hw: { label: "Hot water", kind: "domestic_hot_water", x: -100, z: 450 },
  hwr: { label: "Hot water return", kind: "domestic_hot_water_return", x: -200, z: 300 },
  w: { label: "Waste", kind: "sanitary", x: 0, z: 0 },
  v: { label: "Vent", kind: "vent", x: 0, z: 900 },
  g: { label: "Gas", kind: "natural_gas", x: 200, z: 300 },
  in: { label: "Inlet", kind: "domestic_cold_water", x: -150, z: 0 },
  out: { label: "Outlet", kind: "domestic_cold_water", x: 150, z: 0 },
  power: { label: "Power", kind: "power", x: 0, z: 600 },
};

const p = (name: string): Dim => ({ param: name });
const half = (name: string): Dim => ({ param: name, scale: 0.5 });
const neg = (name: string): Dim => ({ param: name, scale: -0.5 });
const len = (name: string, label: string): ParamDef => ({ name, label, kind: "length", unit: "mm", min: 0 });
const txt = (name: string, label: string): ParamDef => ({ name, label, kind: "text" });

interface FixtureSpec {
  readonly slug: string;
  readonly familyName: string;
  readonly typeName: string;
  readonly category: PartCategory;
  readonly starter: string;
  readonly ports: readonly Port[];
  readonly size: readonly [number, number, number];
  /** Pipe size of the connectors, inches. */
  readonly pipeIn?: number;
  /** Inline items: both ports on one system (`in` / `out` take this kind). */
  readonly inlineKind?: SystemKind;
  readonly heaterKind?: "tank" | "gas_tankless" | "electric_tankless";
  readonly symbol?: "rect" | "circle";
}

/**
 * Round 15: a fixture's water, vent and gas connectors take their own size
 * from its starter connection type (a closet's cold water is 1/2", not its 3"
 * waste), each as a type parameter; waste and in-line ports keep
 * `connection_size`.
 */
const PORT_SIZE: Partial<Record<Port, { readonly param: string; readonly label: string; readonly key: "cw" | "hw" | "v" | "g" }>> = {
  cw: { param: "cw_connection_size", label: "Cold water connection size", key: "cw" },
  hw: { param: "hw_connection_size", label: "Hot water connection size", key: "hw" },
  v: { param: "vent_size", label: "Vent size", key: "v" },
  g: { param: "gas_connection_size", label: "Gas connection size", key: "g" },
};

/** A nominal size as the connection types write it (`1-1/4"`, `3/4"`, `2"`), in inches; null when it isn't one. */
export function nominalInches(text: string): number | null {
  const m = /^\s*(?:(\d+)(?:-(\d+)\/(\d+))?|(\d+)\/(\d+))\s*"?\s*$/.exec(text);
  if (!m) return null;
  if (m[4] && m[5]) return Number(m[4]) / Number(m[5]);
  const whole = Number(m[1]);
  return m[2] && m[3] ? whole + Number(m[2]) / Number(m[3]) : whole;
}

function connector(port: Port, spec: FixtureSpec, sized: ReadonlySet<Port> = new Set()): PartConnector {
  const d = PORTS[port];
  const kind = (port === "in" || port === "out") && spec.inlineKind ? spec.inlineKind : d.kind;
  if (port === "power") return { id: "power", label: d.label, domain: "electrical", systemKind: "power", position: [0, 0, d.z], direction: [0, 0, 1], shape: "none" };
  const inline = port === "in" || port === "out";
  return {
    id: port,
    label: d.label,
    domain: "pipe",
    systemKind: kind,
    position: [inline ? (port === "in" ? neg("width") : half("width")) : d.x, 0, d.z],
    direction: inline ? [port === "in" ? -1 : 1, 0, 0] : port === "w" ? [0, 0, -1] : port === "v" ? [0, 0, 1] : [0, 1, 0],
    shape: "round",
    diameter: p(sized.has(port) ? (PORT_SIZE[port]?.param ?? "connection_size") : "connection_size"),
    ...(inline ? { flowDirection: port === "in" ? ("in" as const) : ("out" as const) } : {}),
  };
}

function fixture(spec: FixtureSpec, version: string): LibraryEntry {
  const [w, d, h] = spec.size;
  const typeParams: ParamDef[] = [len("width", "Width"), len("depth", "Depth"), len("height", "Height"), len("connection_size", "Connection size"), txt("default_connection_type", "Starter connection type")];
  if (spec.heaterKind) typeParams.push(txt("heater_kind", "Water heater kind"));
  const typeValues: Record<string, number | string> = { width: w * IN, depth: d * IN, height: h * IN, connection_size: (spec.pipeIn ?? 0.5) * IN, default_connection_type: spec.starter };
  const sizes = PLUMBING_STARTER_CONNECTION_TYPES.find((t) => t.designator === spec.starter)?.quantities?.sizes ?? {};
  const sized = new Set<Port>();
  for (const port of spec.ports) {
    const ps = PORT_SIZE[port];
    const text = ps ? sizes[ps.key] : undefined;
    const inches = text ? nominalInches(text) : null;
    if (!ps || inches === null) continue;
    sized.add(port);
    typeParams.push(len(ps.param, ps.label));
    typeValues[ps.param] = inches * IN;
  }
  if (spec.heaterKind) typeValues.heater_kind = spec.heaterKind;
  const definition: PartTypeDefinition = {
    familyName: spec.familyName,
    typeName: spec.typeName,
    category: spec.category,
    description: `Starter part; its loads come from connection type ${spec.starter} (verify for permit work).`,
    typeParams,
    typeValues,
    instanceParams: [txt("room", "Room")],
    connectors: spec.ports.map((port) => connector(port, spec, sized)),
    geometry: [{ kind: "box", center: [0, 0, half("height")], size: [p("width"), p("depth"), p("height")] }],
    symbol: spec.symbol === "circle" ? [{ kind: "circle", center: [0, 0], radius: half("width") }] : [{ kind: "rect", center: [0, 0], size: [p("width"), p("depth")] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: version },
  };
  return { id: `builtin:plumbing-${spec.slug}@1`, definition };
}

const FIXTURES: readonly FixtureSpec[] = [
  { slug: "wc-flush-tank", familyName: "Water closet, flush tank", typeName: "Floor mounted", category: "plumbing_fixture", starter: "WC-FT", ports: ["cw", "w", "v"], size: [20, 28, 30], pipeIn: 3 },
  { slug: "wc-flushometer", familyName: "Water closet, flushometer", typeName: "Wall hung", category: "plumbing_fixture", starter: "WC-FV", ports: ["cw", "w", "v"], size: [15, 25, 15], pipeIn: 3 },
  { slug: "urinal", familyName: "Urinal, flushometer", typeName: "Wall hung", category: "plumbing_fixture", starter: "UR", ports: ["cw", "w", "v"], size: [14, 14, 26], pipeIn: 2 },
  { slug: "lavatory", familyName: "Lavatory", typeName: "Counter", category: "plumbing_fixture", starter: "LAV", ports: ["cw", "hw", "w", "v"], size: [20, 18, 8], pipeIn: 1.25 },
  { slug: "hand-sink", familyName: "Hand sink", typeName: "Wall hung", category: "plumbing_fixture", starter: "HS", ports: ["cw", "hw", "w", "v"], size: [17, 15, 10], pipeIn: 1.5 },
  { slug: "sink-1", familyName: "Sink, one compartment", typeName: '24"', category: "plumbing_fixture", starter: "SK1", ports: ["cw", "hw", "w", "v"], size: [24, 24, 12], pipeIn: 1.5 },
  { slug: "sink-2", familyName: "Sink, two compartment", typeName: '48"', category: "plumbing_fixture", starter: "SK2", ports: ["cw", "hw", "w", "v"], size: [48, 24, 12], pipeIn: 2 },
  { slug: "sink-3", familyName: "Sink, three compartment", typeName: '72"', category: "plumbing_fixture", starter: "SK3", ports: ["cw", "hw", "w", "v"], size: [72, 24, 12], pipeIn: 2 },
  { slug: "mop-sink", familyName: "Mop sink", typeName: '24" x 24"', category: "plumbing_fixture", starter: "MS", ports: ["cw", "hw", "w", "v"], size: [24, 24, 10], pipeIn: 3 },
  { slug: "floor-drain", familyName: "Floor drain", typeName: '6" round top', category: "plumbing_fixture", starter: "FD", ports: ["w", "v"], size: [6, 6, 2], pipeIn: 2, symbol: "circle" },
  { slug: "floor-sink", familyName: "Floor sink", typeName: '12" square', category: "plumbing_fixture", starter: "FS", ports: ["w", "v"], size: [12, 12, 8], pipeIn: 3 },
  { slug: "trench-drain", familyName: "Trench drain", typeName: '6" x 48"', category: "plumbing_fixture", starter: "TD", ports: ["w", "v"], size: [48, 6, 4], pipeIn: 3 },
  { slug: "hose-bibb", familyName: "Hose bibb", typeName: '3/4"', category: "plumbing_fixture", starter: "HB", ports: ["cw"], size: [4, 4, 4], pipeIn: 0.75, symbol: "circle" },
  { slug: "drinking-fountain", familyName: "Drinking fountain", typeName: "Bi-level", category: "plumbing_fixture", starter: "DF", ports: ["cw", "w", "v"], size: [38, 18, 36], pipeIn: 1.25 },
  { slug: "ice-maker", familyName: "Ice maker", typeName: "Undercounter", category: "plumbing_fixture", starter: "IM", ports: ["cw"], size: [24, 24, 34] },
  { slug: "dishwasher", familyName: "Dishwasher, commercial", typeName: "Door type", category: "plumbing_fixture", starter: "DW", ports: ["hw", "w", "power"], size: [26, 26, 60], pipeIn: 1.5 },
  { slug: "water-heater-tank", familyName: "Water heater, tank", typeName: "100 gal", category: "plumbing_fixture", starter: "WH-T", ports: ["cw", "hw", "hwr", "g"], size: [30, 30, 72], pipeIn: 1, heaterKind: "tank", symbol: "circle" },
  { slug: "water-heater-electric-tank", familyName: "Water heater, electric tank", typeName: "50 gal", category: "plumbing_fixture", starter: "WH-E", ports: ["cw", "hw", "power"], size: [22, 22, 60], pipeIn: 0.75, heaterKind: "tank", symbol: "circle" },
  { slug: "water-heater-gas-tankless", familyName: "Water heater, gas tankless", typeName: "Wall hung", category: "plumbing_fixture", starter: "WH-GT", ports: ["cw", "hw", "g"], size: [18, 10, 27], pipeIn: 0.75, heaterKind: "gas_tankless" },
  { slug: "water-heater-electric-tankless", familyName: "Water heater, electric tankless", typeName: "Point of use", category: "plumbing_fixture", starter: "WH-ET", ports: ["cw", "hw", "power"], size: [14, 4, 14], heaterKind: "electric_tankless" },
  { slug: "expansion-tank", familyName: "Expansion tank", typeName: "5 gal", category: "pipe_accessory", starter: "ET", ports: ["cw"], size: [11, 11, 15], pipeIn: 0.75, symbol: "circle" },
  { slug: "rpz", familyName: "Backflow preventer, reduced pressure zone", typeName: '2"', category: "pipe_accessory", starter: "RPZ", ports: ["in", "out"], size: [20, 6, 8], pipeIn: 2, inlineKind: "domestic_cold_water" },
  { slug: "prv", familyName: "Pressure reducing valve", typeName: '2"', category: "pipe_accessory", starter: "PRV", ports: ["in", "out"], size: [8, 6, 8], pipeIn: 2, inlineKind: "domestic_cold_water" },
  { slug: "water-meter", familyName: "Water meter", typeName: '2"', category: "pipe_accessory", starter: "MTR", ports: ["in", "out"], size: [12, 6, 8], pipeIn: 2, inlineKind: "domestic_cold_water" },
  { slug: "recirc-pump", familyName: "Recirculation pump", typeName: "Inline", category: "pipe_accessory", starter: "RP", ports: ["in", "out", "power"], size: [8, 6, 6], pipeIn: 0.75, inlineKind: "domestic_hot_water_return" },
  { slug: "grease-interceptor", familyName: "Grease interceptor", typeName: "100 gpm", category: "pipe_accessory", starter: "GI", ports: ["in", "out"], size: [87, 33, 46], pipeIn: 4, inlineKind: "sanitary" },
  { slug: "cleanout-floor", familyName: "Cleanout, floor", typeName: '4"', category: "pipe_accessory", starter: "FCO", ports: ["w"], size: [6, 6, 2], pipeIn: 4, symbol: "circle" },
  { slug: "cleanout-wall", familyName: "Cleanout, wall", typeName: '4"', category: "pipe_accessory", starter: "WCO", ports: ["w"], size: [6, 2, 6], pipeIn: 4 },
  { slug: "cleanout-inline", familyName: "Cleanout, in-line", typeName: '4" wye with plug', category: "pipe_accessory", starter: "CO", ports: ["in", "out"], size: [8, 6, 6], pipeIn: 4, inlineKind: "sanitary" },
  { slug: "cleanout", familyName: "Cleanout", typeName: '4"', category: "pipe_accessory", starter: "CO", ports: ["w"], size: [5, 5, 5], pipeIn: 4, symbol: "circle" },
  { slug: "vtr", familyName: "Vent through roof", typeName: '3"', category: "pipe_accessory", starter: "VTR", ports: ["v"], size: [4, 4, 12], pipeIn: 3, symbol: "circle" },
  { slug: "gas-regulator", familyName: "Gas pressure regulator", typeName: '1"', category: "pipe_accessory", starter: "GR", ports: ["in", "out"], size: [8, 5, 8], pipeIn: 1, inlineKind: "natural_gas" },
  { slug: "sediment-trap", familyName: "Sediment trap", typeName: '3/4"', category: "pipe_accessory", starter: "ST", ports: ["g"], size: [3, 3, 8], pipeIn: 0.75 },
  { slug: "gas-range", familyName: "Gas range", typeName: '36"', category: "plumbing_fixture", starter: "G-RANGE", ports: ["g"], size: [36, 34, 36], pipeIn: 0.75 },
  { slug: "gas-fryer", familyName: "Gas fryer", typeName: '18"', category: "plumbing_fixture", starter: "G-FRYER", ports: ["g"], size: [18, 34, 48], pipeIn: 0.75 },
  { slug: "gas-grill", familyName: "Gas flat top grill", typeName: '36"', category: "plumbing_fixture", starter: "G-GRILL", ports: ["g"], size: [36, 34, 18], pipeIn: 0.5 },
];

/**
 * Building-sewer parts the drainage checks read (`drainage/types.ts`): the
 * existing manhole or public sewer tie-in, a sewage ejector and a backwater
 * valve. Their values are instance parameters typed in Properties.
 */
const DRAINAGE_ROLE: ParamDef = { name: "drainage_role", label: "Drainage role", kind: "choice", choices: ["sewer_connection", "sewage_pump", "backwater_valve"] };
const num = (name: string, label: string, unit: ParamDef["unit"] = "none"): ParamDef => ({ name, label, kind: "number", unit, min: 0 });
/** An elevation from project zero: below grade is negative, so no minimum. */
const elevation = (name: string, label: string): ParamDef => ({ name, label, kind: "length", unit: "mm" });

interface DrainageSpec {
  readonly slug: string;
  readonly familyName: string;
  readonly typeName: string;
  readonly role: "sewer_connection" | "sewage_pump" | "backwater_valve";
  readonly size: readonly [number, number, number];
  readonly pipeIn: number;
  readonly instanceParams: readonly ParamDef[];
  readonly symbol: "rect" | "circle";
}

const DRAINAGE: readonly DrainageSpec[] = [
  {
    slug: "sanitary-manhole-existing",
    familyName: "Sanitary manhole (existing)",
    typeName: "Public sewer",
    role: "sewer_connection",
    size: [48, 48, 24],
    pipeIn: 6,
    symbol: "circle",
    instanceParams: [
      elevation("sewer_invert", "Sewer invert"),
      elevation("sewer_rim", "Upstream manhole cover"),
      { name: "elevation_confidence", label: "Elevations are", kind: "choice", choices: ["verified", "assumed", "field_verify"] },
      num("building_drain_size_in", "Building drain size (in)"),
      num("building_drain_slope_in_per_ft", "Building drain slope (in/ft)"),
      len("building_drain_length", "Building drain length"),
      len("drain_depth_below_floor", "Drain depth below a floor"),
      // Grease routing (plumbing/grease.ts): the sewer owner as the code study names it, and an optional project rule.
      txt("sewer_authority", "Sewer authority (from the code study)"),
      txt("grease_fixtures", "Fixtures to the grease interceptor"),
    ],
  },
  {
    slug: "sewage-ejector",
    familyName: "Sewage ejector",
    typeName: "Duplex grinder",
    role: "sewage_pump",
    size: [36, 36, 48],
    pipeIn: 4,
    symbol: "circle",
    instanceParams: [num("pump_rated_gpm", "Rated flow", "gpm"), num("pump_rated_head_ft", "Rated head (ft)"), num("pump_inflow_gpm", "Design inflow", "gpm"), num("pump_head_ft", "Total head (ft)"), { name: "backwater_valve", label: "Backwater valve", kind: "boolean" }],
  },
  { slug: "backwater-valve", familyName: "Backwater valve", typeName: '4"', role: "backwater_valve", size: [14, 8, 8], pipeIn: 4, symbol: "rect", instanceParams: [] },
];

function drainagePart(spec: DrainageSpec, version: string): LibraryEntry {
  const [w, d, h] = spec.size;
  const inline: FixtureSpec = { slug: spec.slug, familyName: spec.familyName, typeName: spec.typeName, category: "pipe_accessory", starter: "", ports: ["in", "out"], size: spec.size, pipeIn: spec.pipeIn, inlineKind: "sanitary" };
  const definition: PartTypeDefinition = {
    familyName: spec.familyName,
    typeName: spec.typeName,
    category: "pipe_accessory",
    description: "Starter part for the building sewer checks; type its elevations and ratings in Properties (verify for permit work).",
    typeParams: [len("width", "Width"), len("depth", "Depth"), len("height", "Height"), len("connection_size", "Connection size"), DRAINAGE_ROLE],
    typeValues: { width: w * IN, depth: d * IN, height: h * IN, connection_size: spec.pipeIn * IN, drainage_role: spec.role },
    instanceParams: [txt("room", "Room"), ...spec.instanceParams],
    connectors: spec.role === "backwater_valve" ? [connector("in", inline), connector("out", inline)] : [connector("in", inline)],
    geometry: [{ kind: "box", center: [0, 0, half("height")], size: [p("width"), p("depth"), p("height")] }],
    symbol: spec.symbol === "circle" ? [{ kind: "circle", center: [0, 0], radius: half("width") }] : [{ kind: "rect", center: [0, 0], size: [p("width"), p("depth")] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: version },
  };
  return { id: `builtin:plumbing-${spec.slug}@1`, definition };
}

export function plumbingStarterTypes(version: string): LibraryEntry[] {
  return [...FIXTURES.map((spec) => fixture(spec, version)), ...DRAINAGE.map((spec) => drainagePart(spec, version))];
}
