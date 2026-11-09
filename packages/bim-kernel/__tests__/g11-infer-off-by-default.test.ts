/**
 * @jest-environment node
 *
 * Round 11 G11 (product owner question 7, pending): confidence on existing things
 * defaults to "not recorded". Inference is an option, off by default; a
 * guess is marked `inferred: true` and nothing is written. Fails on round
 * 10's code: no reader.
 */
import { readBasis } from "../src/basis/read";
import { wall } from "./g11-fixtures";

describe("g11 inference is off by default", () => {
  const existing = wall("W-E", 0, 0, 1000, 0, { locked: { state: "existing", reason: "Surveyed as built" } });
  const imported = wall("W-I", 0, 0, 1000, 0, { provenance: { ifcGlobalId: "2O2Fr$t4X7Zf8NOew3FLOH", source: "lidar" } });

  it("an existing-conditions record reads not recorded unless inference is asked for", () => {
    expect(readBasis(existing)).toEqual({ known: false, words: "not recorded" });
    expect(readBasis(existing, { infer: false })).toEqual({ known: false, words: "not recorded" });
    expect(readBasis(existing, { infer: true })).toEqual({ known: true, basis: { maturity: "assumed", source: { kind: "old_drawings" } }, from: "inferred", inferred: true });
  });

  it("an imported record's stated source becomes a marked guess; a stored basis always wins", () => {
    expect(readBasis(imported)).toEqual({ known: false, words: "not recorded" });
    expect(readBasis(imported, { infer: true })).toEqual({ known: true, basis: { maturity: "assumed", source: { kind: "lidar", ref: "lidar" } }, from: "inferred", inferred: true });
    const stored = wall("W-S", 0, 0, 1, 0, { locked: { state: "existing", reason: "x" }, provenance: { basis: { maturity: "measured" } } });
    expect(readBasis(stored, { infer: true })).toEqual({ known: true, basis: { maturity: "measured" }, from: "stored" });
  });

  it("inference writes nothing", () => {
    const before = JSON.stringify([existing, imported]);
    readBasis(existing, { infer: true });
    readBasis(imported, { infer: true });
    expect(JSON.stringify([existing, imported])).toBe(before);
  });
});
