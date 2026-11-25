import { BUILTIN_LIBRARY_VERSION, type ParamDef, type PartTypeDefinition, type SymbolPrimitive } from "@permitzip/bim-kernel";

/**
 * Cut-sheet-accurate commercial MEP equipment, fixtures, luminaires, and millwork
 * authored for MutinyBIM's default showcase building (`createShowcaseDemoModel`).
 *
 * Orientation convention across every wall-facing fixture/casework part:
 * - Local `y = 0` is the rear mounting wall face; the fixture projects into `+Y`.
 * - `rotationDeg = 0` faces North (+Y); `90` faces West (-X); `180` faces South (-Y); `270` faces East (+X).
 *
 * All dimensions are derived from published commercial cut sheets (Carrier 50FC-A06,
 * Greenheck G-085, Titus TMS-3-8-24X24, A.O. Smith DRE-52, Kohler K-4350 Highcliff,
 * Kohler K-2210 Caxton, Elkay LR2522 Lustertone, Lithonia 2GTL4 / LDN6 / WDGE2).
 */

const IN = 25.4;
const FT = 304.8;

const len = (name: string, label: string): ParamDef => ({ name, label, kind: "length", unit: "mm", min: 0 });
const num = (name: string, label: string, unit: ParamDef["unit"] = "none", def?: number): ParamDef => ({
  name,
  label,
  kind: "number",
  unit,
  min: 0,
  ...(def !== undefined ? { default: def } : {}),
});
const txt = (name: string, label: string): ParamDef => ({ name, label, kind: "text" });
const bool = (name: string, label: string, def = false): ParamDef => ({ name, label, kind: "boolean", default: def });
const choice = (name: string, label: string, choices: readonly string[], def?: string): ParamDef => ({
  name,
  label,
  kind: "choice",
  choices: [...choices],
  ...(def !== undefined ? { default: def } : {}),
});
const src = () => ({ kind: "builtin" as const, libraryVersion: BUILTIN_LIBRARY_VERSION });

/** Smooth left-half semicircle polygon of radius `r` for ANSI/NEC emergency luminaire shading. */
const halfCircleLeft = (r: number, steps = 20): Array<[number, number]> =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = Math.PI / 2 + (Math.PI * i) / steps;
    return [Number((r * Math.cos(a)).toFixed(3)), Number((r * Math.sin(a)).toFixed(3))] as [number, number];
  });

/** Helper: smooth rounded-rectangle 2D contour using 4 corner arcs + 4 straight tangents. */
function roundedRect2d(cx: number, cy: number, w: number, h: number, r: number, pen: "thin" | "medium" = "thin"): SymbolPrimitive[] {
  const hw = w / 2;
  const hh = h / 2;
  const cr = Math.min(r, hw, hh);
  return [
    { kind: "line", from: [cx - hw + cr, cy - hh], to: [cx + hw - cr, cy - hh], pen },
    { kind: "line", from: [cx + hw, cy - hh + cr], to: [cx + hw, cy + hh - cr], pen },
    { kind: "line", from: [cx + hw - cr, cy + hh], to: [cx - hw + cr, cy + hh], pen },
    { kind: "line", from: [cx - hw, cy + hh - cr], to: [cx - hw, cy - hh + cr], pen },
    { kind: "arc", center: [cx + hw - cr, cy - hh + cr], radius: cr, startDeg: 270, sweepDeg: 90, pen },
    { kind: "arc", center: [cx + hw - cr, cy + hh - cr], radius: cr, startDeg: 0, sweepDeg: 90, pen },
    { kind: "arc", center: [cx - hw + cr, cy + hh - cr], radius: cr, startDeg: 90, sweepDeg: 90, pen },
    { kind: "arc", center: [cx - hw + cr, cy - hh + cr], radius: cr, startDeg: 180, sweepDeg: 90, pen },
  ];
}

