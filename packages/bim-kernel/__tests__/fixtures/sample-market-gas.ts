import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type PartTypeDefinition } from "../../src";

/**
 * The gas system on the issued set for project 7492 (Sample
 * Market), as model commands only, so the same list is the kernel fixture,
 * the calc golden and the agent drill script.
 *
 * Undiluted propane. The secondary regulator (by others) delivers 2 psi; the
 * 2 psi zone feeds the DOAS (224.407 MBH) and the gas water heater GWH
 * (250 MBH), each through its own appliance regulator, and the kitchen line
 * regulator LR-1 (11 in. w.c., 0.5 in. drop) feeds the cook line: K07 grill
 * 90, K08 range 220, two K09 fryers 120 each. Total 1,024.407 MBH.
 *
 * Plan (feet, all pipe 3 ft above Level 1): the 2 psi main runs east from
 * the service at (0,0) to (50,0), jogs south 2 ft (LR-1 sits on the jog,
 * 1 ft down), then the 1-1/4" kitchen header runs east to (66,-2) and on
 * south to the far fryer. K07, K08 and K09b tee off the header at x 55, 58
 * and 61 and run south; the far fryer K09a ends the main. From LR-1 the far
 * fryer is 97 ft, so the cook line sizes on the 100 ft column, as on the
 * sheet: 1-1/4" manifold, 1" to the range, 3/4" to the fryers and grill.
 */

const FT = 304.8;
const IN = 25.4;
const Z = 3 * FT;

const builtin = { kind: "builtin", libraryVersion: "test" } as const;
const box = { geometry: [{ kind: "box" as const, center: [0, 0, 100] as [number, number, number], size: [200, 200, 200] as [number, number, number] }], symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [200, 200] as [number, number] }] };

function gasPart(familyName: string, typeName: string, category: PartTypeDefinition["category"], direction: [number, number, number], mbh: number | null, flowDirection?: "out"): PartTypeDefinition {
  return {
    familyName,
    typeName,
    category,
    typeParams: mbh !== null ? [{ name: "input_mbh", label: "Input (MBH)", kind: "number", unit: "none", min: 0 }] : [],
    typeValues: mbh !== null ? { input_mbh: mbh } : {},
    instanceParams: [],
    connectors: [{ id: "g", label: "Gas", domain: "pipe", systemKind: "natural_gas", position: [0, 0, 0], direction, shape: "round", diameter: 0.75 * IN, ...(flowDirection ? { flowDirection } : {}) }],
    ...box,
    tagFields: ["mark"],
    source: builtin,
  };
}

export const SAMPLE_MARKET_GAS_TYPES = {
  service: gasPart("Propane service", "2 psi secondary regulator outlet (by others)", "mechanical_equipment", [1, 0, 0], null, "out"),
  doas: gasPart("Dedicated outdoor air unit", "DOAS-1", "mechanical_equipment", [1, 0, 0], 224.407),
  gwh: gasPart("Water heater, gas", "100 gal, 250 MBH", "plumbing_fixture", [1, 0, 0], 250),
  grill: gasPart("Gas flat top grill", "36 in.", "plumbing_fixture", [1, 0, 0], 90),
  range: gasPart("Gas range", "36 in.", "plumbing_fixture", [1, 0, 0], 220),
  fryer: gasPart("Gas fryer", "18 in.", "plumbing_fixture", [1, 0, 0], 120),
  farFryer: gasPart("Gas fryer", "18 in.", "plumbing_fixture", [-1, 0, 0], 120),
} as const;

export const SAMPLE_MARKET_GAS_SYSTEM = "sys-gas";
export const SAMPLE_MARKET_GAS_TOTAL_MBH = 1024.407;

const steel = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "black_steel" as const });
const system = { id: SAMPLE_MARKET_GAS_SYSTEM, kind: "natural_gas" as const, name: "Propane" };

export interface SampleMarketGasOptions {
  /** Leave the GWH appliance regulator out (the 2 psi zone then feeds the heater directly). */
  readonly withoutHeaterRegulator?: boolean;
  /** The range's input, MBH (220 on the sheet). */
  readonly rangeMbh?: number;
  /** The range's minimum inlet pressure, in. w.c. (not on the sheet). */
  readonly rangeMinInletInWc?: number;
  /** Size every pipe this many inches (the sizes drawn before sizing). */
  readonly drawnIn?: number;
}

