/**
 * Example A: Sample Market (project 7492), restaurant, one level.
 *
 * Built only from commands, so it is also the agent drill script (the same
 * commands `bim_place_load_points` and the routing tools send). Shared by
 * the plumbing streams: load points (P-A), code packs (P-B), schedules (P-H),
 * risers (P-F), gas (P-E). Reuse it; extend it with new exports rather than
 * changing what is here.
 *
 * Source: the issued P1 sheet, "Plumbing loads" (39 fixtures, 24
 * connection types). Grand totals on the sheet: 37 cold / 15.75 hot / 43.25
 * total WSFU, 88 DFU, 198 gal/h. The brief listed K05.2 ×2 and K16 ×1; the
 * sheet has K05.2 ×1 and K16 ×2 (the 39 only adds up that way), so the sheet
 * wins here.
 *
 * Topology (synthetic, laid out to reproduce the sheet's riser):
 *
 * - Sanitary main, 4" PVC, four legs from the upstream end to the outfall
 *   (`san-s1` → `san-s4`), branches into each leg:
 *   leg 1 FS3 ×4 (20 DFU, one on the upstream end) · leg 2 FD4 (26) ·
 *   leg 3 FD3 ×3, P05 ×2, FD2, P04, P02 ×2 (59) · leg 4 K01 ×3, P01 ×2,
 *   P01A ×2 (88, open end = the outfall).
 * - Domestic cold, 2" copper trunk `cw-s1` from the service (its open west
 *   end) with a branch per cold point and one to the water heater's inlet.
 * - Domestic hot from the water heater GWH (`gwh`): `hw-s1` up from the
 *   heater, `hw-s2` west with a branch per hot point.
 *
 * Each fixture has a point on every system it connects to; a fixture's cold
 * and hot points share its mark ("K01-2"), so the service carries its total
 * units (2 for a hand sink), not cold + hot (3).
 */
import { builtinPartType, type Command, type ConnectionTypeInput } from "../../src";

const FT = 304.8;
const IN = 25.4;

export interface SampleMarketFixtureRow {
  readonly id: string;
  readonly qty: number;
  readonly fixture: string;
  /** Per fixture, as the sheet's Cold / Hot / Total / DFU columns. */
  readonly cold: number;
  readonly hot: number;
  readonly total: number;
  readonly dfu: number;
  /** Per fixture (the sheet prints the row total: 15 gal/h for 3 hand sinks). */
  readonly gph: number;
}

