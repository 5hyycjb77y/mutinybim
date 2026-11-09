/**
 * @jest-environment node
 *
 * Round 11 G11 (D4): a record with no basis and no old ladder reads "not
 * recorded", never a guess. A stored basis (on the record or on one value)
 * reads back as stored, with fields this release doesn't know kept; a
 * malformed one reads "not recorded". Fails on round 10's code: no reader.
 */
import type { BimElement } from "../src";
import { basisGroupOf, readBasis, readValueBasis } from "../src/basis/read";
import { wall } from "./g11-fixtures";

describe("g11 no basis reads not recorded", () => {
  it("an element with nothing recorded", () => {
    const w = wall("W-1", 0, 0, 1000, 0);
    expect(readBasis(w)).toEqual({ known: false, words: "not recorded" });
    expect(readValueBasis(w, "qto.length")).toEqual({ known: false, words: "not recorded" });
    expect(basisGroupOf(readBasis(w))).toBe("not recorded");
  });

  it("a stored basis reads back, per record and per value, with unknown fields kept", () => {
    const w = wall("W-2", 0, 0, 1000, 0, {
      provenance: { basis: { maturity: "calculated", source: { kind: "calc", ref: "calc-7" }, confidence: "high", at: "2026-11-01", reviewedBy: "a newer field" } },
      valueBasis: { "qto.length": { maturity: "field_verified", source: { kind: "lidar" } } },
    });
    const rec = readBasis(w);
    expect(rec.known && rec.from).toBe("stored");
    expect(rec.known && rec.basis).toEqual({ maturity: "calculated", source: { kind: "calc", ref: "calc-7" }, confidence: "high", at: "2026-11-01", reviewedBy: "a newer field" });
    const len = readValueBasis(w, "qto.length");
    expect(len.known && len.basis.maturity).toBe("field_verified");
    const height = readValueBasis(w, "qto.height");
    expect(height.known && height.basis.maturity).toBe("calculated");
    // A rung this release doesn't know is kept as written.
    const newer = readBasis(wall("W-3", 0, 0, 1, 0, { provenance: { basis: { maturity: "zz.drone_scanned" } } }));
    expect(newer.known && newer.basis.maturity).toBe("zz.drone_scanned");
  });

  it("a malformed stored basis is not read as anything", () => {
    for (const basis of [{ maturity: "" }, { maturity: 3 }, { maturity: "measured", source: "survey" }, "measured", []]) {
      expect(readBasis(wall("W-4", 0, 0, 1, 0, { provenance: { basis } }) as BimElement)).toEqual({ known: false, words: "not recorded" });
    }
  });
});
