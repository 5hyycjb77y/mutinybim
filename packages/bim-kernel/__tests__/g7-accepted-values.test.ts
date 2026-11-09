/**
 * @jest-environment node
 *
 * Round 7 step 7b: a value the source's people accepted (an override the
 * model offered back and the Code Map accepted) replaces the derived value at
 * that one anchor, keeps the derived value as `was`, and leaves every other
 * anchor alone. A person's own override in the model still wins over it.
 *
 * Fails on the code before step 7b: `RuleRecord.acceptedValues` is not read.
 */
import { bindRequirementsSnapshot, readRuleRecord, requirementsAt, unbindRequirementsSnapshot, type RequirementsSnapshot } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { floor, run, STUDY, STUDY_RULES, ZT_PACK } from "./g7-fixtures";

const ID = "g7-accepted-values";
const S101 = { kind: "space" as const, id: "S101" };
const S102 = { kind: "space" as const, id: "S102" };

const withAccepted: RequirementsSnapshot = {
  ...STUDY,
  revision: "r2",
  rules: STUDY_RULES.map((r) =>
    r.ruleId === "outside-air"
      ? { ...r, acceptedValues: [{ key: "air.outside_air", anchorId: "S101", value: 30, unit: "cfm", reason: "Measured on site, test reason", acceptedBy: "A. Engineer", acceptedAt: "2026-10-31T12:00:00.000Z" }] }
      : r,
  ),
};

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindRequirementsSnapshot(ID, withAccepted);
});
afterAll(() => unbindRequirementsSnapshot(ID));

const air = (anchor: typeof S101) => requirementsAt(floor(ID), anchor).find((r) => r.key === "air.outside_air");

describe("g7 accepted values from a source", () => {
  it("replaces the derived value at its anchor and keeps what it replaced", () => {
    const at101 = air(S101);
    const at102 = air(S102);
    expect(at101).toMatchObject({ value: 30, unit: "cfm", accepted: { reason: "Measured on site, test reason", acceptedBy: "A. Engineer" } });
    expect(at101?.accepted?.was).toBe(at102?.value);
    expect(at102?.accepted).toBeUndefined();
  });

  it("a person's override in the model still wins over the accepted value", () => {
    const model = floor(ID);
    const id = air(S101)?.id ?? "";
    const overridden = run(model, { type: "set_requirement_state", requirementId: id, status: "overridden", value: 45, unit: "cfm", reason: "Test override in the model", by: "K. Example" });
    expect(requirementsAt(overridden, S101).find((r) => r.key === "air.outside_air")).toMatchObject({ value: 45, status: "overridden", derivedValue: 30 });
  });

  it("the stored rule reader keeps a well-formed list and refuses a broken one", () => {
    const good = withAccepted.rules.find((r) => r.ruleId === "outside-air");
    expect(readRuleRecord(good).ok).toBe(true);
    expect(readRuleRecord({ ...good, acceptedValues: [{ key: "air.outside_air", value: 30 }] }).ok).toBe(false);
  });
});
