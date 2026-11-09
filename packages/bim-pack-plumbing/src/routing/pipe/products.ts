import type { PipeHub, PipeProduct, PipeProductSize } from "@permitzip/bim-kernel";

/**
 * The Plumbing and gas add-on's pipe products (`PIPE_PRODUCT_POINT`, round 10
 * lane P10; the kernel shipped them as its own table until then): nominal
 * sizes with real outside and inside diameters, roughness, Hazen-Williams C,
 * Manning n, pressure class, the joints each is made with (this add-on's end
 * types, `end-types.ts`) and each joint's hub.
 *
 * Dimensions are the published dimensional values of the product standards
 * named on each product (ASTM B88 copper tube, ASME B36.10M schedules, CISPI
 * 301 / ASTM A888 no-hub and ASTM A74 service-weight cast iron, ASTM F876
 * PEX and ASTM D2846 CPVC copper-tube sizes by SDR, ASTM F2389 PP-R metric
 * sizes). They are nominal: tolerances and a manufacturer's own product can
 * differ, so verify against the product submitted.
 *
 * Roughness, C and n are typical published values for new pipe; they are
 * labelled "verify for permit work" wherever they are shown. Spec names and
 * product ids are frozen: stored pipe sizes name them.
 */

const IN = 25.4;
const r1 = (v: number) => Math.round(v * 1000) / 1000;

/** Rows from (nominal, OD, wall) in inches. */
function byWall(rows: ReadonlyArray<readonly [number, number, number]>): PipeProductSize[] {
  return rows.map(([n, od, wall]) => ({ nominalIn: n, odMm: r1(od * IN), wallMm: r1(wall * IN), idMm: r1((od - 2 * wall) * IN) }));
}

/** Copper-tube-size plastics by SDR: OD = nominal + 1/8", wall = OD / SDR, not below `minWallIn`. */
function ctsBySdr(nominals: readonly number[], sdr: number, minWallIn: number): PipeProductSize[] {
  return byWall(nominals.map((n) => [n, n + 0.125, Math.max(minWallIn, (n + 0.125) / sdr)] as const));
}

// ASTM B88 copper water tube: OD is nominal + 1/8"; walls (in) for K, L, M.
const B88_OD: ReadonlyArray<readonly [number, number]> = [
  [0.375, 0.5],
  [0.5, 0.625],
  [0.75, 0.875],
  [1, 1.125],
  [1.25, 1.375],
  [1.5, 1.625],
  [2, 2.125],
  [2.5, 2.625],
  [3, 3.125],
  [3.5, 3.625],
  [4, 4.125],
  [5, 5.125],
  [6, 6.125],
  [8, 8.125],
];
const B88_WALL: Readonly<Record<"type_k" | "type_l" | "type_m", readonly number[]>> = {
  type_k: [0.049, 0.049, 0.065, 0.065, 0.065, 0.072, 0.083, 0.095, 0.109, 0.12, 0.134, 0.16, 0.192, 0.271],
  type_l: [0.035, 0.04, 0.045, 0.05, 0.055, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.125, 0.14, 0.2],
  type_m: [0.025, 0.028, 0.032, 0.035, 0.042, 0.049, 0.058, 0.065, 0.072, 0.083, 0.095, 0.109, 0.122, 0.17],
};
const copperRows = (t: keyof typeof B88_WALL) => byWall(B88_OD.map(([n, od], i) => [n, od, B88_WALL[t][i] ?? 0] as const));

// ASME B36.10M: iron-pipe-size OD and schedule 40 wall (in).
const SCH40: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 0.84, 0.109],
  [0.75, 1.05, 0.113],
  [1, 1.315, 0.133],
  [1.25, 1.66, 0.14],
  [1.5, 1.9, 0.145],
  [2, 2.375, 0.154],
  [2.5, 2.875, 0.203],
  [3, 3.5, 0.216],
  [4, 4.5, 0.237],
  [5, 5.563, 0.258],
  [6, 6.625, 0.28],
  [8, 8.625, 0.322],
  [10, 10.75, 0.365],
  [12, 12.75, 0.406],
];
const sch40 = (from: number, to: number) => byWall(SCH40.filter(([n]) => n >= from && n <= to));

// CISPI 301 / ASTM A888 no-hub: OD and nominal wall (in).
const NO_HUB: ReadonlyArray<readonly [number, number, number]> = [
  [1.5, 1.9, 0.16],
  [2, 2.35, 0.16],
  [3, 3.35, 0.16],
  [4, 4.38, 0.19],
  [5, 5.3, 0.19],
  [6, 6.3, 0.19],
  [8, 8.38, 0.23],
  [10, 10.56, 0.28],
  [12, 12.5, 0.28],
  [15, 15.83, 0.36],
];

