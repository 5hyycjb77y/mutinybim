/**
 * @jest-environment node
 *
 * Round 7 lane G: an outside add-on brings its own requirements with zero
 * kernel edits. A test pack contributes a requirements source at
 * `kernel.requirements_source` (an exit count and a live load, both
 * synthetic and in our own words), the class they apply to and the
 * parameter they read at `kernel.parameter_set`; the engine evaluates them
 * on the element that carries the parameter. A second test pack supplies a
 * stricter exit rule for the same rooms as a bound snapshot: both are kept,
 * the higher-precedence source governs and the other is shown conflicting,
 * and a model-settings pin flips which governs (decision 11).
 *
 * Fails on the code before round 7: there was no requirements source point
 * and no engine to read it.
 */
import { bindRequirementsSnapshot, checkRequirementsSourceRow, CLASS_POINT, PARAMETER_SET_POINT, REQUIREMENTS_SOURCE_POINT, requirementsAt, requirementsSources, unbindRequirementsSnapshot, type BimElement, type ModelState, type RequirementsSourceRow, type RuleRecord } from "../src";
import { bindModelPacks, contribute, definePack, PackSet } from "../src/packs";
import { floor, STUDY } from "./g7-fixtures";

const verified = { status: "verified", by: "Test author" } as const;
const cite = (section: string) => ({ instrument: "Test Add-on Code", edition: "2025", section });

const ADDON_RULES: readonly RuleRecord[] = [
  {
    ruleId: "bay-exits",
    provider: "zq.rules",
    citation: cite("A-1"),
    title: "Bay exit count",
    summary: "A bay serving more than 49 people needs two ways out.",
    discipline: "architecture",
    applies: { classes: ["zq.bay"] },
    reads: ["zq.design_occupants"],
    produces: [{ key: "arch.exit_count", anchor: "element", value: "if({zq.design_occupants} > 49 occ, 2 ea, 1 ea)", unit: "ea", compare: "at_least" }],
    verification: verified,
  },
  {
    ruleId: "bay-live-load",
    provider: "zq.rules",
    citation: cite("S-1"),
    title: "Floor live load",
    summary: "Crowded bays carry the heavier test floor load.",
    discipline: "structure",
    applies: { classes: ["zq.bay"] },
    reads: ["zq.design_occupants"],
    parameters: { light: { value: 50, unit: "psf" }, crowded: { value: 100, unit: "psf" } },
    produces: [{ key: "struct.live_load", anchor: "element", value: "if({zq.design_occupants} > 49 occ, {param.crowded}, {param.light})", unit: "psf", compare: "at_least" }],
    verification: verified,
  },
];

const ADDON_ROW: RequirementsSourceRow = {
  descriptor: { id: "zq.rules", label: "Test add-on rules", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "public" },
  rules: () => ADDON_RULES,
};

const ZQ_PACK = definePack({ id: "zq", name: "Graph test add-on", version: "1.0.0", kernel: "^1.4.0" }, [
  contribute(CLASS_POINT, [{ id: "zq.bay", label: "Test bays", discipline: "general" }]),
  contribute(PARAMETER_SET_POINT, [{ id: "zq.bay_params", label: "Test bay values", parameters: [{ key: "zq.design_occupants", label: "Design occupants", classes: ["zq.bay"], valueType: "quantity", kind: "occupants", unit: "occ" }] }]),
  contribute(REQUIREMENTS_SOURCE_POINT, [ADDON_ROW]),
]);

function withBay(model: ModelState, occupants: number): ModelState {
  const bay = { version: 1, authoredRev: {}, id: "BAY-1", kind: "part", typeId: "pt-bay", levelId: "L1", position: { x: 6000, y: 4000 }, offsetMm: 0, rotationDeg: 0, mark: "BAY-1", values: { "zq.design_occupants": occupants }, classId: "zq.bay" } as unknown as BimElement;
  return { ...model, elements: { ...model.elements, [bay.id]: bay } };
}

const at = (m: ModelState, key: string) => requirementsAt(m, { kind: "element", id: "BAY-1" }).find((r) => r.key === key);

describe("g7 test source: an add-on's rules and parameter, zero kernel edits", () => {
  const ID = "g7-addon";
  beforeAll(() => bindModelPacks(ID, PackSet.create([ZQ_PACK])));

  it("the add-on's source is bound and its rules read the add-on's parameter on the bay", () => {
    const crowded = withBay(floor(ID), 60);
    expect(checkRequirementsSourceRow(ADDON_ROW, crowded)).toEqual([]);
    expect(requirementsSources(crowded).map((s) => [s.id, s.origin])).toContainEqual(["zq.rules", "pack"]);
    expect(at(crowded, "arch.exit_count")).toMatchObject({ value: 2, unit: "ea", provider: "zq.rules", title: "Bay exit count", standing: "governing" });
    expect(at(crowded, "struct.live_load")).toMatchObject({ value: 100, unit: "psf", provider: "zq.rules", title: "Floor live load" });

    const light = withBay(floor(ID), 20);
    expect(at(light, "arch.exit_count")?.value).toBe(1);
    expect(at(light, "struct.live_load")?.value).toBe(50);
  });
});

describe("g7 sources: both kept, the higher governs, a pin flips it", () => {
  const ID = "g7-pins";
  const STRICT: readonly RuleRecord[] = [
    {
      ruleId: "strict-exits",
      provider: "zs.strict",
      citation: cite("A-9"),
      title: "Exit count (stricter)",
      summary: "Every office gets two ways out.",
      discipline: "architecture",
      applies: { spaceUses: ["office"] },
      reads: [],
      produces: [{ key: "arch.exit_count", anchor: "space", value: "2 ea", unit: "ea", compare: "at_least" }],
      verification: verified,
    },
  ];
  beforeAll(() => {
    bindModelPacks(ID, PackSet.create([]));
    bindRequirementsSnapshot(ID, STUDY);
    bindRequirementsSnapshot(ID, { source: { id: "zs.strict", label: "Stricter test study", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" }, revision: "s1", rules: STRICT });
  });
  afterAll(() => unbindRequirementsSnapshot(ID));

  const exits = (m: ModelState) => requirementsAt(m, { kind: "space", id: "S101" }).filter((r) => r.key === "arch.exit_count");

  it("by default the first-bound snapshot governs and the other is conflicting, naming it", () => {
    const [first, second] = exits(floor(ID));
    expect(first).toMatchObject({ provider: "zt.code_study", value: 1, standing: "governing", conflictsWith: ["zs.strict:strict-exits:arch.exit_count:S101"] });
    expect(second).toMatchObject({ provider: "zs.strict", value: 2, standing: "conflicting" });
  });

  it("a pin for architecture puts the stricter source first", () => {
    const m0 = floor(ID);
    const pinned: ModelState = { ...m0, settings: { ...m0.settings, requirementsSources: [{ discipline: "architecture", sources: ["zs.strict", "zt.code_study"] }] } };
    const governing = exits(pinned).find((r) => r.standing === "governing");
    expect(governing).toMatchObject({ provider: "zs.strict", value: 2 });
    expect(exits(pinned).find((r) => r.standing === "conflicting")).toMatchObject({ provider: "zt.code_study", value: 1 });
  });

  it("unbinding a snapshot takes its rules away", () => {
    unbindRequirementsSnapshot(ID, "zs.strict");
    expect(exits(floor(ID)).map((r) => [r.provider, r.standing])).toEqual([["zt.code_study", "governing"]]);
    bindRequirementsSnapshot(ID, STUDY);
  });
});
