/**
 * Example A for risers: Sample Market (project 7492), the
 * restaurant on the P2 (sanitary riser), P3 (water riser) and GR (gas
 * riser) sheets, built only from commands (so it is also the agent drill's
 * script).
 *
 * Same marks, loads and routing as the load-points stream's
 * `sample-market.ts` (39 fixtures, 37 cold / 15.75 hot WSFU, 88 DFU; the
 * sanitary main's four legs at 20 → 26 → 59 → 88 DFU), with each fixture a
 * part on the end of its pipe instead of a load point, plus a vent stack
 * through the roof and the GR gas system (K07 90, K08 220, K09 2 × 120,
 * GWH 250, DOAS 224.407 = 1,024.407 MBH).
 *
 * The pipe report counts a system from its first source part by id, so the
 * water meter (`cw-meter`) and the gas entry (`gas-entry`) have ids that sort
 * before the water heater (`gwh`) and the outdoor air unit (`rtu-doas`),
 * which also have equipment connections on those systems. The report counts
 * equipment as feeding, not loading, so until gas zones read appliance input
 * the heater's 250 and the unit's 224.407 MBH are not in the gas totals; the
 * kitchen appliances are generic parts and count (K07 90, K08 220, K09 2 × 120).
 */
import type { BimElement, Command, PartTypeDefinition, RunSegment } from "../../src";
import { Building } from "./electrical-building";

const FT = 304.8;
const IN = 25.4;

type Kind = "sanitary" | "vent" | "domestic_cold_water" | "domestic_hot_water" | "natural_gas";

interface Row {
  readonly id: string;
  readonly qty: number;
  readonly fixture: string;
  readonly cold: number;
  readonly hot: number;
  readonly total: number;
  readonly dfu: number;
}

/** The sheet's Plumbing loads table (cold, hot, total WSFU and DFU per fixture). */
export const SAMPLE_MARKET_ROWS: readonly Row[] = [
  { id: "FD2", qty: 1, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 3 },
  { id: "FD3", qty: 3, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 5 },
  { id: "FD4", qty: 1, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 6 },
  { id: "FS3", qty: 4, fixture: "Floor sink", cold: 0, hot: 0, total: 0, dfu: 5 },
  { id: "K01", qty: 3, fixture: "Hand sink", cold: 1.5, hot: 1.5, total: 2, dfu: 3 },
  { id: "K02", qty: 2, fixture: "Ice maker", cold: 0.25, hot: 0, total: 0.25, dfu: 0 },
  { id: "K03.1", qty: 1, fixture: "Three compartment sink", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K03.2", qty: 1, fixture: "Pre rinse faucet", cold: 3, hot: 3, total: 4, dfu: 0 },
  { id: "K04", qty: 1, fixture: "Dishwasher", cold: 0, hot: 1, total: 1, dfu: 0 },
  { id: "K05", qty: 1, fixture: "Single compartment sink", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K05.2", qty: 1, fixture: "Pre rinse faucet", cold: 2, hot: 2, total: 3, dfu: 0 },
  { id: "K13", qty: 2, fixture: "Glass rack", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K15", qty: 1, fixture: "Drip tray", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K16", qty: 2, fixture: "Ice chest", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K19", qty: 1, fixture: "Beer tap", cold: 0, hot: 0, total: 0, dfu: 0 },
  { id: "K27", qty: 1, fixture: "Soda dispenser", cold: 0.25, hot: 0, total: 0.25, dfu: 0 },
  { id: "P01", qty: 2, fixture: "Water closet", cold: 5, hot: 0, total: 5, dfu: 5 },
  { id: "P01A", qty: 2, fixture: "Water closet - ADA", cold: 5, hot: 0, total: 5, dfu: 5 },
  { id: "P02", qty: 2, fixture: "Lavatory - ADA", cold: 0, hot: 0, total: 0, dfu: 1 },
  { id: "P03", qty: 2, fixture: "Single handle faucet", cold: 1.5, hot: 1.5, total: 2, dfu: 0 },
  { id: "P04", qty: 1, fixture: "Mop sink", cold: 2.25, hot: 2.25, total: 3, dfu: 3 },
  { id: "P05", qty: 2, fixture: "Trench drain", cold: 0, hot: 0, total: 0, dfu: 5 },
  { id: "P07", qty: 1, fixture: "Hose bibb", cold: 1.5, hot: 0, total: 1.5, dfu: 0 },
  { id: "WF", qty: 1, fixture: "Water filter", cold: 0, hot: 0, total: 0, dfu: 0 },
];

export const SAMPLE_MARKET_RISER_TOTALS = { cold: 37, hot: 15.75, dfu: 88, sanitaryRunning: [20, 26, 59, 88], gasMbh: 1024.407 } as const;

export const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
export const VENT = { id: "sys-vent", kind: "vent" as const, name: "Vent" };
export const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
export const HW = { id: "sys-hw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };
export const GAS = { id: "sys-gas", kind: "natural_gas" as const, name: "Gas" };

const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });
const steel = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "black_steel" as const });

