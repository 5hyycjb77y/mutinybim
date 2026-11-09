/**
 * @jest-environment node
 *
 * Round 12 lane P12 (E12's move handshake for `requirements/facets.ts`):
 * Plumbing and gas's gas, water and drainage load sections equal round 13's
 * kernel rows field for field, and the gas row takes a shared quantity exactly
 * when round 13's did (frozen in `fixtures/k14-round13-stand-ins.json` when K14
 * deleted the kernel's stand-in in round 14) (@mutinybim-bare-kernel).
 *
 * Fails on round 11's code: the add-on had no load section rows.
 */
import type { QuantityTotals } from "@permitzip/bim-kernel";
import { ROUND13_GAS_TAKES_SHARED, round13LoadSection } from "./fixtures/k14-round13-stand-ins";
import { PLUMBING_LOAD_SECTION_ROWS } from "@permitzip/bim-pack-plumbing";

const totals = (mbh: number): QuantityTotals => new Proxy({} as QuantityTotals, { get: (_t, key) => (key === "mbh" ? mbh : 0) });

describe("p12-facet-rows-equal-fallback", () => {
  it.each(PLUMBING_LOAD_SECTION_ROWS.map((r) => [r.id, r] as const))("%s equals round 13's row", (id, row) => {
    const frozen = round13LoadSection(id);
    expect(JSON.stringify(row)).toBe(frozen.json);
    expect(Object.keys(row).sort()).toEqual(frozen.keys);
    const shared = (mbh: number) => (id === "gas" ? (ROUND13_GAS_TAKES_SHARED.find((g) => g.mbh === mbh)?.takes ?? null) : null);
    for (const mbh of [0, 120]) expect([mbh, row.takesShared?.(totals(mbh)) ?? null]).toEqual([mbh, shared(mbh)]);
  });

  it("contributes exactly gas, water and drainage", () => {
    expect(PLUMBING_LOAD_SECTION_ROWS.map((r) => r.id)).toEqual(["gas", "water", "drainage"]);
  });
});
