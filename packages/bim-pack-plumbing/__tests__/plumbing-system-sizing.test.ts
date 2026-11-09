/**
 * @jest-environment node
 *
 * Water and sanitary sizing on the drawn 7492 (Sample Market)
 * model, and auto-sizing on edit. Before this, only gas sized: the project's
 * "auto" setting was stored and never applied, and water and drain pipe had
 * no sizing at all (no `plumbing.size_system`, nothing for auto to apply).
 *
 * Golden numbers: the issued P1 sheet: 43.25 WSFU on ASHRAE Curve A
 * reads 48 gpm at the service; the pressure report leaves 50 − 4.5 − 0.28 −
 * 9.8 (fixed) − 25 (critical fixture) − static = the pressure for friction;
 * the sanitary main runs 20 → 26 → 59 → 88 DFU to the outfall.
 */
import { DEFAULT_SETTINGS, executeCommand, planCommit, type Command, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { hunterStyleGpm } from "../src";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { hunterChart, isAutoSizeExempt, planAutoSize, plumbingAdoptionFrom, systemsTouched, type PipeSystemSizing } from "../src";

const registry = builtinCalcRegistry();

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `k-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-24T12:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function sampleMarketModel(sizingMode: "check" | "auto" = "check"): ModelState {
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  m = commit(m, sampleMarketLoadPointCommand(build.points));
  m = commit(m, { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode, buildingType: "restaurant" } });
  // The sheet's pressure report: 50 psi design minimum; meter 4.5 + tap 0.28 + RPZ 9.8 fixed; 25 psi at the critical fixture.
  m = commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { supplyPressurePsi: 50, fixedLossesPsi: 14.58, minFixturePressurePsi: 25 } } });
  return m;
}

function size(model: ModelState, systemId: string): PipeSystemSizing {
  const r = registry.run({ calc: "plumbing.size_system", inputs: { system_id: systemId }, model, state: "VA" });
  if (!r.ok) throw new Error(r.reason);
  return r.run.detail as PipeSystemSizing;
}
const proposed = (s: PipeSystemSizing, id: string) => s.proposals.find((p) => p.segmentId === id)?.proposed;
const nominal = (m: ModelState, id: string) => {
  const el = m.elements[id] as RunSegment;
  return el.size.shape === "pipe" ? Math.round((el.size.nominalMm / 25.4) * 1000) / 1000 : null;
};

describe("domestic water sizing (plumbing.size_system)", () => {
  const model = sampleMarketModel();
  const cw = size(model, "sys-cw");

  it("reads the restaurant's 43.25 WSFU on ASHRAE Curve A as the sheet's 48 gpm, not the old fit's 23.4", () => {
    expect(cw.curve?.id).toBe("ashrae_a");
    expect(cw.designPoint).toEqual({ wsfu: 43.25, gpm: 48 });
    expect(Math.round(hunterStyleGpm(43.25) * 10) / 10).toBe(23.4);
  });

  it("allows friction from the pressure left after fixed losses, static head and the critical fixture, over the developed length", () => {
    // 50 − 14.58 − 25 − static (9 ft pipe above the service end, which is level with it: 0) = 10.42 psi.
    expect(cw.availablePsi).toBe(10.42);
    expect(cw.developedLengthFt).toBeGreaterThan(90);
    expect(cw.allowablePsiPer100Ft).toBeCloseTo((10.42 / (cw.developedLengthFt! * 1.3)) * 100, 2);
  });

  it("keeps the 2\" service at 48 gpm, raises the water closet branches to 3/4\", and holds every fixture supply at 1/2\" or more", () => {
    expect(proposed(cw, "cw-s1")).toBe("2");
    expect(["cw-P01-1-s1", "cw-P01-2-s1", "cw-P01A-1-s1", "cw-P01A-2-s1"].map((id) => proposed(cw, id))).toEqual(["3/4", "3/4", "3/4", "3/4"]);
    expect(proposed(cw, "cw-K02-1-s1")).toBe("1/2");
    expect(cw.proposals.find((p) => p.segmentId === "cw-K02-1-s1")?.governs).toMatch(/604\.5/);
    expect(cw.proposals.every((p) => p.proposedIn >= 0.5)).toBe(true);
    expect(cw.findings.filter((f) => f.code === "undersized_pipe").map((f) => f.elementId)).toEqual(expect.arrayContaining(["cw-P01-1-s1", "cw-P01A-2-s1"]));
    expect(cw.sizingMode).toBe("check");
  });

  it("caps a branch at what its fixtures can draw: a hand sink's branch carries 2 gpm, not Curve A's 22", () => {
    const sink = cw.proposals.find((p) => p.segmentId === "cw-K01-1-s1");
    expect(sink?.carries).toMatch(/^1\.5 WSFU, 2 gpm \(all its fixtures at once\)$/);
  });

  it("sizes hot water on velocity alone, and says so, when the system has no supply pressure", () => {
    const hw = size(model, "sys-hw");
    expect(hw.maxVelocityFps).toBe(5);
    expect(hw.allowablePsiPer100Ft).toBeNull();
    expect(hw.findings.find((f) => f.code === "no_supply_pressure")?.elementId).toBe("sys-hw");
    expect(proposed(hw, "hw-s2")).toBe("1-1/2");
  });

  it("refuses to size without a demand curve rather than falling back to the old fit", () => {
    const m = commit(model, { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode: "check" } });
    const s = size(m, "sys-cw");
    expect(s.proposals).toEqual([]);
    expect(s.findings[0]).toMatchObject({ code: "no_demand_curve", severity: "error" });
  });
});

/** The sanitary system's minimum slopes set from VPC Table 704.1 (2-1/2" and under 1/4", 3"–6" 1/8"), as the engineer enters them. */
const CODE_SLOPES = [
  { maxNominalIn: 2.5, inPerFt: 0.25 },
  { maxNominalIn: 6, inPerFt: 0.125 },
  { maxNominalIn: 1000, inPerFt: 0.0625 },
];
const withCodeSlopes = (m: ModelState) => commit(m, { type: "set_system_design", systemId: "sys-san", design: { pipe: { slopes: CODE_SLOPES } } });

describe("sanitary sizing (plumbing.size_system)", () => {
  const san = size(withCodeSlopes(sampleMarketModel()), "sys-san");

  it("with the model's built-in slopes (3\" at 1/4\") the 1/8\" main stays 4\", and says the system's rule is stricter than the code", () => {
    const built = size(sampleMarketModel(), "sys-san");
    expect(["san-s1", "san-s2", "san-s3", "san-s4"].map((id) => proposed(built, id))).toEqual(["4", "4", "4", "4"]);
    expect(built.findings.find((f) => f.code === "system_slope_rule")?.message).toMatch(/Table 704\.1/);
  });

  it("sizes the building drain at its 1/8\" fall by Table 710.1(1): 20 and 26 DFU 3\", 59 and 88 DFU 4\"", () => {
    expect(["san-s1", "san-s2", "san-s3", "san-s4"].map((id) => san.proposals.find((p) => p.segmentId === id)?.carries)).toEqual(["20 DFU at 0.125 in/ft", "26 DFU at 0.125 in/ft", "59 DFU at 0.125 in/ft", "88 DFU at 0.125 in/ft"]);
    expect(["san-s1", "san-s2", "san-s3", "san-s4"].map((id) => proposed(san, id))).toEqual(["3", "3", "4", "4"]);
    expect(san.proposals.find((p) => p.segmentId === "san-s4")?.role).toBe("building_drain");
    expect(san.totalLoad).toBe(88);
  });

  it("gives a water closet's branch 3\" and a hand sink's 1-1/2\" (Table 710.1(2))", () => {
    expect(proposed(san, "san-P01-1-s1")).toBe("3");
    expect(san.proposals.find((p) => p.segmentId === "san-P01-1-s1")?.governs).toMatch(/water closet/);
    expect(proposed(san, "san-K01-1-s1")).toBe("1-1/2");
    expect(san.findings.find((f) => f.elementId === "san-K01-1-s1")?.code).toBe("oversized_pipe");
  });

  it("never sizes a drain smaller than a pipe draining into it (704.2)", () => {
    const into = san.proposals.find((p) => p.segmentId === "san-s3")?.proposedIn ?? 0;
    expect(into).toBeGreaterThanOrEqual(3);
    for (const leg of ["san-s1", "san-s2", "san-s3"]) {
      const i = ["san-s1", "san-s2", "san-s3", "san-s4"].indexOf(leg);
      const down = san.proposals.find((p) => p.segmentId === `san-s${i + 2}`)?.proposedIn ?? 0;
      expect(down).toBeGreaterThanOrEqual(san.proposals.find((p) => p.segmentId === leg)?.proposedIn ?? 0);
    }
  });
});

describe("auto-sizing on edit", () => {
  it("does nothing while the project checks (the default)", () => {
    expect(planAutoSize(registry, sampleMarketModel("check"), { state: "VA" }, { idPrefix: "auto" }).edits).toEqual([]);
  });

  it("with auto on, returns one set_pipe_sizes per system that needs one (hot water is already right); applied, the next plan is empty", () => {
    let m = withCodeSlopes(sampleMarketModel("auto"));
    const plan = planAutoSize(registry, m, { state: "VA" }, { idPrefix: "auto" });
    expect(plan.edits.map((e) => e.systemId).sort()).toEqual(["sys-cw", "sys-san"]);
    expect(size(m, "sys-hw").proposals.every((p) => p.change === "same")).toBe(true);
    expect(plan.edits.every((e) => e.command.type === "set_pipe_sizes")).toBe(true);
    for (const e of plan.edits) {
      const run = executeCommand(m, e.command);
      if (!run.ok) throw new Error(`${e.systemId}: ${run.error.message}`);
      m = commit(m, e.command);
    }
    expect(nominal(m, "cw-P01-1-s1")).toBe(0.75);
    expect(nominal(m, "san-P01-1-s1")).toBe(3);
    expect(nominal(m, "san-s1")).toBe(3);
    expect(planAutoSize(registry, m, { state: "VA" }, { idPrefix: "auto" }).edits).toEqual([]);
  });

  it("a system set to check keeps its sizes when the project is on auto", () => {
    const m = commit(sampleMarketModel("auto"), { type: "set_system_design", systemId: "sys-san", design: { pipe: { sizingMode: "check" } } });
    expect(planAutoSize(registry, m, { state: "VA" }, { idPrefix: "auto" }).edits.map((e) => e.systemId)).toEqual(["sys-cw"]);
  });

  it("a system set to auto sizes when the project checks; limited to the systems an edit touched", () => {
    const m = commit(sampleMarketModel("check"), { type: "set_system_design", systemId: "sys-san", design: { pipe: { sizingMode: "auto" } } });
    expect(planAutoSize(registry, m, { state: "VA" }, { idPrefix: "auto" }).edits.map((e) => e.systemId)).toEqual(["sys-san"]);
    expect(planAutoSize(registry, m, { state: "VA" }, { idPrefix: "auto", systemIds: ["sys-cw"] }).edits).toEqual([]);
  });

  it("without a plumbing code it sizes nothing and says why", () => {
    const plan = planAutoSize(registry, sampleMarketModel("auto"), {}, { idPrefix: "auto" });
    expect(plan.edits).toEqual([]);
    expect(plan.skipped.map((s) => s.systemId).sort()).toEqual(["sys-cw", "sys-hw", "sys-san"]);
    expect(plan.skipped[0]?.reason).toMatch(/plumbing code/);
    expect(plan.skipped.map((s) => s.cause)).toEqual(["no_code_edition", "no_code_edition", "no_code_edition"]);
  });

  it("knows which edits it follows and which systems they touched", () => {
    expect(isAutoSizeExempt("set_pipe_sizes")).toBe(true);
    expect(isAutoSizeExempt("undo")).toBe(true);
    expect(isAutoSizeExempt("route_run")).toBe(false);
    const m = sampleMarketModel();
    expect(systemsTouched(m, m, ["san-s1", "cw-s1"])).toEqual(["sys-san", "sys-cw"]);
    expect(systemsTouched(m, m, [Object.keys(m.elements).find((k) => m.elements[k]?.kind === "load_point") ?? ""])).toBeUndefined();
  });

  it("reads the plumbing code from Code Study rows by name", () => {
    expect(plumbingAdoptionFrom([{ code_name: "Virginia Fuel Gas Code", edition: "2021", status: "confirmed" }, { code_name: "Virginia Plumbing Code (VPC)", edition: "2021", status: "unconfirmed" }])).toEqual({ codeName: "Virginia Plumbing Code (VPC)", edition: "2021", status: "unconfirmed" });
  });
});

describe("Hunter curve chart", () => {
  it("draws the four ASHRAE curves with each water system's design point on its curve", () => {
    const chart = hunterChart(sampleMarketModel());
    expect(chart.curves.map((c) => c.id)).toEqual(["ashrae_a", "ashrae_b", "ashrae_c", "ashrae_d"]);
    expect(chart.curves.find((c) => c.id === "ashrae_a")?.used).toBe(true);
    expect(chart.points).toEqual([
      { systemId: "sys-cw", systemName: "Domestic Cold Water", curveId: "ashrae_a", wsfu: 43.25, gpm: 48 },
      { systemId: "sys-hw", systemName: "Domestic Hot Water", curveId: "ashrae_a", wsfu: 15.75, gpm: 30.9 },
    ]);
    expect(chart.missing).toEqual([]);
  });
});