// =============================================================================
// 1. Carrier 50FC-A06 — 5-Ton Packaged Rooftop Unit (RTU-1)
//    Cut sheet: 74-3/8" L × 46-5/8" W × 33-3/8" H (1889 × 1184 × 848 mm)
//    14" (356 mm) roof curb; bottom supply & return drops; 511 lb operating weight
// =============================================================================
export const SHOWCASE_RTU: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:rtu-carrier-50fc06@1",
  definition: {
    familyName: "Rooftop unit, packaged DX",
    typeName: "Carrier 50FC-A06 (5 Ton, 2000 CFM, 480V/3Ø)",
    category: "mechanical_equipment",
    description: "5-ton single-package rooftop air conditioner on 14\" roof curb with economizer and CO2 DCV.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      num("cooling_tons", "Cooling capacity (tons)", "none"),
      num("heating_mbh", "Heating capacity (MBH)", "none"),
      num("supply_cfm", "Supply airflow", "cfm"),
      num("outdoor_cfm", "Outdoor airflow", "cfm"),
      num("hp", "Blower motor HP", "none"),
      num("voltage", "Voltage", "v"),
      num("mca", "MCA", "a"),
      num("mocp", "MOCP", "a"),
      num("operating_weight", "Operating weight (lb)", "none"),
      txt("curb_size", "Roof curb size"),
      len("service_clearance", "Service clearance"),
      txt("sequence_of_operation", "Sequence of operation"),
    ],
    typeValues: {
      manufacturer: "Carrier",
      model: "50FC-A06",
      "material_id": "architecture.galvanized_steel",
      cooling_tons: 5,
      heating_mbh: 72,
      supply_cfm: 2000,
      outdoor_cfm: 400,
      hp: 2,
      voltage: 480,
      mca: 16,
      mocp: 25,
      operating_weight: 511,
      curb_size: "74 x 47 in",
      service_clearance: 36 * IN,
      sequence_of_operation: "Occupied 68F/74F w/ economizer, CO2 DCV & night setback",
    },
    instanceParams: [txt("circuit", "Circuit"), txt("serves", "Serves"), txt("room", "Location")],
    connectors: [
      {
        id: "supply",
        label: "Supply discharge",
        domain: "duct",
        systemKind: "supply_air",
        position: [-420, -240, 0],
        direction: [0, 0, -1],
        shape: "rect",
        width: 16 * IN,
        height: 10 * IN,
        flowDirection: "out",
        flow: 2000,
      },
      {
        id: "return",
        label: "Return intake",
        domain: "duct",
        systemKind: "return_air",
        position: [-420, 260, 0],
        direction: [0, 0, -1],
        shape: "rect",
        width: 16 * IN,
        height: 12 * IN,
        flowDirection: "in",
        flow: 2000,
      },
      {
        id: "power",
        label: "Power",
        domain: "electrical",
        systemKind: "power",
        position: [945, -300, 500],
        direction: [1, 0, 0],
        shape: "none",
        voltage: 480,
        poles: 3,
        flow: 8200,
      },
    ],
    geometry: [
      // 14" (356 mm) insulated roof mounting curb
      { kind: "box", center: [0, 0, 178], size: [1790, 1085, 356] },
      // Main powder-coated equipment cabinet (74-3/8" × 46-5/8" × 33-3/8")
      { kind: "box", center: [0, 0, 356 + 424], size: [1889, 1184, 848] },
      // Crisp top drip-edge roof cap overhang
      { kind: "box", center: [0, 0, 356 + 848 + 18], size: [1930, 1224, 36] },
      // Raised top condenser fan discharge shroud (26" Ø × 6" H)
      { kind: "cylinder", center: [440, 0, 356 + 884 + 75], radius: 330, height: 150, axis: "z" },
      // Outdoor air economizer intake hood on west end
      { kind: "box", center: [-1035, 0, 356 + 340], size: [190, 780, 480] },
      // Electrical disconnect / control vestibule on east-south corner
      { kind: "box", center: [970, -300, 356 + 380], size: [55, 280, 420] },
    ],
    clearances: [
      {
        id: "service",
        name: "Service & Filter Access",
        purpose: "service_access",
        face: "front",
        depth: 36 * IN,
        cite: "IMC 306.1",
      },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [1889, 1184], fill: "mask", pen: "medium" },
      { kind: "rect", center: [-1035, 0], size: [190, 780], fill: "mask", pen: "thin" },
      { kind: "circle", center: [440, 0], radius: 330, pen: "thin" },
      { kind: "line", from: [160, 0], to: [720, 0], pen: "thin" },
      { kind: "line", from: [440, -280], to: [440, 280], pen: "thin" },
      { kind: "rect", center: [-420, -240], size: [406, 254], pen: "thin" },
      { kind: "line", from: [-623, -367], to: [-217, -113], pen: "thin" },
      { kind: "line", from: [-623, -113], to: [-217, -367], pen: "thin" },
      { kind: "rect", center: [-420, 260], size: [406, 305], pen: "thin" },
      { kind: "line", from: [-623, 108], to: [-217, 412], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 2. Greenheck Model G-085 — Spun Aluminum Centrifugal Roof Exhaust Fan (EF-1)
//    Cut sheet: 18"×18" curb, 24" Ø spun hood, 300 CFM, 1/6 HP, 120V/1Ø, 42 lb
// =============================================================================
export const SHOWCASE_EXHAUST_FAN: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:ef-greenheck-g085@1",
  definition: {
    familyName: "Exhaust fan, centrifugal roof",
    typeName: "Greenheck G-085-VG (300 CFM, 120V/1Ø)",
    category: "mechanical_equipment",
    description: "Direct-drive spun-aluminum downblast centrifugal roof exhaust fan serving stacked restrooms.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      num("exhaust_cfm", "Exhaust airflow", "cfm"),
      num("hp", "Motor HP", "none"),
      num("voltage", "Voltage", "v"),
      num("mca", "MCA", "a"),
      num("mocp", "MOCP", "a"),
      num("operating_weight", "Operating weight (lb)", "none"),
      txt("curb_size", "Roof curb size"),
      len("service_clearance", "Service clearance"),
      txt("sequence_of_operation", "Sequence of operation"),
    ],
    typeValues: {
      manufacturer: "Greenheck",
      model: "G-085-VG",
      "material_id": "architecture.brushed_stainless",
      exhaust_cfm: 300,
      hp: 0.17,
      voltage: 120,
      mca: 2.4,
      mocp: 15,
      operating_weight: 42,
      curb_size: "18 x 18 in",
      service_clearance: 24 * IN,
      sequence_of_operation: "Continuous during occupied hours; timeclock interlocked",
    },
    instanceParams: [txt("circuit", "Circuit"), txt("serves", "Serves"), txt("room", "Location")],
    connectors: [
      {
        id: "exhaust",
        label: "Exhaust intake",
        domain: "duct",
        systemKind: "exhaust_air",
        position: [0, 0, 0],
        direction: [0, 0, -1],
        shape: "round",
        diameter: 8 * IN,
        flowDirection: "in",
        flow: 300,
      },
      {
        id: "power",
        label: "Power",
        domain: "electrical",
        systemKind: "power",
        position: [220, 0, 200],
        direction: [1, 0, 0],
        shape: "none",
        voltage: 120,
        poles: 1,
        flow: 250,
      },
    ],
    geometry: [
      // 18"×18"×12" roof mounting curb
      { kind: "box", center: [0, 0, 152], size: [457, 457, 305] },
      // Spun aluminum curb cap & windband throat
      { kind: "cylinder", center: [0, 0, 305 + 90], radius: 225, height: 180, axis: "z" },
      // Spun aluminum mushroom weather shroud (24" Ø)
      { kind: "cylinder", center: [0, 0, 305 + 215], radius: 305, height: 130, axis: "z" },
      // Top motor cover cap
      { kind: "cylinder", center: [0, 0, 305 + 310], radius: 195, height: 65, axis: "z" },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [457, 457], fill: "mask", pen: "thin" },
      { kind: "circle", center: [0, 0], radius: 305, pen: "medium" },
      { kind: "circle", center: [0, 0], radius: 175, pen: "thin" },
      { kind: "line", from: [-215, -215], to: [215, 215], pen: "thin" },
      { kind: "line", from: [-215, 215], to: [215, -215], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 2B. Greenheck CSP-B150 — Indoor Inline Cabinet Exhaust Fan (IMC 306.5 compliant)
//     Mounted inside Mechanical Room 103 ceiling space with 36" service access;
//     discharges vertically up through passive roof gravity hood GRS-8.
// =============================================================================
export const SHOWCASE_INLINE_FAN: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:ef-greenheck-csp-b150@1",
  definition: {
    familyName: "Exhaust fan, inline cabinet",
    typeName: "Greenheck CSP-B150 (300 CFM, 120V/1Ø, Indoor)",
    category: "mechanical_equipment",
    description: "Acoustically lined indoor inline cabinet exhaust fan with 36\" bottom/front service clearance (IMC 306.3/306.5 compliant — keeps serviceable equipment off sloped roof).",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      num("exhaust_cfm", "Exhaust airflow", "cfm"),
      num("hp", "Motor HP", "none"),
      num("voltage", "Voltage", "v"),
      num("mca", "MCA", "a"),
      num("mocp", "MOCP", "a"),
      num("operating_weight", "Operating weight (lb)", "none"),
      len("service_clearance", "Service clearance"),
      txt("sequence_of_operation", "Sequence of operation"),
    ],
    typeValues: {
      manufacturer: "Greenheck",
      model: "CSP-B150",
      "material_id": "architecture.galvanized_steel",
      exhaust_cfm: 300,
      hp: 0.17,
      voltage: 120,
      mca: 2.1,
      mocp: 15,
      operating_weight: 34,
      service_clearance: 36 * IN,
      sequence_of_operation: "Continuous during occupied hours; indoor serviceable access",
    },
    instanceParams: [txt("circuit", "Circuit"), txt("serves", "Serves"), txt("room", "Location")],
    connectors: [
      {
        id: "inlet",
        label: "Exhaust inlet",
        domain: "duct",
        systemKind: "exhaust_air",
        position: [0, 0, -180],
        direction: [0, 0, -1],
        shape: "round",
        diameter: 8 * IN,
        flowDirection: "in",
        flow: 300,
      },
      {
        id: "discharge",
        label: "Exhaust discharge",
        domain: "duct",
        systemKind: "exhaust_air",
        position: [0, 0, 180],
        direction: [0, 0, 1],
        shape: "round",
        diameter: 8 * IN,
        flowDirection: "out",
        flow: 300,
      },
      {
        id: "power",
        label: "Power",
        domain: "electrical",
        systemKind: "power",
        position: [260, 0, 0],
        direction: [1, 0, 0],
        shape: "none",
        voltage: 120,
        poles: 1,
        flow: 220,
      },
    ],
    geometry: [
      // Insulated galvanized steel inline fan cabinet (20" × 16" × 14" H)
      { kind: "box", center: [0, 0, 0], size: [508, 406, 356] },
      // Bottom 8" inlet collar & top 8" discharge collar
      { kind: "cylinder", center: [0, 0, -195], radius: 102, height: 40, axis: "z" },
      { kind: "cylinder", center: [0, 0, 195], radius: 102, height: 40, axis: "z" },
      // Side junction box / disconnect
      { kind: "box", center: [275, 0, 0], size: [42, 140, 180] },
    ],
    clearances: [
      {
        id: "service",
        name: "Service Access Clearance",
        purpose: "service_access",
        face: "front",
        depth: 36 * IN,
        cite: "IMC 306.3",
      },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [508, 406], fill: "mask", pen: "medium" },
      { kind: "circle", center: [0, 0], radius: 145, pen: "thin" },
      { kind: "line", from: [-100, -100], to: [100, 100], pen: "thin" },
      { kind: "line", from: [-100, 100], to: [100, -100], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 2C. Greenheck GRS-8 — Passive Spun-Aluminum Roof Gravity Ventilator Hood (GV-1)
//     Non-mechanical roof discharge hood (no motor/fall-protection trigger on 1:12 roof).
// =============================================================================
export const SHOWCASE_GRAVITY_HOOD: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:hood-greenheck-grs8@1",
  definition: {
    familyName: "Roof ventilator, gravity hood",
    typeName: "Greenheck GRS-8 (Passive Relief / Exhaust Hood)",
    category: "duct_accessory",
    description: "Passive spun-aluminum roof gravity ventilator hood with birdscreen and backdraft damper (no roof-mounted motor).",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      txt("curb_size", "Roof curb size"),
    ],
    typeValues: {
      manufacturer: "Greenheck",
      model: "GRS-8",
      "material_id": "architecture.brushed_stainless",
      curb_size: "16 x 16 in",
    },
    instanceParams: [txt("serves", "Serves"), txt("room", "Location")],
    connectors: [
      {
        id: "throat",
        label: "Throat inlet",
        domain: "duct",
        systemKind: "exhaust_air",
        position: [0, 0, 0],
        direction: [0, 0, -1],
        shape: "round",
        diameter: 8 * IN,
        flowDirection: "in",
        flow: 300,
      },
    ],
    geometry: [
      // 16"×16"×12" roof curb
      { kind: "box", center: [0, 0, 152], size: [406, 406, 305] },
      // Spun aluminum throat & weather dome (22" Ø)
      { kind: "cylinder", center: [0, 0, 305 + 80], radius: 190, height: 160, axis: "z" },
      { kind: "cylinder", center: [0, 0, 305 + 195], radius: 280, height: 105, axis: "z" },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [406, 406], fill: "mask", pen: "thin" },
      { kind: "circle", center: [0, 0], radius: 280, pen: "medium" },
      { kind: "circle", center: [0, 0], radius: 150, pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 3. Titus TMS-3-8-24X24 — 3-Cone Louvered Ceiling Supply Diffuser
//    Cut sheet: 24"×24" lay-in T-bar face (610 mm), 8" round neck (203 mm)
//    Origin z = 0 is the finished ceiling plane; collar extends UP into plenum.
// =============================================================================
export const SHOWCASE_DIFFUSER: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:diffuser-titus-tms-24x24@1",
  definition: {
    familyName: "Supply diffuser, 3-cone louvered",
    typeName: 'Titus TMS-3-8 (24"×24" Face, 8" Neck)',
    typeMark: "SD-1",
    category: "air_terminal",
    description: "Square ceiling supply diffuser with 3 stamped louvers and 8\" round top inlet neck.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      len("face_size", "Face size"),
      len("neck_diameter", "Neck diameter"),
    ],
    typeValues: {
      manufacturer: "Titus",
      model: "TMS-3-8-24X24",
      "material_id": "architecture.powder_coat_white",
      face_size: 24 * IN,
      neck_diameter: 8 * IN,
    },
    instanceParams: [
      num("airflow", "Airflow", "cfm", 400),
      txt("room", "Room"),
    ],
    connectors: [
      {
        id: "neck",
        label: "Neck",
        domain: "duct",
        systemKind: "supply_air",
        position: [0, 0, 125],
        direction: [0, 0, 1],
        shape: "round",
        diameter: 8 * IN,
        flowDirection: "in",
        flow: { param: "airflow" },
      },
    ],
    geometry: [
      // Outer 24"×24" lay-in ceiling trim frame flush with ceiling (z = -6..+14 mm)
      { kind: "box", center: [0, 0, 4], size: [604, 604, 20] },
      // Stepped middle louver cone recessed into plenum
      { kind: "box", center: [0, 0, 26], size: [430, 430, 28] },
      // Upper plenum backpan cone
      { kind: "box", center: [0, 0, 56], size: [290, 290, 36] },
      // 8" round top duct collar for flex duct connection
      { kind: "cylinder", center: [0, 0, 98], radius: 102, height: 56, axis: "z" },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [610, 610], fill: "mask", pen: "medium" },
      { kind: "rect", center: [0, 0], size: [420, 420], pen: "thin" },
      { kind: "rect", center: [0, 0], size: [230, 230], pen: "thin" },
      { kind: "line", from: [-305, -305], to: [305, 305], pen: "thin" },
      { kind: "line", from: [-305, 305], to: [305, -305], pen: "thin" },
    ],
    tagFields: ["mark", "airflow"],
    source: src(),
  },
};

// =============================================================================
// 4. A.O. Smith DRE-52 — 50-Gallon Commercial Electric Water Heater (WH-1)
//    Cut sheet: 21-3/4" Ø (552 mm) × 55-3/4" H (1416 mm), 18 kW, 480V/3Ø
// =============================================================================
export const SHOWCASE_WATER_HEATER: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:wh-aosmith-dre52@1",
  definition: {
    familyName: "Water heater, commercial electric",
    typeName: "A.O. Smith DRE-52 (50 Gal, 18 kW, 480V/3Ø)",
    category: "plumbing_fixture",
    description: "50-gallon commercial electric storage water heater with 1-1/4\" top CW/HW connections.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      txt("heater_kind", "Water heater kind"),
      num("capacity_gal", "Storage capacity (gal)", "none"),
      num("input_kw", "Input power (kW)", "none"),
      num("voltage", "Voltage", "v"),
      len("connection_size", "Water connection size"),
    ],
    typeValues: {
      manufacturer: "A.O. Smith",
      model: "DRE-52",
      "material_id": "architecture.water_heater_enamel",
      heater_kind: "tank",
      capacity_gal: 50,
      input_kw: 18,
      voltage: 480,
      connection_size: 1.25 * IN,
    },
    instanceParams: [txt("room", "Room"), txt("circuit", "Circuit")],
    connectors: [
      {
        id: "cw",
        label: "Cold water inlet",
        domain: "pipe",
        systemKind: "domestic_cold_water",
        position: [-102, 0, 1446],
        direction: [0, 0, 1],
        shape: "round",
        diameter: 1.25 * IN,
        flowDirection: "in",
      },
      {
        id: "hw",
        label: "Hot water outlet",
        domain: "pipe",
        systemKind: "domestic_hot_water",
        position: [102, 0, 1446],
        direction: [0, 0, 1],
        shape: "round",
        diameter: 1.25 * IN,
        flowDirection: "out",
      },
      {
        id: "power",
        label: "Power",
        domain: "electrical",
        systemKind: "power",
        position: [0, -180, 1466],
        direction: [0, 0, 1],
        shape: "none",
        voltage: 480,
        poles: 3,
        flow: 18000,
      },
    ],
    geometry: [
      // Overflow drain pan at floor (24" Ø × 2" H)
      { kind: "cylinder", center: [0, 0, 25], radius: 305, height: 50, axis: "z" },
      // Insulated commercial tank jacket (21.75" Ø × 55.75" H)
      { kind: "cylinder", center: [0, 0, 50 + 708], radius: 276, height: 1416, axis: "z" },
      // Top recessed control & thermostat junction box
      { kind: "box", center: [0, -155, 50 + 1456], size: [215, 140, 80] },
      // Cold inlet & hot outlet 1-1/4" NPT top nipples (8" OC)
      { kind: "cylinder", center: [-102, 0, 50 + 1450], radius: 22, height: 70, axis: "z" },
      { kind: "cylinder", center: [102, 0, 50 + 1450], radius: 22, height: 70, axis: "z" },
      // Front drain valve stub
      { kind: "box", center: [0, 290, 190], size: [38, 60, 38] },
    ],
    symbol: [
      { kind: "circle", center: [0, 0], radius: 276, fill: "mask", pen: "medium" },
      { kind: "circle", center: [0, 0], radius: 230, pen: "thin" },
      { kind: "circle", center: [-102, 0], radius: 24, pen: "thin" },
      { kind: "circle", center: [102, 0], radius: 24, pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 5. Kohler Highcliff K-4350 — Commercial Flushometer Elongated WC
//    Cut sheet: 14-5/8" W × 26-1/8" D × 16-5/8" ADA rim (372 × 664 × 422 mm)
//    2D CAD symbol uses true smooth kernel `arc` curves at crisp `pen: "thin"`.
// =============================================================================
export const SHOWCASE_WC_COMMERCIAL: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:wc-kohler-k4350@1",
  definition: {
    familyName: "Water closet, flushometer",
    typeName: "Kohler K-4350 Highcliff ADA (1.28 gpf)",
    category: "plumbing_fixture",
    description: "Floor-mounted commercial elongated flushometer bowl (ADA 16-5/8\" rim) with Sloan valve.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      txt("default_connection_type", "Starter connection type"),
      num("fixture_units", "Drainage fixture units (DFU)", "count"),
      num("wsfu_cold", "Cold water fixture units (WSFU)", "none"),
      num("flush_gpf", "Flush volume (gpf)", "none"),
      len("connection_size", "Waste connection"),
      len("cw_connection_size", "Cold water connection"),
      len("vent_size", "Vent connection"),
    ],
    typeValues: {
      manufacturer: "Kohler",
      model: "K-4350",
      "material_id": "architecture.vitreous_china",
      default_connection_type: "WC-FV",
      fixture_units: 4,
      wsfu_cold: 5,
      flush_gpf: 1.28,
      connection_size: 3 * IN,
      cw_connection_size: 1 * IN,
      vent_size: 2 * IN,
    },
    instanceParams: [txt("room", "Room"), bool("accessible", "ADA Accessible", true)],
    connectors: [
      { id: "w", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [0, 305, 0], direction: [0, 0, -1], shape: "round", diameter: 3 * IN },
      { id: "cw", label: "Cold water", domain: "pipe", systemKind: "domestic_cold_water", position: [-120, 0, 520], direction: [0, -1, 0], shape: "round", diameter: 1 * IN },
    ],
    geometry: [
      // Contoured vitreous-china pedestal foot
      { kind: "box", center: [0, 290, 125], size: [220, 380, 250] },
      // Rear vertical spud deck & trapway housing
      { kind: "box", center: [0, 120, 210], size: [295, 190, 420] },
      // Elongated bowl outer body (rounded cylinder front + tapered rear rim)
      { kind: "cylinder", center: [0, 455, 340], radius: 184, height: 164, axis: "z" },
      { kind: "box", center: [0, 295, 340], size: [368, 320, 164] },
      // Molded seat ring slightly proud of rim
      { kind: "cylinder", center: [0, 455, 434], radius: 174, height: 22, axis: "z" },
      { kind: "box", center: [0, 315, 434], size: [348, 250, 22] },
      // Sloan flushometer vertical chrome tailpiece & top valve
      { kind: "cylinder", center: [0, 125, 560], radius: 19, height: 280, axis: "z" },
      { kind: "cylinder", center: [0, 125, 700], radius: 34, height: 70, axis: "z" },
      // Wall supply ell & angle stop
      { kind: "box", center: [-60, 62, 690], size: [140, 124, 40] },
    ],
    symbol: [
      // Crisp outer elongated bowl contour: rear flat + tapered sides + smooth 180° semicircular front arc
      { kind: "line", from: [-155, 42], to: [155, 42], pen: "thin" },
      { kind: "line", from: [-155, 42], to: [-184, 460], pen: "thin" },
      { kind: "line", from: [155, 42], to: [184, 460], pen: "thin" },
      { kind: "arc", center: [0, 460], radius: 184, startDeg: 0, sweepDeg: 180, pen: "thin" },
      // Smooth inner bowl opening
      { kind: "line", from: [-110, 195], to: [110, 195], pen: "thin" },
      { kind: "line", from: [-110, 195], to: [-132, 450], pen: "thin" },
      { kind: "line", from: [110, 195], to: [132, 450], pen: "thin" },
      { kind: "arc", center: [0, 450], radius: 132, startDeg: 0, sweepDeg: 180, pen: "thin" },
      // Flushometer valve symbol at rear spud + wall stop
      { kind: "circle", center: [0, 115], radius: 32, pen: "thin" },
      { kind: "line", from: [-115, 0], to: [-115, 115], pen: "thin" },
      { kind: "line", from: [-115, 115], to: [-32, 115], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 6. Kohler Caxton K-2210 — 20"×17" Commercial Undermount Lavatory
//    REAL RECESSED BASIN (4 walls + recessed bottom + drain + chrome faucet)
//    Rim sits flush at z = 864 mm (34" ADA vanity height) inside vanity cutout.
// =============================================================================
export const SHOWCASE_LAV_UNDERMOUNT: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:lav-kohler-k2210@1",
  definition: {
    familyName: "Lavatory, undermount vitreous china",
    typeName: 'Kohler Caxton K-2210 (20"×17", 0.5 gpm)',
    category: "plumbing_fixture",
    description: "Vitreous china recessed undermount lavatory with ADA metering faucet.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      txt("default_connection_type", "Starter connection type"),
      num("fixture_units", "Drainage fixture units (DFU)", "count"),
      num("wsfu_cold", "Cold WSFU", "none"),
      num("wsfu_hot", "Hot WSFU", "none"),
      len("connection_size", "Waste connection"),
      len("cw_connection_size", "Cold water connection"),
      len("hw_connection_size", "Hot water connection"),
      len("vent_size", "Vent connection"),
    ],
    typeValues: {
      manufacturer: "Kohler",
      model: "K-2210",
      "material_id": "architecture.vitreous_china",
      default_connection_type: "LAV",
      fixture_units: 1,
      wsfu_cold: 1,
      wsfu_hot: 1,
      connection_size: 1.5 * IN,
      cw_connection_size: 0.5 * IN,
      hw_connection_size: 0.5 * IN,
      vent_size: 1.5 * IN,
    },
    instanceParams: [txt("room", "Room")],
    connectors: [
      { id: "w", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [0, 310, 480], direction: [0, -1, 0], shape: "round", diameter: 1.5 * IN },
      { id: "cw", label: "Cold water", domain: "pipe", systemKind: "domestic_cold_water", position: [100, 0, 520], direction: [0, -1, 0], shape: "round", diameter: 0.5 * IN },
      { id: "hw", label: "Hot water", domain: "pipe", systemKind: "domestic_hot_water", position: [-100, 0, 520], direction: [0, -1, 0], shape: "round", diameter: 0.5 * IN },
      { id: "v", label: "Vent", domain: "pipe", systemKind: "vent", position: [0, 0, 900], direction: [0, 0, 1], shape: "round", diameter: 1.5 * IN },
    ],
    geometry: [
      // Recessed porcelain basin: 4 perimeter walls surrounding a REAL 170 mm deep open basin!
      // Outer: x ∈ [-254, +254] (508 mm), y ∈ [110, 520] (410 mm), z ∈ [694, 864]
      { kind: "box", center: [0, 128, 779], size: [508, 36, 170] }, // back basin wall
      { kind: "box", center: [0, 502, 779], size: [508, 36, 170] }, // front basin wall
      { kind: "box", center: [-236, 315, 779], size: [36, 338, 170] }, // left basin wall
      { kind: "box", center: [236, 315, 779], size: [36, 338, 170] }, // right basin wall
      // Recessed basin bottom floor (z = 682..704 mm)
      { kind: "box", center: [0, 315, 693], size: [508, 410, 22] },
      // Centered grid drain collar at bottom of basin
      { kind: "cylinder", center: [0, 315, 709], radius: 28, height: 10, axis: "z" },
      // ADA commercial faucet deck base, stem & angled spout above rear rim
      { kind: "box", center: [0, 74, 872], size: [110, 48, 16] },
      { kind: "cylinder", center: [0, 74, 934], radius: 18, height: 115, axis: "z" },
      { kind: "box", center: [0, 145, 984], size: [28, 150, 22] },
    ],
    symbol: [
      { kind: "rect", center: [0, 315], size: [508, 410], fill: "mask", pen: "thin" },
      ...roundedRect2d(0, 315, 440, 340, 145, "thin"),
      { kind: "circle", center: [0, 315], radius: 24, pen: "thin" },
      { kind: "line", from: [0, 74], to: [0, 200], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 7. Elkay Lustertone LR2522 — 25"×22"×8" Brushed Stainless Kitchenette Sink
//    REAL 8" DEEP RECESSED BASIN (4 vertical walls + recessed bottom + drain
//    strainer + high-arc commercial gooseneck faucet). Rim at z = 914 mm (36").
// =============================================================================
export const SHOWCASE_SINK_KITCHENETTE: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:sink-elkay-lr2522@1",
  definition: {
    familyName: "Sink, commercial kitchenette",
    typeName: 'Elkay Lustertone LR2522 (25"×22"×8" Stainless)',
    category: "plumbing_fixture",
    description: "18-gauge brushed 304 stainless steel single-bowl kitchenette sink with 8\" deep recessed basin.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      txt("default_connection_type", "Starter connection type"),
      num("fixture_units", "Drainage fixture units (DFU)", "count"),
      num("wsfu_cold", "Cold WSFU", "none"),
      num("wsfu_hot", "Hot WSFU", "none"),
      len("connection_size", "Waste connection"),
      len("cw_connection_size", "Cold water connection"),
      len("hw_connection_size", "Hot water connection"),
      len("vent_size", "Vent connection"),
    ],
    typeValues: {
      manufacturer: "Elkay",
      model: "LR2522",
      "material_id": "architecture.brushed_stainless",
      default_connection_type: "SK1",
      fixture_units: 2,
      wsfu_cold: 1.5,
      wsfu_hot: 1.5,
      connection_size: 2 * IN,
      cw_connection_size: 0.5 * IN,
      hw_connection_size: 0.5 * IN,
      vent_size: 1.5 * IN,
    },
    instanceParams: [txt("room", "Room")],
    connectors: [
      { id: "w", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [0, 320, 450], direction: [0, -1, 0], shape: "round", diameter: 2 * IN },
      { id: "cw", label: "Cold water", domain: "pipe", systemKind: "domestic_cold_water", position: [120, 0, 520], direction: [0, -1, 0], shape: "round", diameter: 0.5 * IN },
      { id: "hw", label: "Hot water", domain: "pipe", systemKind: "domestic_hot_water", position: [-120, 0, 520], direction: [0, -1, 0], shape: "round", diameter: 0.5 * IN },
      { id: "v", label: "Vent", domain: "pipe", systemKind: "vent", position: [0, 0, 900], direction: [0, 0, 1], shape: "round", diameter: 1.5 * IN },
    ],
    geometry: [
      // Self-rimming stainless top flange (4 frame rails around OPEN 535 × 410 mm basin!)
      // Outer: x ∈ [-317.5, +317.5] (635 mm), y ∈ [35, 594] (559 mm), flange at z = 910..922 mm
      { kind: "box", center: [0, 90, 916], size: [635, 110, 12] }, // rear faucet deck ledge
      { kind: "box", center: [0, 574, 916], size: [635, 40, 12] }, // front lip
      { kind: "box", center: [-292.5, 349, 916], size: [50, 410, 12] }, // left lip
      { kind: "box", center: [292.5, 349, 916], size: [50, 410, 12] }, // right lip
      // 4 vertical stainless steel recessed basin walls (8" = 203 mm deep: z = 711..914 mm)
      { kind: "box", center: [0, 148, 812], size: [545, 16, 203] }, // back basin wall
      { kind: "box", center: [0, 550, 812], size: [545, 16, 203] }, // front basin wall
      { kind: "box", center: [-267, 349, 812], size: [16, 402, 203] }, // left basin wall
      { kind: "box", center: [267, 349, 812], size: [16, 402, 203] }, // right basin wall
      // Recessed stainless basin floor (z = 700..716 mm)
      { kind: "box", center: [0, 349, 708], size: [550, 418, 16] },
      // 3-1/2" stainless basket strainer in basin floor
      { kind: "cylinder", center: [0, 349, 720], radius: 44, height: 10, axis: "z" },
      // High-arc commercial gooseneck faucet (base + riser + top arch + downward aerator nozzle)
      { kind: "cylinder", center: [0, 88, 932], radius: 28, height: 22, axis: "z" },
      { kind: "cylinder", center: [0, 88, 1068], radius: 14, height: 260, axis: "z" },
      { kind: "box", center: [0, 178, 1192], size: [26, 180, 24] },
      { kind: "cylinder", center: [0, 258, 1164], radius: 13, height: 48, axis: "z" },
      // Side mixing lever handle
      { kind: "box", center: [62, 88, 972], size: [85, 16, 16] },
    ],
    symbol: [
      { kind: "rect", center: [0, 315], size: [635, 559], fill: "mask", pen: "thin" },
      ...roundedRect2d(0, 349, 535, 402, 42, "thin"),
      { kind: "circle", center: [0, 349], radius: 34, pen: "thin" },
      { kind: "line", from: [0, 88], to: [0, 245], pen: "thin" },
    ],
    tagFields: ["mark"],
    source: src(),
  },
};

// =============================================================================
// 8. Architectural Lighting Cut-Sheet Luminaires (Recessed Flush + Exterior Sconce)
// =============================================================================
const CONTROL_PROTOCOLS = ["line_voltage", "0-10v", "dali", "low_voltage"];

/** Lithonia Lighting 2GTL4 — 2x4 Recessed Volumetric LED Troffer (flush ceiling trim, housing UP into plenum). */
export const SHOWCASE_TROFFER_2X4: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:light-lithonia-2gtl4@1",
  definition: {
    familyName: "Troffer, recessed volumetric LED",
    typeName: "Lithonia 2GTL4 (2x4, 4000 lm, 32W, 277V)",
    category: "lighting_fixture",
    description: "2x4 architectural recessed volumetric LED troffer with 0-10V dimming driver.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      len("length", "Length"),
      len("width", "Width"),
      num("watts", "Input power", "w"),
      num("lumens", "Output", "lumens"),
      num("voltage", "Voltage", "v"),
      txt("cut_sheet", "Cut sheet"),
    ],
    typeValues: {
      manufacturer: "Lithonia Lighting",
      model: "2GTL4-40L-HE",
      "material_id": "architecture.powder_coat_white",
      length: 4 * FT,
      width: 2 * FT,
      watts: 32,
      lumens: 4000,
      voltage: 277,
      cut_sheet: "2GTL4 PDF|https://lithonia.acuitybrands.com/products/detail/673764/lithonia-lighting/2gtl4-led",
    },
    instanceParams: [
      txt("circuit", "Circuit"),
      txt("switch_leg", "Switch leg"),
      bool("emergency", "Emergency battery", false),
      choice("emergency_mode", "Emergency mode", ["none", "unswitched", "switched"], "none"),
      choice("control_type", "Control wiring", CONTROL_PROTOCOLS, "0-10v"),
      txt("type_mark", "Fixture type"),
    ],
    connectors: [
      { id: "power", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 95], direction: [0, 0, 1], shape: "none", voltage: 277, poles: 1, flow: 32, loadClass: "lighting", continuous: true },
    ],
    geometry: [
      // Flush T-bar ceiling flange (z = -6..+8 mm)
      { kind: "box", center: [0, 0, 1], size: [1214, 604, 14] },
      // Recessed plenum housing extending UP into ceiling plenum (z = +8..+92 mm)
      { kind: "box", center: [0, 0, 50], size: [1150, 540, 84] },
      // Central volumetric LED acrylic diffuser strip (subtle 6 mm reveal below ceiling)
      { kind: "box", center: [0, 0, -9], size: [1150, 190, 8] },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [4 * FT, 2 * FT], fill: "mask", pen: "medium", minPaperMm: 4 },
      { kind: "rect", center: [-1 * FT, 0], size: [2 * FT, 2 * FT], fill: "solid", pen: "medium", when: { param: "emergency", truthy: true } },
      { kind: "line", from: [-2 * FT, 0], to: [2 * FT, 0], pen: "thin", detailLevels: ["medium", "fine"] },
    ],
    tagFields: ["mark", "circuit"],
    source: src(),
  },
};

/** Lithonia Lighting LDN6 — 6" Architectural Recessed LED Downlight (flush circular bezel, can UP into soffit). */
export const SHOWCASE_DOWNLIGHT_6: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:light-lithonia-ldn6@1",
  definition: {
    familyName: "Downlight, recessed architectural LED",
    typeName: 'Lithonia LDN6 (6", 1500 lm, 15W, 277V)',
    category: "lighting_fixture",
    description: "6-inch architectural recessed LED downlight with satin white self-flanged reflector.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      len("length", "Diameter"),
      len("width", "Width"),
      num("watts", "Input power", "w"),
      num("lumens", "Output", "lumens"),
      num("voltage", "Voltage", "v"),
      txt("cut_sheet", "Cut sheet"),
    ],
    typeValues: {
      manufacturer: "Lithonia Lighting",
      model: "LDN6-35/15-MVOLT",
      "material_id": "architecture.powder_coat_white",
      length: 7.25 * IN,
      width: 7.25 * IN,
      watts: 15,
      lumens: 1500,
      voltage: 277,
      cut_sheet: "LDN6 PDF|https://lithonia.acuitybrands.com/products/detail/655589/lithonia-lighting/ldn6",
    },
    instanceParams: [
      txt("circuit", "Circuit"),
      txt("switch_leg", "Switch leg"),
      bool("emergency", "Emergency battery", false),
      choice("emergency_mode", "Emergency mode", ["none", "unswitched", "switched"], "none"),
      choice("control_type", "Control wiring", CONTROL_PROTOCOLS, "0-10v"),
      txt("type_mark", "Fixture type"),
    ],
    connectors: [
      { id: "power", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 120], direction: [0, 0, 1], shape: "none", voltage: 277, poles: 1, flow: 15, loadClass: "lighting", continuous: true },
    ],
    geometry: [
      // Ultra-slim circular ceiling flange flush at ceiling (z = -5..+5 mm)
      { kind: "cylinder", center: [0, 0, 0], radius: 95, height: 10, axis: "z" },
      // Recessed reflector can extending UP into soffit (z = +5..+120 mm)
      { kind: "cylinder", center: [0, 0, 62], radius: 78, height: 115, axis: "z" },
    ],
    symbol: [
      { kind: "circle", center: [0, 0], radius: 1.8, fill: "mask", pen: "medium", units: "paper", detailLevels: ["coarse", "medium"] },
      { kind: "polyline", points: halfCircleLeft(1.8), closed: true, fill: "solid", pen: "thin", units: "paper", detailLevels: ["coarse", "medium"], when: { param: "emergency", truthy: true } },
      { kind: "circle", center: [0, 0], radius: 95, fill: "mask", pen: "medium", detailLevels: ["fine"] },
      { kind: "polyline", points: halfCircleLeft(95), closed: true, fill: "solid", pen: "thin", detailLevels: ["fine"], when: { param: "emergency", truthy: true } },
      { kind: "circle", center: [0, 0], radius: 66, pen: "thin", detailLevels: ["fine"] },
    ],
    tagFields: ["mark", "circuit"],
    source: src(),
  },
};

