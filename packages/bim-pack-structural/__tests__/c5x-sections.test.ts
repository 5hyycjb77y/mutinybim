/**
 * @jest-environment node
 */
import { to } from "@permitzip/bim-units";
import { sectionById, WIDE_FLANGE_SECTIONS } from "../src/sections";

describe("c5x the wide-flange catalogue is typed data", () => {
  it("reads a section by the name drawings use, whatever its case or times sign", () => {
    expect(sectionById("W16X26")?.id).toBe("W16X26");
    expect(sectionById(" w16x26 ")?.id).toBe("W16X26");
    expect(sectionById("W16×26")?.id).toBe("W16X26");
    expect(sectionById("W40X999")).toBeNull();
  });

  it("carries depth, weight, area, Ix and Sx as typed quantities", () => {
    const s = sectionById("W16X26");
    if (!s) throw new Error("W16X26 missing");
    expect(to(s.depth, "in")).toBeCloseTo(15.7, 9);
    expect(to(s.depth, "mm")).toBeCloseTo(398.78, 6);
    expect(to(s.weight, "plf")).toBeCloseTo(26, 9);
    expect(to(s.area, "in2")).toBeCloseTo(7.68, 9);
    expect(to(s.ix, "in4")).toBeCloseTo(301, 9);
    expect(to(s.sx, "in3")).toBeCloseTo(38.4, 9);
    // 301 in⁴ × (25.4 mm/in)⁴ = 125,287,000 mm⁴; held in SI as 1.25287e-4 m⁴.
    expect(to(s.ix, "mm4")).toBeCloseTo(301 * 25.4 ** 4, 0);
    expect(s.ix).toBeCloseTo(1.25287e-4, 8);
    expect(s.verified).toBe(false);
  });

  it("every row is internally consistent: weight = area × 490 pcf and Sx = Ix ÷ (d/2), each within 1%", () => {
    // A transcription slip in any one column breaks one of these two identities.
    for (const s of WIDE_FLANGE_SECTIONS) {
      const plfFromArea = (to(s.area, "in2") / 144) * 490;
      expect({ id: s.id, ok: Math.abs(plfFromArea / to(s.weight, "plf") - 1) < 0.01 }).toEqual({ id: s.id, ok: true });
      const sxFromIx = to(s.ix, "in4") / (to(s.depth, "in") / 2);
      expect({ id: s.id, ok: Math.abs(sxFromIx / to(s.sx, "in3") - 1) < 0.01 }).toEqual({ id: s.id, ok: true });
    }
  });
});
