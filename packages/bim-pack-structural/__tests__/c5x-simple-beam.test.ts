/**
 * @jest-environment node
 */
import { qty, to, type Quantity } from "@permitzip/bim-units";
import { simpleBeam, SimpleBeamInputError } from "../src/simple-beam";

const span = (f: number) => qty("length", f, "ft");
const plf = (w: number) => qty("line_load", w, "plf");
const lbf = (p: number) => qty("force", p, "lbf");

describe("c5x simple-beam reactions and moment (AISC Manual Table 3-23)", () => {
  it("uniform load: R = wL/2, M = wL²/8 at midspan (case 1)", () => {
    // w = 500 plf, L = 30 ft: R = 500·30/2 = 7,500 lbf; M = 500·30²/8 = 56,250 lb-ft at 15 ft.
    const r = simpleBeam({ span: span(30), uniform: plf(500) });
    expect(to(r.startReaction, "lbf")).toBeCloseTo(7500, 6);
    expect(to(r.endReaction, "lbf")).toBeCloseTo(7500, 6);
    expect(to(r.maxMoment, "lbf.ft")).toBeCloseTo(56250, 3);
    expect(to(r.maxMomentAt, "ft")).toBeCloseTo(15, 9);
  });

  it("point load at any point: R1 = Pb/L, R2 = Pa/L, M = Pab/L under the load (case 8)", () => {
    // P = 2,000 lbf at a = 10 ft of L = 30 ft (b = 20): R1 = 2000·20/30 = 1,333.33; R2 = 666.67; M = 2000·10·20/30 = 13,333.3 lb-ft at 10 ft.
    const r = simpleBeam({ span: span(30), uniform: plf(0), pointLoads: [{ load: lbf(2000), at: span(10) }] });
    expect(to(r.startReaction, "lbf")).toBeCloseTo(1333.3333, 3);
    expect(to(r.endReaction, "lbf")).toBeCloseTo(666.6667, 3);
    expect(to(r.maxMoment, "lbf.ft")).toBeCloseTo(13333.333, 2);
    expect(to(r.maxMomentAt, "ft")).toBeCloseTo(10, 9);
  });

  it("combined: the peak is where the shear crosses zero, past the point load", () => {
    // w = 526 plf (500 live + 26 self-weight), P = 2,000 lbf at 10 ft, L = 30 ft.
    // R1 = 526·30/2 + 2000·20/30 = 7,890 + 1,333.33 = 9,223.33 lbf; R2 = 7,890 + 666.67 = 8,556.67 lbf.
    // Shear right of the load: 9,223.33 − 526·10 − 2,000 = 1,963.33 > 0, so V = 0 at x = 10 + 1,963.33/526 = 13.7326 ft.
    // M = 9,223.33·13.7326 − 526·13.7326²/2 − 2,000·3.7326 = 126,660.1 − 49,597.5 − 7,465.1 = 69,597.5 lb-ft.
    const r = simpleBeam({ span: span(30), uniform: plf(526), pointLoads: [{ load: lbf(2000), at: span(10) }], allowableMoment: qty("moment", 100, "kip.ft") });
    expect(to(r.startReaction, "lbf")).toBeCloseTo(9223.333, 2);
    expect(to(r.endReaction, "lbf")).toBeCloseTo(8556.667, 2);
    expect(to(r.maxMomentAt, "ft")).toBeCloseTo(13.7326, 3);
    expect(to(r.maxMoment, "lbf.ft")).toBeCloseTo(69597.5, 0);
    expect(r.utilisation).toBeCloseTo(0.6959748, 5);
    // Statics: the reactions carry every load.
    expect(to(r.startReaction, "lbf") + to(r.endReaction, "lbf")).toBeCloseTo(526 * 30 + 2000, 6);
  });

  it("two loads at the same point count once each", () => {
    const r = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(1000), at: span(5) }, { load: lbf(1000), at: span(5) }] });
    // 2,000 lbf at 5 ft of 20: R1 = 2000·15/20 = 1,500; M = 1,500·5 = 7,500 lb-ft.
    expect(to(r.startReaction, "lbf")).toBeCloseTo(1500, 6);
    expect(to(r.maxMoment, "lbf.ft")).toBeCloseTo(7500, 4);
  });

  it("refuses an impossible beam in plain words", () => {
    expect(() => simpleBeam({ span: span(0), uniform: plf(10) })).toThrow(SimpleBeamInputError);
    expect(() => simpleBeam({ span: span(10), uniform: plf(0), pointLoads: [{ load: lbf(5), at: span(12), label: "RTU-9" }] })).toThrow("A point load (RTU-9) sits 12.00 ft from the start, outside the 10.00 ft span");
  });
});

