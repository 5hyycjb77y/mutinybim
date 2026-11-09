/**
 * @jest-environment node
 *
 * Round 7 lane G: a design choice relaxes a requirement and says so. Once
 * the model is recorded as fully sprinklered, the synthetic "sprinklered
 * area increase" rule triples the allowable floor area; the requirement
 * carries the effect (before, after, cause) and its cause sentence names it.
 * Superseding the choice puts the limit back.
 *
 * Fails on the code before round 7: no rule effects, no model determinations.
 */
import { dependsOn, requirementsAt, unbindRequirementsSnapshot, type ModelState } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, run, ZT_PACK } from "./g7-fixtures";

const ID = "g7-relaxes";
const MODEL = { kind: "model" as const, id: null };

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

const allowable = (m: ModelState) => requirementsAt(m, MODEL).find((r) => r.key === "arch.allowable_area");
const decide = { reasoning: "Synthetic test decision: every floor has heads.", decidedBy: "K. Example", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high" as const };

describe("g7 relaxes: fully sprinklered relaxes allowable area and says so", () => {
  it("without the design choice the base limit governs, with no effect", () => {
    const a = allowable(floor(ID));
    expect(a).toMatchObject({ value: 12000, unit: "ft2", compare: "at_most", standing: "governing" });
    expect(a?.effects).toBeUndefined();
  });

  it("recording the model as fully sprinklered triples the limit and names why", () => {
    const model = floor(ID);
    allowable(model);
    const sprinklered = run(model, { type: "record_determination", determinationId: "D-spk", subject: { kind: "model" }, key: "sprinklered", value: true, ...decide });
    const a = allowable(sprinklered);
    expect(a?.value).toBe(36000);
    expect(a?.effects).toEqual([{ provider: "zt.code_study", ruleId: "sprinklered-increase", effect: "relaxes", before: 12000, after: 36000, cause: "fully sprinklered: allowable floor area tripled" }]);
    expect(a?.cause).toContain("fully sprinklered: allowable floor area tripled");

    // Asked before the decision is recorded, "what re-opens" lists the relaxed limit.
    const preview = dependsOn(model, { changedIds: ["D-spk"], after: sprinklered.elements, label: "Record the building as fully sprinklered" });
    expect(preview.items.map((i) => i.label)).toContain("Allowable floor area in the model");

    // Superseding the choice with "not sprinklered" puts the base limit back.
    const undone = run(sprinklered, { type: "supersede_determination", determinationId: "D-spk", newDeterminationId: "D-spk-2", value: false, ...decide, reasoning: "Synthetic test decision: heads were taken out." });
    expect(allowable(undone)).toMatchObject({ value: 12000 });
    expect(allowable(undone)?.effects).toBeUndefined();
  });
});