/** The sheet's Plumbing loads table, row by row. */
export const SAMPLE_MARKET_FIXTURES: readonly SampleMarketFixtureRow[] = [
  { id: "FD2", qty: 1, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 3, gph: 0 },
  { id: "FD3", qty: 3, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 5, gph: 0 },
  { id: "FD4", qty: 1, fixture: "Floor drain", cold: 0, hot: 0, total: 0, dfu: 6, gph: 0 },
  { id: "FS3", qty: 4, fixture: "Floor sink", cold: 0, hot: 0, total: 0, dfu: 5, gph: 0 },
  { id: "K01", qty: 3, fixture: "Hand sink", cold: 1.5, hot: 1.5, total: 2, dfu: 3, gph: 5 },
  { id: "K02", qty: 2, fixture: "Ice maker", cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { id: "K03.1", qty: 1, fixture: "Three compartment sink", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K03.2", qty: 1, fixture: "Pre rinse faucet", cold: 3, hot: 3, total: 4, dfu: 0, gph: 90 },
  { id: "K04", qty: 1, fixture: "Dishwasher", cold: 0, hot: 1, total: 1, dfu: 0, gph: 35 },
  { id: "K05", qty: 1, fixture: "Single compartment sink", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K05.2", qty: 1, fixture: "Pre rinse faucet", cold: 2, hot: 2, total: 3, dfu: 0, gph: 40 },
  { id: "K13", qty: 2, fixture: "Glass rack", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K15", qty: 1, fixture: "Drip tray", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K16", qty: 2, fixture: "Ice chest", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K19", qty: 1, fixture: "Beer tap", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
  { id: "K27", qty: 1, fixture: "Soda dispenser", cold: 0.25, hot: 0, total: 0.25, dfu: 0, gph: 0 },
  { id: "P01", qty: 2, fixture: "Water closet", cold: 5, hot: 0, total: 5, dfu: 5, gph: 0 },
  { id: "P01A", qty: 2, fixture: "Water closet - ADA", cold: 5, hot: 0, total: 5, dfu: 5, gph: 0 },
  { id: "P02", qty: 2, fixture: "Lavatory - ADA", cold: 0, hot: 0, total: 0, dfu: 1, gph: 4 },
  { id: "P03", qty: 2, fixture: "Single handle faucet", cold: 1.5, hot: 1.5, total: 2, dfu: 0, gph: 0 },
  { id: "P04", qty: 1, fixture: "Mop sink", cold: 2.25, hot: 2.25, total: 3, dfu: 3, gph: 10 },
  { id: "P05", qty: 2, fixture: "Trench drain", cold: 0, hot: 0, total: 0, dfu: 5, gph: 0 },
  { id: "P07", qty: 1, fixture: "Hose bibb", cold: 1.5, hot: 0, total: 1.5, dfu: 0, gph: 0 },
  { id: "WF", qty: 1, fixture: "Water filter", cold: 0, hot: 0, total: 0, dfu: 0, gph: 0 },
];

/** The sheet's grand totals. */
export const SAMPLE_MARKET_TOTALS = { fixtures: 39, connectionTypes: 24, cold: 37, hot: 15.75, total: 43.25, dfu: 88, gph: 198 } as const;
/** Running DFU on the sanitary main, upstream to the outfall (the riser's labels). */
export const SAMPLE_MARKET_SANITARY_RUNNING = [20, 26, 59, 88] as const;

/** Gas loads on the sheet (MBH), for the gas streams: K07 90, K08 220, K09 2×120, GWH 250, DOAS 224.407 = 1,024.407. */
export const SAMPLE_MARKET_GAS: ReadonlyArray<{ readonly id: string; readonly qty: number; readonly description: string; readonly mbh: number }> = [
  { id: "K07", qty: 1, description: "36 in. gas flat top grill", mbh: 90 },
  { id: "K08", qty: 1, description: "36 in. gas range", mbh: 220 },
  { id: "K09", qty: 2, description: "18 in. gas fryer", mbh: 120 },
  { id: "GWH", qty: 1, description: "Gas water heater, 100 gal", mbh: 250 },
  { id: "DOAS-1", qty: 1, description: "Dedicated outdoor air unit", mbh: 224.407 },
];

/** A connection type per row, with the sheet's values (what `bim_save_connection_type` sends). */
export function sampleMarketConnectionType(row: SampleMarketFixtureRow): Omit<ConnectionTypeInput, "type"> {
  return {
    designator: row.id,
    trade: "plumbing",
    description: row.fixture,
    quantities: { wsfu_cold: row.cold, wsfu_hot: row.hot, wsfu_total: row.total, dfu: row.dfu, ...(row.gph > 0 ? { gph_demand: row.gph } : {}) },
  };
}

const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });
export const SAMPLE_MARKET_SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
export const SAMPLE_MARKET_CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
export const SAMPLE_MARKET_HW = { id: "sys-hw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };

/** One fixture instance per sheet quantity: "K01-1", "K01-2"… */
export function sampleMarketInstances(): Array<{ readonly mark: string; readonly row: SampleMarketFixtureRow }> {
  return SAMPLE_MARKET_FIXTURES.flatMap((row) => Array.from({ length: row.qty }, (_, i) => ({ mark: `${row.id}-${i + 1}`, row })));
}

/** The sanitary main's legs and which fixtures branch into each, upstream first. */
const SAN_LEGS: ReadonlyArray<{ readonly marks: readonly string[] }> = [
  { marks: ["FS3-1", "FS3-2", "FS3-3", "FS3-4"] },
  { marks: ["FD4-1"] },
  { marks: ["FD3-1", "FD3-2", "FD3-3", "P05-1", "P05-2", "FD2-1", "P04-1", "P02-1", "P02-2"] },
  { marks: ["K01-1", "K01-2", "K01-3", "P01-1", "P01-2", "P01A-1", "P01A-2"] },
];

export interface SampleMarketPoint {
  readonly mark: string;
  readonly connectionType: string;
  readonly hostId: string;
  readonly port: string;
  readonly system: "sanitary" | "cold" | "hot";
}

export interface SampleMarketBuild {
  /** Level, connection types, runs and the water heater: everything before the load points. */
  readonly setup: Command[];
  /** Where every load point goes (one `create_load_point` with all of them is the drill's batch). */
  readonly points: SampleMarketPoint[];
  /** The service segment (CW), the hot trunk, the heater inlet branch, and the four sanitary legs. */
  readonly ids: { readonly cwService: string; readonly hwTrunk: string; readonly heaterInlet: string; readonly sanLegs: readonly string[]; readonly heater: string };
}

/** Builds Example A. `setup` then one `create_load_point` with `points`. */
export function sampleMarket(): SampleMarketBuild {
  const setup: Command[] = [{ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }];
  for (const row of SAMPLE_MARKET_FIXTURES) setup.push({ type: "save_connection_type", entry: sampleMarketConnectionType(row) });
  const points: SampleMarketPoint[] = [];
  const instances = new Map(sampleMarketInstances().map((i) => [i.mark, i.row]));

  // Sanitary main: four legs joined by elbows, falling to the outfall at its last point.
  setup.push({ type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: SAMPLE_MARKET_SAN, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: -12 * FT }, { x: 60 * FT, y: -12 * FT }, { x: 60 * FT, y: -44 * FT }] });
  const sanLegs = ["san-s1", "san-s2", "san-s3", "san-s4"];
  const legBranch = (leg: number, k: number): { from: { x: number; y: number }; on: { x: number; y: number } } => {
    const s = (4 + 4 * k) * FT;
    if (leg === 0) return { from: { x: 5 * FT * k, y: 6 * FT }, on: { x: 5 * FT * k, y: 0 } };
    if (leg === 1) return { from: { x: 26 * FT, y: -6 * FT }, on: { x: 20 * FT, y: -6 * FT } };
    if (leg === 2) return { from: { x: 20 * FT + s, y: -6 * FT }, on: { x: 20 * FT + s, y: -12 * FT } };
    return { from: { x: 66 * FT, y: -12 * FT - s }, on: { x: 60 * FT, y: -12 * FT - s } };
  };
  SAN_LEGS.forEach((leg, li) => {
    leg.marks.forEach((mark, k) => {
      const row = instances.get(mark);
      if (!row) throw new Error(`no fixture ${mark}`);
      if (li === 0 && k === 0) {
        points.push({ mark, connectionType: row.id, hostId: "san-s1", port: "start", system: "sanitary" });
        return;
      }
      const at = legBranch(li, k);
      const prefix = `san-${mark}`;
      setup.push({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: pvc(2), system: SAMPLE_MARKET_SAN, points: [at.from, at.on], to: { kind: "run_branch", segmentId: sanLegs[li] as string } });
      points.push({ mark, connectionType: row.id, hostId: `${prefix}-s1`, port: "start", system: "sanitary" });
    });
  });

  // Cold water: the service trunk, then the heater, then a branch per cold point.
  const waterZ = 9 * FT;
  setup.push({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper(2), elevationMm: waterZ, system: SAMPLE_MARKET_CW, points: [{ x: 0, y: 40 * FT }, { x: 100 * FT, y: 40 * FT }] });
  const heater = builtinPartType("builtin:plumbing-water-heater-tank@1");
  if (!heater) throw new Error("the starter water heater is missing");
  const hx = 92 * FT;
  const hy = 34 * FT;
  setup.push({ type: "save_connection_type", entry: { designator: "GWH", trade: "plumbing", description: "Gas water heater, 100 gal", quantities: { mbh: 250 } } });
  setup.push({ type: "place_part", partId: "gwh", typeId: heater.id, partType: heater.definition, levelId: "lvl-1", position: { x: hx, y: hy }, offsetMm: waterZ - 450, mark: "GWH" });
  setup.push({ type: "route_run", idPrefix: "cw-gwh", levelId: "lvl-1", domain: "pipe", size: copper(1.5), elevationMm: waterZ, system: SAMPLE_MARKET_CW, points: [{ x: hx + 100, y: 40 * FT }], from: { kind: "part", partId: "gwh", connectorId: "cw" }, to: { kind: "run_branch", segmentId: "cw-s1" } });
  // Hot water: up from the heater, then west.
  setup.push({ type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: copper(1.5), elevationMm: waterZ, system: SAMPLE_MARKET_HW, points: [{ x: hx - 100, y: 37 * FT }, { x: 6 * FT, y: 37 * FT }], from: { kind: "part", partId: "gwh", connectorId: "hw" } });

  const coldMarks: string[] = [];
  const hotMarks: string[] = [];
  for (const [mark, row] of instances) {
    const zero = row.cold === 0 && row.hot === 0 && row.total === 0 && row.dfu === 0;
    // Water-connected: cold or total units, or a fixture with no loads at all (kept on cold so all 39 fixtures are in the model).
    if (row.cold > 0 || (row.total > 0 && row.hot === 0) || zero) coldMarks.push(mark);
    if (row.hot > 0) hotMarks.push(mark);
  }
  coldMarks.forEach((mark, k) => {
    const row = instances.get(mark) as SampleMarketFixtureRow;
    const x = (4 + 3 * k) * FT;
    const prefix = `cw-${mark}`;
    setup.push({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: SAMPLE_MARKET_CW, points: [{ x, y: 46 * FT }, { x, y: 40 * FT }], to: { kind: "run_branch", segmentId: "cw-s1" } });
    points.push({ mark, connectionType: row.id, hostId: `${prefix}-s1`, port: "start", system: "cold" });
  });
  hotMarks.forEach((mark, k) => {
    const row = instances.get(mark) as SampleMarketFixtureRow;
    const x = (80 - 3 * k) * FT;
    const prefix = `hw-${mark}`;
    setup.push({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: SAMPLE_MARKET_HW, points: [{ x, y: 31 * FT }, { x, y: 37 * FT }], to: { kind: "run_branch", segmentId: "hw-s2" } });
    points.push({ mark, connectionType: row.id, hostId: `${prefix}-s1`, port: "start", system: "hot" });
  });
  return { setup, points, ids: { cwService: "cw-s1", hwTrunk: "hw-s2", heaterInlet: "cw-gwh-s1", sanLegs, heater: "gwh" } };
}

/** The one batch that places every load point (what `bim_place_load_points` sends). */
export function sampleMarketLoadPointCommand(points: readonly SampleMarketPoint[]): Command {
  return { type: "create_load_point", points: points.map((p) => ({ hostId: p.hostId, port: p.port, connectionType: p.connectionType, mark: p.mark })) };
}
