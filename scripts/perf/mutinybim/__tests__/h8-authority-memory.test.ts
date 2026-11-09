/**
 * @jest-environment node
 *
 * authority.memory.1M (round 8, product decision 8): the 1M memory rows measure the
 * model server only, not the perf harness's own copy of the model.
 *
 * Measured with memory-probe.ts on 2026-10-31 (apple-m5-max, 1M tier): with the
 * generator's copy in the process the server reached 2,523 MB resident / 804 MB
 * heap; loading the same model as rows from a generator process, 1,027 MB / 786 MB.
 * The server itself grows ~70 MB after load (first join's area index), and
 * nothing after warm-up or commits; the first-party add-on install retains no
 * per-model structure. The gate row itself is Testing's 1M run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { loadModelLikeServer } from "../server-load";

const dir = path.join(__dirname, "..");
const source = (file: string): string => readFileSync(path.join(dir, file), "utf8");

describe("h8 authority memory: the server rows exclude the harness's copy", () => {
  it("synthetic.ts and cold-paths.ts never generate the model in the measured process", () => {
    for (const file of ["synthetic.ts", "cold-paths.ts"]) {
      const text = source(file);
      expect({ file, generatesInProcess: /createFullBimModel\s*\(/.test(text) }).toEqual({ file, generatesInProcess: false });
      expect({ file, loadsRows: text.includes("loadModelLikeServer(") }).toEqual({ file, loadsRows: true });
    }
  });

  it("the rows a generator process streams rebuild the same model", async () => {
    const expected = createFullBimModel(FULL_BIM_TIERS.XS);
    const loaded = await loadModelLikeServer("XS");
    expect(Object.keys(loaded.model.elements).length).toBe(Object.keys(expected.elements).length);
    expect(loaded.model).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(loaded.generateMs).toBeGreaterThan(0);
  }, 120_000);
});