export function sampleMarketGasCommands(o: SampleMarketGasOptions = {}): Command[] {
  const drawn = o.drawnIn ?? 0.75;
  const base = SAMPLE_MARKET_GAS_TYPES.range;
  const range: PartTypeDefinition = {
    ...base,
    typeParams: [...base.typeParams, ...(o.rangeMinInletInWc !== undefined ? [{ name: "min_inlet_in_wc", label: "Minimum inlet (in. w.c.)", kind: "number" as const, unit: "none" as const, min: 0 }] : [])],
    typeValues: { input_mbh: o.rangeMbh ?? 220, ...(o.rangeMinInletInWc !== undefined ? { min_inlet_in_wc: o.rangeMinInletInWc } : {}) },
  };
  const place = (partId: string, typeId: string, partType: PartTypeDefinition, x: number, y: number, mark: string): Command => ({ type: "place_part", partId, typeId, partType, levelId: "lvl-1", position: { x: x * FT, y: y * FT }, offsetMm: Z, mark });
  const branch = (idPrefix: string, partId: string, x: number, y: number, onto: string): Command => ({ type: "route_run", idPrefix, levelId: "lvl-1", domain: "pipe", size: steel(drawn), elevationMm: Z, system, points: [{ x: x * FT, y: y * FT }, { x: x * FT, y: (onto === "main-s1" ? 0 : -2) * FT }], from: { kind: "part", partId, connectorId: "g" }, to: { kind: "run_branch", segmentId: onto } });
  const reg = (accessoryId: string, segmentId: string, atFt: number, role: string, outlet: number, drop: number): Command => ({ type: "place_run_accessory", accessoryId, segmentId, atMm: atFt * FT, family: "pipe.gas.regulator", params: { role, outlet_in_wc: outlet, zone_drop_in_wc: drop } });
  const cmds: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
    place("svc", "t:svc", SAMPLE_MARKET_GAS_TYPES.service, 0, 0, "GS-1"),
    place("doas", "t:doas", SAMPLE_MARKET_GAS_TYPES.doas, 10, 20, "DOAS-1"),
    place("gwh", "t:gwh", SAMPLE_MARKET_GAS_TYPES.gwh, 25, 20, "GWH"),
    place("k07", "t:grill", SAMPLE_MARKET_GAS_TYPES.grill, 50, -59, "K07"),
    place("k08", "t:range", range, 53, -66, "K08"),
    place("k09b", "t:fryer", SAMPLE_MARKET_GAS_TYPES.fryer, 56, -72, "K09"),
    place("k09a", "t:far-fryer", SAMPLE_MARKET_GAS_TYPES.farFryer, 71, -77, "K09"),
    { type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: steel(drawn), elevationMm: Z, system, points: [{ x: 50 * FT, y: 0 }, { x: 50 * FT, y: -2 * FT }, { x: 66 * FT, y: -2 * FT }, { x: 66 * FT, y: -77 * FT }], from: { kind: "part", partId: "svc", connectorId: "g" }, to: { kind: "part", partId: "k09a", connectorId: "g" } },
    { type: "set_system_design", systemId: SAMPLE_MARKET_GAS_SYSTEM, design: { pipe: { gasType: "propane", inletPressureInWc: 55.4, allowableDropInWc: 27.7 } } },
    branch("doas-b", "doas", 15, 20, "main-s1"),
    branch("gwh-b", "gwh", 30, 20, "main-s1"),
    branch("k07-b", "k07", 55, -59, "main-s3"),
    branch("k08-b", "k08", 58, -66, "main-s3"),
    branch("k09b-b", "k09b", 61, -72, "main-s3"),
    reg("LR-1", "main-s2", 1, "line", 11, 0.5),
    reg("AR-DOAS", "doas-b-s2", 10, "appliance", 11, 0.5),
  ];
  if (!o.withoutHeaterRegulator) cmds.push(reg("AR-GWH", "gwh-b-s2", 10, "appliance", 11, 0.5));
  return cmds;
}

let n = 0;
export function buildSampleMarketGas(o: SampleMarketGasOptions = {}): ModelState {
  let m: ModelState = { modelId: "sample-market-gas", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of sampleMarketGasCommands(o)) {
    const d = planCommit(m, [], { idempotencyKey: `sample-market-gas-${++n}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    m = d.model;
  }
  return m;
}
