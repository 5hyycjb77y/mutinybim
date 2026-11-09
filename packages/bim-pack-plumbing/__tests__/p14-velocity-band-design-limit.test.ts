/**
 * @jest-environment node
 *
 * Round 14 P14: velocity in water piping is checked against its system's own
 * band from the design limits — the project's over the firm's over the
 * add-on's default, each named in the words with where it came from — and
 * only over the pipes an edit touched. Fix makes the pipe a size larger.
 *
 * Fails on round 13: there was no velocity measure on the design-limit point
 * (velocity was checked only against a fixed hydraulics default), no
 * per-system band rows and no Fix.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { DESIGN_LIMIT_MEASURE_POINT, designLimitMeasures, type DesignLimit } from "@permitzip/bim-kernel/policy";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { PIPE_VELOCITY_MEASURE, PLUMBING_GAS_PACK, velocityBandFindings, velocityBandRows } from "../src";

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `p14v-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "quinn", name: "Quinn", kind: "human" }, command }, () => "2026-11-04T12:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function sampleMarketModel(): ModelState {
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  return commit(m, sampleMarketLoadPointCommand(build.points));
}

const cold = (max: number, source: string): DesignLimit => ({
  id: "plumbing_gas.cold_water_velocity",
  label: "Domestic cold water velocity",
  quantity: "velocity",
  unit: "ft/s",
  appliesTo: { systems: ["domestic_cold_water"] },
  band: { max },
  severity: "warning",
  citation: { source },
});

describe("p14-velocity-band-design-limit", () => {
  const m = sampleMarketModel();
  const all = PIPE_VELOCITY_MEASURE.measure(m);
  const coldPipes = all.filter((x) => x.selector.system === "domestic_cold_water");
  const fastest = Math.max(...coldPipes.map((x) => x.value));

  it("plumbing measures water velocity on the design-limit point", () => {
    expect(PLUMBING_GAS_PACK.contributions.some((c) => c.pointId === DESIGN_LIMIT_MEASURE_POINT.id && c.items.includes(PIPE_VELOCITY_MEASURE))).toBe(true);
    expect(designLimitMeasures().some((r) => r.id === "plumbing.pipe_velocity")).toBe(true);
    expect(coldPipes.length).toBeGreaterThan(0);
    expect(fastest).toBeGreaterThan(0);
  });

  it("the firm's band binds over the default, and the words name it", () => {
    const firmMax = Math.floor(fastest * 10) / 20;
    const found = velocityBandFindings(m, { firm: [cold(firmMax, "Firm standard, 2026")] });
    const coldFound = found.filter((f) => f.limitId === "plumbing_gas.cold_water_velocity");
    expect(coldFound.length).toBeGreaterThan(0);
    for (const f of coldFound) {
      expect(f.layer).toBe("firm");
      expect(f.source).toBe("Firm standard, 2026");
      expect(f.words).toMatch(new RegExp(`^Velocity [\\d.]+ ft/s over the ${firmMax} ft/s limit \\(firm\\)$`));
      expect(f.selectIds).toEqual([f.elementId]);
    }
    // With only the default 8 ft/s, the same pipes may pass: the band is the firm's, not a fixed number.
    const byDefault = velocityBandFindings(m, {}).filter((f) => f.limitId === "plumbing_gas.cold_water_velocity");
    expect(byDefault.every((f) => f.layer === "addon" && / limit \(default\)$/.test(f.words))).toBe(true);
    expect(byDefault.length).toBeLessThanOrEqual(coldFound.length);
  });

  it("the project's band binds over the firm's", () => {
    const found = velocityBandFindings(m, { firm: [cold(100, "Firm")], project: [cold(0.1, "Owner's spec")] }).filter((f) => f.limitId === "plumbing_gas.cold_water_velocity");
    expect(found.length).toBe(coldPipes.length);
    expect(found.every((f) => f.layer === "project" && f.words.endsWith("over the 0.1 ft/s limit (project)"))).toBe(true);
  });

  it("each water system has its own band: cold water's limit never checks hot water", () => {
    const found = velocityBandFindings(m, { firm: [cold(0.1, "Firm")] });
    const coldIds = new Set(coldPipes.map((x) => x.elementId));
    expect(found.filter((f) => f.limitId === "plumbing_gas.cold_water_velocity").every((f) => coldIds.has(f.elementId))).toBe(true);
    const rows = velocityBandRows({ firm: [cold(6, "Firm")] });
    expect(rows.find((r) => r.system === "domestic_cold_water")?.words).toBe("at most 6 ft/s (firm)");
    expect(rows.find((r) => r.system === "domestic_hot_water")?.words).toBe("at most 5 ft/s (default)");
    expect(rows.find((r) => r.system === "domestic_hot_water_return")?.words).toBe("at most 3 ft/s (default)");
  });

  it("measures only the systems an edit touched", () => {
    const one = coldPipes[0];
    if (!one) throw new Error("no cold pipe");
    const touched = PIPE_VELOCITY_MEASURE.measure(m, new Set([one.elementId]));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((x) => x.selector.system === "domestic_cold_water")).toBe(true);
    expect(PIPE_VELOCITY_MEASURE.measure(m, new Set(["not-a-pipe"]))).toEqual([]);
  });

  it("Fix makes the pipe one size larger, and the faster pipe slows down", () => {
    const f = velocityBandFindings(m, { project: [cold(0.1, "Owner's spec")] }).find((x) => x.limitId === "plumbing_gas.cold_water_velocity" && x.fix);
    if (!f?.fix) throw new Error("no fix");
    expect(f.fix.label).toMatch(/^Make it [\d.]+"$/);
    const before = all.find((x) => x.elementId === f.elementId)?.value ?? 0;
    const after = commit(m, f.fix.command);
    const now = PIPE_VELOCITY_MEASURE.measure(after, new Set([f.elementId])).find((x) => x.elementId === f.elementId)?.value ?? Infinity;
    expect(now).toBeLessThan(before);
  });
});