// ASTM A74 service weight hub and spigot: barrel OD and wall (in).
const SERVICE_WEIGHT: ReadonlyArray<readonly [number, number, number]> = [
  [2, 2.3, 0.17],
  [3, 3.3, 0.17],
  [4, 4.3, 0.18],
  [5, 5.3, 0.18],
  [6, 6.3, 0.18],
  [8, 8.38, 0.19],
  [10, 10.5, 0.22],
  [12, 12.5, 0.22],
  [15, 15.88, 0.25],
];

// ASTM F2389 / ISO 15874 PP-R, SDR 7.4: metric OD (mm), wall (mm), with the inch size it replaces.
const PPR_SDR74: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 20, 2.8],
  [0.75, 25, 3.5],
  [1, 32, 4.4],
  [1.25, 40, 5.5],
  [1.5, 50, 6.9],
  [2, 63, 8.6],
  [2.5, 75, 10.3],
  [3, 90, 12.3],
  [4, 110, 15.1],
];

// CSST: nominal size with a typical equivalent hydraulic diameter. EHD is the manufacturer's own value; these are placeholders to verify.
const CSST: ReadonlyArray<readonly [number, number, number]> = [
  [0.375, 15, 0.47],
  [0.5, 19, 0.59],
  [0.75, 25, 0.78],
  [1, 31, 0.97],
  [1.25, 39, 1.22],
  [1.5, 48, 1.5],
  [2, 62, 1.94],
];

// ASTM D2513 polyethylene gas pipe, iron pipe size: nominal, OD and the actual ID and designation the fuel gas code's PE tables list (VFGC 2021 Table 402.4(20)-(22), (35), (36), from the code library).
const PE_GAS: ReadonlyArray<readonly [number, number, number, string]> = [
  [0.5, 0.84, 0.66, "SDR 9"],
  [0.75, 1.05, 0.86, "SDR 11"],
  [1, 1.315, 1.077, "SDR 11"],
  [1.25, 1.66, 1.328, "SDR 10"],
  [1.5, 1.9, 1.554, "SDR 11"],
  [2, 2.375, 1.943, "SDR 11"],
  [3, 3.5, 2.864, "SDR 11"],
  [4, 4.5, 3.682, "SDR 11"],
];

/** Hub (socket, coupling band, threaded end) proportions by joint: outside diameter and length, each over the pipe's OD. */
const HUBS: Readonly<Record<string, PipeHub>> = {
  sweat: { odOverPipe: 1.1, lengthOverOd: 0.55 },
  press: { odOverPipe: 1.25, lengthOverOd: 0.7 },
  threaded: { odOverPipe: 1.3, lengthOverOd: 0.5 },
  no_hub: { odOverPipe: 1.2, lengthOverOd: 0.9 },
  hub_gasket: { odOverPipe: 1.35, lengthOverOd: 0.9 },
  solvent_weld: { odOverPipe: 1.12, lengthOverOd: 0.6 },
  pex_crimp: { odOverPipe: 1.25, lengthOverOd: 0.6 },
  pex_expansion: { odOverPipe: 1.2, lengthOverOd: 0.6 },
  fusion: { odOverPipe: 1.15, lengthOverOd: 0.6 },
  csst_mechanical: { odOverPipe: 1.35, lengthOverOd: 0.8 },
};

/** The spec words tags and labels print. */
const SPEC_LABEL: Readonly<Record<string, string>> = {
  type_k: "type K",
  type_l: "type L",
  type_m: "type M",
  sch40: "Sch 40",
  dwv_sch40: "DWV",
  no_hub: "no-hub",
  service_weight: "service weight",
  sdr9: "SDR 9",
  sdr11: "SDR 11",
  sdr7_4: "SDR 7.4",
  csst: "",
};

/** The product a material's sizes mean when they name no spec. */
const DEFAULT_SPEC: Readonly<Record<string, string>> = {
  copper: "type_l",
  pex: "sdr9",
  cpvc: "sdr11",
  pp_r: "sdr7_4",
  pvc: "dwv_sch40",
  abs: "dwv_sch40",
  cast_iron: "no_hub",
  black_steel: "sch40",
  steel: "sch40",
  galvanized: "sch40",
  csst: "csst",
  pe: "sdr11",
};

