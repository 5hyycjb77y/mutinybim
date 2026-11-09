/**
 * @jest-environment node
 *
 * The proof (STATUS / NEXT-BATCH §5 f-fitness): on the synthetic site, built
 * through the kernel's commands with the civil pack bound, the catchments'
 * runoff reaches the inlets and the outfall with the right totals THROUGH the
 * kernel's network walk (`runPackNetwork` → `serviceNetworkTotals`), and the
 * one flat pipe is flagged by the kernel's gravity regime.
 *
 * Hand check, US customary, i = 4 in/h for every catchment (no time of
 * concentration; the peaks add). Q = C·i·A_ft² / 43,200 cfs
 * (1 ft²·in/h = 1/12 ft³ per 3,600 s = 1/43,200 cfs):
 *
 *   C1 paved  C 0.95, 30,000 ft² (0.688705 ac): 0.95 × 4 × 30,000 / 43,200 = 2.638889 cfs → I1 (inlet inside it)
 *   C2 paved  C 0.95, 12,000 ft² (0.275482 ac): 0.95 × 4 × 12,000 / 43,200 = 1.055556 cfs → I2 (serves it)
 *   C3 lawn   C 0.20, 43,560 ft² (1.000000 ac): 0.20 × 4 × 43,560 / 43,200 = 0.806667 cfs → I2 (serves it)
 *
 *   I1  = 2.638889 cfs   (capacity 2.50 → overloaded by 0.138889)
 *   I2  = 1.055556 + 0.806667 = 1.862222 cfs   (capacity 3.00 → fine)
 *   MH1 = 2.638889 + 1.862222 = 4.501111 cfs
 *   OF1 = 4.501111 cfs   (= i × ΣCA = 4/43,200 × (28,500 + 11,400 + 8,712) = 4 × 48,612 / 43,200)
 *
 * Fall at the 0.5 % minimum:
 *   P101 I1 → MH1: 96.00 − 95.00 = 1.00 ft over 150 ft = 0.667 %  ok
 *   P102 I2 → MH1: 96.50 − 95.00 = 1.50 ft over 100 ft = 1.500 %  ok (routed MH1 → I2; read downstream)
 *   P103 MH1 → OF1: 95.00 − 94.90 = 0.10 ft over 200 ft = 0.050 %  too flat: needs 1.00 ft, 0.90 ft more
 *
 * Plan lengths are centre to centre less the two structures' connector
 * offsets (600 mm each end): the routed pipe is what the gravity check measures.
 */
import { qty, to, type Quantity } from "@permitzip/bim-units";
import { modelToShared, siteOf, type ModelState } from "@permitzip/bim-kernel";
import { PUMPED_SEGMENT_KEY } from "@permitzip/bim-kernel/connections";
import { buildClassIndex, builtinRegistry, packClassRegistry } from "@permitzip/bim-kernel/registry";
import { runPackNetwork, serviceNetworkTotals } from "@permitzip/bim-pack";
import { inletOverloadFindings, slopeFindings } from "../src/checks";
import { CIVIL_RUNOFF, CIVIL_STORM_SERVICE } from "../src/ids";
import { solveStormNetwork } from "../src/network";
import { CIVIL_SET, FT, SHARED_EASTING_FT, commit, segmentOf, syntheticSiteModel } from "./fixtures/synthetic-site";

const cfs = (q: Quantity<"flow_liquid"> | null | undefined): number => (q === undefined || q === null ? Number.NaN : to(q, "cfs"));
const cfsOf = (si: number | undefined): number => (si === undefined ? Number.NaN : to(qty("flow_liquid", si, "m3/s"), "cfs"));

