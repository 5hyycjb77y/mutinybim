/**
 * @jest-environment node
 */
import { qty, to } from "@permitzip/bim-units";
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
