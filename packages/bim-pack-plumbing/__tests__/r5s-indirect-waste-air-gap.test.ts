/**
 * @jest-environment node
 *
 * Indirect waste into a floor sink is checked for an air gap (IPC 802.2;
 * NEXT-BATCH 5b-1 proof). An ice machine's indirect waste line that ends open
 * above the floor sink passes; one joined straight to the floor sink's inlet,
 * or to a sanitary pipe, is an error that says what to do.
 *
 * Fails on the old code: indirect waste was not a system kind and no rule
 * looked at one.
 */
import { asElementId, withUpgradePolicy, type BimElement, type ModelState, type PartTypeDefinition, type RunSegment, type SystemKind } from "@permitzip/bim-kernel";
import { activeLintRules, DEFAULT_LINT_CONFIG, LintEngine, type Finding } from "@permitzip/bim-lint";
import { drainageRules } from "../src/lint/drainage";
import { DrainageBuilding, FT } from "../../bim-kernel/__tests__/drainage-fixtures";

const SERVICES = "services:registry";

const pipe = (id: string, kind: SystemKind, flowDirection: "in" | "out") => ({ id, label: id === "iw" ? "Indirect waste" : "Waste", domain: "pipe" as const, systemKind: kind, position: [0, 0, 0] as [number, number, number], direction: [0, 0, -1] as [number, number, number], shape: "round" as const, diameter: 25.4, flowDirection });

function fixture(familyName: string, connectors: PartTypeDefinition["connectors"]): PartTypeDefinition {
  return { familyName, typeName: "Test", category: "plumbing_fixture", typeParams: [], typeValues: {}, instanceParams: [], tagFields: [], geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }], symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }], connectors, source: { kind: "builtin", libraryVersion: "test" } };
}

const ICE_MAKER = fixture("Ice maker", [pipe("iw", "indirect_waste", "out")]);
const FLOOR_SINK = fixture("Floor sink", [pipe("iw", "indirect_waste", "in"), pipe("w", "sanitary", "out")]);

function kitchen(): DrainageBuilding {
  const b = new DrainageBuilding();
  withUpgradePolicy((f) => f === SERVICES, () => {
    b.ok({ type: "place_part", partId: "im-1", typeId: "type-im", partType: ICE_MAKER, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "IM-1" });
    b.ok({ type: "place_part", partId: "fs-1", typeId: "type-fs", partType: FLOOR_SINK, levelId: "lvl-1", position: { x: 6 * FT, y: 0 }, mark: "FS-1" });
  });
  return b;
}

function withLine(b: DrainageBuilding, end: RunSegment["links"]["end"], extra: Record<string, BimElement> = {}): ModelState {
  const sys: BimElement = { kind: "mep_system", id: asElementId("sys-iw"), version: 1, authoredRev: {}, name: "Indirect waste 1", systemKind: "indirect_waste", domain: "pipe" };
  const seg: RunSegment = {
    kind: "run_segment",
    id: asElementId("iw-s1"),
    version: 1,
    authoredRev: {},
    domain: "pipe",
    systemId: asElementId("sys-iw"),
    levelId: asElementId("lvl-1"),
    start: { x: 0, y: 0, z: 0 },
    end: { x: 6 * FT, y: 0, z: 0 },
    size: { shape: "pipe", nominalMm: 25.4, material: "pvc" },
    links: { start: { elementId: asElementId("im-1"), port: "iw" }, ...(end ? { end } : {}) },
    branches: [],
    flow: 0,
  };
  return { ...b.head, elements: { ...b.head.elements, [sys.id]: sys, [seg.id]: seg, ...extra } };
}

function findings(model: ModelState, rules = drainageRules): Finding[] {
  const e = new LintEngine(rules);
  e.build(model, []);
  return e.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" } }).filter((f) => f.rule === "indirect-waste-no-air-gap");
}

describe("indirect waste air gap (IPC 802.2)", () => {
  it("ends open above the floor sink: no finding", () => {
    expect(findings(withLine(kitchen(), undefined))).toEqual([]);
  });

  it("joined straight to the floor sink's inlet: an error naming the sink and what to do", () => {
    const f = findings(withLine(kitchen(), { elementId: asElementId("fs-1"), port: "iw" }));
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("error");
    expect([...(f[0]?.elementIds ?? [])].sort()).toEqual(["fs-1", "iw-s1"]);
    expect(f[0]?.message).toBe("Indirect waste 1 is piped straight into FS-1's indirect waste connection: no air gap. Indirect waste needs an air gap or air break (IPC 802.2)");
    expect(f[0]?.fix?.tool).toBe("bim_route_run");
  });

  it("joined to a sanitary pipe: the same error", () => {
    const san: BimElement = { kind: "mep_system", id: asElementId("sys-san"), version: 1, authoredRev: {}, name: "Sanitary 1", systemKind: "sanitary", domain: "pipe" };
    const sanSeg: RunSegment = { kind: "run_segment", id: asElementId("san-s1"), version: 1, authoredRev: {}, domain: "pipe", systemId: asElementId("sys-san"), levelId: asElementId("lvl-1"), start: { x: 6 * FT, y: 0, z: 0 }, end: { x: 12 * FT, y: 0, z: 0 }, size: { shape: "pipe", nominalMm: 50.8, material: "pvc" }, links: {}, branches: [], flow: 0 };
    const f = findings(withLine(kitchen(), { elementId: asElementId("san-s1"), port: "start" }, { [san.id]: san, [sanSeg.id]: sanSeg }));
    expect(f.map((x) => x.message)).toEqual(["Indirect waste 1 is piped straight into a drain pipe: no air gap. Indirect waste needs an air gap or air break (IPC 802.2)"]);
  });

  it("the ice machine's own discharge is where the line starts, not a missing air gap; and the rule is in the engine's list", () => {
    expect(findings(withLine(kitchen(), undefined)).some((f) => f.elementIds.includes("im-1"))).toBe(false);
    expect(activeLintRules().map((r) => r.id)).toContain("indirect-waste-no-air-gap");
  });
});
