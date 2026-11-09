/**
 * @jest-environment node
 *
 * Round 10 lane P10: the pipe catalogue is the Plumbing add-on's. The kernel
 * exports no joint union, no joint words, no product table and no hub sizes;
 * every product in force is an add-on row; the kernel's pipe product and
 * reader files name no joint; and the trade terms that lived in them are
 * gone (counted against `trade-terms.baseline.json`, which only goes down).
 *
 * Fails on round 9's code: `JointType`, `JOINT_LABEL`, `PIPE_SPECS`,
 * `DEFAULT_SPEC`, `SPEC_LABEL` and the hub table were kernel exports and data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import * as kernel from "@permitzip/bim-kernel";
import { PIPE_PRODUCT_POINT, pipeProducts } from "@permitzip/bim-kernel";
import { PIPE_PRODUCTS } from "@permitzip/bim-pack-plumbing";
import { activePackSet } from "../src/packs";

const SRC = path.resolve(__dirname, "../src");
const source = (f: string) => readFileSync(path.join(SRC, f), "utf8");
const JOINT_NAMES = ["sweat", "press", "threaded", "no_hub", "hub_gasket", "solvent_weld", "pex_crimp", "pex_expansion", "fusion", "csst_mechanical"];
/** The ratchet's counting (`src/__tests__/trade-terms.test.ts`), for the terms these files used. */
const TERMS = ["plumbing", "mechanical", "sanitary", "vent", "drainage", "gas", "fixture", "duct", "conduit"];
function countTerms(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    const w = raw.toLowerCase();
    const term = TERMS.find((t) => w === t || w === `${t}s` || w === `${t}es`);
    if (raw.length >= 3 && term) out[term] = (out[term] ?? 0) + 1;
  }
  return out;
}
const BASELINE = (JSON.parse(readFileSync(path.join(SRC, "__tests__", "trade-terms.baseline.json"), "utf8")) as { readonly files: Readonly<Record<string, Readonly<Record<string, number>>>> }).files;

describe("p10-joint-type-out-of-core", () => {
  it("the kernel exports no joint union, joint words or product table", () => {
    for (const gone of ["JOINT_LABEL", "PIPE_SPECS", "DEFAULT_SPEC", "SPEC_LABEL"]) expect({ gone, exported: gone in kernel }).toEqual({ gone, exported: false });
    for (const file of ["routing/pipe/specs.ts", "routing/pipe/families.ts", "routing/pipe/geometry.ts", "../../bim-pack-plumbing/src/routing/pipe/pipe-types.ts", "registry/pipe-product-point.ts"]) {
      expect({ file, union: /\bJointType\b|\bJOINT_LABEL\b|\bPIPE_SPECS\b/.test(source(file)) }).toEqual({ file, union: false });
    }
  });

  it("the kernel ships no product; every product in force is the Plumbing add-on's", () => {
    expect(PIPE_PRODUCT_POINT.builtins).toBeUndefined();
    expect(activePackSet().items(PIPE_PRODUCT_POINT)).toEqual(PIPE_PRODUCTS);
    expect(pipeProducts().every((p) => p.id.startsWith("plumbing_gas.") && p.endTypes.every((e) => e.startsWith("plumbing_gas.")))).toBe(true);
  });

  it("the product point, the readers and the fitting geometry name no joint and no hub size", () => {
    for (const file of ["registry/pipe-product-point.ts", "routing/pipe/specs.ts", "routing/pipe/geometry.ts"]) {
      const text = source(file);
      expect({ file, joints: JOINT_NAMES.filter((j) => new RegExp(`["']${j}["']|\\b${j}:`).test(text)) }).toEqual({ file, joints: [] });
    }
    expect(/sweat:\s*\{\s*od:/.test(source("routing/pipe/geometry.ts"))).toBe(false);
  });

  it("the trade terms the catalogue carried left the kernel", () => {
    const now = countTerms(source("routing/pipe/specs.ts"));
    // Round 9's counts (the baseline before round 10 lowered it): drainage 11, vent 5, gas 15, mechanical 5 in specs.ts, mechanical 1 in geometry.ts. What stays is the service words of `PipeService`.
    const ROUND_9_SPECS = { mechanical: 5, drainage: 11, vent: 5, gas: 15 };
    for (const [term, was] of Object.entries(ROUND_9_SPECS)) expect((now as Record<string, number>)[term] ?? 0).toBeLessThan(was);
    expect(now).toEqual({ drainage: 2, vent: 1, gas: 2 });
    // The ratchet now holds the lowered counts, so the words can't come back.
    expect(BASELINE["packages/bim-kernel/src/routing/pipe/specs.ts"] ?? {}).toEqual(now);
    expect(countTerms(source("routing/pipe/geometry.ts")).mechanical ?? 0).toBeLessThan(1);
    expect(countTerms(source("registry/pipe-product-point.ts"))).toEqual({});
  });
});