/** A product as this add-on writes it: the stored spec name as `id`, the material by its built-in name, and joints by the stored names its end types read. */
interface StoredSpec {
  readonly id: string;
  readonly material: string;
  readonly name: string;
  readonly standard: string;
  readonly services: readonly string[];
  readonly sizes: readonly PipeProductSize[];
  readonly roughnessMm: number;
  readonly hazenWilliamsC: number;
  readonly manningN: number;
  readonly pressureClass: string;
  readonly joints: readonly string[];
  readonly defaultJoint: string;
  readonly note?: string;
}

const endType = (joint: string): string => `plumbing_gas.${joint}`;

function product(s: StoredSpec): PipeProduct {
  const hubs: Record<string, PipeHub> = {};
  for (const j of s.joints) {
    const hub = HUBS[j];
    if (hub) hubs[endType(j)] = hub;
  }
  return {
    id: `plumbing_gas.${s.material}_${s.id}`,
    name: s.name,
    materialId: s.material,
    spec: s.id,
    specLabel: SPEC_LABEL[s.id] ?? s.id.replace(/_/g, " "),
    ...(DEFAULT_SPEC[s.material] === s.id ? { defaultForMaterial: true } : {}),
    standard: s.standard,
    services: s.services,
    sizes: s.sizes,
    roughnessMm: s.roughnessMm,
    hazenWilliamsC: s.hazenWilliamsC,
    manningN: s.manningN,
    pressureClass: s.pressureClass,
    endTypes: s.joints.map(endType),
    defaultEndType: endType(s.defaultJoint),
    hubs,
    ...(s.note !== undefined ? { note: s.note } : {}),
  };
}

