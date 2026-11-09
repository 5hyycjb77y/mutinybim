/**
 * @jest-environment node
 *
 * Circuit and feeder sizing against hand calculations written out here
 * (impedance from the Table 9 cells, voltage drop by 2IZL / √3IZL, the EGC by
 * circular-mil ratio), including the V2/V5 site-lighting case: a 20 A,
 * 300 ft, 277 V circuit upsized from #12 for voltage drop with the EGC grown
 * in proportion, and no "SEE SLD" note needed.
 */
import { builtinCalcRegistry, type CalcRun, type CalcValue } from "@permitzip/bim-calc";

const registry = builtinCalcRegistry();
const SIN_09 = Math.sqrt(1 - 0.9 * 0.9);

function run(inputs: Record<string, unknown>, necEdition: "2020" | "2023" = "2020"): CalcRun {
  const r = registry.run({ calc: "nec.size_circuit", inputs, necEdition });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}
const value = (r: CalcRun, key: string): CalcValue => {
  const v = r.values.find((x) => x.key === key);
  if (!v) throw new Error(`no ${key} in ${r.values.map((x) => x.key).join(", ")}`);
  return v;
};
const cites = (r: CalcRun) => r.citations.map((c) => c.text);

describe("277 V site lighting: 20 A, 300 ft, 16 A continuous (acceptance)", () => {
  const r = run({ circuit: "branch", system: "1ph_2w", voltage_v: 277, continuous_load_a: 16, length_ft: 300, ocpd_a: 20 });
  // Hand: Ze = R x 0.9 + XL(steel) x sin(arccos 0.9); Vd = 2 x 16 A x Ze x 0.3 kft.
  const vd = (r9: number, xl: number) => (2 * 16 * (r9 * 0.9 + xl * SIN_09) * 0.3) / 277 * 100;

  it("#12 has the ampacity: 16 A x 125% = 20 A, #12 at the 60°C terminations is 20 A, and 240.4(D) allows 20 A", () => {
    expect(value(r, "required_ampacity_a").value).toBe(20);
    expect(value(r, "ocpd_a").value).toBe(20);
    expect(value(r, "minimum_conductor").value).toBe("#12");
  });

  it("#12 drops 6.34% and #10 3.84%, so 3% needs #8 (2.53%); the 20 A breaker stays", () => {
    expect(vd(2.0, 0.068)).toBeCloseTo(6.341, 2);
    expect(vd(1.2, 0.063)).toBeCloseTo(3.838, 2);
    expect(vd(0.78, 0.065)).toBeCloseTo(2.531, 2);
    expect(value(r, "conductor").value).toBe("#8");
    expect(value(r, "voltage_drop_pct").value).toBeCloseTo(vd(0.78, 0.065), 2);
    expect(value(r, "ocpd_a").value).toBe(20);
  });

  it("the EGC grows with the phase conductors: #12 x (16,510 / 6,530 cmil) = 16,510 cmil → #8", () => {
    expect(value(r, "egc").value).toBe("#8");
    expect(value(r, "egc").cite.map((c) => c.clause)).toEqual(expect.arrayContaining(["Table 250.122", "250.122(B)"]));
  });

  it("cites every clause it used and says the 3% is a design target, not code", () => {
    expect(cites(r)).toEqual(
      expect.arrayContaining([
        "NEC 2020 210.19(A), 125% of the continuous load plus the noncontinuous load",
        "NEC 2020 Table 310.16, copper 90°C column",
        "NEC 2020 240.4(D), #12 copper: 20 A maximum",
        expect.stringMatching(/^NEC 2020 110\.14\(C\)\(1\)\(a\), circuit rated 100 A or less/),
        expect.stringMatching(/^NEC 2020 Chapter 9, Table 9, #8 copper, steel raceway/),
        expect.stringMatching(/^NEC 2020 250\.122\(B\), phase conductors #12 → #8/),
        expect.stringMatching(/3% branch voltage drop target \(a design target, not a code requirement\)$/),
      ]),
    );
    for (const v of r.values) expect(v.cite.length).toBeGreaterThan(0);
  });

  it("a 5% target stops at #10, with a #10 EGC", () => {
    const five = run({ circuit: "branch", system: "1ph_2w", voltage_v: 277, continuous_load_a: 16, length_ft: 300, ocpd_a: 20, max_voltage_drop_pct: 5 });
    expect(value(five, "conductor").value).toBe("#10");
    expect(value(five, "egc").value).toBe("#10");
  });

  it("describes the circuit as the panel schedule would, and flags the #8-on-a-20 A-terminal question", () => {
    expect(value(r, "description").value).toBe("1-#8, 1-#8 N, 1-#8 EGC Cu THHN in 1/2 in EMT; 20 A 1P");
    expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringMatching(/#8 is larger than many 20 A breaker and device terminals take/)]));
  });
});

describe("feeder: 100 A continuous, 250 ft, 480 V three-phase", () => {
  const r = run({ circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250 });

  it("125 A device, 75°C terminations above 100 A, #1 Cu (130 A; #2 is 115 A)", () => {
    expect(value(r, "required_ampacity_a").value).toBe(125);
    expect(value(r, "ocpd_a").value).toBe(125);
    expect(r.steps.find((s) => s.label === "Terminations")?.cite[0]?.clause).toBe("110.14(C)(1)(b)");
    expect(value(r, "conductor").value).toBe("#1");
    expect(value(r, "conductor_ampacity_a").value).toBe(130);
  });

  it("√3 x 100 A x (0.16 x 0.9 + 0.057 x 0.436) Ω/kft x 0.25 kft = 7.31 V = 1.52%: no upsizing", () => {
    const hand = (Math.sqrt(3) * 100 * (0.16 * 0.9 + 0.057 * SIN_09) * 0.25) / 480 * 100;
    expect(hand).toBeCloseTo(1.523, 2);
    expect(value(r, "voltage_drop_pct").value).toBeCloseTo(hand, 2);
  });

  it("#6 EGC (125 A falls in the 200 A row); 4 #1 + 1 #6 THHN = 0.6755 in² → 1-1/2 in EMT (1-1/4 holds 0.598)", () => {
    expect(value(r, "egc").value).toBe("#6");
    expect(4 * 0.1562 + 0.0507).toBeCloseTo(0.6755, 4);
    expect(value(r, "conduit").value).toBe("1-1/2 in EMT");
    expect(value(r, "conduit_fill_pct").value).toBeCloseTo((0.6755 / 2.036) * 100, 1);
  });

  it("without a neutral the same feeder fits 1-1/4 in EMT (3 #1 + #6 = 0.5193 in²)", () => {
    expect(value(run({ circuit: "feeder", system: "3ph_3w", voltage_v: 480, continuous_load_a: 100, length_ft: 250 }), "conduit").value).toBe("1-1/4 in EMT");
  });
});

describe("the protection rules", () => {
  it("240.4(B): 280 A on 300 kcmil (285 A) with a 300 A device, the next standard rating above 285 A", () => {
    const r = run({ circuit: "feeder", system: "3ph_3w", voltage_v: 480, noncontinuous_load_a: 280 });
    expect(value(r, "ocpd_a").value).toBe(300);
    expect(value(r, "conductor").value).toBe("300 kcmil");
    expect(cites(r)).toContain("NEC 2020 240.4(B), next higher standard rating, 800 A or less");
  });

  it("…but not where the load itself exceeds the ampacity: 300 A needs 350 kcmil", () => {
    expect(value(run({ circuit: "feeder", system: "3ph_3w", voltage_v: 480, noncontinuous_load_a: 300 }), "conductor").value).toBe("350 kcmil");
  });

  it("240.4(D): #14 is never on a 20 A breaker even though its 75°C ampacity is 20 A", () => {
    const r = run({ circuit: "branch", system: "1ph_2w", voltage_v: 120, noncontinuous_load_a: 12, ocpd_a: 20, terminal_temp_c: 75 });
    expect(value(r, "conductor").value).toBe("#12");
  });

  it("a device smaller than the load is refused in words", () => {
    const r = run({ circuit: "branch", system: "1ph_2w", voltage_v: 120, continuous_load_a: 16, ocpd_a: 15 });
    expect(r.issues[0]?.severity).toBe("error");
    expect(r.issues[0]?.message).toBe("A 15 A device is smaller than the 20 A this load needs; use at least 20 A.");
  });

  it("aluminum, 100 A at 60°C terminations: 1/0 Al (100 A; #1 Al is 85 A), #6 Al EGC", () => {
    const r = run({ circuit: "feeder", system: "3ph_3w", voltage_v: 208, noncontinuous_load_a: 100, material: "aluminum" });
    expect(value(r, "conductor").value).toBe("#1/0");
    expect(value(r, "egc").value).toBe("#6");
  });

  it("40°C ambient and 6 conductors: #1 THHN 145 A x 0.91 x 0.80 = 105.6 A carries 100 A at 75°C terminations", () => {
    const r = run({ circuit: "feeder", system: "3ph_3w", voltage_v: 480, noncontinuous_load_a: 100, ambient_c: 40, current_carrying_conductors: 6, terminal_temp_c: 75 });
    expect(value(r, "conductor").value).toBe("#1");
    expect(value(r, "conductor_ampacity_a").value).toBeCloseTo(145 * 0.91 * 0.8, 1);
  });
});

describe("editions", () => {
  it("2020 and 2023 size the same; the ambient correction is cited by each edition's own table number", () => {
    const inputs = { circuit: "feeder", system: "3ph_3w", voltage_v: 480, noncontinuous_load_a: 100, ambient_c: 40 };
    const a = run(inputs, "2020");
    const b = run(inputs, "2023");
    expect(value(a, "conductor").value).toBe(value(b, "conductor").value);
    expect(cites(a).some((c) => c.startsWith("NEC 2020 Table 310.15(B)(1),"))).toBe(true);
    expect(cites(b).some((c) => c.startsWith("NEC 2023 Table 310.15(B)(1)(1),"))).toBe(true);
    expect(a.runKey).not.toBe(b.runKey);
  });
});
