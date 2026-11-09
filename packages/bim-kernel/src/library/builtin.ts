import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { Dim, ParamDef, PartConnector, PartPrimitive, PartTypeDefinition, SymbolPrimitive } from "../parts";

/**
 * The starter library shipped in git: generic, made-up types in every
 * discipline, no client data. Real projects add their own types from Revit
 * (see revit-convert.ts). Every type is pinned into a model when first placed.
 */
export const BUILTIN_LIBRARY_VERSION = "2026.10.1";

const IN = 25.4;
const FT = 304.8;

export interface LibraryEntry {
  /** Stable type id; a model that places this type stores it under this id. */
  readonly id: string;
  readonly definition: PartTypeDefinition;
}

const p = (name: string): Dim => ({ param: name });
const half = (name: string): Dim => ({ param: name, scale: 0.5 });
const neg = (name: string): Dim => ({ param: name, scale: -0.5 });

function length(name: string, label: string, opts: Partial<ParamDef> = {}): ParamDef {
  return { name, label, kind: "length", unit: "mm", min: 0, ...opts };
}

function num(name: string, label: string, unit: ParamDef["unit"], opts: Partial<ParamDef> = {}): ParamDef {
  return { name, label, kind: "number", unit, ...opts };
}

function text(name: string, label: string, opts: Partial<ParamDef> = {}): ParamDef {
  return { name, label, kind: "text", ...opts };
}

/** A box centred in plan on the insertion point, sitting on it (z from 0 up). */
function bodyBox(w: string, d: string, h: string): PartPrimitive {
  return { kind: "box", center: [0, 0, half(h)], size: [p(w), p(d), p(h)] };
}

function outline(w: string, d: string): SymbolPrimitive {
  return { kind: "rect", center: [0, 0], size: [p(w), p(d)] };
}

function cross(w: string, d: string): SymbolPrimitive[] {
  return [
    { kind: "line", from: [neg(w), neg(d)], to: [half(w), half(d)] },
    { kind: "line", from: [neg(w), half(d)], to: [half(w), neg(d)] },
  ];
}

function source(): PartTypeDefinition["source"] {
  return { kind: "builtin", libraryVersion: BUILTIN_LIBRARY_VERSION };
}

function power(id: string, z: Dim, voltage: Dim, poles: number, load: Dim): PartConnector {
  return { id, label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, z], direction: [0, 0, 1], shape: "none", voltage, poles, flow: load };
}

const innerFace: SymbolPrimitive = { kind: "rect", center: [0, 0], size: [{ param: "face_size", scale: 0.6 }, { param: "face_size", scale: 0.6 }] };

/** Ceiling air terminal: square face at the insertion point (ceiling), round neck up. */
function ceilingTerminal(id: string, typeName: string, system: "supply_air" | "return_air" | "exhaust_air", faceIn: number, neckIn: number, defaultCfm: number): LibraryEntry {
  return {
    id,
    definition: {
      familyName: system === "supply_air" ? "Ceiling diffuser, square" : system === "return_air" ? "Return grille, ceiling" : "Exhaust grille, ceiling",
      typeName,
      category: "air_terminal",
      typeParams: [length("face_size", "Face size"), length("neck_diameter", "Neck diameter"), text("model", "Model")],
      typeValues: { face_size: faceIn * IN, neck_diameter: neckIn * IN, model: "Generic" },
      instanceParams: [num("airflow", "Airflow", "cfm", { min: 0, max: 20000, default: defaultCfm }), text("room", "Room")],
      connectors: [
        {
          id: "neck",
          label: "Neck",
          domain: "duct",
          systemKind: system,
          position: [0, 0, 150],
          direction: [0, 0, 1],
          shape: "round",
          diameter: p("neck_diameter"),
          flow: p("airflow"),
        },
      ],
      geometry: [
        { kind: "box", center: [0, 0, 25], size: [p("face_size"), p("face_size"), 50] },
        { kind: "cylinder", center: [0, 0, 100], radius: half("neck_diameter"), height: 100, axis: "z" },
      ],
      symbol: [outline("face_size", "face_size"), ...(system === "supply_air" ? cross("face_size", "face_size") : [innerFace])],
      tagFields: ["mark", "airflow"],
      source: source(),
    },
  };
}

