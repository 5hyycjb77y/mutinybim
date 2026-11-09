/**
 * @jest-environment node
 */
import { to } from "@permitzip/bim-units";
import { carriesDeck, deckPointShares, tributaryStrips, type DeckSpan, type SpanSupport } from "../src/tributary";

const FT = 304.8;
const p = (x: number, y: number) => ({ x: x * FT, y: y * FT });
const beamAt = (id: string, y: number, x0 = 0, x1 = 30): SpanSupport => ({ id, start: p(x0, y), end: p(x1, y) });
const deck = (spanDirectionDeg: number, w = 30, h = 50): DeckSpan => ({ id: "D", outline: [p(0, 0), p(w, 0), p(w, h), p(0, h)], spanDirectionDeg });
const widthFt = (m: ReturnType<typeof tributaryStrips>, id: string) => {
  const s = m.get(id);
  if (!s) throw new Error(`${id} has no strip`);
  return to(s.width, "ft");
};

describe("c5x tributary widths: half the distance to each neighbour, to the edge past the last", () => {
  it("three beams 25 ft apart: 12.5, 25, 12.5 ft; strips tile the deck", () => {
    const strips = tributaryStrips(deck(90), [beamAt("B1", 0), beamAt("B2", 25), beamAt("B3", 50)]);
    expect(widthFt(strips, "B1")).toBeCloseTo(12.5, 9);
    expect(widthFt(strips, "B2")).toBeCloseTo(25, 9);
    expect(widthFt(strips, "B3")).toBeCloseTo(12.5, 9);
    // 30 × 50 ft = 1,500 ft² of deck: 375 + 750 + 375.
    const total = [...strips.values()].reduce((a, s) => a + to(s.area, "ft2"), 0);
    expect(total).toBeCloseTo(1500, 6);
    expect(strips.get("B2")).toMatchObject({ previousId: "B1", nextId: "B3" });
    expect(strips.get("B1")).toMatchObject({ previousId: null, nextId: "B2" });
  });

  it("uneven spacing: 10 ft and 30 ft bays give 5, 20, 15 ft", () => {
    const strips = tributaryStrips(deck(90, 30, 40), [beamAt("a", 0), beamAt("b", 10), beamAt("c", 40)]);
    expect([widthFt(strips, "a"), widthFt(strips, "b"), widthFt(strips, "c")].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([5, 20, 15]);
  });

  it("interior beams with the deck running past them: the overhang goes to the end beams", () => {
    // Beams at y = 5 and 35 on a 0–40 ft deck: 5 + 15 = 20 ft and 15 + 5 = 20 ft.
    const strips = tributaryStrips(deck(90, 30, 40), [beamAt("a", 5), beamAt("b", 35)]);
    expect(widthFt(strips, "a")).toBeCloseTo(20, 9);
    expect(widthFt(strips, "b")).toBeCloseTo(20, 9);
  });

  it("a beam parallel to the span carries nothing; the order supports are given in doesn't matter", () => {
    const girder: SpanSupport = { id: "G", start: p(0, 0), end: p(0, 50) };
    expect(carriesDeck(deck(90), girder)).toBe(false);
    const a = tributaryStrips(deck(90), [beamAt("B3", 50), girder, beamAt("B1", 0), beamAt("B2", 25)]);
    expect(a.has("G")).toBe(false);
    expect(widthFt(a, "B2")).toBeCloseTo(25, 9);
  });

  it("a short beam's neighbours are only the beams that overlap it across the span", () => {
    // B2 covers x 0–15 only; B2' covers 15–30 at y = 20. Each sees B1 and B3, never each other.
    const strips = tributaryStrips(deck(90), [beamAt("B1", 0), beamAt("B2", 25, 0, 15), beamAt("B2x", 20, 15, 30), beamAt("B3", 50)]);
    expect(widthFt(strips, "B2")).toBeCloseTo(25, 9);
    expect(widthFt(strips, "B2x")).toBeCloseTo(25, 9);
    const b2 = strips.get("B2");
    expect(b2 ? to(b2.length, "ft") : null).toBeCloseTo(15, 9);
  });

  it("a deck spanning along x is read in its own frame", () => {
    const strips = tributaryStrips(deck(0, 50, 30), [{ id: "L", start: p(0, 0), end: p(0, 30) }, { id: "M", start: p(20, 0), end: p(20, 30) }, { id: "R", start: p(50, 0), end: p(50, 30) }]);
    expect([widthFt(strips, "L"), widthFt(strips, "M"), widthFt(strips, "R")].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([10, 25, 15]);
  });
});

describe("c5x a point load on the deck splits by the lever rule", () => {
  it("between two beams 25 ft apart, 10 ft from the first: 60% / 40%", () => {
    const r = deckPointShares(deck(90), [beamAt("B1", 0), beamAt("B2", 25), beamAt("B3", 50)], p(12, 10));
    expect(r.cantilever).toBe(false);
    expect(r.shares.map((s) => [s.supportId, Math.round(s.fraction * 1e9) / 1e9])).toEqual([
      ["B1", 0.6],
      ["B2", 0.4],
    ]);
  });
});
