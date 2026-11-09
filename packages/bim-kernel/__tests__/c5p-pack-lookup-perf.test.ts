/**
 * @jest-environment node
 *
 * `kernel.packs.lookup` (batch 5c lane A): the per-call cost of the lookups
 * packs now route through (network adapter by id, service row by id, derived
 * rule by id), outside any scope and inside a scope with a pack set. The
 * "before" numbers in an internal design note were taken from this
 * file on the global-map code, so the budget starts from a measured value.
 * The budget is a ceiling per call, far above the measurement, so a loaded
 * laptop doesn't fail it; a per-call table rebuild (O(adapters) or worse)
 * would.
 */
import { performance } from "node:perf_hooks";
import { adapterForService, tradeAdapter } from "../src/connections/model";
import { serviceById } from "../src/services/registry";
import { derivedZoneRule } from "../src/spaces/derived-zones";

const CALLS = 200_000;
const BUDGET_NS_PER_CALL = 2_000;

function nsPerCall(fn: () => unknown): number {
  let sink = 0;
  for (let i = 0; i < 2_000; i++) sink += fn() ? 1 : 0;
  const t = performance.now();
  for (let i = 0; i < CALLS; i++) sink += fn() ? 1 : 0;
  const ns = ((performance.now() - t) * 1e6) / CALLS;
  if (sink < 0) throw new Error("unreachable");
  return Number(ns.toFixed(1));
}

describe("c5p kernel.packs.lookup", () => {
  it("adapter, service and derived-rule lookups stay O(1) per call", () => {
    const rows = {
      tradeAdapter: nsPerCall(() => tradeAdapter("electrical")),
      adapterForService: nsPerCall(() => adapterForService("sanitary")),
      serviceById: nsPerCall(() => serviceById("domestic_cold_water")),
      derivedZoneRule: nsPerCall(() => derivedZoneRule("dedicated")),
    };
    process.stdout.write(`[kernel.packs.lookup] ns per call, built-ins: ${JSON.stringify(rows)}\n`);
    for (const [name, ns] of Object.entries(rows)) expect({ name, ns: ns < BUDGET_NS_PER_CALL }).toEqual({ name, ns: true });
  });
});
