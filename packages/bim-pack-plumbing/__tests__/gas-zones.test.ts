/**
 * @jest-environment node
 *
 * Gas pressure zones on the issued 7492 (Sample Market) propane
 * system: the 2 psi zone from the secondary regulator, the kitchen line
 * regulator's 11 in. w.c. zone, the DOAS and water heater appliance
 * regulators; each zone's segment tree (what the fuel gas code's sizing
 * methods take), totals, the table-free checks (no regulator between a
 * 2 psi zone and an appliance, a regulator set above its inlet, a
 * regulator over its capacity, an appliance minimum the zone can't hold),
 * the pressure reset in the gas report, and set_pipe_sizes as one edit.
 * Before this, a regulator didn't exist, the whole system was one pressure,
 * and a gas-fired rooftop unit was taken for the meter.
 */
import { DEFAULT_SETTINGS, builtinFormTemplate, diagramNodes, evaluateFormSchedule, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { gasNetwork, plumbingDiagramGraph, PipeHydraulicsEngine } from "../src";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM, SAMPLE_MARKET_GAS_TOTAL_MBH } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";

const IN = 25.4;
let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `gas-${++n}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}
function refusal(model: ModelState, command: Command): string {
  const d = planCommit(model, [], { idempotencyKey: `gas-${++n}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
  if (d.ok) throw new Error(`${command.type} was expected to be refused`);
  return d.error.message;
}
function network(m: ModelState) {
  const net = gasNetwork(m, SAMPLE_MARKET_GAS_SYSTEM);
  if (!net) throw new Error("no gas network");
  return net;
}
const nominal = (m: ModelState, id: string): number => {
  const el = m.elements[id];
  if (el?.kind !== "run_segment" || el.size.shape !== "pipe") throw new Error(`${id} isn't a pipe`);
  return Math.round((el.size.nominalMm / IN) * 1000) / 1000;
};

/** The sizes on the issued sheet: 1-1/4" manifold, 1" to the range, 3/4" to the fryers and grill; the jog with LR-1 at the manifold size. */
const SHEET_SIZES = [
  { segmentId: "main-s2", nominalIn: 1.25 },
  { segmentId: "main-s3", nominalIn: 1.25 },
  { segmentId: "k08-b-s1", nominalIn: 1 },
  { segmentId: "k08-b-s2", nominalIn: 1 },
];

