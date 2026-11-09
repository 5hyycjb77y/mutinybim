/**
 * @jest-environment node
 *
 * One connection type, read in per-trade sections (KERNEL-REQUIREMENTS-MODEL
 * §3.5): the fryer's record carries power, gas and drainage in the one shared
 * bag; it reads as Electrical, Gas and Drainage, each quantity with its
 * bim-units kind and unit. Old records read as the sections their values
 * fill, so an electrical-only record is listed under electrical alone, as
 * before. On the old code `connectionTypeSections` / `connectionTypeTrades`
 * do not exist.
 */
import { connectionTypeSections, connectionTypeTrades, loadSections, sectionOfQuantity, totalsOf } from "../src";
import { connectionTypeSchema } from "../src/catalog/types";

const ct = (input: Parameters<typeof connectionTypeSchema.parse>[0]) => connectionTypeSchema.parse(input);

describe("per-trade sections of the shared quantity bag", () => {
  it("the fryer: Electrical 120 V 1,800 VA, Gas 80 MBH with its inlet pressure, Drainage 1 DFU", () => {
    const fryer = ct({ type: "connection_type", designator: "K07", trade: "gas", description: "Fryer", loadVa: 1800, loadClass: "kitchen", quantities: { mbh: 80, min_inlet_pressure: 0.253, dfu: 1 } });
    const sections = connectionTypeSections(fryer);
    expect(sections.map((s) => [s.label, s.summary])).toEqual([
      ["Electrical", "120 V, 1 pole, 1,800 VA"],
      ["Gas", "80 MBH, min inlet 7 in. w.c. (0.253 psi)"],
      ["Drainage", "1 DFU"],
    ]);
    expect(sections[1]?.quantities.map((q) => [q.key, q.kind, q.unit])).toEqual([
      ["mbh", "flow_gas_energy", "MBH"],
      ["min_inlet_pressure", "pressure", "psi"],
    ]);
    expect(connectionTypeTrades(fryer)).toEqual(["gas", "electrical", "plumbing"]);
  });

  it("an electrical record from before trades reads as Electrical only, listed under electrical alone", () => {
    const rec = ct({ type: "connection_type", designator: "E.05", loadVa: 180 });
    expect(connectionTypeSections(rec).map((s) => s.section)).toEqual(["electrical"]);
    expect(connectionTypeTrades(rec)).toEqual(["electrical"]);
  });

  it("a lavatory: Water (cold, hot, total) and Drainage; its inlet pressure is water's when it burns no gas", () => {
    const lav = ct({ type: "connection_type", designator: "P01", trade: "plumbing", quantities: { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, dfu: 1, min_inlet_pressure: 25 } });
    expect(connectionTypeSections(lav).map((s) => [s.label, s.summary])).toEqual([
      ["Water", "1.5 WSFU cold, 1.5 WSFU hot, 2 WSFU total, min inlet 25 psi"],
      ["Drainage", "1 DFU"],
    ]);
    expect(connectionTypeTrades(lav)).toEqual(["plumbing"]);
    expect(sectionOfQuantity("min_inlet_pressure", totalsOf({ min_inlet_pressure: 25 }))).toBe("water");
    expect(sectionOfQuantity("min_inlet_pressure", totalsOf({ mbh: 80, min_inlet_pressure: 0.25 }))).toBe("gas");
  });

  it("a dishwasher saved under plumbing with a 120 V load also serves electrical", () => {
    const dish = ct({ type: "connection_type", designator: "K12", trade: "plumbing", loadVa: 1500, quantities: { wsfu_hot: 1.4, dfu: 2 } });
    expect(connectionTypeTrades(dish)).toEqual(["plumbing", "electrical"]);
  });

  it("loads with nothing in a section leave it out; an exhaust fan reads as Air", () => {
    expect(loadSections(totalsOf({}))).toEqual([]);
    expect(loadSections(totalsOf({ cfm: 3000 })).map((s) => [s.label, s.summary])).toEqual([["Air", "3,000 CFM"]]);
  });
});