/** Lithonia Lighting WDGE2 — Exterior Architectural Dark-Bronze LED Wall Sconce (wall-face hosted). */
export const SHOWCASE_EXTERIOR_SCONCE: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:light-lithonia-wdge2@1",
  definition: {
    familyName: "Wall sconce, exterior architectural LED",
    typeName: "Lithonia WDGE2 (1200 lm, 12W, 277V, Dark-Sky)",
    category: "lighting_fixture",
    hosting: "wall_face",
    description: "Dark-sky compliant exterior architectural LED wall sconce with photocell/timeclock control.",
    typeParams: [
      txt("manufacturer", "Manufacturer"),
      txt("model", "Model"),
      txt("material_id", "Material"),
      len("length", "Width"),
      len("width", "Projection"),
      num("watts", "Input power", "w"),
      num("lumens", "Output", "lumens"),
      num("voltage", "Voltage", "v"),
      txt("cut_sheet", "Cut sheet"),
    ],
    typeValues: {
      manufacturer: "Lithonia Lighting",
      model: "WDGE2-LED-P2-35K",
      "material_id": "architecture.bronze_fixture",
      length: 9 * IN,
      width: 5.5 * IN,
      watts: 12,
      lumens: 1200,
      voltage: 277,
      cut_sheet: "WDGE2 PDF|https://lithonia.acuitybrands.com/products/detail/773440/lithonia-lighting/wdge2-led",
    },
    instanceParams: [
      txt("circuit", "Circuit"),
      txt("switch_leg", "Switch leg"),
      bool("emergency", "Emergency battery", true),
      choice("emergency_mode", "Emergency mode", ["none", "unswitched", "switched"], "switched"),
      choice("control_type", "Control wiring", CONTROL_PROTOCOLS, "low_voltage"),
      txt("type_mark", "Fixture type"),
    ],
    connectors: [
      { id: "power", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 120], direction: [0, -1, 0], shape: "none", voltage: 277, poles: 1, flow: 12, loadClass: "lighting", continuous: true },
    ],
    geometry: [
      // Die-cast architectural backplate against exterior wall (y = 0..22 mm)
      { kind: "box", center: [0, 11, 120], size: [216, 22, 240] },
      // Architectural wedge luminaire housing projecting outward (+Y)
      { kind: "box", center: [0, 82, 130], size: [228, 126, 175] },
      // Crisp top rain brow cap
      { kind: "box", center: [0, 92, 226], size: [236, 146, 22] },
    ],
    symbol: [
      { kind: "line", from: [0, 0], to: [0, 1.4], pen: "medium", units: "paper" },
      { kind: "circle", center: [0, 2.7], radius: 1.45, fill: "mask", pen: "medium", units: "paper" },
      { kind: "line", from: [-1.45, 2.7], to: [1.45, 2.7], pen: "thin", units: "paper" },
      { kind: "line", from: [0, 1.25], to: [0, 4.15], pen: "thin", units: "paper" },
      { kind: "text", at: [0, 2.7], uprightOffset: [1.85, 0], text: "WP", heightMm: 1.25, anchor: "start", units: "paper" },
    ],
    tagFields: ["mark", "circuit"],
    source: src(),
  },
};