const ksi = (e: number) => qty("stress", e, "ksi");
const in4 = (i: number) => qty("second_moment_of_area", i, "in4");
/** E = 29,000 ksi, I = 100 in⁴: the benchmark beam stiffness. */
const STIFF = { elasticModulus: ksi(29000), momentOfInertia: in4(100) };

describe("c5x simple-beam elastic deflection (Euler–Bernoulli, superposed Table 3-23 cases 1 and 8)", () => {
  // Every expected value below was checked two independent ways: the closed-form expression in the
  // comment, and a numerical double integration of EI·v″ = −M with v(0) = v(L) = 0 on a 200,000-step
  // grid (not this code). They agree to nine figures.

  it("uniform load: Δ = 5wL⁴/384EI at midspan (case 1)", () => {
    // w = 500 plf = 41.667 lb/in, L = 240 in, EI = 29e6 psi · 100 in⁴: Δ = 5·41.667·240⁴/(384·2.9e9) = 0.620689655 in.
    const r = simpleBeam({ span: span(20), uniform: plf(500), ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.620689655, 8);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(10, 6);
  });

  it("centred point load: Δ = PL³/48EI under the load (case 7, the a = b form of case 8)", () => {
    // 2,000·240³/(48·2.9e9) = 0.198620690 in.
    const r = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(2000), at: span(10) }], ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.19862069, 8);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(10, 6);
  });

  it("off-centre point load: the peak is between the load and midspan, not under the load (case 8)", () => {
    // P = 2,000 lbf at a = 15 ft of 20 (a > b = 5): x = √(a(a + 2b)/3) = √(180·300/3) in = 11.1803 ft;
    // Δ = P·a·b·(a + 2b)·√(3a(a + 2b))/(27·EI·L) = 0.138790426 in.
    const r = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(2000), at: span(15) }], ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.138790426, 8);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(11.18034, 4);
  });

  it("off-centre point load near the start: mirrored case 8", () => {
    // P = 5,000 lbf at 4 ft of 30, I = 250 in⁴. From the far end (a = 26 ft, b = 4 ft): x = √(a(a + 2b)/3) = 17.1659 ft,
    // so 30 − 17.1659 = 12.8341 ft from the start; Δ = 0.267910499 in.
    const r = simpleBeam({ span: span(30), uniform: plf(0), pointLoads: [{ load: lbf(5000), at: span(4) }], elasticModulus: ksi(29000), momentOfInertia: in4(250) });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.267910499, 8);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(12.834142, 4);
  });

  it("uniform plus an off-centre point load superpose; the peak moves toward the load", () => {
    // w = 500 plf and P = 2,000 lbf at 5 ft, L = 20 ft. Numerical integration: Δ = 0.757628886 in at 9.792002 ft.
    const r = simpleBeam({ span: span(20), uniform: plf(500), pointLoads: [{ load: lbf(2000), at: span(5) }], ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.757628886, 7);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(9.792002, 4);
    // Superposition: Δ at that point is the sum of the parts there, and more than either peak alone.
    expect(to(r.maxDeflection!, "in")).toBeGreaterThan(0.620689655);
  });

  it("two unequal point loads: the peak is under neither load", () => {
    // 3,000 lbf at 4 ft and 1,000 lbf at 14 ft, L = 20 ft. Numerical integration: Δ = 0.248768073 in at 9.427681 ft.
    const r = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(1000), at: span(14) }, { load: lbf(3000), at: span(4) }], ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(0.248768073, 7);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(9.427681, 4);
  });

  it("coincident point loads deflect as their sum", () => {
    // 1,000 + 1,000 lbf at 5 ft of 20 ≡ 2,000 lbf at 5 ft: the mirror of a = 15 ft, so Δ = 0.138790426 in at 20 − 11.18034 = 8.81966 ft.
    const two = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(1000), at: span(5) }, { load: lbf(1000), at: span(5) }], ...STIFF });
    const one = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(2000), at: span(5) }], ...STIFF });
    expect(to(two.maxDeflection!, "in")).toBeCloseTo(0.138790426, 8);
    expect(to(two.maxDeflectionAt!, "ft")).toBeCloseTo(8.81966, 4);
    expect(to(two.maxDeflection!, "in")).toBeCloseTo(to(one.maxDeflection!, "in"), 12);
  });

  it("a load over a support deflects nothing", () => {
    const r = simpleBeam({ span: span(20), uniform: plf(0), pointLoads: [{ load: lbf(5000), at: span(0) }, { load: lbf(5000), at: span(20) }], ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBe(0);
  });

  it("no load: zero deflection, reported at the start like the moment", () => {
    const r = simpleBeam({ span: span(20), uniform: plf(0), ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBe(0);
    expect(to(r.maxDeflectionAt!, "ft")).toBe(0);
    expect(to(r.maxMomentAt, "ft")).toBe(0);
  });

  it("an upward load deflects up: the sign follows the load, the peak is still its largest size", () => {
    const r = simpleBeam({ span: span(20), uniform: plf(-500), ...STIFF });
    expect(to(r.maxDeflection!, "in")).toBeCloseTo(-0.620689655, 8);
    expect(to(r.maxDeflectionAt!, "ft")).toBeCloseTo(10, 6);
  });

  it("without E and I, the result is exactly what it was: no deflection keys", () => {
    const input = { span: span(30), uniform: plf(526), pointLoads: [{ load: lbf(2000), at: span(10) }], allowableMoment: qty("moment", 100, "kip.ft") };
    const r = simpleBeam(input);
    expect(Object.keys(r).sort()).toEqual(["endReaction", "maxMoment", "maxMomentAt", "startReaction", "utilisation"]);
    // And giving E and I changes none of the statics.
    const withEI = simpleBeam({ ...input, ...STIFF });
    expect({ ...withEI, maxDeflection: undefined, maxDeflectionAt: undefined }).toEqual({ ...r, maxDeflection: undefined, maxDeflectionAt: undefined });
  });

  it("refuses half a stiffness or an impossible one, never assuming a default", () => {
    const base = { span: span(20), uniform: plf(500) };
    expect(() => simpleBeam({ ...base, elasticModulus: ksi(29000) })).toThrow("Deflection needs the moment of inertia (I) as well as the modulus of elasticity (E)");
    expect(() => simpleBeam({ ...base, momentOfInertia: in4(100) })).toThrow("Deflection needs the modulus of elasticity (E) as well as the moment of inertia (I)");
    for (const bad of [0, -29000]) {
      expect(() => simpleBeam({ ...base, elasticModulus: ksi(bad), momentOfInertia: in4(100) })).toThrow(SimpleBeamInputError);
      expect(() => simpleBeam({ ...base, elasticModulus: ksi(bad), momentOfInertia: in4(100) })).toThrow("The modulus of elasticity (E) must be a finite number greater than zero");
      expect(() => simpleBeam({ ...base, elasticModulus: ksi(29000), momentOfInertia: in4(bad) })).toThrow("The moment of inertia (I) must be a finite number greater than zero");
    }
    // bim-units refuses a non-finite quantity before it gets here; a raw canonical value is refused all the same.
    expect(() => ksi(Number.NaN)).toThrow("must be a finite number");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => simpleBeam({ ...base, elasticModulus: bad as Quantity<"stress">, momentOfInertia: in4(100) })).toThrow("The modulus of elasticity (E) must be a finite number greater than zero");
      expect(() => simpleBeam({ ...base, elasticModulus: ksi(29000), momentOfInertia: bad as Quantity<"second_moment_of_area"> })).toThrow("The moment of inertia (I) must be a finite number greater than zero");
    }
  });

  it("refuses flexural rigidity that underflows or overflows", () => {
    const base = { span: span(20), uniform: plf(500) };
    expect(() => simpleBeam({ ...base, elasticModulus: Number.MIN_VALUE as Quantity<"stress">, momentOfInertia: Number.MIN_VALUE as Quantity<"second_moment_of_area"> })).toThrow("The flexural rigidity (E·I) must be finite and greater than zero");
    expect(() => simpleBeam({ ...base, elasticModulus: Number.MAX_VALUE as Quantity<"stress">, momentOfInertia: 2 as Quantity<"second_moment_of_area"> })).toThrow("The flexural rigidity (E·I) must be finite and greater than zero");
  });

  it("refuses a deflection that is not representable as a finite number", () => {
    expect(() => simpleBeam({ span: span(20), uniform: plf(500), elasticModulus: Number.MIN_VALUE as Quantity<"stress">, momentOfInertia: 1 as Quantity<"second_moment_of_area"> })).toThrow("The calculated deflection is not representable as a finite number");
  });

  it("handles signed mixed loading with a challenging moment-root scale", () => {
    const r = simpleBeam({
      span: 1_000_000 as Quantity<"length">,
      uniform: 1e-300 as Quantity<"line_load">,
      pointLoads: [{ load: 1e6 as Quantity<"force">, at: 1 as Quantity<"length"> }, { load: -1e6 as Quantity<"force">, at: 999_999 as Quantity<"length"> }],
      elasticModulus: 1 as Quantity<"stress">,
      momentOfInertia: 1 as Quantity<"second_moment_of_area">,
    });
    expect(Number.isFinite(r.maxDeflection!)).toBe(true);
    expect(Number.isFinite(r.maxDeflectionAt!)).toBe(true);
    expect(to(r.maxDeflectionAt!, "m")).toBeGreaterThan(0);
    expect(to(r.maxDeflectionAt!, "m")).toBeLessThan(1_000_000);
  });
});
