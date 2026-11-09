/**
 * @jest-environment node
 *
 * Article 430 motor tables and motor branch circuits, parallel conductor
 * sets (310.10(G), 250.122(F)), and feeder types proposed from a load. Each
 * expectation is a hand calculation written out beside it.
 */
import { builtinCalcRegistry, necEdition, PERMITZIP_DESIGN_CRITERIA, type CalcRun, type CalcValue } from "@permitzip/bim-calc";
import { motorFullLoad, necElectricalRules, proposeFeederType } from "@permitzip/bim-pack-electrical";

const registry = builtinCalcRegistry();
const nec = necEdition("2023");

function run(calc: string, inputs: Record<string, unknown>): CalcRun {
  const r = registry.run({ calc, inputs, necEdition: "2023" });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}
const value = (r: CalcRun, key: string): CalcValue => {
  const v = r.values.find((x) => x.key === key);
  if (!v) throw new Error(`no ${key} in ${r.values.map((x) => x.key).join(", ")}`);
  return v;
};

describe("motor full-load current (Tables 430.248 / 430.250, read per 430.6(A)(1))", () => {
  it("reads the three-phase table: 10 hp at 460 V is 14 A; a 480 V nameplate reads the 460 V column", () => {
    expect(motorFullLoad(nec, 10, 460, 3)?.amps).toBe(14);
    const at480 = motorFullLoad(nec, 10, 480, 3);
    expect(at480?.amps).toBe(14);
    expect(at480?.columnV).toBe(460);
    expect(at480?.cite.map((c) => c.clause)).toEqual(["Table 430.250", "430.6(A)(1)"]);
  });

  it("reads the single-phase table: 1 hp at 115 V is 16 A, 5 hp at 230 V is 28 A", () => {
    expect(motorFullLoad(nec, 1, 115, 1)?.amps).toBe(16);
    expect(motorFullLoad(nec, 5, 230, 1)?.amps).toBe(28);
    expect(motorFullLoad(nec, 1.5, 208, 1)?.amps).toBe(11);
  });

  it("refuses what the tables don't list (12 hp, 208 V 250 hp, 380 V)", () => {
    expect(motorFullLoad(nec, 12, 460, 3)).toBeNull();
    expect(motorFullLoad(nec, 250, 208, 3)).toBeNull();
    expect(motorFullLoad(nec, 10, 380, 3)).toBeNull();
  });

  it("feeds the aggregation rules: a 10 hp 460 V motor counts 14 A x 460 V x √3 = 11,154 VA", () => {
    const m = necElectricalRules("2023").motorLoad?.(10, 460, 3);
    expect(m?.va).toBeCloseTo(14 * 460 * Math.sqrt(3), 6);
    expect(m?.cite).toEqual(expect.arrayContaining([expect.stringMatching(/Table 430\.250/)]));
  });
});

describe("motor branch circuit: 10 hp, 460 V, 3-phase, inverse-time breaker", () => {
  const r = run("nec.motor_circuit", { hp: 10, voltage_v: 460, phases: 3, device: "inverse_time_breaker" });

  it("conductors at 125% of 14 A = 17.5 A (430.22); the breaker may be 250% = 35 A (Table 430.52)", () => {
    expect(value(r, "flc_a").value).toBe(14);
    expect(value(r, "conductor_a").value).toBe(17.5);
    expect(value(r, "max_device_a").value).toBe(35);
    expect(value(r, "ocpd_a").value).toBe(35);
  });

  it("#12 Cu carries 17.5 A at 60°C (20 A) and the 35 A breaker is allowed on it by 240.4(G), not refused by 240.4(D)", () => {
    expect(value(r, "conductor").value).toBe("#12");
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.citations.map((c) => c.clause)).toEqual(expect.arrayContaining(["430.22", "Table 430.52", "240.4(G)", "Table 430.250"]));
  });
});

