/**
 * @jest-environment node
 *
 * F6 groundwork: the pieces a network walk or a requirement total needs to
 * count a typical once per instance. Not wired into the walks yet (those are
 * k2-loads' files; see the internal design note).
 */
import { asElementId, freezeElements, type BimElement } from "../src";
import { ZERO_TOTALS, type QuantityTotals } from "../src/quantities";
import { nodeElementId, scaleTotals, typicalEdgeFactor, typicalLoadCount, typicalScopeCount } from "../src/organization/typicals-totals";
import { arrayCopies } from "../src/organization/typicals";

function group(id: string, copies: number | null): BimElement {
  const typical = copies === null ? undefined : { label: "Bathroom", mark: "001", basePoint: { x: 0, y: 0 }, copies: arrayCopies(id, "001", copies + 1, 6, { x: 5000, y: 0 }) };
  return { id: asElementId(id), kind: "organization", version: 0, authoredRev: {}, entry: { type: "group", name: id, ...(typical ? { typical } : {}) } } as unknown as BimElement;
}

function member(id: string, groupId?: string): BimElement {
  return { id: asElementId(id), kind: "load_point", version: 0, authoredRev: {}, ...(groupId ? { groupId } : {}) } as unknown as BimElement;
}

const elements = freezeElements(Object.fromEntries([group("g-bath", 23), group("g-plain", null), member("lav", "g-bath"), member("pipe-in-bath", "g-bath"), member("drain"), member("other", "g-plain")].map((e) => [e.id, e])));

describe("typicals in totals", () => {
  it("a typical bathroom's branch counts 24 times where it joins the building drain, once inside the bathroom", () => {
    expect(typicalEdgeFactor(elements, "pipe-in-bath", "drain")).toBe(24);
    expect(typicalEdgeFactor(elements, "lav", "pipe-in-bath")).toBe(1);
    expect(typicalEdgeFactor(elements, "pipe-in-bath#p1", "drain#p2")).toBe(24);
    expect(typicalEdgeFactor(elements, "drain", "pipe-in-bath")).toBe(1);
    expect(typicalEdgeFactor(elements, "other", "drain")).toBe(1);
    expect(nodeElementId("abc#c1")).toBe("abc");
  });

  it("a load counts once per instance in the project total and once in its own bathroom's total", () => {
    expect(typicalLoadCount(elements, elements["lav"], undefined)).toBe(24);
    expect(typicalLoadCount(elements, elements["lav"], "g-bath")).toBe(1);
    expect(typicalLoadCount(elements, elements["drain"], undefined)).toBe(1);
    expect(typicalScopeCount(elements, "g-bath")).toBe(24);
    expect(typicalScopeCount(elements, "g-plain")).toBe(1);
    expect(typicalScopeCount(elements, undefined)).toBe(1);
  });

  it("scales additive quantities (DFU, WSFU, MBH, CFM, VA) and leaves a minimum inlet pressure alone", () => {
    const t: QuantityTotals = { ...ZERO_TOTALS, dfu: 3, wsfu_total: 1.5, mbh: 40, cfm: 75, va: 180, min_inlet_pressure: 8 };
    const s = scaleTotals(t, 24);
    expect([s.dfu, s.wsfu_total, s.mbh, s.cfm, s.va, s.min_inlet_pressure]).toEqual([72, 36, 960, 1800, 4320, 8]);
    expect(scaleTotals(t, 1)).toBe(t);
    expect(() => scaleTotals(t, 0)).toThrow(/whole number/);
    expect(() => scaleTotals(t, 2.5)).toThrow(/whole number/);
  });
});
