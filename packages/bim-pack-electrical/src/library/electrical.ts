import type { Dim, ParamDef, PartConnector, PartTypeDefinition, SymbolPrimitive, LibraryEntry } from "@permitzip/bim-kernel";

/**
 * Starter electrical types beyond the receptacle, junction box, 208 V panel and
 * troffer in builtin.ts: a switch, hardwired equipment connections, 277/480 V
 * distribution, a step-down transformer and a 480 V makeup air unit. Generic
 * and made up; each describes itself the way the served-from adapter reads it
 * (CONNECTIONS.md, "How a part describes itself").
 */

const IN = 25.4;
const source = (version: string): PartTypeDefinition["source"] => ({ kind: "builtin", libraryVersion: version });
const p = (name: string): Dim => ({ param: name });
const half = (name: string): Dim => ({ param: name, scale: 0.5 });

function length(name: string, label: string): ParamDef {
  return { name, label, kind: "length", unit: "mm", min: 0 };
}
function num(name: string, label: string, unit: ParamDef["unit"], def?: number): ParamDef {
  return { name, label, kind: "number", unit, min: 0, ...(def !== undefined ? { default: def } : {}) };
}
function text(name: string, label: string): ParamDef {
  return { name, label, kind: "text" };
}

function power(id: string, z: Dim, voltage: Dim, poles: number, load: Dim): PartConnector {
  return { id, label: id === "power" ? "Power" : id === "primary" ? "Primary" : "Feeder", domain: "electrical", systemKind: "power", position: [0, 0, z], direction: [0, 0, 1], shape: "none", voltage, poles, flow: load };
}

/** NEMA enclosure types offered for distribution equipment (V3: exterior panels go NEMA 3R). */
export const ENCLOSURES = ["NEMA 1", "NEMA 3R", "NEMA 4X", "NEMA 12"];

function letter(t: string, size = 90): SymbolPrimitive {
  return { kind: "text", at: [0, 0], text: t, heightMm: size };
}

/** A wall-mounted cabinet sitting 300 mm up, front face on the insertion line (like the 208 V panelboard). */
const CABINET: Pick<PartTypeDefinition, "geometry" | "symbol"> = {
  geometry: [{ kind: "box", center: [0, half("depth"), { param: "height", scale: 0.5, add: 300 }], size: [p("width"), p("depth"), p("height")] }],
  symbol: [{ kind: "rect", center: [0, half("depth")], size: [p("width"), p("depth")] }, { kind: "line", from: [{ param: "width", scale: -0.5 }, p("depth")], to: [half("width"), p("depth")] }],
};

