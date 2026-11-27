import type { BuiltinPartTypeRow, Dim, LibraryEntry, ParamDef, PartConnector, PartPrimitive, PartTypeDefinition, SymbolPrimitive } from "@permitzip/bim-kernel";

/**
 * Starter mechanical types (ceiling air terminals, packaged rooftop units,
 * inline centrifugal fans and VAV terminal units) contributed via
 * `PART_TYPE_POINT`. Generic and made up; no client data.
 */
const IN = 25.4;

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

function power(id: string, z: Dim, voltage: Dim, poles: number, load: Dim): PartConnector {
  return { id, label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, z], direction: [0, 0, 1], shape: "none", voltage, poles, flow: load };
}

const innerFace: SymbolPrimitive = { kind: "rect", center: [0, 0], size: [{ param: "face_size", scale: 0.6 }, { param: "face_size", scale: 0.6 }] };

function buildMechanicalStarterTypes(version: string): { readonly offered: readonly LibraryEntry[]; readonly superseded: readonly LibraryEntry[] } {
  const source: PartTypeDefinition["source"] = { kind: "builtin", libraryVersion: version };

  const ceilingTerminal = (id: string, typeName: string, system: "supply_air" | "return_air" | "exhaust_air", faceIn: number, neckIn: number, defaultCfm: number): LibraryEntry => ({
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
          endType: "mechanical.slip",
          flow: p("airflow"),
        },
      ],
      geometry: [
        { kind: "box", center: [0, 0, 25], size: [p("face_size"), p("face_size"), 50] },
        { kind: "cylinder", center: [0, 0, 100], radius: half("neck_diameter"), height: 100, axis: "z" },
      ],
      symbol: [
        { kind: "rect", center: [0, 0], size: [p("face_size"), p("face_size")], fill: "mask", pen: "medium" },
        ...(system === "supply_air" ? cross("face_size", "face_size") : [innerFace]),
      ],
      tagFields: ["mark", "airflow"],
      source,
    },
  });

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
        { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [-400, 0, 0], direction: [0, 0, -1], shape: "rect", width: 24 * IN, height: 12 * IN, endType: "mechanical.flanged", flow: p("supply_cfm") },
        { id: "return", label: "Return", domain: "duct", systemKind: "return_air", position: [400, 0, 0], direction: [0, 0, -1], shape: "rect", width: 24 * IN, height: 14 * IN, endType: "mechanical.flanged", flow: p("supply_cfm") },
        power("power", p("height"), p("voltage"), 3, 11000),
      ],
      geometry: [bodyBox("length", "width", "height")],
      symbol: [outline("length", "width"), ...cross("length", "width")],
      tagFields: ["mark"],
      source,
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
        { id: "outdoor_air", label: "Outdoor air", domain: "duct", systemKind: "outside_air", position: [half("length"), 0, { param: "height", scale: 0.55 }], direction: [1, 0, 0], shape: "rect", width: 30 * IN, height: 12 * IN, endType: "mechanical.flanged", flow: p("outdoor_cfm"), flowDirection: "in", intake: "hood" },
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
        { id: "inlet", label: "Inlet", domain: "duct", systemKind: "exhaust_air", position: [neg("length"), 0, 0], direction: [-1, 0, 0], shape: "round", diameter: p("duct_diameter"), endType: "mechanical.slip", flow: p("airflow") },
        { id: "outlet", label: "Outlet", domain: "duct", systemKind: "exhaust_air", position: [half("length"), 0, 0], direction: [1, 0, 0], shape: "round", diameter: p("duct_diameter"), endType: "mechanical.slip", flow: p("airflow") },
        power("power", half("diameter"), p("voltage"), 1, 600),
      ],
      geometry: [{ kind: "cylinder", center: [0, 0, 0], radius: half("diameter"), height: p("length"), axis: "x" }],
      symbol: [outline("length", "diameter"), { kind: "circle", center: [0, 0], radius: { param: "diameter", scale: 0.3 } }],
      tagFields: ["mark", "airflow"],
      source,
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
        { id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", position: [neg("length"), 0, 0], direction: [-1, 0, 0], shape: "round", diameter: p("inlet_diameter"), endType: "mechanical.slip", flow: p("max_cfm") },
        { id: "outlet", label: "Discharge", domain: "duct", systemKind: "supply_air", position: [half("length"), 0, 0], direction: [1, 0, 0], shape: "rect", width: 14 * IN, height: 10 * IN, endType: "mechanical.flanged", flow: p("max_cfm") },
        power("power", half("height"), p("voltage"), 1, 3000),
      ],
      geometry: [{ kind: "box", center: [0, 0, 0], size: [p("length"), p("width"), p("height")] }],
      symbol: [outline("length", "width"), { kind: "text", at: [0, 0], text: "VAV", heightMm: 120 }],
      tagFields: ["mark", "max_cfm"],
      source,
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

  return {
    offered: [
      ceilingTerminal("builtin:supply-diffuser-24@1", '24x24, 8" neck', "supply_air", 24, 8, 150),
      ceilingTerminal("builtin:return-grille-24@1", '24x24, 12" neck', "return_air", 24, 12, 400),
      ceilingTerminal("builtin:exhaust-grille-12@1", '12x12, 6" neck', "exhaust_air", 12, 6, 75),
      RTU_V2,
      INLINE_FAN,
      INLINE_FAN_OA,
      VAV_V2,
    ],
    superseded: [RTU, VAV],
  };
}

export function mechanicalStarterTypes(version: string): readonly LibraryEntry[] {
  return buildMechanicalStarterTypes(version).offered;
}

export function supersededMechanicalStarterTypes(version: string): readonly LibraryEntry[] {
  return buildMechanicalStarterTypes(version).superseded;
}

export function mechanicalStarterPartTypeRows(version: string): readonly BuiltinPartTypeRow[] {
  const { offered, superseded } = buildMechanicalStarterTypes(version);
  return [...offered.map((entry) => ({ entry })), ...superseded.map((entry) => ({ entry, superseded: true }))];
}