// =============================================================================
// 9. Real Architectural Millwork & Casework (With Cut-Out Countertop Openings!)
// =============================================================================

/** 6'-8" Commercial ADA Dual-Lavatory Quartz Vanity with TWO real 508×410 mm cutouts at x = ±549 mm (clears toilet stall!). */
export const SHOWCASE_VANITY_DUAL: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:vanity-dual-quartz@1",
  definition: {
    familyName: "Vanity, commercial dual quartz",
    typeName: "6'-8\" × 2'-0\" ADA Dual-Lavatory Quartz Vanity",
    category: "generic",
    description: "Floating ADA commercial quartz vanity top with two undermount cutouts and 4\" backsplash.",
    typeParams: [txt("material_id", "Material")],
    typeValues: { "material_id": "architecture.quartz_counter" },
    instanceParams: [txt("room", "Room")],
    connectors: [],
    geometry: [
      // Vanity span: x ∈ [-1016, +1016] (2032 mm = 6'-8"), y ∈ [0, 610] (610 mm), deck z = 824..864 mm
      // Cutout 1: x ∈ [-803, -295], y ∈ [110, 520] (center x = -549)
      // Cutout 2: x ∈ [+295, +803], y ∈ [110, 520] (center x = +549)
      { kind: "box", center: [0, 55, 844], size: [2032, 110, 40] }, // continuous rear deck behind cutouts
      { kind: "box", center: [0, 565, 844], size: [2032, 90, 40] }, // continuous front rail in front of cutouts
      { kind: "box", center: [-909.5, 315, 844], size: [213, 410, 40] }, // left quartz wing
      { kind: "box", center: [0, 315, 844], size: [590, 410, 40] }, // center bridge between basins
      { kind: "box", center: [909.5, 315, 844], size: [213, 410, 40] }, // right quartz wing
      // 4" (102 mm) rear quartz backsplash (z = 864..966 mm)
      { kind: "box", center: [0, 12, 915], size: [2032, 24, 102] },
      // Front ADA concealed-trap apron skirt (z = 690..824 mm, keeps knee space open below 27"!)
      { kind: "box", center: [0, 592, 757], size: [2032, 36, 134] },
      { kind: "box", center: [-998, 305, 757], size: [36, 610, 134] },
      { kind: "box", center: [998, 305, 757], size: [36, 610, 134] },
    ],
    symbol: [
      { kind: "rect", center: [0, 305], size: [2032, 610], pen: "thin" },
    ],
    tagFields: [],
    source: src(),
  },
};

