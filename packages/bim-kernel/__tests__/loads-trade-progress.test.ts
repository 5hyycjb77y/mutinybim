/**
 * @jest-environment node
 *
 * QA defects D-1 / D-2 / D-3 (Oct 27, 7329 stand-in): progress per trade,
 * per-row counted figures that total to the project, and the rows a pipe end
 * can take. Before this change `progress(model, { kind: "trade" })` was not a
 * scope (it read "trade:undefined", 0 loads), `tradeProgressLine`,
 * `countedOf` and `loadsForRunEnd` did not exist, and the only progress line
 * counted the 5 gas rows with the 35 fixtures ("Loads: 40 · 0 piped").
 */
import { DEFAULT_SETTINGS, RequirementsEngine, QUANTITY_KEYS, QUANTITIES, asElementId, builtinPartType, executeCommand, fixedSpaceLocator, loadsForRunEnd, progressLine, tradeProgressLine, type Command, type ModelState, type Space } from "../src";
import { plumbingDrawnSource } from "@permitzip/bim-pack-plumbing";
import { CAFE_GAS, CAFE_TOTALS, cafeFixtureLoads } from "./loads-7329-fixture";

const FT = 304.8;
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * 25.4, material: "copper" as const });
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function cafe(): ModelState {
  let m: ModelState = { modelId: "7329", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_load", loads: cafeFixtureLoads() });
  return run(m, { type: "create_load", loads: CAFE_GAS.map((g) => ({ id: `load-gas-${g.tag}`, mark: g.tag, note: g.description, service: "gas" as const, values: { mbh: g.mbh } })) });
}

const FIVE = ["load-WC-1", "load-WC-2", "load-LV-1", "load-LV-2", "load-P41-1"];

function pipeFive(model: ModelState): ModelState {
  let m = model;
  FIVE.forEach((row, i) => {
    const x = (i + 1) * 3 * FT;
    m = run(m, { type: "route_run", idPrefix: `cw-r${i}`, levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: 3 * FT, system: CW, points: [{ x, y: 0 }, { x, y: 10 * FT }] });
    m = run(m, { type: "move_load", loadId: row, to: { kind: "run_end", hostId: `cw-r${i}-s1`, port: "end" } });
  });
  return m;
}

describe("progress per trade (D-2)", () => {
  it("7329 counts 35 water and drainage fixtures and 5 gas rows apart: 0 of 35 piped, 0 of 5 piped", () => {
    const m = cafe();
    const engine = new RequirementsEngine({ drawnSource: plumbingDrawnSource });
    const water = engine.progress(m, { kind: "trade", trade: "plumbing" });
    const gas = engine.progress(m, { kind: "trade", trade: "gas" });
    expect([water.total, gas.total]).toEqual([CAFE_TOTALS.fixtures, CAFE_GAS.length]);
    expect(tradeProgressLine(water, "plumbing")).toBe("Water and drainage: 0 of 35 piped");
    expect(tradeProgressLine(gas, "gas")).toBe("Gas: 0 of 5 piped");
    expect(engine.progress(m, { kind: "trade", trade: "electrical" }).total).toBe(0);
    // The project line is unchanged for every other caller.
    expect(progressLine(engine.progress(m))).toBe("Loads: 40 · 0 piped · 0 attached");
  });

  it("piping five rows reads 5 of 35 piped, gas stays 0 of 5, and the totals don't move; a carried engine agrees with a fresh one", () => {
    const before = cafe();
    const engine = new RequirementsEngine({ drawnSource: plumbingDrawnSource });
    const totals = engine.counted(before);
    const after = pipeFive(before);
    const changed = Object.keys(after.elements).filter((id) => after.elements[id] !== before.elements[id]);
    engine.advance(after, changed);
    expect(tradeProgressLine(engine.progress(after, { kind: "trade", trade: "plumbing" }), "plumbing")).toBe("Water and drainage: 5 of 35 piped");
    expect(tradeProgressLine(engine.progress(after, { kind: "trade", trade: "gas" }), "gas")).toBe("Gas: 0 of 5 piped");
    expect(engine.counted(after)).toEqual(totals);
    const fresh = new RequirementsEngine({ drawnSource: plumbingDrawnSource });
    expect(fresh.progress(after, { kind: "trade", trade: "plumbing" })).toEqual(engine.progress(after, { kind: "trade", trade: "plumbing" }));
  });

  it("a load filling two trades counts in each (a fryer row with gas and drainage)", () => {
    const m = run(cafe(), { type: "create_load", loads: [{ id: "load-fry", mark: "FRY-1", values: { mbh: 80, dfu: 2 } }] });
    const engine = new RequirementsEngine();
    expect(engine.progress(m, { kind: "trade", trade: "gas" }).total).toBe(CAFE_GAS.length + 1);
    expect(engine.progress(m, { kind: "trade", trade: "plumbing" }).total).toBe(CAFE_TOTALS.fixtures + 1);
  });
});

describe("what each row counts (D-1 totals row)", () => {
  const sum = (engine: RequirementsEngine, m: ModelState, ids: readonly string[]) => {
    const out: Record<string, number> = {};
    for (const k of QUANTITY_KEYS) {
      if (QUANTITIES[k].add !== "sum") continue;
      out[k] = Math.round(ids.reduce((s, id) => s + (engine.countedOf(m, id)?.[k] ?? 0), 0) * 1e6) / 1e6;
    }
    return out;
  };
  const summed = (t: Record<string, number>) => Object.fromEntries(Object.entries(t).filter(([k]) => QUANTITIES[k as keyof typeof QUANTITIES].add === "sum"));

  it("7329's rows add up to 25.75 / 13.5 / 30.25 WSFU, 79 DFU, 140 gal/h and 859 MBH, before and after piping", () => {
    for (const m of [cafe(), pipeFive(cafe())]) {
      const engine = new RequirementsEngine({ drawnSource: plumbingDrawnSource });
      const ids = Object.values(m.elements).filter((e) => e.kind === "load_point").map((e) => e.id);
      const t = sum(engine, m, ids);
      expect([t.wsfu_cold, t.wsfu_hot, t.wsfu_total, t.dfu, t.gph_demand, t.mbh]).toEqual([25.75, 13.5, 30.25, 79, 140, 859]);
    }
  });

  it("an estimate the devices exceed adds nothing; the devices add themselves; the rows still total the project", () => {
    let m: ModelState = { modelId: "k", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const space: Space = { id: asElementId("sp-kitchen"), kind: "space", version: 1, authoredRev: {}, number: "101", name: "Kitchen", levelId: asElementId("lvl-1"), bounds: { kind: "none" }, origin: { kind: "typed" } };
    m = { ...m, elements: { [space.id]: space } };
    m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const fryer = builtinPartType("builtin:plumbing-gas-fryer@1");
    if (!fryer) throw new Error("starter fryer");
    m = run(m, { type: "place_part", partId: "fry-1", typeId: fryer.id, partType: fryer.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "FRY-1" });
    m = run(m, { type: "place_part", partId: "fry-2", typeId: fryer.id, levelId: "lvl-1", position: { x: 1000, y: 0 }, mark: "FRY-2" });
    m = run(m, { type: "create_load", loads: [{ id: "est", anchor: { kind: "space", id: "sp-kitchen" }, service: "gas", values: { mbh: 100 } }] });
    m = run(m, { type: "create_load", loads: [{ id: "d1", anchor: { kind: "part", partId: "fry-1", connector: "g" }, values: { mbh: 80 } }, { id: "d2", anchor: { kind: "part", partId: "fry-2", connector: "g" }, values: { mbh: 80 } }] });
    const engine = new RequirementsEngine({ locator: fixedSpaceLocator({ spaceOf: { "fry-1": asElementId("sp-kitchen"), "fry-2": asElementId("sp-kitchen") } }) });
    expect(engine.countedOf(m, "est")?.mbh).toBe(0);
    expect(engine.countedOf(m, "d1")?.mbh).toBe(80);
    expect(sum(engine, m, ["est", "d1", "d2"])).toEqual(summed(engine.counted(m)));
    expect(engine.valueOf(m, "est")?.mbh).toBe(100);
  });
});

describe("rows a pipe end can take (D-3)", () => {
  it("a cold water pipe is offered the rows with cold water fixture units, in mark order, never one already piped", () => {
    const m = pipeFive(cafe());
    const rows = loadsForRunEnd(m.elements, "domestic_cold_water").map((r) => r.mark);
    expect(rows).not.toContain("WC-1");
    expect(rows).not.toContain("FD-1");
    expect(rows).toContain("P434A-1");
    expect(rows.length).toBe(CAFE_TOTALS.fixtures - 5 - 16);
    expect(loadsForRunEnd(m.elements, "natural_gas").map((r) => r.mark)).toEqual(["GWH", "OV-1", "RTU-1", "RTU-2", "RTU-3"]);
    expect(loadsForRunEnd(m.elements, "sanitary").map((r) => r.mark)).toContain("FD-1");
  });
});