export function electricalStarterTypes(version: string): LibraryEntry[] {
  const SWITCH: LibraryEntry = {
    id: "builtin:switch-single-pole@1",
    definition: {
      familyName: "Switch, single pole",
      typeName: "20A 120/277V",
      category: "electrical_device",
      typeParams: [num("voltage", "Voltage", "v"), num("rating", "Rating", "a")],
      typeValues: { voltage: 120, rating: 20 },
      instanceParams: [text("circuit", "Circuit"), text("switch_leg", "Controls")],
      connectors: [power("power", 50, p("voltage"), 1, 0)],
      geometry: [{ kind: "box", center: [0, -10, 60], size: [70, 20, 115] }],
      symbol: [letter("S", 140)],
      tagFields: ["circuit"],
      source: source(version),
    },
  };

  const equipmentConnection = (poles: 1 | 2 | 3, voltage: number, va: number): LibraryEntry => ({
    id: `builtin:equipment-connection-${poles}p@1`,
    definition: {
      familyName: "Equipment connection, hardwired",
      typeName: poles === 1 ? `${voltage} V, 1 pole` : poles === 2 ? `${voltage} V, 2 poles` : `${voltage} V 3-phase`,
      category: "electrical_device",
      description: "A hardwired connection to equipment: set its voltage, load and breaker size to the equipment's nameplate.",
      typeParams: [length("size", "Size")],
      typeValues: { size: 4 * IN },
      instanceParams: [num("voltage", "Voltage", "v", voltage), num("load", "Load", "va", va), num("mocp", "Maximum overcurrent protection", "a"), text("serves", "Serves"), text("circuit", "Circuit")],
      connectors: [power("power", 0, p("voltage"), poles, p("load"))],
      geometry: [{ kind: "box", center: [0, 0, half("size")], size: [p("size"), p("size"), p("size")] }],
      symbol: [{ kind: "circle", center: [0, 0], radius: half("size") }, { kind: "line", from: [{ param: "size", scale: -0.35 }, { param: "size", scale: -0.35 }], to: [{ param: "size", scale: 0.35 }, { param: "size", scale: 0.35 }] }],
      tagFields: ["mark", "circuit"],
      source: source(version),
    },
  });

  /** Bus, mains and enclosure are each panel's own (set in its properties); voltage, phases and circuits come with the type. */
  const distribution = (id: string, familyName: string, typeName: string, values: { bus_rating: number; mains: string; voltage: number; phases: string; circuits: number }, size: readonly [number, number, number]): LibraryEntry => {
    const { bus_rating, mains, ...typeValues } = values;
    return {
      id,
      definition: {
        familyName,
        typeName,
        category: "electrical_equipment",
        typeParams: [
          length("width", "Width"),
          length("height", "Height"),
          length("depth", "Depth"),
          num("voltage", "Voltage", "v"),
          { name: "phases", label: "Phases", kind: "choice", choices: ["1", "3"] },
          num("circuits", "Circuits", "count"),
        ],
        typeValues: { width: size[0] * IN, height: size[1] * IN, depth: size[2] * IN, ...typeValues },
        instanceParams: [
          text("panel_name", "Panel name"),
          num("bus_rating", "Bus rating", "a", bus_rating),
          { name: "mains", label: "Mains", kind: "text", default: mains },
          { name: "enclosure", label: "Enclosure", kind: "choice", choices: ENCLOSURES, default: "NEMA 1" },
          num("aic", "Short-circuit rating", "a", 22000),
        ],
        connectors: [power("feeder", p("height"), p("voltage"), 3, 0)],
        ...CABINET,
        tagFields: ["panel_name"],
        source: source(version),
      },
    };
  };

  const PANEL_480 = distribution("builtin:panelboard-225-480@1", "Panelboard, surface", "225A 480Y/277V 42 circuit", { bus_rating: 225, voltage: 480, phases: "3", circuits: 42, mains: "MLO" }, [20, 60, 5.75]);
  const SWITCHBOARD = distribution("builtin:switchboard-800-480@1", "Switchboard", "800A 480Y/277V", { bus_rating: 800, voltage: 480, phases: "3", circuits: 30, mains: "800A MCB" }, [40, 90, 30]);

  const TRANSFORMER: LibraryEntry = {
    id: "builtin:transformer-75kva@1",
    definition: {
      familyName: "Transformer, dry type",
      typeName: "75 kVA 480Δ-208Y/120V",
      category: "electrical_equipment",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("kva", "Rating", "kw"), num("primary_voltage", "Primary voltage", "v"), num("secondary_voltage", "Secondary voltage", "v")],
      typeValues: { width: 30 * IN, height: 36 * IN, depth: 24 * IN, kva: 75, primary_voltage: 480, secondary_voltage: 208 },
      instanceParams: [text("panel_name", "Name")],
      connectors: [power("primary", p("height"), p("primary_voltage"), 3, 0)],
      geometry: [{ kind: "box", center: [0, 0, half("height")], size: [p("width"), p("depth"), p("height")] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [p("width"), p("depth")] }, letter("T", 160)],
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  return [SWITCH, equipmentConnection(1, 120, 1000), equipmentConnection(2, 208, 3000), equipmentConnection(3, 208, 5000), PANEL_480, SWITCHBOARD, TRANSFORMER, makeupAirUnit(version), ...distributionTypes(version), ...deviceTypes(version)];
}

function makeupAirUnitV1(version: string): LibraryEntry {
  return {
    id: "builtin:makeup-air-unit-480@1",
    definition: {
      familyName: "Makeup air unit",
      typeName: "10 kW, 480 V 3-phase",
      category: "mechanical_equipment",
      typeParams: [length("length", "Length"), length("width", "Width"), length("height", "Height"), num("supply_cfm", "Supply airflow", "cfm"), num("voltage", "Voltage", "v"), num("load_va", "Load", "va"), num("mca", "Minimum circuit ampacity", "a"), num("mocp", "Maximum overcurrent protection", "a")],
      typeValues: { length: 2000, width: 1200, height: 1100, supply_cfm: 3000, voltage: 480, load_va: 10000, mca: 16, mocp: 20 },
      instanceParams: [text("serves", "Serves")],
      connectors: [
        { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [-600, 0, 0], direction: [0, 0, -1], shape: "rect", width: 24 * IN, height: 12 * IN, flow: p("supply_cfm") },
        power("power", p("height"), p("voltage"), 3, p("load_va")),
      ],
      geometry: [{ kind: "box", center: [0, 0, half("height")], size: [p("length"), p("width"), p("height")] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [p("length"), p("width")] }, letter("MAU", 200)],
      tagFields: ["mark"],
      source: source(version),
    },
  };
}

/** The makeup air unit takes all of its air from outdoors, through a weather hood on its end. */
function makeupAirUnit(version: string): LibraryEntry {
  const v1 = makeupAirUnitV1(version).definition;
  return {
    id: "builtin:makeup-air-unit-480@2",
    definition: {
      ...v1,
      typeParams: [...v1.typeParams, num("outdoor_cfm", "Outdoor airflow", "cfm")],
      typeValues: { ...v1.typeValues, outdoor_cfm: 3000 },
      connectors: [
        ...v1.connectors,
        { id: "outdoor_air", label: "Outdoor air", domain: "duct", systemKind: "outside_air", position: [half("length"), 0, half("height")], direction: [1, 0, 0], shape: "rect", width: 30 * IN, height: 18 * IN, flow: p("outdoor_cfm"), flowDirection: "in", intake: "hood" },
      ],
    },
  };
}

/** Earlier versions a model may have placed (see SUPERSEDED_BUILTIN_PART_TYPES). */
export function supersededElectricalStarterTypes(version: string): LibraryEntry[] {
  return [makeupAirUnitV1(version)];
}

const choice = (name: string, label: string, choices: string[]): ParamDef => ({ name, label, kind: "choice", choices });
const yesNo = (name: string, label: string, def: boolean): ParamDef => ({ name, label, kind: "boolean", default: def });
const CONNECTION_TYPE = text("connection_type", "Connection type");

/** A box on the floor, front face on the insertion line. */
function floorBox(label: string, size = 160): Pick<PartTypeDefinition, "geometry" | "symbol"> {
  return {
    geometry: [{ kind: "box", center: [0, half("depth"), half("height")], size: [p("width"), p("depth"), p("height")] }],
    symbol: [{ kind: "rect", center: [0, half("depth")], size: [p("width"), p("depth")] }, { kind: "text", at: [0, half("depth")], text: label, heightMm: size }],
  };
}

/**
 * Distribution equipment beyond the starter set: panelboards with main
 * breakers and a single-phase unit panel, a sectioned switchboard, more
 * transformer sizes, a generator, an automatic transfer switch, a meter and
 * CT cabinet, a tap box, and fused and non-fused disconnects. Each states its voltage
 * system, ratings and connectors the way the served-from adapter reads them
 * (CONNECTIONS.md, "How a part describes itself").
 */
function distributionTypes(version: string): LibraryEntry[] {
  const panel = (id: string, familyName: string, typeName: string, voltage: number, phases: "1" | "3", circuits: number, bus: number, mains: string, size: readonly [number, number, number]): LibraryEntry => ({
    id,
    definition: {
      familyName,
      typeName,
      category: "electrical_equipment",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("bus_rating", "Bus rating", "a"), num("voltage", "Voltage", "v"), choice("phases", "Phases", ["1", "3"]), num("circuits", "Circuits", "count"), text("mains", "Mains"), choice("enclosure", "Enclosure", ["NEMA 1", "NEMA 3R"])],
      typeValues: { width: size[0] * IN, height: size[1] * IN, depth: size[2] * IN, bus_rating: bus, voltage, phases, circuits, mains, enclosure: "NEMA 1" },
      instanceParams: [text("panel_name", "Panel name"), num("aic", "Short-circuit rating", "a", 10000), text("mounting", "Mounting")],
      connectors: [power("feeder", p("height"), p("voltage"), phases === "3" ? 3 : 2, 0)],
      ...CABINET,
      tagFields: ["panel_name"],
      source: source(version),
    },
  });

  const transformer = (kva: number, size: readonly [number, number, number]): LibraryEntry => ({
    id: `builtin:transformer-${String(kva).replace(".", "_")}kva@1`,
    definition: {
      familyName: "Transformer, dry type",
      typeName: `${kva} kVA 480Δ-208Y/120V`,
      category: "electrical_equipment",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("kva", "Rating", "kw"), num("primary_voltage", "Primary voltage", "v"), num("secondary_voltage", "Secondary voltage", "v"), choice("k_factor", "K-factor", ["K-1", "K-4", "K-13"])],
      typeValues: { width: size[0] * IN, height: size[1] * IN, depth: size[2] * IN, kva, primary_voltage: 480, secondary_voltage: 208, k_factor: "K-1" },
      instanceParams: [text("panel_name", "Name")],
      connectors: [power("primary", p("height"), p("primary_voltage"), 3, 0)],
      geometry: [{ kind: "box", center: [0, 0, half("height")], size: [p("width"), p("depth"), p("height")] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [p("width"), p("depth")] }, letter("T", 160)],
      tagFields: ["panel_name"],
      source: source(version),
    },
  });

  const SWBD_SECTIONS: LibraryEntry = {
    id: "builtin:switchboard-sections-1600-480@1",
    definition: {
      familyName: "Switchboard, front accessible",
      typeName: "1600A 480Y/277V, sections",
      category: "electrical_equipment",
      description: "A switchboard of several 40\" sections: its width follows the number of sections.",
      typeParams: [
        num("sections", "Sections", "count", 3),
        length("section_width", "Section width"),
        { name: "width", label: "Width", kind: "length", unit: "mm", min: 0, formula: "sections * section_width" },
        length("height", "Height"),
        length("depth", "Depth"),
        num("bus_rating", "Bus rating", "a"),
        num("voltage", "Voltage", "v"),
        choice("phases", "Phases", ["1", "3"]),
        num("circuits", "Feeder positions", "count"),
        text("mains", "Mains"),
        choice("enclosure", "Enclosure", ["NEMA 1", "NEMA 3R"]),
      ],
      typeValues: { sections: 3, section_width: 40 * IN, height: 90 * IN, depth: 36 * IN, bus_rating: 1600, voltage: 480, phases: "3", circuits: 42, mains: "1600A MCB", enclosure: "NEMA 1" },
      instanceParams: [text("panel_name", "Panel name"), num("aic", "Short-circuit rating", "a", 65000), yesNo("spd", "Surge protective device", true), yesNo("service_entrance", "Service entrance rated", true)],
      connectors: [power("feeder", p("height"), p("voltage"), 3, 0)],
      geometry: [{ kind: "box", center: [0, half("depth"), half("height")], size: [p("width"), p("depth"), p("height")] }],
      symbol: [{ kind: "rect", center: [0, half("depth")], size: [p("width"), p("depth")] }, { kind: "text", at: [0, half("depth")], text: "SWBD", heightMm: 200 }],
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  const GENERATOR: LibraryEntry = {
    id: "builtin:generator-150kw-480@1",
    definition: {
      familyName: "Generator, diesel",
      typeName: "150 kW / 187.5 kVA 480Y/277V",
      category: "electrical_equipment",
      typeParams: [length("width", "Length"), length("depth", "Width"), length("height", "Height"), num("kw", "Rating", "kw"), num("kva", "Apparent power", "kw"), num("voltage", "Voltage", "v"), choice("phases", "Phases", ["1", "3"]), text("fuel", "Fuel")],
      typeValues: { width: 140 * IN, depth: 50 * IN, height: 70 * IN, kw: 150, kva: 187.5, voltage: 480, phases: "3", fuel: "Diesel" },
      instanceParams: [text("panel_name", "Name"), choice("service", "Serves", ["Emergency", "Legally required standby", "Optional standby"])],
      connectors: [],
      ...floorBox("GEN", 220),
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  const ATS: LibraryEntry = {
    id: "builtin:ats-400-480@1",
    definition: {
      familyName: "Automatic transfer switch",
      typeName: "400A 480Y/277V 4-pole",
      category: "electrical_equipment",
      description: "Fed on its normal side from the building's distribution and on its emergency side from a generator.",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("bus_rating", "Rating", "a"), num("voltage", "Voltage", "v"), choice("phases", "Phases", ["1", "3"]), choice("switched_poles", "Switched poles", ["3", "4"]), yesNo("service_entrance", "Service entrance rated", false)],
      typeValues: { width: 30 * IN, height: 72 * IN, depth: 20 * IN, bus_rating: 400, voltage: 480, phases: "3", switched_poles: "4", service_entrance: false },
      instanceParams: [text("panel_name", "Name"), num("aic", "Withstand rating", "a", 42000)],
      connectors: [
        { ...power("normal", p("height"), p("voltage"), 3, 0), label: "Normal" },
        { ...power("emergency", p("height"), p("voltage"), 3, 0), label: "Emergency", position: [{ param: "width", scale: 0.25 }, 0, p("height")] },
      ],
      ...CABINET,
      symbol: [...(CABINET.symbol ?? []), { kind: "text", at: [0, half("depth")], text: "ATS", heightMm: 120 }],
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  const METER: LibraryEntry = {
    id: "builtin:ct-cabinet-meter-800-480@1",
    definition: {
      familyName: "Meter and CT cabinet",
      typeName: "800A 480Y/277V",
      category: "electrical_equipment",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("bus_rating", "Rating", "a"), num("voltage", "Voltage", "v"), choice("phases", "Phases", ["1", "3"]), text("utility", "Utility")],
      typeValues: { width: 36 * IN, height: 48 * IN, depth: 12 * IN, bus_rating: 800, voltage: 480, phases: "3", utility: "" },
      instanceParams: [text("panel_name", "Name")],
      connectors: [{ ...power("line", p("height"), p("voltage"), 3, 0), label: "Line" }],
      ...CABINET,
      symbol: [...(CABINET.symbol ?? []), { kind: "text", at: [0, half("depth")], text: "CT", heightMm: 120 }],
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  const TAP_BOX: LibraryEntry = {
    id: "builtin:tap-box-1200-480@1",
    definition: {
      familyName: "Tap box",
      typeName: "1200A 480Y/277V",
      category: "electrical_equipment",
      description: "Service equipment with no breakers: the service conductors land here and the feeders tap off (a fire pump service, the main switchboard).",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("bus_rating", "Rating", "a"), num("voltage", "Voltage", "v"), choice("phases", "Phases", ["1", "3"]), choice("enclosure", "Enclosure", ["NEMA 1", "NEMA 3R"])],
      typeValues: { width: 36 * IN, height: 36 * IN, depth: 10 * IN, bus_rating: 1200, voltage: 480, phases: "3", enclosure: "NEMA 3R" },
      instanceParams: [text("panel_name", "Name")],
      connectors: [{ ...power("line", p("height"), p("voltage"), 3, 0), label: "Line" }],
      ...CABINET,
      symbol: [...(CABINET.symbol ?? []), { kind: "text", at: [0, half("depth")], text: "TAP", heightMm: 120 }],
      tagFields: ["panel_name"],
      source: source(version),
    },
  };

  const disconnect = (fused: boolean, amps: number, fuseA: number | null, enclosure: string): LibraryEntry => ({
    id: `builtin:disconnect-${fused ? "fused" : "nf"}-${amps}-480@1`,
    definition: {
      familyName: fused ? "Disconnect switch, fused" : "Disconnect switch, non-fused",
      typeName: `${amps}A 600V 3P${fused ? `, ${fuseA}A fuses` : ""}, ${enclosure}`,
      category: "electrical_equipment",
      typeParams: [length("width", "Width"), length("height", "Height"), length("depth", "Depth"), num("bus_rating", "Switch rating", "a"), num("voltage", "System voltage", "v"), choice("phases", "Phases", ["1", "3"]), choice("enclosure", "Enclosure", ["NEMA 1", "NEMA 3R", "NEMA 4X"]), ...(fused ? [num("fuse_rating", "Fuses", "a")] : [])],
      typeValues: { width: 8 * IN, height: 14 * IN, depth: 5 * IN, bus_rating: amps, voltage: 480, phases: "3", enclosure, ...(fused && fuseA !== null ? { fuse_rating: fuseA } : {}) },
      instanceParams: [text("panel_name", "Name"), text("serves", "Serves")],
      connectors: [{ ...power("line", p("height"), p("voltage"), 3, 0), label: "Line" }],
      ...CABINET,
      symbol: [...(CABINET.symbol ?? []), { kind: "text", at: [0, half("depth")], text: fused ? "DF" : "DS", heightMm: 70 }],
      tagFields: ["panel_name"],
      source: source(version),
    },
  });

  return [
    panel("builtin:panelboard-225-mcb@1", "Panelboard, surface", "225A 208Y/120V 42 circuit, main breaker", 208, "3", 42, 225, "225A MCB", [20, 60, 5.75]),
    panel("builtin:panelboard-225-480-mcb@1", "Panelboard, surface", "225A 480Y/277V 42 circuit, main breaker", 480, "3", 42, 225, "225A MCB", [20, 60, 5.75]),
    panel("builtin:panelboard-125-208-1ph@1", "Panelboard, load center", "125A 120/208V 1-phase 3-wire 30 circuit, main breaker", 208, "1", 30, 125, "125A MCB", [14.25, 30, 4]),
    SWBD_SECTIONS,
    transformer(45, [24, 30, 20]),
    transformer(112.5, [36, 42, 30]),
    GENERATOR,
    ATS,
    METER,
    TAP_BOX,
    disconnect(false, 30, null, "NEMA 3R"),
    disconnect(false, 60, null, "NEMA 1"),
    disconnect(true, 60, 40, "NEMA 1"),
    disconnect(true, 100, 80, "NEMA 3R"),
  ];
}

/**
 * Devices beyond the duplex receptacle, junction box, switch and troffer:
 * quad, GFCI, floor, ceiling and countertop receptacles, a downlight and a
 * troffer with an emergency battery, and an exit sign. Each power connector
 * carries its load class, and each takes a connection type.
 */
function deviceTypes(version: string): LibraryEntry[] {
  // Mounting height is where it is placed (the placement height); `mounting` only says where it goes.
  const receptacle = (id: string, familyName: string, typeName: string, load: number, gfci: boolean, mounting: string, mark: SymbolPrimitive[]): LibraryEntry => ({
    id,
    definition: {
      familyName,
      typeName,
      category: "electrical_device",
      typeParams: [num("voltage", "Voltage", "v"), num("rating", "Rating", "a"), text("nema", "NEMA configuration"), text("mounting", "Mounting")],
      typeValues: { voltage: 120, rating: 20, nema: "5-20R", mounting },
      instanceParams: [text("circuit", "Circuit"), num("load", "Load", "va", load), yesNo("gfci", "GFCI", gfci), CONNECTION_TYPE],
      connectors: [{ ...power("power", 50, p("voltage"), 1, p("load")), loadClass: "receptacle" }],
      geometry: [{ kind: "box", center: [0, -10, 60], size: [70, 20, 115] }],
      symbol: [{ kind: "circle", center: [0, 0], radius: 100 }, { kind: "line", from: [-60, -40], to: [-60, 40] }, { kind: "line", from: [60, -40], to: [60, 40] }, ...mark],
      tagFields: ["circuit"],
      source: source(version),
    },
  });

  const light = (id: string, familyName: string, typeName: string, watts: number, voltage: number, emergency: boolean, size: readonly [number, number], symbol: SymbolPrimitive[]): LibraryEntry => ({
    id,
    definition: {
      familyName,
      typeName,
      category: "lighting_fixture",
      typeParams: [length("length", "Length"), length("width", "Width"), num("watts", "Input power", "w"), num("voltage", "Voltage", "v")],
      typeValues: { length: size[0], width: size[1], watts, voltage },
      instanceParams: [text("circuit", "Circuit"), text("switch_leg", "Switch leg"), yesNo("emergency", "Emergency battery", emergency), text("type_mark", "Fixture type"), CONNECTION_TYPE],
      connectors: [{ ...power("power", 100, p("voltage"), 1, p("watts")), loadClass: "lighting", continuous: true }],
      geometry: [{ kind: "box", center: [0, 0, 60], size: [p("length"), p("width"), 120] }],
      symbol,
      tagFields: ["type_mark", "circuit"],
      source: source(version),
    },
  });

  return [
    receptacle("builtin:quad-receptacle@1", "Receptacle, quad", "20A 125V NEMA 5-20R, two duplexes", 360, false, "Wall", [{ kind: "line", from: [-90, 0], to: [90, 0] }]),
    receptacle("builtin:gfci-receptacle@1", "Receptacle, GFCI duplex", "20A 125V NEMA 5-20R GFCI", 180, true, "Wall", [letter("GFI", 60)]),
    receptacle("builtin:countertop-receptacle@1", "Receptacle, countertop GFCI", "20A 125V NEMA 5-20R GFCI, above counter", 180, true, "Above counter", [letter("C", 60)]),
    receptacle("builtin:floor-receptacle@1", "Receptacle, floor box", "20A 125V NEMA 5-20R in floor box", 180, false, "Floor", [{ kind: "rect", center: [0, 0], size: [240, 240] }]),
    receptacle("builtin:ceiling-receptacle@1", "Receptacle, ceiling", "20A 125V NEMA 5-20R, ceiling mounted", 180, false, "Ceiling", [letter("CLG", 50)]),
    light("builtin:downlight-6-led@1", "Downlight, recessed LED", '6", 1500 lm', 15, 277, false, [7 * IN, 7 * IN], [{ kind: "circle", center: [0, 0], radius: 3.5 * IN }]),
    light("builtin:troffer-2x4-led-em@1", "Troffer, recessed LED", "2x4, 4000 lm, emergency battery", 32, 277, true, [4 * FT_MM, 2 * FT_MM], [{ kind: "rect", center: [0, 0], size: [4 * FT_MM, 2 * FT_MM] }, { kind: "line", from: [-2 * FT_MM, 0], to: [2 * FT_MM, 0] }, letter("EM", 120)]),
    light("builtin:exit-sign-led@1", "Exit sign, LED", "Single face, battery", 2, 277, true, [12 * IN, 2 * IN], [{ kind: "rect", center: [0, 0], size: [12 * IN, 3 * IN] }, letter("EXIT", 60)]),
  ];
}

const FT_MM = 12 * IN;