const STORED_SPECS: readonly StoredSpec[] = [] = [
  ...(["type_k", "type_l", "type_m"] as const).map(
    (t): StoredSpec => ({
      id: t,
      material: "copper",
      name: `Copper tube, type ${t.slice(-1).toUpperCase()}`,
      standard: "ASTM B88",
      services: ["water"],
      sizes: copperRows(t),
      roughnessMm: 0.0015,
      hazenWilliamsC: 140,
      manningN: 0.011,
      pressureClass: "Pressure rating depends on temper, size, temperature and joint; see the tube and joint manufacturer",
      joints: ["sweat", "press", "threaded"],
      defaultJoint: "sweat",
    }),
  ),
  {
    id: "sdr9",
    material: "pex",
    name: "PEX tubing, SDR 9",
    standard: "ASTM F876 / F877 (copper tube size)",
    services: ["water"],
    sizes: ctsBySdr([0.375, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3], 9, 0.07),
    roughnessMm: 0.007,
    hazenWilliamsC: 150,
    manningN: 0.009,
    pressureClass: "160 psi at 73 °F, 100 psi at 180 °F (standard hydrostatic ratings)",
    joints: ["pex_crimp", "pex_expansion", "press"],
    defaultJoint: "pex_crimp",
  },
  {
    id: "sdr11",
    material: "cpvc",
    name: "CPVC, SDR 11",
    standard: "ASTM D2846 (copper tube size)",
    services: ["water"],
    sizes: ctsBySdr([0.5, 0.75, 1, 1.25, 1.5, 2], 11, 0.068),
    roughnessMm: 0.0015,
    hazenWilliamsC: 150,
    manningN: 0.009,
    pressureClass: "400 psi at 73 °F, 100 psi at 180 °F",
    joints: ["solvent_weld"],
    defaultJoint: "solvent_weld",
  },
  {
    id: "sdr7_4",
    material: "pp_r",
    name: "PP-R, SDR 7.4",
    standard: "ASTM F2389 / ISO 15874 (metric OD)",
    services: ["water"],
    sizes: PPR_SDR74.map(([n, od, wall]) => ({ nominalIn: n, odMm: od, wallMm: wall, idMm: r1(od - 2 * wall), label: `${od} mm` })),
    roughnessMm: 0.007,
    hazenWilliamsC: 150,
    manningN: 0.009,
    pressureClass: "PN 16 class; temperature derating per manufacturer",
    joints: ["fusion"],
    defaultJoint: "fusion",
  },
  {
    id: "dwv_sch40",
    material: "pvc",
    name: "PVC DWV, schedule 40",
    standard: "ASTM D2665 (ASME B36.10M schedule 40 dimensions)",
    services: ["drainage"],
    sizes: sch40(1.25, 12),
    roughnessMm: 0.0015,
    hazenWilliamsC: 150,
    manningN: 0.01,
    pressureClass: "Non-pressure drainage, waste and vent",
    joints: ["solvent_weld"],
    defaultJoint: "solvent_weld",
  },
  {
    id: "dwv_sch40",
    material: "abs",
    name: "ABS DWV, schedule 40",
    standard: "ASTM D2661 (ASME B36.10M schedule 40 dimensions)",
    services: ["drainage"],
    sizes: sch40(1.25, 6),
    roughnessMm: 0.0015,
    hazenWilliamsC: 150,
    manningN: 0.01,
    pressureClass: "Non-pressure drainage, waste and vent",
    joints: ["solvent_weld"],
    defaultJoint: "solvent_weld",
  },
  {
    id: "no_hub",
    material: "cast_iron",
    name: "Cast iron soil pipe, no-hub",
    standard: "CISPI 301 / ASTM A888",
    services: ["drainage"],
    sizes: byWall(NO_HUB),
    roughnessMm: 0.25,
    hazenWilliamsC: 100,
    manningN: 0.012,
    pressureClass: "Non-pressure drainage, waste and vent",
    joints: ["no_hub"],
    defaultJoint: "no_hub",
  },
  {
    id: "service_weight",
    material: "cast_iron",
    name: "Cast iron soil pipe, service weight hub and spigot",
    standard: "ASTM A74",
    services: ["drainage"],
    sizes: byWall(SERVICE_WEIGHT),
    roughnessMm: 0.25,
    hazenWilliamsC: 100,
    manningN: 0.012,
    pressureClass: "Non-pressure drainage, waste and vent",
    joints: ["hub_gasket"],
    defaultJoint: "hub_gasket",
  },
  {
    id: "sch40",
    material: "black_steel",
    name: "Black steel pipe, schedule 40",
    standard: "ASTM A53 / ASME B36.10M",
    services: ["gas", "water"],
    sizes: sch40(0.5, 8),
    roughnessMm: 0.045,
    hazenWilliamsC: 120,
    manningN: 0.012,
    pressureClass: "Schedule 40",
    joints: ["threaded"],
    defaultJoint: "threaded",
  },
  {
    id: "sch40",
    material: "steel",
    name: "Steel pipe, schedule 40",
    standard: "ASTM A53 / ASME B36.10M",
    services: ["gas", "water"],
    sizes: sch40(0.5, 12),
    roughnessMm: 0.045,
    hazenWilliamsC: 120,
    manningN: 0.012,
    pressureClass: "Schedule 40",
    joints: ["threaded"],
    defaultJoint: "threaded",
  },
  {
    id: "sch40",
    material: "galvanized",
    name: "Galvanized steel pipe, schedule 40",
    standard: "ASTM A53 / ASME B36.10M",
    services: ["water", "drainage"],
    sizes: sch40(0.5, 6),
    roughnessMm: 0.15,
    hazenWilliamsC: 120,
    manningN: 0.013,
    pressureClass: "Schedule 40",
    joints: ["threaded"],
    defaultJoint: "threaded",
  },
  {
    id: "csst",
    material: "csst",
    name: "Corrugated stainless steel tubing (CSST)",
    standard: "ANSI LC 1 / CSA 6.26",
    services: ["gas"],
    sizes: CSST.map(([n, ehd, idIn]) => ({ nominalIn: n, odMm: r1((idIn + 0.12) * IN), idMm: r1(idIn * IN), wallMm: r1(0.06 * IN), label: `EHD ${ehd}` })),
    roughnessMm: 0.5,
    hazenWilliamsC: 100,
    manningN: 0.015,
    pressureClass: "Low and medium pressure gas, to the manufacturer's listing",
    joints: ["csst_mechanical"],
    defaultJoint: "csst_mechanical",
    note: "Each manufacturer publishes its own EHD and capacity; the inside diameter here is a flow-equivalent placeholder. Verify against the product submitted.",
  },
  {
    id: "sdr11",
    material: "pe",
    name: "Polyethylene gas pipe (PE), IPS",
    standard: "ASTM D2513",
    services: ["gas"],
    sizes: PE_GAS.map(([n, od, idIn, designation]) => ({ nominalIn: n, odMm: r1(od * IN), idMm: r1(idIn * IN), wallMm: r1(((od - idIn) / 2) * IN), designation })),
    roughnessMm: 0.0015,
    hazenWilliamsC: 150,
    manningN: 0.009,
    pressureClass: "Gas distribution PE; outdoors and underground only, with a listed transition fitting where it leaves the ground",
    joints: ["fusion"],
    defaultJoint: "fusion",
    note: "Sized on the fuel gas code's polyethylene tables. Install below grade only (VFGC 404.17); tracer wire per the code.",
  },
];

export const PIPE_PRODUCTS: readonly PipeProduct[] = STORED_SPECS.map(product);