const RTU: LibraryEntry = {
  id: "builtin:rtu-5-ton@1",
  definition: {
    familyName: "Packaged rooftop unit",
    typeName: "5 ton, gas heat",
    category: "mechanical_equipment",
    description: "Generic packaged rooftop unit with downflow supply and return.",
    typeParams: [
      length("length", "Length"),
      length("width", "Width"),
      length("height", "Height"),
      num("cooling_tons", "Nominal cooling", "tons", { min: 0 }),
      num("supply_cfm", "Supply airflow", "cfm", { min: 0 }),
      num("heating_btuh", "Heating input", "btuh", { min: 0 }),
      num("voltage", "Voltage", "v", { min: 0 }),
      num("mca", "Minimum circuit ampacity", "a", { min: 0 }),
      num("mocp", "Maximum overcurrent protection", "a", { min: 0 }),
      num("weight", "Operating weight", "lb", { min: 0 }),
    ],
    typeValues: { length: 2300, width: 1400, height: 1100, cooling_tons: 5, supply_cfm: 2000, heating_btuh: 115000, voltage: 460, mca: 14, mocp: 20, weight: 950 },
    instanceParams: [text("serves", "Serves"), text("curb", "Roof curb")],
    connectors: [
      { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [-400, 0, 0], direction: [0, 0, -1], shape: "rect", width: 24 * IN, height: 12 * IN, flow: p("supply_cfm") },
      { id: "return", label: "Return", domain: "duct", systemKind: "return_air", position: [400, 0, 0], direction: [0, 0, -1], shape: "rect", width: 24 * IN, height: 14 * IN, flow: p("supply_cfm") },
      power("power", p("height"), p("voltage"), 3, 11000),
    ],
    geometry: [bodyBox("length", "width", "height")],
    symbol: [outline("length", "width"), ...cross("length", "width")],
    tagFields: ["mark"],
    source: source(),
  },
};

/**
 * The rooftop unit with its economizer: outdoor air comes in through a
 * weather hood on the end of the unit. `outdoor_cfm` is the design outdoor
 * airflow (the minimum outdoor air on the equipment schedule).
 */
const RTU_V2: LibraryEntry = {
  id: "builtin:rtu-5-ton@2",
  definition: {
    ...RTU.definition,
    description: "Generic packaged rooftop unit with downflow supply and return and an economizer outdoor-air hood.",
    typeParams: [...RTU.definition.typeParams, num("outdoor_cfm", "Outdoor airflow", "cfm", { min: 0 })],
    typeValues: { ...RTU.definition.typeValues, outdoor_cfm: 400 },
    connectors: [
      ...RTU.definition.connectors,
      { id: "outdoor_air", label: "Outdoor air", domain: "duct", systemKind: "outside_air", position: [half("length"), 0, { param: "height", scale: 0.55 }], direction: [1, 0, 0], shape: "rect", width: 30 * IN, height: 12 * IN, flow: p("outdoor_cfm"), flowDirection: "in", intake: "hood" },
    ],
  },
};

const INLINE_FAN: LibraryEntry = {
  id: "builtin:inline-fan-10@1",
  definition: {
    familyName: "Inline centrifugal fan",
    typeName: '10" round, 800 CFM',
    category: "mechanical_equipment",
    typeParams: [
      length("length", "Length"),
      length("diameter", "Housing diameter"),
      length("duct_diameter", "Duct connection"),
      num("airflow", "Airflow", "cfm", { min: 0 }),
      num("static_pressure", "External static pressure", "in_wc", { min: 0 }),
      num("motor_hp", "Motor", "hp", { min: 0 }),
      num("voltage", "Voltage", "v", { min: 0 }),
    ],
    typeValues: { length: 700, diameter: 420, duct_diameter: 10 * IN, airflow: 800, static_pressure: 0.75, motor_hp: 0.5, voltage: 120 },
    instanceParams: [text("serves", "Serves")],
    connectors: [
      { id: "inlet", label: "Inlet", domain: "duct", systemKind: "exhaust_air", position: [neg("length"), 0, 0], direction: [-1, 0, 0], shape: "round", diameter: p("duct_diameter"), flow: p("airflow") },
      { id: "outlet", label: "Outlet", domain: "duct", systemKind: "exhaust_air", position: [half("length"), 0, 0], direction: [1, 0, 0], shape: "round", diameter: p("duct_diameter"), flow: p("airflow") },
      power("power", half("diameter"), p("voltage"), 1, 600),
    ],
    geometry: [{ kind: "cylinder", center: [0, 0, 0], radius: half("diameter"), height: p("length"), axis: "x" }],
    symbol: [outline("length", "diameter"), { kind: "circle", center: [0, 0], radius: { param: "diameter", scale: 0.3 } }],
    tagFields: ["mark", "airflow"],
    source: source(),
  },
};