describe("parallel sets", () => {
  it("2 sets for 480 A continuous at 480 V: 600 A needed, 350 kcmil at 75°C is 310 A x 2 = 620 A; a #1 EGC in each raceway (250.122(F))", () => {
    const r = run("nec.size_circuit", { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 480, parallel_sets: 2 });
    expect(value(r, "ocpd_a").value).toBe(600);
    expect(value(r, "parallel_sets").value).toBe(2);
    expect(value(r, "conductor").value).toBe("350 kcmil");
    expect(value(r, "egc").value).toBe("#1");
    expect(value(r, "description").value).toMatch(/^\(2\) sets of 3-350 kcmil, 1-350 kcmil N, 1-#1 EGC Cu THHN in .* EMT each; 600 A 3P$/);
    expect(r.citations.map((c) => c.clause)).toEqual(expect.arrayContaining(["310.10(G)", "250.122(F)"]));
  });

  it("chooses sets itself when no single conductor will do, keeping each at 600 kcmil or less: 1,600 A continuous → 2,000 A → 5 sets of 600 kcmil (420 A x 5 = 2,100 A)", () => {
    const r = run("nec.size_circuit", { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 1600 });
    expect(value(r, "ocpd_a").value).toBe(2000);
    expect(value(r, "parallel_sets").value).toBe(5);
    expect(value(r, "conductor").value).toBe("600 kcmil");
    expect(r.citations.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringMatching(/design preference, not a code requirement/)]));
  });

  it("a single-set feeder is unchanged: 100 A continuous at 480 V → 125 A, #1 Cu", () => {
    const r = run("nec.size_circuit", { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100 });
    expect(r.values.find((v) => v.key === "parallel_sets")).toBeUndefined();
    expect(value(r, "ocpd_a").value).toBe(125);
  });
});

describe("feeder types proposed from a load", () => {
  it("H1's feeder: 180 A continuous at 277/480 V → F225 with 4 conductors, an EGC and conduit, citing what it used", () => {
    const s = proposeFeederType(nec, PERMITZIP_DESIGN_CRITERIA, { system: { lineToLine: 480, lineToNeutral: 277, phases: 3, wires: 4 }, continuousA: 180, noncontinuousA: 0 });
    expect(s.refusal).toBeNull();
    expect(s.entry?.mark).toBe("F225");
    expect(s.entry?.ratingA).toBe(225);
    expect(s.entry?.poles).toBe(3);
    expect(s.entry?.conductors).toEqual({ sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" });
    expect(s.entry?.conduit?.type).toBe("emt");
    expect(s.entry?.basis?.cite).toEqual(expect.arrayContaining([expect.stringMatching(/215\.2\(A\)\(1\)/)]));
  });

  it("a transformer primary (480 V 3-wire, no neutral) is marked with T: 75 kVA at 480 V is 90.2 A → F100T... unless the engineer keeps 110 A", () => {
    const fla = 75000 / (Math.sqrt(3) * 480);
    const s = proposeFeederType(nec, PERMITZIP_DESIGN_CRITERIA, { system: { lineToLine: 480, lineToNeutral: null, phases: 3, wires: 3 }, continuousA: 0, noncontinuousA: fla });
    expect(s.entry?.mark).toBe("F100T");
    expect(s.entry?.conductors.neutralSize).toBeUndefined();
    const kept = proposeFeederType(nec, PERMITZIP_DESIGN_CRITERIA, { system: { lineToLine: 480, lineToNeutral: null, phases: 3, wires: 3 }, continuousA: 0, noncontinuousA: fla, ratingA: 110 });
    expect(kept.entry?.mark).toBe("F110T");
  });

  it("refuses in plain words when the breaker kept is too small for the load", () => {
    const s = proposeFeederType(nec, PERMITZIP_DESIGN_CRITERIA, { system: { lineToLine: 208, lineToNeutral: 120, phases: 3, wires: 4 }, continuousA: 200, noncontinuousA: 0, ratingA: 100 });
    expect(s.entry).toBeNull();
    expect(s.refusal).toMatch(/smaller than the 250 A this load needs/);
  });
});