interface ConnectorSpec {
  readonly id: string;
  readonly kind: Kind;
  readonly at?: readonly [number, number, number];
  readonly dir?: readonly [number, number, number];
  readonly flow?: number;
  /** The pipe size routed from it; absent: it takes any size (a fixture's point at the end of its pipe). */
  readonly diameterIn?: number;
}

export function partType(name: string, category: PartTypeDefinition["category"], connectors: readonly ConnectorSpec[]): PartTypeDefinition {
  return {
    familyName: name,
    typeName: "Sample Market",
    category,
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: connectors.map((c) => ({
      id: c.id,
      label: c.id,
      domain: "pipe" as const,
      systemKind: c.kind,
      position: [...(c.at ?? [0, 0, 0])] as [number, number, number],
      direction: [...(c.dir ?? [1, 0, 0])] as [number, number, number],
      ...(c.diameterIn !== undefined ? { shape: "round" as const, diameter: c.diameterIn * IN } : { shape: "none" as const }),
      ...(c.flow !== undefined ? { flow: c.flow } : {}),
    })),
    geometry: [{ kind: "box", center: [0, 0, 100], size: [300, 300, 200] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [300, 300] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "sample-market" },
  };
}

/** One fixture instance per sheet quantity: "K01-1", "K01-2"… */
export function sampleMarketMarks(): Array<{ readonly mark: string; readonly row: Row }> {
  return SAMPLE_MARKET_ROWS.flatMap((row) => Array.from({ length: row.qty }, (_, i) => ({ mark: `${row.id}-${i + 1}`, row })));
}

/** The sanitary main's legs and the fixtures branching into each, upstream first. */
export const SAN_LEGS: ReadonlyArray<readonly string[]> = [
  ["FS3-1", "FS3-2", "FS3-3", "FS3-4"],
  ["FD4-1"],
  ["FD3-1", "FD3-2", "FD3-3", "P05-1", "P05-2", "FD2-1", "P04-1", "P02-1", "P02-2"],
  ["K01-1", "K01-2", "K01-3", "P01-1", "P01-2", "P01A-1", "P01A-2"],
];

/**
 * A part at a pipe's open end, its connector facing the pipe, connected to it:
 * the fixture (or equipment) the pipe serves.
 */
export function attach(b: Building, segmentId: string, end: "start" | "end", partId: string, typeId: string, type: PartTypeDefinition, mark: string): void {
  const seg = b.head.elements[segmentId] as BimElement | undefined;
  if (seg?.kind !== "run_segment") throw new Error(`no segment ${segmentId}`);
  const s: RunSegment = seg;
  const at = s[end];
  const other = end === "start" ? s.end : s.start;
  // The connector faces into the pipe: from the end towards the other end, in plan.
  const deg = (Math.atan2(other.y - at.y, other.x - at.x) * 180) / Math.PI;
  b.ok({ type: "place_part", partId, typeId, ...(b.head.elements[typeId] ? {} : { partType: type }), levelId: s.levelId, position: { x: at.x, y: at.y }, offsetMm: at.z, rotationDeg: Math.round(deg * 1000) / 1000, mark });
  b.ok({ type: "connect_runs", a: { elementId: segmentId, port: end }, b: { elementId: partId, port: "c" } });
}

const fixtureType = (row: Row, kind: Kind, flow: number) => partType(row.fixture, "plumbing_fixture", [{ id: "c", kind, flow }]);
const slug = (mark: string) => mark.toLowerCase().replace(/\./g, "_");

export interface SampleMarketRisers {
  readonly building: Building;
  /** The ids the tests and the drill look at. */
  readonly ids: { readonly sanLegs: readonly string[]; readonly cwService: string; readonly hwTrunk: string; readonly gasMain: string; readonly ventStack: string };
}

/** Builds the Sample Market model: sanitary and vent, domestic cold and hot water with the water heater, and gas. */
export function sampleMarketRisers(): SampleMarketRisers {
  const b = new Building();
  b.ok({ type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 16 * FT });
  const marks = new Map(sampleMarketMarks().map((m) => [m.mark, m.row]));
  const row = (mark: string): Row => {
    const r = marks.get(mark);
    if (!r) throw new Error(`no fixture ${mark}`);
    return r;
  };

  // Sanitary: a 4" main of four legs falling to the outfall at its last point; a branch per fixture.
  b.ok({ type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: SAN, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -12 * FT }, { x: 60 * FT, y: -12 * FT }, { x: 60 * FT, y: -44 * FT }] });
  const sanLegs = ["san-s1", "san-s2", "san-s3", "san-s4"];
  const legBranch = (leg: number, k: number): { from: { x: number; y: number }; on: { x: number; y: number } } => {
    const s = (4 + 4 * k) * FT;
    if (leg === 0) return { from: { x: 5 * FT * k, y: 6 * FT }, on: { x: 5 * FT * k, y: 0 } };
    if (leg === 1) return { from: { x: 26 * FT, y: -6 * FT }, on: { x: 20 * FT, y: -6 * FT } };
    if (leg === 2) return { from: { x: 20 * FT + s, y: -6 * FT }, on: { x: 20 * FT + s, y: -12 * FT } };
    return { from: { x: 66 * FT, y: -12 * FT - s }, on: { x: 60 * FT, y: -12 * FT - s } };
  };
  SAN_LEGS.forEach((leg, li) => {
    leg.forEach((mark, k) => {
      const r = row(mark);
      const type = fixtureType(r, "sanitary", r.dfu);
      const typeId = `t-${slug(r.id)}-san`;
      if (li === 0 && k === 0) {
        attach(b, "san-s1", "start", `san-${slug(mark)}`, typeId, type, mark);
        return;
      }
      const at = legBranch(li, k);
      const prefix = `san-${mark}`;
      b.ok({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: pvc(2), system: SAN, points: [at.from, at.on], to: { kind: "run_branch", segmentId: sanLegs[li] as string } });
      attach(b, `${prefix}-s1`, "start", `san-${slug(mark)}`, typeId, type, mark);
    });
  });
  // Cleanouts: at the head of the main and on the last leg before the outfall.
  b.ok({ type: "place_run_accessory", accessoryId: "co-head", segmentId: "san-s1", atMm: 2 * FT, family: "dwv.cleanout_wye" });
  b.ok({ type: "place_run_accessory", accessoryId: "co-ext", segmentId: "san-s4", atMm: 30 * FT, family: "dwv.cleanout_wye" });

  // Vent: a 3" stack through the roof, a 2" vent branch to the water closets and one to the lavatories.
  const ventX = 50 * FT;
  const ventY = -20 * FT;
  b.ok({ type: "route_run", idPrefix: "vent", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: 1 * FT, system: VENT, points: [{ x: ventX, y: ventY }, { x: ventX, y: ventY, elevationMm: 18 * FT }] });
  const ventConnection = partType("Vent connection", "pipe_accessory", [{ id: "c", kind: "vent" }]);
  [
    { mark: "P01-1", to: { x: ventX + 8 * FT, y: ventY } },
    { mark: "P02-1", to: { x: ventX - 8 * FT, y: ventY } },
  ].forEach((v, i) => {
    const prefix = `vent-b${i + 1}`;
    b.ok({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: pvc(2), elevationMm: (4 + i) * FT, system: VENT, points: [v.to, { x: ventX, y: ventY }], to: { kind: "run_branch", segmentId: "vent-s1" } });
    attach(b, `${prefix}-s1`, "start", `vent-${slug(v.mark)}`, "t-vent-connection", ventConnection, v.mark);
  });

  // Domestic water: the meter, a 2" trunk with a shut-off, the water heater, then a branch per cold point.
  const waterZ = 9 * FT;
  const meter = partType("Water meter", "mechanical_equipment", [{ id: "out", kind: "domestic_cold_water" }]);
  b.ok({ type: "place_part", partId: "cw-meter", typeId: "t-meter", partType: meter, levelId: "lvl-1", position: { x: 0, y: 40 * FT }, offsetMm: waterZ, mark: "WM-1" });
  b.ok({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper(2), system: CW, points: [{ x: 100 * FT, y: 40 * FT }], from: { kind: "part", partId: "cw-meter", connectorId: "out" }, capEnd: true });
  b.ok({ type: "place_run_accessory", accessoryId: "cw-sov", segmentId: "cw-s1", atMm: 1 * FT, family: "pipe.valve.ball" });
  const hx = 92 * FT;
  const hy = 34 * FT;
  const heaterZ = waterZ - 450;
  const heater = partType("Gas water heater, 100 gal", "mechanical_equipment", [
    { id: "cw", kind: "domestic_cold_water", at: [100, 0, 450], dir: [0, 1, 0] },
    { id: "hw", kind: "domestic_hot_water", at: [-100, 0, 450], dir: [0, 1, 0] },
    { id: "gas", kind: "natural_gas", at: [0, -200, 10 * FT - heaterZ], dir: [0, -1, 0], flow: 250 },
  ]);
  b.ok({ type: "place_part", partId: "gwh", typeId: "t-gwh", partType: heater, levelId: "lvl-1", position: { x: hx, y: hy }, offsetMm: heaterZ, mark: "GWH" });
  b.ok({ type: "route_run", idPrefix: "cw-gwh", levelId: "lvl-1", domain: "pipe", size: copper(1.5), system: CW, points: [{ x: hx + 100, y: 40 * FT }], from: { kind: "part", partId: "gwh", connectorId: "cw" }, to: { kind: "run_branch", segmentId: "cw-s1" } });
  b.ok({ type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: copper(1.5), system: HW, points: [{ x: hx - 100, y: 37 * FT }, { x: 6 * FT, y: 37 * FT }], from: { kind: "part", partId: "gwh", connectorId: "hw" }, capEnd: true });

  const coldMarks: string[] = [];
  const hotMarks: string[] = [];
  for (const [mark, r] of marks) {
    const zero = r.cold === 0 && r.hot === 0 && r.total === 0 && r.dfu === 0;
    if (r.cold > 0 || (r.total > 0 && r.hot === 0) || zero) coldMarks.push(mark);
    if (r.hot > 0) hotMarks.push(mark);
  }
  coldMarks.forEach((mark, k) => {
    const r = row(mark);
    const x = (4 + 3 * k) * FT;
    const prefix = `cw-${mark}`;
    b.ok({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: CW, points: [{ x, y: 46 * FT }, { x, y: 40 * FT }], to: { kind: "run_branch", segmentId: "cw-s1" } });
    attach(b, `${prefix}-s1`, "start", `cw-${slug(mark)}`, `t-${slug(r.id)}-cw`, fixtureType(r, "domestic_cold_water", r.cold > 0 ? r.cold : r.total), mark);
  });
  hotMarks.forEach((mark, k) => {
    const r = row(mark);
    const x = (80 - 3 * k) * FT;
    const prefix = `hw-${mark}`;
    b.ok({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: HW, points: [{ x, y: 31 * FT }, { x, y: 37 * FT }], to: { kind: "run_branch", segmentId: "hw-s2" } });
    attach(b, `${prefix}-s1`, "start", `hw-${slug(mark)}`, `t-${slug(r.id)}-hw`, fixtureType(r, "domestic_hot_water", r.hot), mark);
  });

  // Gas (GR): the entry, a 1" main at 10 ft, the kitchen line K09, K09, K08, K07, then the water heater and the outdoor air unit, each with its shut-off.
  const gasZ = 10 * FT;
  const entry = partType("Gas entry, secondary regulator outlet", "mechanical_equipment", [{ id: "out", kind: "natural_gas" }]);
  b.ok({ type: "place_part", partId: "gas-entry", typeId: "t-gas-entry", partType: entry, levelId: "lvl-1", position: { x: 110 * FT, y: 20 * FT }, offsetMm: gasZ, rotationDeg: 180, mark: "GAS ENTRY" });
  b.ok({ type: "route_run", idPrefix: "gas", levelId: "lvl-1", domain: "pipe", size: steel(1), system: GAS, points: [{ x: 6 * FT, y: 20 * FT }], from: { kind: "part", partId: "gas-entry", connectorId: "out" }, capEnd: true });
  // The 7492 gas is undiluted propane (the sheet's tables); the system's design says so, and so every label does.
  b.ok({ type: "set_system_design", systemId: GAS.id, design: { pipe: { gasType: "propane" } } });
  const appliances: ReadonlyArray<{ readonly mark: string; readonly name: string; readonly mbh: number; readonly x: number }> = [
    { mark: "K09-1", name: "18 in. gas fryer", mbh: 120, x: 10 },
    { mark: "K09-2", name: "18 in. gas fryer", mbh: 120, x: 14 },
    { mark: "K08", name: "36 in. gas range", mbh: 220, x: 18 },
    { mark: "K07", name: "36 in. gas flat top grill", mbh: 90, x: 22 },
  ];
  for (const a of appliances) {
    const id = `gas-${slug(a.mark)}`;
    const type = partType(a.name, "generic", [{ id: "g", kind: "natural_gas", dir: [0, 1, 0], flow: a.mbh }]);
    b.ok({ type: "place_part", partId: id, typeId: `t-${slug(a.mark)}`, partType: type, levelId: "lvl-1", position: { x: a.x * FT, y: 14 * FT }, offsetMm: gasZ, mark: a.mark });
    b.ok({ type: "route_run", idPrefix: id, levelId: "lvl-1", domain: "pipe", size: steel(0.75), system: GAS, points: [{ x: a.x * FT, y: 20 * FT }], from: { kind: "part", partId: id, connectorId: "g" }, to: { kind: "run_branch", segmentId: "gas-s1" } });
    b.ok({ type: "place_run_accessory", accessoryId: `${id}-cock`, segmentId: `${id}-s1`, atMm: 2 * FT, family: "pipe.gas.cock" });
  }
  b.ok({ type: "route_run", idPrefix: "gas-gwh", levelId: "lvl-1", domain: "pipe", size: steel(0.75), system: GAS, points: [{ x: hx, y: 20 * FT }], from: { kind: "part", partId: "gwh", connectorId: "gas" }, to: { kind: "run_branch", segmentId: "gas-s1" } });
  b.ok({ type: "place_run_accessory", accessoryId: "gas-gwh-cock", segmentId: "gas-gwh-s1", atMm: 2 * FT, family: "pipe.gas.cock" });
  const doas = partType("Dedicated outdoor air unit", "mechanical_equipment", [{ id: "g", kind: "natural_gas", dir: [0, -1, 0], flow: 224.407 }]);
  b.ok({ type: "place_part", partId: "rtu-doas", typeId: "t-doas", partType: doas, levelId: "lvl-1", position: { x: 70 * FT, y: 26 * FT }, offsetMm: gasZ, mark: "DOAS-1" });
  b.ok({ type: "route_run", idPrefix: "gas-doas", levelId: "lvl-1", domain: "pipe", size: steel(0.5), system: GAS, points: [{ x: 70 * FT, y: 20 * FT }], from: { kind: "part", partId: "rtu-doas", connectorId: "g" }, to: { kind: "run_branch", segmentId: "gas-s1" } });
  b.ok({ type: "place_run_accessory", accessoryId: "gas-doas-cock", segmentId: "gas-doas-s1", atMm: 2 * FT, family: "pipe.gas.cock" });

  return { building: b, ids: { sanLegs, cwService: "cw-s1", hwTrunk: "hw-s2", gasMain: "gas-s1", ventStack: "vent-s1" } };
}

/** Views for the four risers on the sheets, plus the isometric. */
export const SAMPLE_MARKET_RISER_VIEWS: ReadonlyArray<{ readonly viewId: string; readonly name: string; readonly kind: "plumbing_riser" | "plumbing_isometric"; readonly systemKinds: readonly string[] }> = [
  { viewId: "v-san", name: "P2 Sanitary riser", kind: "plumbing_riser", systemKinds: ["sanitary", "vent"] },
  { viewId: "v-dcw", name: "P3 Domestic cold water riser", kind: "plumbing_riser", systemKinds: ["domestic_cold_water"] },
  { viewId: "v-dhw", name: "P3 Domestic water riser", kind: "plumbing_riser", systemKinds: ["domestic_cold_water", "domestic_hot_water"] },
  { viewId: "v-gas", name: "GR Gas riser", kind: "plumbing_riser", systemKinds: ["natural_gas"] },
];

export function riserViewCommands(): Command[] {
  return SAMPLE_MARKET_RISER_VIEWS.map((v) => ({ type: "create_view", viewId: v.viewId, name: v.name, viewType: "detail", props: { diagram: { kind: v.kind, hints: { systemKinds: [...v.systemKinds] } } } }));
}