/** 8'-6" Break Room Kitchenette Base Cabinet & Countertop with REAL 635×559 mm sink cutout at x = 0. */
export const SHOWCASE_KITCHENETTE_COUNTER: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:kitchenette-counter@1",
  definition: {
    familyName: "Casework, kitchenette counter",
    typeName: "8'-6\" × 2'-1\" Oak Kitchenette Base & Counter",
    category: "generic",
    description: "Break room oak kitchenette cabinet run with open sink cutout for Elkay LR2522.",
    typeParams: [txt("material_id", "Material")],
    typeValues: { "material_id": "architecture.wood_oak" },
    instanceParams: [txt("room", "Room")],
    connectors: [],
    geometry: [
      // Overall run: x ∈ [-1295, +1295] (2590 mm), y ∈ [0, 635] (635 mm), counter top z = 914 mm (36")
      // Open cutout for Elkay LR2522 basin: x ∈ [-275, +275] (550 mm), y ∈ [140, 558] (418 mm)
      // Left & right full-height base cabinet bays (z = 100..874 mm, recessed 75 mm toe-kick below)
      { kind: "box", center: [-785, 310, 487], size: [1020, 600, 774] },
      { kind: "box", center: [785, 310, 487], size: [1020, 600, 774] },
      // Center sink-base cabinet stopping cleanly BELOW the 8"-deep stainless basin (z = 100..692 mm)
      { kind: "box", center: [0, 310, 396], size: [550, 600, 592] },
      // Recessed toe-kick plinth across full run (z = 0..100 mm)
      { kind: "box", center: [0, 265, 50], size: [2590, 530, 100] },
      // Countertop slab around the open sink cutout (z = 874..914 mm)
      { kind: "box", center: [-785, 317.5, 894], size: [1020, 635, 40] }, // left counter
      { kind: "box", center: [785, 317.5, 894], size: [1020, 635, 40] }, // right counter
      { kind: "box", center: [0, 70, 894], size: [550, 140, 40] }, // rear strip behind sink
      { kind: "box", center: [0, 596.5, 894], size: [550, 77, 40] }, // front rail in front of sink
      // 4" rear backsplash
      { kind: "box", center: [0, 12, 965], size: [2590, 24, 102] },
    ],
    symbol: [
      { kind: "rect", center: [0, 317.5], size: [2590, 635], pen: "thin" },
    ],
    tagFields: [],
    source: src(),
  },
};