/** An inline fan that brings outdoor air in (a ventilation or makeup-air fan): both openings carry outdoor air. */
const INLINE_FAN_OA: LibraryEntry = {
  id: "builtin:inline-fan-oa-10@1",
  definition: {
    ...INLINE_FAN.definition,
    familyName: "Inline centrifugal fan, outdoor air",
    typeName: '10" round, 800 CFM',
    typeParams: [...INLINE_FAN.definition.typeParams, num("outdoor_cfm", "Outdoor airflow", "cfm", { min: 0 })],
    typeValues: { ...INLINE_FAN.definition.typeValues, outdoor_cfm: 800 },
    connectors: INLINE_FAN.definition.connectors.map((c): PartConnector => (c.domain !== "duct" ? c : { ...c, systemKind: "outside_air", flow: p("outdoor_cfm"), flowDirection: c.id === "inlet" ? "in" : "out" })),
  },
};

const VAV: LibraryEntry = {
  id: "builtin:vav-8@1",
  definition: {
    familyName: "VAV terminal unit, single duct",
    typeName: '8" inlet, electric reheat',
    category: "mechanical_equipment",
    typeParams: [
      length("length", "Length"),
      length("width", "Width"),
      length("height", "Height"),
      length("inlet_diameter", "Inlet diameter"),
      num("heater_kw", "Reheat", "kw", { min: 0 }),
      num("voltage", "Voltage", "v", { min: 0 }),
    ],
    typeValues: { length: 900, width: 500, height: 300, inlet_diameter: 8 * IN, heater_kw: 3, voltage: 277 },
    instanceParams: [num("max_cfm", "Maximum airflow", "cfm", { min: 0, max: 5000, default: 600 }), num("min_cfm", "Minimum airflow", "cfm", { min: 0, max: 5000, default: 180 }), text("zone", "Zone")],
    connectors: [
      { id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", position: [neg("length"), 0, 0], direction: [-1, 0, 0], shape: "round", diameter: p("inlet_diameter"), flow: p("max_cfm") },
      { id: "outlet", label: "Discharge", domain: "duct", systemKind: "supply_air", position: [half("length"), 0, 0], direction: [1, 0, 0], shape: "rect", width: 14 * IN, height: 10 * IN, flow: p("max_cfm") },
      power("power", p("height"), p("voltage"), 1, 3000),
    ],
    geometry: [{ kind: "box", center: [0, 0, 0], size: [p("length"), p("width"), p("height")] }],
    symbol: [outline("length", "width"), { kind: "text", at: [0, 0], text: "VAV", heightMm: 120 }],
    tagFields: ["mark", "max_cfm"],
    source: source(),
  },
};

/**
 * A VAV box takes primary air from the air handler, not outdoor air, so it
 * has no outdoor-air opening. What it does carry is the zone's outdoor air
 * requirement (ventilation for the space it serves), scheduled per box.
 */
const VAV_V2: LibraryEntry = {
  id: "builtin:vav-8@2",
  definition: {
    ...VAV.definition,
    instanceParams: [...VAV.definition.instanceParams, num("outdoor_cfm", "Zone outdoor airflow", "cfm", { min: 0, max: 5000, default: 0 })],
    tagFields: ["mark", "max_cfm"],
  },
};

const DUPLEX: LibraryEntry = {
  id: "builtin:duplex-receptacle@1",
  definition: {
    familyName: "Receptacle, duplex",
    typeName: "20A 125V NEMA 5-20R",
    category: "electrical_device",
    typeParams: [num("voltage", "Voltage", "v", { min: 0 }), num("rating", "Rating", "a", { min: 0 }), text("nema", "NEMA configuration")],
    typeValues: { voltage: 120, rating: 20, nema: "5-20R" },
    instanceParams: [text("circuit", "Circuit"), num("load", "Load", "va", { min: 0, default: 180 }), { name: "gfci", label: "GFCI", kind: "boolean", default: false }],
    connectors: [power("power", 50, p("voltage"), 1, p("load"))],
    geometry: [{ kind: "box", center: [0, -10, 60], size: [70, 20, 115] }],
    symbol: [
      { kind: "circle", center: [0, 0], radius: 100 },
      { kind: "line", from: [-60, -40], to: [-60, 40] },
      { kind: "line", from: [60, -40], to: [60, 40] },
    ],
    tagFields: ["circuit"],
    source: source(),
  },
};

const JBOX: LibraryEntry = {
  id: "builtin:junction-box-4sq@1",
  definition: {
    familyName: "Junction box",
    typeName: '4" square',
    category: "electrical_device",
    typeParams: [length("size", "Size"), length("depth", "Depth"), num("voltage", "Voltage", "v", { min: 0 })],
    typeValues: { size: 4 * IN, depth: 2.125 * IN, voltage: 120 },
    instanceParams: [text("circuit", "Circuit"), text("serves", "Serves")],
    connectors: [power("power", 0, p("voltage"), 1, 0)],
    geometry: [{ kind: "box", center: [0, 0, half("depth")], size: [p("size"), p("size"), p("depth")] }],
    symbol: [outline("size", "size"), { kind: "text", at: [0, 0], text: "J", heightMm: 80 }],
    tagFields: ["circuit"],
    source: source(),
  },
};

const PANEL: LibraryEntry = {
  id: "builtin:panelboard-225@1",
  definition: {
    familyName: "Panelboard, surface",
    typeName: "225A 208Y/120V 42 circuit",
    category: "electrical_equipment",
    typeParams: [
      length("width", "Width"),
      length("height", "Height"),
      length("depth", "Depth"),
      num("voltage", "Voltage", "v", { min: 0 }),
      { name: "phases", label: "Phases", kind: "choice", choices: ["1", "3"] },
      num("circuits", "Circuits", "count", { min: 1, max: 84 }),
    ],
    typeValues: { width: 20 * IN, height: 60 * IN, depth: 5.75 * IN, voltage: 208, phases: "3", circuits: 42 },
    instanceParams: [
      text("panel_name", "Panel name"),
      text("fed_from", "Fed from"),
      num("bus_rating", "Bus rating", "a", { min: 0, default: 225 }),
      { name: "mains", label: "Mains", kind: "text", default: "MLO" },
      { name: "enclosure", label: "Enclosure", kind: "choice", choices: ["NEMA 1", "NEMA 3R", "NEMA 4X", "NEMA 12"], default: "NEMA 1" },
      num("aic", "Short-circuit rating", "a", { min: 0, default: 10000 }),
    ],
    connectors: [power("feeder", p("height"), p("voltage"), 3, 0)],
    geometry: [{ kind: "box", center: [0, half("depth"), { param: "height", scale: 0.5, add: 300 }], size: [p("width"), p("depth"), p("height")] }],
    symbol: [{ kind: "rect", center: [0, half("depth")], size: [p("width"), p("depth")] }, { kind: "line", from: [neg("width"), p("depth")], to: [half("width"), p("depth")] }],
    tagFields: ["panel_name"],
    source: source(),
  },
};

const TROFFER: LibraryEntry = {
  id: "builtin:troffer-2x4-led@1",
  definition: {
    familyName: "Troffer, recessed LED",
    typeName: "2x4, 4000 lm",
    category: "lighting_fixture",
    typeParams: [length("length", "Length"), length("width", "Width"), num("watts", "Input power", "w", { min: 0 }), num("lumens", "Output", "lumens", { min: 0 }), num("voltage", "Voltage", "v", { min: 0 })],
    typeValues: { length: 4 * FT, width: 2 * FT, watts: 32, lumens: 4000, voltage: 277 },
    instanceParams: [text("circuit", "Circuit"), text("switch_leg", "Switch leg"), { name: "emergency", label: "Emergency battery", kind: "boolean", default: false }],
    connectors: [power("power", 100, p("voltage"), 1, p("watts"))],
    geometry: [{ kind: "box", center: [0, 0, 60], size: [p("length"), p("width"), 120] }],
    symbol: [outline("length", "width"), { kind: "line", from: [neg("length"), 0], to: [half("length"), 0] }],
    tagFields: ["mark", "circuit"],
    source: source(),
  },
};

const WC: LibraryEntry = {
  id: "builtin:water-closet-floor@1",
  definition: {
    familyName: "Water closet, floor mounted",
    typeName: "Flush valve, 1.28 gpf",
    category: "plumbing_fixture",
    typeParams: [num("fixture_units", "Drainage fixture units", "count", { min: 0 }), num("flush_gpf", "Flush volume (gal/flush)", "none", { min: 0 }), length("waste_size", "Waste connection"), length("cw_size", "Cold water connection")],
    typeValues: { fixture_units: 4, flush_gpf: 1.28, waste_size: 3 * IN, cw_size: 1 * IN },
    instanceParams: [{ name: "accessible", label: "Accessible (ADA)", kind: "boolean", default: false }],
    connectors: [
      { id: "waste", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [-150, 0, 0], direction: [0, 0, -1], shape: "round", diameter: p("waste_size") },
      { id: "cw", label: "Cold water", domain: "pipe", systemKind: "domestic_cold_water", position: [-330, 0, 300], direction: [-1, 0, 0], shape: "round", diameter: p("cw_size") },
    ],
    geometry: [
      { kind: "box", center: [-280, 0, 380], size: [180, 500, 760] },
      { kind: "extrusion", profile: [[-190, -180], [150, -180], [400, -100], [430, 0], [400, 100], [150, 180], [-190, 180]], z: 0, height: 400 },
    ],
    symbol: [
      { kind: "rect", center: [-280, 0], size: [180, 500] },
      { kind: "polyline", points: [[-190, -180], [150, -180], [400, -100], [430, 0], [400, 100], [150, 180], [-190, 180]], closed: true },
    ],
    tagFields: ["mark"],
    source: source(),
  },
};

const LAV: LibraryEntry = {
  id: "builtin:lavatory-wall@1",
  definition: {
    familyName: "Lavatory, wall hung",
    typeName: '20" x 18"',
    category: "plumbing_fixture",
    typeParams: [length("width", "Width"), length("depth", "Depth"), num("fixture_units", "Drainage fixture units", "count", { min: 0 }), length("waste_size", "Waste connection"), length("supply_size", "Water connections")],
    typeValues: { width: 20 * IN, depth: 18 * IN, fixture_units: 1, waste_size: 1.25 * IN, supply_size: 0.5 * IN },
    instanceParams: [{ name: "accessible", label: "Accessible (ADA)", kind: "boolean", default: false }, length("rim_height", "Rim height", { default: 34 * IN, max: 1200 })],
    connectors: [
      { id: "waste", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [0, 30, { param: "rim_height", add: -250 }], direction: [0, 1, 0], shape: "round", diameter: p("waste_size") },
      { id: "cw", label: "Cold water", domain: "pipe", systemKind: "domestic_cold_water", position: [100, 30, { param: "rim_height", add: -150 }], direction: [0, 1, 0], shape: "round", diameter: p("supply_size") },
      { id: "hw", label: "Hot water", domain: "pipe", systemKind: "domestic_hot_water", position: [-100, 30, { param: "rim_height", add: -150 }], direction: [0, 1, 0], shape: "round", diameter: p("supply_size") },
    ],
    geometry: [{ kind: "box", center: [0, neg("depth"), { param: "rim_height", add: -100 }], size: [p("width"), p("depth"), 200] }],
    symbol: [{ kind: "rect", center: [0, neg("depth")], size: [p("width"), p("depth")] }, { kind: "circle", center: [0, { param: "depth", scale: -0.55 }], radius: { param: "width", scale: 0.3 } }],
    tagFields: ["mark"],
    source: source(),
  },
};

export const BUILTIN_PART_TYPES: readonly LibraryEntry[] = [
  ceilingTerminal("builtin:supply-diffuser-24@1", '24x24, 8" neck', "supply_air", 24, 8, 150),
  ceilingTerminal("builtin:return-grille-24@1", '24x24, 12" neck', "return_air", 24, 12, 400),
  ceilingTerminal("builtin:exhaust-grille-12@1", '12x12, 6" neck', "exhaust_air", 12, 6, 75),
  RTU_V2,
  INLINE_FAN,
  INLINE_FAN_OA,
  VAV_V2,
  DUPLEX,
  JBOX,
  PANEL,
  TROFFER,
  WC,
  LAV,
];

/**
 * Earlier versions of types a model may already have placed. A model pins a
 * type under its id, so a changed type gets a new id and the old one stays
 * readable here; the library offers only the current versions.
 */
export const SUPERSEDED_BUILTIN_PART_TYPES: readonly LibraryEntry[] = [RTU, VAV];

/**
 * A built-in part type an add-on ships (v1). `entry.id` is stored in every
 * model that placed it: never rename one. A `superseded` row is an earlier
 * version a model may already have placed: readable, not offered.
 */
export interface BuiltinPartTypeRow {
  readonly entry: LibraryEntry;
  readonly superseded?: boolean;
}

const KERNEL_PART_TYPE_ROWS: readonly BuiltinPartTypeRow[] = [...BUILTIN_PART_TYPES.map((entry) => ({ entry })), ...SUPERSEDED_BUILTIN_PART_TYPES.map((entry) => ({ entry, superseded: true }))];

/**
 * Built-in part types (v1): the kernel's own above, then the first-party
 * add-ons' in first-party order, then a model's packs. No `idOf`: stored type
 * ids (`builtin:panelboard-225@1`) predate registry ids. The first row with
 * an id wins, so a pack can't replace a built-in type.
 */
export const PART_TYPE_POINT = defineExtensionPoint<BuiltinPartTypeRow>({
  id: "kernel.part_type",
  version: 1,
  label: "Built-in part types",
  builtins: () => KERNEL_PART_TYPE_ROWS,
});

interface PartTypeIndex {
  readonly offered: readonly LibraryEntry[];
  readonly superseded: readonly LibraryEntry[];
  readonly byId: ReadonlyMap<string, LibraryEntry>;
}

// Keyed by the set's memoised item list, so a set (and a first-party install) gets its own.
const partTypeIndexes = new WeakMap<readonly BuiltinPartTypeRow[], PartTypeIndex>();

function partTypeIndex(): PartTypeIndex {
  const rows = activePackSet().items(PART_TYPE_POINT);
  const had = partTypeIndexes.get(rows);
  if (had) return had;
  const byId = new Map<string, LibraryEntry>();
  const kept = rows.filter((r) => {
    if (byId.has(r.entry.id)) return false;
    byId.set(r.entry.id, r.entry);
    return true;
  });
  const offered = kept.filter((r) => !r.superseded).map((r) => r.entry);
  const superseded = kept.filter((r) => r.superseded).map((r) => r.entry);
  const index: PartTypeIndex = { offered, superseded, byId };
  partTypeIndexes.set(rows, index);
  return index;
}

/** Every built-in part type the library offers in the pack set in force, in library order. */
export function builtinPartTypes(): readonly LibraryEntry[] {
  return partTypeIndex().offered;
}

/** Every earlier built-in version in the pack set in force (readable, never offered). */
export function supersededBuiltinPartTypes(): readonly LibraryEntry[] {
  return partTypeIndex().superseded;
}

export function builtinPartType(id: string): LibraryEntry | undefined {
  return partTypeIndex().byId.get(id);
}
