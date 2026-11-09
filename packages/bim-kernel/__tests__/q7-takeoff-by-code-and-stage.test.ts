/**
 * @jest-environment node
 *
 * Round 7 lane Q: the "Takeoff by cost code and stage" schedule template
 * through the existing schedule engine. A test cost code (TEST-0100) set on
 * the wall type reaches every wall of that type; one wall's own code (an
 * instance code) wins over its type's; walls in two stages group under
 * each; totals add per group. Codes and stages are set by commands, gated on
 * `qto:classification` and `construction:stages`, and never change a design
 * value.
 *
 * Fails on the old code: no classification or stage commands, no `qto.*`
 * fields, no template.
 */
import { canonicalJson, executeCommand, fieldProviderRegistry, withUpgradePolicy, takeoffScheduleDefinition, takeoffTotals, type ModelState, type Wall } from "../src";
import { buildRowSet, validateScheduleDefinition } from "../src/schedules/engine";
import { commit, FT, threeOffices, tryCommit } from "./q7-fixtures";

function staged(): ModelState {
  let m = threeOffices();
  m = commit(m, { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" });
  m = commit(m, { type: "set_classification", elementIds: ["W-15"], system: "firm:cost_codes", code: "TEST-0200" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-a", name: "Stage A, east wing", plannedStart: "2027-01-04", plannedFinish: "2027-03-26" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-b", name: "Stage B, west wing" });
  m = commit(m, { type: "set_construction_stage", elementIds: ["W-11", "W-12", "W-13"], stageId: "st-a" });
  m = commit(m, { type: "set_construction_stage", elementIds: ["W-14", "W-15"], stageId: "st-b" });
  return m;
}

describe("q7 takeoff by cost code and stage", () => {
  it("codes and stages never change a design value", () => {
    const before = threeOffices();
    const after = staged();
    for (const id of ["W-11", "W-12", "W-13", "W-14", "W-15"]) {
      const a = before.elements[id] as Wall;
      const b = after.elements[id] as Wall;
      // Any edit's commit also writes record bookkeeping (version, authoredRev, schema version, the class recognition fills in); none is a design value.
      const { constructionStageId: _stage, classification: _codes, version: _v, authoredRev: _r, schemaVersion: _s, classId: _c, classSource: _cs, ...rest } = b;
      const { version: _v0, authoredRev: _r0, schemaVersion: _s0, classId: _c0, classSource: _cs0, ...restBefore } = a;
      expect(canonicalJson(rest)).toBe(canonicalJson(restBefore));
    }
  });

  it("groups the takeoff by a test cost code, then two stages, with totals", () => {
    const m = staged();
    const def = takeoffScheduleDefinition();
    const registry = fieldProviderRegistry();
    expect(validateScheduleDefinition(m, def, { viewId: "q7", revision: 0, registry })).toEqual([]);
    const rows = buildRowSet(m, def, { viewId: "q7", revision: 0, registry });
    const labels = (rows.groups ?? []).map((g) => `${g.depth}:${g.label}`);
    expect(labels).toEqual(expect.arrayContaining(["0:Cost code: TEST-0100", "1:Construction stage: Stage A, east wing", "1:Construction stage: Stage B, west wing", "0:Cost code: TEST-0200", "0:Cost code: No cost code"]));
    const length = rows.columns.find((c) => c.id === "qto.length");
    expect(length?.heading).toBe("LENGTH (CENTRELINE)");
    // Walls W-11..W-14 are TEST-0100 (from the type); W-15 is TEST-0200 (its own code wins).
    const totals = takeoffTotals(m.elements, { system: "firm:cost_codes" });
    const sum = (code: string, stage: string) => totals.filter((t) => t.group.key === `code:firm:cost_codes:${code}` && t.stageId === stage && t.measure.key === "qto.length").reduce((s, t) => s + t.value, 0);
    expect(sum("TEST-0100", "st-a")).toBeCloseTo((45 * FT) / 1000, 6);
    expect(sum("TEST-0100", "st-b")).toBeCloseTo((15 * FT) / 1000, 6);
    expect(sum("TEST-0200", "st-b")).toBeCloseTo((15 * FT) / 1000, 6);
  });

  it("a code the model's code lists don't know is kept and named", () => {
    const command = { type: "set_classification", elementIds: ["W-11"], system: "acme.codes", code: "X-1" } as const;
    const r = tryCommit(threeOffices(), command);
    if (!r.ok) throw new Error(r.message);
    const w = r.model.elements["W-11"] as Wall;
    expect(w.classification).toEqual([{ system: "acme.codes", code: "X-1" }]);
    const said = withUpgradePolicy(() => true, () => executeCommand(threeOffices(), command));
    expect(said.ok && said.summary?.join(" ")).toMatch(/a code list this model's add-ons don't include/);
  });

  it("refuses while the model server doesn't store codes or stages yet", () => {
    const older = (f: string) => f !== "qto:classification" && f !== "construction:stages";
    const a = tryCommit(threeOffices(), { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" }, older);
    expect(a.ok ? "" : a.message).toMatch(/older version/);
    const b = tryCommit(threeOffices(), { type: "add_construction_stage", stageId: "s1", name: "Stage 1" }, older);
    expect(b.ok ? "" : b.message).toMatch(/older version/);
  });

  it("deleting a stage leaves its elements in no stage, in one step; reorder lists every stage", () => {
    const m = commit(staged(), { type: "delete_construction_stage", stageId: "st-a" });
    expect(m.elements["st-a"]).toBeUndefined();
    expect((m.elements["W-11"] as Wall).constructionStageId).toBeUndefined();
    const r = tryCommit(staged(), { type: "reorder_construction_stages", stageIds: ["st-b"] });
    expect(r.ok ? "" : r.message).toMatch(/leaves out Stage A, east wing/);
  });
});