/** 8'-0"×3'-0" Architectural Studio Worktable (real oak slab tabletop + 4 corner legs + apron rails). */
export const SHOWCASE_WORKTABLE: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:worktable-studio@1",
  definition: {
    familyName: "Furniture, studio worktable",
    typeName: "8'-0\" × 3'-0\" Oak Studio Worktable",
    category: "generic",
    description: "Architectural studio drafting and team worktable with 30\" height oak tabletop.",
    typeParams: [txt("material_id", "Material")],
    typeValues: { "material_id": "architecture.wood_oak" },
    instanceParams: [txt("room", "Room")],
    connectors: [],
    geometry: [
      // Oak tabletop (2438 × 914 × 42 mm at z = 718..760 mm)
      { kind: "box", center: [0, 0, 739], size: [2438, 914, 42] },
      // 4 crisp corner legs (z = 0..718 mm)
      { kind: "box", center: [-1120, -370, 359], size: [56, 56, 718] },
      { kind: "box", center: [1120, -370, 359], size: [56, 56, 718] },
      { kind: "box", center: [-1120, 370, 359], size: [56, 56, 718] },
      { kind: "box", center: [1120, 370, 359], size: [56, 56, 718] },
      // Longitudinal under-frame apron rails
      { kind: "box", center: [0, -370, 688], size: [2184, 34, 60] },
      { kind: "box", center: [0, 370, 688], size: [2184, 34, 60] },
    ],
    symbol: [
      { kind: "rect", center: [0, 0], size: [2438, 914], pen: "thin" },
    ],
    tagFields: [],
    source: src(),
  },
};

