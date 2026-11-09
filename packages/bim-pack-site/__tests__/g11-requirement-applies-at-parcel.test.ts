/**
 * @jest-environment node
 *
 * Round 11 G11 (D3): requirements can sit on a parcel, a copy or the site,
 * and be tied to a stage, so a rule about the land holds before a building
 * exists. A model holding only two parcel records (the Site add-on's intent
 * kind) gets a setback requirement on each, a footprint limit on the one
 * parcel the rule names (read from the parcel's own area, typed by the kind
 * row's unit), and a due-diligence requirement only while the model is in
 * due diligence. Fails on round 10's code: the graph has no `parcel` anchor,
 * no `appliesAt`, and nothing anchors on a record that isn't a space, zone
 * or element.
 */
import { anchorOfRequirementId, bindRequirementsSnapshot, DEFAULT_SETTINGS, requirementById, requirementsOf, unbindRequirementsSnapshot, type BimElement, type ModelState, type RequirementsSnapshot, type RuleRecord } from "@permitzip/bim-kernel";
import { bindModelPacks, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { executeLifecycleCommand } from "../../bim-kernel/src/lifecycle/commands";
import { withUpgradePolicy } from "../../bim-kernel/src/schema-version/registry";
import { SITE_KIND, SITE_PACK, SITE_VALUE } from "../src";

const ID = "g11-parcel";
const SET = PackSet.create([SITE_PACK]);

const rule = (r: Pick<RuleRecord, "ruleId" | "title" | "produces"> & Partial<RuleRecord>): RuleRecord => ({
  provider: "zt.code_study",
  citation: { instrument: "Test Zoning Ordinance", edition: "2024", section: "T-9" },
  summary: "Synthetic.",
  discipline: "architecture",
  applies: {},
  reads: [],
  verification: { status: "verified", by: "Test author" },
  ...r,
});

const STUDY: RequirementsSnapshot = {
  source: { id: "zt.code_study", label: "Test code study", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" },
  revision: "r1",
  rules: [
    rule({ ruleId: "front-setback", title: "Front setback", parameters: { front: { value: 25, unit: "ft" } }, produces: [{ key: "zt.front_setback", anchor: "parcel", value: "{param.front}", unit: "ft", compare: "at_least" }] }),
    rule({ ruleId: "footprint", title: "Building footprint limit", reads: [SITE_VALUE.area], appliesAt: { anchors: [{ kind: "parcel", id: "P-1" }] }, produces: [{ key: "zt.max_footprint", anchor: "parcel", value: `{${SITE_VALUE.area}} * 0.5`, unit: "m2", compare: "at_most" }] }),
    rule({ ruleId: "phase-one", title: "Environmental site report on file", manual: true, appliesAt: { stages: ["due_diligence"] }, produces: [{ key: "zt.site_report", anchor: "parcel", value: "1", unit: "ea", compare: "at_least" }] }),
    rule({ ruleId: "shop-copy", title: "Shop copy keeps the approved spacing", parameters: { gap: { value: 2, unit: "m" } }, appliesAt: { anchors: [{ kind: "lineage", id: "shop-1" }] }, produces: [{ key: "zt.copy_gap", anchor: "lineage", value: "{param.gap}", unit: "m", compare: "at_least" }] }),
  ],
};

const parcel = (id: string, areaM2: number): BimElement => ({ id, kind: SITE_KIND.parcel, version: 1, authoredRev: {}, values: { [SITE_VALUE.area]: areaM2, [SITE_VALUE.parcelNumber]: `${id}-num` } }) as unknown as BimElement;

function model(): ModelState {
  const els = [parcel("P-1", 2000), parcel("P-2", 1200)];
  return { modelId: ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

beforeAll(() => {
  bindModelPacks(ID, SET);
  bindRequirementsSnapshot(ID, STUDY);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("g11 a requirement applies at a parcel before anything is drawn", () => {
  it("the setback holds on each parcel, the footprint only on the parcel it names", () => {
    const m = model();
    // Nothing but the two parcel records: no building, no space, no element to anchor on.
    expect(Object.values(m.elements).map((e): string => e.kind)).toEqual([SITE_KIND.parcel, SITE_KIND.parcel]);
    const reqs = requirementsOf(m);
    const setbacks = reqs.filter((r) => r.key === "zt.front_setback");
    expect(setbacks.map((r) => [r.anchor.kind, r.anchor.id, r.value, r.unit])).toEqual([
      ["parcel", "P-1", 25, "ft"],
      ["parcel", "P-2", 25, "ft"],
    ]);
    const footprint = reqs.filter((r) => r.key === "zt.max_footprint");
    expect(footprint).toHaveLength(1);
    expect(footprint[0]).toMatchObject({ anchor: { kind: "parcel", id: "P-1" }, value: 1000, unit: "m2", compare: "at_most" });
    // The id reads back to its parcel anchor.
    const id = setbacks[0]?.id ?? "";
    expect(withPackSet(SET, () => anchorOfRequirementId(id, m.elements))).toEqual({ kind: "parcel", id: "P-1" });
    expect(requirementById(m, id)?.key).toBe("zt.front_setback");
  });

  it("a stage-tied requirement is there in due diligence and gone after the stage moves on", () => {
    const m0 = model();
    expect(requirementsOf(m0).filter((r) => r.key === "zt.site_report").map((r) => r.anchor.id)).toEqual(["P-1", "P-2"]);
    const r = withPackSet(SET, () => withUpgradePolicy(() => true, () => executeLifecycleCommand(m0, { type: "set_stage_plan", stageSetId: "default", stageSetVersion: "1", currentStageId: "feasibility" })));
    if (!r.ok) throw new Error(r.error.message);
    const m1: ModelState = { ...r.model, revision: 2 as ModelState["revision"] };
    expect(requirementsOf(m1).filter((x) => x.key === "zt.site_report")).toEqual([]);
    expect(requirementsOf(m1).filter((x) => x.key === "zt.front_setback")).toHaveLength(2);
  });

  it("a copy is an anchor by id", () => {
    const gap = requirementsOf(model()).filter((r) => r.key === "zt.copy_gap");
    expect(gap.map((r) => [r.anchor.kind, r.anchor.id, r.value])).toEqual([["lineage", "shop-1", 2]]);
    expect(requirementById(model(), gap[0]?.id ?? "")?.anchor).toEqual({ kind: "lineage", id: "shop-1" });
  });
});
