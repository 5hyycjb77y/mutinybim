/**
 * @jest-environment node
 *
 * Duct pressure and pipe hydraulics on the plugin interface give exactly the
 * kernel's numbers (deep-equal reports on routed systems built through real
 * commands), so moving mechanical and plumbing onto the common interface
 * changed no result. The kernel's own hand-calculation suites
 * (pressure.test.ts, pipe.test.ts) stay the source of truth for the values.
 */
import {
  DEFAULT_SETTINGS,
  builtinPartType,
  planCommit,
  type Command,
  type ModelState,
  type PartTypeDefinition,
  type RunSize,
} from "@permitzip/bim-kernel";
import {
  PA_PER_IN_WC,
  airProperties,
  frictionRate,
  systemPressure,
} from "@permitzip/bim-pack-mechanical";
import {
  hazenWilliamsPsiPer100Ft,
  pipeSystemReport,
} from "@permitzip/bim-pack-plumbing";
import { builtinCalcRegistry, type CalcRun } from "../src";

const FT = 304.8;
const IN = 25.4;
const registry = builtinCalcRegistry();
let n = 0;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `calc-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-21T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const empty = (): ModelState => commit({ modelId: "calc", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS }, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });

/** The kernel pressure suite's system: RTU-1 → 14x10 trunk → SD-1; a tap → 8" branch → SD-2. */
function ductSystem(): ModelState {
  const rtu = builtinPartType("builtin:rtu-5-ton@1");
  const sd = builtinPartType("builtin:supply-diffuser-24@1");
  if (!rtu || !sd) throw new Error("starter library");
  const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
  let m = empty();
  m = commit(m, { type: "place_part", partId: "rtu", typeId: rtu.id, partType: rtu.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd-a", typeId: sd.id, partType: sd.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  m = commit(m, { type: "place_part", partId: "sd-b", typeId: sd.id, levelId: "lvl-1", position: { x: 10 * FT, y: 6 * FT }, offsetMm: 8 * FT, mark: "SD-2" });
  m = commit(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
  return commit(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
}

function waterPart(name: string, category: PartTypeDefinition["category"], direction: [number, number, number], flow?: number): PartTypeDefinition {
  return {
    familyName: name,
    typeName: "Test",
    category,
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: [{ id: "c", label: "Connection", domain: "pipe", systemKind: "domestic_cold_water", position: [0, 0, 0], direction, shape: "round", diameter: IN, ...(flow !== undefined ? { flow } : {}) }],
    geometry: [{ kind: "box", center: [0, 0, 100], size: [200, 200, 200] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [200, 200] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

/** The kernel pipe suite's water system: WS-1 → 10 ft rise → FX-1 (5 gpm), 1" type L, 60 psi supply. */
function waterSystem(): ModelState {
  let m = empty();
  m = commit(m, { type: "place_part", partId: "svc", typeId: "test:svc", partType: waterPart("Water service", "mechanical_equipment", [1, 0, 0]), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "WS-1" });
  m = commit(m, { type: "place_part", partId: "fx", typeId: "test:fx", partType: waterPart("Test fixture", "plumbing_fixture", [-1, 0, 0], 5), levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 13 * FT, mark: "FX-1" });
  const copper: RunSize = { shape: "pipe", nominalMm: IN, material: "copper" };
  m = commit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper, elevationMm: 3 * FT, system: { id: "sys-cw", kind: "domestic_cold_water", name: "Domestic Cold Water" }, points: [{ x: 10 * FT, y: 0, elevationMm: 13 * FT }], from: { kind: "part", partId: "svc", connectorId: "c" }, to: { kind: "part", partId: "fx", connectorId: "c" } });
  return commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { supplyPressurePsi: 60, demandMethod: "flow_is_gpm", minFixturePressurePsi: 20 } } });
}

function run(calc: string, inputs: unknown, model?: ModelState): CalcRun {
  const r = registry.run({ calc, inputs, model });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}
const num = (r: CalcRun, key: string) => r.values.find((v) => v.key === key)?.value;

describe("duct pressure on the plugin interface", () => {
  const m = ductSystem();
  const direct = systemPressure(m, "sys-sa");
  const viaPlugin = run("mech.duct_system_pressure", { system_id: "sys-sa" }, m);

  it("returns the kernel's report unchanged", () => {
    expect(direct?.calculable).toBe(true);
    expect(viaPlugin.detail).toEqual(direct);
  });

  it("its headline values are the report's: ESP in. w.c. = total Pa / 249.0889, counted from RTU-1, critical end SD-2", () => {
    expect(num(viaPlugin, "required_esp_in_wc")).toBe(direct?.requiredEspInWc);
    expect(num(viaPlugin, "total_pa")).toBe(direct?.totalPa);
    expect(direct?.requiredEspInWc).toBeCloseTo((direct?.totalPa ?? 0) / PA_PER_IN_WC, 4);
    expect(num(viaPlugin, "fan")).toBe("RTU-1");
    expect(num(viaPlugin, "critical_end")).toBe("SD-2");
  });

  it("cites the friction method, the air model and every fitting coefficient source the report used", () => {
    expect(viaPlugin.citations.map((c) => c.text)).toEqual(
      expect.arrayContaining(["ASHRAE Handbook—Fundamentals, Duct Design: Darcy–Weisbach with the Colebrook friction factor", expect.stringMatching(/^Fitting loss coefficient: Formula, verify for permit work/)]),
    );
  });

  it("the point calc equals the kernel's friction rate: 10\" round at 400 CFM ≈ 0.085 in. w.c. / 100 ft", () => {
    const r = run("mech.duct_friction", { cfm: 400, diameter_in: 10 });
    const kernel = (frictionRate(400, { shape: "round", diameter: 10 * IN }, airProperties(0, 20), 0.09) * 30.48) / PA_PER_IN_WC;
    expect(num(r, "friction_in_wc_per_100ft")).toBeCloseTo(kernel, 4);
    expect(kernel).toBeGreaterThan(0.075);
    expect(kernel).toBeLessThan(0.095);
  });
});

describe("pipe hydraulics on the plugin interface", () => {
  const m = waterSystem();
  const direct = pipeSystemReport(m, "sys-cw");
  const viaPlugin = run("plumbing.pipe_system", { system_id: "sys-cw" }, m);

  it("returns the kernel's report unchanged", () => {
    expect(direct?.kind).toBe("water");
    expect(viaPlugin.detail).toEqual(direct);
  });

  it("headline values are the report's", () => {
    if (direct?.kind !== "water") throw new Error("water");
    expect(num(viaPlugin, "critical_fixture")).toBe("FX-1");
    expect(num(viaPlugin, "critical_pressure_psi")).toBe(direct.critical?.pressure);
    expect(num(viaPlugin, "pass")).toBe(true);
  });

  it("the point calc equals the kernel's Hazen-Williams: 10 gpm in a 0.785\" bore at C 140", () => {
    const r = run("plumbing.water_friction", { gpm: 10, inside_diameter_in: 0.785, hazen_c: 140 });
    expect(num(r, "friction_psi_per_100ft")).toBeCloseTo(hazenWilliamsPsiPer100Ft(10, 140, 0.785), 4);
  });
});