/** 6'-6"×2'-6" Architectural Quartz Café Break Island (counter overhang + recessed base cabinet + toe-kick). */
export const SHOWCASE_CAFE_ISLAND: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:cafe-island-quartz@1",
  definition: {
    familyName: "Casework, café island",
    typeName: "6'-6\" × 2'-6\" Quartz Break Island",
    category: "generic",
    description: "Reception break room quartz island with cantilevered seating overhang and recessed toe-kick.",
    typeParams: [txt("material_id", "Material")],
    typeValues: { "material_id": "architecture.quartz_counter" },
    instanceParams: [txt("room", "Room")],
    connectors: [],
    geometry: [
      // Honed quartz top slab with seating overhang (1981 × 762 × 44 mm at z = 870..914 mm)
      { kind: "box", center: [0, 0, 892], size: [1981, 762, 44] },
      // Recessed cabinet body (z = 100..870 mm)
      { kind: "box", center: [0, -70, 485], size: [1880, 560, 770] },
      // Recessed toe-kick plinth (z = 0..100 mm)
      { kind: "box", center: [0, -70, 50], size: [1780, 480, 100] },
    ],
    symbol: [{ kind: "rect", center: [0, 0], size: [1981, 762], pen: "thin" }],
    tagFields: [],
    source: src(),
  },
};

