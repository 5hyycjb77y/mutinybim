/**
 * @jest-environment node
 *
 * The drainage lint pack (ROADMAP P4 / P5). Each rule fires on its fixture and
 * clears on the fix an engineer would make; a model with no sewer connection,
 * pump or valve gets nothing from the pack. The pack did not exist before this
 * change, so every "fires" case fails on the old code (nothing to import, and
 * no rule in the engine says any of this).
 */
import type { ModelState } from "@permitzip/bim-kernel";
import { DEFAULT_LINT_CONFIG, LintEngine, type Finding } from "@permitzip/bim-lint";
import { drainageRules } from "../src/lint/drainage";
import { DrainageBuilding } from "../../bim-kernel/__tests__/drainage-fixtures";

function findings(model: ModelState): Finding[] {
  const e = new LintEngine(drainageRules);
  e.build(model, []);
  return e.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" } });
}

function byRule(model: ModelState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of findings(model)) out.set(f.rule, [...(out.get(f.rule) ?? []), f.message]);
  return out;
}

describe("drainage lint pack", () => {
  it("a building with drains but no sewer connection, pump or valve gets no drainage findings", () => {
    const b = new DrainageBuilding();
    b.drains("bsmt", "lvl-b", 3, 8);
    b.rows("row", 10, 40);
    expect(findings(b.head)).toEqual([]);
  });

  it("6144: raising the manhole above the basement floor flips the basement to needs a sewage pump and a backwater valve; Level 1 stays clear", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12, rimFt: -12, confidence: "verified" });
    b.drains("bsmt", "lvl-b", 3, 8);
    b.drains("l1", "lvl-1", 4, 6);
    expect(findings(b.head)).toEqual([]);

    b.setValues("mh-1", { sewer_invert: -8.5 * 304.8, sewer_rim: -2 * 304.8 });
    const fired = byRule(b.head);
    expect(fired.get("sewer-floor-needs-pump")).toEqual(['Basement (floor -10\'-0") is below the sewer at MH-1 (invert -8\'-6"): 3 drainage loads can\'t drain by gravity and need a sewage pump (IPC 712.1)']);
    expect(fired.get("sewer-floor-needs-backwater")).toEqual(['Basement (floor -10\'-0") is below the manhole cover at MH-1 (-2\'-0"): 3 drainage loads need a backwater valve (IPC 715.1)']);
    const pumpFinding = findings(b.head).find((f) => f.rule === "sewer-floor-needs-pump");
    expect(pumpFinding?.elementIds).toEqual(["lvl-b", "mh-1"]);
    expect(pumpFinding?.at.level).toBe("Basement");
    expect(pumpFinding?.fix?.tool).toBe("bim_edit_load_point");
  });

  it("naming SGP-1 (with a backwater valve) as the basement drains' source clears both", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -8.5, rimFt: -2, confidence: "verified" });
    b.pump("sgp-1", "SGP-1", { backwater_valve: true, pump_inflow_gpm: 40, pump_head_ft: 22, pump_rated_gpm: 50, pump_rated_head_ft: 25 });
    const ids = b.drains("bsmt", "lvl-b", 3, 8);
    expect(byRule(b.head).has("sewer-floor-needs-pump")).toBe(true);
    b.nameSource(ids, "sgp-1");
    expect(findings(b.head)).toEqual([]);
  });

  it("a floor above the cover that drains through a backwater valve is told it should not", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12, rimFt: -2, confidence: "verified" });
    b.valve("bwv-1", "BWV-1");
    b.drains("l1", "lvl-1", 2, 6, "bwv-1");
    expect(byRule(b.head).get("sewer-floor-through-backwater")).toEqual(["Level 1 is above the manhole cover at MH-1, so its 2 drainage loads should not drain through a backwater valve (IPC 715.1)"]);
  });

  it("394 DFU on a 4\" building drain at 1/8\"/ft is over capacity (180); a 6\" drain clears it", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12, confidence: "verified", sizeIn: 4, slope: 0.125 });
    b.rows("wc", 98, 4);
    b.rows("lav", 2, 1);
    const fired = byRule(b.head);
    expect(fired.get("building-drain-over-capacity")).toEqual(['394 DFU (whole building) on a 4" drain at 1/8"/ft; that size carries 180 at that slope (IPC Table 710.1(1))']);
    expect(findings(b.head).find((f) => f.rule === "building-drain-over-capacity")?.fix?.hint).toContain('6" carries 700');
    b.setValues("mh-1", { building_drain_size_in: 6 });
    expect(byRule(b.head).has("building-drain-over-capacity")).toBe(false);
  });

  it("7329: 79 DFU of unpiped rows on a 4\" drain at 1/4\"/ft passes", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12, confidence: "verified", sizeIn: 4, slope: 0.25 });
    b.rows("two", 26, 2);
    b.rows("three", 9, 3);
    expect(findings(b.head)).toEqual([]);
  });

  it("an assumed invert with no question is noted; once verified it is not", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12 });
    expect(byRule(b.head).get("sewer-elevation-unverified")).toEqual(["MH-1's invert is assumed, and no question asks the contractor to verify it"]);
    b.setValues("mh-1", { elevation_confidence: "verified" });
    expect(findings(b.head)).toEqual([]);
  });

  it("a pump with 24 DFU and no inflow can't be checked from fixture units; a typed flow it covers clears it; one it doesn't is undersized", () => {
    const b = new DrainageBuilding();
    b.pump("sgp-1", "SGP-1", { pump_rated_gpm: 50, pump_rated_head_ft: 25 });
    b.drains("bsmt", "lvl-b", 3, 8, "sgp-1");
    expect(byRule(b.head).get("sewage-pump-inflow-unknown")).toEqual(["SGP-1: 24 DFU drain to it. Can't check this pump yet: add a flow table (the firm's, with its source) or type the inflow in gpm"]);
    b.setValues("sgp-1", { pump_inflow_gpm: 40, pump_head_ft: 22 });
    expect(findings(b.head)).toEqual([]);
    b.setValues("sgp-1", { pump_inflow_gpm: 60 });
    expect(byRule(b.head).get("sewage-pump-undersized")).toEqual(["SGP-1 is rated 10 gpm short of the inflow (IPC 712.4.2)"]);
  });
});
