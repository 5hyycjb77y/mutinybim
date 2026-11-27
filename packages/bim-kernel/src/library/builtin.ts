import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { Dim, ParamDef, PartConnector, PartTypeDefinition } from "../parts";

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

function source(): PartTypeDefinition["source"] {
  return { kind: "builtin", libraryVersion: BUILTIN_LIBRARY_VERSION };
}

function power(id: string, z: Dim, voltage: Dim, poles: number, load: Dim): PartConnector {
  return { id, label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, z], direction: [0, 0, 1], shape: "none", voltage, poles, flow: load };
}

const DUPLEX: LibraryEntry = {
  id: "builtin:duplex-receptacle@1",
  definition: {
    familyName: "Receptacle, duplex",
    typeName: "20A 125V NEMA 5-20R",
    category: "electrical_device",
    typeParams: [num("voltage", "Voltage", "v", { min: 0 }), num("rating", "Rating", "a", { min: 0 }), text("nema", "NEMA configuration")],
    typeValues: { voltage: 120, rating: 20, nema: "5-20R" },
    instanceParams: [text("circuit", "Circuit"), num("load", "Load", "va", { min: 0, default: 180 }), { name: "gfci", label: "GFCI", kind: "boolean", default: false }],
    connectors: [{ ...power("power", 60, p("voltage"), 1, p("load")), position: [0, -20, 60], direction: [0, -1, 0] }],
    // Recessed device box inside the wall (-20..0) + 6 mm proud faceplate (0..+6) so wall-face hosting has zero Z-fighting and unhosted wallMountOf keeps its 20 mm back depth.
    geometry: [
      { kind: "box", center: [0, -10, 60], size: [55, 20, 95] },
      { kind: "box", center: [0, 3, 60], size: [70, 6, 115] },
    ],
    symbol: [
      { kind: "circle", center: [0, 2.0], radius: 1.5, fill: "mask", pen: "medium", units: "paper" },
      { kind: "line", from: [-0.6, 0], to: [-0.6, 3.35], pen: "medium", units: "paper" },
      { kind: "line", from: [0.6, 0], to: [0.6, 3.35], pen: "medium", units: "paper" },
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
    connectors: [power("power", p("depth"), p("voltage"), 1, 0)],
    geometry: [{ kind: "box", center: [0, 0, half("depth")], size: [p("size"), p("size"), p("depth")] }],
    symbol: [
      { kind: "circle", center: [0, 0], radius: 1.6, fill: "mask", pen: "medium", units: "paper" },
      { kind: "text", at: [0, 0], text: "J", heightMm: 1.8, units: "paper" },
    ],
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
    symbol: [
      { kind: "rect", center: [0, half("depth")], size: [p("width"), p("depth")], fill: "mask", pen: "medium", minPaperMm: 4.5 },
      { kind: "rect", center: [0, { param: "depth", scale: 0.75 }], size: [p("width"), { param: "depth", scale: 0.5 }], fill: "solid", pen: "medium" },
    ],
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
    instanceParams: [
      text("circuit", "Circuit"),
      text("switch_leg", "Switch leg"),
      { name: "emergency", label: "Emergency battery", kind: "boolean", default: false },
      { name: "emergency_mode", label: "Emergency mode", kind: "choice", choices: ["none", "unswitched", "switched"], default: "none" },
    ],
    connectors: [power("power", 120, p("voltage"), 1, p("watts"))],
    geometry: [{ kind: "box", center: [0, 0, 60], size: [p("length"), p("width"), 120] }],
    symbol: [
      { kind: "rect", center: [0, 0], size: [p("length"), p("width")], fill: "mask", pen: "medium", minPaperMm: 4 },
      { kind: "rect", center: [{ param: "length", scale: -0.25 }, 0], size: [{ param: "length", scale: 0.5 }, p("width")], fill: "solid", pen: "medium", when: { param: "emergency", truthy: true } },
      { kind: "line", from: [neg("length"), 0], to: [half("length"), 0], pen: "thin", detailLevels: ["medium", "fine"] },
    ],
    tagFields: ["mark", "circuit"],
    source: source(),
  },
};

export const BUILTIN_PART_TYPES: readonly LibraryEntry[] = [
  DUPLEX,
  JBOX,
  PANEL,
  TROFFER,
];

/**
 * Earlier versions of types a model may already have placed. A model pins a
 * type under its id, so a changed type gets a new id and the old one stays
 * readable here; the library offers only the current versions.
 */
export const SUPERSEDED_BUILTIN_PART_TYPES: readonly LibraryEntry[] = [];

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