/** 10'-0"×4'-0" Architectural Oak Conference Table (thick chamfered tabletop + twin architectural slab pedestals). */
export const SHOWCASE_CONF_TABLE: { readonly id: string; readonly definition: PartTypeDefinition } = {
  id: "showcase:conference-table-oak@1",
  definition: {
    familyName: "Furniture, conference table",
    typeName: "10'-0\" × 4'-0\" White Oak Conference Table",
    category: "generic",
    description: "Commercial 10-seat architectural oak conference table with twin pedestal legs.",
    typeParams: [txt("material_id", "Material")],
    typeValues: { "material_id": "architecture.wood_oak" },
    instanceParams: [txt("room", "Room")],
    connectors: [],
    geometry: [
      // Tabletop slab (3048 × 1219 × 48 mm at z = 712..760 mm)
      { kind: "box", center: [0, 0, 736], size: [3048, 1219, 48] },
      // Twin architectural slab pedestal legs (z = 0..712 mm)
      { kind: "box", center: [-960, 0, 356], size: [110, 840, 712] },
      { kind: "box", center: [960, 0, 356], size: [110, 840, 712] },
      // Center structural beam stretcher
      { kind: "box", center: [0, 0, 668], size: [1920, 120, 80] },
    ],
    symbol: [{ kind: "rect", center: [0, 0], size: [3048, 1219], pen: "thin" }],
    tagFields: [],
    source: src(),
  },
};

export const SHOWCASE_PART_TYPES = [
  SHOWCASE_RTU,
  SHOWCASE_EXHAUST_FAN,
  SHOWCASE_INLINE_FAN,
  SHOWCASE_GRAVITY_HOOD,
  SHOWCASE_DIFFUSER,
  SHOWCASE_WATER_HEATER,
  SHOWCASE_WC_COMMERCIAL,
  SHOWCASE_LAV_UNDERMOUNT,
  SHOWCASE_SINK_KITCHENETTE,
  SHOWCASE_TROFFER_2X4,
  SHOWCASE_DOWNLIGHT_6,
  SHOWCASE_EXTERIOR_SCONCE,
  SHOWCASE_VANITY_DUAL,
  SHOWCASE_KITCHENETTE_COUNTER,
  SHOWCASE_WORKTABLE,
  SHOWCASE_CAFE_ISLAND,
  SHOWCASE_CONF_TABLE,
] as const;
