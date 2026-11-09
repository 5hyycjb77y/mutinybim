/**
 * @jest-environment node
 *
 * Round 12 lane M12, move step 2: the seed models are the add-ons', not the
 * kernel's. The demo, placed-demo and heavy supply networks are the
 * Mechanical add-on's seeders; the all-discipline load-test building
 * (`createFullBimModel`, `FULL_BIM_TIERS`, `describeModel`) composes the
 * first-party add-ons, so it is `@permitzip/bim-first-party`'s.
 *
 * Old models build identically: each seeder's output hashes to what round
 * 11's kernel `seed.ts` / `fullbim.ts` built (canonical JSON, first-party
 * add-ons installed; hashes taken by running round 11's own files beside the
 * moved ones before the kernel copies were emptied).
 *
 * Fails on round 11's code: `@permitzip/bim-pack-mechanical` and
 * `@permitzip/bim-first-party` had no seeders, and the kernel's `seed.ts` /
 * `fullbim.ts` held 74 trade words.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as kernel from "../src";
import { canonicalJson } from "../src";
import { createDemoModel, createHeavyModel, createPlacedDemoModel, HEAVY_TIERS } from "@permitzip/bim-pack-mechanical/seed";
import { createFullBimModel, describeModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

const SRC = path.resolve(__dirname, "../src");
const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);

/** Round 11's kernel seeders, run on Nov 3 2026 (commit 6eccc2969). */
const ROUND_11 = {
  demo: "3a2a9a9e0f6e4a1d",
  placed: "fb92ef5e47650c32",
  heavyS: "c43fb395d2fc6196",
  fullXS: "137256d3ec2ddeb2",
  describeXS: "42f68876645bbeb6",
} as const;

describe("m12 seeders out of the kernel", () => {
  it("each seeder builds what round 11's kernel built, byte for byte", () => {
    const xs = createFullBimModel(FULL_BIM_TIERS.XS);
    expect({
      demo: hash(createDemoModel()),
      placed: hash(createPlacedDemoModel("p", { x: 1000, y: 2000 })),
      heavyS: hash(createHeavyModel(HEAVY_TIERS.S)),
      fullXS: hash(xs),
      describeXS: hash(describeModel(xs)),
    }).toEqual(ROUND_11);
  });

  it("the kernel exports no seeder and its seed files hold no trade word", () => {
    for (const name of ["createDemoModel", "createPlacedDemoModel", "createHeavyModel", "HEAVY_TIERS", "createFullBimModel", "FULL_BIM_TIERS", "describeModel", "ZONE_SQ_FT"]) {
      expect(Reflect.has(kernel, name)).toBe(false);
    }
    for (const file of ["seed.ts", "fullbim.ts"]) expect([file, existsSync(path.join(SRC, file))]).toEqual([file, false]);
  });
});
