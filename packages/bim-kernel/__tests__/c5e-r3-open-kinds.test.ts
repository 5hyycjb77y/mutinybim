/**
 * @jest-environment node
 *
 * Round 3, lane B: open system kinds (civil gap E), class disciplines in the
 * stored partition (civil gap H) and pack pipe materials in size labels (lane
 * B's own open item). Fails on the code before: a pack's kind drew and routed
 * as Other (its row's look and discipline were never read), every run stored
 * one of six disciplines, and a pack material printed as its fallback ("PE").
 */
import { asElementId, PARTITION_DISCIPLINES_FEATURE, sizeLabel, systemKindLook, systemRules, SYSTEM_KINDS, type MepSystem, type ModelState, type SystemKind } from "../src";
import { bindModelPacks, unbindModelPacks, withModelPacks, withPackSet } from "../src/packs";
import { CIVTEST_SET, commit, site, tryCommit } from "./c5e-r3-fixtures";

const MODEL = "c5e-r3-kinds";
beforeAll(() => bindModelPacks(MODEL, CIVTEST_SET));
afterAll(() => unbindModelPacks(MODEL));

const storm = { type: "route_run", idPrefix: "p1", levelId: "lvl-site", domain: "pipe", size: { shape: "pipe", nominalMm: 304.8, material: "pvc", materialId: "civtest.rcp" }, system: { id: "sys-storm", kind: "civtest.storm", name: "Storm 1" }, points: [{ x: 15_000, y: 0 }], from: { kind: "part", partId: "mh1", connectorId: "out" } };

function segment(m: ModelState) {
  const seg = Object.values(m.elements).find((e) => e.kind === "run_segment");
  if (seg?.kind !== "run_segment") throw new Error("a segment");
  return seg;
}

describe("system kinds are open", () => {
  it("a hand-built system takes a pack's kind with no cast, and reads its row's look and rules", () => {
    const kind: SystemKind = "civtest.storm";
    const system: MepSystem = { id: asElementId("s"), version: 1, authoredRev: {}, kind: "mep_system", name: "Storm 1", systemKind: kind, domain: "pipe" };
    withPackSet(CIVTEST_SET, () => {
      expect(systemKindLook(system.systemKind)).toEqual({ colour: "#3a7d44", pattern: "dashed" });
      expect(systemRules(system.systemKind)).toMatchObject({ label: "Storm", domain: "pipe" });
    });
    // Without the pack: Other, as any kind this reader doesn't know.
    expect(systemKindLook(kind)).toEqual({ colour: "#2ea86b", pattern: "solid" });
  });

  it("every built-in kind's look and rules are what the tables hold", () => {
    for (const k of SYSTEM_KINDS) {
      const outside = systemKindLook(k);
      withPackSet(CIVTEST_SET, () => expect(systemKindLook(k)).toEqual(outside));
    }
  });
});

describe("class disciplines in the stored partition", () => {
  it("a pack's storm run is stored as civil when the peers read class disciplines", () => {
    const m = commit(site(MODEL), storm);
    expect(segment(m).partition?.discipline).toBe("civil");
  });

  it("an older peer gets one of the six (the routing rules' discipline)", () => {
    const m = commit(site(MODEL), storm, (f) => f !== PARTITION_DISCIPLINES_FEATURE);
    expect(segment(m).partition?.discipline).toBe("mechanical");
  });

  it("built-in runs keep their six under every policy", () => {
    const m = site(MODEL);
    const r = tryCommit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-site", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, system: { id: "sys-cw", kind: "domestic_cold_water", name: "CW" }, elevationMm: 2400, points: [{ x: 0, y: 5000 }, { x: 6000, y: 5000 }] });
    if (!r.ok) throw new Error(r.message);
    expect(segment(r.model).partition?.discipline).toBe("plumbing");
  });
});

describe("pack pipe materials in size labels", () => {
  it("a pipe in a pack's material prints the pack's name, a built-in its usual word", () => {
    const seg = segment(commit(site(MODEL), storm));
    expect(withModelPacks(MODEL, () => sizeLabel(seg.size))).toBe('12" reinforced concrete');
    expect(sizeLabel(seg.size)).toBe('12" Rcp'); // a host without the pack: kept by id, in words
    expect(sizeLabel({ shape: "pipe", nominalMm: 25.4, material: "copper" })).toBe('1" copper');
  });
});