describe("gas pressure zones (7492 Sample Market)", () => {
  const m = buildSampleMarketGas();
  const net = network(m);

  it("splits the system at its regulators: a 2 psi zone, the 11 in. w.c. cook line, the DOAS and heater regulators", () => {
    expect(net.gas).toBe("propane");
    expect(net.specificGravity).toBe(1.5);
    expect(net.heatingValueBtuPerCf).toBe(2516);
    expect(net.sourceLabel).toBe("GS-1");
    expect(net.zones.map((z) => [z.id, z.inletInWc, z.allowableDropInWc, z.highPressure])).toEqual([
      ["zone-source", 55.4, 27.7, true],
      ["zone-AR-DOAS", 11, 0.5, false],
      ["zone-AR-GWH", 11, 0.5, false],
      ["zone-LR-1", 11, 0.5, false],
    ]);
    expect(net.zones.map((z) => z.label)).toEqual(["From GS-1, 2 psi", "Appliance regulator AR-DOAS, 11 in. w.c.", "Appliance regulator AR-GWH, 11 in. w.c.", "Line regulator LR-1, 11 in. w.c."]);
    expect(net.issues).toEqual([]);
  });

  it("totals the gas equipment: 1,024.407 MBH at the service, 550 MBH on the cook line, each appliance on its own zone", () => {
    expect(net.totalMbh).toBeCloseTo(SAMPLE_MARKET_GAS_TOTAL_MBH, 6);
    const byId = Object.fromEntries(net.zones.map((z) => [z.id, z.totalMbh]));
    expect(byId).toEqual({ "zone-source": 1024.407, "zone-AR-DOAS": 224.407, "zone-AR-GWH": 250, "zone-LR-1": 550 });
    expect(net.appliances.map((a) => [a.mark, a.mbh, a.regulatorId, a.pathFt])).toEqual([
      ["DOAS-1", 224.407, "AR-DOAS", 15],
      ["GWH", 250, "AR-GWH", 15],
      ["K07", 90, "LR-1", 68],
      ["K08", 220, "LR-1", 78],
      ["K09", 120, "LR-1", 87],
      ["K09", 120, "LR-1", 97],
    ]);
    // The DOAS burns gas: it is an appliance, not the source, though it is mechanical equipment.
    expect(net.sourceId).toBe("svc");
  });

  it("gives each zone the segment tree the fuel gas code sizes: the cook line's longest run is 97 ft from LR-1, the 2 psi zone sees each regulator as a load", () => {
    const kitchen = net.zones.find((z) => z.id === "zone-LR-1");
    expect(kitchen?.longestFt).toBe(97);
    expect(kitchen?.segments.filter((s) => s.parent === null).map((s) => s.id)).toEqual(["main-s2@1"]);
    expect(kitchen?.segments.map((s) => [s.id, s.parent, s.lengthFt, s.loadMbh])).toEqual([
      ["main-s2@1", null, 1, 0],
      ["main-s3@0", "main-s2@1", 5, 0],
      ["main-s3@1", "main-s3@0", 3, 0],
      ["main-s3@2", "main-s3@1", 3, 0],
      ["main-s3@3", "main-s3@2", 5, 0],
      ["k07-b-s2", "main-s3@0", 57, 0],
      ["k08-b-s2", "main-s3@1", 64, 0],
      ["k09b-b-s2", "main-s3@2", 70, 0],
      ["main-s4", "main-s3@3", 75, 0],
      ["k07-b-s1", "k07-b-s2", 5, 90],
      ["k08-b-s1", "k08-b-s2", 5, 220],
      ["k09b-b-s1", "k09b-b-s2", 5, 120],
      ["main-s5", "main-s4", 5, 120],
    ]);
    const source = net.zones.find((z) => z.id === "zone-source");
    expect(source?.longestFt).toBe(51);
    expect(source?.segments.filter((s) => s.loadMbh > 0).map((s) => [s.id, s.loadMbh])).toEqual([
      ["doas-b-s2@0", 224.407],
      ["gwh-b-s2@0", 250],
      ["main-s2@0", 550],
    ]);
    expect(net.regulators.map((r) => [r.elementId, r.role, r.upstreamZoneId, r.loadMbh])).toEqual([
      ["AR-DOAS", "appliance", "zone-source", 224.407],
      ["AR-GWH", "appliance", "zone-source", 250],
      ["LR-1", "line", "zone-source", 550],
    ]);
  });

  it("an appliance on the 2 psi zone with no regulator ahead of it is a finding; adding the regulator clears it", () => {
    const bare = network(buildSampleMarketGas({ withoutHeaterRegulator: true }));
    expect(bare.issues).toEqual([
      { code: "regulator_missing", severity: "error", elementId: "gwh", zoneId: "zone-source", message: "GWH is on the 2 psi zone (From GS-1, 2 psi) but takes at most 14 in. w.c.; put a line or appliance regulator between them" },
    ]);
    expect(bare.appliances.find((a) => a.elementId === "gwh")?.regulatorId).toBeNull();
  });

  it("a regulator set above its inlet, one over its rated capacity, and an appliance minimum the zone can't hold are findings", () => {
    const base = buildSampleMarketGas({ withoutHeaterRegulator: true });
    const high = commit(base, { type: "place_run_accessory", accessoryId: "AR-GWH", segmentId: "gwh-b-s2", atMm: 10 * 304.8, family: "pipe.gas.regulator", params: { role: "appliance", outlet_in_wc: 70, zone_drop_in_wc: 0.5 } });
    expect(network(high).issues.map((i) => i.code)).toEqual(["regulator_raises_pressure", "regulator_missing"]);
    const small = commit(base, { type: "place_run_accessory", accessoryId: "AR-GWH", segmentId: "gwh-b-s2", atMm: 10 * 304.8, family: "pipe.gas.regulator", params: { role: "appliance", outlet_in_wc: 11, zone_drop_in_wc: 0.5, capacity_mbh: 200 } });
    expect(network(small).issues).toEqual([{ code: "regulator_over_capacity", severity: "error", elementId: "AR-GWH", zoneId: "zone-AR-GWH", message: "Appliance regulator AR-GWH serves 250 MBH, more than its rated 200 MBH; pick a larger regulator" }]);
    // A range that needs 10.8 in. w.c. on a zone that starts at 11 and may lose 0.5.
    const fussy = network(buildSampleMarketGas({ rangeMinInletInWc: 10.8 }));
    expect(fussy.issues).toEqual([
      { code: "zone_below_appliance_minimum", severity: "error", elementId: "k08", zoneId: "zone-LR-1", message: "K08 needs 10.8 in. w.c. at its inlet, but Line regulator LR-1, 11 in. w.c. may fall to 10.5 in. w.c. (it allows 0.5 in. w.c. of drop); raise the zone's pressure or allow less drop" },
    ]);
  });

  it("the gas report resets the pressure at each regulator and checks each zone against its own drop", () => {
    const report = new PipeHydraulicsEngine().report(m, SAMPLE_MARKET_GAS_SYSTEM);
    if (report?.kind !== "gas") throw new Error(`expected gas, got ${report?.kind}`);
    expect(report.zones?.map((z) => z.id)).toEqual(["zone-source", "zone-AR-DOAS", "zone-AR-GWH", "zone-LR-1"]);
    expect(report.specificGravity).toBe(1.5);
    expect(report.totalMbh).toBeCloseTo(1024.41, 2);
    const k08 = report.ends.find((e) => e.elementId === "k08");
    // Counted from LR-1's 11 in. w.c., not the 2 psi (55.4 in. w.c.) at the service.
    expect(k08?.pressure).toBeLessThan(11);
    expect(report.basis.some((b) => /4 pressure zones/.test(b))).toBe(true);
    expect(report.basis.some((b) => /From GS-1, 2 psi is at 1-1\/2 psi or more/.test(b))).toBe(true);
    // Everything drawn 3/4": the cook line header can't carry 550 MBH within 0.5 in.
    expect(report.zones?.find((z) => z.id === "zone-LR-1")?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it("the gas equipment schedule prints the issued sheet's rows from the model: ID, quantity, input, total, regulator, and 1,024,407 Btu/h", () => {
    const form = evaluateFormSchedule(m, { kind: "gas_equipment", template: builtinFormTemplate("gas_equipment") });
    expect(form.title).toBe("GAS EQUIPMENT SCHEDULE");
    expect(form.grid.headings).toEqual(["ID", "QTY", "DESCRIPTION", "INPUT (BTU/H)", "TOTAL INPUT (BTU/H)", "PRESSURE REGULATOR", "VENT"]);
    expect(form.grid.rows).toEqual([
      ["DOAS-1", "1", "Dedicated outdoor air unit, DOAS-1", "224,407", "224,407", "Appliance regulator AR-DOAS, 11 in. w.c.", "vent limiter"],
      ["GWH", "1", "Water heater, gas, 100 gal, 250 MBH", "250,000", "250,000", "Appliance regulator AR-GWH, 11 in. w.c.", "vent limiter"],
      ["K07", "1", "Gas flat top grill, 36 in.", "90,000", "90,000", "Line regulator LR-1, 11 in. w.c.", "vent limiter"],
      ["K08", "1", "Gas range, 36 in.", "220,000", "220,000", "Line regulator LR-1, 11 in. w.c.", "vent limiter"],
      ["K09", "2", "Gas fryer, 18 in.", "120,000", "240,000", "Line regulator LR-1, 11 in. w.c.", "vent limiter"],
    ]);
    expect(form.totals).toEqual([{ label: "TOTAL GAS INPUT", value: "1,024,407 BTU/H" }]);
    expect(form.grid.rowIds[4]).toEqual(["k09b", "k09a"]);
  });

  it("the gas riser follows the piping: the source with its pressure and total, each regulator with its pressure and load, the appliances past it", () => {
    const graph = plumbingDiagramGraph(m.elements, { systemKinds: ["natural_gas"] });
    const root = graph.roots[0];
    expect(root?.lines.map((l) => l.text)).toEqual(["GS-1", "PROPANE", "PROPANE, 2 PSI, 1,024.41 MBH TOTAL"]);
    const order = (n: NonNullable<typeof root>): string[] => [...(n.role === "device" || n.role === "terminal" ? [n.name] : []), ...n.children.flatMap(order)];
    expect(root && order(root)).toEqual(["Appliance regulator AR-DOAS", "DOAS-1", "Appliance regulator AR-GWH", "GWH", "Line regulator LR-1", "K07", "K08", "K09", "K09"]);
    const lr = diagramNodes(graph).find((n) => n.id === "LR-1");
    expect(lr?.lines.map((l) => l.text)).toEqual(["LINE REGULATOR LR-1", "11 IN. W.C., 550 MBH"]);
    expect(diagramNodes(graph).find((n) => n.id === "k07")?.lines.map((l) => l.text)).toEqual(["K07", "90 MBH"]);
    expect(diagramNodes(graph).find((n) => n.id === "k08")?.feed?.label).toBe('¾"');
    expect(graph.reads).toEqual(expect.arrayContaining(["LR-1", "main-s3", "k08"]));
  });

  it("set_pipe_sizes resizes several pipes as one edit, with reducers where sizes change, and the cook line then passes", () => {
    const sized = commit(m, { type: "set_pipe_sizes", idPrefix: "size-1", systemId: SAMPLE_MARKET_GAS_SYSTEM, sizes: SHEET_SIZES });
    expect(sized.revision).toBe(m.revision + 1);
    expect(["main-s2", "main-s3", "k08-b-s1", "k08-b-s2", "main-s4", "main-s1"].map((id) => nominal(sized, id))).toEqual([1.25, 1.25, 1, 1, 0.75, 0.75]);
    const reducers = Object.values(sized.elements).filter((e) => e.kind === "run_fitting" && e.fittingType === "transition" && e.systemId === SAMPLE_MARKET_GAS_SYSTEM);
    expect(reducers.length).toBeGreaterThanOrEqual(2);
    const report = new PipeHydraulicsEngine().report(sized, SAMPLE_MARKET_GAS_SYSTEM);
    if (report?.kind !== "gas") throw new Error("gas");
    expect(report.zones?.find((z) => z.id === "zone-LR-1")?.pass).toBe(true);
    expect(refusal(sized, { type: "set_pipe_sizes", idPrefix: "size-2", systemId: SAMPLE_MARKET_GAS_SYSTEM, sizes: SHEET_SIZES })).toBe("Every pipe listed on Propane is already that size");
    expect(refusal(m, { type: "set_pipe_sizes", idPrefix: "size-3", systemId: SAMPLE_MARKET_GAS_SYSTEM, sizes: [{ segmentId: "nope", nominalIn: 1 }] })).toBe("nope isn't a pipe");
  });
});

/**
 * Bug log #37 (reference building 7352, Rev 177–185): GAS-TEST-1 is one 20 ft 1" pipe
 * drawn from (270, 38) to (290, 38) ft with no meter drawn, a line regulator
 * to 7 in. w.c. placed 10 ft from its start, a ¾" branch teed off at 15 ft to
 * the water heater, and load point G-EXP-100 on the pipe's far end. The
 * agent reported both loads landing on the regulator's zone as a defect.
 * Gas enters at the start, so the regulator at 10 ft is upstream of the tee
 * (15 ft) and of the far end (20 ft): everything past it is on its zone. That
 * is the hydraulics, not a defect. A regulator on the branch leaves G-EXP-100
 * on the 2 psi zone. A load and a regulator at the same point: the load is on
 * the inlet zone (the regulator's outlet feeds only what is past it).
 */
describe("which zone a load on a regulated pipe is on (reference building 7352 GAS-TEST-1)", () => {
  const FT = 304.8;
  const SYS = "sys-gas-test";
  const at = (x: number, y: number) => ({ x: x * FT, y: y * FT });
  const LR = { family: "pipe.gas.regulator", params: { role: "line", outlet_in_wc: 7, zone_drop_in_wc: 0.5 } } as const;
  function base(): ModelState {
    let m: ModelState = { modelId: "gas-7352", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    for (const command of [
      { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
      { type: "route_run", idPrefix: "g", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "black_steel" }, elevationMm: 4 * FT, system: { id: SYS, kind: "natural_gas", name: "GAS-TEST-1" }, points: [at(270, 38), at(290, 38)] },
      { type: "set_system_design", systemId: SYS, design: { pipe: { gasType: "natural", inletPressureInWc: 55.4, allowableDropInWc: 1 } } },
    ] as Command[])
      m = commit(m, command);
    return m;
  }
  const branch = (m: ModelState) => commit(m, { type: "route_run", idPrefix: "b", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 0.75 * IN, material: "black_steel" }, elevationMm: 4 * FT, system: { id: SYS, kind: "natural_gas", name: "GAS-TEST-1" }, from: { kind: "run_branch", segmentId: "g-s1" }, points: [at(285, 38), at(285, 32)] });
  const loads = (m: ModelState) =>
    commit(m, {
      type: "create_load_point",
      points: [
        { hostId: "g-s1", port: "end", values: { mbh: 100 }, mark: "G-EXP-100" },
        { hostId: "b-s1", port: "end", values: { mbh: 199.9, min_inlet_pressure: 0.2527 }, mark: "WH-TEST" },
      ],
    });
  const zoneOf = (m: ModelState) => {
    const net = gasNetwork(m, SYS);
    if (!net) throw new Error("no gas network");
    return Object.fromEntries(net.appliances.map((a) => [a.mark, a.zoneId]));
  };

  it("as drawn on 7352 (regulator 10 ft along the main, tee at 15 ft, G-EXP-100 at 20 ft): both loads are past the regulator, on its 7 in. w.c. zone", () => {
    const m = loads(branch(commit(base(), { type: "place_run_accessory", accessoryId: "LR-1", segmentId: "g-s1", atMm: 10 * FT, ...LR })));
    expect(zoneOf(m)).toEqual({ "G-EXP-100": "zone-LR-1", "WH-TEST": "zone-LR-1" });
  });

  it("with the regulator on the branch to the water heater, G-EXP-100 stays on the 2 psi zone and the heater is on 7 in. w.c.", () => {
    const m = loads(commit(branch(base()), { type: "place_run_accessory", accessoryId: "LR-1", segmentId: "b-s1", atMm: 2 * FT, ...LR }));
    const net = gasNetwork(m, SYS);
    expect(zoneOf(m)).toEqual({ "G-EXP-100": "zone-source", "WH-TEST": "zone-LR-1" });
    expect(net?.zones.map((z) => [z.id, z.inletInWc, z.allowableDropInWc, z.totalMbh])).toEqual([
      ["zone-source", 55.4, 1, 299.9],
      ["zone-LR-1", 7, 0.5, 199.9],
    ]);
    // The heater needs 0.2527 psi = 7 in. w.c.; the zone starts at 7 and may lose 0.5: 6.5 < 7, a real finding.
    expect(net?.issues.map((i) => [i.code, i.elementId])).toEqual(expect.arrayContaining([["zone_below_appliance_minimum", "lp:b-s1:end"]]));
  });

  it("a branch and a regulator at the same point on a pipe: the branch is on the inlet zone, whichever the walk meets first", () => {
    // Commands keep a regulator clear of other fittings, so this only arises in a model whose positions came from elsewhere.
    const m = loads(branch(commit(base(), { type: "place_run_accessory", accessoryId: "LR-1", segmentId: "g-s1", atMm: 10 * FT, ...LR })));
    const tee = Object.values(m.elements).find((e) => e.kind === "run_fitting" && e.host?.segmentId === "g-s1" && e.id !== "LR-1");
    const reg = m.elements["LR-1"];
    if (tee?.kind !== "run_fitting" || !tee.host || reg?.kind !== "run_fitting" || !reg.host) throw new Error("expected the tee and LR-1 on g-s1");
    for (const first of [reg.id, tee.id]) {
      const g = m.elements["g-s1"];
      if (g?.kind !== "run_segment") throw new Error("g-s1");
      const branches = [first, ...g.branches.filter((id) => id !== first)];
      const same: ModelState = { ...m, elements: { ...m.elements, "LR-1": { ...reg, host: { ...reg.host, s: tee.host.s } }, "g-s1": { ...g, branches } } };
      expect(zoneOf(same)).toEqual({ "G-EXP-100": "zone-LR-1", "WH-TEST": "zone-source" });
    }
  });
});