describe("synthetic storm site", () => {
  let model: ModelState;
  beforeAll(() => {
    model = syntheticSiteModel();
  });

  it("is built from the pack's parts, zones, system and pipe material with no problems", () => {
    const net = solveStormNetwork(model.elements);
    expect(net.problems).toEqual([]);
    expect(net.site.structures.map((s) => s.id).sort()).toEqual(["I1", "I2", "MH1", "OF1"]);
    expect(net.site.catchments.find((c) => c.id === "C1")).toMatchObject({ drainsTo: "I1", drainsToFrom: "inside", cFrom: "surface", c: 0.95 });
    expect(net.site.catchments.find((c) => c.id === "C3")).toMatchObject({ drainsTo: "I2", drainsToFrom: "served_by", c: 0.2 });
    expect(to(net.site.catchments.find((c) => c.id === "C3")?.area ?? qty("area", 0, "ft2"), "acre")).toBeCloseTo(1, 9);
    expect(net.site.pipes.map((p) => p.material)).toEqual(["civil.rcp", "civil.rcp", "civil.rcp"]);
    expect(net.site.structures.find((s) => s.id === "I1")?.capacity === null ? null : to(net.site.structures.find((s) => s.id === "I1")?.capacity ?? qty("flow_liquid", 0, "cfs"), "cfs")).toBeCloseTo(2.5, 12);
    expect(net.intensity === null ? null : to(net.intensity, "in/h")).toBeCloseTo(4, 12);
  });

  it("carries each catchment's runoff to the outfall through the kernel's network walk", () => {
    const totals = runPackNetwork(model, CIVIL_SET, CIVIL_STORM_SERVICE);
    if (!totals.ok) throw new Error(totals.reason);
    expect(totals.direction).toBe("downstream");
    const at = (id: string) => cfsOf(totals.totals.get(id)?.[CIVIL_RUNOFF]);
    expect(at("I1")).toBeCloseTo(2.638889, 5);
    expect(at("I2")).toBeCloseTo(1.862222, 5);
    expect(at("MH1")).toBeCloseTo(4.501111, 5);
    expect(at("OF1")).toBeCloseTo((4 * 48612) / 43200, 5);
  });

  it("isn't a network the kernel can total outside the pack's set", () => {
    const outside = serviceNetworkTotals(model, CIVIL_STORM_SERVICE);
    expect(outside.ok ? "" : outside.reason).toBe('"civil.storm" isn\'t a service this model knows');
  });

  it("gives each catchment and pipe its share, oriented by the network not the drawing", () => {
    const net = solveStormNetwork(model.elements);
    expect(cfs(net.catchmentRunoff.get("C1"))).toBeCloseTo(2.638889, 5);
    expect(cfs(net.catchmentRunoff.get("C2"))).toBeCloseTo(1.055556, 5);
    expect(cfs(net.catchmentRunoff.get("C3"))).toBeCloseTo(0.806667, 5);
    expect(net.pipes.map((p) => `${p.from}>${p.to}`).sort()).toEqual(["I1>MH1", "I2>MH1", "MH1>OF1"]);
    expect(cfs(net.pipes.find((p) => p.from === "MH1")?.flow)).toBeCloseTo(4.501111, 5);
  });

  it("flags the one pipe flatter than the minimum through the gravity regime, with its shortfall", () => {
    const net = solveStormNetwork(model.elements);
    const byFrom = Object.fromEntries(net.pipes.map((p) => [p.from, p]));
    expect(Object.fromEntries(net.pipes.map((p) => [p.from, p.gravity?.status]))).toEqual({ I1: "ok", I2: "ok", MH1: "too_flat" });
    const p103 = byFrom.MH1;
    // Routed length: 200 ft centre to centre less 600 mm at the manhole and 600 mm at the outfall's inlet = 196.063 ft.
    const lengthFt = to(p103?.length ?? qty("length", 0, "mm"), "ft");
    expect(lengthFt).toBeCloseTo(200 - 1200 / FT, 6);
    // Needs 0.5 % of that (0.98031 ft) and has 0.10 ft: 0.88031 ft short.
    expect((p103?.gravity?.shortfallMm ?? 0) / FT).toBeCloseTo(0.005 * lengthFt - 0.1, 6);
    const findings = slopeFindings(net);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.elementIds.slice(1)).toEqual(["MH1", "OF1"]);
    expect(findings[0]?.message).toMatch(/runs at 0\.05 % slope; it needs at least 0\.50 % \(0\.88 ft more fall\)$/);
    // Full-flow capacity at that slope (18 in RCP, n 0.013): about 2.35 cfs, under the 4.50 it carries.
    expect(cfs(p103?.capacity)).toBeLessThan(4.5);
  });

  it("flags the overloaded inlet only", () => {
    const findings = inletOverloadFindings(solveStormNetwork(model.elements));
    expect(findings.map((f) => f.elementIds)).toEqual([["I1", "C1"]]);
    expect(findings[0]?.message).toBe("I1 takes 2.64 cfs of runoff but can take 2.50 cfs");
  });

  it("re-totals one catchment edit along its path to the outfall only", () => {
    const live = solveStormNetwork(model.elements).incremental();
    // C3 resurfaced as paving: 0.95 × 4 × 43,560 / 43,200 = 3.831667 cfs (+3.025 cfs).
    const changed = live.setCatchmentRunoff("C3", qty("flow_liquid", (0.95 * 4 * 43560) / 43200, "cfs"));
    expect(changed).toEqual(["I2", "MH1", "OF1"]);
    expect(to(live.totalAt("I1"), "cfs")).toBeCloseTo(2.638889, 5);
    expect(to(live.totalAt("OF1"), "cfs")).toBeCloseTo(4.501111 + 3.025, 5);
  });

  it("recognises every routed segment as a storm pipe through its system, with no class set on it", () => {
    const index = buildClassIndex(packClassRegistry(builtinRegistry(), CIVIL_SET), model);
    const segments = Object.values(model.elements).filter((e) => e.kind === "run_segment");
    expect(segments.map((e) => ("classId" in e ? e.classId : undefined))).toEqual([undefined, undefined, undefined]);
    expect(index.elementsOf("civil.storm_pipe").map((e) => e.id).sort()).toEqual(segments.map((e) => e.id).sort());
  });

  it("stores the storm runs under the civil discipline, with no fittings at sized connectors", () => {
    const runs = Object.values(model.elements).filter((e) => e.kind === "run_segment").map((e) => e.partition?.discipline);
    expect(runs).toEqual(["civil", "civil", "civil"]);
    expect(Object.values(model.elements).filter((e) => e.kind === "run_fitting")).toEqual([]);
  });

  it("a pumped segment (flow.pumped) is lifted, not slope-checked: the flat pipe becomes a pump", () => {
    const pumped = commit(model, { type: "set_element_values", elementIds: [segmentOf(model, "P103")], values: { [PUMPED_SEGMENT_KEY]: true } });
    const net = solveStormNetwork(pumped.elements);
    expect(Object.fromEntries(net.pipes.map((p) => [p.from, p.gravity?.status]))).toEqual({ I1: "ok", I2: "ok", MH1: "pumped" });
    expect(slopeFindings(net)).toEqual([]);
    // Pumping doesn't change what reaches the outfall.
    expect(cfs(net.totalRunoff.get("OF1"))).toBeCloseTo(4.501111, 5);
  });

  it("keeps the site in a local frame: model numbers small, shared coordinates large", () => {
    const i1 = solveStormNetwork(model.elements).site.structures.find((s) => s.id === "I1");
    expect(Math.abs(i1?.position.x ?? Infinity)).toBeLessThan(1e6);
    const shared = modelToShared(siteOf(model), { x: i1?.position.x ?? 0, y: i1?.position.y ?? 0, z: 0 });
    expect(shared.eastWest / FT).toBeCloseTo(SHARED_EASTING_FT + 350, 6);
  });
});
